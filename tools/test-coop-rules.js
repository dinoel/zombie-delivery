// The rules that only exist because there are two couriers.
//
// Everything here is unreachable in a solo district, so nothing else in the suite covers it:
// who a zombie decides to chase when two people are giving themselves away by different
// amounts, whose magazine a shot comes out of, what happens when one of them goes down rather
// than both, and whether a partner can get them back up.
//
// Input is driven through the key map rather than by writing the records directly, because the
// records are rebuilt from the devices every frame — and because that is the path the game uses.
'use strict';

const assert = require('assert').strict;
const { load } = require('./browser-sandbox.js');

const MODULES = ['core', 'quality', 'audio', 'car-physics', 'environment',
  'world', 'physics', 'input', 'gameplay'];

// The local courier is on WASD and space; the partner is on the arrows and the numeric keypad.
const CLEAR = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftRight', 'Numpad0'];

// A quiet district with two couriers and nothing else moving, so each test can put exactly the
// situation it cares about in front of them.
function district() {
  const env = load({ modules: MODULES, seed: 0x51ed5eed, search: '?qa=coop-local' });
  const g = env.TownGame.world.buildTown(2);
  const rt = env.TownGame.core.runtime;
  rt.game = g; rt.state = 'play';
  g.spawnGrace = 0;                       // The opening seconds ignore everything; skip them.
  g.zombies.length = 0;
  g.cars.length = 0;
  g.ammoBoxes.length = 0;
  for (const b of g.parcels) b.state = 'done';
  g.delivered = 0;
  const step = (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) env.TownGame.gameplay.update(g, dt); };
  const keys = held => { for (const c of CLEAR) rt.keys[c] = 0; for (const c of held || []) rt.keys[c] = 1; };
  const place = (p, x, y) => { p.x = x; p.y = y; p.vx = p.vy = p.kx = p.ky = 0; };
  step(1);                                // One frame so both input records exist.
  return { env, g, rt, step, keys, place, a: g.players[0], b: g.players[1] };
}

// A walker dropped in at a chosen spot, built from the district's own template so it carries
// every field the rules expect.
function walkerAt(env, g, x, y) {
  const proto = env.TownGame.world.buildTown(2).zombies.find(z => z.kind === 'walker');
  const z = Object.assign({}, proto, { x, y, hp: 2, alert: 0, hunt: 0, notice: 0, gone: false,
    rival: null, foeCar: null, guardParcel: -1, ang: 0, mvx: 0, mvy: 0 });
  g.zombies.push(z);
  return z;
}

{
  const { g, a, b } = district();
  assert.equal(g.players.length, 2, 'the local harness should put two couriers in the district');
  assert.equal(a.id, 0); assert.equal(b.id, 1);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 60, 'the shift should start together');
}

{
  // Ammunition and the flashlight belong to whoever is carrying them.
  const { step, keys, a, b } = district();
  a.ammo = 5; b.ammo = 9;
  keys(['Space']);                          // Only the local courier pulls the trigger.
  step(4);
  assert.ok(a.ammo < 5, 'the courier who pulled the trigger should spend a round');
  assert.equal(b.ammo, 9, 'the partner should not pay for it');

  keys(['Numpad0']);                        // Now only the partner does.
  const spent = a.ammo;
  step(20);
  assert.ok(b.ammo < 9, 'the partner has their own trigger');
  assert.equal(a.ammo, spent, 'and the local courier keeps what is left of theirs');

  keys();
  a.batt = .2; b.batt = 1;
  step(30);
  assert.ok(a.batt < b.batt, 'each flashlight drains its own battery');
}

{
  // A zombie has one head. It works out whoever is giving themselves away hardest, and changes
  // its mind when that stops being true.
  const { env, g, step, keys, place, a, b } = district();
  const z = walkerAt(env, g, 1200, 800);
  a.torch = false; b.torch = false;
  place(a, z.x - 40, z.y);                  // Close and sprinting: impossible to miss.
  place(b, z.x + 500, z.y);                 // Far away and standing still.
  keys(['KeyD', 'ShiftLeft']);
  step(30);
  assert.equal(z.prey, a, 'the zombie should work out the courier in front of it');
  assert.ok(a.stealthNotice > 0, 'the noticed courier should see it on their own gauge');
  assert.equal(b.stealthWatchers, 0, 'the far courier should not be told they are being watched');

  // Swap them over: the near one leaves, the far one walks into its face.
  place(a, z.x + 700, z.y);
  place(b, z.x - 30, z.y);
  keys(['ArrowRight', 'ShiftRight']);
  step(40);
  assert.equal(z.prey, b, 'the zombie should switch to whoever is now the obvious one');
}

{
  // A beam betrays whoever is holding it, from any angle.
  const { env, g, step, keys, place, a, b } = district();
  const z = walkerAt(env, g, 1200, 800);
  keys();
  a.torch = false; b.torch = false;
  place(a, z.x + 600, z.y); place(b, z.x + 600, z.y + 40);
  step(10);
  assert.equal(z.hunt, 0, 'a dark street should keep the shift unnoticed');

  b.torch = true; b.batt = 1;
  place(b, z.x - 150, z.y);
  b.ang = 0; b.aim = 0;                     // The partner sweeps the beam straight at it.
  step(20);
  assert.ok(z.hunt > 0, 'a beam from either courier should give the shift away');
  assert.equal(z.prey, b, 'and the one holding the torch is the one it comes for');
}

{
  // One courier down is a problem. Both down is the end of the district.
  const { g, rt, step, keys, a } = district();
  keys();
  const lives = rt.lives;
  a.hp = 0; a.down = true;
  step(2);
  assert.equal(g.dead, false, 'a district is not lost while somebody is still standing');
  assert.equal(rt.lives, lives, 'and it costs no life');
  assert.equal(a.moving, false, 'a downed courier does not walk');
}

{
  // Losing the last courier on their feet ends the district and costs a life.
  const { env, g, rt, step, keys, place, a, b } = district();
  keys();
  const lives = rt.lives;
  b.down = true;                            // The partner is already down.
  a.hp = 1; a.inv = 0;
  place(a, 1200, 800);
  place(b, 1900, 800);                      // Out of the way, so nobody revives anybody.
  const z = walkerAt(env, g, a.x + 6, a.y);
  z.hunt = 5;
  step(90);
  assert.equal(a.down, true, 'the last courier standing should go down when health runs out');
  assert.equal(g.dead, true, 'with nobody left standing the district is lost');
  assert.equal(rt.lives, lives - 1, 'and that costs exactly one life');
}

{
  // A partner can kneel over a body and bring it back. It takes three seconds of standing still.
  const { step, keys, place, a, b } = district();
  keys();
  place(a, 1200, 800);
  a.down = true; a.hp = 0; a.reviveT = 0;
  place(b, a.x + 300, a.y);                 // Too far to help.
  step(120);
  assert.equal(a.down, true, 'a courier does not get up on their own');
  assert.equal(a.reviveT, 0, 'and nobody is credited with helping from across the street');

  place(b, a.x + 12, a.y);                  // Kneeling over them.
  step(100);
  assert.ok(a.reviveT > 1 && a.down, 'help should be counted, and should take time');
  step(120);
  assert.equal(a.down, false, 'three seconds of help should get them back on their feet');
  assert.ok(a.hp > 0 && a.hp < a.hpMax, 'back up, but not back to full');
  assert.ok(a.inv > 0, 'and briefly protected while they find their feet');
}

{
  // Parcels ride on the back of whoever picked them up, and only that courier can sign one off.
  // The count on the door is shared: it is one shift and one district.
  const { g, step, keys, place, a, b } = district();
  keys();
  place(a, 1200, 800);
  place(b, 1900, 800);
  const parcel = g.parcels[0];
  parcel.state = 'ground'; parcel.carrier = -1;
  parcel.x = b.x; parcel.y = b.y;            // Lying at the partner's feet.
  step(3);
  assert.equal(parcel.state, 'carried', 'a parcel underfoot should be picked up');
  assert.equal(parcel.carrier, b.id, 'by the courier standing on it');
  assert.equal(b.carried, 1, 'and it should be on their back');
  assert.equal(a.carried, 0, 'not on their partner\'s');

  // The wrong courier at the right door signs nothing.
  place(a, parcel.dest.x, parcel.dest.y);
  step(3);
  assert.equal(parcel.state, 'carried', 'a partner at the door without the parcel delivers nothing');
  assert.equal(g.delivered, 0);

  place(b, parcel.dest.x, parcel.dest.y);
  step(3);
  assert.equal(parcel.state, 'done', 'the courier carrying it signs it off');
  assert.equal(b.carried, 0);
  assert.equal(g.delivered, 1, 'and the district counts it once, for the shift');
}

{
  // The wallet is shared; the walking is not.
  const { g, step, keys, place, a, b } = district();
  keys();
  place(a, 1900, 800);
  place(b, 1200, 800);
  const before = g.earned;
  g.cash.push({ x: b.x, y: b.y, vx: 0, vy: 0, n: 7, ph: 0, tilt: 0 });
  step(3);
  assert.equal(g.cash.length, 0, 'a note underfoot should be picked up');
  assert.equal(g.earned, before + 7, 'and it goes into the one wallet the shift shares');
}

console.log('Co-op rules verified: separate pockets, one shared district, and a partner worth having.');
