import * as THREE from 'three';
import { damageAtRange, PROJECTILE_GRAVITY, EVASION, WEAPONS } from './config.js';
import { glowSprite } from './textures.js';
import { gaussian, gaussianFrom } from './rng.js';

// Combat resolution. All damage in the game passes through this class, so the
// headless balance sim can drive it with the renderer and fx stripped out.

// Lazily built: drawing it needs a <canvas>, and this module must import
// cleanly in Node for headless runs.
let sprite = null;
const glow = () => (sprite ??= glowSprite());

// Rapier renamed `toi` to `timeOfImpact` between releases; accept either.
const impactDistance = (hit) => hit.timeOfImpact ?? hit.toi;

export class Combat {
  constructor({ world, RAPIER, scene, fx }) {
    this.world = world;
    this.RAPIER = RAPIER;
    this.scene = scene;
    this.fx = fx;
    this.projectiles = [];
    this.byCollider = new Map();
    this.tanks = [];
    this.onKill = null;
    this.onHit = null;
    // Telemetry ring buffer. This grew unbounded — one entry per shot, forever.
    // Harmless in a 60s test, a steady leak in a match that runs for an hour,
    // and the kind of thing that only shows up once the game is worth playing
    // for that long.
    this.shots = [];
    this.maxShotLog = 2000;
  }

  register(tank) {
    this.tanks.push(tank);
    this.byCollider.set(tank.collider.handle, tank);
  }

  // ── Firing ────────────────────────────────────────────────────────────────
  /**
   * @param visualOnly  Draw the shot but resolve no damage.
   * @param seed        Makes the spread draw reproducible, so a client and the
   *                    server independently produce the SAME shot. Null offline,
   *                    where there is only one simulation and nothing to match.
   * @param dryFire     Advance only what the shot does to the shooter — cooldown,
   *                    charge, recoil — and draw nothing. This is how a client
   *                    replays a shot it has ALREADY drawn while reconciling,
   *                    without drawing it a second time.
   *
   * A network client must never decide whether a shot hit. It fires locally so
   * the gun feels instant, but the server owns the outcome — if the client also
   * applied damage, every hit would flash on screen and then be erased by the
   * next snapshot ("lots of shots, almost nothing lands"), and the resulting
   * physics disagreement pushes the tank around.
   *
   * But "the client draws it, the server resolves it" only holds together if
   * both draw the same line. See `gaussianFrom` — they did not, and that is the
   * residual "it looked like a hit and did nothing" after lag compensation was
   * fixed.
   */
  tryFire(tank, { visualOnly = false, seed = null, dryFire = false } = {}) {
    if (!tank.alive || tank.cooldown > 0) return false;
    const w = tank.weapon;

    if (w.chargeTime) {
      if (tank.charge < 1) return false;
      tank.charge = 0;
    }

    tank.cooldown = w.fireInterval;
    tank.recoilOffset = w.recoil * 0.12;
    // Firing gives up spawn protection. Otherwise it is not protection, it is
    // two seconds of free shooting from behind a shield.
    tank.spawnGuard = 0;

    const origin = tank.muzzlePosition;
    const dir = tank.aimDirection();

    // Recoil kick on the chassis. Small, but it makes heavy guns feel heavy.
    const kick = dir.clone().multiplyScalar(-w.recoil * tank.hull.mass * 22);
    tank.body.applyImpulse({ x: kick.x, y: 0, z: kick.z }, true);

    // Everything above is what firing does to the SHOOTER, and a replay has to
    // redo all of it — the recoil included, or the client's predicted position
    // drifts from the server's by one kick per unacknowledged shot.
    if (dryFire) return true;

    this.fx?.muzzleFlash(origin, dir, w.color);

    // Exactly ONE draw per shot, resolved here rather than inside each fire
    // path. Two draws for one shot cannot be kept in sync across two machines.
    const sigma = w.spread + this._evasionSpread(tank, origin, dir);
    const shot = this._spread(dir, sigma, seed);

    if (w.kind === 'hitscan') this._fireHitscan(tank, origin, shot, visualOnly);
    else this._fireProjectile(tank, origin, shot, visualOnly);

    // Lets the server broadcast the shot so other clients can draw it. Without
    // this a client sees its health drop with nothing visibly shooting at it.
    // Broadcasting the SPREAD direction, not the aim direction: observers should
    // see the shot the server actually traced, or their impact effects land in a
    // different place from the damage.
    this.onFire?.(tank, origin, shot);
    return true;
  }

  /**
   * Draw a shot fired by somebody else, from the server's report of it.
   * Purely cosmetic — no damage, no physics.
   */
  renderRemoteShot(weaponKey, origin, dir) {
    const w = WEAPONS[weaponKey];
    if (!w || !this.scene) return;
    this.fx?.muzzleFlash(origin, dir, w.color);
    if (w.kind === 'hitscan') {
      const ray = new this.RAPIER.Ray(
        { x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z });
      const hit = this.world.castRay(ray, 200, true);
      const dist = hit ? impactDistance(hit) : 200;
      const end = origin.clone().addScaledVector(dir, dist);
      this.fx?.beam(origin, end, w.color);
      this.fx?.impact(end, dir.clone().negate(), w.color, 1);
      return;
    }
    this._spawnProjectile(w, origin, dir.clone(), null, true);
  }

  /**
   * Extra spread against a target that is crossing your line of fire.
   *
   * This is the mechanic that makes a light hull mean anything. Measured before
   * it existed: a Wasp out-damaged a Mammoth in every close-range mirror
   * (8807 vs 8458 dealt, 20.9 vs 17.8 per shot) and still lost 0-29, because
   * both took the same damage — mobility reduced incoming fire by about 4% while
   * the HP gap was 75%. Speed had nothing to buy. No amount of HP or
   * acceleration tuning fixes that; the game simply had no way to miss a fast
   * target, so the optimiser could only ever conclude Wasp needed Mammoth's HP.
   *
   * Scaled by the target's ANGULAR rate (lateral speed / distance), because
   * that is what actually defeats tracking: 16 m/s is trivial to follow at 60m
   * and nearly impossible at 8m.
   */
  _evasionSpread(shooter, origin, dir) {
    const ray = new this.RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z });
    const hit = this.world.castRay(
      ray, 120, true, undefined, undefined, undefined, shooter.body);
    if (!hit) return 0;

    const target = this.byCollider.get(hit.collider.handle);
    if (!target || target === shooter) return 0;

    const dist = Math.max(3, impactDistance(hit));
    // `netVel` is the velocity a network client derives for a remote tank from
    // the two snapshots it is blending between. Its physics body has none worth
    // reading — interpolation calls setTranslation and never integrates it — so
    // without this the client computes ~zero evasion while the server computes
    // the real thing, and the two sigmas disagree by up to EVASION.max (0.055
    // rad, larger than Twin's own spread). The seeded draw is then multiplied by
    // two different numbers and the shots part company anyway.
    const v = target.netVel ?? target.body.linvel();
    // Component of the target's velocity across the line of fire.
    const lateral = Math.abs(v.x * -dir.z + v.z * dir.x);
    return Math.min(EVASION.max, EVASION.gain * (lateral / dist));
  }

  _spread(dir, sigma, seed = null) {
    if (!sigma) return dir.clone();
    // Gaussian angular error, applied on the horizontal axis ONLY.
    //
    // It used to scatter vertically as well. On a flat arena every target sits
    // at the same height, so vertical scatter could only ever turn a good shot
    // into a miss over the target's head — it added variance without adding a
    // decision. Horizontal spread still does the real job: it is what keeps a
    // high-damage weapon honest at range.
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const g = seed == null ? gaussian() : gaussianFrom(seed);
    return dir.clone().addScaledVector(right, g * sigma).normalize();
  }

  _fireProjectile(tank, origin, d, visualOnly = false) {
    const w = tank.weapon;
    // Clone: _spawnProjectile scales the direction into a velocity in place, and
    // the caller still needs the unit vector for the fire broadcast.
    this._spawnProjectile(w, origin, d.clone(), tank, visualOnly);
    this._logShot(w, tank);
  }

  _spawnProjectile(w, origin, d, owner, ghost) {
    let mesh = null;
    if (this.scene) {
      mesh = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glow(), color: w.color, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      mesh.scale.setScalar(w.splash ? 1.6 : 0.9);
      mesh.position.copy(origin);
      this.scene.add(mesh);
    }
    this.projectiles.push({
      mesh,
      pos: origin.clone(),
      vel: d.multiplyScalar(w.muzzleSpeed),
      weapon: w,
      owner,
      ghost,                     // cosmetic only: impacts render, damage does not
      origin: origin.clone(),
      life: 4,
      gravity: PROJECTILE_GRAVITY,   // 0 — every shot flies straight
    });
  }

  _fireHitscan(tank, origin, d, visualOnly = false) {
    const w = tank.weapon;
    let from = origin.clone();
    let remaining = 200;
    let end = origin.clone().addScaledVector(d, remaining);
    const alreadyHit = new Set();

    for (let bounce = 0; bounce < 8 && remaining > 0.5; bounce++) {
      const ray = new this.RAPIER.Ray(
        { x: from.x, y: from.y, z: from.z }, { x: d.x, y: d.y, z: d.z });
      const hit = this.world.castRayAndGetNormal(
        ray, remaining, true, undefined, undefined,
        undefined, tank.body);

      if (!hit) { end = from.clone().addScaledVector(d, remaining); break; }

      const dist = impactDistance(hit);
      const point = from.clone().addScaledVector(d, dist);
      const target = this.byCollider.get(hit.collider.handle);

      if (target && target !== tank && target.alive && !alreadyHit.has(target)) {
        alreadyHit.add(target);
        const range = origin.distanceTo(point);
        if (!visualOnly) this._applyDamage(target, damageAtRange(w, range), tank, point);
        this.fx?.impact(point, d.clone().negate(), w.color, 1.2);
        if (w.pierce) {
          from = point.clone().addScaledVector(d, 0.6);
          remaining -= dist + 0.6;
          continue;
        }
        end = point; break;
      }

      // Terrain or cover: the beam stops here.
      const n = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
      this.fx?.impact(point, n, w.color, 1);
      end = point;
      break;
    }

    this.fx?.beam(origin, end, w.color);
    this._logShot(w, tank);
  }

  // ── Damage ────────────────────────────────────────────────────────────────
  _logShot(weapon, tank) {
    this.shots.push({ t: performance.now(), weapon: weapon.name, shooter: tank.name });
    if (this.shots.length > this.maxShotLog) this.shots.splice(0, this.shots.length - this.maxShotLog);
  }

  _applyDamage(target, amount, source, point) {
    const killed = target.takeDamage(amount, source);
    this.onHit?.(target, amount, source, point);
    if (killed) {
      this.fx?.explosion(target.position, 7, 0xff8a3d);
      this.fx?.smoke(target.position, 10);
      this.onKill?.(target, source);
    }
  }

  _splash(center, weapon, source) {
    const radius = weapon.splash;
    for (const t of this.tanks) {
      if (!t.alive || t.removed) continue;
      const dist = t.position.distanceTo(center);
      if (dist > radius) continue;
      const falloff = 1 - dist / radius;
      const dmg = weapon.damage * weapon.splashFactor * falloff;
      if (dmg > 0.5) this._applyDamage(t, dmg, source, t.position);
    }
  }

  // ── Per-frame ─────────────────────────────────────────────────────────────
  update(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;

      if (p.gravity) p.vel.y -= p.gravity * dt;

      const step = p.vel.clone().multiplyScalar(dt);
      const dist = step.length();
      const dir = step.clone().normalize();

      let consumed = false;

      if (dist > 1e-5) {
        const ray = new this.RAPIER.Ray(
          { x: p.pos.x, y: p.pos.y, z: p.pos.z }, { x: dir.x, y: dir.y, z: dir.z });
        const hit = this.world.castRayAndGetNormal(
          ray, dist, true, undefined, undefined, undefined, p.owner?.body);

        if (hit) {
          const d = impactDistance(hit);
          const point = p.pos.clone().addScaledVector(dir, d);
          const target = this.byCollider.get(hit.collider.handle);
          const n = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);

          if (p.weapon.splash) {
            this.fx?.explosion(point, p.weapon.splash, p.weapon.color);
            // BOTH damage calls must be behind the ghost check. The splash one
            // was; the direct-hit one below was not, so every Thunder shot on a
            // network client — its own, and every remote shot replayed from a
            // `fire` event — applied real damage locally. That is precisely the
            // client-side combat that was supposed to have been removed: the
            // hit lands, the next snapshot overwrites the HP, and the tank gets
            // shoved by a shell the server never agreed existed. It survived
            // because the fix was made in the hitscan and non-splash paths and
            // this branch reads as if it were only computing the bonus.
            if (!p.ghost) {
              this._splash(point, p.weapon, p.owner);
              if (target && target.alive) {
                // Direct hits pay full damage on top of the splash component.
                const range = p.origin.distanceTo(point);
                this._applyDamage(target, damageAtRange(p.weapon, range) - p.weapon.damage * p.weapon.splashFactor, p.owner, point);
              }
            }
          } else if (target && target !== p.owner && target.alive) {
            if (!p.ghost) {
              const range = p.origin.distanceTo(point);
              this._applyDamage(target, damageAtRange(p.weapon, range), p.owner, point);
            }
            this.fx?.impact(point, dir.clone().negate(), p.weapon.color, 1.1);
          } else {
            this.fx?.impact(point, n, p.weapon.color, 0.8);
          }
          consumed = true;
        }
      }

      if (consumed || p.life <= 0 || p.pos.y < -5) {
        if (p.mesh) {
          this.scene.remove(p.mesh);
          p.mesh.material.dispose();
        }
        this.projectiles.splice(i, 1);
        continue;
      }

      p.pos.add(step);
      p.mesh?.position.copy(p.pos);
    }
  }
}
