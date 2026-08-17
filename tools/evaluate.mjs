import { initArena, runDuel } from './duel.mjs';
import { apply } from './params.mjs';
import { WEAPONS, HULLS, TTK_TARGET } from '../src/config.js';

export const WEAPON_KEYS = Object.keys(WEAPONS);
export const HULL_KEYS = Object.keys(HULLS);

export const LOADOUTS = [];
for (const weapon of WEAPON_KEYS) {
  for (const hull of HULL_KEYS) LOADOUTS.push({ weapon, hull, id: `${weapon}/${hull}` });
}

export const BAND_KEYS = ['close', 'mid', 'long'];

/**
 * Every ordered job needed for one evaluation. Built once and reused every
 * generation with the same seeds — common random numbers, so two candidates are
 * compared on identical spawns and identical aim noise rather than on luck.
 */
export function buildJobs(duelsPerCell, seedOffset = 0) {
  const jobs = [];
  for (let i = 0; i < LOADOUTS.length; i++) {
    for (let j = i + 1; j < LOADOUTS.length; j++) {
      for (const band of BAND_KEYS) {
        for (let n = 0; n < duelsPerCell; n++) {
          // Seed derived from the cell, so job k is the same fight for every
          // candidate. Sides swap each repeat to cancel any spawn advantage.
          // `seedOffset` shifts the whole set onto fights the optimiser never
          // saw — the held-out check for overfitting to its own duel set.
          const rngSeed = (i * 977 + j * 131 + BAND_KEYS.indexOf(band) * 31
            + (n + seedOffset) * 7919) >>> 0;
          jobs.push({ i, j, band, rngSeed, swap: n % 2 === 1 });
        }
      }
    }
  }
  return jobs;
}

export function runJobs(jobs) {
  const out = [];
  for (const job of jobs) {
    const A = LOADOUTS[job.swap ? job.j : job.i];
    const B = LOADOUTS[job.swap ? job.i : job.j];
    const r = runDuel({ a: A, b: B, band: job.band, rngSeed: job.rngSeed });
    if (!r) continue;
    // Normalise back to "did loadout i win", regardless of which side it took.
    out.push({
      i: job.i, j: job.j, band: job.band,
      win: job.swap ? 1 - r.result : r.result,
      ttk: r.ttk,
    });
  }
  return out;
}

/** Aggregate raw duel results into the metrics the objective is built from. */
export function aggregate(results) {
  const pair = new Map();          // "i:j" -> {sum, n}
  const wByBand = {};              // weapon -> band -> {sum, n}
  const wOverall = {};             // weapon -> {sum, n}
  let ttkSum = 0, ttkN = 0, timeouts = 0;

  const bump = (obj, k, v) => {
    obj[k] ??= { sum: 0, n: 0 };
    obj[k].sum += v; obj[k].n++;
  };

  for (const r of results) {
    const key = `${r.i}:${r.j}`;
    if (!pair.has(key)) pair.set(key, { sum: 0, n: 0 });
    const p = pair.get(key);
    p.sum += r.win; p.n++;

    const wi = LOADOUTS[r.i].weapon, wj = LOADOUTS[r.j].weapon;
    wByBand[wi] ??= {}; wByBand[wj] ??= {};
    bump(wByBand[wi], r.band, r.win);
    bump(wByBand[wj], r.band, 1 - r.win);
    bump(wOverall, wi, r.win);
    bump(wOverall, wj, 1 - r.win);

    if (r.ttk == null) timeouts++;
    else { ttkSum += r.ttk; ttkN++; }
  }

  const mean = (o) => (o && o.n ? o.sum / o.n : 0.5);

  return {
    pairWinrates: [...pair.entries()].map(([k, v]) => ({ pair: k, wr: mean(v), n: v.n })),
    weaponOverall: Object.fromEntries(WEAPON_KEYS.map((w) => [w, mean(wOverall[w])])),
    weaponByBand: Object.fromEntries(WEAPON_KEYS.map((w) => [
      w, Object.fromEntries(BAND_KEYS.map((b) => [b, mean(wByBand[w]?.[b])])),
    ])),
    meanTTK: ttkN ? ttkSum / ttkN : 99,
    timeoutRate: results.length ? timeouts / results.length : 1,
    duels: results.length,
  };
}

/**
 * Scalar loss. Lower is better.
 *
 * Deliberately not "make every winrate 50%": that has a trivial degenerate
 * solution where all three weapons become the same gun. The identity and band
 * terms are what force them to stay different weapons that happen to be equal
 * in aggregate.
 */
export function objective(m) {
  // 1. No pairing should be a blowout.
  const pairLoss = m.pairWinrates.reduce((a, p) => a + (p.wr - 0.5) ** 2, 0)
    / Math.max(1, m.pairWinrates.length);

  // 2. No weapon should be globally dominant.
  const globalLoss = WEAPON_KEYS.reduce((a, w) => a + (m.weaponOverall[w] - 0.5) ** 2, 0)
    / WEAPON_KEYS.length;

  // 3. Each weapon must own its designated band, and be beatable somewhere.
  let identityLoss = 0;
  for (const w of WEAPON_KEYS) {
    const own = WEAPONS[w].band;
    const mine = m.weaponByBand[w][own];
    const others = BAND_KEYS.filter((b) => b !== own).map((b) => m.weaponByBand[w][b]);
    identityLoss += Math.max(0, 0.56 - mine) ** 2;          // strong in its band
    identityLoss += Math.max(0, Math.min(...others) - 0.46) ** 2;   // weak somewhere
  }
  identityLoss /= WEAPON_KEYS.length;

  // 4. Fights should resolve inside the arena-shooter TTK window.
  const [tlo, thi] = TTK_TARGET;
  const ttkLoss = (Math.max(0, m.meanTTK - thi) / thi) ** 2
    + (Math.max(0, tlo - m.meanTTK) / tlo) ** 2;

  // 5. A duel that never resolves is a failed design, not a draw.
  const timeoutLoss = m.timeoutRate ** 2;

  // Identity is weighted ABOVE pair balance, not below it.
  //
  // At 10 vs 16 the optimiser found it cheaper to equalise winrates by letting
  // weapons swap roles than by keeping them. A run scored 0.652 — excellent
  // aggregate balance, spread 0.024 — while producing a Twin that was WEAKEST
  // at close range and a Thunder that was strongest there. Both numerically
  // balanced and completely wrong: the whole point of three weapons is that
  // they answer different ranges. A lower loss with inverted roles is a worse
  // game, so the objective has to say so.
  const total = 12 * pairLoss + 10 * globalLoss + 34 * identityLoss
    + 0.9 * ttkLoss + 2.5 * timeoutLoss;

  return {
    total,
    parts: {
      pair: +(16 * pairLoss).toFixed(4),
      global: +(12 * globalLoss).toFixed(4),
      identity: +(10 * identityLoss).toFixed(4),
      ttk: +(0.9 * ttkLoss).toFixed(4),
      timeout: +(2.5 * timeoutLoss).toFixed(4),
    },
  };
}

export async function evaluateVector(vec, jobs) {
  await initArena();
  apply(vec);
  const results = runJobs(jobs);
  const metrics = aggregate(results);
  return { metrics, loss: objective(metrics) };
}
