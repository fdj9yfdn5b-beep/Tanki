import { WEAPONS, HULLS } from '../src/config.js';

// The optimiser's search space.
//
// Bounds are where design intent lives — this is the single most important
// thing about this file. An objective can only say "make the winrates equal";
// it has no opinion about what a weapon or a hull IS. Twice now the optimiser
// has bought balance by deleting a weakness that was the point of the design
// (Rail's slow turret), and both times the fix was a tighter bound, not a
// different objective.
//
// Two intents are encoded structurally here:
//   * Turret traverse is capped low across the board. Tanks are not turrets on
//     a swivel; a turret you can whip 215°/s makes traverse a non-decision.
//   * Hull ranges do not overlap. Mammoth always has at least ~27% more HP than
//     Wasp, and Wasp is always at least ~30% faster. The optimiser may move
//     them within those lanes; it may not converge them into one hull.

export const SPEC = [
  ['twin.damage', 8, 40],
  ['twin.fireInterval', 0.12, 0.6],
  ['twin.muzzleSpeed', 50, 140],
  // Upper bounds cut from 0.06 / 0.03 — see the SPREAD note in config.js. Both
  // weapons had been tuned to sit essentially ON the old ceilings (0.0502 and
  // 0.0294, the latter at its cap), because spread is the cheapest lever the
  // optimiser has for pulling a winrate down, and the loss function cannot see
  // what it costs to aim. At those values 30% of well-aimed shots missed a
  // stationary target. Leave these tight: a future run will otherwise walk
  // straight back to the ceiling and silently undo it.
  ['twin.spread', 0.005, 0.022],
  ['twin.falloffStart', 8, 30],
  ['twin.falloffEnd', 25, 70],
  ['twin.minDamageFactor', 0.1, 0.8],
  ['twin.turretTurnRate', 0.9, 2.0],

  ['thunder.damage', 25, 110],
  ['thunder.fireInterval', 0.6, 2.2],
  ['thunder.muzzleSpeed', 35, 100],
  ['thunder.spread', 0.002, 0.014],
  ['thunder.splash', 2, 8],
  ['thunder.splashFactor', 0.3, 0.9],
  ['thunder.falloffStart', 15, 45],
  ['thunder.falloffEnd', 40, 90],
  ['thunder.minDamageFactor', 0.2, 0.9],
  ['thunder.turretTurnRate', 0.7, 1.6],

  ['rail.damage', 50, 200],
  ['rail.chargeTime', 0.6, 2.6],
  ['rail.fireInterval', 0.2, 1.2],
  ['rail.turretTurnRate', 0.5, 1.2],

  // Hulls. Admitted to the search only now that bots evade incoming fire —
  // before that, a fast hull's advantage was invisible to the simulation and
  // tuning against it would have been fitting to a bot deficiency.
  ['wasp.hp', 150, 260],
  ['wasp.maxSpeed', 15, 20],
  ['wasp.turnRate', 2.2, 3.2],
  ['wasp.driveForce', 30, 46],

  ['hunter.hp', 240, 340],
  ['hunter.maxSpeed', 11.5, 15.5],
  ['hunter.turnRate', 1.6, 2.4],
  ['hunter.driveForce', 32, 48],

  ['mammoth.hp', 330, 480],
  ['mammoth.maxSpeed', 8, 11.5],
  ['mammoth.turnRate', 1.0, 1.6],
  ['mammoth.driveForce', 38, 56],
];

const HULL_KEYS = new Set(Object.keys(HULLS));

export const DIM = SPEC.length;

const table = (group) => (HULL_KEYS.has(group) ? HULLS : WEAPONS);

/** Current config as a vector, in SPEC order. */
export function currentVector() {
  return SPEC.map(([key]) => {
    const [g, f] = key.split('.');
    return table(g)[g][f];
  });
}

/** Normalise a raw vector into [0,1] per-dimension, which is what CMA-ES sees. */
export function toUnit(v) {
  return v.map((x, i) => (x - SPEC[i][1]) / (SPEC[i][2] - SPEC[i][1]));
}

export function fromUnit(u) {
  return u.map((x, i) => {
    const [, lo, hi] = SPEC[i];
    return lo + Math.min(1, Math.max(0, x)) * (hi - lo);
  });
}

/** Write a raw vector into the live WEAPONS / HULLS objects. */
export function apply(vec) {
  SPEC.forEach(([key], i) => {
    const [g, f] = key.split('.');
    table(g)[g][f] = vec[i];
  });
  // Structural constraint the optimiser cannot express on its own: a falloff
  // window must actually be a window.
  for (const w of ['twin', 'thunder']) {
    WEAPONS[w].falloffEnd = Math.max(WEAPONS[w].falloffEnd, WEAPONS[w].falloffStart + 5);
  }
}

export function asObject(vec) {
  const out = {};
  SPEC.forEach(([key], i) => { out[key] = +vec[i].toFixed(4); });
  return out;
}
