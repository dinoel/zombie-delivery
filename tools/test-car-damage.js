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
      CAR_L: 46, CAR_W: 22, clamp, rnd, pick, obb, setOBB, torchHand: p => p
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
  assert.ok(a.damage.integrity < 100, 'даже медленное касание должно оставить небольшой след');
  assert.ok(a.damage.crush.front > 0, 'контакт не должен быть чисто звуковым эффектом');
  assert.equal(a.broken, false, 'парковочная вмятина не должна ломать исправную машину');
  assert.ok(a.body.revision > 0 && a.body.plasticWork > 0, 'удар должен пластически изменить физическую сетку');
  assert.ok(Math.max(...a.body.nodes.map(n => n.x)) < oldFront, 'физический передний контур должен сдвинуться внутрь');
  assert.ok(Math.max(...a.body.collider.pts.map(p => p[0])) < oldFront, 'коллайдер обязан повторять смятый кузов');
}

{
  const g = game(), a = car(0, 1, 110), b = car(40, -1, 90);
  carPhysics.syncCarBody(a); carPhysics.syncCarBody(b);
  const manifold = carPhysics.carCollisionManifold(a, b);
  assert.ok(manifold && manifold.points >= 2, 'точная фаза должна найти точки пересечения контуров двух машин');
  env.crash(g, a, b, manifold);
  assert.equal(a.broken, false, 'средний удар не должен автоматически уничтожать машину');
  assert.equal(b.broken, false, 'обе машины должны иметь шанс продолжить движение');
  assert.ok(a.damage.integrity < 75 && a.damage.integrity > 5, 'средний удар должен оставить серьёзный постоянный урон');
  assert.ok(a.damage.crush.front > .5, 'передняя зона кузова должна смяться');
  const crashedFront = a.body.nodes.find(n => n.restX === 23 && n.restY === 0);
  assert.ok(crashedFront.x < 15, 'встречный удар машин должен глубоко физически смять нос');
  assert.ok(a.damage.glass.front < 1, 'лобовое стекло должно получить повреждение');
  assert.ok(a.damage.lights.frontLeft < 1 && a.damage.lights.frontRight < 1, 'обе передние фары должны принять удар');
  const secondManifold = carPhysics.carCollisionManifold(a, b);
  assert.ok(!secondManifold || secondManifold.penetration < manifold.penetration,
    'следующая проверка столкновения должна использовать уже смятые контуры');
}

{
  const g = game(), a = car(0, 1, 145), b = car(40, -1, 120);
  env.crash(g, a, b);
  assert.equal(a.broken, true, 'катастрофический встречный удар должен ломать первую машину');
  assert.equal(b.broken, true, 'катастрофический встречный удар должен ломать вторую машину');
  assert.equal(a.v, 0, 'сломанная машина обязана остановиться');
  assert.ok(a.hazard > 0, 'после поломки должна включиться аварийная сигнализация');
  assert.equal(g.carsBroken, 2, 'статистика должна учитывать обе сломанные машины');
}

{
  const g = game(), light = car(0, 1, 85), heavy = car(40, -1, 85);
  Object.assign(light, { model: 0, mass: .78, stiffness: .76, durability: .82 });
  Object.assign(heavy, { model: 2, mass: 1.38, stiffness: 1.36, durability: 1.32 });
  carPhysics.syncCarBody(light); carPhysics.syncCarBody(heavy);
  const manifold = carPhysics.carCollisionManifold(light, heavy);
  env.crash(g, light, heavy, manifold);
  assert.ok(light.damage.integrity < heavy.damage.integrity,
    'лёгкая машина должна получить больше структурного урона от тяжёлой');
  assert.ok(light.body.plasticWork > heavy.body.plasticWork,
    'мягкий лёгкий кузов должен смяться сильнее жёсткого тяжёлого');
  assert.ok(Math.hypot(light.x - heavy.x, light.y - heavy.y) > 40,
    'после аварии кузова должны разойтись немедленно, а не рисоваться друг поверх друга');
  assert.equal(light.broken, true, 'лёгкая машина может не пережить встречный удар тяжёлой');
  assert.equal(heavy.broken, false, 'тяжёлая машина должна пережить тот же контакт');
}

{
  const g = game(), c = car(0, 1, 120);
  env.damageCar(g, c, 150, 0, -1);
  assert.ok(c.damage.crush.left > .5, 'боковой удар должен смять соответствующий борт');
  assert.ok(c.damage.glass.left < .5, 'боковое стекло должно растрескаться');
  assert.ok(c.damage.mirrors.left <= .2, 'зеркало со стороны удара должно отломиться');
  assert.ok(c.damage.wheel > 0, 'боковой удар должен повредить ходовую');
  const leftEdge = c.body.nodes.filter(n => n.restY === -11);
  assert.ok(leftEdge.some(n => n.y > n.restY + 1), 'боковой контакт должен физически вдавить узлы борта');
}

{
  const g = game(), c = car(0, 1, 120);
  carPhysics.syncCarBody(c);
  const before = carPhysics.circleCarContact(c, 22.8, 0, .25);
  assert.ok(before, 'целый передний край должен участвовать в контакте');
  env.damageCar(g, c, 205, 1, 0, 'collision', 23, 0);
  const after = carPhysics.circleCarContact(c, 22.8, 0, .25);
  assert.equal(after, null, 'после смятия старая геометрия не должна оставаться невидимым коллайдером');
}

{
  const g = game(), c = car(0, 1, 150);
  const z = { x: 32, y: 0, kind: 'walker' };
  carPhysics.syncCarBody(c);
  const firstContact = carPhysics.circleCarContact(c, z.x, z.y, 10);
  env.damageCarWithZombie(g, c, z, firstContact);
  const centreFront = c.body.nodes.find(n => n.restX === 23 && n.restY === 0);
  assert.ok(centreFront.x < 20, 'один наезд на зомби должен оставить видимую физическую вмятину');
  for (let i = 1; i < 8; i++) env.damageCarWithZombie(g, c, z);
  assert.equal(c.broken, true, 'серия из восьми наездов должна окончательно сломать обычную машину');
  assert.equal(c.breakReason, 'zombies', 'причина накопительной поломки должна сохраниться');
  assert.equal(c.zombieHits, 8, 'машина должна помнить число наездов');
  assert.equal(c.v, 0, 'сломанная тушами машина должна остаться на месте');
}

{
  const g = game(), c = car(0, 1, 110), p = { x: 33, y: 4 };
  carPhysics.syncCarBody(c);
  const contact = carPhysics.circleCarContact(c, p.x, p.y, 12);
  assert.ok(contact, 'игрок должен соприкасаться с физическим контуром машины');
  env.damageCarWithPlayer(g, c, p, contact);
  assert.equal(c.playerHits, 1, 'наезд на игрока должен быть зарегистрирован машиной');
  assert.ok(c.body.revision > 0 && c.body.plasticWork > 0, 'наезд на игрока должен деформировать физическую сетку');
  const playerDent = c.body.nodes.find(n => n.restX === 23 && n.restY === 6);
  assert.ok(playerDent.x < 21, 'контакт с игроком должен оставить различимую, но небольшую вмятину');
  assert.equal(c.broken, false, 'столкновение с игроком должно мять панели, но не уничтожать машину');
}

{
  const g = game(), c = car(0, 1, 120);
  c.police = false; c.driverMode = 'traffic'; c.driverTimer = 0; c.shotHits = 0; c.bulletDents = [];
  carPhysics.syncCarBody(c);
  const contact = carPhysics.segmentCarContact(c, 55, 2, 0, 2);
  assert.ok(contact && contact.x > 21 && contact.x < 24, 'быстрая пуля должна пересечь физический контур, не проскочив кузов');
  const before = c.damage.integrity;
  const result = env.damageCarWithBullet(g, c, contact, { vx: -680, vy: 0 });
  assert.ok(c.damage.integrity < before && c.damage.integrity > before - 3, 'пуля должна наносить небольшой, а не аварийный урон');
  assert.equal(c.bulletDents.length, 1, 'на панели должна сохраниться локальная пулевая отметина');
  assert.ok(result.mode === 'chase' || result.mode === 'flee', 'водитель должен выбрать преследование или бегство');
  assert.ok(c.driverTimer >= 9, 'реакция водителя не должна исчезать сразу после попадания');
  assert.equal(c.broken, false, 'одна пуля не должна уничтожать исправную машину');
  assert.equal(env.carSmokeProfile(c).active, true, 'даже небольшое повреждение должно дать лёгкий дым');
}

{
  const intact = car(0, 1, 0), medium = car(0, 1, 0), critical = car(0, 1, 0);
  medium.damage.integrity = 62; medium.damage.engine = 55; medium.damage.plasticWork = 80;
  critical.damage.integrity = 18; critical.damage.engine = 8; critical.damage.plasticWork = 210;
  const clean = env.carSmokeProfile(intact), grey = env.carSmokeProfile(medium), black = env.carSmokeProfile(critical);
  assert.equal(clean.active, false, 'исправная машина не должна дымить');
  assert.ok(grey.active && black.active, 'повреждённые машины должны дымить постоянно');
  assert.ok(black.interval < grey.interval && black.darkness > grey.darkness && black.opacity > grey.opacity,
    'с ростом повреждений дым должен становиться чаще, чернее и плотнее');
  critical.broken = true;
  assert.equal(env.carSmokeProfile(critical).level, 1, 'сломанная машина должна использовать максимальный профиль дыма');
}

{
  const g = game(), c = car(0, 1, 0);
  c.parked = true; c.driverMode = 'traffic'; c.bulletDents = [];
  carPhysics.syncCarBody(c);
  const contact = carPhysics.segmentCarContact(c, 40, 0, 0, 0);
  env.damageCarWithBullet(g, c, contact, { vx: -680, vy: 0 });
  assert.equal(c.driverMode, 'alarm', 'припаркованная машина должна включать тревогу вместо движения без водителя');
  assert.ok(c.alarm > 0 && c.hazard > 0, 'тревога должна включить сигнал и аварийные огни');
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
  assert.equal(c.turn.next.id, 1, 'преследователь должен выбрать дорогу, ведущую ближе к игроку');
  c.edge = edges[0]; c.mode = 'edge'; c.turn = null; c.driverMode = 'flee';
  env.startTurn(g, c);
  assert.equal(c.turn.next.id, 2, 'убегающий водитель должен выбрать дорогу дальше от игрока');
}

assert.ok(played.includes('crash'), 'серьёзная авария должна иметь звук металла');
assert.ok(played.includes('engineBreak'), 'окончательная поломка должна иметь отдельный звук');
console.log('Модель машин проверена: сетка, изменяемый коллайдер, аварии, пули и реакции водителей работают.');
