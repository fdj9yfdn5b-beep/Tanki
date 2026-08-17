// Headless duel runner.
//
// Builds the real arena colliders and runs two real Tanks driven by two real
// BotBrains — the same classes the browser build uses, with no renderer. One
// Arena is constructed per worker and reused across thousands of duels; only
// the two tanks are created and destroyed each time.

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import { buildArena } from '../src/arena.js';
import { Tank } from '../src/tank.js';
import { Combat } from '../src/weapons.js';
import { BotBrain } from '../src/bots.js';
import { BANDS } from '../src/config.js';
import { seed, random, range } from '../src/rng.js';

export const FIXED = 1 / 60;

let arena = null;

export async function initArena() {
  if (arena) return arena;
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -30, z: 0 });
  buildArena(null, world, RAPIER);   // colliders only, no scene
  arena = { world, RAPIER };
  return arena;
}

/**
 * Pick two positions `dist` apart that are both inside the arena, both clear of
 * geometry, and that can see each other. Duels have to *start* inside the band
 * being measured, or a "long range" duel is really just a mid-range duel after
 * both tanks drive toward each other.
 */
function placeAtRange(world, RAPIER, dist) {
  for (let attempt = 0; attempt < 220; attempt++) {
    const ang = random() * Math.PI * 2;
    const r = random() * 44;
    const ax = Math.cos(ang) * r, az = Math.sin(ang) * r;
    const dir = random() * Math.PI * 2;
    const bx = ax + Math.cos(dir) * dist, bz = az + Math.sin(dir) * dist;
    if (Math.abs(bx) > 50 || Math.abs(bz) > 50) continue;

    // Both spawn points must be in open space.
    if (occupied(world, RAPIER, ax, az) || occupied(world, RAPIER, bx, bz)) continue;

    // And they must have a clear line, otherwise the "duel" is two bots
    // wandering until they bump into each other at an unrelated distance.
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    const ray = new RAPIER.Ray({ x: ax, y: 1.2, z: az }, { x: dx / len, y: 0, z: dz / len });
    if (world.castRay(ray, len, true)) continue;

    return [new THREE.Vector3(ax, 1.5, az), new THREE.Vector3(bx, 1.5, bz)];
  }
  return null;
}

function occupied(world, RAPIER, x, z) {
  // Four short probes around the point; any hit means we would spawn clipping.
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const ray = new RAPIER.Ray({ x, y: 1.2, z }, { x: dx, y: 0, z: dz });
    if (world.castRay(ray, 3.2, true)) return true;
  }
  return false;
}

/**
 * One duel to the death. Returns 1 if A won, 0 if B won, 0.5 on timeout.
 * `skill` is shared by both bots so the result measures the loadout, not the
 * pilot.
 */
export function runDuel({ a, b, band, rngSeed, skill = 0.62, maxSeconds = 18 }) {
  const { world, RAPIER } = arena;
  seed(rngSeed);

  const [lo, hi] = BANDS[band];
  const dist = range(Math.max(6, lo + 1), hi);
  const spots = placeAtRange(world, RAPIER, dist);
  if (!spots) return null;   // could not stage this band here; caller skips it

  const combat = new Combat({ world, RAPIER, scene: null, fx: null });
  const tankA = new Tank({ world, RAPIER, scene: null, hull: a.hull, weapon: a.weapon, name: 'A' });
  const tankB = new Tank({ world, RAPIER, scene: null, hull: b.hull, weapon: b.weapon, name: 'B' });
  tankA.respawn(spots[0]);
  tankB.respawn(spots[1]);
  combat.register(tankA);
  combat.register(tankB);

  // Face each other at the start; a duel should not be decided by who happened
  // to spawn looking the right way.
  faceToward(tankA, spots[1]);
  faceToward(tankB, spots[0]);

  const tanks = [tankA, tankB];
  const brainA = new BotBrain(tankA, { skill, seed: random() });
  const brainB = new BotBrain(tankB, { skill, seed: random() });

  let t = 0, result = 0.5, ttk = null;
  const steps = Math.round(maxSeconds / FIXED);
  for (let i = 0; i < steps; i++) {
    for (const [tank, brain] of [[tankA, brainA], [tankB, brainB]]) {
      const input = brain.think(FIXED, { world, RAPIER, tanks, combat });
      tank.update(FIXED, input, null);
      if (input.fire) combat.tryFire(tank);
    }
    combat.update(FIXED);
    world.step();
    t += FIXED;

    if (!tankA.alive || !tankB.alive) {
      ttk = t;
      result = !tankB.alive && tankA.alive ? 1 : !tankA.alive && tankB.alive ? 0 : 0.5;
      break;
    }
  }

  world.removeRigidBody(tankA.body);
  world.removeRigidBody(tankB.body);

  return { result, ttk, dist, shots: combat.shots.length };
}

function faceToward(tank, target) {
  const p = tank.position;
  const yaw = Math.atan2(target.x - p.x, target.z - p.z);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  tank.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
}
