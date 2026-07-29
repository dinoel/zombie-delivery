# COURIER — Refactored Edition

This is a standalone working version of the game originally stored in `town (1).html`. An English translation of the legacy monolith is preserved in `reference/town.original.html`.

## Running the game

Open `index.html` in a modern browser. The project does not require packages, a build step, or an internet connection.

Add `?2d` to the URL to force Canvas 2D lighting instead of WebGL.

Quality is selected on the start screen. `AUTO` uses the medium profile when WebGL is available and the low profile with the software Canvas 2D renderer. The selection is saved between runs.

## Verification

Run this command from PowerShell in the project directory:

```powershell
.\tools\verify.ps1
```

The script checks JavaScript syntax, referenced resources, subsystem registration, and the absence of Cyrillic text. Node.js is required for syntax checks, but not for the game itself.

The vehicle damage model has a separate deterministic test:

```powershell
node .\tools\test-car-damage.js
```

It covers plastic body-node displacement, replacement of the original collision outline with the deformed outline, moderate and catastrophic frontal crashes, side-part damage, and final failure after repeated zombie impacts. Visual states can be compared in `tools/car-damage-preview.html`. To inspect smoke and the crumpled physical wreck in the game, open `index.html?2d&qa=car-damage`; a test vehicle will appear in the starting beam. Normal gameplay never enables this mode.

## Keeping the district reproducible

Two checks exist so the simulation can be rearranged without changing what it does. Both run under plain `node` through `tools/browser-sandbox.js`, a shared stub that loads the real subsystems with no browser present.

```powershell
node .\tools\test-seeded-town.js
node .\tools\test-sim-determinism.js
node .\tools\test-coop-rules.js
node .\tools\test-presentation.js
```

`test-seeded-town.js` asserts that one seed builds one district — roads, houses, lamps, traffic, the horde, parcels and their addresses, down to the per-object seeds that decide a roof colour — and that the random stream lands in the same place afterwards. `test-sim-determinism.js` runs a scripted thirteen-second district and hashes the entire dynamic state, pinning the result. A refactor that moves a single random draw shifts every later draw with it, and the digest notices. `test-coop-rules.js` covers what only exists with two couriers, and is described with the shift below.

The picture has its own check, which is run by hand because the answer depends on the browser doing the drawing. Open `index.html?2d&qa=frame-hash`, press start, and read `document.getElementById('c').dataset.frameHash` after a few seconds: it seeds the town, runs 300 steps of a fixed input script off the animation clock, and hashes all 403,200 pixels. Compare the value before and after a change.

The mode pins three things that would otherwise decide the answer without appearing to. The quality profile, because it sets the light budget, the shadow count and the fog cadence. A dry night, because the rain field is filled when `environment.js` loads, before anything can seed it. And the sound, muted — not because sound is visible, but because several voices draw from the same random stream as the town and a muted engine returns before it draws, so the mute setting quietly moves every later draw. Two runs only compare if they agree about all three.

## Building a single file

The game is developed and played from source; the bundle is only for handing it to someone as one file.

```powershell
node .\tools\build.js
```

The script reads the load order out of `index.html`, so a new subsystem is picked up without editing the build. It inlines the stylesheet, minifies the JavaScript with terser, and writes `dist/courier.html` — one self-contained file with no external references, which still opens over `file://`. Property names are never mangled, since they reach the DOM and the subsystem registry by name.

terser is fetched on demand through `npx` and pinned to one version, so the build needs a network connection the first time and produces the same output on every run afterwards. Without terser the bundle is still written, unminified, and the script says so. Nothing about this is required to play the game.

Current output: 279 kB of JavaScript compresses to 143 kB, and the whole page is 156 kB — 56 kB gzipped.

`dist/` is generated and is not tracked.

## Project structure

- `index.html` — markup and subsystem load order.
- `styles/main.css` — interface styling.
- `src/namespace.js` — creates the single global `TownGame` object.
- `src/core.js` — DOM references, configuration, geometry helpers, and mutable `runtime` state.
- `src/quality.js` — quality profiles, automatic selection, and persistence.
- `src/audio.js` — synthesized sound, source positioning, and volume control.
- `src/car-physics.js` — deformable body mesh, plastic constraints, and contacts against the changed outline.
- `src/environment.js` — fog of war, weather, the road graph, and mechanical crash consequences.
- `src/world.js` — district generation and static environment rendering.
- `src/physics.js` — collision resolution and the static broad-phase grid.
- `src/input.js` — keyboard, mouse, and touch controls.
- `src/gameplay.js` — shooting, damage, AI, and game-state updates.
- `src/render.js` — main rendering pass.
- `src/lighting.js` — Canvas 2D and WebGL lighting.
- `src/entities.js` — characters, gauges, and the minimap.
- `src/main.js` — game loop and district startup.
- `tools/build.js` — bundles everything into one minified `dist/courier.html`.
- `docs/architecture.md` — subsystem boundaries and dependency graph.

## Current state

The structural refactor and the first major gameplay pass are complete:

- the original monolith is split into HTML, CSS, and JavaScript subsystems;
- inline styles are replaced with CSS classes;
- interface DOM nodes are cached in a single `UI` object;
- `localStorage` access is centralized and degrades safely when browser storage is unavailable;
- only one global object, `TownGame`, is exposed;
- every subsystem is isolated in a closure and returns a frozen public API;
- mutable launch data lives in `TownGame.core.runtime`, and subsystem dependencies are explicit;
- the sound engine is separate from the core and available through `TownGame.audio`;
- persistent quality profiles include automatic WebGL-aware selection;
- the low profile limits lights, disables dynamic shadows, and reduces weather and fog work;
- Canvas 2D rendering avoids intermediate light buffers when shadows are disabled and culls off-screen dynamic objects;
- zombies flank during a hunt, sometimes dodge the firing line, and perform short surges after a retreating player;
- every district mixes standard green walkers (2 HP), fast orange runners (1 HP), and slow purple brutes (4 HP);
- the first district contains about 14 zombies, three guards patrol every parcel, and later districts scale to 32 enemies;
- the courier starts with 24 rounds, while supply boxes and zombie ammo drops are more plentiful;
- each zombie archetype throws a projectile with its own palette, size, and speed;
- hits produce directional sprays of green blood; airborne droplets stain the ground, and wounded zombies bleed while moving;
- each car uses a deformable mesh of 35 nodes and linked panels; impact position, normal, and impulse plastically displace metal and spread load through adjacent constraints;
- the deformed outline is used for later collisions, shadows, and part placement; windows, lights, mirrors, wheels, smoke, and headlight direction follow the physical mesh;
- zombie and player impacts apply force at the exact contact point and leave localized cumulative dents;
- bullets continuously intersect the deformed body, leave marks, and apply minor damage; a driver either chases the shooter or flees, while a parked car triggers its alarm;
- light, standard, and heavy vehicle constructions have different mass, stiffness, durability, and speed, so crash impulses no longer damage every car identically;
- any damaged vehicle starts smoking, with frequency, size, density, and darkness increasing continuously with engine, body, and plastic damage;
- the mechanical model separately tracks body and engine integrity, windows, headlights, taillights, mirrors, and suspension;
- a heavy crash or repeated zombie impacts can disable a vehicle, leaving a smoking physical obstacle with hazard lights;
- vehicles have separate tires, bumpers, hood, trunk, doors, four windows, mirrors, and independently breakable lights;
- zombies wind up and throw dodgeable clumps of filth at medium range;
- parcels are distributed across reachable yards near different homes;
- every parcel is addressed to its own house with a reachable, street-facing door, at least 300 pixels away from where the parcel lies;
- a guaranteed clear zone surrounds the spawn point, and the starting light does not raise an alarm during the first five seconds;
- `tools/verify.ps1` checks load order, API registration, JavaScript, resources, and English-only text;
- direct `file://` startup is preserved;
- no external dependencies are required.

The second gameplay pass adds survivability, stealth, and a livelier street:

- the courier survives five hits inside a district; losing them all re-issues the district from the depot with a fresh layout at the cost of one of three lives per run, and the life budget is not restored between districts;
- a zombie only watches the arc in front of itself, and notice distance depends on what the courier is doing — 150 steps while sprinting, 90 while walking, 45 while standing still, all shrunk to roughly a third from behind;
- awareness fills in just over half a second in the open, almost instantly in a flashlight beam, and fades over about two and a half;
- an arc above a zombie shows awareness filling, so stealth reads as a state rather than as luck;
- `E` performs a silent kill on an unaware zombie approached from behind, with a short freeze while the finish plays out;
- tanks roam in packs of three or four, placed away from the spawn and from the parcels: 10 HP, half a walker's speed, no tactics, no projectile, and immune to silent kills;
- traffic steers around a tank instead of flattening it; a collision costs half the tank's health but wrecks the car's front, and a second one leaves the vehicle barely driveable;
- patrol cars shoot at zombies within 330 pixels, check the line of fire against houses, hedges, and traffic, lead moving targets, and lose accuracy with speed — about 40 % standing still and 30 % at full speed;
- patrol gunfire draws the horde to the car rather than to the courier, and a nearby patrol becomes an alternative target for zombies;
- a zombie splattered by a neighbour's throw turns on the thrower for eight to thirteen seconds;
- jammed traffic escalates its way out: yield, back up, take another exit from the intersection, and finally turn around onto the opposite lane;
- `P` and `ESC` pause the district, leaving the dimmed frame on screen;
- world density is tuned per unit of area rather than per district, so houses, trees, traffic, and the horde survive changes to the road grid;
- the start screen fits inside the canvas: an objective line, a grid of keys, and a row of threats, with the remaining mechanics behind a `FIELD MANUAL` section that scrolls inside itself and never pushes the start button off screen;
- on a narrow viewport the start screen uses the whole window instead of the letterboxed canvas rectangle;
- the district result has its own element, so finishing a district no longer overwrites the briefing permanently;
- most zombies drop cash and a tank always does; notes scatter out of the body, settle against whatever they meet, glow faintly in the dark, and show on the minimap;
- a drop is worth $2–5 from a runner, $3–8 from a walker, $9–16 from a brute, and $26–42 from a tank;
- the wallet is shown in the HUD, survives district rebuilds like lives do, and resets only on a fresh run. Nothing sells anything yet.

The round is a delivery loop rather than a collection:

- a parcel is picked up and carried to its own address; there is no single exit door;
- the courier carries two parcels at a time, and walking over a third with full hands does nothing but show a `HANDS FULL` prompt;
- carried parcels ride on the courier's back — one centred, two shoulder to shoulder — in both the standing and crawling poses;
- an address is revealed only when its parcel is picked up: a green marker over the door, a lit doorway, a minimap dot that fog does not hide, and the off-screen arrow turning green;
- a delivered address stops being marked immediately, so the map only ever shows work in hand;
- the HUD counts delivered parcels and appends the number in hand, as in `2/5 +1`;
- the district ends when the last parcel reaches its door.

Street lighting is a working part of the district:

- a street lamp is a mast on the kerb with a bracket over the asphalt, so the pool of light
  lands on the lane instead of the pavement behind it, and neighbouring pools overlap along a
  block — a lit street can be walked without the flashlight;
- one bullet in the lantern puts it out for the rest of the district: the mast and bracket stay,
  the glass does not, and the street goes dark;
- breaking glass carries about as far as a shattered car window, so blacking out a street calls
  the horde to the noise;
- a tank head going off takes every lamp inside the blast with it;
- a roof is the one surface facing the sky, so it is lit by the sky and by nothing else: no
  street lamp reaches up there, but moonlight does, and a row of houses reads as slate and
  tile rather than as holes cut out of the street.

The district is being taught to hold a shift of two rather than one courier, ahead of the co-op
mode that will need it. `index.html?qa=coop-local` puts a second courier on the arrow keys next
to the first, on one screen and one camera — not a way to play, but the only way to exercise the
rules below without a network in the way. `tools/test-coop-rules.js` covers them headlessly:

- health, ammunition, the flashlight battery, stamina and what is on the back belong to each
  courier; the district, the horde, the parcel count and the wallet belong to the shift;
- a zombie has one head: it works out whoever is giving themselves away hardest, settles ties by
  who is closer, and changes its mind when that stops being true — so a partner sprinting past
  can take the horde off somebody crawling;
- a beam betrays whoever is holding it, and the one holding it is who the horde comes for;
- a parcel is signed off by the courier carrying it — a partner standing at the right door with
  the wrong parcel signs nothing — while the count on the district is shared;
- running out of health puts a courier on the ground instead of ending the district, and the
  horde loses interest in a body; three seconds of a partner standing over them gets them back
  up on part of their health. The district is only lost when nobody is left standing, which
  alone is the same moment it always was;
- both couriers light the same map: fog is opened by either of them, and each carries their own
  flashlight, muzzle flash and pool of light;
- traffic honks at, swerves for and runs over whichever courier is actually in front of it.

The frame is split between what the district *is* and what it *looks, sounds and feels like*, so
a peer that is not running the rules can still draw the place properly:

- `presentFrame` does the ears, the weather on the glass, the fog, the smoke, the sparks, the
  screen shake and the HUD, and touches no rule at all — `tools/test-presentation.js` pins that
  from both sides: nothing a rule owns may move during it, and the fog and the debris must;
- each piece is called from the exact line it used to occupy inside the update, because several
  are position-sensitive — noise rings age before a siren pushes a new one, smoke ages between
  the traffic and the parcels, and the fog opens before contacts move anybody;
- screen shake is worked out from where the local courier is standing rather than shipped as one
  number, so an explosion two blocks away stays somebody else's problem;
- the loud and visible moments — a shot, a hit, broken glass, a head going off, a noise ring, a
  courier going down or getting back up — are also written down as events, so a peer that never
  ran the rule can still replay the noise and the debris from the note.

A speed pass follows, with no change to the rules or to a single pixel of the picture:

- houses, hedges, parked cars, trees, and bushes are indexed into one uniform grid when a
  district starts, so a body, a bullet, or a light asks only its own neighbourhood instead of
  the whole map; candidates arrive in list order, so every collision resolves exactly as before;
- broad-phase tests compare squared distances, and the frame loops use `Math.sqrt` in place of
  `Math.hypot`, whose overflow guard costs more than a town 2,450 pixels wide can ever need;
- a contact against a car body rejects distant points before synchronizing the mesh, and walks
  the outline without allocating a point object per edge;
- the fog layer rewrites only the cells the courier has already touched, roughly two thousand
  of thirty thousand, instead of the entire grid every frame;
- the WebGL pass refills one preallocated vertex buffer rather than asking the driver for a new
  allocation per light and per penumbra sample, and uploads constant uniforms once;
- on a level-3 district with about fifty zombies the simulation step drops from roughly 4.9 ms
  to 2.7 ms per frame, and the whole frame from 9.3 ms to 7.7 ms.

JavaScript is loaded through ordered classic `<script>` tags. This keeps double-click `file://` startup working while subsystem variables remain outside the global scope.
