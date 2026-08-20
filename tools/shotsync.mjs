/**
 * Is the server actually spreading a player's shot by the seed that player's
 * client used? End-to-end, against the real server.
 *
 *   BOTS=0 PORT=8100 node server/index.mjs
 *   PORT=8100 node tools/shotsync.mjs
 *
 * Deliberately does NOT simulate a client. Every headless client written for
 * this netcode has been unfaithful in some way — stale turret angles, no
 * line-of-sight check, a loop that cannot receive while it sends — and each
 * time the fixture cost more than the bug. This one sends inputs and does
 * arithmetic on what the server broadcasts back. There is no local physics, no
 * aiming and no hit detection in it, so there is nothing for it to get wrong.
 *
 * How it can tell: the server broadcasts every shot as a `fire` event carrying
 * the direction it RESOLVED — the aim direction after spread. With the tank
 * held still, the aim direction is recoverable from the snapshot (body yaw +
 * turret yaw), so the spread angle the server applied can be solved for:
 *
 *     resolved = normalize(aim + right·k)   ⟹   k = (resolved·right)/(resolved·aim)
 *
 * and k/σ is the standard normal the server drew. If the seeding is plumbed
 * correctly that number equals gaussianFrom(shotSeed(id, seq)) for one of the
 * inputs actually sent — which is the number the client drew too. If the seed
 * never reaches the shot, it matches nothing.
 *
 * Requires BOTS=0: with another tank on the arena the shot may pick up evasion
 * spread, and σ is then no longer known from config alone.
 */
import WebSocket from 'ws';
import {
  C_HELLO, C_INPUT, C_PONG, S_WELCOME, S_SNAPSHOT, S_PING, packInput,
} from '../src/net/protocol.js';
import { WEAPONS } from '../src/config.js';
import { gaussianFrom, shotSeed } from '../src/rng.js';

const PORT = Number(process.env.PORT ?? 8100);
const URL = process.env.URL ?? `ws://localhost:${PORT}/ws`;
const SECONDS = Number(process.env.SECONDS ?? 10);
const SIGMA = WEAPONS.twin.spread;
// How far a reconstructed draw may sit from the seed's own value and still
// count as the same shot. This is pure wire rounding: `dir` goes out rounded to
// 3 decimals, so each component carries up to 0.0005 of error, and dividing by
// σ turns that into this many units of the draw.
//
// It was HARD-CODED at 0.02, with a comment deriving it as 0.001/σ. That
// derivation was right when Twin's spread was ~0.05. Playtest 4 cut every
// spread to roughly a third (§4) — σ is 0.018 now — which tripled the
// quantisation without touching the tolerance, and the test has been rejecting
// CORRECT matches ever since. It reported 4-12 of 22 on a build measured, from
// the server's own broadcast, to be seeding all 23 of 23 shots correctly.
//
// A test that fails when nothing is wrong costs exactly what a test that passes
// when something is wrong costs: the next session spends its time on a bug that
// is not there. Derived from σ now, so cutting the spread again cannot silently
// re-break it.
const TOL = 0.0011 / SIGMA;

// Shots are 27 ticks apart (fireInterval 0.4398s at 60Hz = 26.4, and the server
// fires on the first tick where cooldown has expired), give or take the tick
// accumulator. Searching a window this size around the expected seq — instead of
// over every seq sent — is what makes a match mean something. See `solve`.
const GAP = [24, 30];

const ws = new WebSocket(URL);
let id = null;
let pose = null;                  // {yaw, ty} — constant, the tank never moves
const fired = [];                 // seqs sent with fire = true
const shots = [];                 // resolved directions the server reported
let dropped = 0;                  // shots whose aim could not be reconstructed
let gap = 0;                      // dropped since the last usable shot

ws.on('open', () => ws.send(JSON.stringify({
  t: C_HELLO, name: 'sync', hull: 'hunter', weapon: 'twin',
})));

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.t === S_WELCOME) { id = msg.id; return start(); }
  if (msg.t === S_PING) return ws.send(JSON.stringify({ t: C_PONG, ts: msg.ts }));
  if (msg.t !== S_SNAPSHOT) return;

  const me = msg.tanks.find((t) => t.id === id);
  if (!me) return;
  const prev = pose;
  pose = { yaw: 2 * Math.atan2(me.qy, me.qw), ty: me.ty };

  // A shot's aim is reconstructed from the snapshot, but the shot happened
  // somewhere in the ticks SINCE the previous snapshot. That is only sound
  // while the tank is not turning — and it does turn: firing applies a recoil
  // impulse, the tank slides, and eventually scrapes geometry and yaws. Shots
  // straddling any such snapshot are dropped rather than reconstructed wrongly.
  // Skipping this made the whole test flaky — it passed or failed depending on
  // how far the tank had drifted, which is the sort of fixture fault that gets
  // mistaken for a real result.
  const steady = prev && Math.abs(prev.yaw - pose.yaw) < 1e-4 && Math.abs(prev.ty - pose.ty) < 1e-4;

  for (const e of msg.events ?? []) {
    if (e.e !== 'fire' || e.id !== id) continue;
    if (!steady) { dropped++; gap++; continue; }
    // `skip` = shots dropped since the last usable one, so the chain search
    // knows to expect a correspondingly longer stride in sequence numbers.
    shots.push({ dx: e.dx, dz: e.dz, aim: pose.yaw + pose.ty, skip: gap });
    gap = 0;
  }
});

function start() {
  let seq = 0;
  const timer = setInterval(() => {
    seq++;
    fired.push(seq);
    // Everything zero but fire: a still tank means the aim direction is exactly
    // what the snapshot reports, with no interpolation guesswork.
    ws.send(JSON.stringify({
      t: C_INPUT,
      i: packInput(seq, { throttle: 0, steer: 0, turretSteer: 0, fire: true }),
    }));
  }, 1000 / 60);

  setTimeout(() => { clearInterval(timer); ws.close(); report(); }, SECONDS * 1000);
}

function report() {
  if (!shots.length) {
    console.log(`no shots observed in ${SECONDS}s — is the server up on ${URL}?`);
    process.exit(1);
  }

  // The normal the server drew for each shot, solved from the direction it
  // broadcast.
  const drew = [];
  const skips = [];
  for (const sh of shots) {
    const a = sh.aim;
    const aim = { x: Math.sin(a), z: Math.cos(a) };
    // right = cross(aim, up), exactly as Combat._spread builds it
    const right = { x: -Math.cos(a), z: Math.sin(a) };

    const alongAim = sh.dx * aim.x + sh.dz * aim.z;
    const alongRight = sh.dx * right.x + sh.dz * right.z;
    if (Math.abs(alongAim) < 1e-6) continue;
    drew.push((alongRight / alongAim) / SIGMA);
    skips.push(sh.skip);
  }

  const g = (seq) => gaussianFrom(shotSeed(id, seq));

  /**
   * Match the observed draws to a run of input sequence numbers.
   *
   * The obvious version of this — for each shot, take the nearest of the ~600
   * seqs sent — proves nothing, and said 100% before this was rewritten. Six
   * hundred standard normals land about 0.005 apart near the middle of the
   * distribution, so ANY value has a neighbour well inside any tolerance loose
   * enough to absorb the wire rounding. The test could not have failed.
   *
   * What carries the information is not that each shot matches *a* seq but that
   * the shots match seqs in order, one firing interval apart, from a single
   * starting offset. That is a chain of ~20 constrained predictions, and an
   * unseeded server cannot produce it.
   */
  function solve() {
    let best = { len: 0, seqs: [] };
    for (const start of fired) {
      if (Math.abs(g(start) - drew[0]) >= TOL) continue;
      const seqs = [start];
      let prev = start;
      for (let i = 1; i < drew.length; i++) {
        // One firing interval per shot, plus one for each shot dropped in
        // between, so the window stays narrow instead of swallowing the arena.
        const n = 1 + skips[i];
        let found = null;
        for (let d = GAP[0] * n; d <= GAP[1] * n && found === null; d++) {
          if (Math.abs(g(prev + d) - drew[i]) < TOL) found = prev + d;
        }
        if (found === null) break;
        seqs.push(found);
        prev = found;
      }
      if (seqs.length > best.len) best = { len: seqs.length, seqs };
    }
    return best;
  }

  // If the server was run with TANKI_SHOTLOG=1 the seqs are not guessed at all:
  // paste its `[shotlog] seq=` values in and the chain search is skipped.
  //
  // The seqs the server logs cover EVERY shot it fired. The shots reconstructed
  // here do not: any shot straddling a snapshot where the tank was turning was
  // dropped above. Lining the two lists up index-for-index therefore slides out
  // of alignment at the first drop and reports nonsense — measured, 0/21 with
  // exact sequence numbers on a build whose chain search was matching twelve
  // consecutive shots at the same moment. `skips[i]` is how many were dropped
  // before shot i, which is exactly what the offset needs.
  const told = (process.env.SEQS ?? '').split(/[,\s]+/).filter(Boolean).map(Number);
  let toldAt = 0;
  const aligned = drew.map((_, i) => {
    toldAt += i === 0 ? 0 : 1 + skips[i];
    return told[toldAt];
  });
  const best = told.length
    ? { len: aligned.filter((seq, i) => seq !== undefined && Math.abs(g(seq) - drew[i]) < TOL).length,
        seqs: aligned }
    : solve();
  const rows = best.seqs.slice(0, 8).map((seq, i) => ({
    shot: i,
    serverDrew: +drew[i].toFixed(4),
    fromSeq: seq,
    seedPredicts: +g(seq).toFixed(4),
    err: +Math.abs(g(seq) - drew[i]).toFixed(4),
  }));

  console.log(`inputs sent: ${fired.length}   shots usable: ${drew.length}   ` +
    `dropped (tank was turning): ${dropped}`);
  console.log(`σ = ${SIGMA} rad (Twin, no other tanks so no evasion term)\n`);
  console.table(rows);

  const rate = best.len / drew.length;
  console.log(`\nconsecutive shots explained by one run of input seqs: ` +
    `${best.len}/${drew.length}  (${(rate * 100).toFixed(1)}%)`);

  const ok = rate > 0.95 && best.len >= 5;
  console.log(ok
    ? '\nPASS — the shot the client drew is the shot the server resolved.'
    : '\nFAIL — the server is not spreading by the client\'s seed.');
  process.exit(ok ? 0 : 1);
}
