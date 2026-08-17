import * as THREE from 'three';
import { HULLS, WEAPONS } from './config.js';
import { metalTexture, treadTexture } from './textures.js';

// One tank. Player and bot go through the same `update(dt, input)` path —
// the only difference is who fills the input struct. That is deliberate: it is
// what lets the exact same tank code run inside the headless balance sim.

const UP = new THREE.Vector3(0, 1, 0);

// Turret traverse is velocity-controlled, not a raw on/off rate.
//
// Holding a key still reaches the weapon's full `turretTurnRate` — that number
// is balance-relevant and unchanged — but it takes SPIN_UP seconds to get
// there. The point is the other end: a one-frame tap moves the turret by
// maxRate * (dt/SPIN_UP) * dt, which for the fastest turret in the game is
// under a tenth of a degree. That is what makes fine aim possible on a
// keyboard. Straight rate control gives 3.75 rad/s from the first frame —
// 3.5° per frame, roughly a metre of aim error at 40m, with nothing in between.
// Module-level so the charge tell is not allocating a Color every frame.
const WHITE = new THREE.Color(0xffffff);

// Anti-grav. Stiff enough to hold a steady ride height over the arena's steps,
// damped just under critical so it settles rather than bobbing. The probe stops
// short deliberately: past this there is nothing to hover over and the hull
// should be falling.
// How far above the hull box the collider reaches, to cover the turret. Sized
// so that every hull's muzzle lands inside every other hull's box — see
// tools/hitheight.mjs, which fails if that ever stops being true.
const TURRET_HITBOX_RISE = 0.55;

// A hover hull's box also reaches down through its anti-grav cushion. Without
// it the gap between the lowest muzzle in the game and this hull's underside
// was 7cm — technically hittable, and one bump away from not being. It stops
// well short of the ground so the hull still rides over small steps.
const HOVER_SKIRT = 0.2;

const HOVER_PROBE = 6;          // m of ground to look for below
const HOVER_STIFFNESS = 60;
const HOVER_DAMPING = 12;

// Turret spin-up and settle, in seconds from rest to full traverse and back.
//
// These are ANGULAR ACCELERATION limits, not durations of an animation, and the
// difference is the whole point: with a fixed acceleration, the turret takes as
// long to stop as it was actually going fast. Release from a flick and it stops
// almost at once; release from a full sweep and it settles over a much longer
// arc, because the distance it coasts is ω²/2a — quadratic in how fast it was
// moving. That is real physics rather than a fade, which is what was asked for.
//
// Scaled per weapon by barrel length, as a stand-in for the rotational inertia
// of the thing being swung. Rail hangs a 3.6m barrel off the ring and Twin a
// 2.5m pair, so Rail winds up and settles noticeably heavier — and each weapon
// gets a distinct feel out of a property it already had.
//
// Settle was 0.12s flat, which parked the aim exactly where you left it and
// felt like the gun was on rails. Every increase here is coast the player did
// not ask for, so it trades against the aim precision playtest 6 was about;
// this is deliberately the smallest step that reads as mass.
const TURRET_SPIN_UP = 0.75;
const TURRET_SPIN_DOWN = 0.16;
const TURRET_REFERENCE_BARREL = 3.0;   // Thunder's, i.e. the middle of the range

// The same treatment for the hull's own rotation, scaled by mass instead of
// barrel length. Deliberately quicker to stop than to start: a tracked vehicle
// brakes a turn by driving the tracks against it, which it can do harder than
// it can accelerate the turn in the first place.
const HULL_TURN_SPIN_UP = 0.30;        // s from rest to full turn rate
const HULL_TURN_SETTLE = 0.18;         // s from full turn rate back to straight
const HULL_REFERENCE_MASS = 1.55;      // Hunter

function approach(current, target, maxDelta) {
  if (current < target) return Math.min(target, current + maxDelta);
  return Math.max(target, current - maxDelta);
}

// Built on first use, not at import. Every texture here is drawn on a <canvas>,
// and this module has to import cleanly in Node for the headless balance runs.
let sharedTread = null;

export class Tank {
  constructor({ world, RAPIER, scene, hull, weapon, color, isPlayer = false, name = 'Tank' }) {
    this.world = world;
    this.RAPIER = RAPIER;
    this.scene = scene;
    this.hull = HULLS[hull];
    this.weaponKey = weapon;
    this.weapon = WEAPONS[weapon];
    this.color = color ?? this.hull.color;
    this.isPlayer = isPlayer;
    this.name = name;

    this.hp = this.hull.hp;
    this.maxHp = this.hull.hp;
    this.alive = true;
    this.cooldown = 0;
    this.charge = 0;
    this.kills = 0;
    this.trackTimer = 0;
    this.recoilOffset = 0;
    this.turretVel = 0;
    this.turnVel = 0;

    this._buildBody();
    this._buildRig();
    // Visuals are optional. Without a scene the tank is a pure simulation
    // object — no meshes, no materials, no canvas — which is what lets the
    // balance harness run this exact class in Node worker threads.
    if (this.scene) this._buildVisuals();
  }

  // ── Physics ───────────────────────────────────────────────────────────────
  _buildBody() {
    const { RAPIER, world } = this;
    const [hx, hy, hz] = this.hull.size.map((v) => v / 2);

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, 2, 0)
      .setLinearDamping(1.4)
      .setAngularDamping(4.0)
      // Pitch and roll locked: an arcade tank should never tip over, and a
      // locked chassis makes hit registration reproducible for the sim.
      .enabledRotations(false, true, false)
      .setCcdEnabled(true);

    this.body = world.createRigidBody(bodyDesc);

    // The collider covers the TURRET too, not just the hull box.
    //
    // Shots fly flat (§5), so a shot only lands if the shooter's muzzle height
    // falls inside the target's collider. That held by accident while every
    // hull rested on the ground with a muzzle around 0.6-0.8m — a band that sat
    // inside every hull box. It was never actually true: a hull-only box stops
    // at ~1.0m and the turret above it was not there to be hit at all.
    //
    // Adding a hovering hull turned the accident into a visible bug — its
    // muzzle cleared every other hull box and every other muzzle passed beneath
    // its floating one, so it could neither hit nor be hit by anything.
    // `tools/hitheight.mjs` measures this pairing by pairing.
    //
    // Extended upward only: the bottom face stays where it was, so ground
    // contact, driving and ramming are unchanged.
    const rise = TURRET_HITBOX_RISE;
    const skirt = this.hull.hover ? HOVER_SKIRT : 0;
    const colDesc = RAPIER.ColliderDesc.cuboid(hx, hy + (rise + skirt) / 2, hz)
      .setTranslation(0, (rise - skirt) / 2, 0)
      .setMass(this.hull.mass * 8)
      .setFriction(0.6)
      .setRestitution(0.05);

    this.collider = world.createCollider(colDesc, this.body);
  }

  // ── Rig ───────────────────────────────────────────────────────────────────
  // Transform hierarchy only. Aiming, the ballistic solve and muzzle position
  // all read these nodes, so they must exist with or without a renderer.
  _buildRig() {
    const h = this.hull.size[1];
    this.root = new THREE.Group();
    this.turret = new THREE.Group();
    this.turret.position.y = h * 0.72;
    this.root.add(this.turret);
    this.barrelGroup = new THREE.Group();
    this.turret.add(this.barrelGroup);
    this._layoutBarrels();
    if (this.scene) this.scene.add(this.root);
  }

  /** Empty nodes at each muzzle. Visuals hang off them; the sim only needs
   *  their transforms. */
  _layoutBarrels() {
    const w = this.hull.size[0];
    const { barrels, barrelLength, barrelRadius } = this.weapon;
    this.barrels = [];
    for (let i = 0; i < barrels; i++) {
      const off = barrels === 1 ? 0 : (i - (barrels - 1) / 2) * barrelRadius * 2.6;
      const node = new THREE.Object3D();
      node.position.set(off, 0, barrelLength / 2 + w * 0.2);
      this.barrelGroup.add(node);
      this.barrels.push(node);
    }
  }

  // ── Visuals ───────────────────────────────────────────────────────────────
  _buildVisuals() {
    const [w, h, d] = this.hull.size;
    sharedTread ??= treadTexture();

    const bodyMat = new THREE.MeshStandardMaterial({
      map: metalTexture('#ffffff'), color: this.color,
      roughness: 0.55, metalness: 0.45,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x24272c, roughness: 0.8, metalness: 0.3,
    });
    const treadMat = new THREE.MeshStandardMaterial({
      map: sharedTread.clone(), roughness: 0.9, metalness: 0.1,
    });
    treadMat.map.wrapS = treadMat.map.wrapT = THREE.RepeatWrapping;
    treadMat.map.repeat.set(1, d * 0.9);
    this.treadMat = treadMat;

    // Chassis: a wedge-topped box reads as armour far better than a plain box.
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(w * 0.78, h * 0.9, d), bodyMat);
    chassis.position.y = h * 0.15;
    chassis.castShadow = chassis.receiveShadow = true;
    this.root.add(chassis);

    const glacis = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, h * 0.5, d * 0.28), bodyMat);
    glacis.position.set(0, h * 0.55, d * 0.3);
    glacis.rotation.x = -0.5;
    glacis.castShadow = true;
    this.root.add(glacis);

    if (this.hull.hover) {
      // No treads and no wheels — the whole point of the hull is that it does
      // not touch the ground, and a tank sliding sideways on stationary tracks
      // is the single most obviously wrong thing it could do.
      this.treadMat = null;

      // Anti-grav pods along each flank, and a soft glow underneath so the gap
      // to the ground is legible from a chase camera. The glow is what actually
      // says "hovering"; without it a floating box just looks mispositioned.
      for (const side of [-1, 1]) {
        const pod = new THREE.Mesh(
          new THREE.CapsuleGeometry(h * 0.34, d * 0.5, 4, 8), darkMat);
        pod.rotation.x = Math.PI / 2;
        pod.position.set(side * w * 0.40, -h * 0.05, 0);
        pod.castShadow = true;
        this.root.add(pod);

        const emitter = new THREE.Mesh(
          new THREE.CylinderGeometry(h * 0.3, h * 0.44, h * 0.16, 12),
          new THREE.MeshStandardMaterial({
            color: this.color, emissive: this.color, emissiveIntensity: 2.2,
            transparent: true, opacity: 0.85,
          }));
        emitter.position.set(side * w * 0.40, -h * 0.42, 0);
        this.root.add(emitter);
      }
    } else {
      for (const side of [-1, 1]) {
        const tread = new THREE.Mesh(new THREE.BoxGeometry(w * 0.24, h * 0.95, d * 1.04), treadMat);
        tread.position.set(side * w * 0.42, h * 0.02, 0);
        tread.castShadow = tread.receiveShadow = true;
        this.root.add(tread);

        // Road wheels, visible through the tread gap — cheap detail, big payoff.
        for (let i = 0; i < 4; i++) {
          const wheel = new THREE.Mesh(
            new THREE.CylinderGeometry(h * 0.42, h * 0.42, w * 0.1, 12), darkMat);
          wheel.rotation.z = Math.PI / 2;
          wheel.position.set(side * w * 0.42, -h * 0.12, (i / 3 - 0.5) * d * 0.72);
          this.root.add(wheel);
        }
      }
    }

    // ── Turret ──────────────────────────────────────────────────────────────
    const turretBody = new THREE.Mesh(
      new THREE.CylinderGeometry(w * 0.32, w * 0.38, h * 0.8, 14), bodyMat);
    turretBody.castShadow = true;
    this.turret.add(turretBody);

    const mantlet = new THREE.Mesh(new THREE.BoxGeometry(w * 0.4, h * 0.6, w * 0.3), darkMat);
    mantlet.position.z = w * 0.28;
    this.turret.add(mantlet);

    this._buildBarrelVisuals();

    // Emissive weapon-coloured accent: instant team/weapon identification.
    const accent = new THREE.Mesh(
      new THREE.TorusGeometry(w * 0.33, 0.07, 8, 20),
      new THREE.MeshStandardMaterial({
        color: this.weapon.color, emissive: this.weapon.color,
        emissiveIntensity: 1.1, roughness: 0.3,
      }));
    accent.rotation.x = Math.PI / 2;
    accent.position.y = h * 0.42;
    this.turret.add(accent);
    this.accent = accent;

    this._buildNameplate();
  }

  // Barrel geometry hangs off the rig's muzzle nodes, so switching weapon
  // rebuilds only this and leaves the transform hierarchy intact.
  _buildBarrelVisuals() {
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x24272c, roughness: 0.8, metalness: 0.3,
    });
    const { barrelLength, barrelRadius } = this.weapon;
    for (const node of this.barrels) {
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(barrelRadius, barrelRadius * 1.15, barrelLength, 12), darkMat);
      barrel.rotation.x = Math.PI / 2;
      barrel.castShadow = true;
      node.add(barrel);
    }
  }

  _buildNameplate() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 8;
    ctx.fillText(this.name, 128, 32);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;

    this.plate = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    this.plate.scale.set(4.4, 1.1, 1);
    this.plate.position.y = this.hull.size[1] * 0.72 + 3.2;
    this.plate.visible = !this.isPlayer;
    this.root.add(this.plate);

    // Health bar above the nameplate, billboarded the same way.
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(3.6, 0.34),
      new THREE.MeshBasicMaterial({ color: 0x111318, transparent: true, opacity: 0.75, depthTest: false }));
    this.hpFill = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 0.22),
      new THREE.MeshBasicMaterial({ color: 0x4ade80, depthTest: false }));
    this.hpFill.position.z = 0.01;
    this.hpBar = new THREE.Group();
    this.hpBar.add(bg, this.hpFill);
    this.hpBar.position.y = this.plate.position.y - 0.85;
    this.hpBar.renderOrder = 999;
    this.hpBar.visible = !this.isPlayer;
    this.root.add(this.hpBar);
  }

  // ── State ─────────────────────────────────────────────────────────────────
  get position() {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  get muzzlePosition() {
    const p = new THREE.Vector3();
    this.barrels[0].getWorldPosition(p);
    return p.addScaledVector(this.aimDirection(), this.weapon.barrelLength / 2);
  }

  turretForward() {
    const q = new THREE.Quaternion();
    this.turret.getWorldQuaternion(q);
    return new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
  }

  /**
   * Copy the physics body's transform onto the visual rig.
   *
   * Called from update() locally — but remote tanks in a network game never get
   * update(), they are placed by interpolation. Without this being callable on
   * its own, their meshes stayed at the origin forever while their bodies moved
   * around the map: every bot invisible (buried inside the central block) with
   * its nameplate stacked on one spot.
   *
   * Also refreshes world matrices immediately rather than waiting for the
   * renderer, because aiming and muzzle position read them and a headless run
   * never renders.
   */
  syncTransform() {
    const t = this.body.translation();
    const rot = this.body.rotation();
    this.root.position.set(t.x, t.y - this.hull.size[1] / 2, t.z);
    this.root.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    this.root.visible = this.alive;
    this.root.updateMatrixWorld(true);
  }

  /** Effective turret traverse: the weapon's rate, scaled by the hull. */
  get traverseRate() {
    return this.weapon.turretTurnRate * (this.hull.turretMod ?? 1);
  }

  /**
   * Barrel forward. The barrel never elevates, so this is the turret's heading
   * — and that is the point: what the barrel points at is what the shot hits.
   */
  aimDirection() {
    const q = new THREE.Quaternion();
    this.barrelGroup.getWorldQuaternion(q);
    return new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
  }

  setWeapon(key) {
    this.weaponKey = key;
    this.weapon = WEAPONS[key];
    this.charge = 0;
    this.cooldown = 0;

    for (const node of [...this.barrelGroup.children]) {
      this.barrelGroup.remove(node);
      node.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    }
    this._layoutBarrels();
    if (this.scene) {
      this._buildBarrelVisuals();
      if (this.accent) {
        this.accent.material.color.setHex(this.weapon.color);
        this.accent.material.emissive.setHex(this.weapon.color);
      }
    }
  }

  _syncHealthBar() {
    if (!this.hpFill) return;   // headless
    const frac = this.hp / this.maxHp;
    this.hpFill.scale.x = Math.max(0.001, frac);
    this.hpFill.position.x = -1.7 * (1 - frac);
    this.hpFill.material.color.setHex(
      frac > 0.5 ? 0x4ade80 : frac > 0.25 ? 0xfbbf24 : 0xef4444);
  }

  takeDamage(amount, from) {
    if (!this.alive) return false;
    this.hp = Math.max(0, this.hp - amount);

    // Remember who is shooting us. Without this a bot happily keeps grinding on
    // whichever enemy sits nearest its preferred range while someone unloads
    // into its back — it has no sense of being under fire at all.
    if (from && from !== this) {
      this.threatFrom = from;
      this.threatTimer = 3.0;
    }
    this._syncHealthBar();
    if (this.hp <= 0) {
      this.alive = false;
      // Scoring belongs to Match.onKill, which also credits assists and keeps
      // score consistent with kills. Incrementing here as well double-counted
      // every kill — total kills came out at exactly 2x total deaths, while
      // points (awarded once) matched the true count and so looked "wrong".
      return true;
    }
    return false;
  }

  respawn(pos) {
    this.hp = this.maxHp;
    this.alive = true;
    this._syncHealthBar();
    this.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.root.visible = true;
  }

  // ── Per-frame ─────────────────────────────────────────────────────────────
  // input: { throttle:-1..1, steer:-1..1, aimPoint:Vector3|null, fire:boolean }
  update(dt, input, fx) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.recoilOffset *= Math.max(0, 1 - dt * 9);
    this.threatTimer = Math.max(0, (this.threatTimer ?? 0) - dt);

    if (!this.alive) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;

    this.syncTransform();

    // ── Drive ───────────────────────────────────────────────────────────────
    // Read the rotation back off the body rather than reusing a local from the
    // transform block — syncTransform() owns that now, and leaving a stale
    // reference behind is exactly how this broke.
    const rot = this.body.rotation();
    const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);

    const throttle = THREE.MathUtils.clamp(input.throttle ?? 0, -1, 1);
    const steer = THREE.MathUtils.clamp(input.steer ?? 0, -1, 1);
    const strafe = THREE.MathUtils.clamp(input.strafe ?? 0, -1, 1);

    const vel = this.body.linvel();
    const target = forward.clone().multiplyScalar(throttle * this.hull.maxSpeed);

    // A hover hull adds a sideways component, so its velocity is a full 2D
    // vector rather than a scalar along the nose. This is the whole difference
    // between the two kinds of hull; everything below is shared.
    if (this.hull.hover) {
      // Right-hand perpendicular: with the hull facing +Z this is -X, which is
      // screen-right, matching every other "right" in the codebase.
      const right = new THREE.Vector3(-forward.z, 0, forward.x);
      target.addScaledVector(right, strafe * this.hull.maxSpeed * this.hull.strafeFactor);
      // Diagonals must not be faster than either axis alone.
      const flat = Math.hypot(target.x, target.z);
      if (flat > this.hull.maxSpeed) target.multiplyScalar(this.hull.maxSpeed / flat);
    }
    // Blend toward the target velocity rather than setting it: keeps collisions
    // and explosion knockback meaningful instead of being erased every frame.
    const accel = this.hull.driveForce * dt;
    const newVel = new THREE.Vector3(vel.x, vel.y, vel.z);
    newVel.x += (target.x - newVel.x) * Math.min(1, accel / this.hull.maxSpeed);
    newVel.z += (target.z - newVel.z) * Math.min(1, accel / this.hull.maxSpeed);
    // ── Anti-grav ───────────────────────────────────────────────────────────
    // A spring-damper onto a fixed gap above whatever is below, NOT a fixed
    // height and not gravity switched off. Over a ledge the ray finds nothing
    // and the hull falls like anything else, which is what keeps the map's
    // geometry meaningful — an anti-grav hull that ignored gravity could simply
    // ignore the arena.
    let velY = vel.y;
    if (this.hull.hover) {
      const p = this.body.translation();
      const ground = this.world.castRay(
        new this.RAPIER.Ray({ x: p.x, y: p.y, z: p.z }, { x: 0, y: -1, z: 0 }),
        // Excluding our own body matters: the ray starts inside our collider,
        // and a solid hit from inside reports distance zero.
        HOVER_PROBE, true, undefined, undefined, undefined, this.body);
      if (ground) {
        const err = this.hull.hoverHeight - ground.timeOfImpact;
        // Gravity is cancelled explicitly rather than left for the spring to
        // fight. A spring alone settles wherever its force happens to match
        // gravity — measured, that parked the hull at 0.69m against a 1.15m
        // target, a sag of `g / stiffness`. Stiffening it enough to hide that
        // would only trade the sag for a bob. Cancelling the constant leaves
        // the spring doing the one job it is good at: holding a height.
        velY += (err * HOVER_STIFFNESS - velY * HOVER_DAMPING
          - this.world.gravity.y) * dt;
      }
    }

    this.body.setLinvel({ x: newVel.x, y: velY, z: newVel.z }, true);

    if (this.hull.hover) {
      // A hover hull has no `steer` — it does not need to point itself to go
      // somewhere. Instead the body eases round to face wherever the gun is
      // looking, which is what stops it from sliding around permanently
      // sideways-on and keeps "forward" meaning something for the player.
      //
      // The turret's local angle is decremented by exactly the same step. Miss
      // that and the two chase each other: the body turns toward the aim, which
      // carries the turret with it, which moves the aim.
      const step = THREE.MathUtils.clamp(
        this.turret.rotation.y, -this.hull.turnRate * dt, this.hull.turnRate * dt);
      const yaw = 2 * Math.atan2(rot.y, rot.w) + step;
      this.body.setRotation(
        { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
      this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.turret.rotation.y -= step;

      // Re-sync: this is the one place a hull's rotation changes DURING update
      // rather than inside world.step(), so `root` is now stale by exactly
      // `step`. The turret block below aims via root.worldToLocal, and against
      // a stale frame it reads an error one step too large and corrects for it
      // — handing this hull an effective aim rate of traverse PLUS turn rate.
      // Measured as an 88-91% winrate on Rail, whose traverse is the slowest in
      // the game and so gained the most from the free extra rotation.
      this.syncTransform();
    } else {
      // Steering does NOT invert in reverse.
      //
      // It used to, on the theory that reversing a vehicle flips which way the
      // nose swings. That is car logic — a car steers by pointing its front
      // wheels. A tank steers by driving its tracks at different speeds, so
      // "right" is a request to rotate clockwise and it means the same thing
      // whichever way the hull is travelling. Inverting it just makes the
      // controls change meaning under the player mid-manoeuvre.
      // Ramped, not set. Writing the angular velocity straight from the input
      // meant the hull reached full rotation on the frame the key went down and
      // stopped dead on the frame it came up — the one part of the tank with no
      // physics in it at all, while its linear motion had always blended toward
      // a target. Playtest: the movement did not read as a machine with mass.
      //
      // Same acceleration-limited model as the turret, so the settle is again
      // proportional to how fast it was actually turning: a dab of steer stops
      // almost immediately, a hard sustained turn swings a little past. Scaled
      // by hull mass, which is what makes a Mammoth feel like a Mammoth.
      const inertia = this.hull.mass / HULL_REFERENCE_MASS;
      const want = -steer * this.hull.turnRate;
      const ramp = this.hull.turnRate
        / ((want === 0 ? HULL_TURN_SETTLE : HULL_TURN_SPIN_UP) * inertia);
      this.turnVel = approach(this.turnVel, want, ramp * dt);
      this.body.setAngvel({ x: 0, y: this.turnVel, z: 0 }, true);
    }

    // ── Turret traverse ─────────────────────────────────────────────────────
    // Two ways in. `turretSteer` is direct rate control, which is what the
    // player uses: the turret is a thing you drive, not a thing that snaps to a
    // cursor. `aimPoint` is the "point it at that" path, used by bots.
    if (input.turretSteer !== undefined && input.turretSteer !== null) {
      const maxRate = this.traverseRate;
      const target = THREE.MathUtils.clamp(input.turretSteer, -1, 1) * maxRate;
      // A fixed acceleration limit, so both the wind-up and the settle scale
      // with how fast the turret is actually turning rather than taking a fixed
      // time. Heavier barrel, gentler acceleration — see the constants.
      const inertia = this.weapon.barrelLength / TURRET_REFERENCE_BARREL;
      const ramp = maxRate / ((target === 0 ? TURRET_SPIN_DOWN : TURRET_SPIN_UP) * inertia);
      this.turretVel = approach(this.turretVel, target, ramp * dt);
      this.turret.rotation.y += this.turretVel * dt;
      this.aimError = 0;
    } else if (input.aimPoint) {
      const local = this.root.worldToLocal(input.aimPoint.clone());
      const desired = Math.atan2(local.x, local.z);
      let delta = desired - this.turret.rotation.y;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      const maxStep = this.traverseRate * dt;
      this.turret.rotation.y += THREE.MathUtils.clamp(delta, -maxStep, maxStep);
      this.aimError = Math.abs(delta);
    }

    this.barrelGroup.position.z = -this.recoilOffset;
    // Second refresh: the turret yaw and barrel pitch set above must be live
    // before anything fires this frame, since shots read aimDirection().
    this.root.updateMatrixWorld(true);

    // ── Tread scroll + track marks ──────────────────────────────────────────
    const speed = Math.hypot(newVel.x, newVel.z);
    if (this.treadMat) {
      this.treadMat.map.offset.y -= (throttle >= 0 ? 1 : -1) * speed * dt * 0.35;
    }

    // Spaced by distance travelled, not by time — a fixed interval leaves the
    // marks a metre apart at speed (they read as railway sleepers) and stacked
    // on top of each other when crawling.
    // Nothing touches the ground on a hover hull, so it leaves nothing on it.
    if (fx && speed > 1.2 && !this.hull.hover) {
      this.trackTimer += speed * dt;
      if (this.trackTimer >= 0.45) {
        this.trackTimer = 0;
        for (const side of [-1, 1]) {
          const p = new THREE.Vector3(side * this.hull.size[0] * 0.42, 0, 0);
          this.root.localToWorld(p);
          p.y = 0.02;
          fx.trackMark(p, this.root.quaternion);
        }
      }
    }

    // ── Charge weapons ──────────────────────────────────────────────────────
    if (this.weapon.chargeTime) {
      if (input.fire && this.cooldown <= 0) {
        this.charge = Math.min(1, this.charge + dt / this.weapon.chargeTime);
      } else {
        // Bleed off instead of dumping to zero. A momentary break in the
        // trigger — or in a bot's line of sight — should cost progress, not
        // erase it, otherwise a 1.6 s charge is nearly impossible to land.
        this.charge = Math.max(0, this.charge - (dt / this.weapon.chargeTime) * 0.8);
      }
    }
    this.syncChargeVisual();
  }

  /**
   * Wind the turret ring up as a charge shot builds.
   *
   * Public, and deliberately not folded into `update()`: this is a tell for the
   * ENEMY above all, and remote tanks in a network game never get `update()` —
   * they are placed by interpolation. Leaving it in there meant your own Rail
   * glowed and nobody else's ever did, so the one shot in the game you are
   * supposed to see coming arrived with no warning. Same shape as the bug where
   * remote tanks' meshes never moved: state arrives in the snapshot, and then
   * nothing tells the visuals about it.
   *
   * Three channels, not one. Emissive intensity alone reads as a glow only
   * because the bloom pass smears it, so with bloom off (`B`) nothing visible
   * happened at all. Colour and scale both survive without post-processing.
   */
  syncChargeVisual() {
    if (!this.accent) return;
    const c = this.weapon.chargeTime ? this.charge : 0;
    this.accent.material.emissiveIntensity = 1.1 + c * 2.4;
    this.accent.material.emissive.setHex(this.weapon.color).lerp(WHITE, c * 0.4);
    this.accent.scale.setScalar(1 + c * 0.3);
  }

  faceCamera(camera) {
    if (this.plate?.visible) {
      this.plate.quaternion.copy(camera.quaternion);
      this.hpBar.quaternion.copy(camera.quaternion);
    }
  }
}
