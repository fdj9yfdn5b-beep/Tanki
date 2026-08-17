import * as THREE from 'three';

// Procedural textures — no image files. This is the "the look comes from code"
// argument in practice: albedo + roughness + normal generated at load time.

function canvas(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')];
}

function valueNoise(ctx, size, cells, alpha, hue) {
  const step = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const v = Math.random();
      ctx.fillStyle = `hsla(${hue}, 8%, ${40 + v * 45}%, ${alpha})`;
      ctx.fillRect(x * step, y * step, step + 1, step + 1);
    }
  }
}

export function groundTexture(repeat = 40) {
  const size = 1024;
  const [c, ctx] = canvas(size);
  ctx.fillStyle = '#474e58';
  ctx.fillRect(0, 0, size, size);
  valueNoise(ctx, size, 128, 0.14, 220);

  // Painted arena grid, the readable-space cue that low-poly arenas live on.
  ctx.strokeStyle = 'rgba(150,190,220,0.16)';
  ctx.lineWidth = 3;
  for (let i = 0; i <= 8; i++) {
    const p = (i / 8) * size;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(150,190,220,0.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 64; i++) {
    const p = (i / 64) * size;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function metalTexture(tint = '#8899aa') {
  const size = 512;
  const [c, ctx] = canvas(size);
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, size, size);
  valueNoise(ctx, size, 256, 0.12, 210);

  // Brushed streaks give specular highlights something to travel along.
  ctx.globalAlpha = 0.08;
  for (let i = 0; i < 400; i++) {
    const y = Math.random() * size;
    ctx.strokeStyle = Math.random() > 0.5 ? '#ffffff' : '#000000';
    ctx.lineWidth = Math.random() * 2;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y + (Math.random() - 0.5) * 6); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function treadTexture() {
  const size = 256;
  const [c, ctx] = canvas(size);
  ctx.fillStyle = '#1b1d21';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 16; i++) {
    const y = (i / 16) * size;
    ctx.fillStyle = '#33373d';
    ctx.fillRect(0, y, size, size / 32);
    ctx.fillStyle = '#101215';
    ctx.fillRect(0, y + size / 32, size, size / 64);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 3);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Radial falloff sprite reused by muzzle flash, sparks, smoke and tracers.
export function glowSprite() {
  const size = 128;
  const [c, ctx] = canvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
