# TANKI — prototype

Browser 3D tank arena. Three.js + Rapier physics, no external assets: every
texture, model and effect is generated in code at load time.

```bash
npm install && npm run dev
```

Then open http://localhost:5178.

| keys | |
|---|---|
| **W A S D** | drive |
| **Z X** | traverse turret |
| **Q E** | camera pitch (low, near-deck ↔ high, top-down) |
| **space** / click | fire (hold to charge Rail) |
| **1 2 3** | weapon |

Aiming is **rate control on the turret**, not a mouse cursor. Mouse aim made the
view chase the pointer and turned turret traverse — a real weapon stat — into
something you never felt. Driving the turret with keys means a slow turret is
slow in the hand, which is the point of it being a stat at all.

---

## What exists

- Tank rig built from primitives — chassis, glacis, treads with scrolling
  texture, road wheels, independently traversing turret, per-weapon barrels.
- Three weapons with genuinely different behaviour: `Twin` (fast kinetic
  projectiles), `Thunder` (arcing splash shell), `Rail` (charged piercing
  hitscan).
- Three hulls trading HP against speed and traverse.
- Five bots with an explicit skill dial driving aim error, reaction time,
  target lead quality and how well they hold their weapon's range band.
- Arena with cover tuned to produce all three engagement bands on one map.
- Damage falloff by range, splash with distance falloff, recoil impulse on the
  chassis, track decals, procedural sky, bloom.

## Architecture

The one structural decision that matters: **`simulate(dt, input)` in
`src/main.js` contains everything that decides a match outcome, and touches no
camera, HUD or renderer.** `present(dt)` holds all the presentation. Player and
bots both go through `Tank.update(dt, input)` with the same input struct — the
only difference is who fills it in.

That split is what makes the balance methodology below actually runnable: the
same code that plays the game can be driven thousands of times headlessly with
no renderer attached.

| File | Responsibility |
|---|---|
| `src/config.js` | **All balance numbers.** The tuner's input vector. |
| `src/tank.js` | Tank rig, physics body, drive, turret traverse, ballistics |
| `src/weapons.js` | Firing, projectiles, hitscan, damage resolution, telemetry |
| `src/bots.js` | Bot brain with a skill model |
| `src/arena.js` | Map geometry and colliders |
| `src/fx.js` | Pooled transient effects (skippable in headless runs) |

`window.TANKI` exposes `simulate`, `present`, and `runHeadless(seconds)` for
console-driven tuning and automated checks.

## Findings from the first tuning pass

Recorded because each one changes how the next pass should be run.

**Engagement bands must be derived from map geometry, not chosen by feel.**
Ray-sampling 40k random position pairs at turret height gives the probability
that two points can see each other:

| range | 0-10m | 10-20 | 20-30 | 30-40 | 40-50 | 50-60 | 60-70 | 80-90 |
|---|---|---|---|---|---|---|---|---|
| clear line | 69% | 54% | 37% | 26% | 17% | 12% | 9% | 6% |

The long band originally ran to 120m, giving Rail a preferred range of 80m —
where only 6% of the map can hold a line. Rail bots parked at their ideal
distance and fired **5 shots in 120 seconds**. Capping the long band at 55m and
adding "reposition when blind for >1.5s" took Rail from ~2% to 11% firing
uptime and it started scoring kills. Re-run this measurement whenever the map
changes.

**Arcing weapons need a ballistic solver, not a drop offset.** A mouse-aimed
player has no way to compensate for shell drop. `Tank._ballisticPitch` solves
the low root of the ballistic equation and elevates the barrel to put the shell
on the reticle: residual error is 9-38cm across 12-55m, inside a tank hitbox.
The remaining bias is because the solve launches from the turret centre while
the shell spawns at the muzzle — one Newton iteration would remove it.

**World matrices must be updated inside the sim, not left to the renderer.**
Aiming, muzzle position and the ballistic solve all read `matrixWorld`, which
three.js only refreshes during render. A headless run never renders, so every
shot would be computed off stale geometry. `Tank.update` now calls
`updateMatrixWorld` explicitly.

**Charge weapons cannot gate on instantaneous line of sight.** Any single frame
without LOS reset the charge, making a 1.6s charge nearly unlandable. Charge now
bleeds instead of dumping, and bot LOS has a 0.7s hysteresis window.

**The TTK target was imported from the wrong genre.** It started at 0.8-2.5s,
which is arena-shooter pacing and assumes hitscan weapons with near-permanent
line of sight. Measured firing uptime here is 10-30%, so even maximum damage
cannot approach 2.5s — the target was unreachable, and it grew to ~70% of the
optimiser's loss, starving the balance terms that are the actual goal. Corrected
to 3-7s. Worth stating plainly: a wrong constant in the objective wastes the
whole optimisation run, and it does so silently.

**Playtest feedback the metrics then confirmed.** First human session reported
Twin felt dominant and Rail never seemed to fire. The baseline matrix agreed:
Twin 68.9% overall and the strongest weapon in *all three* bands (80.5% close),
Rail 43.3% and not even winning its own designated band at 48.7%.

**Bots needed steering, not a stuck-timer.** Driving straight at the target and
flailing when wedged left bots pinned against walls 15.1% of sampled frames.
Whisker raycasts that trade heading error against open space cut that to 8.2%.

**The camera follows the turret, not the hull.** Trailing the hull meant
reversing or strafing swung the whole view. Following the turret puts the camera
where the gun looks — but aim is raycast *from* that camera and the turret
chases the aim, so the two form a feedback loop and the camera has to converge
strictly slower than the turret or the view oscillates.

## Multiplayer

```bash
npm run server          # authoritative server, prints the LAN URL to share
npm run dev             # then open http://localhost:5178/?online=1
```

### Playing from another device

Both machines on the same Wi-Fi. The server prints the address on startup:

```
play from another device on this network:
   http://192.168.1.42:5178/?online=1
```

Open that on the phone/laptop. Vite binds to all interfaces (`host: true`) and
the client derives its socket URL from `location.hostname`, so loading the page
from `192.168.1.42` automatically connects to `ws://192.168.1.42:8099` — there is
nothing to configure on the second device. macOS may prompt to allow incoming
connections the first time; that has to be accepted.

### Playing over the internet

```bash
npm run host                                   # build + serve everything on 8099
npx cloudflared tunnel --url http://localhost:8099
```

Cloudflare prints a public `https://…trycloudflare.com` URL. Send it with
`?online=1` on the end. That is the whole setup — no account, no port forwarding.

This works because the game server **also serves the built client**, so the page
and the socket share one origin. The alternative — vite on 5178 and the socket on
8099 — needs two tunnels on two different hostnames, and the client would have to
be told the second one by hand (`?server=wss://…` still does this if wanted).
One origin also means `wss://` comes free from the `https://` the tunnel already
terminates; a secure page cannot open an insecure `ws://` socket, so a split
setup breaks on that alone.

### Deploying for real

`Dockerfile` and `fly.toml` are ready. Fly.io, because it has first-class
WebSocket support and a Frankfurt region — the lowest latency to Israel of the
usual choices, which matters when the thing being tested *is* latency.

```bash
brew install flyctl
fly auth signup
fly launch --no-deploy      # reads fly.toml; pick a unique app name
fly deploy
```

Gives a permanent `https://<app>.fly.dev`. Share it with `?online=1`.

**This server is stateful and must never scale past one machine.** The match
lives in one process's memory, so a second instance is a second arena and
players split between them without any indication. `fly.toml` pins
`max_machines_running = 1` and disables auto-stop, since stopping the machine
ends the match everyone is in. Real scaling means separating match state from
the process — a room server plus a matchmaker — which is a different design, not
a config change.

`/healthz` reports tick, player and bot counts for platform health checks, and
SIGTERM closes client sockets with code 1001 so a redeploy shows a clean
disconnect instead of every client hanging until its own timeout.

The container installs production dependencies only — `three`, Rapier and `ws`
are runtime (the server runs the same simulation as the browser); vite is not.

Static file serving is deliberately narrow: paths are normalised and checked
against the dist prefix before opening anything. Verified — `/%2e%2e/package.json`,
`/..%2fpackage.json` and encoded `../../etc/hosts` all return 403/404 with no
bytes leaked, while ordinary assets serve normally.

### Scoring

Kill **10 pts**, assist **5 pts**. An assist goes to anyone who damaged the
victim within 8 seconds before it died and did not land the killing blow;
without it, focusing a target as a team rewards only whoever fired last. The
scoreboard is rebuilt from tank state every frame rather than tallied locally,
so online it shows the server's numbers and offline the same `Match`'s numbers —
one code path, no chance of a client tally drifting from the authority.

**Scores are counters, not interpolated state.** The scoreboard sat at zero for
every remote player while the server tallied correctly. Reconciliation only
restores the *local* tank, and `interpolate()` copies position and hp for remote
tanks but not their counters — so nobody else's kills ever reached the client.
They are now applied for every tank on every snapshot, outside the interpolation
path entirely, because a kill count is discrete and has nothing to blend.

**Nameplates drawn with `depthTest:false` punch through walls.** Several bots
behind one block render their labels stacked on the near face of it, which reads
as "all the bots are inside the wall in the same place" — they were up to 42m
apart and moving normally. Plates are now hidden when a ray from the camera to
the tank is blocked, and beyond 90m. Verified over 600 frames that this is
occlusion and not blanket hiding: one bot's plate was visible 598 frames, another
192 (moving through cover), another 0 (behind a block the whole time).

Worth recording: the first version double-counted every kill, because
`Tank.takeDamage` still incremented `kills` from before `Match` owned scoring.
The arithmetic gave it away immediately — total kills came to exactly **2x**
total deaths, while points (awarded once, in `onKill`) matched the true count and
so looked like the broken number. Checking two independent totals against each
other catches this class of bug in one glance.

Open the URL in two windows to play against yourself. Without `?online=1` the
game runs offline against bots, using the same `Match` class.

The server spawns bots of its own (`BOTS=4` by default) running the same
`BotBrain` as the offline game, so the first player to join is never alone in an
empty arena. To a client they are ordinary roster entries — nothing in the
protocol distinguishes a bot from a person.

| piece | file |
|---|---|
| shared authoritative simulation | `src/match.js` |
| wire protocol | `src/net/protocol.js` |
| server (tick loop, lag comp) | `server/index.mjs` |
| client (predict / reconcile / interpolate) | `src/net/client.js` |

**One `Match` class, run by both ends.** Prediction only works if the client
reaches exactly the state the server will reach from the same inputs, so there
is one simulation class, one fixed 60Hz step, and one seeded RNG. A separate
"client world" would drift the moment either side was edited. This is why the
codebase already had `simulate()` split from `present()` and a seeded RNG — both
were built for this.

**Three client jobs.** *Prediction* runs your input locally at once, so nothing
waits a round trip. *Reconciliation* snaps to the server's (older) state and
replays every unacknowledged input — invisible when the prediction was right.
*Interpolation* renders other players 100ms in the past, blending the two
snapshots that bracket that moment, because they arrive at 20Hz and we draw at
60+.

**Lag compensation** rewinds other tanks by `rtt/2 + INTERP_DELAY` before
resolving a shot, so you hit what you were aiming at. Both delays stack, and
rewinding by only one of them is a subtle bug that makes shots feel like they
need a fraction of a ping's lead. The cost is the familiar one: occasionally you
die just after reaching cover. There is no third option — only a choice of who
gets the benefit of the doubt.

**A removed tank is a use-after-free waiting to happen.** When a client
disconnects its rigid body is freed, but bot brains still hold it as their
current target and in-flight projectiles still hold it as their owner. Reading
`.position` from a freed body does not return null — Rapier's wasm traps and
takes the whole server down, which is exactly what happened on the first
disconnect. `removeTank` now marks `removed`/`alive=false` *before* freeing the
body, drops that tank's projectiles, and brains skip removed tanks when
targeting.

**A client must never resolve its own hits.** The first version ran full combat
locally: it fired, flew projectiles and applied damage to its own copies. Every
symptom of that showed up at once in the first real playtest —

* *"lots of shots but almost nothing lands"* — the client applied damage, the
  next snapshot overwrote it with the server's truth, so hits flashed and
  vanished
* *"my health drops but I never see the bot shoot"* — remote tanks never get
  `update()` (they are placed by interpolation), so the client never spawned
  their shots at all
* *"the tank sometimes jumps backwards"* — client and server physics disagreed,
  because the client was applying recoil and splash knockback for hits the
  server resolved differently

The client now fires `visualOnly`: the tracer appears instantly so the gun feels
responsive, but damage, knockback and kills come only from server events. Shots
are broadcast as `fire` events carrying muzzle origin and direction so every
other client can draw them. Measured after the change, while driving and firing
for 600 ticks: average correction **0.06m**, maximum **0.06m**, and **zero**
ticks with a jump over 50cm.

**A remote tank's mesh has to be told to move.** `interpolate()` sets the physics
body; the visual rig is only synced inside `Tank.update()`, which remote tanks
never call. Their bodies moved correctly around the map while every mesh sat at
the origin — buried inside the central block, invisible, with all four
nameplates stacked on one spot. It read as "the bots are all stuck inside a
wall"; they were up to 42m apart. `syncTransform()` is now callable on its own
and interpolation calls it.

**Releasing a mouse button is not one event.** Press on the canvas, drag outside
the window, release — `pointerup` goes to whatever is under the cursor and the
tank fires forever. `pointercancel`, `pointerleave`, `blur`, `visibilitychange`
and a `pointermove` check for `buttons === 0` all clear it now.

**Never trust the client.** Inputs are clamped to [-1,1] on arrival (an
unclamped throttle is a teleport, not a cheat to be detected later), exactly one
input is consumed per tick (draining the queue would be a free speed hack), and
the input backlog is bounded (an unbounded one is a memory-exhaustion vector).

### Verified

| | result |
|---|---|
| snapshot rate | 19.2/s (target 20) |
| input rate | 60/s |
| prediction window vs RTT | 0.9 unacked at 0ms → 24 at 400ms |
| prediction | drives the local tank with no server round trip |
| reconciliation | forced 6m desync corrected to 0.16m |
| hit registration | damage, kills and respawns all cross the wire |
| hit rate vs latency | 24 / 27 / 24 / 23 hits at 0 / 100 / 200 / 400ms RTT |

**Lag compensation: partially verified.** A/B with `NO_LAG_COMP=1`, shooter
aiming at the *interpolated* enemy position (what a real client renders):

| RTT | on | off |
|---|---|---|
| 0ms | 100% | 100% |
| 200ms | **56%** | 42% |
| 400ms | **63%** | 42% |

Roughly 1.4x more hits retained at high latency — directionally right, but a
weak signal. Two earlier versions of this test were wrong in instructive ways: a
shooter firing in a *fixed* direction never consults its delayed view, so
latency cannot affect it and compensation has nothing to do; and a shooter
aiming at the raw latest snapshot makes the server's rewind overshoot by a full
`INTERP_DELAY`, which reads as lag compensation making aim *worse* (11 hits vs
22 with it off). The client must interpolate for the server's rewind to line up.

The remaining noise is Twin's 0.05 rad spread — 1.2m at 24m, comparable to the
hull width being aimed at. Rail would isolate it (zero spread, hitscan) but its
2s charge yields only ~8 shots per trial, too few to resolve. A proper fixture
needs a purpose-built zero-spread, high-rate test weapon.

Building the *test* took far longer than building the netcode, almost entirely
on geometry: four separate runs reported zero hits because the tanks were placed
inside the central structure, off the firing line, or — the one that cost the
most — re-placed at spawn height every tick, so the muzzle sat a metre high and
every shot sailed over a Wasp. Verify the fixture before believing the result.

## Balance harness

```bash
node tools/report.mjs 14                    # measure current config.js
node tools/validate.mjs 12                  # baseline vs tuned, held-out duels
GENERATIONS=45 LAMBDA=14 DUELS=8 node tools/optimize.mjs
```

### Where the tuning stands

Refitted after projectiles went flat (λ=14, 30 generations), scored on 1080
held-out duels:

| | loss | winrate spread |
|---|---|---|
| before refit | 2.709 | 0.450 |
| after refit | **1.502** | **0.117** |

| weapon | overall | close | mid | long |
|---|---|---|---|---|
| Twin | 0.551 | **\*0.808** | 0.458 | 0.376 |
| Thunder | 0.516 | 0.406 | **\*0.546** | 0.600 |
| Rail | 0.434 | 0.285 | 0.496 | **\*0.524** |

**Weapons-only tuning has hit its floor, and the floor is hulls.** Decomposing
what is left (`node tools/decompose.mjs`):

| hull | winrate in same-weapon mirrors |
|---|---|
| Wasp | 0.104 |
| Hunter | 0.474 |
| Mammoth | 0.922 |

Nine same-weapon pairs — a quarter of all matchups — carry 47% of the residual
loss, and the worst nominally cross-weapon matchup is also Wasp against Mammoth.
No weapon parameter can reach any of it.

**Do not fix this by tuning hull numbers yet.** A light hull's whole case is
speed and evasion, and these bots strafe on a sine wave without ever dodging
incoming fire. The sim cannot express what a Wasp is *for*, so buffing Wasp HP
against this data would be fitting to a bot deficiency. Teach the bots to dodge
first, then let hulls into the search space.

### Result of the first tuning run (arcing projectiles, superseded)

30 generations of sep-CMA-ES, then re-scored on **1296 duels with a disjoint
seed range** the optimiser never saw:

| | loss | winrate spread | worst matchup |
|---|---|---|---|
| baseline | 2.277 | 0.328 | **0.000** |
| tuned | **0.584** | **0.067** | 0.833 |

Weapon winrate by band, held-out (`*` = designated band):

| weapon | overall | close | mid | long |
|---|---|---|---|---|
| Twin | 0.534 | **\*0.740** | 0.434 | 0.421 |
| Thunder | 0.467 | 0.429 | **\*0.502** | 0.470 |
| Rail | 0.499 | 0.332 | 0.564 | **\*0.609** |

Every weapon now owns its designated band and is beatable elsewhere. Before
tuning, Twin was the strongest weapon in *all three* bands and one matchup was a
0.000 total blowout. The improvement holding on unseen seeds is the evidence it
is real balance rather than a fit to the optimiser's own 864 fights.

`tools/duel.mjs` builds the real arena colliders and runs two real `Tank`s
driven by two real `BotBrain`s with no renderer — ~26ms per duel in Node. Both
bots use the same skill value, so a duel measures the loadout and not the pilot.

Duels are **staged inside the band being measured**: both tanks spawn in open
space at a sampled distance with a clear line between them. Without that, a
"long range" duel is just two bots driving at each other until they fight at
whatever range they happen to meet.

`tools/optimize.mjs` runs separable CMA-ES over 22 weapon parameters across 8
worker threads. Diagonal covariance, not full: 22 dimensions against a noisy
objective has nowhere near the sample budget to estimate 231 covariance terms.
Every candidate in a generation is scored on an **identical** seeded set of
duels (common random numbers), so within-generation ranking is near noise-free
even while absolute loss still wobbles.

Hulls are excluded from the search on purpose. Hull identity — fast-and-fragile
against slow-and-tough — is a design decision, not something an optimiser should
be free to flatten.

The objective is deliberately not "drive every winrate to 50%": that has a
trivial degenerate solution where all three weapons converge into the same gun.
Band-dominance and weak-somewhere terms are what keep them distinct weapons that
happen to be equal in aggregate.

## Next

1. **More map archetypes.** The harness runs one map. Bands derived from a
   single arena's sight lines will not transfer to an open map or a corridor
   map; the win-rate tensor needs a map axis before the numbers can be trusted
   generally.
2. **Netcode.** Authoritative server on the existing fixed 60Hz step, client
   prediction and reconciliation, lag compensation for Rail.
3. **Feel pass.** Sim measures balance, not fun — audio, screen shake, hit
   confirmation, and absolute TTK (target band 0.8-2.5s) need human playtesting.
4. **Assets.** Procedural geometry carries the prototype; real hulls want
   text-to-3D or modelled sources. Shaders, lighting and VFX stay in code.

**A minimum-distance floor will silently defeat camera collision.** The spring
arm correctly detected a wall 1.64m behind the tank, then a `CAM_MIN = 2.6`
clamp overrode it and placed the camera 1m *inside* that wall. When an obstacle
is nearer than the minimum, shortening the boom cannot help — the camera has to
leave that direction entirely. It now sphere-sweeps six boom elevations and
climbs over the obstruction instead, resting at 23.5° in the open and rising to
~83° against a wall. Measured occlusion at seven map positions: 0%.

**The optimiser balanced duels; the game is a free-for-all.** All tuning came
from 1v1 fights. A six-way scrum has different dynamics — in one 180s FFA the
Twin/Wasp bot took 12 of 19 kills despite duel winrates being level. Duel
balance is a necessary foundation, not the finished job.

**Hull balance was a design problem wearing a tuning problem's clothes.** Four
hypotheses were built, measured, and falsified in order: give Wasp more HP (at
*equal* HP it still only reached 0.415), more acceleration (4x responsiveness →
0.283), a hull turret modifier (no measurable change), and evasion spread that
widens with the target's angular rate (even at absurd values → 0.223).

Instrumenting one duel ended the guessing. At close range a Wasp **out-damaged**
a Mammoth — 8807 vs 8458 dealt, 20.9 vs 17.8 per shot — and lost 0-29, because
both took the same damage. Mobility was reducing incoming fire by about 4% while
the HP gap was 75%. An HP sweep put a number on it: **speed is worth roughly +5
to +9% winrate here.** Real, and nowhere near enough to buy 2.26x health.

So the HP spread was cut to 1.05x and hulls now differentiate on mobility.
Mirror winrates went 0.215 / 0.457 / 0.827 → **0.495 / 0.554 / 0.451**, and
overall loss fell to 0.168 with `identity: 0`. Scaling all three hulls' HP down
by 0.85 afterwards preserved the balance (it depends on ratios) while pulling
mean TTK from 8.3s to 7.4s.

The alternative was to keep the fantasy of a heavy tank and let hulls be
unbalanced in a straight fight, earning their value through objectives instead —
a Wasp is good in capture-the-flag, not in a duel. That option is still open and
becomes available once game modes exist.

Two behaviours were also removed after measurement: **orbiting** an opponent
inside their traverse envelope made the light hull strictly *worse*
(0.069 → 0.028 at close range), because diving inside also drags you into the
band where their damage peaks.

**Weapon-only tuning had hit its floor at hulls.** Every lopsided matchup left
is now a same-weapon, different-hull pairing: `twin/hunter` vs `twin/mammoth`
0.129, `rail/wasp` vs `rail/mammoth` 0.229. Mammoth wins mirrors decisively.
Hulls were deliberately excluded from the search — but there is a confound worth
naming before tuning them: a light hull's advantage is dodging, and these bots
strafe on a sine wave. **The sim structurally undervalues Wasp**, so hull numbers
should not be optimised against bots this crude.

**A hidden solver between the barrel and the shot destroys trust.** Arcing
shells used to have the barrel solve a ballistic elevation onto a mouse-aimed
ground point. It was mathematically correct and verified to 9-38cm — and it felt
broken, because Thunder would lob clean over a tank sitting directly in front of
the barrel. The shell obeyed a *range* the player never chose and could not see.
Both elevation and gravity are gone: shots fly straight and the aim marker is
drawn by the barrel's own raycast, so "what the barrel points at is what you
hit" is now literally true. Verified across 3 weapons × 3 ranges: 9/9 kills.

Vertical spread went with it. On a flat arena every target is at the same
height, so vertical scatter could only convert a good shot into a miss over the
target's head — variance with no decision attached. Horizontal spread still does
the real work of keeping a high-damage weapon honest at range.

**Physics changes invalidate tuning, and by a lot.** Removing vertical spread
roughly doubled effective accuracy — a weapon scattering in two axes now
scatters in one. The tuned config went from loss 0.615 to **2.778** overnight
with no parameter changed: Twin back to dominant in all three bands (0.842
close), Rail collapsed to 0.217. Any change to projectiles, hulls, map or bot
brain means re-running the optimiser, not adjusting numbers by hand.

**A sphere cast that starts inside geometry reports zero distance in every
direction.** Bot whiskers were switched from rays to sphere casts to stop them
clipping corners, sized off the hull's longest axis and centred at y=1. That
ball dips below y=0 into the ground collider, and with `stopAtPenetration` every
probe returned a zero-distance hit — so every bot believed it was walled in on
all sides, and the whiskers became actively worse than the rays they replaced.
Average measured forward clearance was **0.01m**. Sizing the ball off hull width
and lifting the origin to y=1.7 fixed it: clearance 9.41m, and time wedged
against geometry fell from 16.3% to **0.1%**. The lesson is that a broken sensor
reads as plausible behaviour — the bots looked stuck, not blind.

**Bots need to know they are being shot.** Target selection scored purely on
distance from the weapon's preferred range, so a bot would keep working on
whoever sat at its ideal distance while a player emptied a magazine into its
back. A *weighted* bonus for the attacker was not enough — an attacker across
the map still lost to a well-placed target. Being hit now selects the attacker
outright; skill sets the reaction delay (0.21s at skill 0.72, 0.34s at 0.45),
not whether the bot notices at all. Threat memory expires after 3s so they
cannot be baited into tunnelling forever.

**Never size a worker pool to the workload.** The optimiser spawned `LAMBDA`
workers — 16 of them on an 8-core machine — while the game was being playtested
in the browser. Load average hit 30 and the game stuttered badly. The game's own
frame cost was 2.56ms against a 16.7ms budget the entire time; nothing was wrong
with it. The pool is now `availableParallelism() - 2`. Measured cost with 40
bots is 0.9ms per simulate step, so the simulation has roughly 18x headroom —
the stutter was never the game.

**A lower loss can be a worse game.** The first run with hulls in the search
scored 0.652 on held-out duels against the previous 1.146 — a 43% improvement,
with weapon winrate spread down to 0.024. It was rejected. The reason is in the
band table: it produced a **Twin that was weakest at close range** (0.483) and a
**Thunder that was strongest there** (0.594). The optimiser discovered that
swapping two weapons' roles equalises winrates more cheaply than balancing them
in the roles they were designed for. Perfectly balanced, and nonsense — the
entire point of three weapons is that they answer different ranges. The
identity term now outweighs pair balance (34 vs 12) instead of sitting under it.

**Never let a background job compete with the game.** The tuner spawned one
worker per candidate — 16 on 8 cores — then `availableParallelism() - 2`, which
still held four cores solid for hours. It now defaults to 2 workers at scheduler
priority 19, so it only consumes cycles nothing else wants. The count matters
less than the priority.

**λ=8 was undersized for 22 dimensions.** The standard heuristic is
4+3·ln(22) ≈ 13; 8 was chosen to match core count, which is a convenience, not a
reason. The best result arrived at generation 13 and 17 further generations found
nothing better while sigma drifted upward — a search widening rather than
converging. The numbers in `config.js` are a real improvement, not a converged
optimum.

## Known gaps

- Bots don't use cover deliberately, coordinate, or discover exploits — the sim
  catches gross imbalance, never a subtle meta.
- Single map, no game modes, no scoring beyond a kill counter.
- Weapon numbers in `config.js` are tuned and held-out validated. Hull numbers
  are **not** — and should not be tuned until the bots can actually exploit a
  fast hull.
- Several weapon parameters sit on their bounds (`twin.damage`, `twin.falloffEnd`,
  `twin.minDamageFactor`, `thunder.damage`, `thunder.minDamageFactor`), meaning
  the optimiser wanted to push further. Bounds are where design intent lives, so
  a pinned parameter is a question for a designer, not automatically a bug.
- sigma more than doubled over the run (0.20 → 0.43): the search was still
  widening at generation 30, not converging.
