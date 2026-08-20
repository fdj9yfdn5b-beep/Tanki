import { WebSocketServer } from 'ws';
import { networkInterfaces } from 'node:os';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import RAPIER from '@dimforge/rapier3d-compat';
import { Match, TICK_DT, TICK_RATE } from '../src/match.js';
import {
  C_HELLO, C_INPUT, C_LOADOUT, C_PONG, C_DEV_PLACE, C_DEV_AIM,
  S_WELCOME, S_SNAPSHOT, S_JOIN, S_LEAVE, S_PING,
  SNAPSHOT_INTERVAL, INTERP_DELAY, LAG_COMP_WINDOW, MAX_INPUT_BACKLOG, unpackInput,
} from '../src/net/protocol.js';
import { HULLS, WEAPONS } from '../src/config.js';
import { BotBrain } from '../src/bots.js';
import { shotSeed } from '../src/rng.js';

const PORT = Number(process.env.PORT ?? 8099);
const DEV = process.env.TANKI_DEV === '1';
const NO_LAG_COMP = process.env.NO_LAG_COMP === '1';   // A/B switch for testing

await RAPIER.init();
const match = new Match({ RAPIER, scene: null, worldSeed: 20250812 });

const clients = new Map();   // id -> { ws, input, queue, lastAck, name, latency }
let nextId = 1;

// ── Bots ────────────────────────────────────────────────────────────────────
// Without these, the first player to join an empty server sits alone in an
// arena — which is exactly the state anyone testing multiplayer starts in.
// They run the same BotBrain as the offline game, on the authoritative side,
// so to a client they are indistinguishable from players.
const BOT_COUNT = Number(process.env.BOTS ?? 4);
const BOT_ID_BASE = 10000;   // far above nextId, so ids can never collide
const bots = [];
const roster = new Map();    // id -> { name, hull, weapon } for clients AND bots

const BOT_SETUPS = [
  { hull: 'wasp', weapon: 'twin', skill: 0.45, name: 'Messi' },
  { hull: 'hunter', weapon: 'thunder', skill: 0.6, name: 'Rihanna' },
  { hull: 'mammoth', weapon: 'rail', skill: 0.72, name: 'Musk' },
  { hull: 'hunter', weapon: 'rail', skill: 0.5, name: 'Zendaya' },
  { hull: 'wasp', weapon: 'thunder', skill: 0.55, name: 'Drake' },
  { hull: 'mammoth', weapon: 'twin', skill: 0.65, name: 'Brick' },
];

for (let i = 0; i < BOT_COUNT; i++) {
  const cfg = BOT_SETUPS[i % BOT_SETUPS.length];
  const id = BOT_ID_BASE + i;
  const tank = match.addTank({
    id, hull: cfg.hull, weapon: cfg.weapon, name: cfg.name,
  });
  bots.push({ id, tank, brain: new BotBrain(tank, { skill: cfg.skill, seed: i / BOT_SETUPS.length }) });
  roster.set(id, { id, name: cfg.name, hull: cfg.hull, weapon: cfg.weapon, bot: true });
}
if (BOT_COUNT) console.log(`spawned ${BOT_COUNT} bots: ${bots.map((b) => b.tank.name).join(', ')}`);

// ── Lag compensation history ────────────────────────────────────────────────
// Ring of past tank positions. When a client fires, it was aiming at where it
// SAW the enemy — which is INTERP_DELAY plus its own latency in the past. The
// server rewinds to that moment, resolves the shot there, and puts everything
// back. Without this you have to lead every shot by your own ping, which is
// unplayable; with it, you sometimes die a moment after reaching cover. There
// is no third option — the choice is only whether the shooter or the target
// gets the benefit of the doubt, and every shooter-favoured game picks this.
const history = [];
const HISTORY_TICKS = Math.ceil(LAG_COMP_WINDOW * TICK_RATE);

// Velocity is recorded alongside the pose because evasion spread is a function
// of how fast the target was crossing the line of fire, and the shot is
// resolved in the rewound world. Rewinding position but not velocity computes
// the sigma from how the target is moving NOW — a different number from the one
// the shooter's client derived from what it was rendering.
function recordHistory() {
  const frame = new Map();
  for (const [id, tank] of match.tanks) {
    const t = tank.body.translation();
    const r = tank.body.rotation();
    const v = tank.body.linvel();
    frame.set(id, { x: t.x, y: t.y, z: t.z, qy: r.y, qw: r.w, vx: v.x, vy: v.y, vz: v.z });
  }
  history.push({ tick: match.tick, frame });
  if (history.length > HISTORY_TICKS) history.shift();
}

function rewindTo(tick, exceptId) {
  const entry = history.find((h) => h.tick >= tick) ?? history[0];
  if (!entry) return null;
  const restore = new Map();
  for (const [id, tank] of match.tanks) {
    if (id === exceptId) continue;
    const past = entry.frame.get(id);
    if (!past) continue;
    const t = tank.body.translation();
    const r = tank.body.rotation();
    const v = tank.body.linvel();
    restore.set(id, {
      x: t.x, y: t.y, z: t.z, qy: r.y, qw: r.w, vx: v.x, vy: v.y, vz: v.z,
    });
    tank.body.setTranslation({ x: past.x, y: past.y, z: past.z }, false);
    tank.body.setRotation({ x: 0, y: past.qy, z: 0, w: past.qw }, false);
    tank.body.setLinvel({ x: past.vx, y: past.vy, z: past.vz }, false);
  }
  return restore;
}

function restoreFrom(restore) {
  if (!restore) return;
  for (const [id, s] of restore) {
    const tank = match.tanks.get(id);
    if (!tank) continue;
    tank.body.setTranslation({ x: s.x, y: s.y, z: s.z }, false);
    tank.body.setRotation({ x: 0, y: s.qy, z: 0, w: s.qw }, false);
    tank.body.setLinvel({ x: s.vx, y: s.vy, z: s.vz }, false);
  }
}

// ── HTTP + WebSocket on ONE port ────────────────────────────────────────────
// Serving the built client from the same origin as the socket is what makes
// remote play practical: one tunnel (or one deployment) exposes everything, and
// the client can derive its socket URL from the page it was loaded from. Two
// separate ports means two tunnels on two hostnames, and the client then has to
// be told the second one by hand.
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.map': 'application/json',
};

const http = createServer(async (req, res) => {
  // Health check. Hosting platforms poll this to decide whether the instance is
  // live; without it a deploy can be marked failed while the game runs fine.
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tick: match.tick, players: clients.size, bots: bots.length }));
    return;
  }

  if (!existsSync(DIST)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('No build found. Run `npm run build` first.');
    return;
  }
  try {
    const url = new URL(req.url, 'http://x');
    // normalize + prefix check: without it, `/../../etc/passwd` escapes DIST.
    let file = normalize(join(DIST, decodeURIComponent(url.pathname)));
    if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
    if (url.pathname === '/' || !extname(file)) file = join(DIST, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

const wss = new WebSocketServer({ server: http, path: '/ws' });
http.listen(PORT);
console.log(`tanki server listening on ws://localhost:${PORT}  (${TICK_RATE}Hz)` + (DEV ? '  [DEV HOOKS ON]' : ''));

if (existsSync(DIST)) {
  console.log(`  serving the built client on http://localhost:${PORT}/`);
} else {
  console.log('  (no dist/ build — run `npm run build` to serve the client from here too)');
}

// Print the LAN address so a second device knows what to open.
for (const [name, addrs] of Object.entries(networkInterfaces())) {
  for (const a of addrs ?? []) {
    if (a.family === 'IPv4' && !a.internal) {
      console.log(`  same Wi-Fi:  http://${a.address}:5178/?online=1        (${name})`);
    }
  }
}
console.log('  over the internet:  npx cloudflared tunnel --url http://localhost:' + PORT);

wss.on('connection', (ws) => {
  const id = nextId++;
  const client = {
    ws, id, queue: [], lastAck: 0, name: `P${id}`,
    hull: 'hunter', weapon: 'twin', lastInput: null,
    rtt: 0.06,          // seconds, smoothed
    rewindTicks: 0,     // derived below
  };
  updateRewind(client);
  clients.set(id, client);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handle(client, msg);
  });

  ws.on('close', () => {
    clients.delete(id);
    roster.delete(id);
    match.removeTank(id);
    broadcast({ t: S_LEAVE, id });
    console.log(`- ${client.name} left (${clients.size} online)`);
  });
});

function handle(client, msg) {
  switch (msg.t) {
    case C_HELLO: {
      client.name = String(msg.name ?? client.name).slice(0, 16);
      client.hull = HULLS[msg.hull] ? msg.hull : 'hunter';
      client.weapon = WEAPONS[msg.weapon] ? msg.weapon : 'twin';

      const tank = match.addTank({
        id: client.id, hull: client.hull, weapon: client.weapon,
        name: client.name, color: HULLS[client.hull].color,
      });

      roster.set(client.id, {
        id: client.id, name: client.name, hull: client.hull, weapon: client.weapon,
      });

      send(client, {
        t: S_WELCOME,
        id: client.id,
        tick: match.tick,
        tickRate: TICK_RATE,
        // Bots are in the roster too — a client has no reason to know or care
        // which entries are people.
        players: [...roster.values()].filter((p) => match.tanks.has(p.id)),
      });
      broadcast({
        t: S_JOIN, id: client.id, name: client.name,
        hull: client.hull, weapon: client.weapon,
      }, client.id);
      console.log(`+ ${client.name} joined as ${client.hull}/${client.weapon} (${clients.size} online)`);
      void tank;
      break;
    }

    case C_INPUT: {
      // Bounded queue. An unbounded one is a trivial memory-exhaustion vector:
      // a client that never stops sending simply grows the server's heap.
      if (client.queue.length >= MAX_INPUT_BACKLOG) client.queue.shift();
      client.queue.push(unpackInput(msg.i));
      break;
    }

    case C_PONG: {
      const sample = (Date.now() - Number(msg.ts)) / 1000;
      if (sample >= 0 && sample < 2) {
        // Smoothed: a single delayed packet should not swing where shots land.
        client.rtt += (sample - client.rtt) * 0.25;
        updateRewind(client);
      }
      break;
    }

    case C_DEV_PLACE: {
      if (!DEV) break;
      const tank = match.tanks.get(client.id);
      if (!tank) break;
      tank.respawn({ x: Number(msg.x), y: 1.5, z: Number(msg.z) });
      const yaw = Number(msg.yaw) || 0;
      tank.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
      tank.turret.rotation.y = Number(msg.turret) || 0;
      tank.turretVel = 0;
      break;
    }

    case C_DEV_AIM: {
      if (!DEV) break;
      const tank = match.tanks.get(client.id);
      if (!tank) break;
      tank.turret.rotation.y = Number(msg.turret) || 0;
      tank.turretVel = 0;
      break;
    }

    case C_LOADOUT: {
      const tank = match.tanks.get(client.id);
      if (tank && WEAPONS[msg.weapon]) {
        tank.setWeapon(msg.weapon);
        client.weapon = msg.weapon;
      }
      break;
    }
  }
}

/**
 * How far back this client's view of the world is.
 *
 * Two separate delays stack: half the round trip (how old the last snapshot was
 * when it arrived) plus INTERP_DELAY (how far in the past the client
 * deliberately renders remote tanks so it always has two snapshots to blend).
 * Rewinding by only one of them is a common and very confusing bug — shots feel
 * like they need a little lead, but not a full ping's worth.
 */
// DEV diagnostic: for each player shot, report what the shot ray sees at the
// rewound moment. Answers directly whether lag compensation is putting the
// target where the shooter aimed.
const diag = { shots: 0, sawTank: 0, sawStatic: 0, sawNothing: 0, rewind: 0, misses: [] };
function _diagShot(tank, client) {
  const origin = tank.muzzlePosition;
  const dir = tank.aimDirection();
  const hit = match.world.castRay(
    new RAPIER.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z }),
    120, true, undefined, undefined, undefined, tank.body);
  const target = hit ? match.combat.byCollider.get(hit.collider.handle) : null;
  diag.shots++;
  diag.rewind += client.rewindTicks;

  // Which input this shot was keyed to. The seed pairing is the whole reason a
  // client's tracer and the server's ray describe the same line, and it is
  // invisible from either side alone — the client cannot see which of its
  // inputs the server actually fired on, and a mismatch would look exactly like
  // the bug it fixes. `tools/shotsync.mjs` reads these lines.
  if (process.env.TANKI_SHOTLOG === '1') {
    console.log(`[shotlog] id=${tank.netId} seq=${client.lastInput?.seq}`);
  }
  if (target) diag.sawTank++;
  else if (hit) diag.sawStatic++;
  else diag.sawNothing++;

  // How far off was the nearest enemy from the shot line?
  if (!target) {
    let best = 1e9;
    for (const [id, other] of match.tanks) {
      if (id === tank.netId || !other.alive) continue;
      const rel = other.position.clone().sub(origin);
      const along = rel.dot(dir);
      if (along <= 0) continue;
      best = Math.min(best, rel.addScaledVector(dir, -along).length());
    }
    if (best < 1e8) diag.misses.push(+best.toFixed(2));
  }
}
setInterval(() => {
  if (!DEV || !diag.shots) return;
  const m = diag.misses;
  console.log(`[diag] player shots ${diag.shots} | ray saw: tank ${diag.sawTank}, wall ${diag.sawStatic}, nothing ${diag.sawNothing}` +
    ` | avg rewind ${(diag.rewind / diag.shots).toFixed(1)} ticks` +
    (m.length ? ` | miss distance med ${m.sort((a,b)=>a-b)[Math.floor(m.length/2)]}m` : ''));
  diag.shots = diag.sawTank = diag.sawStatic = diag.sawNothing = diag.rewind = 0;
  diag.misses = [];
}, 5000);

function updateRewind(client) {
  const seconds = client.rtt / 2 + INTERP_DELAY;
  client.rewindTicks = Math.min(
    HISTORY_TICKS - 1, Math.max(0, Math.round(seconds * TICK_RATE)));
}

setInterval(() => {
  const now = Date.now();
  for (const c of clients.values()) send(c, { t: S_PING, ts: now });
}, 1000);

function send(client, obj) {
  if (client.ws.readyState === 1) client.ws.send(JSON.stringify(obj));
}

function broadcast(obj, exceptId = null) {
  const payload = JSON.stringify(obj);
  for (const c of clients.values()) {
    if (c.id !== exceptId && c.ws.readyState === 1) c.ws.send(payload);
  }
}

// ── Tick loop ───────────────────────────────────────────────────────────────
let acc = 0;
let snapAcc = 0;
let last = process.hrtime.bigint();

setInterval(() => {
  const now = process.hrtime.bigint();
  const dt = Number(now - last) / 1e9;
  last = now;
  acc += dt;

  // Bound catch-up. If the process is descheduled for a second, replaying 60
  // ticks in one burst would make every client rubber-band; better to drop the
  // backlog and stay in the present.
  if (acc > 0.25) acc = 0.25;

  while (acc >= TICK_DT) {
    acc -= TICK_DT;
    stepOnce();
  }

  snapAcc += dt;
  if (snapAcc >= SNAPSHOT_INTERVAL) {
    snapAcc = 0;
    sendSnapshots();
  }
}, 4);

function stepOnce() {
  const inputs = new Map();

  for (const client of clients.values()) {
    // Exactly one input per tick. Draining the whole queue would let a client
    // that batches inputs move several times in one tick — a speed hack that
    // costs nothing to perform.
    const next = client.queue.shift();
    if (next) {
      client.lastInput = next;
      client.lastAck = next.seq;
    }
    // Reusing the last input when a packet is late is what keeps movement
    // smooth through jitter instead of stuttering to a halt.
    if (client.lastInput) inputs.set(client.id, client.lastInput);
  }

  // Bots think on the server, using the same brain as the offline game.
  const tanks = [...match.tanks.values()];
  for (const b of bots) {
    if (!match.tanks.has(b.id)) continue;
    inputs.set(b.id, b.brain.think(TICK_DT, { world: match.world, RAPIER, tanks, combat: match.combat }));
  }

  // Shots are resolved against the world as the shooter saw it: rewind the
  // other tanks, fire, put them back. Everything else about the tick — this
  // tank's own movement, its position in the update order — is untouched.
  match.step(inputs, {
    fireHook: (tank, id) => {
      const client = clients.get(id);
      const restore = (client && !NO_LAG_COMP) ? rewindTo(match.tick - client.rewindTicks, id) : null;

      // MUST refresh the query pipeline after moving bodies. Rapier only
      // rebuilds it inside world.step(), so a raycast issued right after
      // setTranslation() still sees the OLD position — verified directly: move a
      // body from x=20 to x=40 and the ray keeps reporting a hit at 18.5m until
      // this is called, then reports 38.5m.
      //
      // Without it the rewind was a no-op and lag compensation did nothing at
      // all: players aimed where they SAW an enemy while the server resolved
      // against where that enemy actually was, so shots missed by exactly the
      // distance the target moved during their latency. Server-side bots, having
      // no latency, hit normally — which is what made it look like a
      // player-only problem.
      if (restore) match.world.updateSceneQueries();

      // Same seed the client used when it predicted this exact input, so the
      // shot it drew and the shot resolved here are one shot. Bots have no
      // client mirroring them, so they keep the free-running stream.
      const didFire = match.combat.tryFire(tank, {
        seed: client?.lastInput ? shotSeed(id, client.lastInput.seq) : null,
      });

      // Diagnose only when a shot actually left the barrel, and after the fact —
      // the world is still rewound here, and aim does not change by firing.
      //
      // This used to run before tryFire, on every tick the fire key was HELD.
      // Twin fires once every 26 ticks, so `[diag] player shots` was reporting
      // roughly 26x the real number and its tank/wall/nothing ratios described
      // ticks rather than shots. The one diagnostic pointed at "do my shots
      // land" was answering a different question.
      if (DEV && client && didFire) _diagShot(tank, client);

      restoreFrom(restore);
      if (restore) match.world.updateSceneQueries();
    },
  });
  recordHistory();
}

function sendSnapshots() {
  const snap = match.snapshot();
  const events = match.events.splice(0, match.events.length);
  for (const client of clients.values()) {
    // `drops` matters as much as `tanks`. Building it in the snapshot and then
    // not forwarding it is why no crate ever appeared on a client: the server
    // was spawning and dropping them correctly the whole time, into a field
    // nobody was sending.
    send(client, {
      t: S_SNAPSHOT, tick: snap.tick, ack: client.lastAck,
      tanks: snap.tanks, drops: snap.drops, events,
    });
  }
}

// ── Keep-alive ──────────────────────────────────────────────────────────────
// Ping our own public URL so the host does not suspend us.
//
// Render's free tier suspends an idle instance, and it does NOT hold the next
// request while it restarts — it answers immediately with a 404 and
// `x-render-routing: no-server`. Measured: two 404s and then a 200, about 25
// seconds apart. So a friend clicking the link does not wait through a slow
// load, they get "Not Found" and reasonably conclude the game is down. The
// client's own connect-retry cannot help, because it only exists once the page
// has loaded.
//
// A request through the public hostname counts as inbound traffic and resets
// the idle timer. Free instances get 750 hours a month against a ~730 hour
// month, so one service staying up fits — but only one. Adding a second free
// service on the same account would exceed the allowance.
//
// Silent no-op anywhere else: RENDER_EXTERNAL_URL only exists on Render.
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  const KEEP_ALIVE_MIN = 10;   // comfortably inside Render's ~15 minute idle cut
  console.log(`keep-alive: pinging ${SELF_URL}/healthz every ${KEEP_ALIVE_MIN}m`);
  setInterval(() => {
    fetch(`${SELF_URL}/healthz`, { signal: AbortSignal.timeout(20000) })
      .catch((err) => console.log(`keep-alive ping failed: ${err.message}`));
  }, KEEP_ALIVE_MIN * 60 * 1000).unref?.();
}

// ── Shutdown ────────────────────────────────────────────────────────────────
// Platforms send SIGTERM on redeploy and SIGKILL some seconds later. Closing
// sockets deliberately lets clients see a clean disconnect instead of hanging
// until their own timeout fires.
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    console.log(`\n${sig} — closing ${clients.size} connection(s)`);
    for (const c of clients.values()) { try { c.ws.close(1001, 'server restarting'); } catch {} }
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
