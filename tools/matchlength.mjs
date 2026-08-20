/**
 * How long does a match actually last?
 *
 * `scoreTarget` decides that, and it is the one number in a game mode a player
 * feels directly: too low and a match is over before anyone has settled into
 * it, too high and the arena is a sandbox with a progress bar. It cannot be
 * reasoned out from the balance numbers — firing uptime here is 10-30% and most
 * of a match is manoeuvring — so it has to be measured, the same way the
 * engagement bands and the TTK target were.
 *
 * Runs full bot matches headless at whatever the config currently says and
 * reports the distribution. Re-run after any change to SCORE, to the mode's
 * target, or to weapon damage.
 *
 *   node tools/matchlength.mjs [matches] [target] [mode]
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { Match, TICK_DT } from '../src/match.js';
import { BotBrain } from '../src/bots.js';
import { MODES } from '../src/config.js';

await RAPIER.init();

const MATCHES = Number(process.argv[2] ?? 5);
const OVERRIDE = process.argv[3] ? Number(process.argv[3]) : null;
const MODE = process.argv[4] ?? 'tdm';

// The server's own line-up, so this measures the game as it is actually played.
const SETUPS = [
  { hull: 'wasp', weapon: 'twin', skill: 0.45, name: 'Messi' },
  { hull: 'hunter', weapon: 'thunder', skill: 0.6, name: 'Rihanna' },
  { hull: 'mammoth', weapon: 'rail', skill: 0.72, name: 'Musk' },
  { hull: 'hunter', weapon: 'rail', skill: 0.5, name: 'Zendaya' },
  { hull: 'wasp', weapon: 'thunder', skill: 0.55, name: 'Drake' },
  { hull: 'mammoth', weapon: 'twin', skill: 0.65, name: 'Brick' },
];

const results = [];

for (let m = 0; m < MATCHES; m++) {
  const match = new Match({ RAPIER, scene: null, worldSeed: 20250812 + m, mode: MODE });
  if (OVERRIDE) match.mode = { ...match.mode, scoreTarget: OVERRIDE };
  const target = match.mode.scoreTarget;

  const bots = SETUPS.map((cfg, i) => {
    const tank = match.addTank({ id: i + 1, hull: cfg.hull, weapon: cfg.weapon, name: cfg.name });
    return { tank, brain: new BotBrain(tank, { skill: cfg.skill, seed: (i + m) / SETUPS.length }) };
  });

  const maxTicks = Math.ceil(match.mode.timeLimit / TICK_DT) + 60;
  let ticks = 0;
  let kills = 0;
  while (match.phase === 'live' && ticks < maxTicks) {
    const inputs = new Map();
    const tanks = [...match.tanks.values()];
    for (const b of bots) {
      inputs.set(b.tank.netId, b.brain.think(TICK_DT, {
        world: match.world, RAPIER, tanks, combat: match.combat,
      }));
    }
    match.step(inputs);
    kills += match.events.filter((e) => e.e === 'kill').length;
    match.events.length = 0;
    ticks++;
  }

  const secs = ticks * TICK_DT;
  const byClock = ticks >= Math.ceil(match.mode.timeLimit / TICK_DT);
  results.push({ secs, kills, winner: match.winner, byClock, target,
    red: match.teamScore.red, blue: match.teamScore.blue });
  const board = match.mode.teams
    ? `${match.teamScore.red}-${match.teamScore.blue}`
    : [...match.tanks.values()].map((t) => t.score).sort((a, b) => b - a).join('/');
  const won = match.mode.teams ? match.winner : match.tanks.get(match.winner)?.name;
  console.log(`  match ${m + 1}: ${secs.toFixed(0)}s  ${board}`
    + `  ${kills} kills  →  ${won ?? 'draw'}${byClock ? '  (on the clock)' : ''}`);
}

const secs = results.map((r) => r.secs).sort((a, b) => a - b);
const mean = secs.reduce((a, b) => a + b, 0) / secs.length;
const timedOut = results.filter((r) => r.byClock).length;
const totalKills = results.reduce((a, r) => a + r.kills, 0);

console.log(`\n${MODES[MODE].name}: target ${results[0].target} points  (${MODES[MODE].timeLimit}s limit)`);
console.log(`  match length   mean ${mean.toFixed(0)}s   median ${secs[Math.floor(secs.length / 2)].toFixed(0)}s`
  + `   range ${secs[0].toFixed(0)}-${secs[secs.length - 1].toFixed(0)}s`);
console.log(`  kills          ${(totalKills / results.length).toFixed(1)} per match`
  + `   ${(totalKills / (mean * results.length / 60)).toFixed(1)} per minute`);
console.log(`  decided by the clock rather than the target: ${timedOut}/${results.length}`);
