import { initArena } from './duel.mjs';
import { buildJobs, runJobs, aggregate, objective, LOADOUTS, BAND_KEYS, WEAPON_KEYS } from './evaluate.mjs';
import { apply, currentVector, SPEC } from './params.mjs';
import { readFileSync } from 'node:fs';

const N = Number(process.argv[2] ?? 14);
const vecFile = process.argv[3];

await initArena();

if (vecFile) {
  const saved = JSON.parse(readFileSync(vecFile, 'utf8'));
  apply(SPEC.map(([k]) => saved.params[k]));
  console.log(`Applied tuned parameters from ${vecFile}\n`);
} else {
  apply(currentVector());
  console.log('Baseline (current config.js)\n');
}

const t0 = Date.now();
const jobs = buildJobs(N);
const results = runJobs(jobs);
const m = aggregate(results);
const loss = objective(m);

console.log(`${m.duels} duels in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

console.log('Weapon winrate overall (target 0.500)');
for (const w of WEAPON_KEYS) {
  const v = m.weaponOverall[w];
  const bar = '█'.repeat(Math.round(v * 40));
  console.log(`  ${w.padEnd(9)} ${v.toFixed(3)}  ${bar}`);
}

console.log('\nWeapon winrate by engagement band  (* = its designated band)');
console.log(`  ${''.padEnd(9)} ${BAND_KEYS.map((b) => b.padStart(7)).join('')}`);
for (const w of WEAPON_KEYS) {
  const own = (await import('../src/config.js')).WEAPONS[w].band;
  const row = BAND_KEYS.map((b) => {
    const v = m.weaponByBand[w][b].toFixed(3);
    return (b === own ? `*${v}` : ` ${v}`).padStart(7);
  }).join('');
  console.log(`  ${w.padEnd(9)} ${row}`);
}

const worst = [...m.pairWinrates].sort((a, b) =>
  Math.abs(b.wr - 0.5) - Math.abs(a.wr - 0.5)).slice(0, 6);
console.log('\nMost lopsided matchups');
for (const p of worst) {
  const [i, j] = p.pair.split(':').map(Number);
  console.log(`  ${LOADOUTS[i].id.padEnd(16)} vs ${LOADOUTS[j].id.padEnd(16)} ${p.wr.toFixed(3)}`);
}

const { TTK_TARGET } = await import('../src/config.js');
console.log(`\nMean TTK    ${m.meanTTK.toFixed(2)}s   (target ${TTK_TARGET[0]}-${TTK_TARGET[1]}s)`);
console.log(`Timeouts    ${(m.timeoutRate * 100).toFixed(1)}%`);
console.log(`\nLOSS ${loss.total.toFixed(4)}`, loss.parts);
