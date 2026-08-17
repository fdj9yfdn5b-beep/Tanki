import * as THREE from 'three';
import { glowSprite } from './textures.js';
import { FX } from './config.js';

// Pooled effects. Everything here is transient visual feedback — none of it
// touches simulation state, so it is safe to skip on a headless balance run.

const sprite = glowSprite();

export class Fx {
  constructor(scene) {
    this.scene = scene;
    this.live = [];
    this.decals = [];
    this.maxDecals = 160;
    this.spritePool = [];   // retired Sprites, ready to be re-issued
  }

  /**
   * Take a Sprite from the pool, or build one if the pool is dry.
   *
   * Every particle used to allocate a fresh Sprite AND a fresh SpriteMaterial,
   * then dispose both a fraction of a second later. A single explosion is ~15 of
   * them. That is pure garbage generation during the exact frames the player is
   * in a fight, and GC pauses are felt as hitches rather than as a lower frame
   * rate — which is precisely the symptom being chased here.
   */
  _sprite(color, opacity = 1) {
    const s = this.spritePool.pop() ?? new THREE.Sprite(new THREE.SpriteMaterial({
      map: sprite, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    s.material.color.setHex(color);
    s.material.opacity = opacity;
    s.material.blending = THREE.AdditiveBlending;
    s.visible = true;
    return s;
  }

  _retire(obj) {
    if (obj.isSprite && this.spritePool.length < 256) {
      this.spritePool.push(obj);
      return;
    }
    obj.material?.dispose?.();
    if (obj.isMesh) obj.geometry?.dispose?.();
  }

  _add(obj, life, update) {
    obj.userData.age = 0;
    obj.userData.life = life;
    obj.userData.update = update;
    this.scene.add(obj);
    this.live.push(obj);
    return obj;
  }

  muzzleFlash(pos, dir, color) {
    const s = this._sprite(color);
    s.position.copy(pos);
    s.scale.setScalar(2.0);
    this._add(s, 0.07, (o, t) => {
      o.scale.setScalar(2.0 * (1 - t) + 0.4);
      o.material.opacity = 1 - t;
    });

    // Ejecta, kept sparse. This was six embers plus the flash — seven additive
    // sprites per shot — which at a 2.4/sec fire rate reads as a continuous
    // burst rather than as individual shots. The shot rate was always correct;
    // it just looked like several. Now in config.FX so the next playtest can
    // move it without a code hunt.
    for (let i = 0; i < FX.muzzleEmbers; i++) {
      const p = this._sprite(color);
      p.position.copy(pos);
      p.scale.setScalar(0.5);
      const v = dir.clone().multiplyScalar(8 + Math.random() * 10)
        .add(new THREE.Vector3(
          (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6));
      this._add(p, 0.22 + Math.random() * 0.15, (o, t, dt) => {
        o.position.addScaledVector(v, dt);
        v.y -= 22 * dt;
        o.material.opacity = 1 - t;
        o.scale.setScalar(0.5 * (1 - t));
      });
    }
  }

  impact(pos, normal, color = 0xffd08a, scale = 1) {
    const s = this._sprite(color);
    s.position.copy(pos);
    this._add(s, 0.18, (o, t) => {
      o.scale.setScalar((1 + t * 5) * scale);
      o.material.opacity = 1 - t;
    });

    // Cap the ember count. It was `10 * scale`, and scale rides the splash
    // radius — a big Thunder hit was emitting 30+ sprites in one frame. Halved
    // again after playtest: impacts were 62% of all effects spawned.
    const embers = Math.min(FX.maxImpactEmbers, Math.round(FX.impactEmbers * scale) + 1);
    for (let i = 0; i < embers; i++) {
      const p = this._sprite(color);
      p.position.copy(pos);
      const v = normal.clone().multiplyScalar(4 + Math.random() * 9 * scale)
        .add(new THREE.Vector3(
          (Math.random() - 0.5) * 9, Math.random() * 7, (Math.random() - 0.5) * 9));
      this._add(p, 0.3 + Math.random() * 0.3, (o, t, dt) => {
        o.position.addScaledVector(v, dt);
        v.y -= 26 * dt;
        o.material.opacity = 1 - t;
        o.scale.setScalar(0.42 * scale * (1 - t * 0.7));
      });
    }
  }

  explosion(pos, radius, color = 0xffa040) {
    // Soft additive billboards, not a sphere mesh. A splash radius of 4-5m means
    // the camera is routinely *inside* the blast, and a sphere seen from within
    // fills the screen with a flat orange wall that hides the whole fight.
    const flash = this._sprite(color);
    flash.position.copy(pos);
    this._add(flash, 0.3, (o, t) => {
      o.scale.setScalar(radius * (0.7 + t * 1.5));
      o.material.opacity = 0.75 * (1 - t) ** 2.2;
    });

    const core = this._sprite(0xfff0d0);
    core.position.copy(pos);
    this._add(core, 0.12, (o, t) => {
      o.scale.setScalar(radius * 0.55 * (1 - t * 0.4));
      o.material.opacity = (1 - t) ** 1.4;
    });

    this.impact(pos, new THREE.Vector3(0, 1, 0), color, radius * 0.3);
    this.smoke(pos, 4);
  }

  // Hitscan beam: a stretched additive cylinder that collapses in on itself.
  beam(from, to, color) {
    const dist = from.distanceTo(to);
    const geo = new THREE.CylinderGeometry(0.13, 0.13, dist, 8, 1, true);
    geo.translate(0, dist / 2, 0);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(from);
    m.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
    this._add(m, FX.beamLife, (o, t) => {
      o.material.opacity = (1 - t) ** 2;
      o.scale.set(1 - t * 0.85, 1, 1 - t * 0.85);
    });
  }

  smoke(pos, amount = 3) {
    for (let i = 0; i < amount; i++) {
      const p = this._sprite(0x5a5f66, 0.5);
      p.material.blending = THREE.NormalBlending;   // smoke occludes, not glows
      p.position.copy(pos).add(new THREE.Vector3(
        (Math.random() - 0.5) * 1.4, Math.random() * 0.6, (Math.random() - 0.5) * 1.4));
      const v = new THREE.Vector3(
        (Math.random() - 0.5) * 1.6, 1.6 + Math.random() * 1.6, (Math.random() - 0.5) * 1.6);
      this._add(p, 1.3 + Math.random(), (o, t, dt) => {
        o.position.addScaledVector(v, dt);
        o.material.opacity = 0.5 * (1 - t);
        o.scale.setScalar(1.2 + t * 4);
      });
    }
  }

  // Track marks. Kept as a capped ring buffer so a long match cannot leak.
  // Geometry is shared across every decal; only the material differs, because
  // each one fades independently as it ages out of the buffer.
  trackMark(pos, quat) {
    const geo = Fx.decalGeo ??= new THREE.PlaneGeometry(0.55, 0.7);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x14161a, transparent: true, opacity: 0.4,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(pos);
    m.quaternion.copy(quat);
    m.rotateX(-Math.PI / 2);
    this.scene.add(m);
    this.decals.push(m);
    if (this.decals.length > this.maxDecals) {
      const old = this.decals.shift();
      this.scene.remove(old);
      old.material.dispose();   // geometry is shared — see above
    }
  }

  update(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const o = this.live[i];
      o.userData.age += dt;
      const t = o.userData.age / o.userData.life;
      if (t >= 1) {
        this.scene.remove(o);
        // Sprites go back to the pool; meshes (beams) are disposed. Note that a
        // Sprite's geometry must NEVER be disposed either way: three shares one
        // quad across every Sprite in the scene.
        this._retire(o);
        this.live.splice(i, 1);
        continue;
      }
      o.userData.update(o, t, dt);
    }
    // Fade the oldest decals out rather than popping them.
    const n = this.decals.length;
    for (let i = 0; i < Math.min(24, n); i++) {
      this.decals[i].material.opacity = 0.4 * (i / 24);
    }
  }
}
