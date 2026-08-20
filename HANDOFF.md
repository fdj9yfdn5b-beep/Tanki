# TANKI — handoff

**Read this first.** Written at the end of the build session so the next one can
pick up without re-deriving anything.

A browser 3D tank arena in the spirit of Tanki Online, built from nothing in one
session. ~4,900 lines across simulation, netcode, a balance optimiser and test
tooling. No external art assets — every texture, mesh and effect is generated in
code.

---

## 1. Run it

```bash
cd ~/tanki
npm install
```

| what | command | open |
|---|---|---|
| offline vs bots | `npm run dev` | http://localhost:5178 |
| multiplayer, local | `npm run server` + `npm run dev` | http://localhost:5178/?online=1 |
| multiplayer, one port | `npm run host` | http://localhost:8099/?online=1 |
| same Wi-Fi | `npm run host` | server prints the LAN URL |
| over the internet | **already deployed — see below** | https://tanki-nh1l.onrender.com/?online=1 |
| a throwaway link | `npm run host` then `npm run tunnel` | it prints a link it has already tested |
| on a phone | open that same URL — touch controls appear on their own | force with `?touch=1`, force off with `?touch=0` |

## THE GAME IS DEPLOYED. Use the permanent link.

**https://tanki-nh1l.onrender.com/?online=1**

Render free tier, deployed from `render.yaml` in this repo, GitHub remote
`fdj9yfdn5b-beep/Tanki`. **Every `git push origin main` redeploys it** — that is
`autoDeploy: true`, and it takes 3-5 minutes. Confirm a deploy landed by
watching `/healthz`: the tick counter resets to near zero when a fresh process
takes over.

Do not reach for the tunnel any more. Four separate times a link was handed over
and was dead within the hour. Everything below about tunnels is for a quick
local share only.

**The free instance is kept awake by pinging itself.** `server/index.mjs` fetches
its own `RENDER_EXTERNAL_URL/healthz` every 10 minutes. This is not optional
polish: Render suspends an idle instance and then does NOT hold the next request
while it restarts — it answers **404 with `x-render-routing: no-server`**.
Measured: two 404s then a 200, ~25 seconds apart. So a friend clicking a cold
link is told "Not Found" and reasonably concludes the game is broken, and the
client's own connect-retry cannot help because it only exists once the page has
loaded. Free instances get 750 hours a month against a ~730 hour month, so one
service staying up fits — **but only one**; a second free service on the account
would exceed it.

---

**Quick tunnels expire, and they fail dishonestly.** The hostname stops
resolving while the `cloudflared` process stays alive and keeps retrying
("control stream encountered a failure while serving"). Nothing looks broken
locally — the game server is fine, the process list looks right — so the first
symptom is a person telling you the link is dead. It has now happened twice in
one session.

```bash
npm run tunnel
```

That kills any existing tunnel, starts a fresh one, and **fetches /healthz
through the public hostname before printing it** — a URL that has not served a
request is not a URL. Do not go back to running `cloudflared` by hand: its own
output mentions `api.trycloudflare.com`, and a loose grep for a trycloudflare
URL picks that up and reports a link that serves nothing. Real quick-tunnel
names are always several hyphenated words.

The link changes every time, so it has to be re-sent. §3 "permanent hosting" is
the actual fix.

Useful flags: `?lag=150` injects artificial latency both directions into the real
client (dev testing). `BOTS=4` sets server bot count. `TANKI_DEV=1` enables test
hooks and shot diagnostics. `NO_LAG_COMP=1` disables lag compensation for A/B.

**Controls:** `WASD` drive · `Z X` turret · `Q E` camera pitch · `space`/click
fire · `1 2 3` weapon · `P` perf overlay · `B` bloom · `O` shadows.
On the hover hull `A`/`D` strafe instead of steering — its body follows the gun.

---

## 2. Where things are

| file | responsibility |
|---|---|
| `src/config.js` | **every balance number.** The optimiser's input vector. |
| `src/match.js` | authoritative simulation, shared verbatim by server and client |
| `src/tank.js` | tank rig, physics body, drive (tracked + hover), turret traverse |
| `src/weapons.js` | firing, projectiles, hitscan, damage, evasion spread |
| `src/bots.js` | bot brain with an explicit skill dial |
| `src/arena.js` | map geometry + colliders (works with `scene = null`) |
| `src/fx.js` | pooled transient effects |
| `src/main.js` | browser entry: renderer, camera, HUD, offline/online wiring |
| `src/loadout.js` | pre-match screen: callsign, hull, weapon. Cards built from `config.js` |
| `src/touch.js` | phone controls: two floating sticks + fire button. Knows nothing about the game |
| `src/net/protocol.js` | wire protocol, single source of truth for both ends |
| `src/net/client.js` | prediction / reconciliation / interpolation |
| `server/index.mjs` | authoritative server, lag comp, bots, static hosting |
| `tools/*` | balance harness + netcode tests (see §6), plus `tunnel.mjs` |
| `render.yaml` | the live deployment. Pushing to `main` redeploys. |

**The one structural decision everything rests on:** `Match.step(inputs)` contains
everything that decides an outcome and touches no renderer. Server and client run
the *same class*. A separate "client world" would drift the moment either side
was edited.

---

## 3. Current state

### Works and is verified
- **Game modes: teams, a score target, a match end.** `tdm` (default) and `ffa`
  run through the same code — `teams: false` is the only difference, so there
  is no second implementation. Red vs blue, first to 100 points (kills 10,
  assists 5), 7-minute limit, 12-second intermission, then everything resets and
  a new match starts. Friendly fire off, bots ignore teammates, each side spawns
  on its own half of the ring. See §4 for what is measured and what is not.
- Offline play vs 5 bots; online play vs server bots and other humans
- Authoritative server at 60Hz, snapshots at ~19-20Hz, inputs at 60/s
- Client prediction (moves with no round trip), reconciliation (forced 6m desync
  corrected to 0.16m), interpolation of remote tanks
- Scoreboard: kill 10 pts, assist 5 pts (assist = damaged the victim within 8s
  and did not land the kill). Verified arithmetic over 180s of bot combat.
- Weapon balance tuned by optimiser and validated on held-out duels
- **Deployed and live on Render** — see §1. `Dockerfile`, `render.yaml`,
  `/healthz`, graceful SIGTERM, self-ping keep-alive. `fly.toml` is also present
  and correct but unused (Fly requires a card; Render does not).
- **Air-dropped crates.** A crate falls every 18s with a light column, up to 3 on
  the field, and grants SHIELD (-45% damage taken), POWER (+50% damage dealt) or
  SPEED (+35%) for 10-12s. Every effect is a MULTIPLIER on the tuned numbers,
  never a flat grant, so each weapon's shape at range survives. Lives in
  `Match._stepDrops` so client and server run identical code. Verified headless:
  spawn, fall, pickup, multiplier applied, expiry, cleared on death; and the
  local player's HUD readout verified through the real reconciliation path.
- **`wraith`, the anti-grav hull.** NOTE: measurably imbalanced against Rail and
  the cause is not yet found — see §4 before touching its numbers.
  Strafes in any direction with no turn, so a
  thumbstick maps straight onto velocity. Verified: stick up/right/down/left/
  diagonal give throttle 1 / strafe 1 / throttle -1 / strafe -1 / 0.71+0.71;
  pure strafe moves 8.77m sideways and 0.00m forward; ride height settles to
  1.19m from a 4m drop and holds while driving; it falls when nothing is below
  it; the body swings onto the gun with 0.00° of world-aim drift.
- **Phone support.** On a tracked hull the left stick points where you want to GO
  (camera-relative heading, with a translucent ghost hull showing it); on a hover
  hull it just moves you there. Right stick traverses the
  turret and pitches the camera; fire button plus auto-fire. Verified at a
  360px-tall landscape viewport with touch emulation: stick directions map to
  the right world headings in all four quadrants, the hull converges from 90°,
  135° and 180° offsets, both sticks work simultaneously, auto-fire triggers
  only while the barrel is on someone and goes quiet when toggled off, the fire
  button lights on target, portrait shows a rotate prompt, and desktop is
  untouched (`isTouchDevice()` requires a coarse pointer, so touchscreen laptops
  keep the keyboard).
- Per-player loadout: callsign, hull and weapon chosen before joining, remembered
  in localStorage. Verified with two clients on one server — each sees the
  other's real name, hull and weapon, and a failed connect leaves the player on
  the screen with the reason instead of in an empty arena. **The wire never
  needed changing**: `C_HELLO` has always carried all three and the server has
  always validated and broadcast them; the client just sent a hardcoded
  `{ name: 'You', hull: 'hunter', weapon: 'twin' }`, so two humans were two
  identical Hunters both called "You".

- Shot agreement between client and server: the line a client draws is the line
  the server resolves, verified end-to-end against the real server
  (`tools/shotsync.mjs`, 25/25 consecutive shots, and it fails 2/26 when the
  seeding is deliberately broken).

### Known-unverified
- **How it feels under real latency.** Playtest 3 found the shot-multiplication
  bug (§4), which was most of both complaints. It is fixed and measured, but
  **no human has played the fixed build.** Ask first. In particular the particle
  counts have been put back up, and that has never been judged against a build
  that draws the right number of shots.
- Lag compensation's isolated contribution. A/B shows it helps at high latency
  (75-108% hit retention vs 50-81%) but the signal is weak. Worth re-running now
  that the spread divergence is out of the measurement — that divergence was
  most of the noise it was drowning in.

### Open / next
1. **"I shoot a tank and it takes no health off" — reported AGAIN**, after
   playtest 9 had it as no longer reported. See §4a, which is where this
   session's investigation of it lives. Read that before touching hit
   registration.
2. **Permanent hosting — in progress on Render.** `render.yaml` is written and
   the repo has a git history; what remains is pushing to GitHub and connecting
   it. Fly was priced up and rejected for now: ~$5/month, which is a plan
   minimum rather than usage (measured egress is only ~73MB per player-hour, so
   even 100 hours of play is 15 cents). Render's free tier needs no card, and
   the trade is that an idle instance is SUSPENDED after ~15 minutes and takes
   about a minute to wake. `net.connect()` therefore retries for two minutes
   with a "waking the server" counter instead of failing on the first attempt —
   verified by starting a server 57s into a retry and watching the client join
   on its own. Note a suspend also RESETS THE MATCH, since the arena lives in
   process memory.
3. **More maps** — engagement bands were derived from *one* arena's sight lines
   and will not transfer.
4. **Art pass** — deliberately last; see §5.
5. Hull tuning is blocked on better bots (see §4).

---

## 4. Findings that change what you should do next

These were each measured, and several overturned an assumption. Do not redo them.

**A game mode is a rule about DAMAGE, and there is exactly one place to put
it.** Every damage path in the game — hitscan, a shell's direct hit, and splash
— funnels through `Combat._applyDamage`. Friendly fire and "the match is already
over" are both installed there as a single `canDamage` gate that `Match` owns.
Putting the rule in each firing path instead is how a splash weapon ends up as
the one thing that still kills its own team, which is the exact shape of the
ghost-splash bug already recorded below: a check applied in two branches out of
three, surviving review because the third branch reads as if it were doing
something else. `tools/gamemode.mjs` tests hitscan and splash separately for
this reason.

**Turning friendly fire off manufactures the game's oldest complaint unless the
shot says so.** A blocked shot is pixel-identical to a miss, and "I shoot a tank
and it takes no health off" already has three separate real causes behind it in
this file. So a shot stopped by friendly fire emits an `ff` event and the
shooter's client floats **FRIENDLY** where the damage number would have been.
This is not polish; without it the next playtest report is a fourth instance of
the oldest bug in the project, with no bug behind it.

**`new Match()` still defaults to the endless sandbox, and must keep doing so.**
Every tool in `tools/` stages its own fights and runs them on a wall clock. If
the default mode had a time limit, a long balance run would silently cross it,
`canDamage` would start returning false, and the run would report a table
measured on a match that had already ended — with nothing on screen saying so.
That is the same failure shape as the wrong TTK constant below. The game asks
for `GAME_MODE` explicitly; the harness never has to. `tools/gamemode.mjs`'s
last block is the regression guard.

**The score target is measured, not chosen.** `tools/matchlength.mjs` runs full
bot matches headless. At 100 points TDM runs **mean 184s, median 174s, range
119-293s** over four matches, ~17 kills each, and the final scores came in at
95-105, 100-80, 105-70 and 85-100 — close enough that the end of a match is
worth playing. FFA needed a different number rather than the same one: it
produces nearly twice the kills per minute (10.3 vs 5.6) because everyone is a
target, so 60 points ran 113s and felt over before it started; 80 runs 156s.
The 420s time limit was never reached in any measured match — it is not the
pacing dial, it is the guard against two players who cannot find each other.

**A client must not read the win condition off its own config.** `tgt` was on
the wire from the start and the client ignored it, showing `FIRST TO 100` from
`config.js` through an entire 20-point match. The two normally agree, which is
exactly why it went unnoticed — the failure only appears when a server runs a
different number or a client is on an older build, and then the one line telling
you how much longer this goes on is quietly wrong. Same family as the entries
below about predicted state: **if the server is the authority on a number, the
client displays the server's copy, not its own.**

**Your own tank has to be your team's colour, and lightening it is a trap.** It
used to be cyan regardless of hull so you could find yourself in a fight, and
that reason is still good — but cyan in a red-vs-blue arena is a third faction,
and you would be the only player who cannot see which side they are on. Lighter-
but-same solves it, and the first attempt lightened by 0.42 toward white, which
under this sun and tone mapping renders as a **white** tank — the same problem
again. 0.22 keeps it red.

## 4a. "I shoot a tank and it takes no health off", reported a fourth time

Reported again after playtest 9 had it as settled. §8's ordered checklist was
run first: `corpseblock`, `hitheight`, `edgehit` and `firerate` all pass, and
hit registration is not the problem. Two things were, and one of them was a
test.

**The number on screen was the damage REQUESTED, not the damage DEALT.**
`Combat._applyDamage` called `takeDamage(amount)` and then reported `amount` to
`onHit`. Three things sit between the two, and every one of them was invisible:

| | shooter was told | target lost |
|---|---|---|
| ordinary hit | 175 | 175 |
| **spawn-protected target** | **175** | **0** |
| SHIELD on the target | 175 | 96.2 |
| target had 20 HP left | 175 | 20 |

Measured over 9 minutes of bot combat: **the screen claimed 35,719 damage and
31,831 landed — 89%.** 2.3% of all damage applications hit a spawn-protected
tank, and bots understate that badly: bots wander, whereas a player chases the
person they just killed, which is precisely who is protected. `takeDamage` now
returns what it applied and that is what gets reported, so the floating number,
the assist ledger and the DEV diagnostics all describe the same event.

**Spawn protection is THREE seconds of TOTAL immunity and had no tell of any
kind** — not on the protected tank, not on the shooter's screen. Unloading into
someone who just respawned did exactly nothing, with nothing anywhere saying
why. That is indistinguishable from the three real bugs below and reads as a
fourth.

The protected tank now carries a **visible bubble** — a soft additive skin plus
a wireframe shell, in the same blue as the SHIELD pickup — that shrinks and
flickers faster as it runs out. Translucency on the hull was the first attempt
and it was not enough: this arena already fades hulls for camera occlusion, so
"that tank looks see-through" is an overloaded signal, and at 60m a slightly
transparent tank is just a tank. A bubble is a shape not otherwise in the game.
It uses `depthWrite: false` and `depthTest: true`, per §5's rule that has now
gone wrong three times. `Tank.syncGuardVisual` is called from `update()` AND
from `interpolate()` — fourth instance of the remote-tank rule below; the tank
whose invulnerability you need to see is by definition not your own.

A shot that lands on a protected tank floats **PROTECTED** instead of a number.

Raised 2.0 → 3.0 on the report that a respawn does not buy enough time to get
off the spot: the slowest hull needs about a second to reach speed, so two
seconds was closer to one. No balance cost — duels stage `spawnGuard = 0` and
end on a kill, so `report.mjs` is bit-identical at LOSS 0.4403, and measured
match length is unchanged (median 174s either way).

**`tools/shotsync.mjs` was crying wolf, and nearly sent this session hunting a
bug that does not exist.** It reported 4-12 of 22 — a clear FAIL — on a build
where the server was in fact seeding all 23 of 23 shots correctly. `TOL` was
hard-coded at 0.02 with a comment deriving it as `0.001/σ`. That derivation was
right when Twin's spread was ~0.05. **Playtest 4 cut every spread to roughly a
third** (§4, and it is in the session log two entries later), so σ is 0.018 and
the true wire-rounding bound is 0.056 — the tolerance had been 2.8x too tight
ever since, rejecting correct matches at random and breaking the chain wherever
it happened to land. `TOL` is derived from σ now.

How it was settled, and the method is the reusable part: the server was made to
log, per shot, the seq it keyed off, the gaussian that seq produces, its own aim
and the direction it broadcast. Reconstructing the draw from that ground truth
gave **worst error 0.035σ across all 23 shots against a quantisation floor of
0.056σ** — the arithmetic is exact. Only then was the tool at fault rather than
the game. Two traps hit on the way, both worth knowing: **each shotsync run
gets a new client id**, so seeds from one run mean nothing in another (the
`SEQS=` mode was fed the wrong run's numbers twice and reported a confident
0/21); and its `SEQS=` mode lined those numbers up index-for-index while the
tool DROPS shots taken while the tank is turning, so the two lists slid out of
alignment at the first drop. Both are fixed.

**A negative control that requires hand-editing the server is a control that
stops being run.** `NO_SHOT_SEED=1` now puts the server back on its free-running
RNG. Seeded: **21/21**. Unseeded: **3/22**. Both were run.

**Asked when it happens: "at range, not close, and at random with no pattern."**
`tools/rangehit.mjs` aims DEAD CENTRE — what the game tells you to do, §5: flat
trajectory, no reticle, the barrel is the reticle — at a hull crossing at top
speed:

```
              10m      20m      30m      40m      50m      60m
twin          93%       0%       0%       0%       0%       7%   hits
thunder        1%       0%       0%       0%       0%       4%
rail         100%     100%     100%      59%     100%     100%
```

Stationary, everything hits everywhere. Moving, the two PROJECTILE weapons hit
essentially never, and Thunder misses even at 10m. Twin's shell does 50 m/s and
Thunder's 35, so at 30m the flight takes 0.6s and 0.86s while the target covers
8m and 11m — against a tank 2.8m wide. **And the bots lead their shots**
(`bots.js`: `aim.addScaledVector(v, tof * skill)`); the player is given no tool
for the interception and no hint that one is needed. This is the part of §5's
"the barrel is the reticle" that was never true: exactly true for hitscan, less
true every metre for a shell in flight. Left alone deliberately — it is a design
decision, and §5's real objection was to a *ballistic arc* with a hidden range
solver, which a lead marker is not.

**Then the report was narrowed, and the real one is none of the above: "I SEE
the shell hit the tank and no health comes off."** Not a miss — the round
visibly strikes and nothing happens. That is one shot resolved against two
different targets, and the game does it by construction:

**LAG COMPENSATION ONLY WORKS FOR HITSCAN. Projectiles get none of it.** The
server rewinds the world, calls `tryFire`, and restores. `_fireHitscan`
*resolves* inside that rewound instant, so Rail is compensated correctly.
`_fireProjectile` only *spawns* a shell — the world is then restored and the
shell flies through PRESENT time, colliding against where tanks are NOW.

Confirmed with the tool built for the question. `tools/lagcomp.mjs` takes a
`WEAPON=` and its own header says flat retention means compensation is working,
a collapse means it is not:

| RTT | 0ms | 100ms | 200ms | 400ms |
|---|---|---|---|---|
| rail (hitscan) | 100% | 250% | 200% | 100% |
| twin (projectile) | 100% | 64% | 60% | **40%** |

Rail is flat and noisy; Twin collapses monotonically. **And `WEAPON` defaults to
`twin`** — so §4's "lag compensation's isolated contribution is a weak signal"
was measured on the one weapon class it cannot help. Re-read that entry in this
light.

The size of it follows from the delays. A client draws remote tanks
`INTERP_DELAY` in the past, and the snapshot it is drawing already took `rtt/2`
to arrive; the server spawns the shell `rtt/2` after the input was sent. So what
the client saw the shell strike and what the server tested are separated by the
target's motion over **`rtt + INTERP_DELAY`**:

| rtt | separation at 13.3 m/s | vs a 2.81m tank |
|---|---|---|
| 0 | 1.33m | half a tank |
| 100ms | 2.66m | a whole tank |
| 200ms | 3.99m | a tank and a half |

**At any real latency the gap exceeds the tank's own width, so a shell the
client draws hitting dead centre is a clean miss on the server.** Rail is
immune, which is exactly why the symptom comes and goes with no pattern the
player can see — it depends on which weapon is in your hands.

**Faster shells would not help this, and it is worth seeing why.** The
separation is a difference of two times — `(T + rtt/2 + f)` on the server
against `(T + f - D)` on the client — and the flight time `f` appears in both
and cancels. The gap is `rtt + INTERP_DELAY` no matter how fast the round
travels. Muzzle speed is the fix for the *leading* problem above; it does
nothing for this one. Do not conflate them: they have the same symptom from the
player's chair and completely different causes.

**FIXED.** Shells now fly through the world their own shooter could see.
`server/index.mjs` tags each spawned projectile with its shooter's
`rewindTicks`, and `stepProjectiles` — installed as `Match.step`'s
`projectileHook` — groups the shells in flight by rewind depth and advances
each group with the world rewound to that depth. `Combat.update(dt, { only })`
exists for exactly this: a shell must be advanced ONCE per tick, so the hook
replaces the combat step rather than running beside it.

Measured on `tools/lagcomp.mjs`, `WEAPON=twin`, same lane:

| RTT | 0ms | 100ms | 200ms | 400ms |
|---|---|---|---|---|
| before | 100% | 64% | 60% | 40% |
| after | 100% | **132%** | **114%** | **77%** |

Flat-to-rising instead of a monotonic collapse, which is the signature the
tool's own header describes. It costs nothing measurable: 60.0 ticks/s held
with two lagged clients and four bots, because the rewind happens once per
distinct latency per tick and only while a shell is actually in the air, and a
group at zero rewind (every bot) skips it entirely.

Three things worth knowing before touching it:

- **`rail` cannot be used as the control on this tool.** It fires 0.44/s, so
  even a 70-second run per latency lands 2-4 shots and the percentages are
  noise. The guarantee for hitscan is structural instead: `_fireHitscan`
  resolves inside `tryFire`, and a hitscan shot never puts anything in
  `combat.projectiles`, so it cannot reach the new path at all.
- **`NO_LAG_COMP=1` still disables the whole thing**, projectiles included, so
  the A/B switch remains honest.
- A tank that died while the shell was flying has its collider disabled, and
  rewinding moves bodies without re-enabling colliders — so a shell cannot kill
  a tank twice. That errs in the target's favour, which is the safe direction.

---

**Engagement bands come from map geometry, not taste.** Ray-sampling 40k position
pairs gave clear-line probability by range (69% at 0-10m down to 6% at 80-90m).
The long band originally ran to 120m, so Rail bots parked at 80m where only 6% of
the map holds a line — they fired **5 shots in 120 seconds**. Re-measure whenever
the map changes.

**A wrong constant in an objective silently wastes the whole run.** The TTK target
started at 0.8-2.5s, borrowed from twitch arena shooters. Firing uptime here is
10-30%, so it was unreachable, and it grew to ~70% of the optimiser's loss.
Corrected to 3-7s.

**A lower loss can be a worse game.** One run scored 0.652 held-out with weapon
winrate spread 0.024 — and produced a Twin that was *weakest* at close range. It
had discovered that swapping two weapons' roles equalises winrates more cheaply
than balancing them. Identity now outweighs pair balance (34 vs 12).

**Hull balance was a design problem, not a tuning problem.** Four hypotheses were
built and falsified: more HP (at *equal* HP Wasp still only reached 0.415), more
acceleration (0.283), a hull turret modifier (no change), evasion spread (0.223).
Instrumenting one duel ended it: a Wasp **out-damaged** a Mammoth at close range
and lost 0-29, because both took the same damage — mobility cut incoming fire by
~4% while the HP gap was 75%. Speed is worth ~+5 to +9% winrate here. The HP
spread was therefore cut from 2.26x to **1.05x**; hulls now differ on mobility.
The alternative — keep the spread and let hulls earn value through objectives —
is still open once game modes exist.

**Do not tune hulls against the current bots.** A light hull's advantage is
evasion, and these bots strafe on a randomised interval without truly dodging.
The sim structurally undervalues Wasp.

**Rapier only refreshes its query pipeline inside `world.step()`.** This was the
big netcode bug. The server rewound tanks for lag compensation and then raycast —
against *stale* positions. Proven directly: move a body from x=20 to x=40 and the
ray keeps reporting 18.5m until `updateSceneQueries()` is called, then 38.5m. Lag
compensation was doing **nothing**. Symptom: players' shots rarely landed while
server-side bots (zero latency) hit normally.

**Three separate bugs all read to the player as "my shots do nothing".** Worth
knowing as a set, because each was found only after the previous was fixed and
the complaint survived:

1. *Corpses stayed solid.* A killed tank kept its collider where it fell.
   `_fireHitscan` found a target that was not `alive`, fell through to the
   terrain branch and ended the beam there for no damage — and the corpse is
   invisible, so shots appeared to stop in mid-air. Fixed by disabling the
   collider on death. `tools/corpseblock.mjs`, with a control.
2. *The hit box was narrower than the tank you can see.* Treads sit at ±0.42w
   and are 0.24w wide, so the visible hull reaches 0.54w while the box stopped
   at 0.50w.
3. *A shell was swept as a zero-width ray.* Its sprite renders ~0.45m across, so
   a round whose visible body overlapped a hull by up to that much registered
   nothing. Now swept as a 0.28m ball. Effective hit envelope **1.30m → 1.65m**,
   against the 1.68m you can see. TTK 6.33s → 6.37s. `tools/edgehit.mjs`.

**Anything the client PREDICTS must be on the wire.** Twice now a value became
predicted state and was not added to the snapshot, and both times the symptom
was a snap the player felt but no test caught:

- `turnVel` — added when hull rotation got an acceleration ramp. Client and
  server ramped down from different values, so stopping a turn yanked the tank
  back. p95 rotational correction 3.38° → 0.05°.
- effects from air drops — `interpolate()` carries them for remote tanks but
  deliberately skips our own ("ours is predicted"), and the client never runs
  `_stepDrops`. So `applyTankState` was the only route to the local player and
  did not carry them: **the one player who needs to know what they picked up was
  the only one never told.**

The checklist when adding predicted state: does `snapshot()` carry it, does
`applyTankState` restore it, does `interpolate()` apply it to remote tanks?

**A flat trajectory means every muzzle must sit inside every other hull's box.**
Shots have no gravity and no elevation (§5), so a shot lands only if the
shooter's muzzle height falls within the target's collider. That held by
accident while all three hulls rested on the ground with muzzles at 0.61-0.83m.
It was never designed: the collider was the hull box only, so the turret above
it was not there to be hit at all.

`wraith` turned the accident into a total failure. At a 1.15m ride height its
muzzle was 1.34m — above every other hull's box — and its own box floated from
0.84m, above every other muzzle. It could neither hit nor be hit by anything.
Fixed by growing every collider upward to cover the turret
(`TURRET_HITBOX_RISE`), giving the hover hull a downward skirt through its
anti-grav cushion (`HOVER_SKIRT`), and dropping ride height to 0.85.
`tools/hitheight.mjs` checks all 12 orderings and reports the tightest margin —
it is 0.27m; the first attempt passed at 0.07m, which is a bug that has not
happened yet. Balance cost of the bigger boxes: TTK 5.54s -> 5.71s.

**That bug hid inside a winrate of exactly 0.5.** `hulltest` had reported Wraith
at 0.500 across most matchups and it was read as "balanced". Those were draws —
every duel timing out because neither tank could damage the other. The tell was
sitting in the same table: only *Thunder* gave non-0.5 numbers against Wraith,
because splash damages by radius and never casts the ray that was missing. **A
winrate of exactly 0.5 is not evidence of balance, it is evidence of nothing
happening.**

**Wraith is measurably lopsided and the cause is NOT yet known.** With the hit
box fixed the real numbers appeared: it loses to Thunder (0.85 / 0.68 / 0.63
against it) and dominates Rail (winning 87-89%). Two explanations were built and
falsified — a stale visual transform handing it a free extra turret correction
each tick (real bug, fixed, changed nothing), and its body-always-facing giving
it a permanently narrow profile (squaring the footprint moved 0.042 to 0.113 and
no further). Per §4's own lesson, the next step is to instrument ONE duel rather
than build a third hypothesis. Note also that bots never send `strafe`, so half
of what this hull is cannot appear in these numbers at all.

**The real fix for a thumbstick was a hull that does not need to turn.** The
turn-toward-a-heading layer below made tracked hulls usable on a phone, but it
is a workaround for a constraint tracks impose: they can only push along the
hull's own axis, so the tank must point itself before it can go anywhere, and no
control scheme removes that delay. `wraith` is an anti-grav hull that moves in
any direction at once — forward, sideways, diagonally, backwards, with no
wind-up — so the stick maps straight onto velocity and the lag is gone rather
than hidden. Verified: stick up/right/down/left/diagonal produce exactly
`throttle 1 / strafe 1 / throttle -1 / strafe -1 / 0.71+0.71`.

How it is put together, and the parts worth not re-deriving:

- **`strafe` is a new input axis on the wire** (`packInput` slot 5). It is a
  player intent like throttle, so it belongs on the input, not derived server
  side. Old packets decode to 0, so a stale client is merely unable to strafe.
- **Anti-grav is a spring-damper onto a gap, with gravity cancelled explicitly.**
  A spring alone settles wherever its force happens to match gravity — measured,
  that parked the hull at 0.69m against a 1.15m target, a sag of exactly
  `g / stiffness`. Stiffening it enough to hide that only trades sag for bob.
  Cancelling the constant leaves the spring holding a height, which is all it is
  good at. It now settles at 1.19m from a 4m drop with no oscillation.
- **Gravity is untouched.** The probe only looks 6m down; over a drop it finds
  nothing and the hull falls (measured 3.03m in half a second). An anti-grav
  hull that ignored gravity could ignore the arena.
- **The body follows the gun and `steer` is ignored.** A hover hull has no
  reason to point itself, but a tank permanently slid sideways-on looks broken,
  so the body eases onto the aim. **The turret's local angle must be decremented
  by the same step** — miss that and the two chase each other, because turning
  the body carries the turret, which moves the aim. Measured world-aim drift
  while the body swings 69°: 0.00°.
- **The sim cannot tell you what this hull is worth.** Bots never send `strafe`,
  so in the harness a Wraith is just a Hunter that turns differently, and it
  duly measures ~0.5 everywhere. That is the same blind spot §4 already records
  for Wasp and evasion — do not read those winrates as balance.

**The drive stick has to name a DIRECTION, not a throttle and a turn rate.**
The first phone build mapped the stick straight onto the keyboard controls — up
was forward, sideways was rate of turn. Those are tank controls, and the report
after five minutes was that the game was hard to play. They give a thumb no way
to say where it wants to end up: turning around means holding left and waiting,
every correction is another push, and it reads as the tank ignoring you. The
stick now points somewhere in the world relative to the camera, and the hull
turns onto that heading and drives once roughly aligned — which is what the
phone version of Tanki Online does and why it needs no learning.

Measured convergence (Hunter, turn rate 1.6): from 90° off, aligned in ~2s; from
135°, the same; from 180° it pivots on the spot (throttle 0, full steer) and
accelerates as it comes round, ending 0.009 rad off at full speed. Throttle
scales with `cos(misalignment)` and is clamped at zero rather than going
negative — reversing would need the steering to invert, which §5 refuses.

**The conversion is client-side and the server still receives `{throttle,
steer}`.** This is a control scheme, not a physics change: the hull still turns
at its own rate, so a Mammoth still swings like a Mammoth and no balance number
moves.

**The ghost hull is not decoration.** Without it the scheme is guesswork — the
thumb names a heading, the tank takes a moment to swing onto it, and in between
nothing on screen says which heading was asked for, so a correction looks
identical to being ignored. The translucent hull closes that loop, and is why
the scheme feels responsive even on a slow tank: the tank lags, the ghost never
does. It is drawn at the real hull's dimensions with a nose wedge, because a
bare box is symmetric and 180° is the error that kills you.

**Do not disable depth testing to keep an overlay visible.** The ghost first
used `depthTest: false` so scenery could never hide it, and the chase camera
promptly ended up inside it — a translucent hull painted over the entire screen
with no depth cue to explain it. Third time this exact trade has gone wrong here
(nameplates, then this). `depthWrite: false` is almost always the thing actually
wanted: the overlay stops occluding the world, and the world still occludes it.

**A short landscape window hides your own tank.** The camera looks at a point
2.2m above the hull, which is right in a tall window and wrong at 740x360: the
tank sat under the HUD strip and the player drove an arena they could see with a
tank they could not. `CAM_PIVOT_Y` drops to 0.9 on touch.

**Auto-fire is not a phone luxury, it is what makes the game possible there.**
This tank aims by *rate* — the turret traverses at a speed, it never snaps to a
cursor (§5). On a keyboard you hold a key and tap another at the right instant;
on glass the same hand is doing both, and the instant is unhittable. Auto-fire
pulls the trigger while the barrel is on someone, using one ray down the exact
line the shell will fly. It moves nothing and assists no aim — the shot keeps
its ordinary spread — so it cannot claim a hit the shot would not have taken.
Capped at the weapon's own `falloffEnd`, or Twin opens up at 80m for 14% damage
and just gives the player's position away.

**Responsive CSS overrides must come last in the file.** The phone layout was
written, matched (`matchMedia` said true), and did nothing: the media blocks sat
above the base rules they override, at equal specificity, so the desktop rules
won on source order. Symptom is the worst kind — the query is clearly correct,
so you go looking at the query.

**Spread was tuned without anyone measuring what it costs to aim.** The
optimiser treats spread as a balance lever — it is the cheapest way to pull a
winrate down — and the loss function has no term for "the shot went somewhere
the player did not point". Both projectile weapons had therefore been tuned to
sit essentially ON their upper bounds. Measured against a Hunter (2.6m wide) at
25m with those values: **30% of shots missed a dead-centre-aimed stationary
target, 62% missed a crossing one.** Against a mover the evasion term (0.055 rad)
was *larger than Twin's own spread*, so most of the error came from a mechanic
that is invisible, unpredictable and never explained on screen.

That directly contradicts the rule the rest of the game is built on (§5: flat
trajectory, no reticle, the barrel is the reticle). It went unnoticed for three
playtests because clients were drawing 5-7 shells per shot — a fan of shells
hides which one went where. Values cut to roughly a third: 0% / 15% miss at the
same range. The A/B on `tools/report.mjs`:

| | before | after |
|---|---|---|
| loss | 0.1754 | 0.2001 |
| mean TTK | 7.39s | 7.26s |
| timeouts | 14.8% | 13.6% |
| weapon identity term | 0 | 0.0008 |

The whole regression is in the pairwise term; every other term improved and each
weapon still dominates its own band. That is a deliberate trade — §4 already
says a lower loss can be a worse game, and this is the clearest case of it yet.
**The bounds in `tools/params.mjs` were tightened to match** (twin 0.06 → 0.022,
thunder 0.03 → 0.014). Without that a future optimiser run walks straight back
to the ceiling and silently undoes it.

**A client was drawing five to seven shots for every shot it fired.** Three
rounds of "too dense" were answered by cutting particle counts, and none of it
was ever a count problem. `applyTankState` restores the server's cooldown during
reconciliation, and a snapshot in flight normally predates the server seeing the
shot the client just fired — so it reports cooldown 0. Reconciliation replayed
movement but deliberately *not* firing, so the cooldown stayed at 0 and the next
`predict()` fired again, once per snapshot, at 20/s against a real rate of
2.3/s. Measured: **4.9x at 100ms of lag, 7.0x at 150ms**, median 0.050s between
drawn shots, which at Twin's 50 m/s muzzle speed is a shell every 2.5 metres —
exactly the stream in the playtest screenshot. It scales with ping, so it was
worst for the people furthest away. Reconciliation now replays the shot's effect
on the shooter (`tryFire({ dryFire: true })` — cooldown, charge and recoil, no
visuals). `tools/firerate.mjs` holds the ratio at 1.00.

The same bug was also half of "my shots do nothing": every extra was
`visualOnly`, so six shells in seven were phantoms that could not damage
anything by construction. And it silently defeats the seeded spread below — the
server keys a shot's seed to the input it fired on, and a client firing on
different inputs derives different seeds. Two symptoms, one cause, and the
particle counts in `config.FX` have been put back to where they were before any
of it was blamed on them.

**The client and the server were rolling the spread separately.** This is what
was left after lag compensation was fixed, and it is why playtest 2 still said
"looks like a hit, does nothing". Both ends run the same `weapons.js`, and the
design is sound — the client draws the shot, the server owns the outcome — but
spread came from a module-level RNG, and the two processes have unrelated
streams. One shot became two independent draws of the same distribution. At
Twin's 1σ = 0.05 rad that is 0.05·√2 of angular disagreement, **1.71m at 30m**,
measured — wider than a tank. The tracer was honest about the aim and lied about
the outcome, and roughly half of all marginal shots disagreed. The draw is now
keyed to `(shooter id, input seq)`, which both ends already agree on, so neither
has to trust the other's aim. Evasion spread had the same disease from a second
direction: it scales with the target's velocity, the server read the live body
velocity while the client's interpolated remote tanks have none worth reading,
so the two sigmas differed by up to EVASION.max — 0.055 rad, *larger* than
Twin's own spread. The server now rewinds velocity along with position, and the
client derives it from the snapshot pair it is blending.

**Ghost projectiles were still applying splash damage.** `_splash` was correctly
behind the `!p.ghost` check; the direct-hit bonus three lines below it was not.
So on a network client every Thunder shot — its own, and every remote shot
replayed from a `fire` event — applied real damage locally, which is exactly the
client-side combat that was supposed to have been deleted. It survived the
earlier fix because that branch reads as if it were only computing a bonus.

**A DEV diagnostic that answers a different question is worse than none.** The
`[diag] player shots` line ran on every tick the fire key was HELD, not per
shot. Twin fires once in 26 ticks, so it overstated the shot count ~26x and its
tank/wall/nothing ratios described ticks. The one instrument pointed at "do my
shots land" was quietly answering something else.

**A test that cannot fail is not evidence — and this one nearly shipped.**
`shotsync` first matched each observed shot to the nearest of ~600 candidate
seeds and reported 100%. Six hundred standard normals sit about 0.005 apart near
the middle of the distribution, so *any* value has a neighbour inside any
tolerance loose enough to absorb the wire rounding. It now matches a *chain* of
consecutive shots to seqs one firing interval apart from a single offset, and is
checked against a negative control: 25/25 with the seeding in, 2/26 with it
removed. The first strict version then failed for a fixture reason rather than a
code one — recoil slides the tank until it scrapes geometry and yaws, breaking
the aim reconstruction — which is the same trap as below, hit twice in one hour.

**A client must never resolve its own hits.** Running full combat client-side
produced three symptoms at once: hits flashed then vanished (server overwrote
them), bot shots were invisible (remote tanks never get `update()`), and the tank
jumped backwards (physics disagreement). The client now fires `visualOnly` and all
damage comes from server events; shots are broadcast as `fire` events so everyone
can see them. Correction dropped to 0.06m average with zero jumps over 50cm.

**Remote tanks' meshes must be told to move.** `interpolate()` sets the physics
body; the visual rig is only synced inside `Tank.update()`, which remote tanks
never call. Their bodies moved correctly while every mesh sat at the origin —
buried inside the central block, all nameplates stacked on one spot. It read as
"the bots are stuck in a wall"; they were 42m apart.

**The adaptive resolution controller was parked in the one band that judders.**
`frameAvg` measures WORK per frame — rAF's wait for vsync is not in it — so the
number to stay under is a 60Hz display's 16.7ms. The controller only reduced
quality above 20ms and only raised it below 11ms, and 14-18ms sits squarely in
that dead band: steadily dropping frames, never badly enough to trigger a
reduction. Playtest values were 14.5-17.6ms. Thresholds are now 13ms down / 8ms
up, which leaves headroom for a spike instead of spending it all on pixels;
measured 14.6ms → 11.3ms on the same scene, and 11.7ms with bloom on during an
explosion. Reconciliation was ruled out first, by measurement, not by guessing:
median snap 0.005m, p95 0.011m while driving and turning at 250ms of lag.

**A visual tell that rides only on bloom is not a tell.** Rail's charge was
communicated purely through `emissiveIntensity`, which reads as a glow only
because the bloom pass smears it. With bloom off (the `B` key) the wind-up was
effectively invisible — reported as "you can't see it charging, there's no
light". It now moves colour and scale as well, both of which survive without
post-processing.

**And nobody could see anyone ELSE's Rail charging.** The charge is in every
snapshot, but `interpolate()` dropped it and the ring is only redrawn inside
`Tank.update()`, which remote tanks never get. So the one shot in the game that
is designed to be visible coming arrived with no warning, in the exact case that
matters — an enemy charging at you. Third instance of this same shape (meshes
never moved, nameplates, now this): **state arriving in the snapshot is not the
same as something telling the visuals about it.** The tell now lives in
`Tank.syncChargeVisual()`, called from both `update()` and `interpolate()`, so a
fourth path cannot forget it.

**A post-process on your own screen cannot telegraph anything to an enemy.**
Bloom strength ramped 0.34 → 0.78 with your own charge, on exactly that stated
justification. It raised whole-screen bloom by 130% for the one player who
already knows they are charging, and playtest 5 called charging Rail blinding.
Bloom is constant now; the tell belongs on the tank, where an enemy can see it.
Ring emissive also came down from 6.5 to 3.5 at full charge.

**Nameplates with `depthTest:false` punch through walls** and collapse onto
whatever is in front of you. They are now hidden when the tank is occluded.

**Never size a worker pool to the workload.** The optimiser spawned one worker per
candidate — 16 on 8 cores — while the game was being playtested. Load average hit
30. It now defaults to 2 workers at scheduler priority 19.

**Verify the fixture before believing the result.** This cost more time than any
real bug. Repeated pattern: tests reported zero hits because tanks were placed
inside the central structure, off the firing line, or re-placed at spawn height
every tick so the muzzle sat a metre high and every shot flew over the target.

---

## 5. Deliberate decisions worth not re-litigating

**"Often shoots and takes no health off" was two separate causes, and neither
was hit registration.** Reported for a third time; the hit geometry and shot
sync were both already verified, so it had to be something else.

*The camera lagged the barrel by up to 32 degrees.* Camera yaw eased toward the
turret at 4.5/s, so while the turret key was held the barrel ran ahead by
traverse/4.5 and never caught up — 25° on Hunter+Twin, 32° on Wasp+Twin, which
is **9 to 13 metres sideways at 20m**. With no reticle the rule is "the barrel
is the reticle", but the player aims by the screen, so tracking anything meant
firing a third of a right angle off. The easing was justified in a comment by a
feedback loop — aim raycast from the camera, turret chasing that aim — that no
longer exists: the player drives the turret with Z/X and `aimPoint` is used only
by bots, which have no camera. **A constraint outlived the thing it protected.**
Yaw is now locked to the turret; measured error while turning: 0.0°. The same
bug was reported separately as "the turret turns faster than the camera" — one
cause, two complaints.

*And Twin at range does 2% of a health bar.* Damage falls from 34 at knife range
to 5 past 26m by design, but nothing on screen distinguished a 34 from a 5, so a
landed shot was indistinguishable from a miss. Floating damage numbers now show
the figure, dimmed and shrunk below 12 damage. The `hit` event already carried
`dmg`, so no protocol change was needed.

**A reload bar exists for every weapon, not just Rail.** The bar was built for
charge weapons and hidden otherwise, so with Twin or Thunder there was nothing
saying whether the trigger would do anything. Same bar, filled from cooldown
when there is no charge clock, and it goes accent-coloured when the gun is ready
so it reads peripherally.

**Fixed-step physics needs render interpolation, or it judders on any screen
faster than 60Hz.** The hull's drawn position only changed 60 times a second, so
on a 144Hz display the same pose was shown for two or three refreshes and then
jumped, while the camera — smoothed per rendered frame — glided. The tank
twitched against a smooth background. Reported as "it still jumps and dances"
and "the movement looks artificial, it moves abruptly", and it is also why
capping to 60 seemed like the answer: at exactly 60 every physics step lands on
one refresh and the problem disappears. Interpolating between the last two
physics poses fixes it properly and gets *better* the faster the display goes.
Measured motion unevenness at 144fps: **238% -> 0%**.

Three traps in it, all of which bit:

- **The pose must be captured at the END of the step.** `syncTransform()` runs
  at the top of `update()`, before the drive and the turret traverse, so
  capturing there recorded the pre-traverse turret angle — and `restorePose()`
  then wrote that back every frame and undid the rotation entirely. The gun
  stopped turning while `turretVel` sat at full rate. Found by printing the
  turret's world yaw and seeing it pinned at 0.0°.
- **The rig must be restored before the next step.** `turret.rotation.y` is
  simulation state, not a visual: traverse integrates onto it and
  `aimDirection()` reads it. Leaving a half-interpolated angle there feeds a
  wrong number back into the simulation every frame.
- **The camera has to follow the interpolated rig, not the body**, and its
  feed-forward has to be interpolated by the same alpha. Consuming a whole
  step's banked rotation the instant the step ran put the view ahead of a barrel
  still being drawn part-way through that step: 1.7° of shimmer at 144fps, on a
  build where the previous fix had already measured zero.

Final: 0.000° wobble on turret rotation at 60 and 144fps, 0.003° on hull
rotation, 0% motion unevenness at 60/90/120/144.

**The perf overlay was reporting headroom as frame rate.** It printed
`1000 / work-ms` as "fps", so 1.5ms of work read as 660fps and prompted a
reasonable "why is it running so high, it doesn't need to". rAF is vsync-locked
and never exceeded the display. It now shows the measured frame interval as fps
and labels the other number "ms work".

**A camera feed-forward must be integrated on the SIMULATION clock.** The first
version added `rate * dt` once per rendered frame while physics ran on a fixed
1/60 accumulator. At exactly 60fps those agree and nothing is wrong. At any
other rate some frames step the simulation and some do not, so the camera
advanced smoothly every frame while the barrel advanced in bursts, and the
catch-up term chased the difference — the two beat against each other and the
gun visibly shimmered while turning. Measured wobble: **0.00° at 60fps, 1.65° at
144, 1.18° at 90, 1.46° at 37.** The reporter's machine runs 118-145fps; a test
at 60 would have found nothing and declared it fixed. The commanded rotation is
now banked inside `simulate()` and consumed once per frame, which is exact at
every frame rate.

**Locking the camera to the turret was right for aim and wrong for feel.** With
yaw welded to the barrel, the camera also inherited every twitch of the HULL at
full amplitude — kerb strikes, tank-on-tank shoves, driving wobble — all of
which the old easing had been quietly absorbing. Reported immediately: "the
camera moves too sharply when I move the tank, it throws the whole frame
around."

The fix is feed-forward, not more easing. The rate the barrel is *known* to be
turning — hull angular velocity plus turret traverse — is integrated directly,
which costs nothing in lag because it is the actual motion rather than a
correction; a gentle pull toward the true angle then mops up whatever was not
commanded. Measured aim error: 0.00° holding full traverse, 0.00° turning the
hull hard, 0.8° with everything at once. Measured jolt response: a 17° hull
shunt arrives as 2.4° on the first frame and settles over half a second.
**Easing and lag are not the same axis** — feed-forward buys smoothness without
paying in accuracy.

**Acceleration limits, not fade durations.** Asked for a "very small fade" when
the turret stops, and then, correctly, for it to scale with speed. Both the
turret and the hull now ramp toward their target rate at a fixed angular
acceleration, so the settle is quadratic in how fast the thing was actually
turning: the turret coasts 7.5° from a full sweep, 1.9° from a half sweep and
0.3° from a flick; the hull 5.3°, 0.8° and 0°. A dab of steer still parks
exactly where you left it. Scaled by barrel length for turrets and by hull mass
for chassis, so a Rail feels heavier to swing than a Twin and a Mammoth heavier
than a Wasp — out of properties they already had.

The hull's rotation previously had **no** physics at all: `setAngvel` was
written straight from the input, so it reached full rotation on the frame the
key went down and stopped dead on the frame it came up, while its linear motion
had always blended toward a target. Balance impact of fixing it: twin-vs-rail
0.588 -> 0.525, timeouts 3 -> 2, TTK unchanged.

- **The camera fades cover; it does not climb over it.** It used to sphere-sweep
  a fan of steeper angles and take whichever bought the most distance. That kept
  it out of walls and cost the player the fight: backing into cover — which is
  where a duel happens — swung the view into a top-down shot and put the tank
  shooting at you off the bottom of the screen. Two humans, independently: "it
  hides the attacker." Framing now stays exactly where the player put it and the
  blocking geometry goes translucent. **Moving the camera to solve occlusion
  moves the picture; fading the occluder solves it and leaves the picture
  alone.** Two traps in doing it: the blocks share ONE material, so fading a
  mesh's material dissolves the whole arena (each block that fades gets a lazy
  clone), and the occlusion ray must be cast from the PLAYER outward, because
  three's raycaster respects `material.side` and a camera already inside a wall
  sees only back faces — the exact case that matters most. Emissive surfaces
  also need their `emissiveIntensity` zeroed: alpha alone left the centre
  structure's glowing trim as a teal wash that was harder to see past than the
  solid wall.
- **Aiming is rate control (`Z`/`X`), not a mouse cursor.** Mouse aim made the view
  chase the pointer and made turret traverse — a real weapon stat — unfeelable.
  A turret spin-up ramp gives fine control: a one-frame tap moves the aim ~2cm at
  40m, while holding still reaches full traverse.
- **No barrel elevation, no gravity, no vertical spread.** An arc means the shell
  obeys a *range* the player never chose; Thunder lobbed over targets directly in
  front of it. Flat trajectory makes "what the barrel points at is what you hit"
  literally true.
- **No aim reticle.** With a flat trajectory the barrel *is* the reticle.
- **Steering does not invert in reverse.** That is car logic; a tank steers by
  track differential.
- **Art last.** Every graphics decision made before the mechanics settle gets
  thrown away. When it starts: pick a direction first, then Blender + a
  text-to-3D tool. Shaders/lighting/VFX stay in code.

---

## 6. Tooling

```bash
node tools/report.mjs 14         # balance matrix for current config
node tools/validate.mjs 12       # baseline vs tuned on held-out duels
node tools/decompose.mjs         # where the residual imbalance lives
node tools/hulltest.mjs          # hull winrates in same-weapon mirrors
GENERATIONS=30 LAMBDA=14 DUELS=8 node tools/optimize.mjs   # sep-CMA-ES tuner
node tools/nettest.mjs           # two headless clients vs the real server
node tools/lagcomp.mjs           # lag compensation A/B (needs TANKI_DEV=1).
                                 # WEAPON=rail vs WEAPON=twin is the run that matters: it
                                 # shows compensation working for hitscan and ABSENT for
                                 # projectiles. Defaults to twin, which is why the old
                                 # reading of this tool was so weak. See §4a.
node tools/scores.mjs            # read the live scoreboard off the server
node tools/spreadsync.mjs        # client/server shot agreement, pure arithmetic
node tools/firerate.mjs          # shots drawn per shot fired (LAG_TICKS=9 to stress)
node tools/hitheight.mjs         # can every hull shoot every other hull? run after ANY
                                 # change to hull size, ride height or barrel height
node tools/gamemode.mjs          # teams, friendly fire, match end, reset — every check
                                 # has a control, incl. that the SANDBOX default is unchanged
node tools/matchlength.mjs 5     # how long a match actually runs. args: [matches] [target] [mode]
node tools/nodamage.mjs          # is the number on screen the damage that landed?
node tools/rangehit.mjs          # what a dead-centre shot is worth, by range, still vs moving.
                                 # Its fixture PROVES itself: a lane is only accepted after a
                                 # real rail shot has landed down it, so Rail-vs-stationary at
                                 # 100% in every column is a control, not a result.
node tools/corpseblock.mjs       # do dead tanks block shots? (has a negative control)
node tools/edgehit.mjs           # how far off-centre a shot still lands, vs the visible tank
npm run tunnel                   # throwaway public link, verified before it is printed
NO_SHOT_SEED=1 node server/index.mjs      # negative control for shotsync: 21/21
                                 # seeded, 3/22 unseeded. Run BOTH or the pass means nothing.
MODE=ffa node server/index.mjs   # the same server without sides
TARGET=20 node server/index.mjs  # a short match, for testing the END of one — the
                                 # banner, the intermission and the reset are three
                                 # minutes apart otherwise, and a path you can only
                                 # watch by waiting is a path nobody watches
BOTS=0 PORT=8100 node server/index.mjs   # …then, against that server:
PORT=8100 node tools/shotsync.mjs        # same question, end-to-end
```

`shotsync` deliberately simulates nothing. It sends inputs and does arithmetic
on what the server broadcasts back — the `fire` event carries the direction the
server *resolved*, so with the tank held still the spread it applied can be
solved for and compared against the seed the client would have used. No local
physics, no aiming, no hit detection, so there is nothing in it to be unfaithful
about. That is the shape every future netcode test here should take.

The optimiser scores every candidate on an identical seeded set of duels (common
random numbers), so within-generation ranking is near noise-free. Duels are staged
*inside* the band being measured. Hulls are excluded from the search by default.

---

## 7. Session log, in order

1. Prototype: tank rig, three weapons, three hulls, arena, bots, procedural art
2. Balance harness — headless duels in Node; refactored `Tank`/`arena` to run
   without a DOM
3. sep-CMA-ES optimiser over 22 weapon parameters + held-out validation
4. Playtest fixes: turret-following camera, bot whisker steering, Rail charge hint
5. Controls overhaul: `Z`/`X` turret, `Q`/`E` camera, flat trajectory, no reticle
6. Camera spring arm (sphere-cast, climbs over obstructions)
7. Performance: sprite pooling, adaptive resolution, capped telemetry buffer
8. Hull investigation → four falsified hypotheses → HP spread cut to 1.05x
9. Netcode: `Match` extraction, protocol, authoritative server, client
   prediction/reconciliation/interpolation, lag compensation
10. Server-side bots, scoreboard with assists, single-port hosting, deployment
    config, public tunnel
11. Netcode bug hunt from live playtest: query pipeline, visual-only client
    combat, mesh sync, nameplate occlusion, stuck-fire edge cases
12. Playtest 2 ("hits improved but not perfect", "still too dense"): seeded shot
    spread so both ends draw the same line, velocity-matched evasion spread,
    ghost splash damage, one impact per shot instead of two, `config.FX` density
    dial, DEV shot diagnostic corrected, `spreadsync` + `shotsync` added
13. Playtest 3 (screenshot: a stream of shells where one was fired): found
    reconciliation was not replaying firing, so the client re-fired once per
    snapshot — 5-7x the real rate, and the reason three rounds of density
    tuning never worked. `firerate.mjs` added; `config.FX` reverted to its
    pre-session values since the counts were never the problem.
14. Playtest 3 confirmed good. Loadout screen so two people can bring different
    tanks — `src/loadout.js`, no protocol change needed.
15. Playtest 4: spread cut ~3x (and the optimiser's bounds with it) so shots
    track the barrel; adaptive-resolution thresholds tightened to hold the 60Hz
    budget; Rail's charge tell made independent of bloom; centre-screen hit
    marker removed.
16. Playtest 5 ("aiming works now"): Rail's charge glow toned down and the
    global bloom ramp removed, and the charge tell made to show on OTHER tanks —
    it had only ever rendered on your own.
17. Phone support — `src/touch.js`, sticks + fire button + auto-fire, phone HUD
    and a loadout screen that fits a 360px-tall landscape viewport.
18. Phone playtest ("hard to play"): drive stick changed from tank controls to
    a camera-relative heading with a ghost hull showing it, and the camera pivot
    lowered so your own tank is not hidden behind the HUD.
19. `wraith`, an anti-grav hull that strafes — the actual answer to a thumbstick.
    New `strafe` input axis, hover spring, body-follows-gun, hover visuals.
21. Two-player playtest: camera fades cover instead of climbing over it; camera
    yaw locked to the turret (was 32° of aim error); damage numbers; reload bar
    for every weapon.
25. Playtest 9: hit box widened to the visible tank and the shell swept as a
    ball (corner hits); pickups given a description, a draining timer and the
    crate's own symbol — and made to actually reach the local player at all.
24. Air-dropped crates with timed abilities; deployed to Render with a self-ping
    keep-alive; corpse colliders, full respawn reset, spawn protection.
22. Camera yaw moved from locked to feed-forward + gentle catch-up (locked was
    too harsh when the hull moved); turret and hull rotation given acceleration
    limits so the settle scales with speed.
24. Render interpolation between physics steps (judder on >60Hz displays);
    perf overlay now reports real frame rate rather than headroom.
23. Feed-forward moved onto the simulation clock (was shimmering the gun at any
    frame rate other than 60); rotation ramps roughly halved after "too much
    resistance", and the inertia scaling square-rooted so the heavy end is not
    disproportionately sluggish.
28. **Lag compensation for projectiles**, which had never existed — see §4a.
    Shells are tagged with their shooter's rewind depth and flown through the
    world that shooter could see. Twin's hit retention at 400ms RTT: 40% → 77%.
27. **"Shots take no health off", fourth report.** Hit registration was clean;
    the damage READOUT was not — the screen reported the damage requested, not
    the damage dealt, so a spawn-protected target showed 175 and lost 0. Spawn
    protection also had no visual tell at all. Both fixed, plus `nodamage.mjs`.
    And `shotsync` was found to have been failing on correct builds since
    playtest 4 cut the spreads — see §4a; it now has a one-env-var negative
    control.
26. **Game modes.** Teams, a score target, a match end, an intermission and a
    full reset — the thing §8 had been calling the biggest gap. Friendly fire
    off through one gate on the one damage path, with a FRIENDLY tell so a
    blocked shot cannot read as a miss; bots ignore teammates; team spawns off
    the two halves of the existing spawn ring; team colours replace hull
    colours; a match bar, a grouped scoreboard and a result banner. Targets
    measured with a new `tools/matchlength.mjs`. Two bugs found by looking at
    it rather than by testing it: the client displayed its own score target
    instead of the server's, and on a phone the taller scoreboard ran through
    the FIRE button while the perf overlay was stuck on with no key to toggle
    it.
20. Playtest: the hover hull could neither hit nor be hit. Colliders grown to
    cover the turret, hover skirt added, ride height lowered; `hitheight.mjs`
    added. Uncovered a Rail imbalance that the bug had been masking.

**`config.js` is shared by the server.** A balance change needs the server
restarted, not just a rebuild — otherwise the two ends spread shots differently
and the seeding fix in §4 is defeated. The client bundle alone only needs
`npm run build`, since `dist/` is read from disk per request.

---

## 8. Start the next session by

Playtest 9 confirmed these are **no longer reported**: the tank
dancing/jumping, the snapback on stopping a turn, corner hits, and tank-on-tank
shaking. Do not go hunting them again without a fresh report.

**"I SEE the shell hit and no health comes off" — FOUND AND FIXED**, but no
human has played the fixed build. §4a has it: lag compensation only ever
covered hitscan, so a shell was resolved against a tank that had moved on by
`rtt + INTERP_DELAY`. Twin's hit retention at 400ms RTT went 40% → 77%, and
132% at 100ms where it had been 64%. **Ask whether it is gone before doing
anything else here.**

If it is NOT gone, the thing to suspect next is the leading problem in §4a,
which is separate and untouched: against a crossing target the two projectile
weapons essentially never connect past point-blank when aimed dead centre,
while the bots lead their shots. That one is a design decision awaiting a
choice, not a bug.

1. **Ask what still feels wrong**, then measure before changing anything. Every
   single fix this session came from a measurement that contradicted a
   hypothesis — see §4. Four separate times a plausible diagnosis was falsified
   by a test, and twice a *correct* fix was nearly discarded because the test
   could not exercise the case (a smooth sine steer never produces the
   discontinuity of releasing a key; forcing an effect locally bypasses the
   exact network path that was broken).

2. **Game modes are DONE** — teams, target, match end, intermission, reset, in
   both tdm and ffa. What is untested is how they FEEL with real people: nobody
   has played a full match to a win yet, and the two numbers most likely to be
   wrong are the score target (measured against bots, not humans) and the
   12-second intermission.

3. **The Wraith / Rail imbalance is still unexplained** (§4). It wins 87-89% on
   Rail. Two hypotheses were built and falsified. Per this project's own
   history, the next step is to instrument ONE duel rather than build a third
   hypothesis. Note also that bots never send `strafe`, so half of what that
   hull is cannot appear in the harness at all.

4. **Never trust a green test you have not seen fail.** Two tests here reported
   PASS while measuring nothing: `shotsync` matched each shot to the nearest of
   ~600 candidate seeds (any value has a neighbour), and `hulltest` reported
   Wraith at exactly 0.500 which was not balance but *both tanks unable to
   damage each other*. Both were caught by adding a deliberate negative control.
   Every test in `tools/` that matters now has one.

5. **If hits ever fail again**, the order is: `tools/corpseblock.mjs`,
   `tools/hitheight.mjs`, `tools/edgehit.mjs`, `tools/nodamage.mjs`, then
   `tools/shotsync.mjs` against a live server. Damage numbers are on screen now
   and they finally report what LANDED rather than what was requested (§4a),
   which separates "hit for very little" (range falloff), "hit a protected
   tank" (says PROTECTED), "hit a teammate" (says FRIENDLY) and "no damage at
   all" — four different things that used to look identical.

   And read §4a before believing `shotsync`: it spent this session reporting a
   confident FAIL on a build that was provably correct.

6. **If the visuals are too busy**, `config.FX` is one place and every count is
   in it — but read §4 first: three rounds of density tuning were spent on a bug
   that had nothing to do with counts. Run `node tools/firerate.mjs` and confirm
   the ratio is still 1.00 before touching them.
