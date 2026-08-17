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
| over the internet | `npm run host` then `npm run tunnel` | it prints a link it has already tested |
| on a phone | open that same URL — touch controls appear on their own | force with `?touch=1`, force off with `?touch=0` |

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

**The one structural decision everything rests on:** `Match.step(inputs)` contains
everything that decides an outcome and touches no renderer. Server and client run
the *same class*. A separate "client world" would drift the moment either side
was edited.

---

## 3. Current state

### Works and is verified
- Offline play vs 5 bots; online play vs server bots and other humans
- Authoritative server at 60Hz, snapshots at ~19-20Hz, inputs at 60/s
- Client prediction (moves with no round trip), reconciliation (forced 6m desync
  corrected to 0.16m), interpolation of remote tanks
- Scoreboard: kill 10 pts, assist 5 pts (assist = damaged the victim within 8s
  and did not land the kill). Verified arithmetic over 180s of bot combat.
- Weapon balance tuned by optimiser and validated on held-out duels
- Deployment ready: `Dockerfile`, `fly.toml`, `/healthz`, graceful SIGTERM
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
1. **Game modes** — teams, match end, win condition. Turns a sandbox into a
   game. This is the next real one: two players with different tanks now works,
   and what is missing is something to *win*.
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
node tools/lagcomp.mjs           # lag compensation A/B (needs TANKI_DEV=1)
node tools/scores.mjs            # read the live scoreboard off the server
node tools/spreadsync.mjs        # client/server shot agreement, pure arithmetic
node tools/firerate.mjs          # shots drawn per shot fired (LAG_TICKS=9 to stress)
node tools/hitheight.mjs         # can every hull shoot every other hull? run after ANY
                                 # change to hull size, ride height or barrel height
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
20. Playtest: the hover hull could neither hit nor be hit. Colliders grown to
    cover the turret, hover skirt added, ride height lowered; `hitheight.mjs`
    added. Uncovered a Rail imbalance that the bug had been masking.

**`config.js` is shared by the server.** A balance change needs the server
restarted, not just a rebuild — otherwise the two ends spread shots differently
and the seeding fix in §4 is defeated. The client bundle alone only needs
`npm run build`, since `dist/` is read from disk per request.

---

## 8. Start the next session by

1. **Game modes.** Shots and loadouts are settled; there is still nothing to
   win. Teams, a score target, a match end, and a scoreboard that resets.
2. Asking whether the loadout screen and the phone controls survived contact
   with a second human — both were verified with browser tabs and touch
   emulation, never with two people on two devices. **No real phone has run
   this**; emulation cannot tell you about thumb reach, sustained frame rate on
   a mobile GPU, or whether auto-fire feels like help or like the game playing
   itself.
3. Auto-fire is currently touch-only and always available there. If a phone
   player ends up dominating keyboard players, that is the first thing to look
   at — it removes a real skill (timing) that desktop players still pay.
4. If hits ever fail again: run `PORT=8100 BOTS=0 node server/index.mjs` and
   `PORT=8100 node tools/shotsync.mjs` first — that isolates whether the two ends
   still describe the same shot. If they do, the remaining suspect is the rewind
   itself, not the shot: run with `TANKI_DEV=1` and watch `[diag] player shots …`
   for what each ray saw after the rewind (now counted per shot, not per tick).
5. If the visuals are still too busy, `config.FX` is one place and every count
   is in it. But read §4 first: three rounds of density tuning were spent on a
   bug that had nothing to do with counts, so before touching them run
   `node tools/firerate.mjs` and confirm the ratio is still 1.00.
