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

The script checks JavaScript syntax, referenced resources, subsystem registration, the absence of Cyrillic text, and the translated reference HTML. Node.js is required for syntax checks, but not for the game itself.

The vehicle damage model has a separate deterministic test:

```powershell
node .\tools\test-car-damage.js
```

It covers plastic body-node displacement, replacement of the original collision outline with the deformed outline, moderate and catastrophic frontal crashes, side-part damage, and final failure after repeated zombie impacts. Visual states can be compared in `tools/car-damage-preview.html`. To inspect smoke and the crumpled physical wreck in the game, open `index.html?2d&qa=car-damage`; a test vehicle will appear in the starting beam. Normal gameplay never enables this mode.

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
- `src/physics.js` — collision resolution.
- `src/input.js` — keyboard, mouse, and touch controls.
- `src/gameplay.js` — shooting, damage, AI, and game-state updates.
- `src/render.js` — main rendering pass.
- `src/lighting.js` — Canvas 2D and WebGL lighting.
- `src/entities.js` — characters, gauges, and the minimap.
- `src/main.js` — game loop and district startup.
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
- the exit is selected from reachable interior homes, while a clear path remains around the map edge;
- a guaranteed clear zone surrounds the spawn point, and the starting light does not raise an alarm during the first five seconds;
- `tools/verify.ps1` checks load order, API registration, JavaScript, resources, and English-only text;
- direct `file://` startup is preserved;
- no external dependencies are required.

JavaScript is loaded through ordered classic `<script>` tags. This keeps double-click `file://` startup working while subsystem variables remain outside the global scope.
