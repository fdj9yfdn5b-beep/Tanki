/**
 * At what range does a shot stop doing anything?
 *
 * Reported: "I shoot at another tank and it takes no health off" — at range,
 * not up close. Two mechanics could produce that and they need separating,
 * because the fixes are opposites:
 *
 *   FALLOFF   the shot lands and is worth almost nothing (Twin drops to 5
 *             damage past 26m, by design)
 *   MISSING   the shot never arrives at all
 *
 * And there is a third that only exists at range: these are PROJECTILES with a
 * finite muzzle speed and no lead indicator anywhere on screen. §5's contract
 * is "the barrel is the reticle" — which is exactly true for a hitscan weapon
 * and gets less true every metre for a shell in flight against a moving target.
 *
 * Aims dead centre, the way a player does with nothing on screen telling them
 * to lead, and reports what fraction of a health bar the shot was worth.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { Match, TICK_DT } from '../src/match.js';
import { WEAPONS, HULLS, damageAtRange } from '../src/config.js';

await RAPIER.init();

const RANGES = [10, 20, 30, 40, 50, 60];
const SHOTS = Number(process.env.SHOTS ?? 120);

const match = new Match({ RAPIER, scene: null, worldSeed: 20250812 });
const shooter = match.addTank({ id: 1, hull: 'hunter', weapon: 'twin', name: 'shooter' });
const target = match.addTank({ id: 2, hull: 'hunter', weapon: 'twin', name: 'target' });

/**
 * Find a lane of open ground `dist` long, and PROVE it is open before using it.
 *
 * Not optional. This project's most expensive recurring mistake is a fixture
 * that could not have hit anything — tanks inside the centre structure, off the
 * firing line, at the wrong height. A "0% hit rate at 60m" from a blocked lane
 * would read exactly like the bug being investigated.
 */
const laneCache = new Map();

/**
 * Find a lane of open ground `dist` long, and PROVE it before using it.
 *
 * The proof is the important part and it is not a geometry argument: place both
 * tanks, then fire a test ray from the shooter's own muzzle along its own aim
 * direction and require that the FIRST thing it meets is the target. That is
 * the exact query the game runs, so a lane that passes it can definitely be hit
 * by a hitscan weapon — which makes Rail-vs-stationary a positive control built
 * into the fixture.
 *
 * Two earlier versions of this got it wrong in opposite directions. The first
 * only searched radial lines inward and could not find any clear lane past 30m,
 * reporting "no lane" for precisely the ranges in question. The second added a
 * clearance probe either side of the target, which quietly rejected the good
 * lanes and settled on ones where nothing could hit anything — the table came
 * out with Rail at 0% everywhere, which is impossible for a hitscan weapon and
 * was the tell that the fixture, not the game, was broken. This project's
 * single most expensive recurring mistake, three sessions running.
 */
function findLane(dist) {
  if (laneCache.has(dist)) return laneCache.get(dist);
  for (let deg = 0; deg < 360; deg += 3) {
    const a = (deg * Math.PI) / 180;
    const dir = { x: Math.cos(a), y: 0, z: Math.sin(a) };
    const yaw = Math.atan2(dir.x, dir.z);
    for (let sx = -52; sx <= 52; sx += 8) {
      for (let sz = -52; sz <= 52; sz += 8) {
        const from = { x: sx, y: 0.85, z: sz };
        const to = { x: sx + dir.x * dist, y: 0.85, z: sz + dir.z * dist };
        if (Math.abs(to.x) > 54 || Math.abs(to.z) > 54) continue;

        place(shooter, from, yaw);
        place(target, to, yaw);
        match.world.step();
        shooter.syncTransform();
        target.syncTransform();

        const o = shooter.muzzlePosition;
        const d = shooter.aimDirection();
        const hit = match.world.castRay(
          new RAPIER.Ray({ x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z }),
          dist + 8, true, undefined, undefined, undefined, shooter.body);
        if (!hit || match.combat.byCollider.get(hit.collider.handle) !== target) continue;

        // The ray is not proof enough — a lane passed it at 50m and then Rail,
        // a hitscan weapon with no spread against a stationary target, scored
        // 0%, which cannot happen. So fire an actual control shot and require
        // it to land. Now the fixture cannot be accepted unless the game
        // itself has demonstrated a hit down it.
        const held = shooter.weaponKey;
        shooter.setWeapon('rail');
        shooter.cooldown = 0;
        shooter.charge = 1;
        target.hp = target.maxHp;
        match.combat.tryFire(shooter);
        const landed = target.maxHp - target.hp;
        target.hp = target.maxHp;
        shooter.setWeapon(held);
        if (landed <= 0) continue;

        const lane = { from, dir, to, yaw };
        laneCache.set(dist, lane);
        return lane;
      }
    }
  }
  laneCache.set(dist, null);
  return null;
}

function place(tank, p, yaw) {
  tank.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
  tank.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  tank.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  tank.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  tank.turret.rotation.y = 0;
  tank.turretVel = 0;
  tank.spawnGuard = 0;
  tank.syncTransform();
}

/** One shot, aimed dead centre at where the target is RIGHT NOW. */
function shot(weaponKey, dist, crossSpeed) {
  const lane = findLane(dist);
  if (!lane) return null;
  const yaw = lane.yaw;

  shooter.setWeapon(weaponKey);
  place(shooter, lane.from, yaw);
  place(target, lane.to, yaw);
  target.hp = target.maxHp;

  // Across the line of fire, which is the direction that defeats a shell in
  // flight. Held every tick: a tank under power does not coast to a stop.
  const cross = { x: -lane.dir.z * crossSpeed, y: 0, z: lane.dir.x * crossSpeed };
  const hold = () => target.body.setLinvel(cross, true);
  hold();
  match.world.step();
  shooter.syncTransform();
  target.syncTransform();

  shooter.cooldown = 0;
  shooter.charge = 1;
  const before = target.hp;
  match.combat.tryFire(shooter);

  // Let the shell fly. Hitscan resolves immediately and this loop just exits.
  for (let i = 0; i < 240 && match.combat.projectiles.length; i++) {
    hold();
    match.combat.update(TICK_DT);
    match.world.step();
  }
  return before - target.hp;
}

const maxHp = HULLS.hunter.hp;
console.log(`\naiming dead centre at a ${HULLS.hunter.hp} HP Hunter — no lead, which is what`);
console.log(`the game tells you to do (§5: flat trajectory, the barrel is the reticle)\n`);

for (const crossSpeed of [0, HULLS.hunter.maxSpeed]) {
  console.log(crossSpeed === 0
    ? '── STATIONARY target ────────────────────────────────────────────────'
    : `── target CROSSING at ${crossSpeed.toFixed(1)} m/s ─────────────────────────────`);
  console.log('        ' + RANGES.map((r) => `${r}m`.padStart(9)).join(''));

  for (const key of ['twin', 'thunder', 'rail']) {
    const hitRow = [];
    const dmgRow = [];
    for (const dist of RANGES) {
      let hits = 0, total = 0, n = 0;
      for (let i = 0; i < SHOTS; i++) {
        const d = shot(key, dist, crossSpeed);
        if (d === null) break;
        n++;
        if (d > 0) hits++;
        total += d;
      }
      if (!n) { hitRow.push('  no lane'); dmgRow.push('        -'); continue; }
      hitRow.push(`${((hits / n) * 100).toFixed(0)}%`.padStart(9));
      // What one shot is worth as a share of the target's health, which is the
      // number the player actually perceives.
      dmgRow.push(`${((total / n / maxHp) * 100).toFixed(1)}%`.padStart(9));
    }
    console.log(`${key.padEnd(8)}${hitRow.join('')}   hits`);
    console.log(`${''.padEnd(8)}${dmgRow.join('')}   of a health bar per shot`);
  }
  console.log('');
}

console.log('for reference, damage the weapon is WORTH at each range (a hit, before spread):');
console.log('        ' + RANGES.map((r) => `${r}m`.padStart(9)).join(''));
for (const key of ['twin', 'thunder', 'rail']) {
  console.log(key.padEnd(8) + RANGES.map((r) =>
    `${((damageAtRange(WEAPONS[key], r) / maxHp) * 100).toFixed(1)}%`.padStart(9)).join(''));
}
