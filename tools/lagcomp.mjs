// Does lag compensation actually work?
//
// The honest test is a controlled one: a shooter that holds a fixed position and
// aim, and a target that crosses its line of fire at a constant speed, on a
// stretch of open ground. Then measure hit rate as latency rises.
//
//   * lag compensation WORKING  -> hit rate roughly flat across latencies
//   * lag compensation BROKEN   -> hit rate collapses, because the shooter is
//                                  aiming at where the target was rendered,
//                                  which is where it no longer is
//
// Run the server with TANKI_DEV=1 for the placement hook.

import WebSocket from 'ws';
import {
  C_HELLO, C_INPUT, C_PONG, C_DEV_PLACE, C_DEV_AIM,
  S_WELCOME, S_SNAPSHOT, S_PING, INTERP_DELAY, packInput,
} from '../src/net/protocol.js';

const URL = process.env.URL ?? 'ws://localhost:8099/ws';
const SECONDS = Number(process.env.SECONDS ?? 26);

// Lane verified by actually firing down it in-process (tools/duelprobe-style
// check): shooter at (20,-40) facing +X, target 24m downrange at (44,-40), with
// clear ground either side for the target to cross. Picking a lane by eye failed
// three times here — the arena has scatter cover almost everywhere.
const SHOOTER = { x: 20, z: -40, yaw: Math.PI / 2 };   // faces +X
const TARGET = { x: 44, z: -40 };                      // 24m downrange
const CROSS_SPEED = 1.0;   // full speed: at ~16 m/s, 200ms of latency moves the
                           // target ~3.2m — more than a hull width, so a shot aimed
                           // at the stale position misses unless the server rewinds

class C {
  constructor(name, hull, weapon) { Object.assign(this, { name, hull, weapon }); this.seq = 0; this.ev = []; this.buf = []; }
  connect(latency) {
    this.latency = latency;
    return new Promise((res) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', () => this.ws.send(JSON.stringify(
        { t: C_HELLO, name: this.name, hull: this.hull, weapon: this.weapon })));
      this.ws.on('message', (raw) => setTimeout(() => {
        const m = JSON.parse(raw);
        if (m.t === S_WELCOME) { this.id = m.id; res(this); }
        else if (m.t === S_PING) this.send({ t: C_PONG, ts: m.ts });
        else if (m.t === S_SNAPSHOT) {
          this.me = m.tanks.find((t) => t.id === this.id);
          // Buffer with receive time so the aim can be taken from the
          // INTERPOLATED position, exactly as the real client renders it.
          m.recvAt = Date.now() / 1000;
          this.buf.push(m);
          while (this.buf.length > 40) this.buf.shift();
          for (const e of m.events ?? []) this.ev.push(e);
        }
      }, this.latency));
    });
  }
  send(o) { const s = JSON.stringify(o); setTimeout(() => { if (this.ws.readyState === 1) this.ws.send(s); }, this.latency); }
  input(i) { this.seq++; this.send({ t: C_INPUT, i: packInput(this.seq, i) }); }
  place(x, z, yaw, turret = 0) { this.send({ t: C_DEV_PLACE, x, z, yaw, turret }); }
  aim(turret) { this.send({ t: C_DEV_AIM, turret }); }

  /**
   * The turret angle that points exactly at where the SNAPSHOT says the enemy
   * is — i.e. where this client currently SEES it, which is rtt/2 + INTERP_DELAY
   * in the past.
   *
   * Set directly rather than steered. A bot trying to track a moving target with
   * a rate-limited turret mostly measures the turret, and it produced ~1 hit per
   * trial — no signal at all. Aiming exactly at the delayed position isolates the
   * one thing under test: whether the server credits a shot aimed at where the
   * shooter saw the target.
   */
  aimAtSeenFoe() {
    if (!this.me || this.buf.length < 2) return null;
    // Where the enemy is RENDERED: interpolated at now - INTERP_DELAY. Aiming at
    // the raw latest snapshot instead makes the server's rewind overshoot by a
    // full INTERP_DELAY, which reads as lag compensation making aim worse.
    const target = Date.now() / 1000 - INTERP_DELAY;
    let a = this.buf[this.buf.length - 2], b = this.buf[this.buf.length - 1];
    for (let i = this.buf.length - 1; i > 0; i--) {
      if (this.buf[i - 1].recvAt <= target && this.buf[i].recvAt >= target) {
        a = this.buf[i - 1]; b = this.buf[i]; break;
      }
    }
    const fa = a.tanks.find((t) => t.id !== this.id);
    const fb = b.tanks.find((t) => t.id !== this.id);
    if (!fa || !fb) return null;
    const span = b.recvAt - a.recvAt;
    const f = span > 1e-6 ? Math.min(1, Math.max(0, (target - a.recvAt) / span)) : 1;
    const fx = fa.x + (fb.x - fa.x) * f;
    const fz = fa.z + (fb.z - fa.z) * f;
    const hullYaw = 2 * Math.atan2(this.me.qy, this.me.qw);
    return Math.atan2(fx - this.me.x, fz - this.me.z) - hullYaw;
  }
}

async function trial(latency) {
  const shooter = new C('Shooter', 'hunter', process.env.WEAPON ?? 'twin');
  const target = new C('Target', 'wasp', 'twin');
  await shooter.connect(latency);
  await target.connect(latency);
  await sleep(300);

  // Place ONCE and let it settle. Re-placing every tick keeps respawning the
  // shooter at spawn height (y=1.5) so it never falls to resting height — the
  // muzzle sits ~1m high and every shot sails over a Wasp, whose hull is only
  // 0.85m tall. That cost four debugging rounds; the netcode was fine.
  shooter.place(SHOOTER.x, SHOOTER.z, SHOOTER.yaw, 0);
  await sleep(400);

  let shots = 0;
  const timer = setInterval(() => {
    const a = shooter.aimAtSeenFoe();
    if (a !== null) shooter.aim(a);
    shooter.input({ throttle: 0, steer: 0, turretSteer: 0, fire: true });
    shots++;

    // Target crosses the line of fire back and forth along Z. Facing +Z (yaw 0)
    // means throttle alone moves it perpendicular to the incoming fire.
    // Fast reversals: at 16 m/s a slow oscillation carries the target 45m off
    // the line and it spends almost no time in front of the gun. Flipping every
    // ~0.3s keeps it sweeping back and forth across the muzzle, which is exactly
    // the case lag compensation exists for.
    // Period ~4s. Fast reversals defeat the tracking turret entirely (it spends
    // the whole trial swinging and never settles), which measures the turret,
    // not the netcode.
    const t = Date.now() / 1000;
    const dir = Math.sin(t * 1.2) > 0 ? 1 : -1;
    target.input({ throttle: CROSS_SPEED * dir, steer: 0, turretSteer: 0, fire: false });
  }, 1000 / 60);

  target.place(TARGET.x, TARGET.z, 0, 0);
  // Deliberately NOT re-anchored during the run. Re-placing the target parks it
  // stationary on the firing line for an instant, and a hit landed at that
  // instant is latency-independent for the wrong reason — it measures the
  // teleport, not the compensation. The fast reversal keeps it in the lane on
  // its own (~5m either side), so every hit counted is a hit on a moving tank.
  const anchor = null;

  await sleep(SECONDS * 1000);
  clearInterval(timer);
  if (anchor) clearInterval(anchor);

  const hits = shooter.ev.filter((e) => e.e === 'hit' && e.by === shooter.id).length;
  shooter.ws.close(); target.ws.close();
  await sleep(250);
  return { latency, hits, shots };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('Controlled lag-compensation test');
console.log('shooter fixed, target crossing at speed, open lane\n');
console.log('  one-way   RTT     hits landed');
const results = [];
for (const l of [0, 50, 100, 200]) {
  const r = await trial(l);
  results.push(r);
  console.log(`  ${String(l).padStart(5)}ms  ${String(l * 2).padStart(4)}ms   ${String(r.hits).padStart(5)}`);
}

const base = results[0].hits || 1;
console.log('\n  retention vs 0ms baseline:');
for (const r of results) {
  console.log(`    ${String(r.latency * 2).padStart(4)}ms RTT : ${(r.hits / base * 100).toFixed(0)}%`);
}
process.exit(0);
