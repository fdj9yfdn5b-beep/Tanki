/**
 * Bring up a public link, and do not report one that does not work.
 *
 *   npm run tunnel
 *
 * Cloudflare quick tunnels expire, and they fail in the worst possible way: the
 * `cloudflared` process stays alive and keeps retrying ("control stream
 * encountered a failure while serving") while the hostname simply stops
 * resolving. Nothing looks broken locally — the game server is fine, the
 * process list looks right — but the link you handed someone is dead. That has
 * now happened twice in one session, both times discovered by a person clicking
 * it.
 *
 * So this kills any existing tunnel, starts a fresh one, and then actually
 * fetches /healthz THROUGH the public hostname before printing it. A URL that
 * has not served a request is not a URL.
 */
import { spawn, execSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';

const PORT = Number(process.env.PORT ?? 8099);
const LOG = new URL('../tunnel.log', import.meta.url).pathname;

const local = await fetch(`http://localhost:${PORT}/healthz`).then((r) => r.json()).catch(() => null);
if (!local?.ok) {
  console.error(`No game server on :${PORT}. Start it first —  npm run host`);
  process.exit(1);
}
console.log(`game server ok on :${PORT}  (${local.bots} bots)`);

try { execSync('pkill -f cloudflared'); } catch { /* none running */ }
await new Promise((r) => setTimeout(r, 2000));

const log = createWriteStream(LOG);
const proc = spawn('npx', ['cloudflared', 'tunnel', '--url', `http://localhost:${PORT}`],
  { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

let url = null;
const scan = (buf) => {
  const s = buf.toString();
  log.write(s);
  // Quick-tunnel hostnames are always several hyphenated words. cloudflared
  // also logs its own control endpoint, `api.trycloudflare.com`, and a looser
  // pattern happily picks that up and then reports a URL that serves nothing —
  // which is precisely the failure this script exists to prevent.
  const m = s.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/);
  if (m && !url) url = m[0];
};
proc.stdout.on('data', scan);
proc.stderr.on('data', scan);

process.stdout.write('opening tunnel');
for (let i = 0; i < 40 && !url; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  process.stdout.write('.');
}
console.log();

if (!url) {
  console.error(`cloudflared never printed a URL — see ${LOG}`);
  process.exit(1);
}

// The hostname takes a few seconds to propagate after it is printed. Poll it
// rather than sleeping a guessed amount and hoping.
let served = false;
for (let i = 0; i < 20 && !served; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  served = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(8000) })
    .then((r) => r.ok).catch(() => false);
  process.stdout.write(served ? '' : '.');
}

if (!served) {
  console.error(`\n${url} came up but never served a request — see ${LOG}`);
  process.exit(1);
}

proc.unref();
console.log(`\n  ${url}/?online=1\n`);
console.log('  Verified: that hostname served a real request just now.');
console.log('  It stays up only while this Mac is awake and the server is running.');
