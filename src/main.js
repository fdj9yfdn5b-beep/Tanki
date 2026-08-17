import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { Fx } from './fx.js';
import { Match } from './match.js';
import { NetClient } from './net/client.js';
import { BotBrain } from './bots.js';
import { WEAPONS, HULLS } from './config.js';
import { chooseLoadout } from './loadout.js';
import { createTouchControls, isTouchDevice } from './touch.js';

const TOUCH = isTouchDevice();

await RAPIER.init();

// ── Renderer ────────────────────────────────────────────────────────────────
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x2a3444, 95, 220);

// Gradient sky dome. Cheaper and more controllable than an HDRI, and it gives
// the horizon something to sit against instead of a black void.
scene.add(new THREE.Mesh(
  new THREE.SphereGeometry(300, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x0b1220) },
      mid: { value: new THREE.Color(0x2a3444) },
      bottom: { value: new THREE.Color(0x4b5468) },
    },
    vertexShader: `
      varying float vH;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vH = normalize(wp.xyz).y;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 top; uniform vec3 mid; uniform vec3 bottom;
      varying float vH;
      void main() {
        float h = clamp(vH, -1.0, 1.0);
        vec3 c = h > 0.0 ? mix(mid, top, pow(h, 0.65)) : mix(mid, bottom, pow(-h, 0.6));
        gl_FragColor = vec4(c, 1.0);
      }`,
  })));

const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 600);

// ── Lighting ────────────────────────────────────────────────────────────────
// Key + fill + rim. Three lights and good tone mapping do more for the look
// than any amount of mesh detail.
const sun = new THREE.DirectionalLight(0xfff2d8, 2.4);
sun.position.set(45, 70, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 220;
const s = 85;
Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.03;
scene.add(sun);

scene.add(new THREE.HemisphereLight(0x9dc0f0, 0x2a2f38, 1.15));

const rim = new THREE.DirectionalLight(0x4fa3ff, 0.7);
rim.position.set(-50, 25, -45);
scene.add(rim);

// ── Post-processing ─────────────────────────────────────────────────────────
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// Threshold at 1.0 so only genuinely emissive surfaces bloom — anything lower
// and sunlit metal smears into a white blob.
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.34, 0.45, 1.0);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ── World ───────────────────────────────────────────────────────────────────
// One Match class for both modes. Offline it is driven by local bot brains;
// online the server drives the authoritative copy and this one predicts. Using
// the same class for both is what guarantees the prediction matches — a
// separate "client world" would drift the moment either side was edited.
const ONLINE = new URLSearchParams(location.search).has('server')
  || new URLSearchParams(location.search).has('online');
// Where the socket lives depends on how the page was served:
//   dev      — vite serves the page on 5178, the game server is a separate
//              process on 8099
//   built    — the game server serves the page itself, so the socket is the
//              same origin at /ws. This is the case that matters for remote
//              play: one origin means one tunnel, and wss:// comes free with
//              the https:// the tunnel already terminates.
const SERVER_URL = new URLSearchParams(location.search).get('server') || (() => {
  const secure = location.protocol === 'https:';
  if (location.port === '5178') return `ws://${location.hostname}:8099/ws`;
  return `${secure ? 'wss' : 'ws'}://${location.host}/ws`;
})();

const match = new Match({ RAPIER, scene });
const world = match.world;
const combat = match.combat;
const spawns = match.spawns;

const fx = new Fx(scene);
combat.fx = fx;

// ── Tanks ───────────────────────────────────────────────────────────────────
const bots = [];
let player = null;
let net = null;

const BOT_SETUPS = [
  { hull: 'wasp', weapon: 'twin', skill: 0.45, name: 'Vega' },
  { hull: 'hunter', weapon: 'thunder', skill: 0.6, name: 'Rook' },
  { hull: 'mammoth', weapon: 'rail', skill: 0.72, name: 'Iron' },
  { hull: 'hunter', weapon: 'rail', skill: 0.5, name: 'Nyx' },
  { hull: 'wasp', weapon: 'thunder', skill: 0.55, name: 'Ash' },
];

/**
 * A translucent hull floating where the drive stick is pointing.
 *
 * Without it the directional scheme is guesswork: the thumb names a heading,
 * the tank takes a moment to swing onto it, and in between there is nothing on
 * screen saying which heading was asked for — so a correction looks the same as
 * being ignored. The ghost is that missing half of the loop, and it is why the
 * scheme reads as responsive even on a slow hull: the tank lags, the ghost
 * never does.
 *
 * Deliberately the real hull's dimensions, not an arrow. It shows you the shape
 * you are about to fit through a gap, at the angle you are about to hit it.
 */
function createDriveGhost(hull) {
  const [w, h, d] = hull.size;
  const geo = new THREE.BoxGeometry(w, h, d);
  const group = new THREE.Group();

  group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0x6fd3ff, transparent: true, opacity: 0.12,
    depthWrite: false,
  })));
  group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({
      color: 0x6fd3ff, transparent: true, opacity: 0.7,
      depthWrite: false,
    })));

  // A nose wedge, so which end is the front is never ambiguous — a bare box is
  // symmetric and a 180° error is the one that gets you killed.
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(w * 0.26, d * 0.32, 3),
    new THREE.MeshBasicMaterial({
      color: 0x6fd3ff, transparent: true, opacity: 0.5,
      depthWrite: false,
    }));
  nose.rotation.set(Math.PI / 2, 0, Math.PI);
  nose.position.z = d * 0.62;
  group.add(nose);

  // NOTE: depth testing stays ON. The first version disabled it so the ghost
  // would never be hidden by scenery, and the chase camera promptly ended up
  // inside it — a translucent hull drawn over the whole screen with no depth to
  // tell you it was inches away. Same failure as the nameplates that punched
  // through walls. `depthWrite: false` is the part actually wanted: the ghost
  // does not occlude anything, but the world still occludes it.
  group.renderOrder = 5;
  group.visible = false;
  scene.add(group);

  const FORWARD = 2.2;   // m ahead, so the camera is never sitting inside it

  return {
    show(pos, yaw) {
      group.visible = true;
      // Sits a little ahead along the heading it is showing, and floats. Both
      // are so it reads as "go this way" rather than as a second tank glued on
      // top of yours.
      group.position.set(
        pos.x + Math.sin(yaw) * FORWARD,
        pos.y + 1.3,
        pos.z + Math.cos(yaw) * FORWARD);
      group.rotation.y = yaw;
    },
    hide() { group.visible = false; },
  };
}

let driveGhost = null;

function addLocalPlayer(id, lo) {
  player = match.addTank({
    id, hull: lo.hull, weapon: lo.weapon,
    // Our own tank is always cyan regardless of hull, so you can find yourself
    // in a fight; everyone else is drawn in their hull's colour.
    name: lo.name, color: 0x4cc9f0, isPlayer: true,
  });
  return player;
}

const allTanks = () => [...match.tanks.values()];

function startOffline(lo) {
  addLocalPlayer(0, lo);
  BOT_SETUPS.forEach((cfg, i) => {
    const t = match.addTank({
      id: i + 1, hull: cfg.hull, weapon: cfg.weapon,
      name: cfg.name, color: HULLS[cfg.hull].color,
    });
    bots.push({ tank: t, brain: new BotBrain(t, { skill: cfg.skill, seed: i / 5 }) });
  });
  updateWeaponHud();
}

// ── Online ──────────────────────────────────────────────────────────────────
function startOnline(lo, status) {
  net = new NetClient({
    url: SERVER_URL,
    match,
    lagMs: Number(new URLSearchParams(location.search).get('lag') ?? 0),
    loadout: lo,

    onWelcome: (msg) => {
      // Our own tank, plus everyone already in the match.
      for (const p of msg.players) {
        const isMe = p.id === msg.id;
        const tank = match.addTank({
          id: p.id, hull: p.hull, weapon: p.weapon,
          name: isMe ? 'You' : p.name,
          color: isMe ? 0x4cc9f0 : HULLS[p.hull].color,
          isPlayer: isMe,
        });
        if (isMe) player = tank;
      }
      if (!player) player = addLocalPlayer(msg.id, lo);
      updateWeaponHud();
      feed(`connected — ${msg.players.length} in match`, '#7ee787');
    },

    onJoin: (msg) => {
      if (match.tanks.has(msg.id)) return;
      match.addTank({
        id: msg.id, hull: msg.hull, weapon: msg.weapon,
        name: msg.name, color: HULLS[msg.hull].color,
      });
      feed(`${msg.name} joined`, '#7ee787');
    },

    onLeave: (msg) => {
      const t = match.tanks.get(msg.id);
      if (t) feed(`${t.name} left`, '#9aa4b2');
      match.removeTank(msg.id);
    },

    // The server owns outcomes; the client only plays them back. Effects are
    // driven from these events rather than from local hit detection, so what
    // you see is always what actually happened.
    onEvent: (e) => {
      // Somebody else fired: draw it. Our own shot is already drawn by
      // prediction, so replaying it here would double every tracer.
      if (e.e === 'fire') {
        if (e.id !== net.id) {
          combat.renderRemoteShot(
            e.w,
            new THREE.Vector3(e.ox, e.oy, e.oz),
            new THREE.Vector3(e.dx, e.dy, e.dz));
        }
        return;
      }

      const who = match.tanks.get(e.id);
      if (e.e === 'hit' && who) {
        // Deliberately draws nothing in the world. Every shot is already
        // rendered — your own by prediction, everyone else's from the `fire`
        // event — and each of those renders its own impact at the point the
        // ray or shell actually struck. Spawning a second burst here, at the
        // target's CENTRE rather than the impact point, meant one shot flashed
        // twice a metre or two apart. It read as more shooting than was
        // happening, and it was the largest single source of effect spam in a
        // firefight.
        //
        // Confirmation that damage landed is the job of the HUD hit marker,
        // which is on screen where the player is already looking.
      } else if (e.e === 'kill' && who) {
        fx.explosion(who.position, 7, 0xff8a3d);
        const killer = e.by != null ? match.tanks.get(e.by) : null;
        feed(`${killer?.name ?? '?'}  ▸  ${who.name}`,
          e.by === net.id ? '#4ade80' : who === player ? '#f87171' : '#9aa4b2');
        if (e.by === net.id) hud.kills.textContent = player?.kills ?? 0;
      }
    },
  });

  // Returned, not swallowed: the loadout screen stays up until this settles and
  // shows the reason if it does not.
  //
  // The two-minute deadline is for free hosting that suspends an idle instance.
  // Waking one takes most of a minute, and every attempt before it is ready
  // fails at once, so without the retry the first person through the door is
  // told the game is down.
  return net.connect({
    deadlineMs: 120000,
    onWaking: (secs) => status?.(`waking the server… ${secs}s (first join after a quiet spell)`),
  });
}

// Nothing exists until a loadout is chosen. `simulate` and `present` both
// already no-op while `player` is null, so the render loop can start first and
// the arena sits there behind the screen.
chooseLoadout({
  join: (lo, status) => (ONLINE ? startOnline(lo, status) : startOffline(lo)),
});


// No aim marker. Shots fly straight from the barrel, so the barrel itself is
// the aiming reference — a ring drawn at the impact point only restates what
// the gun is already showing you.

// ── Input ───────────────────────────────────────────────────────────────────
const keys = new Set();
let firing = false;
const touch = TOUCH ? createTouchControls() : null;

/**
 * Is the barrel currently on an enemy?
 *
 * One ray, from the muzzle along the aim direction, which is the same line the
 * shot itself will take — flat trajectory, no gravity, no lead. Cover is handled
 * for free: the ray stops at the first thing it meets, so a tank behind a wall
 * is not a target.
 *
 * This drives auto-fire on touch, and the fire button's highlight. It is capped
 * at the weapon's own useful range rather than at the ray's, or Twin would open
 * up at 80m where it does 14% damage and simply give the player's position away.
 */
function targetOnTheLine() {
  if (!player?.alive) return false;
  const origin = player.muzzlePosition;
  const dir = player.aimDirection();
  const reach = Math.min(80, player.weapon.falloffEnd);
  const hit = world.castRay(
    new RAPIER.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z }),
    reach, true, undefined, undefined, undefined, player.body);
  if (!hit) return false;
  const target = combat.byCollider.get(hit.collider.handle);
  return !!target && target !== player && target.alive;
}

addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyP') {
    const el = document.getElementById('perf');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  }
  if (e.code === 'KeyB') {
    bloom.enabled = !bloom.enabled;   // isolate bloom as a cost source
  }
  if (e.code === 'KeyO') {
    renderer.shadowMap.enabled = !renderer.shadowMap.enabled;
    scene.traverse((o) => { if (o.isMesh) o.material.needsUpdate = true; });
  }
  if (e.code === 'Digit1') switchWeapon('twin');
  if (e.code === 'Digit2') switchWeapon('thunder');
  if (e.code === 'Digit3') switchWeapon('rail');
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
    'KeyZ', 'KeyX', 'KeyQ', 'KeyE'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); firing = false; });

// Click-to-fire is a mouse affordance. On a phone the canvas is the whole
// screen, so any stray tap — or the thumb that just came off a stick — would
// pull the trigger.
canvas.addEventListener('pointerdown', (e) => {
  if (!TOUCH && e.button === 0) firing = true;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Releasing the mouse must ALWAYS stop the gun. `pointerup` on the window is not
// enough on its own: press on the canvas, drag outside the browser and release,
// and the event is delivered to whatever is under the cursor instead — the tank
// then fires forever with no button held. Every one of these is a way that
// press can end.
for (const ev of ['pointerup', 'pointercancel', 'blur', 'visibilitychange']) {
  addEventListener(ev, () => { firing = false; });
}
// A pointer that leaves the document entirely (out of the window) never sends
// pointerup here at all.
document.addEventListener('pointerleave', () => { firing = false; });
// Belt and braces: if no button is actually held, we are not firing.
addEventListener('pointermove', (e) => { if (e.buttons === 0) firing = false; });

function switchWeapon(key) {
  if (!player || player.weaponKey === key) return;
  player.setWeapon(key);
  updateWeaponHud();
  net?.setWeapon(key);   // the server owns the real loadout
}

document.querySelectorAll('.slot').forEach((el) => {
  el.addEventListener('click', () => switchWeapon(el.dataset.weapon));
});

// ── HUD ─────────────────────────────────────────────────────────────────────
const hud = {
  hp: document.getElementById('hp-fill'),
  hpText: document.getElementById('hp-text'),
  weapon: document.getElementById('weapon-name'),
  band: document.getElementById('weapon-band'),
  charge: document.getElementById('charge-fill'),
  chargeWrap: document.getElementById('charge'),
  kills: document.getElementById('kills'),
  feed: document.getElementById('feed'),
  slots: [...document.querySelectorAll('.slot')],
  respawn: document.getElementById('respawn'),
  hint: document.getElementById('charge-hint'),
  scoreboard: document.getElementById('scoreboard'),
};

// ── Scoreboard ──────────────────────────────────────────────────────────────
// Rebuilt from tank state rather than accumulated locally, so online it shows
// the server's numbers and offline it shows the same Match's numbers — one code
// path, and no chance of the client's tally drifting from the authority's.
let scoreboardSig = '';

function updateScoreboard() {
  const rows = allTanks()
    .map((t) => ({
      name: t.name, me: t === player,
      k: t.kills ?? 0, a: t.assists ?? 0, d: t.deaths ?? 0, sc: t.score ?? 0,
    }))
    .sort((x, y) => y.sc - x.sc || y.k - x.k || x.name.localeCompare(y.name));

  // Only touch the DOM when something actually changed — this runs every frame.
  const sig = rows.map((r) => `${r.name}:${r.sc}:${r.k}:${r.a}:${r.d}`).join('|');
  if (sig === scoreboardSig) return;
  scoreboardSig = sig;

  hud.scoreboard.innerHTML =
    '<table><thead><tr><th class="n">PLAYER</th><th>K</th><th>A</th><th>D</th><th>PTS</th></tr></thead><tbody>'
    + rows.map((r) => `<tr class="${r.me ? 'me' : ''}">`
      + `<td class="n">${escapeHtml(r.name)}</td>`
      + `<td>${r.k}</td><td>${r.a}</td><td class="dim">${r.d}</td>`
      + `<td class="sc">${r.sc}</td></tr>`).join('')
    + '</tbody></table>';
}

// Names come from other players over the network — never inject them as markup.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function updateWeaponHud() {
  if (!player) return;
  const w = player.weapon;
  hud.weapon.textContent = w.name;
  hud.band.textContent = w.band.toUpperCase();
  hud.chargeWrap.style.display = w.chargeTime ? 'block' : 'none';
  // Charge weapons are unusable until you know they need a held button — the
  // click-to-fire reflex just silently does nothing.
  hud.hint.style.display = w.chargeTime ? 'block' : 'none';
  if (w.chargeTime) hud.hint.textContent = `HOLD FIRE ${w.chargeTime.toFixed(1)}s TO CHARGE`;
  hud.slots.forEach((el) => el.classList.toggle('active', el.dataset.weapon === player.weaponKey));
  document.documentElement.style.setProperty('--accent', '#' + w.color.toString(16).padStart(6, '0'));
}
updateWeaponHud();

function feed(text, color = '#e6edf3') {
  const el = document.createElement('div');
  el.className = 'feed-line';
  el.style.color = color;
  el.textContent = text;
  hud.feed.prepend(el);
  setTimeout(() => el.remove(), 4200);
  while (hud.feed.children.length > 5) hud.feed.lastChild.remove();
}

combat.onKill = (victim, killer) => {
  feed(`${killer?.name ?? '?'}  ▸  ${victim.name}`,
    killer === player ? '#4ade80' : victim === player ? '#f87171' : '#9aa4b2');
  victim.deadAt = simTime;
  if (killer === player) hud.kills.textContent = player.kills;
};

// No centre-screen hit marker. It was added back when a client resolved its own
// hits and the shot you saw was not the shot the server traced, so a HUD tell
// was the only trustworthy confirmation. Both ends now describe the same shot,
// and the shell's own impact lands on the enemy where it visibly hit — the
// marker was a second, worse copy of information already on screen, parked in
// the middle of the view.

// ── Camera ──────────────────────────────────────────────────────────────────
// ── Third-person spring arm ─────────────────────────────────────────────────
const CAM_DIST = 11.5;    // horizontal reach at full extension
const CAM_RISE = 5.0;     // height above the pivot at full extension
const CAM_LEN = Math.hypot(CAM_DIST, CAM_RISE);
const CAM_BASE_ELEV = Math.atan2(CAM_RISE, CAM_DIST);
// The camera looks at a point above the tank, not at the tank, so the view is
// weighted toward what is ahead. On a phone held sideways the window is ~360px
// tall and the bottom strip is HUD, and that offset pushed the player's own
// tank down behind it — you drove an arena you could see with a tank you could
// not. Looking lower lifts it back into frame.
const CAM_PIVOT_Y = TOUCH ? 0.9 : 2.2;

// Player-controlled pitch (Q/E). Low sits near the deck for reading sight lines
// down a lane; high looks down for spatial awareness in a scrum.
const CAM_ELEV_MIN = 0.10;   // ~6°
const CAM_ELEV_MAX = 1.20;   // ~69°
const CAM_ELEV_RATE = 0.9;   // rad/s
let camElevWanted = CAM_BASE_ELEV;

const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3(0, 24, -26);
const camPivot = new THREE.Vector3();
let camYaw = 0;
let camBoom = CAM_LEN;
let camElev = CAM_BASE_ELEV;

function updateCamera(dt) {
  if (!player) return;
  const p = player.position;

  // Pitch input lives here rather than in the frame loop: it is presentation,
  // and it belongs on the same clock as the camera it drives.
  const pitchInput = (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0)
    + (touch ? touch.state.pitch : 0);
  if (pitchInput) {
    camElevWanted = THREE.MathUtils.clamp(
      camElevWanted + pitchInput * CAM_ELEV_RATE * dt, CAM_ELEV_MIN, CAM_ELEV_MAX);
  }

  // The camera trails the TURRET, not the hull — you look where the gun looks,
  // so the hull can drive sideways or reverse without swinging the view.
  const q = new THREE.Quaternion();
  player.turret.getWorldQuaternion(q);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const targetYaw = Math.atan2(fwd.x, fwd.z);

  // Smoothed on the shortest arc. Aim is raycast from this camera and the
  // turret chases that aim, so the two form a feedback loop — the camera has to
  // converge slower than the turret or the view oscillates around the target.
  let d = targetYaw - camYaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  camYaw += d * (1 - Math.exp(-4.5 * dt));

  // Smooth the *inputs* — pivot and yaw — then apply collision to the result.
  // Smoothing after the collision clamp would let the camera drift back into
  // whatever it was just pushed out of.
  const pivotGoal = p.clone().setY(p.y + CAM_PIVOT_Y);
  camPivot.lerp(pivotGoal, 1 - Math.exp(-9 * dt));

  const back = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw));

  // The camera does NOT climb over cover, and does not pull in against it.
  //
  // It used to do both: sphere-sweep a fan of steeper angles and take whichever
  // bought the most distance. It kept the camera out of walls, and it cost the
  // player the fight. Backing against cover — which is where you spend a duel —
  // swung the view up into a top-down shot, and from up there the tank shooting
  // at you is off the bottom of the screen. Playtest, two humans: "it hides the
  // attacker."
  //
  // Framing now stays exactly where the player put it, and the wall in the way
  // is faded out instead (see fadeOccluders). Moving the camera to solve an
  // occlusion problem moves the picture; making the occluder transparent solves
  // it and leaves the picture alone.
  camElev += (camElevWanted - camElev) * (1 - Math.exp(-6 * dt));
  camBoom += (CAM_LEN - camBoom) * (1 - Math.exp(-6 * dt));

  const dir = back.clone().multiplyScalar(Math.cos(camElev)).setY(Math.sin(camElev)).normalize();
  camPos.copy(camPivot).addScaledVector(dir, camBoom);
  camPos.y = Math.max(camPos.y, 0.8);   // never dip through the floor

  camTarget.lerp(camPivot, 1 - Math.exp(-14 * dt));
  camera.position.copy(camPos);
  camera.lookAt(camTarget);

  fadeOccluders(dt);
}

// ── See-through cover ───────────────────────────────────────────────────────
// Fade any arena block sitting between the camera and the player.
//
// Two details decide whether this works at all:
//
// The blocks SHARE one material. Setting opacity on the mesh's material would
// dissolve the entire arena at once, so each block that has ever been faded
// gets its own clone, made lazily and cached on the mesh. Typically one or two
// blocks are involved at a time, so this stays small.
//
// The ray is cast from the PLAYER outwards, not from the camera. Three's
// raycaster obeys `material.side`, and these boxes are FrontSide — so a camera
// that has ended up inside a wall sees only back faces and detects nothing,
// which is exactly the case that matters most. From the player's side the wall
// presents its front face and is found normally.
const GHOST_OPACITY = 0.16;
const GHOST_FADE = 7;             // per second
const occRay = new THREE.Raycaster();
const fading = new Map();         // mesh -> current opacity

function ghostMaterialFor(mesh) {
  if (!mesh.userData.ghostMat) {
    const ghost = mesh.material.clone();
    ghost.transparent = true;
    ghost.depthWrite = false;     // so it never occludes what it is revealing
    // Emissive surfaces do not dim with opacity — they keep adding light. The
    // centre structure's trim band is emissive teal, and ghosting it purely by
    // alpha left a glowing wash across the bottom of the screen that was harder
    // to see past than the solid wall had been. A ghost does not glow.
    if (ghost.emissive) ghost.emissiveIntensity = 0;
    mesh.userData.solidMat = mesh.material;
    mesh.userData.ghostMat = ghost;
  }
  return mesh.userData.ghostMat;
}

function fadeOccluders(dt) {
  const blocks = match.arena?.statics;
  if (!blocks?.length) return;

  const toCam = new THREE.Vector3().subVectors(camera.position, camPivot);
  const dist = toCam.length();
  occRay.set(camPivot, toCam.normalize());
  occRay.far = dist;

  const blocking = new Set();
  for (const h of occRay.intersectObjects(blocks, false)) blocking.add(h.object);

  // Anything blocking fades toward transparent; everything previously faded
  // fades back and is handed its shared material once it is solid again.
  for (const mesh of blocking) if (!fading.has(mesh)) fading.set(mesh, 1);

  for (const [mesh, current] of fading) {
    const target = blocking.has(mesh) ? GHOST_OPACITY : 1;
    const next = current + (target - current) * (1 - Math.exp(-GHOST_FADE * dt));
    if (target === 1 && next > 0.985) {
      mesh.material = mesh.userData.solidMat;
      fading.delete(mesh);
      continue;
    }
    const ghost = ghostMaterialFor(mesh);
    ghost.opacity = next;
    mesh.material = ghost;
    fading.set(mesh, next);
  }
}

// ── Simulation ──────────────────────────────────────────────────────────────
// Deliberately free of camera, HUD and renderer references. Everything that
// decides a match outcome happens in here, so this exact function is what the
// headless balance sim will drive with no renderer attached.
function simulate(dt, playerInput) {
  if (!player) return;

  if (ONLINE) {
    // Online, this client is not authoritative over anything. It predicts its
    // own tank forward and lets interpolation place everyone else; the server
    // owns the outcome and corrects us on every snapshot.
    net?.predict(playerInput);
    combat.update(dt);
    world.step();
    return;
  }

  const inputs = new Map();
  inputs.set(player.netId, playerInput);
  for (const b of bots) {
    inputs.set(b.tank.netId,
      b.brain.think(dt, { world, RAPIER, tanks: allTanks(), combat }));
  }
  match.step(inputs);
  match.events.length = 0;   // offline nobody consumes these
  simTime += dt;
}

// ── Loop ────────────────────────────────────────────────────────────────────
let last = performance.now();
const FIXED = 1 / 60;
const RESPAWN_DELAY = 2.6;
let accumulator = 0;
let simTime = 0;

/**
 * Hide a tank's nameplate when the tank itself cannot be seen.
 *
 * Nameplates draw with depthTest:false so they are never clipped by the tank's
 * own geometry — but that also punches them straight through walls. Several
 * bots behind the same block then render their labels stacked on the near face
 * of it, which reads exactly like "all the bots are inside the wall in one
 * spot". They were up to 42m apart and moving normally.
 */
const plateRay = new THREE.Vector3();

function updateNameplates() {
  for (const t of allTanks()) {
    if (!t.plate || t === player) continue;
    if (!t.alive) { t.plate.visible = false; t.hpBar.visible = false; continue; }

    const head = t.position;
    head.y += 1.2;
    plateRay.copy(head).sub(camera.position);
    const dist = plateRay.length();
    plateRay.divideScalar(dist);

    const hit = world.castRay(
      new RAPIER.Ray(
        { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        { x: plateRay.x, y: plateRay.y, z: plateRay.z }),
      dist - 1.2, true, undefined, undefined, undefined, t.body);

    // Visible only with a clear line, and only within a readable distance.
    const show = !hit && dist < 90;
    t.plate.visible = show;
    t.hpBar.visible = show;
  }
}

// ── Frame budget ────────────────────────────────────────────────────────────
// Full-screen bloom at devicePixelRatio 2 means a 2560x1440 drawing buffer and
// ten extra blur passes over it. That is the single most expensive thing here
// and it scales with the square of the resolution, so resolution is the dial
// worth turning automatically.
const perfEl = document.getElementById('perf');
let frameAvg = 16.7;
let quality = 1;                 // multiplier on pixel ratio
// Phones report devicePixelRatio 3 or more. Rendering a bloomed 3D scene at 3x
// on a mobile GPU is hopeless, and the adaptive controller would only discover
// that after several seconds of stutter — so cap it before the first frame.
const MAX_DPR = Math.min(devicePixelRatio, TOUCH ? 1.5 : 2);
let qualityCooldown = 0;

function applyQuality() {
  renderer.setPixelRatio(MAX_DPR * quality);
  composer.setPixelRatio?.(MAX_DPR * quality);
  composer.setSize(innerWidth, innerHeight);
}

function trackFrame(ms, dt) {
  // Exponential average, plus a slow controller so it cannot oscillate.
  frameAvg += (ms - frameAvg) * 0.1;
  qualityCooldown -= dt;
  // `ms` is WORK per frame, not the frame interval — rAF's wait for vsync is not
  // in it. So the number to stay under is the 16.7ms budget of a 60Hz display,
  // and the old thresholds did not: they only reduced quality above 20ms, which
  // let the game park at 14-19ms indefinitely. That band cannot hold 60fps and
  // is exactly what "it doesn't drive smoothly, it catches sometimes" feels
  // like — frames being dropped steadily, never badly enough to trigger a
  // reduction. Reported playtest values sat at 14.5-17.6ms, in the middle of it.
  //
  // 13ms leaves real headroom under the budget for a spike — an explosion, a GC
  // pause — instead of spending it all on pixels. The gap up to 8ms is wide
  // enough that the controller cannot hunt between two levels.
  if (qualityCooldown <= 0) {
    if (frameAvg > 13 && quality > 0.55) {
      quality = Math.max(0.55, quality - 0.15);
      applyQuality(); qualityCooldown = 1.5;
    } else if (frameAvg < 8 && quality < 1) {
      quality = Math.min(1, quality + 0.15);
      applyQuality(); qualityCooldown = 2.5;
    }
  }
  if (perfEl && perfEl.style.display !== 'none') {
    perfEl.textContent =
      `${(1000 / frameAvg).toFixed(0)} fps   ${frameAvg.toFixed(1)} ms   ` +
      `${(MAX_DPR * quality).toFixed(2)}x   fx ${fx.live.length}`;
  }
}

const clamp1 = (v) => Math.max(-1, Math.min(1, v));

// ── Touch driving model ─────────────────────────────────────────────────────
/**
 * The drive stick names a DIRECTION, not a throttle and a turn rate.
 *
 * The first version mapped the stick straight onto the keyboard's controls —
 * up was forward, sideways was rate of turn. Those are tank controls, and they
 * are miserable on a thumb: turning around means holding left and waiting,
 * with no way to say where you want to end up, and every correction is a
 * separate little push. It reads as the tank ignoring you.
 *
 * So the stick points somewhere in the world instead, relative to the camera —
 * push the thumb up-left and up-left is where the tank goes. The hull turns
 * toward that heading and drives once it is roughly facing it. This is what
 * the phone version of Tanki Online does, and the reason it needs no learning:
 * the stick means "there", the same as every twin-stick game on a phone.
 *
 * The conversion happens HERE, on the client, and the server still receives the
 * same `{throttle, steer}` it always has. This is a control scheme, not a
 * physics change — the tank still turns at its hull's turn rate, so a Mammoth
 * still swings like a Mammoth and nothing about balance moves.
 */
const TURN_BAND = 0.35;   // rad of misalignment that already demands full steer
const _camDir = new THREE.Vector3();

function driveTowardStick(t) {
  if (!player || t.moveMag < 0.01) {
    driveGhost?.hide();
    return { throttle: 0, steer: 0, strafe: 0 };
  }

  // A hover hull needs none of this. It can move in the direction the thumb is
  // pointing immediately, so the stick becomes a straight translation of world
  // direction into hull-space throttle and strafe — no heading to turn onto, no
  // wind-up, and no ghost, because there is nothing to preview when the tank is
  // already going where you asked.
  if (player.hull.hover) {
    driveGhost?.hide();
    camera.getWorldDirection(_camDir);
    const camYaw = Math.atan2(_camDir.x, _camDir.z);
    const wantYaw = camYaw - Math.atan2(t.moveX, -t.moveY);

    const r = player.body.rotation();
    const hullYaw = 2 * Math.atan2(r.y, r.w);
    const rel = wantYaw - hullYaw;
    return {
      throttle: t.moveMag * Math.cos(rel),
      // Screen-right is -X, and the hull's right vector is built the same way,
      // so the sideways component carries a sign flip.
      strafe: -t.moveMag * Math.sin(rel),
      steer: 0,
    };
  }

  // Built lazily: online, `player` is assigned inside onWelcome rather than by
  // addLocalPlayer, and the ghost needs the hull we actually ended up with.
  driveGhost ??= createDriveGhost(player.hull);

  // Where the thumb points, in the world. Stick-up is away from the camera,
  // which is the only mapping that stays true while the hull spins underneath.
  camera.getWorldDirection(_camDir);
  const camYaw = Math.atan2(_camDir.x, _camDir.z);
  const wantYaw = camYaw - Math.atan2(t.moveX, -t.moveY);

  const r = player.body.rotation();
  const hullYaw = 2 * Math.atan2(r.y, r.w);
  let off = wantYaw - hullYaw;
  while (off > Math.PI) off -= Math.PI * 2;
  while (off < -Math.PI) off += Math.PI * 2;

  driveGhost?.show(player.position, wantYaw);

  // Angular velocity is `-steer * turnRate`, so closing a positive offset needs
  // a negative steer.
  const strafe = 0;
  const steer = clamp1(-off / TURN_BAND);
  // Throttle falls off with misalignment, so a tank pointed 90° away pivots on
  // the spot instead of carving a long arc through the wall behind it. Past 90°
  // it is zero rather than negative: reversing would need the steering to
  // invert too, and inverted steering under the player mid-turn is exactly the
  // thing §5 refuses to do.
  const throttle = t.moveMag * Math.max(0, Math.cos(off));
  return { throttle, steer, strafe };
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const frameStart = performance.now();

  const playerInput = {
    throttle: (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0)
      - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0),
    // A/D turn a tracked hull and slide a hover one. Same keys, and on a hover
    // hull the body is following the gun anyway, so there is nothing left for
    // them to steer.
    steer: 0,
    strafe: 0,
    // Z/X drive the turret at its own traverse rate. Rate control, not a cursor
    // snap: turret speed is a real weapon stat and it should be felt.
    //
    // Z is screen-left, X is screen-right, matching where the keys sit on the
    // keyboard. Note the sign: the camera looks along +Z, so screen-right is
    // world -X, and a *positive* rotation.y swings the turret to screen-left.
    turretSteer: (keys.has('KeyZ') ? 1 : 0) - (keys.has('KeyX') ? 1 : 0),
    aimPoint: null,
    fire: firing || keys.has('Space'),
  };

  const lateral = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0)
    - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  if (player?.hull.hover) playerInput.strafe = lateral;
  else playerInput.steer = lateral;

  // Touch adds to the keyboard rather than replacing it, so a device with both
  // works and there is only ever one input struct to reason about. The sticks
  // are analogue, so clamp after summing.
  if (touch) {
    const t = touch.read();
    const drive = driveTowardStick(t);
    playerInput.throttle = clamp1(playerInput.throttle + drive.throttle);
    playerInput.steer = clamp1(playerInput.steer + drive.steer);
    playerInput.strafe = clamp1(playerInput.strafe + drive.strafe);
    playerInput.turretSteer = clamp1(playerInput.turretSteer + t.turretSteer);

    // Auto-fire. The gun goes off by itself while the barrel is on somebody.
    //
    // Not an aim-assist — nothing here moves the turret, and the shot is the
    // ordinary shot with the ordinary spread. It only removes the need to press
    // a button at an exact instant, which is the part a thumb cannot do while
    // the same hand is traversing the turret. It reads the same ray the shell
    // will fly down, so it cannot claim a hit the shot would not have taken.
    //
    // Charge weapons fall out of this correctly: holding fire is what builds a
    // Rail's charge, so staying on target winds it up and it discharges the
    // moment it is ready.
    const onTarget = targetOnTheLine();
    touch.setOnTarget(onTarget);
    if (t.fire || (t.autoFire && onTarget)) playerInput.fire = true;
  }

  // Fixed-step physics; the same step the authoritative server will run.
  accumulator += dt;
  let steps = 0;
  while (accumulator >= FIXED && steps < 4) {
    accumulator -= FIXED;
    steps++;
    simulate(FIXED, playerInput);
  }

  present(dt);
  trackFrame(performance.now() - frameStart, dt);
}

// Everything that is purely presentation. Split out so a frame can be produced
// on demand — the browser stops firing rAF entirely in a backgrounded tab.
function present(dt) {
  // Online, nothing exists until the server has welcomed us.
  if (!player) { composer.render(); return; }

  // Remote tanks are placed by interpolation, not by local physics.
  net?.interpolate();

  updateNameplates();
  for (const t of allTanks()) t.faceCamera(camera);

  updateCamera(dt);
  fx.update(dt);

  // HUD. Driven off actual tank state, not off the input handler, so any path
  // that changes the weapon (loadout screen, server-driven respawn) stays in
  // sync — not just the keyboard shortcut.
  if (hud.weapon.textContent !== player.weapon.name) updateWeaponHud();

  updateScoreboard();

  const frac = player.hp / player.maxHp;
  hud.hp.style.width = `${frac * 100}%`;
  hud.hp.style.background = frac > 0.5 ? '#4ade80' : frac > 0.25 ? '#fbbf24' : '#ef4444';
  hud.hpText.textContent = `${Math.ceil(player.hp)} / ${player.maxHp}`;
  hud.charge.style.width = `${player.charge * 100}%`;
  hud.respawn.style.display = player.alive ? 'none' : 'block';

  // Bloom is constant. It used to ramp with your own charge, on the stated
  // grounds of telegraphing the shot to enemies — which a post-process on YOUR
  // screen cannot do. It raised whole-screen bloom by 130% for the one player
  // who already knows they are charging, and the report was that charging Rail
  // is blinding. The tell belongs on the tank, where an enemy can see it; see
  // Tank.syncChargeVisual.
  bloom.strength = 0.34;

  composer.render();
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// Expose for console-driven tuning while playtesting, and for running the match
// forward without a renderer — used for balance runs and for automated checks.
window.TANKI = {
  bots, combat, world, WEAPONS, HULLS, scene, camera, renderer, composer,
  RAPIER, simulate, present, match, ONLINE, touch, targetOnTheLine, driveTowardStick,
  // Live getters: `player` and `net` are null until the server welcomes us, and
  // a plain property would freeze that null in place.
  get player() { return player; },
  get net() { return net; },
  get simTime() { return simTime; },
  /** Advance the match by `seconds` at the fixed step, ignoring wall clock. */
  runHeadless(seconds, playerInput = { throttle: 0, steer: 0, aimPoint: null, fire: false }) {
    const before = allTanks().map((t) => ({ name: t.name, kills: t.kills }));
    const steps = Math.round(seconds / FIXED);
    for (let i = 0; i < steps; i++) simulate(FIXED, playerInput);
    return allTanks().map((t, i) => ({
      name: t.name,
      weapon: t.weapon.name,
      hull: t.hull.name,
      hp: Math.round(t.hp),
      alive: t.alive,
      kills: t.kills - before[i].kills,
    }));
  },
};
if (!ONLINE) document.getElementById('loading')?.remove();
