// Where is the remaining loss actually coming from?
//
// The optimiser tunes weapons only. If the leftover imbalance lives in
// same-weapon / different-hull matchups, then no amount of further weapon
// tuning can reach it and the search space itself is the limit.

import { initArena } from './duel.mjs';
import { buildJobs, runJobs, aggregate, LOADOUTS } from './evaluate.mjs';
import { apply, SPEC } from './params.mjs';
import { readFileSync } from 'node:fs';

await initArena();
const saved = JSON.parse(readFileSync(new URL('./tuned.json', import.meta.url), 'utf8'));
apply(SPEC.map(([k]) => saved.params[k]));

const m = aggregate(runJobs(buildJobs(10, 5000)));

let sameWeapon = { sum: 0, n: 0, worst: null };
let crossWeapon = { sum: 0, n: 0, worst: null };

for (const p of m.pairWinrates) {
  const [i, j] = p.pair.split(':').map(Number);
  const a = LOADOUTS[i], b = LOADOUTS[j];
  const err = (p.wr - 0.5) ** 2;
  const bucket = a.weapon === b.weapon ? sameWeapon : crossWeapon;
  bucket.sum += err;
  bucket.n++;
  if (!bucket.worst || Math.abs(p.wr - 0.5) > Math.abs(bucket.worst.wr - 0.5)) {
    bucket.worst = { pair: `${a.id} vs ${b.id}`, wr: p.wr };
  }
}

const total = sameWeapon.sum + crossWeapon.sum;
const show = (label, b) => {
  console.log(`${label}`);
  console.log(`  pairs           ${b.n}`);
  console.log(`  mean sq error   ${(b.sum / b.n).toFixed(4)}`);
  console.log(`  share of loss   ${(b.sum / total * 100).toFixed(1)}%`);
  console.log(`  worst           ${b.worst.pair}  ${b.worst.wr.toFixed(3)}\n`);
};

console.log('\nRemaining pair imbalance, decomposed\n');
show('SAME weapon, different hull  (outside the search space)', sameWeapon);
show('DIFFERENT weapon             (what the optimiser can reach)', crossWeapon);

console.log('Hull win rates in same-weapon mirrors (the confound: bots barely dodge)');
const hullWins = {};
for (const p of m.pairWinrates) {
  const [i, j] = p.pair.split(':').map(Number);
  const a = LOADOUTS[i], b = LOADOUTS[j];
  if (a.weapon !== b.weapon) continue;
  hullWins[a.hull] ??= { sum: 0, n: 0 };
  hullWins[b.hull] ??= { sum: 0, n: 0 };
  hullWins[a.hull].sum += p.wr; hullWins[a.hull].n++;
  hullWins[b.hull].sum += 1 - p.wr; hullWins[b.hull].n++;
}
for (const [h, v] of Object.entries(hullWins)) {
  console.log(`  ${h.padEnd(9)} ${(v.sum / v.n).toFixed(3)}`);
}
