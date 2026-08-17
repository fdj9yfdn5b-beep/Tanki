/**
 * Does the shot the client DRAWS match the shot the server RESOLVES?
 *
 * Regression test for the bug that survived the lag-compensation fix. Online,
 * the client fires `visualOnly` for instant feedback and the server decides the
 * outcome — both running the same weapons.js. But spread was drawn from a
 * module-level RNG, and the two processes have separate state advanced a
 * different number of times (the server also runs bots). So one shot became two
 * independent draws of the same distribution, and the tracer on your screen was
 * not the ray the server traced. It looked exactly like a hit that did nothing.
 *
 * The fix keys the draw off (shooter id, input seq), which both ends already
 * agree on. This asserts that, and asserts the draw is still a real normal
 * rather than a constant — a seeded draw that always returned the same number
 * would also "pass" a sync test while quietly deleting the spread mechanic.
 *
 * No simulation fixture on purpose. Every fixture written for this netcode so
 * far has been unfaithful in some way; this is pure arithmetic and cannot be.
 */
import * as THREE from 'three';
import { seed, random, gaussian, gaussianFrom, shotSeed } from '../src/rng.js';
import { WEAPONS } from '../src/config.js';

const SIGMA = WEAPONS.twin.spread;
const RANGE = 30;        // a typical mid-band engagement
const N = 2000;

// The horizontal-only spread from Combat._spread, isolated.
function spreadDir(dir, sigma, g) {
  const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
  return dir.clone().addScaledVector(right, g * sigma).normalize();
}

const aim = new THREE.Vector3(0, 0, 1);

// Two processes, two RNG histories. `client` and `server` below never share
// state — which is the whole point.
function asClient(fn) { seed(1); return fn(); }
function asServer(fn) {
  seed(999);
  for (let k = 0; k < 37; k++) random();   // bots pulled from the stream
  return fn();
}

// ── What it used to do: each end draws for itself ───────────────────────────
const clientDraws = asClient(() => Array.from({ length: N }, () => gaussian()));
const serverDraws = asServer(() => Array.from({ length: N }, () => gaussian()));

let before = 0;
for (let i = 0; i < N; i++) {
  before += spreadDir(aim, SIGMA, clientDraws[i])
    .sub(spreadDir(aim, SIGMA, serverDraws[i])).length() * RANGE;
}
before /= N;

// ── What it does now: both ends key off the same input ──────────────────────
let after = 0, worst = 0;
for (let i = 0; i < N; i++) {
  const id = 1 + (i % 7), seq = 1000 + i;
  const c = asClient(() => spreadDir(aim, SIGMA, gaussianFrom(shotSeed(id, seq))));
  const s = asServer(() => spreadDir(aim, SIGMA, gaussianFrom(shotSeed(id, seq))));
  const d = c.sub(s).length() * RANGE;
  after += d;
  worst = Math.max(worst, d);
}
after /= N;

// ── The draw must still be normal(0,1), or spread has been silently removed ─
const sample = Array.from({ length: 20000 }, (_, i) => gaussianFrom(shotSeed(3, i)));
const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
const sd = Math.sqrt(sample.reduce((a, b) => a + (b - mean) ** 2, 0) / sample.length);

console.log(`Twin spread 1σ = ${SIGMA} rad, disagreement measured at ${RANGE}m\n`);
console.log(`  client vs server, independent draws : ${before.toFixed(3)} m mean`);
console.log(`  client vs server, seeded draw       : ${after.toFixed(3)} m mean, worst ${worst}`);
console.log(`\n  seeded draw: mean ${mean.toFixed(4)}, sd ${sd.toFixed(4)}   (want ~0, ~1)`);

const ok = worst === 0 && Math.abs(mean) < 0.03 && Math.abs(sd - 1) < 0.03;
console.log(`\n${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
