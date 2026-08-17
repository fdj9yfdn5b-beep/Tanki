/**
 * Do dead tanks block shots?
 *
 * A killed tank used to keep its collider standing exactly where it fell. Every
 * ray in the game hits it: `_fireHitscan` finds a target that is not `alive`,
 * falls through to the terrain branch, and ends the beam there for no damage.
 * The corpse is invisible, so from the player's side a shot simply stopped in
 * mid-air and took no health off — reported as "the shot stops where another
 * tank was and died", and as a share of "half my shots do nothing".
 *
 * Stages a shooter, a live target, and a third tank killed directly between
 * them, then fires and checks whether the damage arrives.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { Match } from '../src/match.js';

await RAPIER.init();
const match = new Match({ RAPIER, scene: null, worldSeed: 20250812 });

const shooter = match.addTank({ id: 1, hull: 'hunter', weapon: 'rail', name: 'shooter' });
const target = match.addTank({ id: 2, hull: 'hunter', weapon: 'twin', name: 'target' });
const corpse = match.addTank({ id: 3, hull: 'hunter', weapon: 'twin', name: 'corpse' });

for (const t of [shooter, target, corpse]) t.spawnGuard = 0;

// Open ground, all three in a line: shooter at 0, corpse at 10m, target at 22m.
const s = match.spawns[0];
const place = (tank, ahead) => {
  tank.body.setTranslation({ x: s.x, y: s.y, z: s.z + ahead }, true);
  tank.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  tank.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  tank.turret.rotation.y = 0;
  tank.syncTransform();
};
place(shooter, 0);
place(corpse, 10);
place(target, 22);
match.world.step();

// Kill the middle one the way the game does.
corpse.hp = 1;
corpse.takeDamage(999, shooter);
match.world.step();

console.log(`corpse alive: ${corpse.alive}   collider enabled: ${corpse.collider.isEnabled()}`);

// Fire straight down the line. Rail is hitscan with no spread, so this is a
// clean question: does the beam reach the target 12m past the body?
for (const t of [shooter, target, corpse]) t.syncTransform();
shooter.charge = 1;
shooter.cooldown = 0;
const before = target.hp;
match.combat.tryFire(shooter);
const dealt = before - target.hp;

console.log(`\nshooter -> corpse at 10m -> live target at 22m`);
console.log(`  damage that reached the target: ${dealt.toFixed(1)}`);

// Control: put the corpse's collider back and confirm the shot IS blocked, so
// a pass here means something rather than the test being unable to fail.
corpse.collider.setEnabled(true);
match.world.step();
for (const t of [shooter, target, corpse]) t.syncTransform();
shooter.charge = 1;
shooter.cooldown = 0;
const before2 = target.hp;
match.combat.tryFire(shooter);
const dealtBlocked = before2 - target.hp;
console.log(`  with the corpse solid again:     ${dealtBlocked.toFixed(1)}`);

const ok = dealt > 0 && dealtBlocked === 0;
console.log(`\n${ok ? 'PASS — corpses are see-through, and the control confirms the test can fail'
  : 'FAIL — ' + (dealt === 0 ? 'the shot died on the corpse' : 'the control did not block, so this test proves nothing')}`);
process.exit(ok ? 0 : 1);
