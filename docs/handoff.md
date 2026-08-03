# COURIER — picking this up cold

Read this before touching anything. It is what one long conversation learned, written down so the
next one does not have to learn it again. `README.md` describes what the game *is*; this describes
what the code *demands*.

---

## 1. Hard rules

Break any of these and the project stops being what it is.

- **Vanilla JS. No dependencies, no build step, no resource files.** No audio files, no images —
  every sound is synthesised in `audio.js`, every sprite is drawn in code.
- **Ordered classic `<script>` tags**, so double-clicking `index.html` off the disk still plays.
- **One global `window.TownGame`.** Each file registers one subsystem and freezes its public API:
  `window.TownGame.x = (() => { … return Object.freeze({…}); })();`
- **The `?v=` cache tag is duplicated** in `index.html` and in `tools/verify.ps1`. Bump both or
  verification fails.
- **No Cyrillic anywhere in the project.** All source, comments and docs in English. Enforced.
- **Comments explain why, not what.** Every non-obvious number has the reason beside it, usually
  the measurement or the bug that produced it. This is the house style and it is load-bearing —
  most of the constants in the game were arrived at by measuring something.
- **Every tuning number lives in `config.js`, and its reason travels with it.** No module declares
  a settings constant of its own any more; it takes what it needs off `window.TownGame.config`.
  `core` is not a settings API and must not grow back into one — it exports the canvas, the
  helpers and `runtime`, nothing tunable. What legitimately stays in a module is what is not a
  setting: a module reference, a maths constant, an event enum, a value derived internally from a
  setting (`FW` from `FCELL`), or geometry a subsystem is defined by (the deformable car mesh).

## 2. Load order

`namespace → config → core → quality → audio → car-physics → environment → world → physics →
input → gameplay → lighting → entities → render → net → main`

Dependencies only ever point backwards. `net.js` loads after `render.js` and before `main.js`, so
**gameplay cannot call into net** — that is why cosmetic messages travel as district state
(`g.events`) rather than as function calls.

`gameplay.js` is ~3000 lines and about a quarter of the codebase. That is uncomfortable but it has
never been the thing slowing work down; see §7.

## 3. The decisions everything else hangs off

**Host-authoritative co-op.** One browser runs the simulation, the other watches. Lockstep was
considered and rejected: ~325 RNG sites share one global `Math.random`, and the *number of draws
per frame* changes with local mute state, graphics quality and camera position. Two peers would
desync in seconds.

**The district is grown from a seed, never sent.** `g` is not serialisable — a 2450×2450 canvas, a
closure, a 30k-float fog grid. Both peers wrap `buildTown` in a seeded `Math.random` and then
compare `layoutChecksum`. Restore the *previous* `Math.random`, not the native one.

**The entity roster is fixed at district creation.** A snapshot names entities by an id the far
end already holds and only ever updates what it has. Nothing is created mid-district except
bullets, filth, cash, ammo boxes and severed parts. This is why madness has a **reserve bench**:
arrivals come off it and bodies go back onto it, so a growing horde is still a fixed roster.

**Rules vs presentation.** `update(g, dt)` is the rules; `presentFrame(g, dt)` is everything a
watching peer owns — its ears, weather, fog, smoke, sparks, screen shake, HUD. The pieces were
extracted **in place**, because several are position-sensitive (rings age before a siren pushes
one, smoke ages between the traffic and the parcels, fog opens before contacts move anybody).

**Screen shake is per-screen, never streamed.** `shakeAt(g, x, y, power)` — each peer works out
how much of an event it felt from where its own courier is standing. The event travels; the
feeling does not.

**A courier who is not on the street is one field and one index.** Two features put a courier
somewhere the street rules do not reach — `p.roof` holds a house, `p.car` holds a car — and the
second was cheap because the first had drawn the shape. Everything follows from testing that one
field: nothing walking can touch them, nothing is within reach of their hands, and the field rides
the player snapshot row as **an index into a roster the far end already holds**, because houses
come from the seed and the car roster is fixed at district creation. That is the whole of either
feature on the wire. The horde is never allowed to simply lose interest, though — a place that
cannot be reached and cannot be punished is a button that ends the district. It gathers under a
roof and anything that throws still throws; it takes a car apart by hand through `foeCar`. A third
such place should follow this rather than invent a fourth shape.

## 4. The two regression gates

| Gate | How | Value |
| --- | --- | --- |
| Rules | `node tools/test-sim-determinism.js` | **stale — must be re-pinned, see §10** |
| Picture | browser, by hand: `index.html?2d&qa=frame-hash`, press START, read `document.getElementById('c').dataset.frameHash` | `40e87878` |

The digest hashes the whole dynamic state after a scripted 13-second district. **Moving a single
random draw shifts every later draw with it**, so a refactor that changes the *number or order* of
`Math.random()` calls will move it even if behaviour is identical. Threading an argument is free;
hoisting a loop is not, if a random call crosses the hoist.

The pixel hash is not pinned in a file — compare before and after by hand. The mode pins quality,
a dry night and mute, because all three silently change where later draws land.

## 5. The test harness — three layers

- **`tools/browser-sandbox.js`** — a browser stub good enough to load the real subsystems under
  node. Deliberately does *not* pass the host realm's `Math`. It loads `config.js` itself, ahead of
  whatever module list it is given, because config has no dependencies and everything is written in
  terms of it — a new test cannot forget it.
- **`tools/scene.js`** — a district you can drive: `step`, `hold`, `present`, `tap`, `place`,
  `scatter`, `courierAt`, `quiet`, `immortal`. **Use this.** It is where the traps are written
  down, and every one of them cost a debugging round trip to find:
  - input goes through `runtime.keys` or real key events, **never** onto `p.in` — the record is
    rebuilt from the devices at the top of every frame;
  - `immortal` holds `inv` just under 1.2, because above that the damage vignette paints the whole
    canvas red and anything reading pixels reads the harness;
  - `scatter` spreads bodies out, because piled on one point they start grudges and kill each
    other;
  - `place` freezes a body by default, because a question about the shape of a cone is not a
    question about where the horde walked while it was being asked;
  - `scatter`'s default corner is *outside the world*, and the zombie update clamps every body
    straight back to the border — so it does not empty the street, it builds a pile in one corner.
    For a question that is not about the horde, set `g.zombies.length = 0` instead.
- **Anything that drives a car needs the district border kept in mind.** A straight run at 160 px/s
  crosses from the middle to the edge in about six seconds, at madness speeds in four, and the
  border clamp then holds the car still. Two separate probes reported "top speed 1 px/s" and
  "the car stops after two seconds" before this was noticed; both were measuring the border. Reset
  the car to the middle each second and take the peak, or clear `g.solids` and the rest of
  `g.cars` when the question is about one car's handling.
- **`tools/balance.js`** — `node tools/balance.js` plays madness three ways and prints what the
  street does. For questions a unit test cannot ask.

`test-sim-determinism.js` deliberately does not use `scene`: its value is a pinned constant and it
drives its own scripted input.

**Timing:** the full suite is ~7.5 minutes, of which `test-madness.js` alone is 288 s because it
plays 12.5 minutes of district frame by frame. A frame costs 0.14 ms empty, 2.6 ms on a night
shift, 8.7 ms in madness at the cap — it scales with entity count, not with the sandbox. Run one
test, not all of them, unless the change is broad.

## 6. Failure patterns that have already happened twice

**A value two paths raise and one path lowers.** Presentation is allowed to raise things
(`copFlash` from a replayed shot, `g.shake` from a replayed blast) but the winding-down lived in
`update`, which a guest never runs. Result: the flash stuck, and the screen shook forever.
*Anything presentation may raise, presentation must be able to lower — in `presentFrame`, before
`playEvents`.*

**Scaling the wrong quantity.** A wreck's shake was written as four times a head's because four
times was right for everything else about that blast. `g.shake` is multiplied by 7 and added to
the camera in pixels, so 14 meant the screen jumping half its width for five seconds. `shakeAt`
now caps at `SHAKE_MAX`. Ask what a number feeds into before multiplying it.

**Two owners writing one value every frame, settling somewhere neither meant.** `driveBody` takes
the throttle off a car whose driver has lost control; the traffic model was putting it back on in
the same frame. They balanced at 48% of the target speed — 70 px/s against a `LOST_SETTLE` of 34 —
so the "slow enough to gather it up" exit was unreachable on any road, every slide ran its full
six-second timeout, and for all six seconds the car ignored the lane. This is the sibling of the
pattern above and harder to see: nothing sticks at a maximum, it just quietly sits at a number
that is not in any of the code. *If two places write one field every frame, work out the fixed
point before assuming one of them wins.*

**Asking the plan where the body is.** A car carries a plan (`c.edge`, `c.s`, a turn arc) and a
body, and they stop agreeing the moment anything shoves the car. Three separate bugs came from
reading the plan and believing it was the body: the corridor scan probed the lane, so a car in a
garden braked for traffic on a road it was not on; the turn trigger measured `left` from `c.s`,
which `anchorToEdge` pins to the end of the road once the body is past it, so a stranded car had
`left = 0` for ever and started a fresh arc every frame; and the arc advances at the car's own
speed, so one that stopped inside a turn never left it. *Anything asking "where is this car" wants
the body. The plan only says where it meant to go.*

**A local search answering a global question.** `anchorToEdge` is a hill-climb with steps of 32,
16, 8, 4 and 2 — it can travel 62 px from where it is started, which is right for tracking a body
that moves a few pixels a frame. `nearestLane` called it from the middle of each 530-px road, so
it was comparing roads by how close their middle quarter came: the wrong road 11% of the time. The
function was not wrong; the question was. *Check the reach of a search before reusing it.*

**A new thing in madness out-clearing the spawner.** The horde caps at 64 live off a 96-deep
bench. The patrol machine gun pulled more horde onto itself than it could kill; a wreck blast
disabled every car within 400 px and turned the roads into a scrapyard; the flamethrower panicked
bodies before the stream could soak them. **Measure with `balance.js` before believing a number.**

**The measurement rig breaking and looking like a result.** Eight times in one sitting, and three
more since — `scatter` piling the horde into a corner for the traffic to drive through, and twice
the district border reading as a top speed. See §5. It has never once announced itself; it always
arrives as a plausible number.

**Reaching for the obvious correction and getting the sign right but the shape wrong.** A car that
has strayed should aim harder at its lane, so the look-ahead was pulled in. That is backwards: a
car 100 px out aiming 20 px along the lane asks for ninety degrees, cannot hold it, crosses the
lane and asks for ninety back — cars orbited a lane point at walking pace and time spent off the
road tripled. Coming back is an intercept, so the aim is pushed *out* by the error. The same shape
appeared again with the steering keys: full lock is what a keyboard asks for and what no driver
uses at speed. *Measure the correction, not just the direction of it.*

**Shell escaping.** Backticks and quotes inside `node -e` and PowerShell get eaten; a here-string
closing `'@` must sit at column 0. Write a file with the Write tool and run that instead.

## 7. What is actually slow, and what is not

The module split is fine and pays off — the flamethrower cost **one bit** on the wire because the
net contract already existed, and a courier driving a car cost **one number**, for the same reason.
Splitting `gameplay.js` further would fight real coupling: burning touches the zombie steering
chain because burning *is* an AI state.

The separation that paid best was not between files. `rollCar` is a body, `driveBody` says in as
many words that it is one step of a car whether or not anybody is driving it, and the traffic model
is only one of the things that can hold the wheel. Because that line was already drawn, adding a
player driver added a driver rather than a vehicle. Keep it drawn.

Time goes to: the balance loop (worth it, the first numbers are always wrong), and — before
`scene.js` existed — debugging the test rig. If work feels slow again, look there before looking
at the module graph.

## 8. History, newest first

| Commit | What it established |
| --- | --- |
| `62fa61d` | This document brought level with the code |
| `8e4bae7` | Traffic stays on the road; the courier can take a car |
| `d9d17bb` | Roofs and ladders; this document |
| `4569435` | Shake decays in `presentFrame`; `SHAKE_MAX` cap |
| `7bbdbbe` | Relay `--debug` / `=full` / `=tally`, off the forwarding path |
| `8853e7b` | `scene.js` and `balance.js`; six tests migrated, −110 lines |
| `7fe6a74` | Flamethrower: a cone query, not an entity. One bit on the wire |
| `94eba49` | Wrecks burn 30 s then explode; shared `blastWave` |
| `811d553` | Madness patrol heavy machine gun, piercing rounds |
| `da6e5a5` | Madness: free rounds, arrivals off a reserve bench |
| earlier | Co-op in nine stages; lamps, infighting, tracers, gunshot audio |

## 9. Working agreement

- **Do not run tests without being asked.** Write the code, say what should be checked and which
  test covers it, hand it over.
- **Measuring is not testing, and it is wanted.** The line that has held in practice: the suite is
  the user's to run, but a throwaway probe answering one question is how the numbers in this
  codebase get chosen. Writing a rig, sweeping a constant over four values and keeping the one the
  numbers pick is the house method — `CAR_YAW_MAX`, `CLAW_IMPACT` and the off-road throttle were
  all found that way, and the first guess was wrong every time. Put the probes in a scratchpad, not
  in `tools/`, unless they earn a place there.
- **Do not do browser verification.** No pixel-hash runs, no canvas captures. The user looks at
  the result and sends screenshots.
- **Do not spawn subagents** unless asked.
- **Commit straight to `main`.** One person develops this; a feature branch is ceremony with
  nobody on the other side of it.
- Declined already, do not re-propose: a relay POST endpoint for canvas dumps, a pinned pixel
  hash, a dedicated QA scene.

## 10. What has not been run

**The suite has not been run since `4569435`.** Three pieces of work have landed on top of it, all
of them touching the rules. Nothing below is known to be broken; it is simply not known to be
sound, and the next conversation should not read green as given.

**Re-pin the digest once, deliberately, rather than three times.** It is going to move: roofs
changed the shared bullet path and zombie perception, and `8e4bae7` changed car speeds, steering
and positions across the board. No `Math.random()` call sites were added or reordered in
`8e4bae7`, so the *order* of draws is intact and the move is from positions alone — but that still
moves it. Run it, read the district, and pin the answer.

Worth running, in this order:

- `test-sim-determinism.js` — will move. Re-pin.
- `test-car-damage.js` — the siege was split from the run-over, and hitting a solid is now measured
  along the contact normal rather than from raw speed.
- `test-snapshot.js` — compares field values rather than row length, so the roof's two numbers and
  the car's one should pass unremarked. Confirm rather than assume.
- `balance.js` — the patrol path was deliberately left alone, but traffic flow is not what it was:
  off-asphalt time went from 33.2% of car-frames to 7.1% and mean speed from 96 to 109 px/s.

**Roofs** (`d9d17bb`) — still never run. Ladders on ~1 in 4 houses (`LADDER_*` in `world.js`); `E`
climbs and descends, 0.9 s rooted; `keepOnRoof` clamps to the parapet; bullets get `b.high` and
skip solids, trees and traffic; fog opens 1.7× further. Known gaps: **a courier on a roof looks
identical to one on the street**, and the guest gets `climb` but plays no climbing animation.

**Driving** (`8e4bae7`) — exercised by a purpose-built rig, not by the suite. Known gaps, all
declared rather than discovered: a guest drives about 100 ms behind because its own body is not
predicted; a guest does not see the `E` prompt over a car, because prompts are computed host-side
(the takedown prompt has always had this); and a patrol car under a player runs with no siren and
no roof gun, both of which live in the traffic model that a driven car skips.

Tuning constants, if the feel is wrong — all three were chosen by sweeping, so change them the same
way: `CAR_YAW_MAX` and `CAR_TOP_MADNESS` in `gameplay.js`, `MADNESS_DRIVER_DURABILITY` and
`CLAW_IMPACT` in `environment.js`.
