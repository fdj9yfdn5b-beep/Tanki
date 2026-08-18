/**
 * How many shots does a client DRAW for each shot the server actually fires?
 *
 * It should be exactly one. Playtest 3 reported a stream of shells a couple of
 * metres apart where one was fired, which is this ratio being far above 1.
 *
 * The cause is in reconciliation. `applyTankState` restores the server's
 * cooldown, and a snapshot in flight normally predates the server seeing the
 * shot the client just fired — so it reports cooldown 0. Replaying the pending
 * inputs then advanced movement but NOT firing, leaving the cooldown at 0, and
 * the next predict() fired again. Once per snapshot, against a real fire rate of
 * 2.3/s. Every extra was visualOnly and so could never do damage, which made the
 * same bug read as "my shots do nothing" as well as "too many shots".
 *
 * Runs two real Match instances — one as the server, one as the client, with
 * the real NetClient between them and inputs and snapshots delayed both ways.
 * No sockets, so it is deterministic and needs nothing running. Nothing here
 * depends on aiming or hit detection, which is where every previous headless
 * fixture for this netcode went wrong.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { Match, TICK_DT } from '../src/match.js';
import { NetClient } from '../src/net/client.js';

await RAPIER.init();

const LAG_TICKS = Number(process.env.LAG_TICKS ?? 6);      // ~100ms each way
const SNAP_EVERY = Number(process.env.SNAP_EVERY ?? 3);    // 20Hz
const TICKS = Number(process.env.TICKS ?? 900);            // 15s
const ID = 1;

function build() {
  const m = new Match({ RAPIER, scene: null, worldSeed: 20250812 });
  m.addTank({ id: ID, hull: 'hunter', weapon: 'twin', name: 'P', color: 0x44aaff });
  return m;
}

const server = build();
const client = build();

let resolved = 0, drawn = 0;
server.combat.onFire = () => resolved++;
client.combat.onFire = () => drawn++;

// The real client, with the socket stubbed out.
const net = new NetClient({ url: '', match: client, loadout: {} });
net.connected = true;
net.id = ID;
net._send = () => {};

// Drive as well as fire. A stationary tank hides the thing a player actually
// feels: reconciliation snapping the hull back after the prediction and the
// server disagree. Steering reverses periodically so the test covers turning,
// which is where a mispredicted contact with the arena shows up.
const DRIVE = process.env.DRIVE !== '0';
function inputAt(tick) {
  return {
    throttle: DRIVE ? 1 : 0,
    // STEER=square reproduces what a player does — hold the key, let go — which
    // is a discontinuity the smooth sine never produces. "Turn right and stop"
    // is the reported case, and a continuous input cannot exercise it.
    steer: DRIVE ? (process.env.STEER === 'square'
      ? (Math.floor(tick / 45) % 2 ? 0 : 1)
      : Math.sin(tick / 90)) : 0,
    turretSteer: 0,
    aimPoint: null,
    fire: true,
  };
}

const toServer = [];    // inputs in flight
const toClient = [];    // snapshots in flight
let lastAck = 0;
const drawnAt = [];     // tick of each client-drawn shot, for the spacing report

const corrections = [];
const yawErrors = [];
const yawOf = (m) => { const r = m.tanks.get(ID).body.rotation(); return 2 * Math.atan2(r.y, r.w); };

for (let t = 0; t < TICKS; t++) {
  // ── client ────────────────────────────────────────────────────────────────
  const input = inputAt(t);
  const before = drawn;
  net.predict(input);
  client.combat.update(TICK_DT);
  client.world.step();
  if (drawn > before) drawnAt.push(t);
  toServer.push({ seq: net.seq, input: { ...input }, arrives: t + LAG_TICKS });

  // ── server ────────────────────────────────────────────────────────────────
  // One input per tick, exactly as stepOnce does; reuse the last one when the
  // queue has not caught up.
  const ready = toServer.findIndex((q) => q.arrives <= t);
  let current = null;
  if (ready >= 0) {
    current = toServer.splice(ready, 1)[0];
    lastAck = current.seq;
  }
  server.step(new Map(current ? [[ID, current.input]] : []));
  server.events.length = 0;

  if (t % SNAP_EVERY === 0) {
    const snap = server.snapshot();
    toClient.push({ snap: { ...snap, ack: lastAck, events: [] }, arrives: t + LAG_TICKS });
  }

  // ── snapshots arriving back ───────────────────────────────────────────────
  while (toClient.length && toClient[0].arrives <= t) {
    const { snap } = toClient.shift();
    // Rotational snap, measured the same way `lastCorrection` measures the
    // positional one: how far reconciliation MOVES the hull, not how far the
    // client is from the server. The client legitimately predicts ahead by its
    // latency, so a standing difference is expected and means nothing — the
    // first version of this measured that and reported a healthy build as 9°
    // out. What a player feels is the correction itself.
    const yawBefore = yawOf(client);
    net._reconcile(snap);
    // How far the hull jumped when the server's answer arrived. This is what a
    // player feels as the tank not driving smoothly.
    corrections.push(net.lastCorrection);
    let dy = yawOf(client) - yawBefore;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    yawErrors.push(Math.abs(dy) * 180 / Math.PI);
  }
}

const seconds = TICKS * TICK_DT;
const gaps = drawnAt.slice(1).map((v, i) => (v - drawnAt[i]) * TICK_DT);
const median = gaps.length ? gaps.slice().sort((a, b) => a - b)[gaps.length >> 1] : 0;

console.log(`${seconds.toFixed(1)}s held on the trigger, ${LAG_TICKS} ticks of lag each way\n`);
console.log(`  shots the server fired : ${resolved}   (${(resolved / seconds).toFixed(2)}/s)`);
console.log(`  shots the client drew  : ${drawn}   (${(drawn / seconds).toFixed(2)}/s)`);
console.log(`  drawn per real shot    : ${(drawn / Math.max(1, resolved)).toFixed(2)}`);
console.log(`  median gap between drawn shots: ${median.toFixed(3)}s  (fireInterval is 0.440s)`);

const c = corrections.slice().sort((a, b) => a - b);
const at = (p) => c[Math.min(c.length - 1, Math.floor(c.length * p))] ?? 0;
console.log(`\n  reconciliation snap, ${DRIVE ? 'while driving and turning' : 'stationary'}:`);
console.log(`    median ${at(0.5).toFixed(3)}m   p95 ${at(0.95).toFixed(3)}m   worst ${at(1).toFixed(3)}m`);
console.log(`    over 0.25m: ${c.filter((v) => v > 0.25).length}/${c.length} snapshots`);
const y = yawErrors.slice().sort((a, b) => a - b);
const yAt = (p) => y[Math.min(y.length - 1, Math.floor(y.length * p))] ?? 0;
console.log(`  rotational snap applied by reconciliation:`);
console.log(`    median ${yAt(0.5).toFixed(2)}deg   p95 ${yAt(0.95).toFixed(2)}deg   worst ${yAt(1).toFixed(2)}deg`);

// A client may legitimately be one shot ahead or behind the server at any
// instant — it is predicting — so this is a tolerance, not an equality.
const ratio = drawn / Math.max(1, resolved);
const ok = ratio > 0.95 && ratio < 1.05 && median > 0.4;
console.log(`\n${ok ? 'PASS' : 'FAIL'} — one drawn shot per fired shot`);
process.exit(ok ? 0 : 1);
