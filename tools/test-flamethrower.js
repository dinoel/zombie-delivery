// The madness flamethrower.
//
// The claim worth pinning is not that fire hurts. It is that the whole weapon is a query: once a
// frame the cone in front of the gun hand is asked who is standing in it, and nothing is created,
// tracked or sent. A flame entity would have been a new block in every snapshot and a new thing
// for two ends to disagree about; a cone is a courier position, an aim and one bit.
//
// The other half is that being on fire is a state a body carries away with it. What kills is the
// seconds afterwards rather than the contact — so a walker lit and then left entirely alone has
// to die on its own, and it has to run while it does.
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

  // The trigger goes through the same key the player uses, because the record is rewritten from
  // the real devices every frame and anything poked straight into it would be gone by the time
  // the rules read it.
  const step = (seconds, firing = false) => {
    rt.keys.Space = firing ? 1 : 0;
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      g.p.hp = g.p.hpMax; g.p.down = false; g.dead = false;  // The courier is not what is measured.
      env.TownGame.gameplay.update(g, 1 / 60);
    }
    rt.keys.Space = 0;
  };
  // A clear stretch of ground with nobody else on it, so what the cone reaches is the cone rather
  // than whatever the district happened to leave nearby. With no mouse in a sandbox the courier
  // aims wherever they are facing, so the heading is the aim and standing still holds it.
  const clear = (x, y) => {
    // Moved away and spread out. Piled on one point they brawl with each other, which is a
    // perfectly good rule getting in the way of a question about something else.
    g.zombies.forEach((z, i) => {
      z.x = -4000 - (i % 20) * 90; z.y = -4000 - Math.floor(i / 20) * 90;
      z.gone = false; z.burn = 0;
    });
    g.p.x = x; g.p.y = y;
    g.p.ang = 0;                                             // Facing, and therefore aiming, due east.
    g.p.weapon = 1;
  };
  // One body placed by bearing and range from the courier, at a health nobody burns through.
  // Held still by default: a question about the shape of the cone is not a question about where
  // the horde walked while it was being asked, and one that closed to arm's length would be
  // caught by the close-range exemption rather than by the arc.
  const place = (i, angle, range, hp = 60, still = true) => {
    const z = g.zombies[i];
    z.x = g.p.x + Math.cos(angle) * range;
    z.y = g.p.y + Math.sin(angle) * range;
    z.gone = false; z.hp = z.maxHp = hp; z.burn = 0;
    if (still) z.spd = 0;
    return z;
  };
  return { env, g, rt, step, clear, place };
}

{
  // The weapon exists only in madness. A night shift courier holds a pistol and the key does
  // nothing — but the presses are still read, or a shift spent leaning on it would put a
  // flamethrower in somebody's hands the moment a madness district started.
  // The key goes through the real keydown handler in input.js rather than being poked into the
  // record, so this covers the counter as well as what the counter means.
  const tap = env => { env.key(true, 'KeyQ'); env.key(false, 'KeyQ'); };

  const shift = district(false);
  assert.equal(shift.g.p.weapon, 0, 'a courier starts with the pistol');
  shift.step(.1);
  for (let i = 0; i < 3; i++) { tap(shift.env); shift.step(.1); }
  assert.equal(shift.g.p.weapon, 0, 'and a night shift has nothing to swap to');
  assert.equal(shift.g.p.weaponSeen, 3, 'though the presses are read rather than banked');

  const mad = district(true);
  mad.step(.1);
  tap(mad.env); mad.step(.1);
  assert.equal(mad.g.p.weapon, 1, 'madness swaps to the flamethrower on a press');
  tap(mad.env); mad.step(.1);
  assert.equal(mad.g.p.weapon, 0, 'and back to the pistol on the next one');
}

{
  // The pistol is untouched by any of this: same cooldown, same rounds.
  const { g, step } = district(false);
  const before = g.p.ammo;
  step(1, true);
  assert.ok(g.p.ammo < before, 'the pistol still spends rounds');
  assert.ok(before - g.p.ammo < 10,
    `and still has a cooldown rather than firing every frame (spent ${before - g.p.ammo} in a second)`);
}

{
  // The cone. What is in front burns; what is beside, behind or beyond the reach does not.
  const { clear, place, step } = district(true);
  clear(1200, 1200);
  const front = place(0, 0, 90);
  const beside = place(1, Math.PI / 2, 90);
  const behind = place(2, Math.PI, 90);
  const beyond = place(3, 0, 260);
  step(.6, true);
  assert.ok(front.burn > 0, 'a body in front of the stream should be set alight');
  assert.ok(front.hp < 60, 'and take the stream itself as well');
  assert.equal(beside.burn, 0, 'a body ninety degrees off the aim is not in the cone');
  assert.equal(behind.burn, 0, 'and one standing behind the courier certainly is not');
  assert.equal(beyond.burn, 0,
    'the stream is short: something well past its reach should be untouched');
}

{
  // Fire does not go through a house, by the same check the patrol uses for its line of fire.
  // The wall is the district's own first obstacle, moved between the courier and the target.
  const { env, g, clear, place, step } = district(true);
  clear(1200, 1200);
  const target = place(0, 0, 115);
  const wall = g.solids[0];
  env.TownGame.core.setOBB(wall, g.p.x + 58, g.p.y, 0, 12, 46);
  g.solids.length = 1;
  g.grid = null;                                   // The broad phase rebuilds around the new shape.
  step(.6, true);
  assert.equal(target.burn, 0, 'fire should not reach through a wall');
}

{
  // Burning is what kills. A body lit once and then left entirely alone has to go down on its own.
  const { g, clear, place, step } = district(true);
  clear(1200, 1200);
  const victim = place(0, 0, 70, 2);               // An ordinary walker's health.
  step(.5, true);
  assert.ok(victim.burn > 0, 'half a second of contact should be enough to light somebody');
  const litTo = victim.burn;
  g.p.x = -3000; g.p.y = -3000;                    // The courier walks away and does nothing more.
  step(12);
  assert.ok(victim.gone, `a lit walker should burn to death unattended (lit to ${litTo.toFixed(2)})`);
}

{
  // And it runs while it does. A burning body stops hunting and puts distance between itself and
  // whoever lit it, which is the point of the weapon: it takes the street's attention with it.
  const { g, clear, place, step } = district(true);
  clear(1200, 1200);
  const runner = place(0, 0, 60, 400, false);      // Too healthy to die, and free to move.
  step(.8, true);
  assert.ok(runner.burn > 0, 'the body should be alight');
  const before = Math.hypot(runner.x - g.p.x, runner.y - g.p.y);
  step(2.5);
  const after = Math.hypot(runner.x - g.p.x, runner.y - g.p.y);
  // It burns out during this, which is exactly why the distance is the claim rather than the
  // flame: running away is the first thing it does with the fire, and it does not come back
  // while it lasts.
  assert.ok(after > before + 40,
    `a burning body should run from the courier, not at them (${Math.round(before)} to ${Math.round(after)})`);
}

{
  // Nothing is created. The flames are decoration, they are capped, and no rule reads them.
  const { g, clear, place, step } = district(true);
  clear(1200, 1200);
  place(0, 0, 80, 400);
  // The roster rather than the street: madness moves bodies between the two of them constantly,
  // and what must never change is how many there are altogether.
  const roster = g.zombies.length + g.reserve.length;
  step(3, true);
  assert.ok(g.flames.length > 0, 'the stream should be visible');
  assert.ok(g.flames.length <= 190, `and stay inside its cap (was ${g.flames.length})`);
  assert.equal(g.zombies.length + g.reserve.length, roster,
    'and create no entity of any kind — the flames are a picture, not a thing');
  assert.equal(g.bullets.length, 0, 'a flamethrower fires no rounds');
}

{
  // A body going back on the madness bench is put out. The bench hands the same objects out
  // again, so a burn left on one would walk out with the next arrival.
  const { env, clear, place, step } = district(true);
  clear(1200, 1200);
  const z = place(0, 0, 70, 400);
  step(.6, true);
  assert.ok(z.burn > 0, 'lit');
  env.TownGame.world.resetZombie(z, 500, 500);
  assert.equal(z.burn, 0, 'a body put back on the bench is put out');
  assert.equal(z.litBy, null, 'and forgets who lit it');
}

console.log('Flamethrower verified: a cone and nothing else, and a fire that walks away with the body.');
