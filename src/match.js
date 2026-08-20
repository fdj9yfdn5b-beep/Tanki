import * as THREE from 'three';
import { buildArena, spawnPoints } from './arena.js';
import { Tank } from './tank.js';
import { Combat } from './weapons.js';
import { seed } from './rng.js';
import {
  SCORE, SPAWN_PROTECTION, DROPS, DROP_KINDS,
  MODES, DEFAULT_MODE, TEAMS, TEAM_KEYS, INTERMISSION,
} from './config.js';
import { random, pick } from './rng.js';

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
  constructor({ RAPIER, scene = null, worldSeed = 1, mode = DEFAULT_MODE }) {
    this.RAPIER = RAPIER;
    this.scene = scene;
    this.tick = 0;
    this.tanks = new Map();          // id -> Tank
    this.spawns = spawnPoints();
    this.events = [];                // drained by the server each tick
    this.drops = [];                 // air-dropped crates, see _stepDrops
    this.dropTimer = DROPS.interval * 0.5;
    this.nextDropId = 1;

    // ── The match itself ────────────────────────────────────────────────────
    // `live` is a match in progress; `over` is the intermission where the
    // result is on screen and nothing can be scored. Both ends read the phase
    // off the snapshot rather than deriving it — see the note on `snapshot()`.
    this.mode = MODES[mode] ?? MODES[DEFAULT_MODE];
    this.phase = 'live';
    this.phaseTick = 0;
    this.winner = null;              // team key, tank id, or null for a draw
    // Kept on the MATCH, not summed from the players on the field. A team's
    // work does not leave when the player who did it disconnects, and summing
    // live tanks would hand the other side the lead the moment someone quit.
    this.teamScore = { red: 0, blue: 0 };
    this.spawnCursor = { red: 0, blue: 0, none: 0 };

    seed(worldSeed);
    this.world = new RAPIER.World({ x: 0, y: -30, z: 0 });
    // Kept: the renderer needs the block meshes to fade whatever is between the
    // camera and the player. Headless, `scene` is null and this is empty.
    this.arena = buildArena(scene, this.world, RAPIER);

    this.combat = new Combat({ world: this.world, RAPIER, scene, fx: null });

    // Every damage path in the game funnels through Combat._applyDamage —
    // hitscan, direct shell hits and splash alike — so one gate here covers all
    // three. Putting the rule in each firing path instead is how a splash
    // weapon ends up as the one thing that still kills its own team.
    this.combat.canDamage = (target, source) => this.canDamage(target, source);

    // A shot that landed on a teammate and did nothing. Broadcast so the
    // shooter's client can draw "FRIENDLY" where the damage number would have
    // been — see the note in Combat._applyDamage. Only friendly fire reports
    // itself; a shot blocked because the match is already over does not, since
    // firing is disabled in that phase and anything still in the air is a
    // shell that was fired before the whistle.
    this.combat.onBlocked = (target, source) => {
      if (!this.friendly(target, source)) return;
      this.events.push({ e: 'ff', id: target.netId, by: source.netId });
    };

    this.combat.onKill = (victim, killer) => {
      victim.deadAt = this.tick;
      victim.deaths = (victim.deaths ?? 0) + 1;
      if (killer && killer !== victim) {
        killer.kills = (killer.kills ?? 0) + 1;
        killer.score = (killer.score ?? 0) + SCORE.kill;
        this._award(killer, SCORE.kill);
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
        this._award(helper, SCORE.assist);
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

  /**
   * @param team  Which side this tank is on, or null to let the match decide.
   *
   * The server decides and every client is TOLD — a client that worked it out
   * for itself would put a late joiner on a different side from everyone else
   * the moment two people joined close together, and half the arena would be
   * shooting at friends it thought were enemies.
   */
  addTank({ id, hull, weapon, name, color, isPlayer = false, team = null }) {
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
    this.combat.register(tank);
    this.tanks.set(id, tank);
    tank.setTeam(this.mode.teams ? (team ?? this.pickTeam()) : null);

    const spot = this._spawnFor(tank);
    tank.respawn(spot, Math.atan2(-spot.x, -spot.z));
    // Joining is a spawn like any other, and the same camper is still there.
    tank.spawnGuard = SPAWN_PROTECTION;
    return tank;
  }

  /** The smaller side, ties broken in a fixed order so it is reproducible. */
  pickTeam() {
    const count = { red: 0, blue: 0 };
    for (const t of this.tanks.values()) if (t.team) count[t.team]++;
    return count.red <= count.blue ? TEAM_KEYS[0] : TEAM_KEYS[1];
  }

  teamOf(id) { return this.tanks.get(id)?.team ?? null; }

  /**
   * Spawn on your own side of the map.
   *
   * The eight spawn points sit on a ring, four with x < 0 and four with x > 0,
   * so the split falls out of the geometry that is already there. Without it a
   * team game starts with both sides shuffled through the same eight points and
   * half of everyone spawns inside the enemy.
   */
  _spawnFor(tank) {
    const key = tank.team ?? 'none';
    const pool = tank.team
      ? this.spawns.filter((p) => (tank.team === TEAM_KEYS[0] ? p.x < 0 : p.x > 0))
      : this.spawns;
    const spot = pool[this.spawnCursor[key] % pool.length];
    this.spawnCursor[key]++;
    return spot;
  }

  /** Same side, and not yourself. Self-damage is unchanged — see the tools. */
  friendly(a, b) {
    return !!(a && b && a !== b && a.team && a.team === b.team);
  }

  /**
   * The single rule for whether damage is allowed to land.
   *
   * Two things stop it: your own team, and a match that has already been
   * decided. Combat asks this on every damage application, so neither can be
   * forgotten by a weapon added later.
   */
  canDamage(target, source) {
    if (this.phase !== 'live') return false;
    return !this.friendly(target, source);
  }

  /** Points to the scorer's side. No-op in a mode without sides. */
  _award(tank, points) {
    if (this.mode.teams && tank?.team) this.teamScore[tank.team] += points;
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
    const live = this.phase === 'live';
    for (const [id, tank] of this.tanks) {
      const input = inputs.get(id) ?? EMPTY_INPUT;
      tank.update(TICK_DT, input, null);
      // Driving still works during the intermission — being frozen in place
      // while a scoreboard is up feels like a hang. Shooting does not: the
      // result is already decided, and shots that cannot score are noise.
      if (input.fire && live) {
        if (fireHook) fireHook(tank, id);
        else this.combat.tryFire(tank);
      }
    }

    this.combat.update(TICK_DT);
    if (live) this._stepDrops(TICK_DT);
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

    this._stepGame(TICK_DT);
  }

  /**
   * The match clock and the win condition.
   *
   * Runs only where `step()` runs — the server, or an offline client, which are
   * the two places that are authoritative over anything. A network client never
   * calls this; it reads `phase`, `teamScore` and `timeLeft` straight off the
   * snapshot, exactly like air-dropped crates. That is deliberate: §4's rule is
   * that anything the client PREDICTS has to be on the wire, and the cheapest
   * way to satisfy it is to predict nothing at all. A match clock ticking
   * locally would drift from the server's within a minute and start showing a
   * different number in the corner of everyone's screen.
   */
  _stepGame(dt) {
    this.phaseTick++;
    const elapsed = this.phaseTick * TICK_DT;

    if (this.phase === 'over') {
      if (elapsed >= INTERMISSION) this.resetMatch();
      return;
    }

    const target = this.scoreTarget;
    if (this.mode.teams) {
      for (const key of TEAM_KEYS) {
        if (this.teamScore[key] >= target) return this._endMatch(key);
      }
    } else {
      for (const tank of this.tanks.values()) {
        if ((tank.score ?? 0) >= target) return this._endMatch(tank.netId);
      }
    }

    // Out of time: whoever is ahead. A tie is a real result and says so — the
    // alternative is sudden death, which needs a rule for what happens when
    // nobody can find anybody, and this map is big enough for that to happen.
    if (elapsed >= this.mode.timeLimit) this._endMatch(this._leader());
  }

  /** Who is winning right now, or null if it is level. */
  _leader() {
    if (this.mode.teams) {
      const [a, b] = TEAM_KEYS;
      if (this.teamScore[a] === this.teamScore[b]) return null;
      return this.teamScore[a] > this.teamScore[b] ? a : b;
    }
    let best = null, bestScore = -1, tied = false;
    for (const tank of this.tanks.values()) {
      const sc = tank.score ?? 0;
      if (sc > bestScore) { bestScore = sc; best = tank.netId; tied = false; }
      else if (sc === bestScore) tied = true;
    }
    return tied || bestScore <= 0 ? null : best;
  }

  _endMatch(winner) {
    this.phase = 'over';
    this.phaseTick = 0;
    this.winner = winner ?? null;
    this.events.push({
      e: 'over',
      win: this.winner,
      red: this.teamScore.red,
      blue: this.teamScore.blue,
    });
  }

  /**
   * Wipe the slate and start again.
   *
   * Everything a match accumulates has to go, or the next one starts with the
   * last one's tail: scores obviously, but also the damage-assist ledger (an
   * assist credited across a match boundary), the crates on the field and any
   * ability still running off one of them.
   */
  resetMatch() {
    this.phase = 'live';
    this.phaseTick = 0;
    this.winner = null;
    for (const key of TEAM_KEYS) this.teamScore[key] = 0;

    for (const d of this.drops) this.events.push({ e: 'dropgone', id: d.id });
    this.drops.length = 0;
    this.dropTimer = DROPS.interval * 0.5;

    for (const tank of this.tanks.values()) {
      tank.kills = 0; tank.assists = 0; tank.deaths = 0; tank.score = 0;
      tank.damageFrom?.clear();
      tank.effects?.clear();
      tank.deadAt = null;
      const spot = this._spawnFor(tank);
      tank.respawn(spot, Math.atan2(-spot.x, -spot.z));
      tank.spawnGuard = SPAWN_PROTECTION;
      this.events.push({ e: 'spawn', id: tank.netId });
    }
    this.events.push({ e: 'start', mode: this.mode.key });
  }

  /** Seconds left in the current phase. */
  get timeLeft() {
    const limit = this.phase === 'live' ? this.mode.timeLimit : INTERMISSION;
    return Math.max(0, limit - this.phaseTick * TICK_DT);
  }

  /**
   * Switch modes. Only ever called on a CLIENT, which is told which mode the
   * server is running in the welcome message; the server picks its mode once at
   * boot and never changes it.
   */
  setMode(key) {
    if (!MODES[key] || this.mode.key === key) return;
    this.mode = MODES[key];
  }

  /**
   * Air-dropped crates: spawn, fall, expire, and get picked up.
   *
   * Lives in Match rather than in the server so the client runs the exact same
   * code — a crate is simulated state like anything else, and a client that
   * guessed at it would show pickups that never happened. The RNG is the
   * SEEDED one, so both ends choose the same drop points and kinds from the
   * same tick, and only the pickup itself needs the server's word.
   */
  _stepDrops(dt) {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];

      if (d.y > d.groundY) {
        d.y = Math.max(d.groundY, d.y - DROPS.fallSpeed * dt);
      } else {
        d.age += dt;
        if (d.age > DROPS.lifetime) {
          this.drops.splice(i, 1);
          this.events.push({ e: 'dropgone', id: d.id });
          continue;
        }
      }

      // Only landed crates can be taken, so a tank cannot claim one out of the
      // air before anyone has had a chance to drive to it.
      if (d.y > d.groundY + 0.4) continue;
      for (const tank of this.tanks.values()) {
        if (!tank.alive) continue;
        const p = tank.body.translation();
        if (Math.hypot(p.x - d.x, p.z - d.z) > DROPS.pickupRadius) continue;
        tank.giveEffect(d.kind);
        this.drops.splice(i, 1);
        this.events.push({ e: 'pickup', id: d.id, by: tank.netId, kind: d.kind });
        break;
      }
    }

    this.dropTimer -= dt;
    if (this.dropTimer > 0 || this.drops.length >= DROPS.maxAlive) return;
    this.dropTimer = DROPS.interval;

    // Drop onto open ground. Spawn points are known clear, and offsetting
    // toward the middle keeps crates out of the corners where a camper already
    // has the advantage.
    const base = this.spawns[Math.floor(random() * this.spawns.length)];
    const pull = 0.35 + random() * 0.4;
    const x = base.x * (1 - pull);
    const z = base.z * (1 - pull);
    const kind = pick(Object.keys(DROP_KINDS));
    const d = {
      id: this.nextDropId++, kind, x, z,
      y: DROPS.fallFrom, groundY: 1.2, age: 0,
    };
    this.drops.push(d);
    this.events.push({ e: 'drop', id: d.id, kind, x: round(x), z: round(z) });
  }

  // ── State transfer ────────────────────────────────────────────────────────
  /** Everything a client needs to reproduce this tank's visible state. */
  snapshot() {
    const drops = this.drops.map((d) => ({
      id: d.id, k: d.kind, x: round(d.x), y: round(d.y), z: round(d.z),
    }));
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
        // The HULL's angular rate, not the turret's. Both are now ramped rather
        // than set from the input, which makes them predicted state that has to
        // be reconciled — leaving this one off the wire meant the client ramped
        // down from a different value than the server, their hull rotations
        // parted company, and every time you stopped turning the correction
        // snapped the tank back the other way.
        nv: round(tank.turnVel, 3),
        hp: Math.round(tank.hp),
        a: tank.alive ? 1 : 0,
        c: round(tank.charge, 2),
        cd: round(tank.cooldown, 2),
        sg: round(tank.spawnGuard, 2),
        fx: tank.effectsWire(),
        // Which side this tank is on. It also arrives in the join message, and
        // that is the path that normally sets it — this is here so a client
        // that missed a join (or joined mid-match) still colours the arena
        // correctly instead of shooting at friends. Cheap: one short string per
        // tank per snapshot.
        tm: tank.team ?? null,
        k: tank.kills ?? 0,
        as: tank.assists ?? 0,
        de: tank.deaths ?? 0,
        sc: tank.score ?? 0,
      });
    }
    return { tick: this.tick, tanks, drops, game: this.gameState() };
  }

  /**
   * The match itself, for the wire: phase, clock, scores, winner.
   *
   * Small enough to send whole on every snapshot rather than diffing, and
   * sending it whole is what makes a client that connects mid-match correct on
   * its first frame instead of after the next thing happens.
   */
  gameState() {
    return {
      m: this.mode.key,
      ph: this.phase,
      t: Math.round(this.timeLeft * 10) / 10,
      r: this.teamScore.red,
      b: this.teamScore.blue,
      tgt: this.scoreTarget,
      win: this.winner,
    };
  }

  /**
   * What it takes to win, as the AUTHORITY understands it.
   *
   * A client must not read this off its own config. The two normally agree, and
   * the whole reason `tgt` is on the wire is the cases where they do not: a
   * server started with a shortened target, or a client running a build from
   * before the number was last tuned. Caught exactly that way — the bar read
   * "FIRST TO 100" through an entire 20-point match, so the one line on screen
   * that tells you how much longer this goes on was quietly wrong.
   */
  get scoreTarget() {
    return this.serverTarget ?? this.mode.scoreTarget;
  }

  /** Adopt the server's match state. The client's only route to any of it. */
  applyGameState(g) {
    if (!g) return;
    this.setMode(g.m);
    this.phase = g.ph;
    this.serverTarget = g.tgt ?? null;
    this.serverTimeLeft = g.t;
    this.teamScore.red = g.r;
    this.teamScore.blue = g.b;
    this.winner = g.win ?? null;
  }

  /** Overwrite local state with the server's. Used by reconciliation. */
  applySnapshot(snap, { skipId = null } = {}) {
    this.tick = snap.tick;
    this.applyGameState(snap.game);
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
  tank.turnVel = s.nv ?? 0;
  tank.hp = s.hp;
  tank.alive = !!s.a;
  tank.charge = s.c;
  tank.cooldown = s.cd;
  tank.spawnGuard = s.sg ?? 0;
  if (s.tm !== undefined && s.tm !== tank.team) tank.setTeam(s.tm);
  // Air-drop abilities, for the LOCAL player.
  //
  // interpolate() carries these for everyone else but deliberately skips our
  // own tank ("ours is predicted, not interpolated"), and the client never runs
  // _stepDrops — only the server spawns and awards crates. So without this line
  // the one player who most needs to know what they picked up is the only one
  // who is never told, and the HUD sat empty however many crates you drove over.
  tank.effects.clear();
  for (let i = 0; s.fx && i < s.fx.length; i += 2) tank.effects.set(s.fx[i], s.fx[i + 1]);
  if (s.k !== undefined) {
    tank.kills = s.k; tank.assists = s.as; tank.deaths = s.de; tank.score = s.sc;
  }
  tank._syncHealthBar?.();
}

function round(n, p = 2) {
  const m = 10 ** p;
  return Math.round(n * m) / m;
}
