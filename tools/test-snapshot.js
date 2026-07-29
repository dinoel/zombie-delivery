// What crosses the wire, and what must not.
//
// A snapshot is only small enough to send twenty times a second because almost nothing is in it.
// The town, the horde's colours, which door a parcel belongs to and the shape of every car were
// all settled by the seed and are already standing at both ends. So this checks two things that
// are easy to break in opposite directions: that everything a rule can read does arrive, and
// that none of the enormous, unserializable rest of the district gets dragged along with it.
'use strict';

const assert = require('assert').strict;
const { load, q } = require('./browser-sandbox.js');

const MODULES = ['core', 'quality', 'audio', 'car-physics', 'environment',
  'world', 'physics', 'input', 'gameplay', 'net'];
const SEED = 0x51ed5eed;

// Two separate realms, as unlike two machines as this can get in one process: neither can see
// the other's objects, so anything that agrees between them agreed through the wire.
function peer(role) {
  const env = load({ modules: MODULES, seed: SEED });
  const g = env.TownGame.world.buildTown(2, 2);
  const rt = env.TownGame.core.runtime;
  rt.game = g; rt.state = 'play';
  return { env, g, rt, role };
}

const host = peer('host');
const guest = peer('guest');

{
  // The premise: one seed, two realms, the same district.
  assert.equal(host.env.TownGame.world.layoutChecksum(host.g),
    guest.env.TownGame.world.layoutChecksum(guest.g),
    'both ends must have built the same district before anything is sent');
  assert.equal(host.g.players.length, 2, 'a co-op district carries the whole shift');
}

// Play the host forward so there is something worth describing: bullets in the air, zombies
// hunting, a car moving, damage taken.
host.rt.keys.KeyD = 1; host.rt.keys.Space = 1;
for (let i = 0; i < 420; i++) host.env.TownGame.gameplay.update(host.g, 1 / 60);
host.rt.keys.KeyD = 0; host.rt.keys.Space = 0;

{
  const g = host.g;
  assert.ok(g.zombies.length > 5, 'the sample should still have a horde');
  assert.ok(g.killed > 0, 'and should have fought some of it');
  assert.ok(g.cars.length > 5, 'and have traffic');
}

const snapshot = host.env.TownGame.net.encodeSnapshot(host.g, 7);
const wire = JSON.stringify(snapshot);

{
  // The wire must not carry the district. These are the things that would either fail to
  // serialize at all or make a snapshot enormous, and every one of them is already at both ends.
  assert.ok(!wire.includes('"stat"'), 'the pre-rendered town must not be sent');
  assert.ok(!wire.includes('"roadDist"'), 'the distance field is a closure and cannot be');
  assert.ok(!wire.includes('"fog"') && !wire.includes('"seen"'), 'the fog belongs to each screen');
  assert.ok(!wire.includes('"solids"') && !wire.includes('"houses"'), 'the town was built from the seed');
  assert.ok(!wire.includes('"skin"') && !wire.includes('"clothes"'), 'a zombie already knows what it looks like');
  assert.ok(!wire.includes('"dest"'), 'a parcel already knows its own door');
  // Object identities cannot travel, and nothing should have tried to send one.
  assert.ok(!wire.includes('"rival"') && !wire.includes('"foeCar"') && !wire.includes('"prey"'),
    'a zombie\'s grudges are decided by whoever runs the rules');
  assert.ok(!wire.includes('"owner"'), 'a thrown handful does not carry its thrower across');

  // Cosmetic debris is made locally from events, not shipped.
  for (const cosmetic of ['"parts"', '"splats"', '"stains"', '"bloodDrops"', '"rings"', '"splash"', '"carSmoke"'])
    assert.ok(!wire.includes(cosmetic), `${cosmetic} should be made locally, not sent`);

  assert.ok(wire.length < 12000,
    `a snapshot should stay small enough to send twenty times a second (was ${wire.length} bytes)`);
}

// Now put it through the eye of a needle: text out of one realm, text into the other.
guest.env.TownGame.net.applySnapshot(guest.g, JSON.parse(wire));

// Everything a rule can read, from either end, in one shape.
const readable = g => ({
  players: g.players.map(p => [p.hp, p.ammo, p.carried, p.down, q(p.batt, 2), q(p.stam, 2)]),
  zombieIds: g.zombies.map(z => z.id),
  zombieHp: g.zombies.map(z => z.hp),
  cars: g.cars.map(c => [c.id, c.broken === true, q(c.damage.integrity, 2)]),
  bullets: g.bullets.length,
  filth: g.zombieShots.length,
  parts: g.zombieParts.map(part => [part.id, part.kind, q(part.h, 1)]),
  cash: g.cash.map(m => m.n),
  ammoBoxes: g.ammoBoxes.map(a => [a.batt === true, a.n]),
  parcels: g.parcels.map(b => [b.state, b.carrier]),
  lamps: g.lamps.map(l => l.broken === true),
  counters: [g.delivered, g.killed, g.earned, g.done, g.dead]
});

{
  assert.equal(JSON.stringify(readable(guest.g)), JSON.stringify(readable(host.g)),
    'after one snapshot the guest should agree about everything a rule can read');
}

{
  // Positions arrive quantised to a tenth of a pixel, which is far below anything visible and
  // keeps the snapshot small.
  for (let i = 0; i < host.g.players.length; i++) {
    assert.ok(Math.abs(guest.g.players[i].x - host.g.players[i].x) <= .05, 'courier x within a tenth of a pixel');
    assert.ok(Math.abs(guest.g.players[i].y - host.g.players[i].y) <= .05, 'courier y within a tenth of a pixel');
  }
  const hostById = new Map(host.g.zombies.map(z => [z.id, z]));
  for (const z of guest.g.zombies) {
    const original = hostById.get(z.id);
    assert.ok(original, 'every zombie the guest has should be one the host still has');
    assert.ok(Math.abs(z.x - original.x) <= .05 && Math.abs(z.y - original.y) <= .05,
      'a zombie should land where the host has it');
  }
}

{
  // The guest must never invent a zombie, and must lose exactly the ones the host lost.
  assert.ok(guest.g.zombies.length <= 52, 'the horde should not grow on the way across');
  assert.equal(guest.g.zombies.length, host.g.zombies.filter(z => !z.gone).length,
    'the guest should hold exactly the zombies still standing');

  // And the identities the host owns must not have been fabricated at the other end.
  for (const z of guest.g.zombies) {
    assert.equal(z.rival, null, 'a grudge is not the guest\'s to hold');
    assert.equal(z.foeCar, null, 'nor is a feud with a patrol car');
  }
}

{
  // Kill something on the host and the guest should stop holding it.
  const doomed = host.g.zombies[0];
  const before = guest.g.zombies.length;
  doomed.gone = true;
  const next = host.env.TownGame.net.encodeSnapshot(host.g, 8);
  guest.env.TownGame.net.applySnapshot(guest.g, JSON.parse(JSON.stringify(next)));
  assert.equal(guest.g.zombies.length, before - 1, 'a zombie the host removed should leave the guest too');
  assert.ok(!guest.g.zombies.some(z => z.id === doomed.id), 'and it should be the same one');
}

{
  // A broken lamp is a fact about the district, and it has to survive the crossing.
  const lamp = host.g.lamps[3];
  lamp.broken = true;
  const next = host.env.TownGame.net.encodeSnapshot(host.g, 9);
  guest.env.TownGame.net.applySnapshot(guest.g, JSON.parse(JSON.stringify(next)));
  assert.equal(guest.g.lamps[3].broken, true, 'a lamp put out on one end is out on the other');
  assert.equal(guest.g.lamps[4].broken, false, 'and its neighbours are not');
}

{
  // A parcel is signed off by the courier carrying it, so both ends must agree who that is.
  const parcel = host.g.parcels[0];
  parcel.state = 'carried'; parcel.carrier = 1;
  const next = host.env.TownGame.net.encodeSnapshot(host.g, 10);
  guest.env.TownGame.net.applySnapshot(guest.g, JSON.parse(JSON.stringify(next)));
  assert.equal(guest.g.parcels[0].state, 'carried');
  assert.equal(guest.g.parcels[0].carrier, 1, 'the guest should know whose back it is on');
}

{
  // Events ride alongside and are handed to the frame, which is what lets a watching peer make
  // its own sparks for something it never simulated.
  const { EV } = host.env.TownGame.environment;
  host.g.events.length = 0;
  host.g.events.push([EV.shot, 100, 200, 0]);
  const next = host.env.TownGame.net.encodeSnapshot(host.g, 11);
  guest.g.events.length = 0;
  guest.env.TownGame.net.applySnapshot(guest.g, JSON.parse(JSON.stringify(next)));
  assert.equal(guest.g.events.length, 1, 'a note about a shot should cross');
  assert.equal(guest.g.events[0][0], EV.shot);

  host.g.events.length = 0;
  const quiet = host.env.TownGame.net.encodeSnapshot(host.g, 12);
  assert.equal(quiet.e, undefined, 'a quiet frame should not carry an empty list');
}

console.log('Snapshot verified: everything a rule reads crosses, and the district itself never does.');
