import { initArena, runDuel } from './duel.mjs';

await initArena();
const t0 = Date.now();
let nulls = 0;
const res = [];
for (let i = 0; i < 40; i++) {
  const r = runDuel({
    a: { hull: 'hunter', weapon: 'twin' },
    b: { hull: 'hunter', weapon: 'rail' },
    band: 'mid', rngSeed: 1000 + i,
  });
  if (!r) { nulls++; continue; }
  res.push(r);
}
const ms = Date.now() - t0;
const decided = res.filter((r) => r.ttk !== null);
console.log('duels:', res.length, ' unstageable:', nulls);
console.log('ms total:', ms, ' ms/duel:', (ms / Math.max(1, res.length)).toFixed(1));
console.log('twin winrate vs rail (mid):', (res.reduce((a, r) => a + r.result, 0) / res.length).toFixed(3));
console.log('mean TTK:', (decided.reduce((a, r) => a + r.ttk, 0) / Math.max(1, decided.length)).toFixed(2), 's');
console.log('timeouts:', res.length - decided.length, '/', res.length);
console.log('mean start dist:', (res.reduce((a, r) => a + r.dist, 0) / res.length).toFixed(1), 'm');
