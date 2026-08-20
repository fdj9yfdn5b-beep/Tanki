import * as THREE from 'three';
import { BANDS } from './config.js';
import { random } from './rng.js';

const UP = new THREE.Vector3(0, 1, 0);

// Bot brain with an explicit skill model. `skill` ∈ [0,1] maps to aim error,
// reaction latency and how well the bot holds its weapon's preferred band.
// This is the same brain the headless balance sim runs — turning bot skill into
// a dial is what makes skill-bucketed win-rate analysis possible.

export class BotBrain {
  constructor(tank, { skill = 0.6, seed = random() } = {}) {
    this.tank = tank;
    this.skill = skill;
    this.target = null;
    this.reacquire = 0;
    this.reaction = 0;
    this.strafePhase = seed * Math.PI * 2;
    this.strafeDir = random() > 0.5 ? 1 : -1;
    this.stuckTimer = 0;
    this.lastPos = new THREE.Vector3();
    this.losMemory = 0;
    this.noLosTimer = 0;   // read by the movement pass one frame stale, which is fine
    this.strafeFlip = 0;
    this.dodgeDir = null;
    this.dodgeTimer = 0;
  }

  get aimSigma() {
    // 0.09 rad at skill 0 down to 0.008 rad at skill 1.
    return THREE.MathUtils.lerp(0.09, 0.008, this.skill);
  }

  get reactionTime() {
    return THREE.MathUtils.lerp(0.55, 0.12, this.skill);
  }

  preferredRange() {
    const [lo, hi] = BANDS[this.tank.weapon.band];
    return (lo + hi) / 2;
  }

  /**
   * The radius inside which this tank can circle a target faster than that
   * target's turret can traverse — the range at which speed becomes armour.
   *
   * Orbiting at radius r gives angular velocity v/r, so the envelope is
   * r < v / traverse. This is the entire reason a light hull exists, and the
   * bots had no idea it was there: they strafed laterally and nursed a
   * preferred range, so Wasp's win rate was WORST at close range (0.069) —
   * exactly where its advantage is largest. The sim could not value speed,
   * so tuning hulls against it only ever concluded that Wasp needed more HP.
   */
  outTurnRadius(target) {
    if (!target) return 0;
    const traverse = target.traverseRate;
    if (traverse <= 0) return 0;
    // 1.15 margin: matching their traverse exactly is not enough, the shot only
    // has to be close. We want to be genuinely faster than they can track.
    return this.tank.hull.maxSpeed / (traverse * 1.15);
  }

  /**
   * Distance to the first obstacle along `dir`, capped at `maxDist`.
   *
   * Sphere-swept, not a ray. A ray is a zero-width line from the hull's centre:
   * it slips past corners the tank is physically wide enough to hit, so bots
   * would confidently steer into a block the whisker "proved" was clear. The
   * ball is sized to the hull so clearance means clearance for the whole tank.
   */
  _clearance(world, RAPIER, me, origin, dir, maxDist) {
    // Radius from hull WIDTH, not its longest axis, and the caller lifts the
    // origin clear of the floor. Sized off the length and centred at y=1 the
    // ball dips below y=0 into the ground collider, and `stopAtPenetration`
    // then reports a zero-distance hit in every direction — every bot believes
    // it is walled in on all sides and the whiskers become worse than useless.
    this._probe ??= new RAPIER.Ball(me.hull.size[0] * 0.45);
    const hit = world.castShape(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: 0, y: 0, z: 0, w: 1 },
      { x: dir.x, y: dir.y, z: dir.z },
      this._probe, 0, maxDist, true,
      undefined, undefined, undefined, me.body);
    if (!hit) return maxDist;
    return hit.time_of_impact ?? hit.timeOfImpact ?? hit.toi ?? maxDist;
  }

  /**
   * Whisker steering. Fans rays either side of where the bot wants to go and
   * picks the direction that trades the least heading error for the most open
   * space. Replaces "drive straight at the target and hope", which pinned bots
   * against walls until the stuck timer flailed them loose.
   */
  _steerAround(world, RAPIER, me, desired) {
    const origin = me.position;
    // High enough that the swept ball clears the ground plane, low enough to
    // still catch the shortest cover on the map (~1.4m).
    origin.y = 1.7;
    const PROBE = 10;

    let best = desired, bestScore = -Infinity;
    for (let i = -3; i <= 3; i++) {
      const dir = desired.clone().applyAxisAngle(UP, i * 0.42).normalize();
      const clear = this._clearance(world, RAPIER, me, origin, dir, PROBE);
      // Openness dominates when something is close; heading preference wins
      // once the path is clear, so bots do not wander off target in the open.
      const score = (clear / PROBE) * 1.7 + dir.dot(desired);
      if (score > bestScore) { bestScore = score; best = dir; }
    }
    this.forwardClear = this._clearance(world, RAPIER, me, origin, best, PROBE);
    return best;
  }

  /**
   * Step out of the path of an incoming shell.
   *
   * This is the behaviour a light hull's entire case rests on. Without it the
   * sim cannot express what a Wasp is *for*: speed buys nothing if nobody ever
   * uses it to not be where a shell is going. Any attempt to balance hulls
   * against bots that cannot do this is fitting to a bot deficiency.
   *
   * Skill sets how early the threat is noticed — a weak bot reacts when the
   * round is nearly on top of it, which is usually too late.
   */
  _dodgeVector(combat, me) {
    if (!combat?.projectiles?.length) return null;
    const myPos = me.position;
    const lookahead = THREE.MathUtils.lerp(0.35, 1.4, this.skill);
    const bodyRadius = Math.max(me.hull.size[0], me.hull.size[2]) * 0.5 + 0.6;

    let best = null, bestTime = Infinity;
    for (const p of combat.projectiles) {
      if (p.owner === me) continue;
      const speed = p.vel.length();
      if (speed < 1e-3) continue;

      const dir = p.vel.clone().divideScalar(speed);
      const rel = myPos.clone().sub(p.pos);
      const along = rel.dot(dir);
      if (along <= 0) continue;                 // already past us

      const tHit = along / speed;
      if (tHit > lookahead) continue;           // too early to have noticed

      // Perpendicular offset from the shell's line: how badly it threatens us,
      // and which way to leave.
      const perp = rel.clone().addScaledVector(dir, -along);
      const miss = perp.length();
      const danger = bodyRadius + (p.weapon.splash || 0) * 0.7;
      if (miss > danger) continue;              // it misses anyway

      if (tHit < bestTime) {
        bestTime = tHit;
        // Leave along the side we are already on; if dead-centre, pick a side.
        best = miss > 0.3
          ? perp.setY(0).normalize()
          : new THREE.Vector3().crossVectors(dir, UP).multiplyScalar(this.strafeDir).normalize();
      }
    }
    return best;
  }

  hasLineOfSight(world, RAPIER, from, to, self, targetTank) {
    const dir = to.clone().sub(from);
    const dist = dir.length();
    dir.normalize();
    const ray = new RAPIER.Ray(
      { x: from.x, y: from.y, z: from.z }, { x: dir.x, y: dir.y, z: dir.z });
    const hit = world.castRay(ray, dist, true, undefined, undefined, undefined, self.body);
    if (!hit) return true;
    return hit.collider.handle === targetTank.collider.handle;
  }

  think(dt, { world, RAPIER, tanks, combat }) {
    const me = this.tank;
    const input = { throttle: 0, steer: 0, aimPoint: null, fire: false };
    if (!me.alive) return input;

    // ── Target selection ────────────────────────────────────────────────────
    this.reacquire -= dt;
    if (this.reacquire <= 0 || !this.target?.alive || this.target?.removed) {
      this.reacquire = 0.5;
      const myPos = me.position;

      // Being shot wins outright. A weighted bonus is not enough — an attacker
      // hitting you from across the map still loses on distance to whoever
      // happens to be sitting at your ideal range, which is exactly the
      // "doesn't even notice I'm behind him" behaviour. Reaction time is what
      // separates skill levels here, not whether the bot notices at all.
      // `!hostile` on the threat as well as on the search. Friendly fire cannot
      // set a threat any more (Combat returns before takeDamage), but a bot
      // that ever did turn and duel a teammate would look exactly like a bot
      // that had stopped working, so it is worth being explicit here too.
      const underFire = me.threatTimer > 0 && me.threatFrom?.alive
        && !me.threatFrom.removed && hostile(me, me.threatFrom)
        ? me.threatFrom : null;

      let best = null;
      if (underFire) {
        best = underFire;
      } else {
        let bestScore = Infinity;
        for (const t of tanks) {
          if (t === me || !t.alive || !hostile(me, t)) continue;
          const d = t.position.distanceTo(myPos);
          const score = Math.abs(d - this.preferredRange()) + d * 0.15;
          if (score < bestScore) { bestScore = score; best = t; }
        }
      }
      if (best !== this.target) this.reaction = this.reactionTime;
      this.target = best;
    }

    if (!this.target || this.target.removed) return input;

    const myPos = me.position;
    const tgtPos = this.target.position.clone();
    const toTarget = tgtPos.clone().sub(myPos);
    const dist = toTarget.length();

    this.reaction = Math.max(0, this.reaction - dt);

    // ── Aim, with lead on travel-time weapons ───────────────────────────────
    const aim = tgtPos.clone();
    aim.y = myPos.y;
    if (me.weapon.muzzleSpeed) {
      const tof = dist / me.weapon.muzzleSpeed;
      const v = this.target.body.linvel();
      // Lead quality scales with skill — low-skill bots barely lead at all.
      aim.addScaledVector(new THREE.Vector3(v.x, 0, v.z), tof * this.skill);
      // No manual arc offset here: the tank's ballistic solver already elevates
      // the barrel to reach aimPoint, so adding drop compensation double-counts.
    }

    // Persistent aim error, resampled slowly so it reads as human wobble.
    this.wobbleTimer = (this.wobbleTimer ?? 0) - dt;
    if (this.wobbleTimer <= 0) {
      this.wobbleTimer = 0.25;
      const s = this.aimSigma * dist;
      this.wobble = new THREE.Vector3(
        (random() - 0.5) * 2 * s, 0, (random() - 0.5) * 2 * s);
    }
    aim.add(this.wobble ?? new THREE.Vector3());
    input.aimPoint = aim;

    // ── Movement: hold preferred band, strafe, unstick ───────────────────────
    // Orbiting was tried here and REMOVED: measured, it made the light hull
    // strictly worse (Wasp vs Mammoth at close range fell from 0.069 to 0.028).
    // Diving inside a turret's traverse envelope only pays if your own turret
    // can still track, and it drags you into the range band where the enemy's
    // damage is highest. `outTurnRadius` is kept because the geometry is still
    // the right way to reason about it, but nothing acts on it yet.
    const want = this.preferredRange();
    this.orbiting = false;
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(me.root.quaternion);
    const flat = toTarget.clone().setY(0).normalize();

    // Flip strafe direction on a randomised interval rather than riding a clean
    // sine wave. A sine is trivially leadable — a competent shooter just aims
    // where the curve is going.
    this.strafeFlip -= dt;
    if (this.strafeFlip <= 0 && !this.orbiting) {
      // Not while orbiting: reversing the circle hands the turret the lead it
      // was losing, which throws away the whole manoeuvre.
      this.strafeDir *= -1;
      this.strafeFlip = 0.5 + random() * 1.7;
    }
    this.strafePhase += dt * (0.7 + this.skill * 0.9);
    const strafe = Math.sin(this.strafePhase) * 0.55 * this.strafeDir;

    // Evading a shell outranks everything else, including holding range.
    this.dodgeTimer -= dt;
    const threat = this._dodgeVector(combat, me);
    if (threat) { this.dodgeDir = threat; this.dodgeTimer = 0.35; }
    if (this.dodgeTimer <= 0) this.dodgeDir = null;

    let desiredDir;
    if (this.dodgeDir) {
      desiredDir = this.dodgeDir.clone();
    } else if (this.noLosTimer > 1.5) {
      // Blind for a while: stop nursing the preferred range and go find an
      // angle. Without this a long-range bot will happily sit at its ideal
      // distance behind a wall for the whole match.
      desiredDir = flat.clone();
    } else if (this.orbiting) {
      // Inside the traverse envelope: commit to a circle. Tangential motion is
      // what outruns the turret; drifting in or out just gives it a chance to
      // catch up. A slight inward bias holds the radius against drift.
      const tangent = new THREE.Vector3()
        .crossVectors(flat, new THREE.Vector3(0, 1, 0))
        .multiplyScalar(this.strafeDir);
      desiredDir = tangent.addScaledVector(flat, 0.18).normalize();
    } else if (dist > want * 1.25) desiredDir = flat.clone();
    else if (dist < want * 0.7) desiredDir = flat.clone().negate();
    else {
      const side = new THREE.Vector3().crossVectors(flat, new THREE.Vector3(0, 1, 0));
      desiredDir = side.multiplyScalar(this.strafeDir).normalize();
    }
    // Don't dilute an evade or an orbit with the idle strafe — a half-committed
    // manoeuvre is just a slower way of standing where the shot is going.
    if (!this.dodgeDir && !this.orbiting) {
      desiredDir.addScaledVector(
        new THREE.Vector3().crossVectors(flat, new THREE.Vector3(0, 1, 0)), strafe).normalize();
    }

    // Bend the intent around whatever is actually in the way.
    desiredDir = this._steerAround(world, RAPIER, me, desiredDir);

    const cross = fwd.x * desiredDir.z - fwd.z * desiredDir.x;
    const dot = fwd.dot(desiredDir);
    input.steer = THREE.MathUtils.clamp(cross * 2.2, -1, 1);
    input.throttle = dot > 0.2 ? 1 : dot > -0.4 ? 0.55 : -0.7;

    // Ease off when closing on an obstacle, and back out rather than grind
    // into it. Turning takes room, so slowing early is what buys the space.
    const clear = this.forwardClear ?? 10;
    if (clear < 3.5) input.throttle = -0.8;
    else if (clear < 7) input.throttle = Math.min(input.throttle, 0.45);

    // Last-resort unstick: still pinned despite all of the above.
    if (myPos.distanceTo(this.lastPos) < 0.06 && Math.abs(input.throttle) > 0.3) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.5) {
        input.throttle = -1;
        input.steer = this.strafeDir;
        if (this.stuckTimer > 1.4) { this.stuckTimer = 0; this.strafeDir *= -1; }
      }
    } else {
      this.stuckTimer = 0;
    }
    this.lastPos.copy(myPos);

    // ── Fire discipline ─────────────────────────────────────────────────────
    // Line of sight is held for a short window after it breaks. Without this
    // hysteresis a charge weapon can never finish a charge, because strafing
    // past cover clips the ray for a frame at a time.
    const losNow = this.hasLineOfSight(world, RAPIER, me.muzzlePosition, tgtPos, me, this.target);
    this.losMemory = losNow ? 0.7 : Math.max(0, this.losMemory - dt);
    this.noLosTimer = losNow ? 0 : this.noLosTimer + dt;
    const los = this.losMemory > 0;

    const aimedWell = (me.aimError ?? Math.PI) < THREE.MathUtils.lerp(0.22, 0.05, this.skill);
    input.fire = los && this.reaction <= 0 && (aimedWell || !!me.weapon.chargeTime);

    return input;
  }
}

/**
 * Is `other` someone this bot should be shooting at?
 *
 * Teams are the tanks' own property rather than something the brain is
 * configured with, so a bot moved between sides needs no re-wiring — and in a
 * mode with no sides every tank has a null team and everyone is fair game.
 */
function hostile(me, other) {
  return !(me.team && other.team && me.team === other.team);
}
