// Read the live scoreboard off the server. Confirms scoring is computed
// authoritatively and reaches clients in snapshots.

import WebSocket from 'ws';
import { C_HELLO, C_PONG, S_WELCOME, S_SNAPSHOT, S_PING } from '../src/net/protocol.js';
import { SCORE } from '../src/config.js';

const URL = process.env.URL ?? 'ws://localhost:8099/ws';
const WATCH = Number(process.env.WATCH ?? 45);

const ws = new WebSocket(URL);
let id = null, names = new Map(), latest = null;

ws.on('open', () => ws.send(JSON.stringify({ t: C_HELLO, name: 'Spectator', hull: 'hunter', weapon: 'twin' })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.t === S_WELCOME) {
    id = m.id;
    for (const p of m.players) names.set(p.id, p.name);
  } else if (m.t === S_PING) ws.send(JSON.stringify({ t: C_PONG, ts: m.ts }));
  else if (m.t === S_SNAPSHOT) latest = m;
});

console.log(`watching for ${WATCH}s...`);
await new Promise((r) => setTimeout(r, WATCH * 1000));

if (!latest) { console.log('no snapshots received'); process.exit(1); }

const rows = latest.tanks
  .map((t) => ({ name: names.get(t.id) ?? `#${t.id}`, k: t.k, a: t.as, d: t.de, sc: t.sc }))
  .sort((x, y) => y.sc - x.sc);

console.log(`\nLIVE SCOREBOARD  (kill ${SCORE.kill} pts · assist ${SCORE.assist} pts)\n`);
console.log('  PLAYER        K   A   D   PTS');
for (const r of rows) {
  const want = r.k * SCORE.kill + r.a * SCORE.assist;
  console.log(`  ${r.name.padEnd(12)}${String(r.k).padStart(2)}${String(r.a).padStart(4)}` +
    `${String(r.d).padStart(4)}${String(r.sc).padStart(6)}` + (want === r.sc ? '' : `  <- expected ${want}`));
}
const K = rows.reduce((s, r) => s + r.k, 0);
const D = rows.reduce((s, r) => s + r.d, 0);
console.log(`\n  totals: ${K} kills / ${D} deaths`);
ws.close();
process.exit(0);
