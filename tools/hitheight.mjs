/**
 * Can every hull actually shoot every other hull?
 *
 * Shots fly FLAT — no gravity, no barrel elevation (§5). That is only safe
 * while every tank's muzzle sits inside every other tank's collider, which was
 * true for as long as all three hulls rested on the ground at roughly the same
 * height. `wraith` floats, and a floating tank both shoots over everyone and is
 * shot under, which is exactly what a playtest reported.
 *
 * This measures the real thing rather than reasoning about it: settle one of
 * each hull on open ground, then cast the actual shot ray from each shooter's
 * real muzzle at each target and report what it hits. Any FAIL here is a pair
 * of tanks that cannot damage each other at all.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Match } from '../src/match.js';
import { HULLS } from '../src/config.js';

await RAPIER.init();

const RANGE = Number(process.env.RANGE ?? 18);
const hulls = Object.keys(HULLS);

const match = new Match({ RAPIER, scene: null, worldSeed: 20250812 });

// One of each hull, parked far apart on open ground so nothing collides while
// they settle. Spawn points are known-clear.
const tanks = {};
hulls.forEach((h, i) => {
  const t = match.addTank({ id: i + 1, hull: h, weapon: 'twin', name: h });
  const s = match.spawns[i % match.spawns.length];
  t.body.setTranslation({ x: s.x, y: s.y, z: s.z }, true);
  tanks[h] = t;
});

const idle = { throttle: 0, steer: 0, strafe: 0, turretSteer: 0, aimPoint: null, fire: false };
for (let i = 0; i < 240; i++) match.step(new Map());   // let them settle / hover

// Captured ONCE, before anything gets moved. Reading these back later from the
// live bodies is how the first version of this tool reported tanks 50m in the
// air: the loop below parks the hulls it is not testing out of the way, and
// then re-read those parked heights as if they were resting heights.
const rest = {};
for (const h of hulls) {
  const t = tanks[h];
  t.syncTransform(); t.root.updateMatrixWorld(true);
  // Read the box off the collider itself rather than from hull.size — it is
  // grown to cover the turret, and on a hover hull the anti-grav cushion too.
  const c = t.collider.halfExtents().y;
  const off = t.collider.translation().y - t.body.translation().y;
  rest[h] = {
    y: t.body.translation().y,
    lo: t.body.translation().y + off - c,
    hi: t.body.translation().y + off + c,
    muzzle: t.muzzlePosition.y,
  };
}

console.log(`Resting geometry (${RANGE}m test range)\n`);
console.log('  hull       body y   hit box y       muzzle y');
for (const h of hulls) {
  const r = rest[h];
  console.log(`  ${h.padEnd(9)}  ${r.y.toFixed(2).padStart(5)}   ` +
    `${r.lo.toFixed(2)} – ${r.hi.toFixed(2)}   ${r.muzzle.toFixed(2).padStart(6)}`);
}

// How close the worst pairing is to failing. Passing is not enough on its own:
// tanks ride over steps and a hover hull's height varies, so a margin of a few
// centimetres is a bug that has not happened yet.
const muzzles = hulls.map((h) => rest[h].muzzle);
let worst = { margin: Infinity, what: '' };
for (const h of hulls) {
  for (const [i, m] of muzzles.entries()) {
    if (hulls[i] === h) continue;
    const margin = Math.min(m - rest[h].lo, rest[h].hi - m);
    if (margin < worst.margin) worst = { margin, what: `${hulls[i]}'s muzzle vs ${h}'s box` };
  }
}
console.log(`\n  tightest margin: ${worst.margin.toFixed(2)}m  (${worst.what})`);

// ── Can each shooter's ray reach each target? ───────────────────────────────
// Stage the pair alone: shooter at origin facing +Z, target RANGE ahead, both
// at the height they settle to. Then fire the real ray.
console.log(`\nShot ray from each muzzle at each target:\n`);
const spare = match.spawns[0];
let fails = 0;
const rows = [];

for (const sh of hulls) {
  for (const tg of hulls) {
    if (sh === tg) continue;
    const shooter = tanks[sh], target = tanks[tg];

    shooter.body.setTranslation({ x: spare.x, y: rest[sh].y, z: spare.z }, true);
    shooter.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    shooter.turret.rotation.y = 0;
    target.body.setTranslation({ x: spare.x, y: rest[tg].y, z: spare.z + RANGE }, true);
    target.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);

    // Move everyone else out of the way.
    for (const o of hulls) {
      if (o === sh || o === tg) continue;
      tanks[o].body.setTranslation({ x: spare.x + 300, y: 50, z: spare.z + 300 }, true);
    }
    match.world.step();
    shooter.syncTransform(); shooter.root.updateMatrixWorld(true);

    const o = shooter.muzzlePosition;
    const d = shooter.aimDirection();
    const hit = match.world.castRay(
      new RAPIER.Ray({ x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z }),
      RANGE + 10, true, undefined, undefined, undefined, shooter.body);
    const struck = hit ? match.combat.byCollider.get(hit.collider.handle) : null;

    const ok = struck === target;
    if (!ok) fails++;
    const r = rest[tg];
    rows.push(
      `  ${sh.padEnd(8)} -> ${tg.padEnd(9)} ${ok ? 'hit ' : 'MISS'}   ` +
      `muzzle ${o.y.toFixed(2)}  target box ${r.lo.toFixed(2)}–${r.hi.toFixed(2)}` +
      `   ${o.y > r.hi ? '(passes OVER)' : o.y < r.lo ? '(passes UNDER)' : ''}`);
  }
}
console.log(rows.join('\n'));

console.log(`\n${fails === 0 ? 'PASS' : `FAIL — ${fails} pairing(s) cannot hit each other`}`);
process.exit(fails === 0 ? 0 : 1);
