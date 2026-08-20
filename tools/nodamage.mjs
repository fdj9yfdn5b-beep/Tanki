/**
 * Does the damage number on screen match the damage the tank took?
 *
 * "I shoot a tank and it takes no health off" is the most-reported complaint in
 * this project and has had three separate real causes (§4). This asks a
 * narrower question than hit registration, and one nothing has asked before:
 * when a shot DOES connect, is the number the shooter is shown the number that
 * actually landed?
 *
 * `Combat._applyDamage` calls `target.takeDamage(amount)` and then reports
 * `amount` to `onHit` — the damage REQUESTED, not the damage DEALT. Three
 * things sit between the two: spawn protection (total immunity), the SHIELD
 * pickup (a multiplier), and the target's remaining HP.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { Match } from '../src/match.js';
import { SPAWN_PROTECTION, DROP_KINDS } from '../src/config.js';

await RAPIER.init();

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
  if (!ok) failures++;
};

const match = new Match({ RAPIER, scene: null, worldSeed: 20250812 });
const shooter = match.addTank({ id: 1, hull: 'hunter', weapon: 'rail', name: 'shooter' });
const target = match.addTank({ id: 2, hull: 'hunter', weapon: 'twin', name: 'target' });

// Spawn points are known-clear ground; firing along +z from one is the fixture
// corpseblock.mjs already proved can connect.
const base = match.spawns[0];
function stage() {
  for (const [tank, ahead] of [[shooter, 0], [target, 14]]) {
    tank.body.setTranslation({ x: base.x, y: base.y, z: base.z + ahead }, true);
    tank.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    tank.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    tank.turret.rotation.y = 0;
    tank.syncTransform();
  }
  shooter.spawnGuard = 0;
  match.world.step();
  for (const t of [shooter, target]) t.syncTransform();
}

/** Fire once; return what the tank LOST and what the hit event CLAIMED. */
function fire() {
  shooter.cooldown = 0;
  shooter.charge = 1;
  let claimed = null;
  match.combat.onHit = (t, amount) => { claimed = +amount.toFixed(1); };
  const before = target.hp;
  match.combat.tryFire(shooter);
  const lost = +(before - target.hp).toFixed(1);
  return { lost, claimed };
}

console.log('\nwhat the shooter is told, vs what the target lost');

stage();
target.spawnGuard = 0;
target.effects.clear();
const plain = fire();
check('CONTROL: an ordinary hit reports what it dealt',
  plain.claimed !== null && Math.abs(plain.claimed - plain.lost) < 0.05,
  `told ${plain.claimed}, dealt ${plain.lost}`);

stage();
target.hp = target.maxHp;
target.spawnGuard = SPAWN_PROTECTION;
const guarded = fire();
console.log(`\n  spawn-protected target (${SPAWN_PROTECTION}s of immunity):`);
console.log(`      the shooter is told : ${guarded.claimed}`);
console.log(`      the target loses    : ${guarded.lost}`);
check('a shot at a protected tank does not claim damage it did not do',
  guarded.claimed === 0 || guarded.claimed === null,
  guarded.lost === 0 && guarded.claimed > 0
    ? '← the number floats, the health bar does not move'
    : '');

stage();
target.hp = target.maxHp;
target.spawnGuard = 0;
target.giveEffect('shield');
const shielded = fire();
// What the raw shot was worth, recovered from what landed, so the line reads
// the same way whether or not the reporting bug is present.
const expected = +(shielded.claimed / DROP_KINDS.shield.damageTaken).toFixed(1);
console.log(`\n  SHIELD on the target (${DROP_KINDS.shield.blurb}):`);
console.log(`      the shooter is told : ${shielded.claimed}`);
console.log(`      the target loses    : ${shielded.lost}   (${expected} before the shield)`);
check('a shot at a shielded tank reports the reduced figure',
  Math.abs(shielded.claimed - shielded.lost) < 0.05,
  `off by ${(shielded.claimed - shielded.lost).toFixed(1)}`);

// Overkill: the last shot on a nearly-dead tank cannot deal more than is left.
stage();
target.spawnGuard = 0;
target.effects.clear();
target.hp = 20;
const overkill = fire();
console.log(`\n  target on 20 HP, hit for ${overkill.claimed}:`);
console.log(`      the target loses    : ${overkill.lost}`);
check('a killing blow does not report more than the tank had',
  Math.abs(overkill.claimed - overkill.lost) < 0.05,
  `off by ${(overkill.claimed - overkill.lost).toFixed(1)}`);

console.log(`\n${failures ? `FAIL — ${failures} case(s) where the screen and the simulation disagree`
  : 'PASS — the number on screen is the damage that landed'}`);
process.exit(failures ? 1 : 0);
