// Madness: ammunition is free and the horde keeps arriving.
//
// The interesting constraint is not the mode, it is that the mode had to fit an existing promise.
// A snapshot names entities by id and the far end only ever updates what it already holds, so a
// horde that grew would be a horde a guest could not see. Nothing is created: the district is
// built with a reserve on the bench, arrivals come off it, and bodies go back on. That is the
// claim most worth pinning, because breaking it would look fine alone and be invisibly broken
// with two players.
'use strict';

const assert = require('assert').strict;
const { load } = require('./browser-sandbox.js');

const MODULES = ['core', 'quality', 'audio', 'car-physics', 'environment',
  'world', 'physics', 'input', 'gameplay'];

function district(madness) {
  const env = load({ modules: MODULES, seed: 0x51ed5eed });
  const g = env.TownGame.world.buildTown(2, 1, madness);
  const rt = env.TownGame.core.runtime;
  rt.game = g; rt.state = 'play';
  g.spawnGrace = 0;
  // Some of these measure the spawner rather than survival, and a courier standing still in
  // madness is dead inside a minute — which would freeze the mode and measure nothing. `immortal`
  // keeps them upright so the arrivals are what is being watched.
  const step = (seconds, dt = 1 / 60, immortal = false) => {
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      if (immortal) { g.p.hp = g.p.hpMax; g.p.down = false; g.dead = false; }
      env.TownGame.gameplay.update(g, dt);
    }
  };
  return { env, g, rt, step };
}

{
  // A normal district is untouched by any of this: no bench, no arrivals, rounds still cost.
  const { g, rt, step } = district(false);
  assert.equal(g.madness, false, 'a night shift is not madness');
  assert.equal(g.reserve.length, 0, 'and keeps nobody on a bench');
  assert.equal(g.ground, null, 'and does not pay to remember every walkable spot');
  const before = g.zombies.length;
  rt.keys.Space = 1;
  step(6);
  rt.keys.Space = 0;
  assert.ok(g.p.ammo < 24, 'rounds should still be spent');
  assert.ok(g.zombies.length <= before, 'and the horde should not grow on its own');
}

{
  // Madness: free rounds.
  const { g, rt, step } = district(true);
  assert.equal(g.madness, true);
  g.p.ammo = 3;
  rt.keys.Space = 1;
  step(8);
  rt.keys.Space = 0;
  assert.equal(g.p.ammo, 3, 'madness should not count rounds');
  assert.ok(g.bullets.length > 0 || g.killed > 0, 'and should still actually fire');
}

{
  // The bench exists, and arrivals come off it rather than from nowhere. Every zombie that ever
  // walks must be one of the objects the district was built with.
  const { g, step } = district(true);
  const built = new Set(g.zombies.concat(g.reserve).map(z => z.id));
  const objects = new Set(g.zombies.concat(g.reserve));
  assert.ok(g.reserve.length > 40, `the bench should be deep (was ${g.reserve.length})`);
  assert.ok(g.ground && g.ground.length > 50, 'and there should be somewhere to arrive from');

  const benchAtStart = g.reserve.length;
  step(45, 1 / 60, true);
  assert.ok(g.spawned > 10, `arrivals should be steady inside a minute (spawned ${g.spawned})`);
  assert.ok(g.reserve.length < benchAtStart, 'and they should have come off the bench');
  for (const z of g.zombies) {
    assert.ok(built.has(z.id), 'every zombie on the street must be one the district was built with');
    assert.ok(objects.has(z), 'and must be the same object, not a copy of it');
  }
  assert.equal(g.zombies.length + g.reserve.length, objects.size,
    'nobody should be lost between the street and the bench, or exist in both');
}

{
  // Arrivals happen where nobody is looking. Something appearing in front of a courier reads as
  // a bug rather than as pressure.
  const { g, step } = district(true);
  const seen = new Set(g.zombies);
  let closest = Infinity;
  // Sampled often, so an arrival is caught near where it arrived rather than after it has walked.
  for (let n = 0; n < 360; n++) {
    step(.25, 1 / 60, true);
    for (const z of g.zombies) {
      if (seen.has(z)) continue;
      seen.add(z);
      closest = Math.min(closest, Math.hypot(z.x - g.p.x, z.y - g.p.y));
    }
  }
  assert.ok(closest > 400,
    `an arrival should never appear near a courier (closest was ${Math.round(closest)})`);
}

{
  // It keeps up the pressure without drowning the frame, and a body that falls comes back.
  const { g, step } = district(true);
  step(90, 1 / 60, true);
  const pressed = g.zombies.length;
  step(150, 1 / 60, true);
  assert.ok(pressed >= 60, `the street should fill up within ninety seconds (reached ${pressed})`);
  assert.ok(g.zombies.length <= 64, `and stay inside its cap (was ${g.zombies.length})`);
  assert.ok(g.spawned > 60, `arrivals should keep coming for as long as it runs (spawned ${g.spawned})`);
  assert.ok(g.reserve.length > 0, 'and the bench should never run dry and quietly end the mode');
}

{
  // Two ends build the same madness district, bench included — otherwise they would disagree
  // about every arrival for the rest of the run.
  const a = district(true), b = district(true);
  assert.equal(a.env.TownGame.world.layoutChecksum(a.g),
    b.env.TownGame.world.layoutChecksum(b.g),
    'one seed and one mode should build one district');
  const plain = district(false);
  assert.notEqual(a.env.TownGame.world.layoutChecksum(a.g),
    plain.env.TownGame.world.layoutChecksum(plain.g),
    'and a madness district is not the same district as a night shift');
}

console.log('Madness verified: free rounds, arrivals off the bench, and nobody created.');
