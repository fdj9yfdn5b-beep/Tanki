// How much HP does a Wasp actually need to break even with a Mammoth?
//
// Tuning moved Wasp from 0.215 to only 0.280 in same-weapon mirrors. Either the
// optimiser under-weighted hull mirrors (they are 9 of 36 pairs, so only a
// quarter of the pair term), or hull parity is simply unreachable inside the
// bounds. A direct sweep answers which, and costs one run instead of an hour.

import { initArena, runDuel } from './duel.mjs';
import { apply, SPEC } from './params.mjs';
import { HULLS } from '../src/config.js';
import { readFileSync } from 'node:fs';

await initArena();
apply(SPEC.map(([k]) => JSON.parse(
  readFileSync(new URL('./tuned.json', import.meta.url), 'utf8')).params[k]));

const N = Number(process.argv[2] ?? 14);
const mammothHp = HULLS.mammoth.hp;
const baseSpeed = HULLS.wasp.maxSpeed;

console.log(`Mammoth: hp=${mammothHp.toFixed(0)} speed=${HULLS.mammoth.maxSpeed.toFixed(1)}`);
console.log(`Wasp speed held at ${baseSpeed.toFixed(1)}\n`);
console.log('  wasp.hp   hp ratio   wasp winrate vs mammoth (same weapon)');

for (const hp of [190, 255, 300, 350, 400, 444, 500]) {
  HULLS.wasp.hp = hp;
  let sum = 0, n = 0;
  for (const weapon of ['twin', 'thunder', 'rail']) {
    for (const band of ['close', 'mid', 'long']) {
      for (let k = 0; k < N; k++) {
        const swap = k % 2 === 1;
        const r = runDuel({
          a: { weapon, hull: swap ? 'mammoth' : 'wasp' },
          b: { weapon, hull: swap ? 'wasp' : 'mammoth' },
          band, rngSeed: (hp * 31 + k * 6151) >>> 0,
        });
        if (!r) continue;
        sum += swap ? 1 - r.result : r.result;
        n++;
      }
    }
  }
  const wr = sum / n;
  const bar = '#'.repeat(Math.round(wr * 40));
  const flag = hp > 260 ? '  <- above the wasp.hp bound (260)' : '';
  console.log(`  ${String(hp).padStart(6)}   ${(mammothHp / hp).toFixed(2)}x      ${wr.toFixed(3)}  ${bar}${flag}`);
}
