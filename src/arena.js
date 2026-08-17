import * as THREE from 'three';
import { groundTexture, metalTexture } from './textures.js';

// Map archetype "mixed": open centre, hard cover on the flanks, long sight
// lines down the axes. Deliberately built so all three engagement bands exist
// on one map — that is what makes a single map usable for balance testing.

export const ARENA_SIZE = 120;

export function buildArena(scene, world, RAPIER) {
  const half = ARENA_SIZE / 2;
  const statics = [];

  // `scene` may be null: the balance harness builds the same colliders with no
  // meshes, materials or textures at all, so geometry stays identical between
  // what players see and what the optimiser measures.
  const visual = !!scene;

  // ── Ground ────────────────────────────────────────────────────────────────
  if (visual) {
    const groundMat = new THREE.MeshStandardMaterial({
      map: groundTexture(30), roughness: 0.95, metalness: 0.05,
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_SIZE, ARENA_SIZE), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
  }

  world.createCollider(
    RAPIER.ColliderDesc.cuboid(half, 0.5, half).setTranslation(0, -0.5, 0));

  // ── Block helper ──────────────────────────────────────────────────────────
  const blockMat = visual ? new THREE.MeshStandardMaterial({
    map: metalTexture('#8a9099'), roughness: 0.75, metalness: 0.15,
  }) : null;
  const trimMat = visual ? new THREE.MeshStandardMaterial({
    color: 0x2ec4b6, roughness: 0.45, metalness: 0.4,
    emissive: 0x1a8f83, emissiveIntensity: 0.9,
  }) : null;

  function block(x, z, w, h, d, trim = false) {
    if (visual) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), blockMat);
      mesh.position.set(x, h / 2, z);
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
      statics.push(mesh);

      // A thin proud band near the top edge, not a cap over the whole top face
      // — a glowing surface that large reads as a blown highlight, not as trim.
      if (trim) {
        const t = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.22, d + 0.3), trimMat);
        t.position.set(x, h - 0.5, z);
        scene.add(t);
      }
    }

    world.createCollider(
      RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setTranslation(x, h / 2, z));
  }

  // ── Perimeter ─────────────────────────────────────────────────────────────
  const wallH = 7;
  block(0, -half, ARENA_SIZE, wallH, 3);
  block(0, half, ARENA_SIZE, wallH, 3);
  block(-half, 0, 3, wallH, ARENA_SIZE);
  block(half, 0, 3, wallH, ARENA_SIZE);

  // ── Centre structure: breaks the middle, creates close-quarters pockets ───
  block(0, 0, 14, 5.5, 14, true);
  block(0, 0, 22, 1.6, 22);

  // ── Flank cover: mid-band duelling ground ─────────────────────────────────
  const flanks = [
    [-26, -26], [26, -26], [-26, 26], [26, 26],
    [-34, 0], [34, 0], [0, -34], [0, 34],
  ];
  for (const [x, z] of flanks) {
    block(x, z, 9, 4, 9, true);
    block(x + 7, z + 7, 5, 2.2, 5);
  }

  // ── Scatter: low cover that blocks shells but not sight ───────────────────
  const rng = mulberry32(1337);
  for (let i = 0; i < 26; i++) {
    const a = rng() * Math.PI * 2;
    const r = 14 + rng() * 40;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.abs(x) < 13 && Math.abs(z) < 13) continue;
    block(x, z, 2.4 + rng() * 3, 1.4 + rng() * 1.6, 2.4 + rng() * 3);
  }

  // ── Long-band corridors: clear lanes down both axes for Rail ──────────────
  block(-half + 12, -half + 12, 6, 9, 6, true);
  block(half - 12, half - 12, 6, 9, 6, true);

  return { statics, size: ARENA_SIZE };
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function spawnPoints() {
  const r = 46;
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    pts.push(new THREE.Vector3(Math.cos(a) * r, 1.5, Math.sin(a) * r));
  }
  return pts;
}
