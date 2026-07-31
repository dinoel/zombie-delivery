// A peer that is only watching must not quietly play the game.
//
// presentFrame exists so a guest can make a district look, sound and feel right without running
// any of its rules. The whole arrangement only holds if it genuinely runs none of them: a guest
// that nudged a zombie, spent a round or opened a door would drift away from the host with
// nothing to correct it. So this pins the boundary from both sides — nothing a rule owns may
// move, and everything a screen owns must.
'use strict';

const assert = require('assert').strict;
const { q } = require('./browser-sandbox.js');
const { scene } = require('./scene.js');

// The grace period is put back: several of these want a district that has had time to get going
// on its own, and skipping the quiet start is not what this is about.
function district(seed = 0x51ed5eed) {
  const s = scene({ seed });
  s.g.spawnGrace = 5;
  return s;
}

// Everything a rule is allowed to touch. If any of it moves during presentFrame, the guest is
// simulating behind the host's back.
const ruleState = g => JSON.stringify({
  players: g.players.map(p => [p.x, p.y, p.vx, p.vy, p.hp, p.ammo, p.carried, p.batt, p.stam,
    p.down, p.cool, p.torch].map(v => q(v))),
  zombies: g.zombies.map(z => [z.x, z.y, z.ang, z.hp, z.hunt, z.alert, z.notice, z.gone === true].map(v => q(v))),
  cars: g.cars.map(c => [c.id, c.x, c.y, c.v, c.broken === true, c.damage.integrity].map(v => q(v))),
  bullets: g.bullets.length,
  filth: g.zombieShots.length,
  parcels: g.parcels.map(b => b.state),
  lamps: g.lamps.map(l => l.broken === true),
  counters: [g.time, g.delivered, g.killed, g.earned, g.dead, g.done].map(v => q(v))
});

{
  // Let a district get properly under way, so there is something in flight to be wrong about.
  const s = district();
  s.hold(['KeyD', 'Space'], 400 / 60);

  assert.ok(s.g.zombies.length > 5 && s.g.cars.length > 5, 'the sample district should be populated');

  const before = ruleState(s.g);
  s.present(2);
  assert.equal(ruleState(s.g), before,
    'two seconds of presentation must leave every rule-owned value exactly where it was');
}

{
  // The other half of the claim: presentation is not a no-op. A watching peer still gets its
  // ears, its map, its weather and its debris.
  const s = district();
  const g = s.g;
  s.hold(['KeyW'], 200 / 60);

  const seenBefore = g.seen.reduce((a, b) => a + b, 0);
  g.p.x += 700;                              // As if a snapshot had moved this courier.
  g.p.torch = true; g.p.batt = 1;
  s.present(.5);
  assert.ok(g.seen.reduce((a, b) => a + b, 0) > seenBefore,
    'a watching peer should still open the fog around where its courier turned out to be');

  g.parts.push({ x: g.p.x, y: g.p.y, vx: 0, vy: 0, l: .05, c: '#fff', s: 2 });
  s.present(10 / 60);
  assert.equal(g.parts.length, 0, 'and should still age its own debris away');
}

{
  // Events are the only channel through which a watching peer learns that something loud
  // happened. Replaying them makes noise and debris, and empties the list.
  const s = district();
  const g = s.g;
  const { EV } = s.env.TownGame.environment;
  s.step(1);

  g.parts.length = 0; g.rings.length = 0;
  g.events.push([EV.shot, g.p.x, g.p.y, 0]);
  g.events.push([EV.lamp, g.p.x + 40, g.p.y]);
  g.events.push([EV.ring, g.p.x, g.p.y, 300]);
  s.present(1 / 60);
  assert.equal(g.events.length, 0, 'replayed notes should be consumed');
  assert.ok(g.parts.length >= 19, 'a shot and a broken lamp should leave sparks and glass');
  assert.equal(g.rings.length, 1, 'a noise note should draw its ring');
}

{
  // Shake is worked out from where this peer is standing, not shipped as one number. An event
  // across the district should barely register; the same event underfoot should land in full.
  const { env, g } = district();
  const { shakeAt } = env.TownGame.environment;
  g.shake = 0;
  // Straight at the helper, because what is under test is how it answers rather than a frame.
  shakeAt(g, g.p.x + 2000, g.p.y, 1);
  const far = g.shake;
  g.shake = 0;
  shakeAt(g, g.p.x, g.p.y, 1);
  const near = g.shake;
  assert.equal(far, 0, 'an event two blocks away should not shake this screen');
  assert.ok(near > .9, 'the same event underfoot should');
}

console.log('Presentation seam verified: a watching peer draws the district without playing it.');
