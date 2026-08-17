import { TICK_DT } from '../match.js';
import { shotSeed } from '../rng.js';
import {
  C_HELLO, C_INPUT, C_LOADOUT, C_PONG,
  S_WELCOME, S_SNAPSHOT, S_JOIN, S_LEAVE, S_PING,
  INTERP_DELAY, packInput,
} from './protocol.js';

// Metres of movement between two snapshots that can only be a teleport. The
// fastest hull does 16 m/s and snapshots are ~50ms apart, so about 0.8m is the
// physical maximum; anything past a few metres is a respawn.
const TELEPORT_JUMP = 6;

/**
 * Client-side netcode: prediction, reconciliation, interpolation.
 *
 * The three jobs, and why each exists:
 *
 *   PREDICTION      Your own tank moves the instant you press a key, because
 *                   the client runs the same simulation locally rather than
 *                   waiting for the server. Without it every input costs a full
 *                   round trip before anything happens on screen.
 *
 *   RECONCILIATION  The server's answer describes a moment already in the past.
 *                   We snap our tank to that authoritative state and then
 *                   replay every input the server has not acknowledged yet. If
 *                   the prediction was right this lands exactly where we
 *                   already were and nothing is visible; if it was wrong (a
 *                   wall we did not predict, a shell that shoved us) the
 *                   correction appears as a small jump.
 *
 *   INTERPOLATION   Other players arrive at 20Hz but we draw at 60+. We render
 *                   them INTERP_DELAY in the past and blend between the two
 *                   snapshots that bracket that time, so they glide instead of
 *                   teleporting four times a second.
 */
export class NetClient {
  constructor({ url, match, loadout, onJoin, onLeave, onEvent, onWelcome, lagMs = 0 }) {
    // Dev-only artificial latency, both directions (?lag=N). Testing netcode
    // against a loopback server measures nothing — and every headless test
    // client written for this ended up unfaithful in some way (stale turret
    // angles, no line-of-sight check). Injecting delay into the REAL client
    // keeps prediction, reconciliation and interpolation exactly as they ship.
    this.lagMs = lagMs;
    this.match = match;
    this.url = url;
    this.loadout = loadout;
    this.onJoin = onJoin; this.onLeave = onLeave;
    this.onEvent = onEvent; this.onWelcome = onWelcome;

    this.id = null;
    this.connected = false;
    this.seq = 0;
    this.pending = [];        // inputs sent but not yet acknowledged
    this.snapshots = [];      // recent server states, for interpolation
    this.rtt = 0;
    this.lastCorrection = 0;  // metres of the last reconciliation snap
    this.serverTimeOffset = 0;
  }

  /**
   * Connect, retrying until `deadlineMs` has passed.
   *
   * A single 5s attempt is right for a server that is already running and wrong
   * for a free host that suspends the instance when idle: the first request has
   * to start a container, which takes the better part of a minute, and the
   * attempts before it is ready fail *immediately* rather than hanging. Giving
   * up on the first error means a friend clicking the link is told the game is
   * down when it is merely asleep.
   *
   * `onWaking` is called with the seconds elapsed so the screen can say what is
   * happening — a minute of silence is indistinguishable from a broken link.
   */
  async connect({ deadlineMs = 0, onWaking = null } = {}) {
    const started = Date.now();
    let first = null;
    for (;;) {
      try {
        return await this._openOnce(8000);
      } catch (err) {
        first ??= err;
        if (Date.now() - started >= deadlineMs) throw first;
        onWaking?.(Math.round((Date.now() - started) / 1000));
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
  }

  _openOnce(timeoutMs) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* already gone */ }
        reject(new Error('connect timeout'));
      }, timeoutMs);

      ws.onopen = () => {
        clearTimeout(timer);
        this.connected = true;
        this._send({ t: C_HELLO, ...this.loadout });
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('connect failed')); };
      ws.onclose = () => { this.connected = false; };
      ws.onmessage = (ev) => {
        const deliver = () => {
          const msg = JSON.parse(ev.data);
          if (msg.t === S_WELCOME) { this._welcome(msg); resolve(this); }
          else this._handle(msg);
        };
        if (this.lagMs) setTimeout(deliver, this.lagMs); else deliver();
      };
    });
  }

  _welcome(msg) {
    this.id = msg.id;
    this.onWelcome?.(msg);
  }

  _handle(msg) {
    switch (msg.t) {
      case S_SNAPSHOT: this._snapshot(msg); break;
      case S_JOIN: this.onJoin?.(msg); break;
      case S_LEAVE: this.onLeave?.(msg); break;
      case S_PING: this._send({ t: C_PONG, ts: msg.ts }); break;
    }
  }

  _snapshot(snap) {
    snap.recvAt = performance.now() / 1000;
    this.snapshots.push(snap);
    // Two seconds of history is far more than interpolation needs, but it is
    // the cheapest possible guard against a stall leaving nothing to blend.
    while (this.snapshots.length > 40) this.snapshots.shift();

    // Scores are discrete counters, not interpolated quantities — apply them
    // for EVERY tank on every snapshot.
    //
    // This was the scoreboard bug: reconciliation only restores the local
    // player's tank, and interpolate() copies position/hp for remote tanks but
    // not their counters. So kills by anyone else never reached the client and
    // the board sat at zero while the server happily tallied away.
    for (const s of snap.tanks) {
      const tank = this.match.tanks.get(s.id);
      if (!tank || s.k === undefined) continue;
      tank.kills = s.k; tank.assists = s.as; tank.deaths = s.de; tank.score = s.sc;
    }

    for (const e of snap.events ?? []) this.onEvent?.(e);
    this._reconcile(snap);
  }

  // ── Prediction ────────────────────────────────────────────────────────────
  /** Send an input, and immediately simulate it locally. */
  predict(input) {
    if (!this.connected || this.id == null) return;

    this.seq++;
    this._send({ t: C_INPUT, i: packInput(this.seq, input) });
    this.pending.push({ seq: this.seq, input });
    if (this.pending.length > 240) this.pending.shift();

    // Step ONLY our own tank. Remote tanks are driven by interpolation, and
    // predicting them would fight the snapshots rather than help.
    const me = this.match.tanks.get(this.id);
    if (!me) return;
    me.update(TICK_DT, input, null);
    // visualOnly: the shot is drawn instantly so the gun feels responsive, but
    // the server decides whether it hit. Resolving damage here as well made
    // every hit flash and then vanish on the next snapshot.
    //
    // The seed is what makes the drawn shot and the resolved shot the same
    // shot. The server keys off the same (id, seq) when it processes this input,
    // so both ends spread the shot by an identical angle instead of rolling
    // their own — otherwise the tracer is honest about the aim and lies about
    // the outcome.
    if (input.fire) {
      this.match.combat.tryFire(me, {
        visualOnly: true, seed: shotSeed(this.id, this.seq),
      });
    }
  }

  // ── Reconciliation ────────────────────────────────────────────────────────
  _reconcile(snap) {
    const me = this.match.tanks.get(this.id);
    if (!me) return;
    const mine = snap.tanks.find((t) => t.id === this.id);
    if (!mine) return;

    const before = me.position.clone();

    // Rewind to the authoritative state...
    this.match.applyTankState(this.id, mine);

    // ...and replay everything the server had not seen when it sent this.
    this.pending = this.pending.filter((p) => p.seq > snap.ack);
    for (const p of this.pending) {
      me.update(TICK_DT, p.input, null);

      // Replay the shot's effect on our own tank — cooldown, charge, recoil —
      // but draw nothing. `dryFire` exists for exactly this.
      //
      // Skipping it entirely, which is what this did, is what made the gun
      // appear to fire in bursts. `applyTankState` above restores the SERVER's
      // cooldown, and a snapshot in flight usually predates the server seeing
      // the shot we just fired, so it says "cooldown 0". Replaying movement but
      // not firing left it at 0, and the very next predict() fired again — once
      // per snapshot, ~20 times a second against a real fire rate of 2.3, until
      // the server's own cooldown finally showed up in a snapshot. Hence a
      // stream of shells a couple of metres apart where one was fired.
      //
      // Every one of those extras was visualOnly, so none of them could ever do
      // damage: the same bug was also making most of what the player saw
      // unhittable by construction.
      //
      // It matters for aim as well as for looks. The server keys a shot's
      // spread to the input it fired on; if the client fires on a different
      // input it derives a different seed, and the two ends stop describing the
      // same shot — undoing the fix in rng.js. Running the same cooldown state
      // machine over the same inputs is what keeps them choosing the same one.
      if (p.input.fire) this.match.combat.tryFire(me, { dryFire: true });

      this.match.world.step();
    }

    this.lastCorrection = before.distanceTo(me.position);
  }

  // ── Interpolation ─────────────────────────────────────────────────────────
  /**
   * Position every remote tank at `now - INTERP_DELAY`, blending the two
   * snapshots that bracket it.
   */
  interpolate() {
    const target = performance.now() / 1000 - INTERP_DELAY;
    if (this.snapshots.length < 2) return;

    let a = null, b = null;
    for (let i = this.snapshots.length - 1; i > 0; i--) {
      if (this.snapshots[i - 1].recvAt <= target && this.snapshots[i].recvAt >= target) {
        a = this.snapshots[i - 1]; b = this.snapshots[i];
        break;
      }
    }
    // Running behind the buffer (a stall, or a very late packet): hold on the
    // newest pair rather than freezing or extrapolating into a wall.
    if (!a) { a = this.snapshots[this.snapshots.length - 2]; b = this.snapshots[this.snapshots.length - 1]; }

    const span = b.recvAt - a.recvAt;
    const f = span > 1e-6 ? Math.min(1, Math.max(0, (target - a.recvAt) / span)) : 1;

    for (const sb of b.tanks) {
      if (sb.id === this.id) continue;             // ours is predicted, not interpolated
      const tank = this.match.tanks.get(sb.id);
      if (!tank) continue;
      const sa = a.tanks.find((t) => t.id === sb.id) ?? sb;

      // A respawn TELEPORTS the tank. Blending across that draws it streaking
      // over the map from where it died to where it came back, which is the
      // "tanks blink or shoot off to a new place when they die" report. No tank
      // covers this distance in one snapshot under its own power, so a jump
      // this large is by definition a teleport and must be snapped, not blended.
      const jumped = Math.abs(sb.x - sa.x) > TELEPORT_JUMP
        || Math.abs(sb.z - sa.z) > TELEPORT_JUMP;
      const g = jumped ? 1 : f;

      tank.body.setTranslation({
        x: lerp(sa.x, sb.x, g), y: lerp(sa.y, sb.y, g), z: lerp(sa.z, sb.z, g),
      }, false);
      tank.body.setRotation(slerpY(sa, sb, jumped ? 1 : f), false);
      tank.turret.rotation.y = lerpAngle(sa.ty, sb.ty, f);

      // Velocity for evasion spread, differentiated from the snapshot pair
      // rather than read off the physics body — see `_evasionSpread`. Timed by
      // tick delta, not by arrival times, which carry all the network jitter.
      const dt = (b.tick - a.tick) * TICK_DT;
      tank.netVel = dt > 1e-6
        ? { x: (sb.x - sa.x) / dt, y: (sb.y - sa.y) / dt, z: (sb.z - sa.z) / dt }
        : { x: 0, y: 0, z: 0 };

      tank.hp = sb.hp;
      const wasAlive = tank.alive;
      tank.alive = !!sb.a;
      // Dead tanks are hidden outright rather than left lying on the field: the
      // corpse has no collider any more (see Tank.takeDamage), so leaving the
      // mesh there shows something you can shoot through. Coming back, both
      // poses are reset onto the new spot so the renderer does not interpolate
      // in from where it died.
      tank.root.visible = tank.alive;
      if (tank.alive && !wasAlive) { tank.syncTransform(); tank.capturePose?.(); tank.capturePose?.(); }
      // Charge is in every snapshot but was being dropped here, and the ring is
      // only redrawn by Tank.update(), which remote tanks never get. Between the
      // two, a charging enemy Rail looked identical to an idle one — the single
      // shot in the game that is meant to be visible coming arrived with no
      // warning at all. Discrete like hp, not interpolated: it is read off the
      // newer snapshot rather than blended.
      tank.charge = sb.c ?? 0;
      tank.spawnGuard = sb.sg ?? 0;
      tank._syncHealthBar?.();
      tank.syncChargeVisual?.();
      // Push the interpolated body transform onto the visual rig. Interpolation
      // only touches the physics body; without this the mesh never moves.
      tank.syncTransform();
    }
  }

  setWeapon(weapon) {
    if (this.connected) this._send({ t: C_LOADOUT, weapon });
  }

  _send(obj) {
    const payload = JSON.stringify(obj);
    const go = () => { if (this.ws.readyState === 1) this.ws.send(payload); };
    if (this.lagMs) setTimeout(go, this.lagMs); else go();
  }
}

const lerp = (a, b, f) => a + (b - a) * f;

function lerpAngle(a, b, f) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}

// Yaw-only quaternions, so a 2D slerp on (y, w) is exact and much cheaper than
// the general case.
function slerpY(sa, sb, f) {
  let ay = sa.qy, aw = sa.qw;
  const by = sb.qy, bw = sb.qw;
  if (ay * by + aw * bw < 0) { ay = -ay; aw = -aw; }   // shortest arc
  const y = lerp(ay, by, f);
  const w = lerp(aw, bw, f);
  const len = Math.hypot(y, w) || 1;
  return { x: 0, y: y / len, z: 0, w: w / len };
}
