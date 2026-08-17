// Headless netcode test: two bot-driven clients against the real server.
//
// Exercises the whole loop — connect, send inputs at 60Hz, receive snapshots,
// reconcile, and shoot each other — with an injectable latency so prediction
// and lag compensation are tested under conditions that actually resemble the
// internet rather than a 0ms loopback.

import WebSocket from 'ws';
import {
  C_HELLO, C_INPUT, C_PONG, S_WELCOME, S_SNAPSHOT, S_PING, packInput,
} from '../src/net/protocol.js';

const URL = process.env.URL ?? 'ws://localhost:8099/ws';
const LATENCY = Number(process.env.LATENCY ?? 60);   // ms each way
const SECONDS = Number(process.env.SECONDS ?? 12);

function delayed(fn, ms) { setTimeout(fn, ms); }

class TestClient {
  constructor(name, hull, weapon) {
    Object.assign(this, { name, hull, weapon });
    this.seq = 0; this.snaps = 0; this.acks = []; this.hp = null;
    this.events = []; this.id = null; this.tanks = 0;
  }

  connect() {
    return new Promise((resolve) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ t: C_HELLO, name: this.name, hull: this.hull, weapon: this.weapon }));
      });
      this.ws.on('message', (raw) => {
        // Simulate downstream latency.
        delayed(() => {
          const msg = JSON.parse(raw);
          if (msg.t === S_WELCOME) { this.id = msg.id; resolve(this); }
          else if (msg.t === S_PING) this.send({ t: C_PONG, ts: msg.ts });
          else if (msg.t === S_SNAPSHOT) {
            this.snaps++;
            this.tanks = msg.tanks.length;
            this.acks.push(this.seq - msg.ack);       // how far ahead we are
            this.me = msg.tanks.find((t) => t.id === this.id);
            this.foe = msg.tanks.find((t) => t.id !== this.id);
            if (this.me) this.hp = this.me.hp;
            for (const e of msg.events ?? []) this.events.push(e.e);
          }
        }, LATENCY);
      });
    });
  }

  send(obj) {
    const s = JSON.stringify(obj);
    delayed(() => { if (this.ws.readyState === 1) this.ws.send(s); }, LATENCY);
  }

  input(i) {
    this.seq++;
    this.send({ t: C_INPUT, i: packInput(this.seq, i) });
  }

  /**
   * Turret steer that tracks the opponent, computed from the SNAPSHOT — i.e.
   * from the delayed view of the world the client actually has. That is the
   * point: it aims where the enemy appeared to be, so if lag compensation is
   * wrong, the shots miss and the hit count collapses with latency.
   */
  aimSteer() {
    if (!this.me || !this.foe) return 0;
    const hullYaw = 2 * Math.atan2(this.me.qy, this.me.qw);
    const turretWorld = hullYaw + this.me.ty;
    const want = Math.atan2(this.foe.x - this.me.x, this.foe.z - this.me.z);
    let d = want - turretWorld;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    // Z is +1 (screen-left) in the game's mapping, so the sign is inverted here.
    return Math.max(-1, Math.min(1, d * 3));
  }

  /** Drive toward the opponent, roughly holding weapon range. */
  driveToward(range) {
    if (!this.me || !this.foe) return { throttle: 0, steer: 0 };
    const dx = this.foe.x - this.me.x, dz = this.foe.z - this.me.z;
    const dist = Math.hypot(dx, dz);
    const hullYaw = 2 * Math.atan2(this.me.qy, this.me.qw);
    let d = Math.atan2(dx, dz) - hullYaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    // Circle rather than park: two bots that converge and stop will sit behind
    // whatever cover happens to be between them for the whole test.
    const orbit = Math.sin(Date.now() / 1700) * 0.9;
    return {
      throttle: dist > range ? 1 : dist < range * 0.6 ? -1 : 0.6,
      steer: Math.max(-1, Math.min(1, -d * 2 + orbit)),
    };
  }
}

const a = new TestClient('AlphaBot', 'wasp', 'twin');
const b = new TestClient('BetaBot', 'mammoth', 'twin');
await a.connect();
await b.connect();
console.log(`connected: ${a.name}=#${a.id}  ${b.name}=#${b.id}  latency ${LATENCY}ms each way`);

// Drive both clients at the real tick rate, turning and firing constantly.
let t = 0;
const timer = setInterval(() => {
  t += 1 / 60;
  for (const c of [a, b]) {
    const drive = c.driveToward(12);
    c.input({ throttle: drive.throttle, steer: drive.steer, turretSteer: c.aimSteer(), fire: true });
  }
}, 1000 / 60);

await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(timer);

const avg = (xs) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);

if (a.me && a.foe) {
  const dist = Math.hypot(a.foe.x - a.me.x, a.foe.z - a.me.z);
  const hullYaw = 2 * Math.atan2(a.me.qy, a.me.qw);
  let aimErr = Math.atan2(a.foe.x - a.me.x, a.foe.z - a.me.z) - (hullYaw + a.me.ty);
  while (aimErr > Math.PI) aimErr -= Math.PI * 2;
  while (aimErr < -Math.PI) aimErr += Math.PI * 2;
  console.log(`\ngeometry: distance ${dist.toFixed(1)}m   ` +
    `A pos (${a.me.x.toFixed(1)}, ${a.me.z.toFixed(1)})   B pos (${a.foe.x.toFixed(1)}, ${a.foe.z.toFixed(1)})`);
  console.log(`          A turret error off target: ${(aimErr * 180 / Math.PI).toFixed(1)}°   ` +
    `A cooldown ${a.me.cd}  alive ${a.me.a}`);
}
for (const c of [a, b]) {
  const counts = c.events.reduce((m, e) => (m[e] = (m[e] || 0) + 1, m), {});
  console.log(
    `\n${c.name} (#${c.id})\n` +
    `  snapshots received : ${c.snaps}  (~${(c.snaps / SECONDS).toFixed(1)}/s)\n` +
    `  inputs sent        : ${c.seq}  (~${(c.seq / SECONDS).toFixed(0)}/s)\n` +
    `  unacked inputs     : avg ${avg(c.acks).toFixed(1)}  max ${Math.max(...c.acks)}\n` +
    `  tanks in snapshot  : ${c.tanks}\n` +
    `  hp now             : ${c.hp}\n` +
    `  events             : ${JSON.stringify(counts)}`);
}

a.ws.close(); b.ws.close();
process.exit(0);
