// Separable CMA-ES over the weapon parameter vector.
//
// Diagonal covariance rather than full: 22 dimensions against a *noisy*
// objective does not have the sample budget to estimate 231 covariance terms,
// and sep-CMA-ES needs no eigendecomposition. Every candidate in a generation
// is scored on an identical set of seeded duels, so ranking within a generation
// is close to noise-free even though absolute loss still wobbles.

import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setPriority } from 'node:os';
import { buildJobs } from './evaluate.mjs';
import { SPEC, DIM, currentVector, toUnit, fromUnit, asObject } from './params.mjs';

const GENERATIONS = Number(process.env.GENERATIONS ?? 34);
const DUELS_PER_CELL = Number(process.env.DUELS ?? 8);
const LAMBDA = Number(process.env.LAMBDA ?? 8);
const OUT = fileURLToPath(new URL('./tuned.json', import.meta.url));

// ── Worker pool ─────────────────────────────────────────────────────────────
const jobs = buildJobs(DUELS_PER_CELL);
const workerUrl = new URL('./worker.mjs', import.meta.url);
const pool = [];

async function spawnPool(n) {
  await Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
    const w = new Worker(workerUrl);
    w.once('message', () => {
      w.postMessage({ type: 'jobs', jobs });
      pool.push({ w, busy: false });
      resolve();
    });
  })));
}

function evalOn(worker, id, vec) {
  return new Promise((resolve) => {
    const onMsg = (m) => {
      if (m.type !== 'result' || m.id !== id) return;
      worker.w.off('message', onMsg);
      worker.busy = false;
      resolve(m);
    };
    worker.w.on('message', onMsg);
    worker.busy = true;
    worker.w.postMessage({ type: 'eval', id, vec });
  });
}

async function evaluatePopulation(vectors) {
  const out = new Array(vectors.length);
  let next = 0;
  await Promise.all(pool.map(async (worker) => {
    while (next < vectors.length) {
      const idx = next++;
      out[idx] = await evalOn(worker, idx, vectors[idx]);
    }
  }));
  return out;
}

// ── sep-CMA-ES ──────────────────────────────────────────────────────────────
const N = DIM;
const mu = Math.floor(LAMBDA / 2);
const rawW = Array.from({ length: mu }, (_, i) => Math.log(mu + 0.5) - Math.log(i + 1));
const sumW = rawW.reduce((a, b) => a + b, 0);
const weights = rawW.map((x) => x / sumW);
const muEff = 1 / weights.reduce((a, x) => a + x * x, 0);

const cSigma = (muEff + 2) / (N + muEff + 5);
const dSigma = 1 + 2 * Math.max(0, Math.sqrt((muEff - 1) / (N + 1)) - 1) + cSigma;
const cc = (4 + muEff / N) / (N + 4 + 2 * muEff / N);
// Both learning rates are scaled by (N+2)/3, the standard sep-CMA-ES speed-up
// that a diagonal model permits.
const c1 = (2 / ((N + 1.3) ** 2 + muEff)) * ((N + 2) / 3);
const cmu = Math.min(1 - c1,
  (2 * (muEff - 2 + 1 / muEff) / ((N + 2) ** 2 + muEff)) * ((N + 2) / 3));
const chiN = Math.sqrt(N) * (1 - 1 / (4 * N) + 1 / (21 * N * N));

let mean = toUnit(currentVector());
let sigma = 0.22;                       // in normalised [0,1] units
let C = new Array(N).fill(1);           // diagonal variances
let pSigma = new Array(N).fill(0);
let pc = new Array(N).fill(0);

function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

let best = { loss: Infinity, vec: null, metrics: null };

console.log(`sep-CMA-ES  dim=${N}  lambda=${LAMBDA}  duels/eval=${jobs.length}  generations=${GENERATIONS}`);
// Two workers by default, at the lowest scheduler priority available.
//
// This started at LAMBDA workers — 16 on an 8-core machine, load average 30.
// `availableParallelism() - 2` was the next attempt and it still took four
// cores solid for hours, which is far too much to ask of the machine someone is
// trying to play on. `nice` matters more than the count: at priority 19 the
// tuner only gets cycles nobody else wants, so it cannot compete with the game
// no matter how long it runs. Raise WORKERS deliberately on an idle machine.
const WORKERS = Number(process.env.WORKERS ?? Math.min(LAMBDA, 2));
try {
  setPriority(0, 19);   // affects this process and the workers it spawns
} catch { /* not permitted on some platforms — the low worker count still holds */ }
await spawnPool(WORKERS);
console.log(`pool of ${pool.length} workers ready\n`);

const started = Date.now();

for (let gen = 1; gen <= GENERATIONS; gen++) {
  const D = C.map(Math.sqrt);

  // Sample
  const zs = [], ys = [], xs = [];
  for (let k = 0; k < LAMBDA; k++) {
    const z = Array.from({ length: N }, gauss);
    const y = z.map((zi, i) => D[i] * zi);
    const x = mean.map((mi, i) => Math.min(1, Math.max(0, mi + sigma * y[i])));
    zs.push(z); ys.push(y); xs.push(x);
  }

  const evals = await evaluatePopulation(xs.map(fromUnit));
  const order = evals.map((e, i) => [e.loss, i]).sort((a, b) => a[0] - b[0]);

  if (order[0][0] < best.loss) {
    const i = order[0][1];
    best = { loss: order[0][0], vec: fromUnit(xs[i]), metrics: evals[i].metrics, parts: evals[i].parts };
    writeFileSync(OUT, JSON.stringify({
      loss: best.loss, params: asObject(best.vec),
      metrics: best.metrics, parts: best.parts,
      generations: gen, duelsPerEval: jobs.length,
    }, null, 2));
  }

  // Recombine
  const newMean = new Array(N).fill(0);
  const yW = new Array(N).fill(0);
  for (let r = 0; r < mu; r++) {
    const i = order[r][1];
    for (let d = 0; d < N; d++) {
      newMean[d] += weights[r] * xs[i][d];
      yW[d] += weights[r] * ys[i][d];
    }
  }
  mean = newMean;

  // Step-size control
  for (let d = 0; d < N; d++) {
    pSigma[d] = (1 - cSigma) * pSigma[d]
      + Math.sqrt(cSigma * (2 - cSigma) * muEff) * (yW[d] / D[d]);
  }
  const pSigmaNorm = Math.hypot(...pSigma);
  sigma *= Math.exp((cSigma / dSigma) * (pSigmaNorm / chiN - 1));
  sigma = Math.min(0.5, Math.max(0.01, sigma));

  // Covariance (diagonal)
  const hSig = pSigmaNorm / Math.sqrt(1 - (1 - cSigma) ** (2 * gen)) / chiN < 1.4 + 2 / (N + 1) ? 1 : 0;
  for (let d = 0; d < N; d++) {
    pc[d] = (1 - cc) * pc[d] + hSig * Math.sqrt(cc * (2 - cc) * muEff) * yW[d];
    let rankMu = 0;
    for (let r = 0; r < mu; r++) rankMu += weights[r] * ys[order[r][1]][d] ** 2;
    C[d] = (1 - c1 - cmu) * C[d] + c1 * pc[d] ** 2 + cmu * rankMu;
    C[d] = Math.max(1e-8, C[d]);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  const m = evals[order[0][1]].metrics;
  console.log(
    `gen ${String(gen).padStart(3)}  best ${order[0][0].toFixed(4)}  ` +
    `alltime ${best.loss.toFixed(4)}  sigma ${sigma.toFixed(3)}  ` +
    `ttk ${m.meanTTK.toFixed(2)}s  ` +
    `wr ${Object.values(m.weaponOverall).map((v) => v.toFixed(2)).join('/')}  ` +
    `${elapsed}s`);
}

console.log(`\nBest loss ${best.loss.toFixed(4)} written to ${OUT}`);
console.log(best.parts);
for (const [k] of SPEC) console.log(`  ${k.padEnd(28)} ${asObject(best.vec)[k]}`);

for (const p of pool) p.w.terminate();
