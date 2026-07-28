const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const noop = () => {};
const context2d = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: noop, save: noop, restore: noop, drawImage: noop,
  beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, arc: noop, fill: noop,
  createRadialGradient: () => ({ addColorStop: noop })
};
const canvas = { width: 0, height: 0, getContext: () => context2d };
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const len = (x, y) => Math.sqrt(x * x + y * y);
const rnd = (a, b) => a + (b - a) * .5;
const pick = a => a[0];
const setOBB = (o, cx, cy, ang, hw, hh) => {
  o.cx = cx; o.cy = cy; o.ang = ang; o.hw = hw; o.hh = hh; o.rad = Math.hypot(hw, hh);
  o.pts = o.pts || [[0, 0], [0, 0], [0, 0], [0, 0]];
  return o;
};
const obb = (cx, cy, ang, hw, hh) => setOBB({}, cx, cy, ang, hw, hh);

const played = [];
const sandbox = {
  console,
  Uint8ClampedArray,
  Math,
  document: { createElement: () => ({ ...canvas }) },
  window: { TownGame: {
    core: {
      ctx: context2d, W: 720, H: 540, WORLD: 1530, ROAD: 116, GN: 4, GS: 400, MRG: 165, LANE: 29,
      CAR_L: 46, CAR_W: 22, clamp, len, rnd, pick, obb, setOBB, torchHand: p => p
    },
    audio: { play: name => played.push(name), rain: noop },
    quality: { current: { fogEvery: 1, rainDensity: 0 } }
  } }
};
sandbox.globalThis = sandbox;

const physicsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'car-physics.js'), 'utf8');
vm.runInNewContext(physicsSource, sandbox, { filename: 'car-physics.js' });
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'environment.js'), 'utf8');
vm.runInNewContext(source, sandbox, { filename: 'environment.js' });
const env = sandbox.window.TownGame.environment;
const carPhysics = sandbox.window.TownGame.carPhysics;

const game = () => ({
  p: { x: 1000, y: 1000 }, zombies: [], weather: { rain: 0 }, rings: [], parts: [], shake: 0, carsBroken: 0
});
const car = (x, heading, speed, police = false) => ({
  x, y: 0, hx: heading, hy: 0, v: speed, max: speed, baseMax: speed, police,
  jx: 0, jy: 0, cd: 0, stall: 0, creep: 0, hold: false, honk: 0, hazard: 0,
  broken: false, damage: env.newCarDamage()
});

{
  const g = game(), a = car(0, 1, 18), b = car(40, 1, 12);
  const oldFront = 23;
  env.crash(g, a, b);
  assert.ok(a.damage.integrity < 100, 'even a slow contact should leave a small mark');
  assert.ok(a.damage.crush.front > 0, 'contact should not be merely a sound effect');
  assert.equal(a.broken, false, 'a parking dent should not disable a working car');
  assert.ok(a.body.revision > 0 && a.body.plasticWork > 0, 'an impact should plastically alter the physical mesh');
  assert.ok(Math.max(...a.body.nodes.map(n => n.x)) < oldFront, 'the physical front contour should move inward');
  assert.ok(Math.max(...a.body.collider.pts.map(p => p[0])) < oldFront, 'the collider must follow the crushed body');
}

{
  const g = game(), a = car(0, 1, 110), b = car(40, -1, 90);
  carPhysics.syncCarBody(a); carPhysics.syncCarBody(b);
  const manifold = carPhysics.carCollisionManifold(a, b);
  assert.ok(manifold && manifold.points >= 2, 'the narrow phase should find intersection points between both car contours');
  env.crash(g, a, b, manifold);
  assert.equal(a.broken, false, 'a medium impact should not automatically destroy the car');
  assert.equal(b.broken, false, 'both cars should have a chance to keep moving');
  assert.ok(a.damage.integrity < 75 && a.damage.integrity > 5, 'a medium impact should leave serious permanent damage');
  assert.ok(a.damage.crush.front > .5, 'the front body zone should be crushed');
  const crashedFront = a.body.nodes.find(n => n.restX === 23 && n.restY === 0);
  assert.ok(crashedFront.x < 15, 'a head-on car impact should physically crush the nose deeply');
  assert.ok(a.damage.glass.front < 1, 'the windshield should be damaged');
  assert.ok(a.damage.lights.frontLeft < 1 && a.damage.lights.frontRight < 1, 'both headlights should take damage');
  const secondManifold = carPhysics.carCollisionManifold(a, b);
  assert.ok(!secondManifold || secondManifold.penetration < manifold.penetration,
    'the next collision check should use the already crushed contours');
}

{
  const g = game(), a = car(0, 1, 145), b = car(40, -1, 120);
  env.crash(g, a, b);
  assert.equal(a.broken, true, 'a catastrophic head-on impact should disable the first car');
  assert.equal(b.broken, true, 'a catastrophic head-on impact should disable the second car');
  assert.equal(a.v, 0, 'a disabled car must stop');
  assert.ok(a.hazard > 0, 'hazard lights should turn on after the car breaks down');
  assert.equal(g.carsBroken, 2, 'the statistics should count both disabled cars');
}

{
  const g = game(), light = car(0, 1, 85), heavy = car(40, -1, 85);
  Object.assign(light, { model: 0, mass: .78, stiffness: .76, durability: .82 });
  Object.assign(heavy, { model: 2, mass: 1.38, stiffness: 1.36, durability: 1.32 });
  carPhysics.syncCarBody(light); carPhysics.syncCarBody(heavy);
  const manifold = carPhysics.carCollisionManifold(light, heavy);
  env.crash(g, light, heavy, manifold);
  assert.ok(light.damage.integrity < heavy.damage.integrity,
    'the light car should take more structural damage from the heavy car');
  assert.ok(light.body.plasticWork > heavy.body.plasticWork,
    'the soft light body should crush more than the rigid heavy one');
  assert.ok(Math.hypot(light.x - heavy.x, light.y - heavy.y) > 40,
    'after a crash, the bodies should separate immediately instead of overlapping');
  assert.equal(light.broken, true, 'the light car may not survive a head-on impact with the heavy car');
  assert.equal(heavy.broken, false, 'the heavy car should survive the same contact');
}

{
  const g = game(), c = car(0, 1, 120);
  env.damageCar(g, c, 150, 0, -1);
  assert.ok(c.damage.crush.left > .5, 'a side impact should crush the corresponding side');
  assert.ok(c.damage.glass.left < .5, 'the side window should crack');
  assert.ok(c.damage.mirrors.left <= .2, 'the mirror on the impact side should break off');
  assert.ok(c.damage.wheel > 0, 'a side impact should damage the running gear');
  const leftEdge = c.body.nodes.filter(n => n.restY === -11);
  assert.ok(leftEdge.some(n => n.y > n.restY + 1), 'side contact should physically push the side nodes inward');
}

{
  const g = game(), c = car(0, 1, 120);
  carPhysics.syncCarBody(c);
  const before = carPhysics.circleCarContact(c, 22.8, 0, .25);
  assert.ok(before, 'the intact front edge should participate in contact');
  env.damageCar(g, c, 205, 1, 0, 'collision', 23, 0);
  const after = carPhysics.circleCarContact(c, 22.8, 0, .25);
  assert.equal(after, null, 'after crushing, the old geometry should not remain as an invisible collider');
}

{
  const g = game(), c = car(0, 1, 150);
  const z = { x: 32, y: 0, kind: 'walker' };
  carPhysics.syncCarBody(c);
  const firstContact = carPhysics.circleCarContact(c, z.x, z.y, 10);
  env.damageCarWithZombie(g, c, z, firstContact);
  const centreFront = c.body.nodes.find(n => n.restX === 23 && n.restY === 0);
  assert.ok(centreFront.x < 20, 'one zombie impact should leave a visible physical dent');
  // Bodies now load the front far harder, so a regular car gives out after five of them.
  for (let i = 1; i < 4; i++) env.damageCarWithZombie(g, c, z);
  assert.equal(c.broken, false, 'four bodies should batter a car without finishing it');
  env.damageCarWithZombie(g, c, z);
  assert.equal(c.broken, true, 'a series of five impacts should permanently disable a regular car');
  assert.equal(c.breakReason, 'zombies', 'the accumulated failure reason should be preserved');
  assert.equal(c.zombieHits, 5, 'the car should remember its zombie impact count');
  assert.equal(c.v, 0, 'a car disabled by bodies should remain in place');
}

{
  // A tank is not roadkill: it costs the driver far more than an ordinary body.
  const g = game(), c = car(0, 1, 150);
  const tank = { x: 38, y: 0, kind: 'tank', dumb: true, r: 20.4 };
  carPhysics.syncCarBody(c);
  env.damageCarWithZombie(g, c, tank, carPhysics.circleCarContact(c, tank.x, tank.y, 16));
  const afterOne = c.damage.integrity;
  assert.ok(afterOne < 92, 'a single tank impact should visibly wreck the front of the car');
  assert.equal(c.broken, false, 'one tank impact should not finish the car outright');
  env.damageCarWithZombie(g, c, tank);
  env.damageCarWithZombie(g, c, tank);
  assert.equal(c.broken, true, 'three tank impacts should leave the vehicle disabled');
}

{
  const g = game(), c = car(0, 1, 110), p = { x: 33, y: 4 };
  carPhysics.syncCarBody(c);
  const contact = carPhysics.circleCarContact(c, p.x, p.y, 12);
  assert.ok(contact, 'the player should touch the physical contour of the car');
  env.damageCarWithPlayer(g, c, p, contact);
  assert.equal(c.playerHits, 1, 'the car should record an impact with the player');
  assert.ok(c.body.revision > 0 && c.body.plasticWork > 0, 'an impact with the player should deform the physical mesh');
  const playerDent = c.body.nodes.find(n => n.restX === 23 && n.restY === 6);
  assert.ok(playerDent.x < 21, 'contact with the player should leave a distinct but small dent');
  assert.equal(c.broken, false, 'a collision with the player should dent panels without destroying the car');
}

{
  const g = game(), c = car(0, 1, 120);
  c.police = false; c.driverMode = 'traffic'; c.driverTimer = 0; c.shotHits = 0; c.bulletDents = [];
  carPhysics.syncCarBody(c);
  const contact = carPhysics.segmentCarContact(c, 55, 2, 0, 2);
  assert.ok(contact && contact.x > 21 && contact.x < 24, 'a fast bullet should cross the physical contour without tunnelling through the body');
  const before = c.damage.integrity;
  const result = env.damageCarWithBullet(g, c, contact, { vx: -680, vy: 0 });
  assert.ok(c.damage.integrity < before && c.damage.integrity > before - 3, 'a bullet should cause minor damage rather than crash-level damage');
  assert.equal(c.bulletDents.length, 1, 'a local bullet mark should remain on the panel');
  assert.ok(result.mode === 'chase' || result.mode === 'flee', 'the driver should choose to chase or flee');
  assert.ok(c.driverTimer >= 9, 'the driver reaction should not disappear immediately after the hit');
  assert.equal(c.broken, false, 'one bullet should not destroy a working car');
  assert.equal(env.carSmokeProfile(c).active, true, 'even slight damage should produce light smoke');
}

{
  const intact = car(0, 1, 0), medium = car(0, 1, 0), critical = car(0, 1, 0);
  medium.damage.integrity = 62; medium.damage.engine = 55; medium.damage.plasticWork = 80;
  critical.damage.integrity = 18; critical.damage.engine = 8; critical.damage.plasticWork = 210;
  const clean = env.carSmokeProfile(intact), grey = env.carSmokeProfile(medium), black = env.carSmokeProfile(critical);
  assert.equal(clean.active, false, 'an undamaged car should not smoke');
  assert.ok(grey.active && black.active, 'damaged cars should smoke continuously');
  assert.ok(black.interval < grey.interval && black.darkness > grey.darkness && black.opacity > grey.opacity,
    'as damage increases, smoke should become more frequent, darker, and denser');
  critical.broken = true;
  assert.equal(env.carSmokeProfile(critical).level, 1, 'a disabled car should use the maximum smoke profile');
}

{
  const g = game(), c = car(0, 1, 0);
  c.parked = true; c.driverMode = 'traffic'; c.bulletDents = [];
  carPhysics.syncCarBody(c);
  const contact = carPhysics.segmentCarContact(c, 40, 0, 0, 0);
  env.damageCarWithBullet(g, c, contact, { vx: -680, vy: 0 });
  assert.equal(c.driverMode, 'alarm', 'a parked car should trigger its alarm instead of driving without a driver');
  assert.ok(c.alarm > 0 && c.hazard > 0, 'the alarm should activate the horn and hazard lights');
}

{
  const edge = (id, a, b, ax, ay, bx, by) => {
    const len = Math.hypot(bx - ax, by - ay);
    return { id, a, b, pts: [{ x: ax, y: ay }, { x: bx, y: by }], cum: [0, len], len };
  };
  const nodes = [
    { x: 0, y: 0, e: [0, 1, 2] }, { x: 40, y: 0, e: [1] },
    { x: -180, y: 0, e: [2] }, { x: 0, y: 80, e: [0] }
  ];
  const edges = [edge(0, 3, 0, 0, 80, 0, 0), edge(1, 0, 1, 0, 0, 40, 0), edge(2, 0, 2, 0, 0, -180, 0)];
  const g = { roads: { nodes, edges }, p: { x: 55, y: 0 } };
  const c = { edge: edges[0], dir: 1, x: 0, y: 0, hx: 0, hy: -1, driverTimer: 10, driverMode: 'chase' };
  env.startTurn(g, c);
  assert.equal(c.turn.next.id, 1, 'a pursuing driver should choose the road leading closer to the player');
  c.edge = edges[0]; c.mode = 'edge'; c.turn = null; c.driverMode = 'flee';
  env.startTurn(g, c);
  assert.equal(c.turn.next.id, 2, 'a fleeing driver should choose the road leading farther from the player');
}

assert.ok(played.includes('crash'), 'a serious crash should have a metal impact sound');
assert.ok(played.includes('engineBreak'), 'a terminal breakdown should have a distinct sound');
console.log('Car model verified: mesh, mutable collider, crashes, bullets, and driver reactions work.');
