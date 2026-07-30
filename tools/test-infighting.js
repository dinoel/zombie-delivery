// What the horde does to itself, as opposed to what it does to a courier.
//
// A thrown handful that lands on a neighbour starts a grudge, and until this was scaled back the
// grudge was settled almost instantly: a walker put another one down in two swings, half a
// second, which meant a street could empty itself while the courier stood and watched. Blows
// between two of the horde now land at a fraction of what the same blow does to a courier.
//
// The scripted district in test-sim-determinism never starts a feud — filth reaches the courier
// or the scenery, never another zombie — so that digest says nothing about any of this. This is
// the only thing holding the numbers.
'use strict';

const assert = require('assert').strict;
const { load } = require('./browser-sandbox.js');

const MODULES = ['core', 'quality', 'audio', 'car-physics', 'environment',
  'world', 'physics', 'input', 'gameplay'];
const SEED = 0x51ed5eed;

function district() {
  const env = load({ modules: MODULES, seed: SEED });
  const g = env.TownGame.world.buildTown(2);
  const rt = env.TownGame.core.runtime;
  rt.game = g; rt.state = 'play';
  g.spawnGrace = 0;
  g.cars.length = 0;
  g.p.x = 200; g.p.y = 200;              // The courier is nowhere near any of this.
  return { env, g, rt };
}

// Two of the horde set on each other and held to it, so the clock measures damage and nothing
// else. Returns the seconds until one of them drops, or null if neither does.
function brawl(kindA, kindB, limitSeconds = 30) {
  const { env, g } = district();
  const pick = k => g.zombies.find(z => z.kind === k && !z.gone);
  const a = pick(kindA), b = pick(kindB);
  assert.ok(a && b, `the district should contain a ${kindA} and a ${kindB}`);
  a.x = 1600; a.y = 1600;
  b.x = 1600 + a.r + b.r + 2; b.y = 1600;
  a.guardParcel = -1; b.guardParcel = -1;
  for (let f = 0; f < 60 * limitSeconds; f++) {
    a.rival = b; b.rival = a;             // Hold the grudge open; its length is not what is being measured.
    a.rivalCd = 999; b.rivalCd = 999;
    env.env ? null : null;
    env.TownGame.gameplay.update(g, 1 / 60);
    if (a.gone || b.gone) return f / 60;
  }
  return null;
}

{
  // The headline: a brawl is an event with a duration, not an execution. At full strength these
  // were half a second and nothing at all respectively.
  const walkers = brawl('walker', 'walker');
  assert.ok(walkers !== null, 'a grudge held open should eventually settle');
  assert.ok(walkers > 2.5, `two walkers should take several seconds over it (took ${walkers.toFixed(1)} s)`);

  const runner = brawl('runner', 'walker');
  assert.ok(runner !== null && runner > 1,
    `a runner is fragile but should not die on contact (took ${runner === null ? 'never' : runner.toFixed(1) + ' s'})`);
}

{
  // The scale is thirty per cent, and the way to prove it is to count what a single blow costs.
  const { env, g } = district();
  const a = g.zombies.find(z => z.kind === 'walker' && !z.gone);
  const b = g.zombies.find(z => z !== a && z.kind === 'walker' && !z.gone);
  a.x = 1600; a.y = 1600; b.x = 1600 + a.r + b.r + 2; b.y = 1600;
  a.guardParcel = -1; b.guardParcel = -1;
  const before = b.hp;
  let struck = 0;
  for (let f = 0; f < 60 * 3 && !struck; f++) {
    a.rival = b; b.rival = a; a.rivalCd = 999; b.rivalCd = 999;
    b.rival = null;                        // Only one of them swings, so the arithmetic is clean.
    a.rival = b; a.rivalCd = 999;
    env.TownGame.gameplay.update(g, 1 / 60);
    if (b.hp < before) struck = before - b.hp;
  }
  // A walker's swing is 1 against a courier; thirty per cent of it is what a neighbour feels.
  assert.ok(Math.abs(struck - .3) < .001,
    `a walker's blow on another walker should cost .3 health (cost ${struck})`);
}

{
  // A thrown handful is the other way the horde hurts itself, and it is scaled by the same rule.
  // At full strength it took a whole point, which killed a runner outright.
  const { env, g } = district();
  const thrower = g.zombies.find(z => z.shot && !z.gone);
  const victim = g.zombies.find(z => z !== thrower && z.kind === 'walker' && !z.gone);
  thrower.x = 1600; thrower.y = 1600;
  victim.x = 1660; victim.y = 1600;
  const before = victim.hp;
  const spec = thrower.shot;                 // Built the way the horde builds one, field for field.
  g.zombieShots.push({
    x: victim.x - 12, y: victim.y, px: victim.x - 12, py: victim.y, owner: thrower,
    vx: spec.speed, vy: 0, r: spec.radius, l: spec.life, spin: 0, kind: thrower.kind,
    body: spec.body, edge: spec.edge, dark: spec.dark, trail: spec.trail,
    splash: spec.splash, splat: spec.splat, light: spec.light
  });
  // Stop the moment it lands: the grudge it starts brings the thrower over to swing as well, and
  // two costs added together would look like one large one.
  let cost = 0;
  for (let f = 0; f < 30 && !cost; f++) {
    env.TownGame.gameplay.update(g, 1 / 60);
    cost = before - victim.hp;
  }
  assert.ok(cost > 0, 'a handful landing on a neighbour should still hurt');
  assert.ok(Math.abs(cost - .3) < .001, `and should cost .3 health, not a whole point (cost ${cost})`);
  assert.equal(victim.rival, thrower, 'and should still start the grudge');
}

{
  // The other half of the rule, and the one worth guarding: none of this touched what the horde
  // does to a courier. A bite is still a whole heart.
  const { env, g } = district();
  const p = g.p;
  const z = g.zombies.find(x => x.kind === 'walker' && !x.gone);
  p.x = 1600; p.y = 1600; p.inv = 0; p.vx = p.vy = 0;
  z.x = 1600 + 6; z.y = 1600; z.hunt = 9; z.guardParcel = -1;
  const before = p.hp;
  for (let f = 0; f < 60 && p.hp === before; f++) env.TownGame.gameplay.update(g, 1 / 60);
  assert.equal(before - p.hp, 1, 'a zombie should still take a full heart off a courier');
}

console.log('Infighting verified: the horde brawls at a third strength and bites the courier at full.');
