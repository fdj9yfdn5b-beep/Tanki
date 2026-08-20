/**
 * At what sideways offset does a shot stop registering?
 *
 * A tank is a box you can see. A shell is a sprite nearly a metre across. But
 * the hit test sweeps a mathematically thin RAY, so a shell whose sprite
 * visibly overlaps the hull by 40cm can pass it without touching anything —
 * "hits at the corner do nothing, only the middle counts".
 *
 * Fires at a stationary target across a range of lateral offsets and reports
 * the widest offset that still deals damage, against the target's real
 * half-width.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { Match } from '../src/match.js';
import { HULLS, WEAPONS, EVASION } from '../src/config.js';

await RAPIER.init();

// Spread would scatter the answer by ±0.22m at 12m and turn a clean geometric
// question into a noisy one — the first run of this reported hits 0.25m WIDER
// than the target, which was just a lucky draw. Zero it for the measurement.
WEAPONS.twin.spread = 0;
EVASION.gain = 0;
EVASION.max = 0;
const RANGE = Number(process.env.RANGE ?? 12);
const HULL = process.env.HULL ?? 'hunter';

const m = new Match({ RAPIER, scene: null, worldSeed: 1 });
const shooter = m.addTank({ id: 1, hull: 'hunter', weapon: 'twin', name: 'S' });
const target = m.addTank({ id: 2, hull: HULL, weapon: 'twin', name: 'T' });
shooter.spawnGuard = 0; target.spawnGuard = 0;

const s = m.spawns[0];
const halfW = target.collider.halfExtents().x;

function shotLands(offset) {
  shooter.body.setTranslation({ x: s.x, y: s.y, z: s.z }, true);
  shooter.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  shooter.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  shooter.turret.rotation.y = 0;
  shooter.cooldown = 0;
  shooter.syncTransform();

  const o = shooter.muzzlePosition, d = shooter.aimDirection();
  // Offset the TARGET sideways rather than steering, so the shot line is exact.
  const right = { x: -d.z, z: d.x };
  target.body.setTranslation({
    x: o.x + d.x * RANGE + right.x * offset,
    y: shooter.body.translation().y,
    z: o.z + d.z * RANGE + right.z * offset,
  }, true);
  target.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  target.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  target.hp = target.maxHp;
  target.syncTransform();
  m.world.step();

  m.combat.tryFire(shooter);
  for (let i = 0; i < 90; i++) m.combat.update(1 / 60);
  return target.hp < target.maxHp;
}

let widest = -1;
const rows = [];
for (let off = 0; off <= halfW + 0.8; off += 0.05) {
  const hit = shotLands(off);
  if (hit) widest = off;
  if (Math.abs(off % 0.25) < 0.001) rows.push(`${off.toFixed(2)}m ${hit ? 'hit' : '--'}`);
}

console.log(`target: ${HULL}, half-width ${halfW.toFixed(2)}m, range ${RANGE}m\n`);
console.log('  ' + rows.join('   '));
console.log(`\n  widest offset that still damages: ${widest.toFixed(2)}m`);
console.log(`  target's actual half-width:        ${halfW.toFixed(2)}m`);
const gap = halfW - widest;
console.log(`  dead band at the edge:            ${gap.toFixed(2)}m` +
  (gap > 0.05 ? '   <-- shots that look like hits and are not' : '   (matches)'));
