// A district built twice from one seed must be the same district.
//
// Co-op never sends the layout over the wire: it is far too large, and most of it is
// unserializable anyway. Instead both peers generate the town locally from a shared seed. That
// only works if generation is a pure function of the random stream, so this test is the
// foundation the network protocol stands on.
'use strict';

const assert = require('assert').strict;
const { load, fnv1a } = require('./browser-sandbox.js');

const MODULES = ['core', 'quality', 'audio', 'car-physics', 'environment', 'world', 'physics'];
const build = (seed, level) => load({ modules: MODULES, seed }).TownGame.world.buildTown(level);

// Everything a player could notice about the shape of a district. Cosmetic per-object seeds are
// included deliberately: two peers that disagree about a roof colour are already out of sync.
const signature = g => ({
  start: [g.p.x, g.p.y],
  need: g.need,
  roadNodes: g.roads.nodes.map(n => [n.x, n.y]),
  roadEdges: g.roads.edges.map(e => [e.id, e.a, e.b, e.len, e.pts.length]),
  houses: g.houses.map(h => [h.cx, h.cy, h.ang, h.hw, h.hh, h.wall, h.roof, h.seed]),
  trees: g.trees.map(t => [t.x, t.y, t.r, t.seed]),
  soft: g.soft.map(s => [s.x, s.y, s.r, s.seed]),
  lamps: g.lamps.map(l => [l.x, l.y, l.hx, l.hy, l.ang, l.lampPower, l.seed]),
  parked: g.parked.map(c => [c.cx, c.cy, c.ang, c.model]),
  parcels: g.parcels.map(p => [p.x, p.y, p.dest.x, p.dest.y, p.ph]),
  cars: g.cars.map(c => [c.id, c.x, c.y, c.s, c.dir, c.max, c.police, c.edge.id]),
  zombies: g.zombies.map(z => [z.x, z.y, z.kind, z.hp, z.spd, z.seed, z.guardX, z.guardY]),
  ammoBoxes: g.ammoBoxes.map(a => [a.x, a.y, a.batt, a.n]),
  weather: [g.weather.rain, g.weather.target, g.weather.wet, g.weather.wind, g.weather.next, g.weather.strike]
});

// Each sandbox is its own realm, so its arrays have their own prototypes and a deep strict
// compare would fail on constructor identity while every value agreed. Serializing first asks
// the question actually being asked.
const serialize = g => JSON.stringify(signature(g));
const digest = g => fnv1a(serialize(g));

{
  const a = build(0x51ed5eed, 3), b = build(0x51ed5eed, 3);
  assert.equal(serialize(a), serialize(b),
    'one seed must produce one district, field for field');
  assert.equal(digest(a), digest(b), 'the layout digest must agree between two builds');
}

{
  // A district is expected to actually contain a district; an empty town would satisfy every
  // equality above while telling us nothing.
  const g = build(0x51ed5eed, 3);
  assert.ok(g.houses.length > 20, 'the seeded district should be populated with houses');
  assert.ok(g.zombies.length > 20, 'the seeded district should be populated with a horde');
  assert.ok(g.lamps.length > 20, 'the seeded district should have street lighting');
  assert.ok(g.parcels.length === g.need && g.need >= 4, 'every required parcel should be placed');
  assert.ok(g.parcels.every(p => p.dest && Number.isFinite(p.dest.x)),
    'every parcel should be addressed to a door');
  assert.ok(g.cars.length > 5, 'the seeded district should have traffic');
}

{
  const a = build(0x51ed5eed, 3), b = build(0x1a2b3c4d, 3);
  assert.notEqual(digest(a), digest(b), 'a different seed must produce a different district');
}

{
  // The level number changes parcel count and horde size, so it belongs in the handshake next
  // to the seed rather than being inferred from it.
  const a = build(0x51ed5eed, 1), b = build(0x51ed5eed, 5);
  assert.notEqual(digest(a), digest(b), 'the same seed at a different level must differ');
  assert.ok(b.need > a.need, 'later districts should ask for more parcels');
}

{
  // The static layer consumes the same stream as the layout, so a peer that skipped it would
  // still agree about the town but disagree about everything generated afterwards. Nothing
  // is generated afterwards today; this guards that it stays that way.
  const one = load({ modules: MODULES, seed: 7 });
  const town = one.TownGame.world.buildTown(2);
  const after = one.nextRandom();
  const two = load({ modules: MODULES, seed: 7 });
  two.TownGame.world.buildTown(2);
  assert.equal(after, two.nextRandom(),
    'both peers must leave the random stream at the same position after generating a district');
  assert.ok(town.stat, 'the district should carry its pre-rendered static layer');
}

console.log('Seeded town verified: one seed builds one district, and the stream lands in the same place.');
