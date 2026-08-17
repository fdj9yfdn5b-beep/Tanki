// Seedable RNG for everything that affects simulation outcome.
//
// The balance harness compares candidate parameter sets by simulating duels.
// With Math.random, two candidates get different luck and the comparison is
// dominated by noise. Seeding lets every candidate in a generation face the
// *same* sequence of spawns, aim wobble and spread — common random numbers —
// which removes most of the variance without running more duels.
//
// Module-level state is intentional: each worker thread gets its own module
// instance, so workers never share a stream.

function mulberry32(state) {
  return function next() {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let next = mulberry32(0x9e3779b9);

export function seed(n) {
  next = mulberry32(n >>> 0);
}

export function random() {
  return next();
}

/** Standard normal via Box-Muller. */
function boxMuller(draw) {
  let u = 0, v = 0;
  while (u === 0) u = draw();
  while (v === 0) v = draw();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function gaussian() {
  return boxMuller(next);
}

/**
 * A normal drawn from an explicit seed rather than from the module stream.
 *
 * Online, the client fires its own shot for instant feedback and the server
 * decides the outcome. Both run the same code — but each was pulling spread
 * from its own RNG, so the tracer you watched and the ray the server actually
 * traced were two INDEPENDENT draws of the same distribution. With Twin at
 * 1σ = 0.05 rad the two directions differ by 0.05·√2, which is over 2m of
 * lateral disagreement at 30m: wide enough that a shot could visibly strike a
 * tank on your screen while the authoritative ray passed beside it. Seeding
 * the draw from something both ends already know collapses that to zero.
 *
 * Kept separate from the module stream on purpose. The balance harness relies
 * on `seed()` giving every candidate the same sequence of spawns and aim wobble
 * (common random numbers, §6), and pulling shots out of that stream would
 * change what the tuner sees.
 */
export function gaussianFrom(s) {
  return boxMuller(mulberry32(s >>> 0));
}

/**
 * Mix a shooter and one of its inputs into a shot seed. The input sequence
 * number is the right pairing key: the client stamps it on the input it
 * predicts, and the server resolves that exact input, so the two ends agree
 * without either having to trust the other's aim.
 */
export function shotSeed(id, seq) {
  let h = Math.imul(id + 1, 0x9e3779b1) ^ Math.imul(seq + 1, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function range(lo, hi) {
  return lo + random() * (hi - lo);
}

export function pick(arr) {
  return arr[Math.floor(random() * arr.length)];
}
