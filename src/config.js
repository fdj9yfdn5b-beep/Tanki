// ─────────────────────────────────────────────────────────────────────────────
// Balance data. Every number here is a tunable parameter — this file is the
// input vector for the auto-tuner described in the design doc. Nothing that
// affects balance should live anywhere else.
// ─────────────────────────────────────────────────────────────────────────────

// Engagement bands, in metres. Each weapon must dominate exactly one.
//
// These are derived from the arena, not picked by feel. Ray-sampling 40k random
// position pairs at turret height on the current map gives the probability that
// two points can actually see each other:
//
//   0-10m 69%   10-20m 54%   20-30m 37%   30-40m 26%   40-50m 17%
//   50-60m 12%  60-70m  9%   70-80m  7%   80-90m  6%   90m+  <5%
//
// A band is only playable where that probability is high enough to find a
// fight. The long band originally ran to 120m — at 80m barely 6% of the map can
// hold a line, so Rail bots parked at their preferred range and never fired a
// shot. Long now tops out at 55m, where sight lines still exist.
// Re-measure and re-derive these whenever the map geometry changes.
export const BANDS = { close: [0, 15], mid: [15, 35], long: [35, 55] };

// ─────────────────────────────────────────────────────────────────────────────
// Tuned by `tools/optimize.mjs` (sep-CMA-ES, 30 generations, λ=14), refitted
// after projectiles went flat. Validated on 1080 held-out duels the optimiser
// never saw: loss 2.709 -> 1.502, weapon winrate spread 0.450 -> 0.117.
//
// Re-run the optimiser after ANY change to projectiles, the map, the hulls or
// the bot brain. That is not a formality: removing vertical spread alone —
// without touching a single number here — sent the previous tuned set from
// loss 0.615 to 2.778, because a weapon scattering in one axis instead of two
// is roughly twice as accurate.
//
// Hull HP was then set by direct measurement rather than by the optimiser — see
// the HULLS block below for why, and for the four hypotheses that failed first.
// ─────────────────────────────────────────────────────────────────────────────

export const WEAPONS = {
  twin: {
    name: 'Twin',
    band: 'close',
    kind: 'projectile',
    damage: 34.42,
    fireInterval: 0.4398,   // s between shots
    muzzleSpeed: 50,        // m/s — slowest kinetic round, at the tuner s floor
    spread: 0.018,          // radians, 1σ, horizontal only. See SPREAD note below.
    // Twin is now defined by a brutally short damage window: full damage to 9m,
    // decaying to a tenth of it by 25m. Both ends sit on the tuner's bounds. It
    // is the highest per-shot damage in the game and it evaporates past knife
    // range — which is what finally stopped it being the best weapon in all
    // three bands.
    falloffStart: 8.47,     // m — full damage until here
    falloffEnd: 26.3,       // m — minDamageFactor beyond here
    minDamageFactor: 0.145,
    splash: 0,
    turretTurnRate: 1.9527, // rad/s — fastest traverse, its close-range answer
    recoil: 0.9,
    color: 0x6fd3ff,
    barrels: 2,
    barrelLength: 2.5,
    barrelRadius: 0.16,
  },
  thunder: {
    name: 'Thunder',
    band: 'mid',
    kind: 'projectile',
    damage: 110,            // at the tuner's cap
    fireInterval: 1.5563,
    // Slow shell: travel time is what keeps Thunder out of close range, since a
    // moving target at 10m simply is not there when it arrives.
    muzzleSpeed: 35,
    spread: 0.010,
    // Almost no falloff (0.9 floor, at the cap) plus the widest splash in the
    // game. Thunder is the area-denial answer — it does not need to be precise,
    // it needs to make a piece of ground unusable.
    falloffStart: 22.58,
    falloffEnd: 59.09,
    minDamageFactor: 0.9,
    splash: 7.9112,         // m — radius of full-to-zero falloff
    splashFactor: 0.8189,   // fraction of direct damage at epicentre
    turretTurnRate: 1.6,
    recoil: 3.4,
    color: 0xffb347,
    barrels: 1,
    barrelLength: 3.0,
    barrelRadius: 0.3,
  },
  rail: {
    name: 'Rail',
    band: 'long',
    kind: 'hitscan',
    damage: 174.96,
    chargeTime: 2.0678,     // s of held fire before it will discharge
    fireInterval: 0.2,      // post-shot lockout
    spread: 0,
    falloffStart: 120,      // no falloff — it is the long-range answer
    falloffEnd: 120,
    minDamageFactor: 1,
    splash: 0,
    pierce: true,           // passes through tanks, damage unreduced
    // Worth noting: the previous run pinned this at its upper bound of 2.5,
    // deleting the slow traverse meant to be Rail's counterplay. Under flat
    // trajectories the optimiser chose 1.45 on its own — the slowest turret in
    // the game — and paid for the balance with a 2s charge instead. Design
    // intent survived here without needing the bound tightened.
    turretTurnRate: 1.1673,
    recoil: 4.5,
    color: 0xff5c7a,
    barrels: 1,
    barrelLength: 3.6,
    barrelRadius: 0.14,
  },
};

// `turretMod` scales the weapon's traverse rate by hull, so a light hull tracks
// faster than a heavy one. Kept on design grounds — traverse being a pure weapon
// stat meant both tanks in a mirror tracked identically — but be aware it did
// NOT measurably move hull balance on its own.
//
// HULLS DIFFERENTIATE ON MOBILITY, NOT ON TOUGHNESS. The HP spread is 1.05x.
//
// That is not a stylistic choice, it is what the measurements forced. The
// original design had a 2.26x HP spread (190 vs 430) and Mammoth won 92% of
// same-weapon mirrors. Four separate attempts to make speed pay for that gap
// were each built, measured, and falsified:
//
//   1. More HP for Wasp      — at EQUAL hp it still only reached 0.415
//   2. More acceleration     — 4x responsiveness only reached 0.283
//   3. Hull turret modifier  — no measurable improvement
//   4. Evasion spread        — even at absurd values, only 0.223
//
// Instrumenting a duel showed why: a Wasp OUT-DAMAGED a Mammoth at close range
// (8807 vs 8458 dealt, 20.9 vs 17.8 per shot) and still lost 0-29, because both
// took the same damage. Mobility reduced incoming fire by ~4%. Sweeping HP
// showed speed is worth roughly +5 to +9% winrate here — real, but it can never
// offset 75% more health.
//
// So either the HP spread shrinks to what mobility can actually pay for, or
// hulls stay unbalanced in a straight fight and earn their value elsewhere
// (objective capture, flag carrying) once game modes exist. This takes the
// first option.
//
// HP was then scaled down uniformly by 0.85. Balance depends on the RATIOS, so
// scaling preserves it while shortening fights: mean TTK 8.30s -> 7.29s and
// timeouts 22.4% -> 17.7%, with overall loss falling 0.594 -> 0.246.
export const HULLS = {
  wasp: {
    name: 'Wasp',
    hp: 293,
    mass: 1.0,
    driveForce: 30.95,
    maxSpeed: 16.15,
    turnRate: 2.21,
    turretMod: 1.3,
    size: [2.3, 0.85, 3.2],   // half-extents feed the collider
    color: 0x8fe388,
  },
  hunter: {
    name: 'Hunter',
    hp: 298,
    mass: 1.55,
    driveForce: 32,
    maxSpeed: 13.34,
    turnRate: 1.6,
    turretMod: 1.0,
    size: [2.6, 1.0, 3.6],
    color: 0x7fb3ff,
  },
  mammoth: {
    name: 'Mammoth',
    hp: 308,
    mass: 2.6,
    driveForce: 39.09,
    maxSpeed: 9.77,
    turnRate: 1.23,
    turretMod: 0.75,
    size: [3.0, 1.15, 4.1],
    color: 0xd9a441,
  },

  // The hover hull. Tracks can only push along the hull's own axis, so every
  // tracked tank has to point itself before it can go anywhere — which is the
  // single thing that makes a thumbstick feel unresponsive, and the reason the
  // phone build needed a whole turn-toward-a-heading layer to be playable.
  // An anti-grav hull just goes: forward, sideways, diagonally, backwards, at
  // once and with no wind-up.
  //
  // It pays for that. `strafeFactor` keeps sideways slower than forward, the
  // body is slower to bring round than a Hunter's, and it is the least armoured
  // hull in the game. Gravity is untouched — it floats a fixed gap above
  // whatever is under it, and over a drop there is nothing under it.
  wraith: {
    name: 'Wraith',
    hp: 291,
    mass: 1.2,
    driveForce: 33,
    maxSpeed: 13.6,
    turnRate: 1.45,          // how fast the body swings onto the aim
    turretMod: 1.15,
    // Near-square footprint, and that is a balance decision rather than a
    // styling one. This hull's body always faces whatever its gun is pointing
    // at, so with a 2.5 x 3.3 hull it presented its narrow face permanently —
    // free angling that no tracked hull can have. Against Rail, which has zero
    // spread and kills in two, hit-or-miss is purely geometric, and it measured
    // a 96% winrate. Square means facing buys nothing.
    size: [2.9, 0.7, 3.0],   // compact and low-slung
    color: 0xb98cff,
    hover: true,
    // Ride height is not a free visual choice. Shots fly flat, so it decides
    // whether this hull's muzzle still falls inside a tracked hull's box and
    // whether theirs still falls inside this one's. At 1.15 it could neither
    // hit nor be hit by anything. Anything raised here must be re-checked with
    // `node tools/hitheight.mjs`.
    hoverHeight: 0.85,       // m from the ground to the body centre
    strafeFactor: 0.8,       // sideways speed as a fraction of forward
  },
};

// Evasion: how much a target's angular rate (lateral speed / range) widens the
// shooter's spread. This is the only mechanic that converts hull speed into
// survival, so it is the dial that decides whether light hulls can exist.
export const EVASION = {
  gain: 0.010,   // rad of extra 1σ spread per rad/s of target angular rate
  max: 0.018,    // ceiling, so a fast close crosser is not untouchable
};

// SPREAD, and why these numbers came down.
//
// The optimiser tuned spread as a balance lever and had no way to know what it
// costs to aim. Measured against a Hunter (2.6m wide) at 25m with the tuned
// values: 30% of shots missed a dead-centre-aimed STATIONARY target, and 62%
// missed a crossing one. Against a moving target the evasion term (0.055 rad)
// was larger than Twin's own spread, so most of the error came from a mechanic
// the player cannot see, cannot predict and is never told about.
//
// That directly contradicts the rule the rest of the game is built on — flat
// trajectory, no reticle, "what the barrel points at is what you hit" (§5 of
// the handoff). A shot that leaves the barrel at a random angle makes the
// barrel a liar, and the player reads it as the game being broken rather than
// as a balance mechanic. It was invisible while clients were drawing five to
// seven shells per shot, because a fan of shells hides which one went where.
//
// Roughly a third of the previous values. Spread still keeps a high-damage
// weapon honest at the far edge of its band, and evasion still pays a light
// hull something, but neither can now take a well-aimed shot and throw it past
// a target the player is looking straight at.

// Visual density. Purely cosmetic — nothing here reaches the simulation.
//
// Kept as one dial because "too busy to read the fight" is a judgement only a
// playtest can make, and hunting the counts back down through fx.js each time
// is how they drift apart.
//
// THREE rounds of "too dense" were answered by cutting these counts, and none
// of it was ever a count problem. A client was drawing five to seven shots for
// every shot it fired — see the reconciliation note in net/client.js — so the
// screen was showing a real 2.3 shots/sec as fifteen. Every reduction here was
// treating the symptom, and the numbers below are deliberately back at what
// they were before that was understood. If it is still busy now that the cause
// is fixed, this is the place, but change it against a playtest of the FIXED
// build, not against the memory of the broken one.
//
// The one genuine density bug was structural, not numeric: every landed shot
// rendered TWO impacts, one from the shot's own projectile or beam and a second
// from the server's `hit` event at the target's centre — one shot, two bursts,
// a metre or two apart. That one stays fixed; see main.js.
export const FX = {
  muzzleEmbers: 3,      // per shot, on top of the flash itself
  impactEmbers: 3,      // base count before the scale term
  maxImpactEmbers: 6,   // ceiling, so a big splash cannot dump 30 in one frame
  beamLife: 0.28,       // s. Hitscan tracer dwell.
};

// How hull turn rate scales with how fast you are going.
//
// A tracked tank pivots hardest when it is barely moving and washes out into a
// wide arc at speed — that is what tracks do, and a tank that yaws at its full
// rate flat out reads as a hovercraft. `atRest` is the multiplier standing
// still, `atTopSpeed` the multiplier at maxSpeed, interpolated between.
//
// Above 1.0 at rest on purpose: a neutral-steer pivot is the one thing tracks
// are genuinely better at than wheels, and it is what makes a heavy hull able
// to bring its gun round in a corner.
export const TURN_BY_SPEED = { atRest: 1.25, atTopSpeed: 0.6 };

// Seconds of invulnerability after respawning.
//
// Spawns are fixed points on a ring, so anyone who knows the map can park a gun
// on one; without this you die, wait, and die again to the same shot with no
// move available to you. It ends EARLY the moment the protected tank fires —
// otherwise it is not protection, it is two free seconds of shooting.
export const SPAWN_PROTECTION = 2.0;

// Scoring. An assist is credited to anyone who damaged the victim recently but
// did not land the final blow — without it, focusing a target down as a team
// rewards only whoever happened to fire last.
export const SCORE = {
  kill: 10,
  assist: 5,
  assistWindow: 8,     // seconds before death that damage still counts
  assistMinDamage: 1,  // ignore incidental splash chip
};

// Absolute TTK target band, in seconds.
//
// This was originally 0.8-2.5s, borrowed from twitch arena shooters. That is the
// wrong genre: those numbers assume hitscan weapons and near-permanent line of
// sight. Tank combat is attritional — turrets traverse slowly, cover breaks
// sight lines constantly, and measured firing uptime here is 10-30%, so even
// maxed damage cannot get near 2.5s. Chasing it made TTK 70% of the optimiser's
// loss and starved the balance terms that are the actual goal.
//
// 3-7s: long enough to be a duel with manoeuvring in it, short enough that a
// won engagement resolves instead of stalling into a timeout.
export const TTK_TARGET = [3.0, 7.0];

// Projectiles fly straight — no gravity, no barrel elevation.
//
// This used to be 9, with the barrel solving a ballistic arc onto a mouse-aimed
// ground point. It was removed on playtest feedback and the reasoning is worth
// keeping: an arc means the shell's path depends on a *range* the player never
// explicitly chose, so Thunder routinely lobbed over a tank sitting directly in
// front of the barrel. Nothing about that is learnable — the barrel points at a
// target and the shot misses high, for reasons invisible on screen.
//
// A flat trajectory makes the rule "what the barrel points at is what you hit",
// which is the contract the aim marker now draws. Elevation, if it ever comes
// back, should come from the tank's own pitch on sloped ground — a position you
// can see and drive to — not from a hidden solver.
export const PROJECTILE_GRAVITY = 0;

export function damageAtRange(weapon, dist) {
  if (dist <= weapon.falloffStart) return weapon.damage;
  if (dist >= weapon.falloffEnd) return weapon.damage * weapon.minDamageFactor;
  const t = (dist - weapon.falloffStart) / (weapon.falloffEnd - weapon.falloffStart);
  return weapon.damage * (1 - t * (1 - weapon.minDamageFactor));
}

// ── Air drops ───────────────────────────────────────────────────────────────
// Crates fall onto the arena and grant a timed ability to whoever drives into
// one first. They exist to give the map a reason to leave cover: the arena is
// symmetric and a duel between two players who both know their weapon's band
// has no other pull toward a particular piece of ground.
//
// Every effect is a MULTIPLIER, never a flat grant. A shield that made you
// invulnerable, or a damage boost that added a fixed number, would each rewrite
// the balance the optimiser produced; a multiplier scales it and stays legible
// to a player who already knows what their tank does.
//
// Durations are deliberately short. The interesting decision is whether to
// break off and take the crate, not what happens for the next half-minute.
export const DROPS = {
  interval: 18,        // s between drops
  maxAlive: 3,         // crates on the field at once
  fallFrom: 42,        // m up — high enough to see across the map
  fallSpeed: 11,       // m/s
  pickupRadius: 3.2,   // m, generous: a fast hull should not have to thread it
  lifetime: 32,        // s on the ground before it expires
};

export const DROP_KINDS = {
  shield: {
    name: 'SHIELD',
    // What it actually does, in the player's terms. Shown on the HUD next to
    // the countdown: knowing you have SHIELD is useless without knowing what
    // SHIELD is worth, and a name alone taught nobody anything.
    blurb: '-45% damage taken',
    glyph: 'shield',
    duration: 10,
    color: 0x6fd3ff,
    // Takes 45% off incoming damage. Not immunity — a protected tank still has
    // to fight, and whoever it is fighting can still see progress.
    damageTaken: 0.55,
  },
  power: {
    name: 'POWER',
    blurb: '+50% damage dealt',
    glyph: 'power',
    duration: 10,
    color: 0xff8a3d,
    damageDealt: 1.5,
  },
  speed: {
    name: 'SPEED',
    blurb: '+35% speed',
    glyph: 'speed',
    duration: 12,
    color: 0x8fe388,
    maxSpeed: 1.35,
    turnRate: 1.25,
  },
};

// ── Teams and game modes ────────────────────────────────────────────────────
// Until now this was a sandbox: you could kill and be killed forever and there
// was nothing to win. A mode is three things — sides, a target, and an end —
// and the end is the part that makes the other two mean anything.
//
// Both modes live in the same code path. The only thing `teams: false` changes
// is who counts as an enemy and whose score the target is measured against, so
// there is no second implementation to keep in step with the first.
export const TEAMS = {
  red: { name: 'RED', color: 0xff5f4d, css: '#ff5f4d' },
  blue: { name: 'BLUE', color: 0x3f9dff, css: '#3f9dff' },
};
export const TEAM_KEYS = Object.keys(TEAMS);

export const MODES = {
  // No sides, no target, no end — the original sandbox, and the DEFAULT for a
  // bare `new Match()`. Every tool in tools/ stages its own fights and runs
  // them for a fixed time; if the default had an end, a long balance run would
  // quietly cross the time limit, stop resolving damage and report a table of
  // numbers measured on a match that was already over. §4 has a whole entry
  // on what a wrong constant costs when it fails silently, and this is the same
  // shape. The game asks for a real mode explicitly; the harness never has to.
  sandbox: {
    key: 'sandbox',
    name: 'SANDBOX',
    teams: false,
    scoreTarget: Number.MAX_SAFE_INTEGER,
    timeLimit: Number.MAX_SAFE_INTEGER,
  },
  tdm: {
    key: 'tdm',
    name: 'TEAM DEATHMATCH',
    teams: true,
    // Points, not kills, so an assist moves the team's number — the scoreboard
    // has always paid 5 for an assist and it would be strange for the thing
    // that decides the match to be the one place that does not count them.
    //
    // 100 is MEASURED, not picked: `tools/matchlength.mjs` runs full bot
    // matches and reports mean 184s, median 174s, range 119-293s over four —
    // about three minutes, which is a match you can finish on a break. The
    // scores came in at 95-105, 100-80, 105-70 and 85-100, so a target this
    // size is also close enough to be worth chasing at the end.
    scoreTarget: 100,
    // Never reached in any measured bot match. It is not the pacing dial — it
    // is the guard against two players who cannot find each other, which on a
    // 120m map with this much cover is a real state.
    timeLimit: 420,
  },
  ffa: {
    key: 'ffa',
    name: 'FREE FOR ALL',
    teams: false,
    // Lower than TDM's, because one player has to reach it alone rather than a
    // side pooling three players' work — but not half of it: measured, FFA
    // produces nearly twice the kills per minute (10.3 vs 5.6) because
    // everyone is a target. 60 ran 113s, which is short enough to feel like it
    // ended before it started; 80 runs 156s and sits alongside TDM's 184s.
    scoreTarget: 80,
    timeLimit: 420,
  },
};

// What `new Match()` gets when nobody says otherwise: the endless sandbox.
export const DEFAULT_MODE = 'sandbox';
// What the actual GAME runs — server and offline play both ask for this.
export const GAME_MODE = 'tdm';

// Seconds between the winner being decided and the next match starting. Long
// enough to read the final board, short enough that nobody alt-tabs.
export const INTERMISSION = 12;
