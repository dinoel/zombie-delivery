// The simulation must keep producing exactly the frame it produces today.
//
// Multiplayer means pulling the single courier apart into a list, threading an actor argument
// through most of the rules, and lifting the presentation work out of the simulation. None of
// that is allowed to change what a solo district does. A digest over the whole dynamic state
// after a scripted run catches the difference, including the one that is easiest to cause by
// accident: moving a random draw, which shifts every later draw in the district with it.
'use strict';

const assert = require('assert').strict;
const { load, fnv1a, q } = require('./browser-sandbox.js');

const MODULES = ['core', 'quality', 'audio', 'car-physics', 'environment',
  'world', 'physics', 'input', 'gameplay'];
const SEED = 0x51ed5eed;
const LEVEL = 2;
const FRAMES = 780;                                   // Thirteen seconds: past the spawn grace and well into a fight,
                                                      // while leaving the courier two hits of headroom so a run never
                                                      // ends early and truncates the frame it is supposed to measure.
const STEP = 1 / 60;

// The digest is only meaningful if the courier is doing something, so the script walks a circuit,
// sprints on one leg of it, and shoots on a fixed cadence. It is a function of the frame number
// alone, which keeps the run reproducible without recording an input trace.
function driveInput(env, frame) {
  const { runtime } = env.TownGame.core;
  const keys = runtime.keys;
  for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft']) keys[code] = 0;

  const leg = Math.floor(frame / 150) % 4;
  keys[['KeyW', 'KeyD', 'KeyS', 'KeyA'][leg]] = 1;
  keys.ShiftLeft = leg === 1 || leg === 3 ? 1 : 0;
  keys.Space = frame > 300 && frame % 37 === 0 ? 1 : 0;
  keys.KeyE = frame % 53 === 0 ? 1 : 0;

  // Aim sweeps around the courier so the mouse path, which de-projects through the camera, is
  // exercised rather than the fallback that simply follows the walking direction.
  runtime.mouse.active = true;
  const a = frame * 0.031;
  runtime.mouse.sx = 360 + Math.cos(a) * 250;
  runtime.mouse.sy = 280 + Math.sin(a) * 200;

  // Both toggles travel through the real keydown handler in input.js rather than being poked
  // into runtime, so the run covers the path that multiplayer has to replace with a counter.
  if (frame === 120) env.key(true, 'KeyF');           // Flashlight off, and back on at 200: a run
  if (frame === 121) env.key(false, 'KeyF');          // spent in the dark would barely lift the fog.
  if (frame === 200) env.key(true, 'KeyF');
  if (frame === 201) env.key(false, 'KeyF');
  if (frame === 400) env.key(true, 'KeyC');           // Crawl on.
  if (frame === 401) env.key(false, 'KeyC');
  if (frame === 640) env.key(true, 'KeyC');           // Crawl off.
  if (frame === 641) env.key(false, 'KeyC');
}

// Every mutable field a rule can read. Cosmetic arrays contribute only their length: their
// contents are noise, but a change in how many of them exist still means a rule fired
// differently, which is worth catching.
function snapshot(g) {
  const p = g.p;
  return {
    p: [p.x, p.y, p.vx, p.vy, p.kx, p.ky, p.ang, p.aim, p.tx, p.ty, p.walk, p.inv, p.cool,
      p.muzzle, p.stagger, p.torch, p.batt, p.stam, p.running, p.moving, p.rest, p.step,
      p.flick, p.takedown, p.sneaking, p.sneakToggle].map(v => q(v)),
    // Health, ammunition, what is carried and how noticed the courier is moved onto the courier
    // when the district learned to hold more than one. The digest reads the same values in the
    // same order from their new home, so it is expected not to move.
    g: [g.time, p.hp, p.ammo, g.delivered, p.carried, g.killed, g.earned, g.dead, g.done,
      g.shake, g.spawnGrace, g.filthThrown, g.filthHits, g.dodges, g.surges, g.headKicks,
      g.roadKills, g.takedowns, g.carsBroken, p.stealthNotice, p.stealthWatchers,
      p.stealthDetected, p.stealthCrawlTime, g.lampsBroken || 0].map(v => q(v)),
    zombies: g.zombies.map(z => [z.x, z.y, z.ang, z.hp, z.alert, z.hunt, z.notice, z.gone === true,
      z.kind, z.headless === true, z.lostArms || 0, z.throwCd, z.wdir].map(v => q(v))),
    cars: g.cars.map(c => [c.id, c.x, c.y, c.hx, c.hy, c.v, c.mode, c.broken === true,
      c.damage.integrity, c.damage.engine, c.zombieHits || 0, c.playerHits || 0].map(v => q(v))),
    bullets: g.bullets.map(b => [b.x, b.y, b.vx, b.vy, b.l, !!b.own].map(v => q(v))),
    filth: g.zombieShots.map(s => [s.x, s.y, s.vx, s.vy, s.l, s.kind].map(v => q(v))),
    parts: g.zombieParts.map(t => [t.x, t.y, t.h, t.ang, t.kind, t.heat || 0].map(v => q(v))),
    cash: g.cash.map(m => [m.x, m.y, m.n].map(v => q(v))),
    ammoBoxes: g.ammoBoxes.map(a => [a.x, a.y, a.batt, a.n].map(v => q(v))),
    parcels: g.parcels.map(b => b.state),
    lamps: g.lamps.map(l => l.broken === true),
    fogSum: q(g.fog.reduce((a, b) => a + b, 0), 2),
    seenCount: g.seen.reduce((a, b) => a + b, 0),
    counts: [g.parts.length, g.splats.length, g.stains.length, g.bloodDrops.length,
      g.rings.length, g.splash.length, g.carSmoke.length, g.blasts.length]
  };
}

function run() {
  const env = load({ modules: MODULES, seed: SEED });
  const g = env.TownGame.world.buildTown(LEVEL);
  env.TownGame.core.runtime.game = g;
  env.TownGame.core.runtime.state = 'play';
  // Hunting and crawling are transient, so whether the run reached them cannot be read off the
  // final frame. They are counted as the run goes instead.
  const seen = { huntFrames: 0, crawlFrames: 0, torchOff: 0 };
  for (let frame = 0; frame < FRAMES; frame++) {
    driveInput(env, frame);
    env.TownGame.gameplay.update(g, STEP);
    for (const z of g.zombies) if (z.hunt > 0) seen.huntFrames++;
    if (g.p.sneaking) seen.crawlFrames++;
    if (!g.p.torch) seen.torchOff++;
  }
  return { g, seen, state: snapshot(g) };
}

const first = run();
const second = run();
const digest = fnv1a(JSON.stringify(first.state));

assert.equal(JSON.stringify(first.state), JSON.stringify(second.state),
  'two runs of the same script over the same seed must reach the same state');

// The scripted courier is expected to survive and to actually play; a run that died early would
// stop exercising most of the frame while still hashing consistently.
assert.ok(!first.g.dead, 'the scripted run should keep the courier alive for the whole sample');
assert.ok(first.g.time > 12, 'the scripted run should advance the district clock');
assert.ok(first.g.killed > 0 && first.g.p.ammo < 24, 'the scripted run should have fought');
assert.ok(first.g.p.hp < first.g.p.hpMax, 'the scripted run should have taken a hit');
assert.ok(first.seen.huntFrames > 100,
  'the scripted run should have been seen and hunted, not merely heard');
assert.ok(first.seen.crawlFrames > 0 && first.seen.torchOff > 0,
  'the scripted run should have exercised the crawl and flashlight handlers in input.js');
assert.ok(first.g.filthThrown > 0, 'the scripted run should have drawn a thrown projectile');
assert.ok(first.state.seenCount > 5000, 'the scripted run should have explored the fog');

// Pinned from the district as it behaved before the multiplayer work began. It is expected to
// stay untouched through the player-list refactor, the input records and the presentation split,
// all of which are meant to rearrange the code without moving a single value. A deliberate rules
// change re-pins it; an accidental one shows up here as a puzzle worth solving before going on.
const PINNED = 'd8b56a9f';
assert.equal(digest, PINNED,
  `the simulation changed behaviour: expected ${PINNED}, produced ${digest}`);
console.log(`Simulation determinism verified: ${FRAMES} frames hash to ${digest}.`);
