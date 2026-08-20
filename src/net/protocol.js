// Wire protocol. One definition, imported by both server and client, so the two
// ends cannot drift apart silently.

export const SNAPSHOT_HZ = 20;        // server → client state rate
export const SNAPSHOT_INTERVAL = 1 / SNAPSHOT_HZ;

// How far in the past remote tanks are rendered. Snapshots arrive every 50ms,
// so interpolating needs at least one interval of buffer to always have two
// snapshots to blend between; the rest is headroom for jitter. This delay is
// exactly what lag compensation on the server has to undo.
export const INTERP_DELAY = 0.10;     // seconds

// Server keeps this much position history for rewinding shots.
export const LAG_COMP_WINDOW = 1.0;   // seconds

export const MAX_INPUT_BACKLOG = 180; // 3s of inputs; drops abusive clients

// ── Client → server ─────────────────────────────────────────────────────────
export const C_HELLO = 'hello';       // { name, hull, weapon }
export const C_INPUT = 'i';           // { seq, th, st, tu, f }
export const C_LOADOUT = 'l';         // { hull, weapon }
export const C_PONG = 'o';            // { ts } — echoed straight back

// Test-only. Handled solely when the server runs with TANKI_DEV=1, so it cannot
// exist in a shipped build. Controlled placement is the only way to test lag
// compensation honestly: hit rate has to be compared with the geometry held
// fixed, or cover decides the result instead of the netcode.
export const C_DEV_PLACE = 'dev_place';   // { x, z, yaw, turret }
// Turret angle only, WITHOUT respawning. C_DEV_PLACE respawns, which resets the
// tank to spawn height — calling it every tick leaves the muzzle a metre high
// and every shot sails over a short hull. That cost four debugging rounds.
export const C_DEV_AIM = 'dev_aim';       // { turret }

// ── Server → client ─────────────────────────────────────────────────────────
export const S_WELCOME = 'w';         // { id, tick, mode, players }
export const S_SNAPSHOT = 's';        // { tick, ack, tanks, drops, game, events }
export const S_JOIN = 'j';            // { id, name, hull, weapon, team }

// Which side you are on is decided by the SERVER and travels three ways: in the
// welcome roster, in each join, and again on every tank in every snapshot. That
// looks redundant and is not — the first two are how a client learns about a
// tank at all, and the third is what makes a client that joined mid-match, or
// missed a message, correct anyway. Getting this wrong does not degrade
// gracefully: a client with the wrong idea of who is on which side spends the
// match shooting at friends and holding fire on enemies.
//
// The match itself (phase, clock, both scores, winner) rides in the snapshot's
// `game` field, whole, every time. It is a handful of bytes and sending it
// whole means there is no such thing as a client that missed the transition.
export const S_LEAVE = 'x';           // { id }
export const S_PING = 'p';            // { ts }

/**
 * Inputs go on the wire as a packed array rather than an object.
 *
 * At 60Hz per client this is the highest-frequency message in the system, and
 * key names would be roughly three times the payload of the values they label.
 */
// `strafe` is sideways movement in hull space, and only a hover hull can act on
// it — tracks cannot slide. It rides on the input rather than being derived on
// the server because it is a player intent, exactly like throttle: the client
// decides where the thumb is pointing, the server decides what that achieves.
export function packInput(seq, input) {
  return [
    seq,
    Math.round(input.throttle * 100) / 100,
    Math.round(input.steer * 100) / 100,
    Math.round(input.turretSteer * 100) / 100,
    input.fire ? 1 : 0,
    Math.round((input.strafe ?? 0) * 100) / 100,
  ];
}

export function unpackInput(a) {
  return {
    seq: a[0],
    throttle: clamp(a[1]),
    strafe: clamp(a[5] ?? 0),
    steer: clamp(a[2]),
    turretSteer: clamp(a[3]),
    fire: !!a[4],
    aimPoint: null,
  };
}

// Never trust a client's numbers. A hand-edited client can send throttle 1e9
// and, with an authoritative server that forwards inputs straight into the
// simulation, that is a teleport rather than a cheat that needs detecting.
function clamp(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}
