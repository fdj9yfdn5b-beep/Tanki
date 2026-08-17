// Instrument a single Wasp-vs-Mammoth duel.
//
// Three hypotheses about why the light hull loses have now been falsified by
// measurement (more HP, more acceleration, a faster turret). Rather than try a
// fourth, count what each side actually does: shots taken, shots landed, damage
// dealt. Whatever the asymmetry is, it has to show up in one of those.

import { initArena } from './duel.mjs';
import { apply, SPEC } from './params.mjs';
import { Tank } from '../src/tank.js';
import { Combat } from '../src/weapons.js';
import { BotBrain } from '../src/bots.js';
import { seed, random } from '../src/rng.js';
import { HULLS } from '../src/config.js';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { readFileSync } from 'node:fs';

const arena = await initArena();
apply(SPEC.map(([k]) => JSON.parse(
  readFileSync(new URL('./tuned.json', import.meta.url), 'utf8')).params[k]));

const F = 1 / 60;
const weapon = process.argv[2] ?? 'twin';
const startDist = Number(process.argv[3] ?? 10);
const TRIALS = Number(process.argv[4] ?? 40);

const agg = {
  wasp: { shots: 0, dmg: 0, wins: 0, fireFrames: 0, aliveFrames: 0 },
  mammoth: { shots: 0, dmg: 0, wins: 0, fireFrames: 0, aliveFrames: 0 },
};

for (let trial = 0; trial < TRIALS; trial++) {
  seed(9000 + trial);
  const { world } = arena;
  const combat = new Combat({ world, RAPIER: arena.RAPIER, scene: null, fx: null });

  const a = new Tank({ world, RAPIER: arena.RAPIER, scene: null, hull: 'wasp', weapon, name: 'wasp' });
  const b = new Tank({ world, RAPIER: arena.RAPIER, scene: null, hull: 'mammoth', weapon, name: 'mammoth' });
  const ang = random() * Math.PI * 2;
  a.respawn(new THREE.Vector3(Math.cos(ang) * 20, 1.5, Math.sin(ang) * 20));
  b.respawn(new THREE.Vector3(Math.cos(ang) * 20 + startDist, 1.5, Math.sin(ang) * 20));
  combat.register(a); combat.register(b);

  combat.onHit = (target, amount, source) => {
    if (source && source.name && agg[source.name]) agg[source.name].dmg += amount;
  };

  const tanks = [a, b];
  const brains = [new BotBrain(a, { skill: 0.62, seed: random() }),
                  new BotBrain(b, { skill: 0.62, seed: random() })];

  for (let i = 0; i < 60 * 18; i++) {
    for (let k = 0; k < 2; k++) {
      const tank = tanks[k];
      if (!tank.alive) continue;
      agg[tank.name].aliveFrames++;
      const input = brains[k].think(F, { world, RAPIER: arena.RAPIER, tanks, combat });
      if (input.fire) agg[tank.name].fireFrames++;
      tank.update(F, input, null);
      if (input.fire && combat.tryFire(tank)) agg[tank.name].shots++;
    }
    combat.update(F);
    world.step();
    if (!a.alive || !b.alive) break;
  }
  if (!b.alive && a.alive) agg.wasp.wins++;
  else if (!a.alive && b.alive) agg.mammoth.wins++;

  world.removeRigidBody(a.body);
  world.removeRigidBody(b.body);
}

console.log(`\n${weapon} mirror, start ${startDist}m, ${TRIALS} duels\n`);
console.log(`  hull      hp   shots  dmg dealt  dmg/shot  wanted-to-fire%  wins`);
for (const h of ['wasp', 'mammoth']) {
  const s = agg[h];
  console.log(
    `  ${h.padEnd(9)}${HULLS[h].hp.toFixed(0).padStart(4)}` +
    `${String(s.shots).padStart(8)}${s.dmg.toFixed(0).padStart(11)}` +
    `${(s.dmg / Math.max(1, s.shots)).toFixed(1).padStart(10)}` +
    `${(s.fireFrames / Math.max(1, s.aliveFrames) * 100).toFixed(0).padStart(17)}%` +
    `${String(s.wins).padStart(6)}`);
}
console.log(`\n  effective HP ratio mammoth/wasp: ${(HULLS.mammoth.hp / HULLS.wasp.hp).toFixed(2)}x`);
