/**
 * Does the game mode actually work?
 *
 * Five separate questions, each with a control that makes a pass mean
 * something. §8 of the handoff: two tests in this repo once reported PASS while
 * measuring nothing, and both were caught by deliberately making them fail.
 *
 *   1. sides      — balanced, and spawning on their own half
 *   2. friendly   — a shot at a teammate does nothing, a shot at an enemy does
 *   3. splash     — the same, for the weapon whose damage does not use a ray
 *                   (the exact shape of the ghost-splash bug in §4: a gate
 *                   applied on one damage path and not the other)
 *   4. the end    — the match stops at the target, names a winner, and the
 *                   intermission resets it
 *   5. the clock  — out of time, the leader wins; level, it is a draw
 *   6. sandbox    — a bare `new Match()` is unchanged: no sides, no end, and
 *                   damage that always lands. Every tool in tools/ depends on
 *                   this, and a mode that ended after 7 minutes would silently
 *                   stop resolving damage in the middle of a balance run.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { Match, TICK_DT } from '../src/match.js';
import { INTERMISSION, MODES } from '../src/config.js';

await RAPIER.init();

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
  if (!ok) failures++;
};

const build = (mode) => new Match({ RAPIER, scene: null, worldSeed: 20250812, mode });

// Put two tanks on open ground in a straight line, facing each other, and make
// sure the shot CAN connect before asking whether it does. Every wasted hour in
// this project's history came from a fixture that could not have hit anything.
function stage(match, shooter, target, gap = 16) {
  // Off a SPAWN POINT, not off the origin. The first version of this staged
  // both tanks near the middle of the map, which is where the centre structure
  // is — every control fired into a wall and reported zero damage, and the
  // friendly-fire checks "passed" on a fixture that could not have hit
  // anything. That is the trap §4 spends a paragraph on. Spawn points are
  // known-clear ground, and firing along +z from one is what corpseblock.mjs
  // already does.
  const base = match.spawns[0];
  for (const [tank, ahead] of [[shooter, 0], [target, gap]]) {
    tank.body.setTranslation({ x: base.x, y: base.y, z: base.z + ahead }, true);
    tank.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    tank.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    tank.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    tank.turret.rotation.y = 0;
    tank.turretVel = 0;
    tank.spawnGuard = 0;
    tank.syncTransform();
  }
  match.world.step();
  for (const t of [shooter, target]) t.syncTransform();
}

/** Fire once and report the damage that arrived, plus any 'ff' event. */
function shootOnce(match, shooter, target) {
  shooter.cooldown = 0;
  shooter.charge = 1;
  match.events.length = 0;
  const before = target.hp;
  match.combat.tryFire(shooter);
  // Shells are not hitscan: run the projectile forward until it is consumed.
  for (let i = 0; i < 200 && match.combat.projectiles.length; i++) {
    match.combat.update(TICK_DT);
    match.world.step();
  }
  return {
    dealt: +(before - target.hp).toFixed(1),
    ff: match.events.filter((e) => e.e === 'ff').length,
  };
}

// ── 1. Sides ────────────────────────────────────────────────────────────────
console.log('\nsides');
{
  const match = build('tdm');
  const made = [];
  for (let i = 0; i < 6; i++) {
    made.push(match.addTank({ id: i + 1, hull: 'hunter', weapon: 'twin', name: `T${i}` }));
  }
  const red = made.filter((t) => t.team === 'red');
  const blue = made.filter((t) => t.team === 'blue');
  check('six tanks split three and three', red.length === 3 && blue.length === 3,
    `red ${red.length}, blue ${blue.length}`);

  const onOwnHalf = made.every((t) =>
    (t.team === 'red' ? t.position.x < 0 : t.position.x > 0));
  check('everyone spawns on their own half', onOwnHalf,
    made.map((t) => `${t.team[0]}${t.position.x.toFixed(0)}`).join(' '));

  const ffa = build('ffa');
  const solo = ffa.addTank({ id: 1, hull: 'hunter', weapon: 'twin', name: 'x' });
  check('a mode without sides assigns none', solo.team === null, `team=${solo.team}`);
}

// ── 2. Friendly fire, hitscan ───────────────────────────────────────────────
console.log('\nfriendly fire (rail — hitscan)');
{
  const match = build('tdm');
  const a = match.addTank({ id: 1, hull: 'hunter', weapon: 'rail', name: 'a' });
  const b = match.addTank({ id: 2, hull: 'hunter', weapon: 'rail', name: 'b' });

  // Control FIRST, so a zero later cannot be the fixture rather than the rule.
  // addTank alternates sides, so these two start as enemies.
  stage(match, a, b);
  const enemy = shootOnce(match, a, b);
  check('CONTROL: a shot at an enemy lands', enemy.dealt > 0, `${enemy.dealt} damage`);

  b.setTeam(a.team);
  stage(match, a, b);
  const mate = shootOnce(match, a, b);
  check('a shot at a teammate does nothing', mate.dealt === 0, `${mate.dealt} damage`);
  check('and it says so on the wire', mate.ff === 1, `${mate.ff} ff events`);
}

// ── 3. Friendly fire, splash ────────────────────────────────────────────────
console.log('\nfriendly fire (thunder — splash, no ray)');
{
  const match = build('tdm');
  const a = match.addTank({ id: 1, hull: 'hunter', weapon: 'thunder', name: 'a' });
  const b = match.addTank({ id: 2, hull: 'hunter', weapon: 'thunder', name: 'b' });

  stage(match, a, b, 14);
  const enemy = shootOnce(match, a, b);
  check('CONTROL: splash on an enemy lands', enemy.dealt > 0, `${enemy.dealt} damage`);

  b.setTeam(a.team);
  stage(match, a, b, 14);
  const mate = shootOnce(match, a, b);
  check('splash on a teammate does nothing', mate.dealt === 0, `${mate.dealt} damage`);
}

// ── 4. The end of a match ───────────────────────────────────────────────────
console.log('\nthe end');
{
  const match = build('tdm');
  const a = match.addTank({ id: 1, hull: 'hunter', weapon: 'twin', name: 'a' });
  match.addTank({ id: 2, hull: 'hunter', weapon: 'twin', name: 'b' });
  const noInput = new Map();

  match.teamScore[a.team] = MODES.tdm.scoreTarget - 1;
  match.step(noInput);
  check('CONTROL: one point short is still live', match.phase === 'live', match.phase);

  match.teamScore[a.team] = MODES.tdm.scoreTarget;
  match.events.length = 0;
  match.step(noInput);
  check('reaching the target ends it', match.phase === 'over', match.phase);
  check('and names the winner', match.winner === a.team, `winner=${match.winner}`);
  check('and announces it once', match.events.filter((e) => e.e === 'over').length === 1);

  // Firing is off, and so is damage, for as long as the result is on screen.
  const before = match.tanks.get(2).hp;
  match.step(new Map([[1, {
    throttle: 0, steer: 0, strafe: 0, turretSteer: 0, aimPoint: null, fire: true,
  }]]));
  check('nothing can be scored after the whistle',
    match.tanks.get(2).hp === before && match.combat.projectiles.length === 0);

  // Run out the intermission.
  const need = Math.ceil(INTERMISSION / TICK_DT) + 2;
  match.drops.push({ id: 99, kind: 'shield', x: 0, z: 0, y: 1.2, groundY: 1.2, age: 0 });
  a.kills = 4; a.score = 40;
  for (let i = 0; i < need; i++) match.step(noInput);
  check('the intermission starts a new match', match.phase === 'live', match.phase);
  check('with the scores wiped',
    match.teamScore.red === 0 && match.teamScore.blue === 0 && a.score === 0 && a.kills === 0,
    `red ${match.teamScore.red} blue ${match.teamScore.blue} a ${a.score}`);
  check('and the field cleared of crates', match.drops.length === 0, `${match.drops.length} left`);
}

// ── 5. The clock ────────────────────────────────────────────────────────────
console.log('\nthe clock');
{
  const run = (red, blue) => {
    const match = build('tdm');
    match.addTank({ id: 1, hull: 'hunter', weapon: 'twin', name: 'a' });
    match.addTank({ id: 2, hull: 'hunter', weapon: 'twin', name: 'b' });
    match.teamScore.red = red;
    match.teamScore.blue = blue;
    match.phaseTick = Math.ceil(MODES.tdm.timeLimit / TICK_DT);
    match.step(new Map());
    return match;
  };
  const ahead = run(30, 20);
  check('out of time, the leader wins',
    ahead.phase === 'over' && ahead.winner === 'red', `winner=${ahead.winner}`);
  const level = run(20, 20);
  check('level on time is a draw',
    level.phase === 'over' && level.winner === null, `winner=${level.winner}`);
}

// ── 6. The sandbox is untouched ─────────────────────────────────────────────
console.log('\nsandbox (what every tool in tools/ runs)');
{
  const match = new Match({ RAPIER, scene: null, worldSeed: 20250812 });
  const a = match.addTank({ id: 1, hull: 'hunter', weapon: 'rail', name: 'a' });
  const b = match.addTank({ id: 2, hull: 'hunter', weapon: 'rail', name: 'b' });
  check('no sides', a.team === null && b.team === null);

  stage(match, a, b);
  const hit = shootOnce(match, a, b);
  check('damage always lands', hit.dealt > 0, `${hit.dealt} damage`);

  // Past every real mode's time limit, and still going.
  match.phaseTick = Math.ceil(MODES.tdm.timeLimit / TICK_DT) * 2;
  match.step(new Map());
  check('and it never ends', match.phase === 'live', match.phase);
}

console.log(`\n${failures ? `FAIL — ${failures} check(s) failed` : 'PASS — every check, and every control, behaved'}`);
process.exit(failures ? 1 : 0);
