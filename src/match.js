import * as THREE from 'three';
import { buildArena, spawnPoints } from './arena.js';
import { Tank } from './tank.js';
import { Combat } from './weapons.js';
import { seed } from './rng.js';
import { SCORE, SPAWN_PROTECTION } from './config.js';

// The authoritative match simulation, shared verbatim by server and client.
//
// This is the foundation the whole netcode rests on: client prediction only
// works if the client reaches EXACTLY the state the server will reach from the
// same inputs. Any divergence — a different timestep, an unseeded random, a
// physics step that runs at a different rate — shows up as the client being
// yanked backwards every snapshot. So there is one Match class, one fixed
// timestep, and one seeded RNG, and both ends run them identically.
//
// Presentation (camera, HUD, effects) lives entirely outside this file.

export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
export const RESPAWN_DELAY = 2.6;

export class Match {
  /** @param scene  three.js scene for visuals, or null for a headless server. */
  constructor({ RAPIER, scene = null, worldSeed = 1 }) {
    this.RAPIER = RAPIER;
    this.scene = scene;
    this.tick = 0;
    this.tanks = new Map();          // id -> Tank
    this.spawns = spawnPoints();
    this.events = [];                // drained by the server each tick

    seed(worldSeed);
    this.world = new RAPIER.World({ x: 0, y: -30, z: 0 });
    // Kept: the renderer needs the block meshes to fade whatever is between the
    // camera and the player. Headless, `scene` is null and this is empty.
    this.arena = buildArena(scene, this.world, RAPIER);

    this.combat = new Combat({ world: this.world, RAPIER, scene, fx: null });
    this.combat.onKill = (victim, killer) => {
      victim.deadAt = this.tick;
      victim.deaths = (victim.deaths ?? 0) + 1;
      if (killer && killer !== victim) {
        killer.kills = (killer.kills ?? 0) + 1;
        killer.score = (killer.score ?? 0) + SCORE.kill;
      }

      // Assists: everyone who hurt this tank recently EXCEPT the killer.
      const cutoff = this.tick - SCORE.assistWindow * TICK_RATE;
      const assisted = [];
      for (const [id, rec] of victim.damageFrom ?? []) {
        if (id === killer?.netId || id === victim.netId) continue;
        if (rec.lastTick < cutoff || rec.amount < SCORE.assistMinDamage) continue;
        const helper = this.tanks.get(id);
        if (!helper) continue;
        helper.assists = (helper.assists ?? 0) + 1;
        helper.score = (helper.score ?? 0) + SCORE.assist;
        assisted.push(id);
      }
      victim.damageFrom?.clear();

      this.events.push({
        e: 'kill', id: victim.netId, by: killer?.netId ?? null, assists: assisted,
      });
    };

    // Shots are broadcast so every other client can draw them. Without this a
    // player's health drops with nothing visibly shooting at them — the shooter
    // sees its own tracer, nobody else does.
    this.combat.onFire = (tank, origin, dir, end = null) => {
      const ev = {
        e: 'fire', id: tank.netId, w: tank.weaponKey,
        ox: round(origin.x), oy: round(origin.y), oz: round(origin.z),
        dx: round(dir.x, 3), dy: round(dir.y, 3), dz: round(dir.z, 3),
      };
      // Hitscan carries where the beam actually stopped. Without it each client
      // guesses by raycasting its own world and the beam ends in the wrong
      // place — or nowhere.
      if (end) { ev.ex = round(end.x); ev.ey = round(end.y); ev.ez = round(end.z); }
      this.events.push(ev);
    };

    this.combat.onHit = (target, amount, source) => {
      if (source && source !== target) {
        target.damageFrom ??= new Map();
        const rec = target.damageFrom.get(source.netId) ?? { amount: 0, lastTick: 0 };
        rec.amount += amount;
        rec.lastTick = this.tick;
        target.damageFrom.set(source.netId, rec);
      }
      this.events.push({ e: 'hit', id: target.netId, dmg: +amount.toFixed(1), by: source?.netId ?? null });
    };
  }

  addTank({ id, hull, weapon, name, color, isPlayer = false }) {
    const tank = new Tank({
      world: this.world, RAPIER: this.RAPIER, scene: this.scene,
      hull, weapon, name, color, isPlayer,
    });
    tank.netId = id;
    tank.hullKey = hull;
    tank.kills = 0;
    tank.assists = 0;
    tank.deaths = 0;
    tank.score = 0;
    tank.damageFrom = new Map();
    const spot = this.spawns[this.tanks.size % this.spawns.length];
    tank.respawn(spot, Math.atan2(-spot.x, -spot.z));
    // Joining is a spawn like any other, and the same camper is still there.
    tank.spawnGuard = SPAWN_PROTECTION;
    this.combat.register(tank);
    this.tanks.set(id, tank);
    return tank;
  }

  removeTank(id) {
    const tank = this.tanks.get(id);
    if (!tank) return;

    // Mark BEFORE freeing the body. Anything still holding a reference — a bot
    // brain's current target, a projectile's owner — would otherwise read a
    // rigid body that no longer exists, and Rapier's wasm traps on that rather
    // than returning null. `alive = false` also makes brains re-target on their
    // very next think(), instead of waiting for the reacquire timer.
    tank.removed = true;
    tank.alive = false;

    // Projectiles reference their owner's body when raycasting.
    for (let i = this.combat.projectiles.length - 1; i >= 0; i--) {
      if (this.combat.projectiles[i].owner === tank) {
        const p = this.combat.projectiles[i];
        if (p.mesh && this.scene) { this.scene.remove(p.mesh); p.mesh.material.dispose(); }
        this.combat.projectiles.splice(i, 1);
      }
    }

    this.world.removeRigidBody(tank.body);
    this.combat.byCollider.delete(tank.collider.handle);
    const i = this.combat.tanks.indexOf(tank);
    if (i >= 0) this.combat.tanks.splice(i, 1);
    if (tank.root && this.scene) this.scene.remove(tank.root);
    this.tanks.delete(id);
  }

  /**
   * Advance exactly one tick. `inputs` maps tank id -> input struct.
   *
   * Deliberately takes ALL inputs at once rather than being called per-tank:
   * the order tanks are stepped in affects the outcome, so it has to be fixed
   * and identical on both ends. Map iteration order is insertion order, and
   * both ends insert in the order the server assigned ids.
   */
  /**
   * `fireHook` lets the server wrap the shot resolution in a rewind for lag
   * compensation. It must be a wrapper, not a replacement step: movement and
   * firing have to stay in the same pass, in the same order, or the client's
   * prediction of its own tank stops matching.
   */
  step(inputs, { fireHook = null } = {}) {
    for (const [id, tank] of this.tanks) {
      const input = inputs.get(id) ?? EMPTY_INPUT;
      tank.update(TICK_DT, input, null);
      if (input.fire) {
        if (fireHook) fireHook(tank, id);
        else this.combat.tryFire(tank);
      }
    }

    this.combat.update(TICK_DT);
    this.world.step();
    this.tick++;

    for (const tank of this.tanks.values()) {
      if (tank.spawnGuard > 0) tank.spawnGuard = Math.max(0, tank.spawnGuard - TICK_DT);
      if (!tank.alive && tank.deadAt != null
          && (this.tick - tank.deadAt) * TICK_DT > RESPAWN_DELAY) {
        tank.deadAt = null;
        const spot = this.spawns[this.tick % this.spawns.length];
        // Spawns sit on a ring facing outward at nothing. Come back looking at
        // the middle of the map, which is where the game is.
        tank.respawn(spot, Math.atan2(-spot.x, -spot.z));
        tank.spawnGuard = SPAWN_PROTECTION;
        this.events.push({ e: 'spawn', id: tank.netId });
      }
    }
  }

  // ── State transfer ────────────────────────────────────────────────────────
  /** Everything a client needs to reproduce this tank's visible state. */
  snapshot() {
    const tanks = [];
    for (const tank of this.tanks.values()) {
      const t = tank.body.translation();
      const v = tank.body.linvel();
      const r = tank.body.rotation();
      tanks.push({
        id: tank.netId,
        x: round(t.x), y: round(t.y), z: round(t.z),
        vx: round(v.x), vz: round(v.z),
        qy: round(r.y, 4), qw: round(r.w, 4),
        ty: round(tank.turret.rotation.y, 3),
        tv: round(tank.turretVel, 3),
        hp: Math.round(tank.hp),
        a: tank.alive ? 1 : 0,
        c: round(tank.charge, 2),
        cd: round(tank.cooldown, 2),
        sg: round(tank.spawnGuard, 2),
        k: tank.kills ?? 0,
        as: tank.assists ?? 0,
        de: tank.deaths ?? 0,
        sc: tank.score ?? 0,
      });
    }
    return { tick: this.tick, tanks };
  }

  /** Overwrite local state with the server's. Used by reconciliation. */
  applySnapshot(snap, { skipId = null } = {}) {
    this.tick = snap.tick;
    for (const s of snap.tanks) {
      const tank = this.tanks.get(s.id);
      if (!tank || s.id === skipId) continue;
      applyTankState(tank, s);
    }
  }

  /** Restore a single tank — the local player during reconciliation. */
  applyTankState(id, s) {
    const tank = this.tanks.get(id);
    if (tank) applyTankState(tank, s);
  }
}

const EMPTY_INPUT = { throttle: 0, steer: 0, strafe: 0, turretSteer: 0, aimPoint: null, fire: false };

function applyTankState(tank, s) {
  tank.body.setTranslation({ x: s.x, y: s.y, z: s.z }, true);
  tank.body.setLinvel({ x: s.vx, y: 0, z: s.vz }, true);
  tank.body.setRotation({ x: 0, y: s.qy, z: 0, w: s.qw }, true);
  tank.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  tank.turret.rotation.y = s.ty;
  tank.turretVel = s.tv;
  tank.hp = s.hp;
  tank.alive = !!s.a;
  tank.charge = s.c;
  tank.cooldown = s.cd;
  tank.spawnGuard = s.sg ?? 0;
  if (s.k !== undefined) {
    tank.kills = s.k; tank.assists = s.as; tank.deaths = s.de; tank.score = s.sc;
  }
  tank._syncHealthBar?.();
}

function round(n, p = 2) {
  const m = 10 ** p;
  return Math.round(n * m) / m;
}
