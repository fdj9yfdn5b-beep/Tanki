// Does teaching bots to dodge change what a hull is worth?
//
// If Wasp's winrate in same-weapon mirrors moves once bots evade, then the
// earlier hull numbers were measuring the bot's inability to dodge, not the
// hull. That is the precondition for letting hulls into the search space.

import { initArena, runDuel } from './duel.mjs';
import { HULLS, WEAPONS } from '../src/config.js';

await initArena();

const hulls = Object.keys(HULLS);
const weapons = Object.keys(WEAPONS);
const N = Number(process.argv[2] ?? 24);

const wins = Object.fromEntries(hulls.map((h) => [h, { sum: 0, n: 0 }]));
const perPair = [];

for (const weapon of weapons) {
  for (let i = 0; i < hulls.length; i++) {
    for (let j = i + 1; j < hulls.length; j++) {
      let sum = 0, n = 0;
      for (const band of ['close', 'mid', 'long']) {
        for (let k = 0; k < N; k++) {
          const swap = k % 2 === 1;
          const a = { weapon, hull: swap ? hulls[j] : hulls[i] };
          const b = { weapon, hull: swap ? hulls[i] : hulls[j] };
          const r = runDuel({ a, b, band, rngSeed: (i * 733 + j * 197 + k * 6151) >>> 0 });
          if (!r) continue;
          const winI = swap ? 1 - r.result : r.result;
          sum += winI; n++;
        }
      }
      if (!n) continue;
      const wr = sum / n;
      perPair.push({ weapon, pair: `${hulls[i]} vs ${hulls[j]}`, wr: +wr.toFixed(3), n });
      wins[hulls[i]].sum += wr; wins[hulls[i]].n++;
      wins[hulls[j]].sum += 1 - wr; wins[hulls[j]].n++;
    }
  }
}

console.log('\nHull winrate in same-weapon mirrors (bots now dodge)\n');
for (const h of hulls) {
  const wr = wins[h].sum / wins[h].n;
  console.log(`  ${h.padEnd(9)} ${wr.toFixed(3)}  hp=${HULLS[h].hp} speed=${HULLS[h].maxSpeed}` +
    `  ${'█'.repeat(Math.round(wr * 40))}`);
}
console.log('\nPer weapon:');
for (const p of perPair) console.log(`  ${p.weapon.padEnd(9)} ${p.pair.padEnd(22)} ${p.wr}  (n=${p.n})`);
