// Held-out comparison: baseline config vs tuned parameters, on duels the
// optimiser never saw.
//
// The optimiser scores every candidate on one fixed set of seeded duels, which
// makes ranking clean but lets it overfit that exact set. Re-scoring on a
// disjoint seed range is what separates "genuinely better balance" from "found
// the 864 fights where these numbers happen to look good".

import { initArena } from './duel.mjs';
import { buildJobs, runJobs, aggregate, objective, WEAPON_KEYS, BAND_KEYS, LOADOUTS } from './evaluate.mjs';
import { apply, currentVector, SPEC } from './params.mjs';
import { WEAPONS } from '../src/config.js';
import { readFileSync } from 'node:fs';

const N = Number(process.argv[2] ?? 12);
const SEED_OFFSET = 5000;         // disjoint from the optimiser's n = 0..7

await initArena();
const baseline = currentVector();
const tuned = (() => {
  const saved = JSON.parse(readFileSync(new URL('./tuned.json', import.meta.url), 'utf8'));
  return SPEC.map(([k]) => saved.params[k]);
})();

const jobs = buildJobs(N, SEED_OFFSET);
console.log(`Held-out set: ${jobs.length} duels, seed offset ${SEED_OFFSET}\n`);

function score(vec, label) {
  apply(vec);
  // Snapshot band assignments before the next apply() mutates WEAPONS.
  const bands = Object.fromEntries(WEAPON_KEYS.map((w) => [w, WEAPONS[w].band]));
  const m = aggregate(runJobs(jobs));
  const l = objective(m);
  return { label, m, l, bands };
}

const results = [score(baseline, 'BASELINE'), score(tuned, 'TUNED')];

for (const r of results) {
  console.log(`── ${r.label} ${'─'.repeat(40 - r.label.length)}`);
  console.log('  weapon    overall     close      mid     long   (* designated)');
  for (const w of WEAPON_KEYS) {
    const cells = BAND_KEYS.map((b) => {
      const v = r.m.weaponByBand[w][b].toFixed(3);
      return (b === r.bands[w] ? `*${v}` : ` ${v}`).padStart(9);
    }).join('');
    console.log(`  ${w.padEnd(9)} ${r.m.weaponOverall[w].toFixed(3)} ${cells}`);
  }
  const spread = Math.max(...WEAPON_KEYS.map((w) => r.m.weaponOverall[w]))
    - Math.min(...WEAPON_KEYS.map((w) => r.m.weaponOverall[w]));
  const worst = [...r.m.pairWinrates].sort((a, b) =>
    Math.abs(b.wr - 0.5) - Math.abs(a.wr - 0.5))[0];
  const [wi, wj] = worst.pair.split(':').map(Number);
  console.log(`  spread ${spread.toFixed(3)}   TTK ${r.m.meanTTK.toFixed(2)}s   ` +
    `timeouts ${(r.m.timeoutRate * 100).toFixed(1)}%`);
  console.log(`  worst matchup  ${LOADOUTS[wi].id} vs ${LOADOUTS[wj].id}  ${worst.wr.toFixed(3)}`);
  console.log(`  LOSS ${r.l.total.toFixed(4)}`, r.l.parts, '\n');
}

const [b, t] = results;
const delta = ((b.l.total - t.l.total) / b.l.total * 100).toFixed(1);
console.log(`Tuned vs baseline on held-out duels: loss ${b.l.total.toFixed(4)} -> ` +
  `${t.l.total.toFixed(4)}  (${delta}% better)`);
