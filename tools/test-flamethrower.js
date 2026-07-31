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
const { scene } = require('./scene.js');

// Everything is set up the same way: the horde moved aside, the courier standing still facing
// east, the flamethrower in their hands. With no mouse in a sandbox the aim follows the heading,
// so standing still is what holds it pointing where the test put it.
function armed(at = { x: 1200, y: 1200 }) {
  const s = scene({ madness: true });
  s.immortal();
  s.scatter();
  s.courierAt(at.x, at.y, 0);
  s.g.p.weapon = 1;
  return s;
}

{
  // The weapon exists only in madness. A night shift courier holds a pistol and the key does
  // nothing — but the presses are still read, or a shift spent leaning on it would put a
  // flamethrower in somebody's hands the moment a madness district started.
  const shift = scene({ madness: false });
  assert.equal(shift.g.p.weapon, 0, 'a courier starts with the pistol');
  shift.step(.1);
  for (let i = 0; i < 3; i++) { shift.tap('KeyQ'); shift.step(.1); }
  assert.equal(shift.g.p.weapon, 0, 'and a night shift has nothing to swap to');
  assert.equal(shift.g.p.weaponSeen, 3, 'though the presses are read rather than banked');

  const mad = scene({ madness: true });
  mad.step(.1);
  mad.tap('KeyQ'); mad.step(.1);
  assert.equal(mad.g.p.weapon, 1, 'madness swaps to the flamethrower on a press');
  mad.tap('KeyQ'); mad.step(.1);
  assert.equal(mad.g.p.weapon, 0, 'and back to the pistol on the next one');
}

{
  // The pistol is untouched by any of this: same cooldown, same rounds.
  const s = scene({ madness: false });
  const before = s.g.p.ammo;
  s.hold(['Space'], 1);
  assert.ok(s.g.p.ammo < before, 'the pistol still spends rounds');
  assert.ok(before - s.g.p.ammo < 10,
    `and still has a cooldown rather than firing every frame (spent ${before - s.g.p.ammo} in a second)`);
}

{
  // The cone. What is in front burns; what is beside, behind or beyond the reach does not.
  const s = armed();
  const front = s.place(0, { angle: 0, range: 90, hp: 60 });
  const beside = s.place(1, { angle: Math.PI / 2, range: 90, hp: 60 });
  const behind = s.place(2, { angle: Math.PI, range: 90, hp: 60 });
  const beyond = s.place(3, { angle: 0, range: 260, hp: 60 });
  s.hold(['Space'], .6);
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
  const s = armed();
  const target = s.place(0, { angle: 0, range: 115, hp: 60 });
  s.env.TownGame.core.setOBB(s.g.solids[0], s.g.p.x + 58, s.g.p.y, 0, 12, 46);
  s.g.solids.length = 1;
  s.g.grid = null;                                 // The broad phase rebuilds around the new shape.
  s.hold(['Space'], .6);
  assert.equal(target.burn, 0, 'fire should not reach through a wall');
}

{
  // Burning is what kills. A body lit once and then left entirely alone has to go down on its own.
  const s = armed();
  const victim = s.place(0, { angle: 0, range: 70, hp: 2 });   // An ordinary walker's health.
  s.hold(['Space'], .5);
  assert.ok(victim.burn > 0, 'half a second of contact should be enough to light somebody');
  const litTo = victim.burn;
  s.courierAt(-3000, -3000);                       // The courier walks away and does nothing more.
  s.step(12);
  assert.ok(victim.gone, `a lit walker should burn to death unattended (lit to ${litTo.toFixed(2)})`);
}

{
  // And it runs while it does. A burning body stops hunting and puts distance between itself and
  // whoever lit it, which is the point of the weapon: it takes the street's attention with it.
  const s = armed();
  // Free to move, and too healthy to die during the sample.
  const runner = s.place(0, { angle: 0, range: 60, hp: 400, still: false });
  s.hold(['Space'], .8);
  assert.ok(runner.burn > 0, 'the body should be alight');
  const before = Math.hypot(runner.x - s.g.p.x, runner.y - s.g.p.y);
  s.step(2.5);
  const after = Math.hypot(runner.x - s.g.p.x, runner.y - s.g.p.y);
  // It burns out during this, which is exactly why the distance is the claim rather than the
  // flame: running away is the first thing it does with the fire, and it does not come back
  // while it lasts.
  assert.ok(after > before + 40,
    `a burning body should run from the courier, not at them (${Math.round(before)} to ${Math.round(after)})`);
}

{
  // Nothing is created. The flames are decoration, they are capped, and no rule reads them.
  const s = armed();
  s.place(0, { angle: 0, range: 80, hp: 400 });
  // The roster rather than the street: madness moves bodies between the two of them constantly,
  // and what must never change is how many there are altogether.
  const roster = s.g.zombies.length + s.g.reserve.length;
  s.hold(['Space'], 3);
  assert.ok(s.g.flames.length > 0, 'the stream should be visible');
  assert.ok(s.g.flames.length <= 190, `and stay inside its cap (was ${s.g.flames.length})`);
  assert.equal(s.g.zombies.length + s.g.reserve.length, roster,
    'and create no entity of any kind — the flames are a picture, not a thing');
  assert.equal(s.g.bullets.length, 0, 'a flamethrower fires no rounds');
}

{
  // A body going back on the madness bench is put out. The bench hands the same objects out
  // again, so a burn left on one would walk out with the next arrival.
  const s = armed();
  const z = s.place(0, { angle: 0, range: 70, hp: 400 });
  s.hold(['Space'], .6);
  assert.ok(z.burn > 0, 'lit');
  s.world.resetZombie(z, 500, 500);
  assert.equal(z.burn, 0, 'a body put back on the bench is put out');
  assert.equal(z.litBy, null, 'and forgets who lit it');
}

console.log('Flamethrower verified: a cone and nothing else, and a fire that walks away with the body.');
