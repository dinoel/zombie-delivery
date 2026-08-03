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

## 2. Load order

`namespace → core → quality → audio → car-physics → environment → world → physics → input →
gameplay → lighting → entities → render → net → main`

Dependencies only ever point backwards. `net.js` loads after `render.js` and before `main.js`, so
**gameplay cannot call into net** — that is why cosmetic messages travel as district state
(`g.events`) rather than as function calls.

`gameplay.js` is ~2500 lines and about a third of the codebase. That is uncomfortable but it has
never been the thing slowing work down; see §7.

## 3. The five decisions everything else hangs off

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

## 4. The two regression gates

| Gate | How | Value |
| --- | --- | --- |
| Rules | `node tools/test-sim-determinism.js` | `d8b56a9f` |
| Picture | browser, by hand: `index.html?2d&qa=frame-hash`, press START, read `document.getElementById('c').dataset.frameHash` | `40e87878` |

The digest hashes the whole dynamic state after a scripted 13-second district. **Moving a single
random draw shifts every later draw with it**, so a refactor that changes the *number or order* of
`Math.random()` calls will move it even if behaviour is identical. Threading an argument is free;
hoisting a loop is not, if a random call crosses the hoist.

The pixel hash is not pinned in a file — compare before and after by hand. The mode pins quality,
a dry night and mute, because all three silently change where later draws land.

## 5. The test harness — three layers

- **`tools/browser-sandbox.js`** — a browser stub good enough to load the real subsystems under
  node. Deliberately does *not* pass the host realm's `Math`.
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
    question about where the horde walked while it was being asked.
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

**A new thing in madness out-clearing the spawner.** The horde caps at 64 live off a 96-deep
bench. The patrol machine gun pulled more horde onto itself than it could kill; a wreck blast
disabled every car within 400 px and turned the roads into a scrapyard; the flamethrower panicked
bodies before the stream could soak them. **Measure with `balance.js` before believing a number.**

**The measurement rig breaking and looking like a result.** Eight times in one sitting. See §5.

**Shell escaping.** Backticks and quotes inside `node -e` and PowerShell get eaten; a here-string
closing `'@` must sit at column 0. Write a file with the Write tool and run that instead.

## 7. What is actually slow, and what is not

The module split is fine and pays off — the flamethrower cost **one bit** on the wire because the
net contract already existed. Splitting `gameplay.js` further would fight real coupling: burning
touches the zombie steering chain because burning *is* an AI state.

Time goes to: the balance loop (worth it, the first numbers are always wrong), and — before
`scene.js` existed — debugging the test rig. If work feels slow again, look there before looking
at the module graph.

## 8. History, newest first

| Commit | What it established |
| --- | --- |
| roofs *(uncommitted)* | Fire escapes, roof state, bullets that fly over ground cover |
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
- **Do not do browser verification.** No pixel-hash runs, no canvas captures. The user looks at
  the result and sends screenshots.
- **Do not spawn subagents** unless asked.
- Declined already, do not re-propose: a relay POST endpoint for canvas dumps, a pinned pixel
  hash, a dedicated QA scene.

## 10. Where the roof feature stands

Implemented and syntax-checked only — **nothing has been run.**

Ladders on ~1 in 4 houses (`LADDER_*` in `world.js`); `E` climbs and descends, 0.9 s rooted;
`p.roof` holds the house; `keepOnRoof` clamps to the parapet; zombies cannot touch a roofed
courier but still gather and still throw; bullets get `b.high` and skip solids, trees and traffic;
fog opens 1.7× further; the roof index rides in the player snapshot row.

Known gaps: **a courier on a roof looks identical to one on the street** (no raised shadow or
scale), and the guest gets `climb` but plays no climbing animation.

Expect `test-sim-determinism` to move — the shared bullet path and zombie perception both changed.
`test-snapshot` needs the player row's two new numbers. Re-pin the digest deliberately.
