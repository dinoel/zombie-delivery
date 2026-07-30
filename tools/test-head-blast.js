// A tank's head, shot until it goes off.
//
// This exists because it did not. A courier put five rounds into a tank head and the frame died
// on a stale variable — a name that had belonged to the single-player blast block, still being
// read after that block became a loop over the shift. Ten tests passed on either side of it,
// because not one of them ever detonated anything: the district-wide digest never puts five
// rounds into the same head, and the co-op tests have no tanks in them.
//
// The game already scripts this scene for the browser, so the test drives that same script rather
// than inventing a second version of it — which also means the thing under test is the path a
// player actually takes.
'use strict';

const assert = require('assert').strict;
const { load } = require('./browser-sandbox.js');

const MODULES = ['core', 'quality', 'audio', 'car-physics', 'environment',
  'world', 'physics', 'input', 'gameplay'];

// The scripted scene: a tank is killed, its head is planted, and five rounds go into it on a
// timer. Two and a half seconds of district covers the whole sequence.
function detonate(prepare) {
  const env = load({ modules: MODULES, seed: 0x51ed5eed, search: '?qa=zombie-head-explosion' });
  const g = env.TownGame.world.buildTown(3);
  const rt = env.TownGame.core.runtime;
  rt.game = g; rt.state = 'play';
  let head = null, prepared = false;
  for (let f = 0; f < 60 * 3; f++) {
    env.TownGame.gameplay.update(g, 1 / 60);
    if (!head) head = g.zombieParts.find(part => part.kind === 'head' && part.explosive) || null;
    // Once the head exists and before it goes off, let the caller arrange what is standing near it.
    if (head && !prepared && !g.headExplosions) { prepared = true; if (prepare) prepare(g, head); }
    if (g.headExplosions) break;
  }
  return { env, g, head };
}

{
  // The sequence itself. Before the fix this threw on the fifth round instead of exploding.
  const { g, head } = detonate();
  assert.ok(head, 'killing a tank should leave an explosive head');
  assert.equal(g.headExplosions, 1, 'five rounds into it should set it off exactly once');
  assert.equal(g.explosiveHeadHits, 5, 'and it should have taken five to get there');
  assert.ok(g.blasts.length > 0, 'the blast should exist in the world');
}

{
  // What the blast reaches. Each of these became a loop over the shift during the refactor, so
  // each is a place the same mistake could have been made and nothing would have noticed.
  let hpBefore = 0, victim = null, victimHpBefore = 0, lampsBefore = 0;
  const { g } = detonate((g, head) => {
    const p = g.p;
    p.x = head.x + 18; p.y = head.y; p.inv = 0; p.vx = p.vy = 0;
    hpBefore = p.hp;
    const lamp = g.lamps.find(l => !l.broken);
    lamp.hx = head.x + 40; lamp.hy = head.y + 12;
    lampsBefore = g.lamps.filter(l => l.broken).length;
    victim = g.zombies.find(z => !z.gone && z.kind !== 'tank');
    if (victim) { victim.x = head.x + 26; victim.y = head.y - 12; victimHpBefore = victim.hp; }
  });
  assert.ok(g.headExplosions > 0, 'the head should have gone off');
  assert.ok(g.p.hp < hpBefore, 'a courier standing on a blast should be hurt by it');
  assert.ok(g.shake > 0, 'and should feel it');
  assert.ok(victim && (victim.gone || victim.hp < victimHpBefore),
    'a zombie standing in the blast should take it too');
  assert.ok(g.lamps.filter(l => l.broken).length > lampsBefore,
    'and a lamp inside it should lose its glass');
}

{
  // A blast writes one note. It carries where it happened and how big it was — a head and a car
  // going up are the same event at two sizes — and it does not carry a loudness, because how hard
  // it lands is a question about where a screen is and each end answers that for itself.
  const { env, g } = detonate((g, head) => { g.p.x = head.x + 18; g.p.y = head.y; g.p.inv = 0; });
  const { EV } = env.TownGame.environment;
  const note = g.events.find(e => e[0] === EV.blast);
  assert.ok(note, 'the blast should be written down for a peer that never ran the rule');
  assert.equal(note.length, 4, 'and should carry where it happened and how big, and nothing else');
  assert.equal(note[3], 1, 'a head is the unit the other sizes are measured in');

  // Replayed on a peer that never simulated, it has to shake that peer's own screen.
  g.shake = 0; g.events.length = 0;
  g.events.push([EV.blast, g.p.x, g.p.y]);
  env.TownGame.gameplay.presentFrame(g, 1 / 60);
  const underfoot = g.shake;
  g.shake = 0;
  g.events.push([EV.blast, g.p.x + 4000, g.p.y]);
  env.TownGame.gameplay.presentFrame(g, 1 / 60);
  assert.ok(underfoot > 1, `a replayed blast underfoot should land hard (was ${underfoot.toFixed(2)})`);
  assert.equal(g.shake, 0, 'and one across the district should not be felt at all');
}

// ---------- a wreck on a fuse ----------
// A wreck used to smoke until the district ended. Now the smoke is a fuse, and what it counts
// down to is the same blast as the head at four times the size.
{
  const env = load({ modules: MODULES, seed: 0x51ed5eed });
  const g = env.TownGame.world.buildTown(2);
  const rt = env.TownGame.core.runtime;
  rt.game = g; rt.state = 'play';
  const { WRECK_FUSE, disableCar, carSmokeProfile } = env.TownGame.environment;

  const car = g.cars.find(c => !c.police);
  // Out of the courier's way: what is being timed is the wreck, not a death.
  car.x = 60; car.y = 60;
  disableCar(g, car, 'damage');
  assert.equal(car.fuse, WRECK_FUSE, 'a wreck should be lit rather than merely stopped');
  assert.ok(carSmokeProfile(car).active, 'and should be smoking while it burns');
  assert.equal(carSmokeProfile(car).urgency, 0, 'calmly, to begin with');

  const step = seconds => {
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      g.p.hp = g.p.hpMax; g.dead = false;
      env.TownGame.gameplay.update(g, 1 / 60);
    }
  };

  step(WRECK_FUSE * .8);
  assert.ok(!car.exploded, 'it should still be burning most of the way through the fuse');
  assert.ok(carSmokeProfile(car).urgency > .5,
    'and should be visibly worse by then, because an unreadable fuse kills from nowhere');

  step(WRECK_FUSE * .3);
  assert.ok(car.exploded, `a wreck should go up once its fuse runs out (fuse ${car.fuse})`);
  assert.equal(g.wrecksExploded, 1, 'exactly once');
  assert.ok(!carSmokeProfile(car).active,
    'and stop smoking afterwards, which is the whole point of the fuse');

  // The smoke has to actually clear, not merely stop being produced.
  step(6);
  assert.equal(g.carSmoke.filter(s => Math.hypot(s.x - car.x, s.y - car.y) < 90).length, 0,
    'the column over a burnt-out hull should be gone, not just no longer growing');

  // Still a physical object: a wreck is cover, and cover that vanished would change the street.
  assert.ok(car.broken && g.cars.indexOf(car) >= 0, 'the hull stays on the street as cover');
}

{
  // Four times the head means four times the ground covered and four times the wound — but only
  // to what is standing in it. Traffic keeps its own much shorter reach, or one wreck going up
  // beside another takes the whole road network with it a wreck at a time.
  const env = load({ modules: MODULES, seed: 0x51ed5eed });
  const g = env.TownGame.world.buildTown(2);
  env.TownGame.core.runtime.game = g; env.TownGame.core.runtime.state = 'play';
  const { disableCar, EV } = env.TownGame.environment;

  const car = g.cars.find(c => !c.police);
  car.x = 1200; car.y = 1200;
  // A zombie well outside a head blast but inside a wreck's, and a car just outside the reach
  // that traffic gets.
  const far = g.zombies[0];
  far.x = car.x + 260; far.y = car.y; far.gone = false; far.hp = far.maxHp = 40;
  const neighbour = g.cars.find(c => c !== car && !c.police);
  neighbour.x = car.x + 240; neighbour.y = car.y;
  const neighbourWasBroken = neighbour.broken;

  g.p.x = car.x - 2000; g.p.y = car.y;            // Nowhere near it.
  disableCar(g, car, 'damage');
  car.fuse = 1 / 60;
  g.events.length = 0;
  env.TownGame.gameplay.update(g, 1 / 60);

  assert.ok(car.exploded, 'the fuse should have run out');
  assert.ok(far.gone || far.hp < 40,
    'a wreck should reach further than a head does — this one is beyond a head blast entirely');
  assert.equal(neighbour.broken, neighbourWasBroken,
    'but a car two hundred and forty pixels away should not be wrecked by it');

  const note = g.events.find(e => e[0] === EV.blast);
  assert.ok(note, 'and it should be written down for a watching peer');
  assert.equal(note[3], 4, 'as four heads');
}

console.log('Blasts verified: five rounds into a head, a wreck on a fuse, and the notes they leave.');
