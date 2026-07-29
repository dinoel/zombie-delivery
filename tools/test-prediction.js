// A guest walking on its own legs, and then quietly agreeing with the host.
//
// Everything else on a guest's screen is deliberately a tenth of a second old. Its own courier
// cannot be: walking with the round trip on your own legs is the one thing that makes a game
// feel broken. So the guest runs its own steps forward and settles up afterwards, and this pins
// the two things that have to be true for that to be honest — the guess is close enough to be
// worth making, and making it never touches anything that is not the guest's to touch.
'use strict';

const assert = require('assert').strict;
const { load } = require('./browser-sandbox.js');

const MODULES = ['core', 'quality', 'audio', 'car-physics', 'environment',
  'world', 'physics', 'input', 'gameplay', 'net'];
const SEED = 0x51ed5eed;

function peer() {
  const env = load({ modules: MODULES, seed: SEED });
  const g = env.TownGame.world.buildTown(2, 2);
  const rt = env.TownGame.core.runtime;
  rt.game = g; rt.state = 'play';
  g.spawnGrace = 0;
  return { env, g, rt };
}

// The guess runs the same code the host runs, so with the same input it should not merely be
// close — it should be exact. Sprinting is included because it is where this first went wrong:
// speed depends on stamina, and a guess that did not spend stamina kept running long after the
// host had stopped, drifting far enough to be corrected with a jump instead of a nudge.
for (const [what, keys, record] of [
  ['a walk', { KeyD: 1 }, { x: 1, y: 0, m: 1, run: false }],
  ['a sprint', { KeyD: 1, ShiftLeft: 1 }, { x: 1, y: 0, m: 1, run: true }],
  ['a diagonal', { KeyD: 1, KeyW: 1 }, { x: .7071, y: -.7071, m: 1, run: false }]
]) {
  const host = peer(), guest = peer();
  Object.assign(host.rt.keys, keys);
  const mine = guest.g.p;
  let worst = 0;
  for (let i = 0; i < 300; i++) {
    host.env.TownGame.gameplay.update(host.g, 1 / 60);
    // The guest's record says the same thing the host's keyboard does.
    Object.assign(mine.in, { n: i + 1, fire: false, finish: false, aimScreen: false }, record);
    guest.env.TownGame.net.predict(guest.g, 1 / 60);
    const truth = host.g.players[0];
    worst = Math.max(worst, Math.hypot(mine.x - truth.x, mine.y - truth.y));
  }
  const truth = host.g.players[0];
  assert.ok(Math.hypot(truth.x - 1170, truth.y - 1250) > 400, `${what} should cover real ground`);
  assert.ok(worst < 1,
    `${what} should never drift more than a pixel from the host (worst was ${worst.toFixed(2)})`);
}

{
  // Predicting must not play the game. A guest that alerted the horde with its own footsteps
  // would be running a rule it has no right to run, and the host would never hear about it.
  const guest = peer();
  const g = guest.g;
  const before = g.zombies.map(z => [z.alert, z.tx, z.ty, z.hunt].join());
  const ringsBefore = g.rings.length;
  Object.assign(g.p.in, { n: 1, x: 1, y: 0, m: 1, run: true, fire: false, finish: false, aimScreen: false });
  // Sprinting is the loudest thing a courier does; three seconds of it is many footsteps.
  for (let i = 0; i < 180; i++) {
    g.p.in.n = i + 1;
    guest.env.TownGame.net.predict(g, 1 / 60);
  }
  assert.ok(Math.hypot(g.p.x - 1170, g.p.y - 1250) > 100, 'the guess should have moved the courier');
  assert.equal(g.zombies.map(z => [z.alert, z.tx, z.ty, z.hunt].join()).join('|'), before.join('|'),
    'a predicted footstep must not reach a single zombie');
  assert.equal(g.rings.length, ringsBefore, 'nor leave a noise ring the host never made');
}

{
  // Health, ammunition, the battery, invulnerability, stagger and knockback belong to the host.
  // A guess that touched any of them would be arguing with the correction rather than waiting
  // for it. Stamina is the one exception, and only because speed depends on it.
  const guest = peer();
  const g = guest.g, p = g.p;
  p.hp = 3; p.ammo = 11; p.batt = .5; p.stam = .5; p.inv = 1; p.stagger = .4;
  p.kx = 400; p.ky = 0; p.torch = true;
  const held = [p.hp, p.ammo, p.batt, p.inv, p.stagger, p.kx, p.torch];
  Object.assign(p.in, { n: 1, x: 1, y: 0, m: 1, run: true, fire: true, finish: true,
    aimScreen: false, torchSeq: 99, sneakSeq: 99 });
  for (let i = 0; i < 60; i++) { p.in.n = i + 1; guest.env.TownGame.net.predict(g, 1 / 60); }
  assert.deepEqual([p.hp, p.ammo, p.batt, p.inv, p.stagger, p.kx, p.torch], held,
    'nothing the host owns should move while guessing');
  // Stamina does move, because the guess needs it to know how fast the courier is. Here the
  // courier is staggered and so cannot run, which is why it recovers rather than being spent —
  // and that is itself the proof that the stagger the host set was left alone.
  assert.ok(p.stam > .5, 'stamina is the guess\'s to work out, and a staggered courier recovers it');
}

{
  // Settling up. A small disagreement is folded in over about a quarter of a second, because a
  // courier that jumped every time a packet arrived would be worse than one that lagged.
  const guest = peer();
  const g = guest.g, p = g.p;
  Object.assign(p.in, { n: 1, x: 0, y: 0, m: 0, run: false, fire: false, finish: false, aimScreen: false });
  guest.env.TownGame.net.predict(g, 1 / 60);
  const startX = p.x;
  // The host says we were eight pixels further along than we thought, as of input 1.
  guest.env.TownGame.net.reconcile(g, [startX + 8, p.y, 0, 0], 1);
  assert.equal(p.x, startX, 'the correction should not be applied all at once');

  for (let i = 0; i < 6; i++) { p.in.n = i + 2; guest.env.TownGame.net.predict(g, 1 / 60); }
  const partway = p.x - startX;
  assert.ok(partway > .5 && partway < 7.5, `a tenth of a second in, it should be partway (was ${partway.toFixed(2)})`);

  for (let i = 0; i < 40; i++) { p.in.n = i + 8; guest.env.TownGame.net.predict(g, 1 / 60); }
  assert.ok(Math.abs(p.x - (startX + 8)) < .3, 'and settled within about a quarter of a second');
}

{
  // A car, a blast or a bite is not a disagreement to ease into: it is meant to be sudden.
  const guest = peer();
  const g = guest.g, p = g.p;
  Object.assign(p.in, { n: 1, x: 0, y: 0, m: 0, run: false, fire: false, finish: false, aimScreen: false });
  guest.env.TownGame.net.predict(g, 1 / 60);
  const far = [p.x + 300, p.y + 120, 0, 0];
  guest.env.TownGame.net.reconcile(g, far, 1);
  assert.equal(p.x, far[0], 'a large correction should land immediately');
  assert.equal(p.y, far[1], 'in both directions');
}

{
  // With no memory of the moment the host is talking about, the host is simply right.
  const guest = peer();
  const g = guest.g, p = g.p;
  guest.env.TownGame.net.reconcile(g, [999, 888, 0, 0], 4242);
  assert.equal(p.x, 999);
  assert.equal(p.y, 888);
}

console.log('Prediction verified: the guess tracks the host, settles up, and touches nothing it should not.');
