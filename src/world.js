// Генерация района и отрисовка статических объектов.
window.TownGame.world = (() => {
'use strict';

const {
  W, H, WORLD, ROAD, CAR_L, CAR_W,
  clamp, rnd, pick, obb, setOBB, distOBB, roundRect,
  WALLS, ROOFS, CARCOL
} = window.TownGame.core;
const {
  FW, makeRoads, onEdge, nearRoad, newWeather, placeCar, newCarDamage
} = window.TownGame.environment;
const { createCarBody, syncCarBody, deformCarBody, bodyPointLocal } = window.TownGame.carPhysics;

// Три конструкции кузова отличаются не только цветом: лёгкая сильнее мнётся и
// быстрее разгоняется, тяжёлая передаёт больше импульса и лучше держит удар.
const CAR_BUILDS = Object.freeze([
  Object.freeze({ name: 'light', mass: .78, stiffness: .76, durability: .82, speed: 1.08 }),
  Object.freeze({ name: 'standard', mass: 1, stiffness: 1, durability: 1, speed: 1 }),
  Object.freeze({ name: 'heavy', mass: 1.38, stiffness: 1.36, durability: 1.32, speed: .88 })
]);
function applyCarBuild(c) {
  const build = CAR_BUILDS[c.model % CAR_BUILDS.length];
  c.build = build.name; c.mass = build.mass; c.stiffness = build.stiffness; c.durability = build.durability;
  if (Number.isFinite(c.max)) c.max *= build.speed;
  return c;
}

// Базовые архетипы идут циклом, поэтому каждый район гарантированно содержит все виды.
const ZOMBIE_TYPES = Object.freeze([
  Object.freeze({
    id: 'walker', hp: 2, speed: [104, 132], skin: '#8fae63', clothes: '#5d6b4a', eye: '#ff5a45',
    trail: '#a8cc79', map: '#9fd36a', blood: ['#8bc83e', '#568b27', '#b1df5a'], stain: [58, 102, 28],
    shot: Object.freeze({ speed: 230, radius: 7, life: 2.2, windup: .62, cooldown: [4.5, 7.2],
      body: '#9fb43f', edge: '#d2dd72', dark: '#66772a', held: '#a8bd47', heldEdge: '#d9e982',
      trail: 'rgba(177,200,75,.45)', splash: ['#8da63a', '#b1c84b', '#62752d'], splat: [104, 126, 42], light: [.67, .8, .24] })
  }),
  Object.freeze({
    id: 'runner', hp: 1, speed: [152, 178], skin: '#d78352', clothes: '#7d4035', eye: '#ffd05a',
    trail: '#efad6f', map: '#f0a25d', blood: ['#76bd2c', '#477f20', '#a5e446'], stain: [66, 112, 25],
    shot: Object.freeze({ speed: 275, radius: 5.5, life: 1.9, windup: .48, cooldown: [5, 7.4],
      body: '#d99a35', edge: '#ffe08a', dark: '#8d5524', held: '#e6a93d', heldEdge: '#ffe6a2',
      trail: 'rgba(255,185,65,.5)', splash: ['#d98c2f', '#f2b94b', '#9b5f26'], splat: [184, 116, 39], light: [1, .55, .16] })
  }),
  Object.freeze({
    id: 'brute', hp: 4, speed: [72, 92], skin: '#7d86ae', clothes: '#4b4968', eye: '#e0a8ff',
    trail: '#a7acd0', map: '#aab2e4', blood: ['#669b32', '#3c6a22', '#8fbd48'], stain: [49, 88, 27],
    shot: Object.freeze({ speed: 185, radius: 10, life: 2.5, windup: .82, cooldown: [6, 8.4],
      body: '#8560b2', edge: '#d7b1ff', dark: '#4d3568', held: '#936ac2', heldEdge: '#e1c3ff',
      trail: 'rgba(170,112,225,.48)', splash: ['#8560b2', '#a778d7', '#5d427e'], splat: [105, 70, 138], light: [.65, .35, 1] })
  })
]);

// ---------- генерация района ----------
function buildTown(level) {
  const qaMode = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('qa') : '';
  const R = makeRoads();
  const solids = [];   // повёрнутые коробки: дома, изгороди, припаркованные машины
  const trees  = [];   // {x,y,r}
  const soft   = [];   // кусты (замедляют)
  const houses = [];
  const props  = [];   // фонари, лавки, площадки — только для отрисовки
  const CELL = 20, gw = Math.ceil(WORLD / CELL);
  const EDGE_LANE = 54; // свободный обход вдоль границы: здесь нельзя ставить твёрдые объекты
  const insideEdge = (x, y, r = 0) =>
    x - r > EDGE_LANE && y - r > EDGE_LANE && x + r < WORLD - EDGE_LANE && y + r < WORLD - EDGE_LANE;

  // ---------- поле расстояний до асфальта ----------
  const rdist = new Float32Array(gw * gw).fill(1e9);
  for (const e of R.edges) for (let s = 0; s <= e.len; s += 8) {
    const p = onEdge(e, s);
    const gx = (p.x / CELL) | 0, gy = (p.y / CELL) | 0;
    for (let j = Math.max(0, gy - 9); j <= Math.min(gw - 1, gy + 9); j++)
      for (let i = Math.max(0, gx - 9); i <= Math.min(gw - 1, gx + 9); i++) {
        const d = Math.hypot(i * CELL + 10 - p.x, j * CELL + 10 - p.y);
        if (d < rdist[j * gw + i]) rdist[j * gw + i] = d;
      }
  }
  const roadDist = (x, y) =>
    rdist[clamp((y / CELL) | 0, 0, gw - 1) * gw + clamp((x / CELL) | 0, 0, gw - 1)];
  const farFrom = (x, y, pad, skip) => !solids.some(q => q !== skip && Math.hypot(q.cx - x, q.cy - y) < q.rad + pad);

  // ---------- дома вдоль улиц, фасадом к дороге ----------
  const CURB = ROAD / 2 + 30;
  for (let tries = 0; tries < 1800 && houses.length < 32; tries++) {
    const x = rnd(70, WORLD - 70), y = rnd(70, WORLD - 70);
    const d = roadDist(x, y);
    if (d < CURB + 34 || d > CURB + 215) continue;
    const near = nearRoad(R, x, y);
    const ang = near.ang + rnd(-.1, .1);
    const hw = rnd(50, 78), hh = rnd(42, 62);
    const c = Math.cos(ang), s = Math.sin(ang);
    const face = ((near.y - y) * c - (near.x - x) * s) > 0 ? 1 : -1;   // с какой стороны улица
    const h = obb(x, y, ang, hw, hh, { wall: pick(WALLS), roof: pick(ROOFS), seed: Math.random(), face });
    if (!insideEdge(x, y, h.rad)) continue;
    if (!farFrom(x, y, h.rad + 22)) continue;
    houses.push(h); solids.push(h);

    // площадка с машиной сбоку от дома
    if (Math.random() < .5) {
      const lx = (Math.random() < .5 ? 1 : -1) * (hw + 36), ly = face * hh * .3;
      const px = x + lx * c - ly * s, py = y + lx * s + ly * c;
      if (insideEdge(px, py, 36) && roadDist(px, py) > CURB - 4 && farFrom(px, py, 40, h)) { // сам дом площадке не мешает
        props.push(obb(px, py, ang, CAR_L / 2 + 11, CAR_W / 2 + 11, { t: 'lot' }));
        const car = obb(px, py, ang + rnd(-.05, .05), CAR_L / 2, CAR_W / 2,
          { t: 'parked', col: pick(CARCOL), seed: Math.random(), model: (Math.random() * 3) | 0 });
        car.x = car.cx; car.y = car.cy; car.hx = Math.cos(car.ang); car.hy = Math.sin(car.ang);
        car.v = 0; car.parked = true; car.broken = false; car.hazard = 0; car.honk = 0;
        car.damage = newCarDamage(); car.body = createCarBody(); car.bulletDents = [];
        applyCarBuild(car);
        syncCarBody(car);
        props.push(car); solids.push(car);
      }
    }
  }

  // ---------- живые изгороди ----------
  for (let tries = 0, k = 0; tries < 600 && k < 16; tries++) {
    const x = rnd(60, WORLD - 60), y = rnd(60, WORLD - 60);
    if (roadDist(x, y) < CURB + 24) continue;
    const o = obb(x, y, rnd(0, 6.283), rnd(38, 78), 9, { t: 'hedge' });
    if (!insideEdge(x, y, o.rad)) continue;
    if (!farFrom(x, y, o.rad + 18)) continue;
    solids.push(o); props.push(o); k++;
  }

  // ---------- деревья и кусты ----------
  for (let tries = 0; tries < 2200 && trees.length < 62; tries++) {
    const x = rnd(34, WORLD - 34), y = rnd(34, WORLD - 34), r = rnd(15, 22);
    if (!insideEdge(x, y, r)) continue;
    if (roadDist(x, y) < ROAD / 2 + 19) continue;
    if (!farFrom(x, y, r + 16)) continue;
    if (trees.some(t => Math.hypot(t.x - x, t.y - y) < t.r + r + 20)) continue;
    trees.push({ x, y, r, seed: Math.random() });
  }
  for (let tries = 0; tries < 1400 && soft.length < 46; tries++) {
    const x = rnd(30, WORLD - 30), y = rnd(30, WORLD - 30), r = rnd(16, 26);
    if (roadDist(x, y) < ROAD / 2 + 14) continue;
    if (!farFrom(x, y, r + 8)) continue;
    if (trees.some(t => Math.hypot(t.x - x, t.y - y) < t.r + r + 6)) continue;
    soft.push({ x, y, r, seed: Math.random() });
  }

  // ---------- фонари и лавки вдоль тротуаров ----------
  for (const e of R.edges) {
    let side = Math.random() < .5 ? 1 : -1;
    for (let s = rnd(60, 120); s < e.len - 50; s += rnd(150, 210)) {
      const p = onEdge(e, s), off = (ROAD / 2 + 17) * side;
      props.push({ t: 'lamp', x: p.x - p.ty * off, y: p.y + p.tx * off });
      if (Math.random() < .3) {
        const b = off + 21 * side;
        props.push({ t: 'bench', x: p.x - p.ty * b, y: p.y + p.tx * b, a: Math.atan2(p.ty, p.tx) });
      }
      side = -side;
    }
  }

  // ---------- сетка проходимости (для расстановки и проверки достижимости) ----------
  const free = new Uint8Array(gw * gw);
  for (let gy = 0; gy < gw; gy++) for (let gx = 0; gx < gw; gx++) {
    const x = gx * CELL + CELL / 2, y = gy * CELL + CELL / 2;
    let ok = x > 6 && y > 6 && x < WORLD - 6 && y < WORLD - 6;
    if (ok) for (const s of solids) {
      if (Math.hypot(s.cx - x, s.cy - y) > s.rad + 16) continue;
      if (distOBB(x, y, s) < 14) { ok = false; break; }
    }
    if (ok) for (const t of trees)
      if (Math.hypot(t.x - x, t.y - y) < t.r + 14) { ok = false; break; }
    free[gy * gw + gx] = ok ? 1 : 0;
  }

  // старт — ближайший к центру двор, а не середина перекрёстка
  let start = null;
  for (let pass = 0; pass < 2 && !start; pass++)
    for (let rad = 0; rad < 60 && !start; rad++) for (let a = 0; a < 32; a++) {
      const x = WORLD / 2 + Math.cos(a / 32 * 6.283) * rad * 14, y = WORLD / 2 + Math.sin(a / 32 * 6.283) * rad * 14;
      const gx = (x / CELL) | 0, gy = (y / CELL) | 0;
      if (gx < 0 || gy < 0 || gx >= gw || gy >= gw || !free[gy * gw + gx]) continue;
      if (!pass && rdist[gy * gw + gx] < ROAD / 2 + 30) continue;      // первый проход — только дворы
      start = { x: gx * CELL + 10, y: gy * CELL + 10 }; break;
    }

  // волна от старта — что вообще достижимо
  const reach = new Uint8Array(gw * gw);
  const sq = [((start.y / CELL) | 0) * gw + ((start.x / CELL) | 0)];
  reach[sq[0]] = 1;
  for (let h = 0; h < sq.length; h++) {
    const i = sq[h], gx = i % gw, gy = (i / gw) | 0;
    const nb = [[gx + 1, gy], [gx - 1, gy], [gx, gy + 1], [gx, gy - 1]];
    for (const [nx, ny] of nb) {
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gw) continue;
      const j = ny * gw + nx;
      if (free[j] && !reach[j]) { reach[j] = 1; sq.push(j); }
    }
  }
  const spots = [], onFoot = [];                  // во дворах и вообще где угодно
  for (let i = 0; i < reach.length; i++) if (reach[i]) {
    const x = (i % gw) * CELL + CELL / 2, y = ((i / gw) | 0) * CELL + CELL / 2;
    onFoot.push({ x, y });
    if (rdist[i] > ROAD / 2 + 26) spots.push({ x, y });
  }
  if (spots.length < 20) spots.push(...onFoot);   // район вышел сплошь асфальтовым
  const openReach = (x, y, radius = 1) => {
    const gx = (x / CELL) | 0, gy = (y / CELL) | 0;
    for (let oy = -radius; oy <= radius; oy++) for (let ox = -radius; ox <= radius; ox++) {
      const nx = gx + ox, ny = gy + oy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gw) return false;
      const i = ny * gw + nx;
      if (!free[i] || !reach[i]) return false;
    }
    return true;
  };

  // Доступные дворовые площадки по всему району. 3×3 свободных клетки не дают
  // положить посылку в щель между домом и краем или в узкий карман декораций.
  const yardCells = [];
  for (const s of spots) {
    if (s.x < 105 || s.y < 105 || s.x > WORLD - 105 || s.y > WORLD - 105) continue;
    if (!openReach(s.x, s.y, 1)) continue;
    let house = null, hd = 1e9;
    for (const h of houses) {
      const d = distOBB(s.x, s.y, h);
      if (d < hd) { hd = d; house = h; }
    }
    if (house && hd >= 24 && hd <= 118) yardCells.push({ x: s.x, y: s.y, house });
  }
  const fallbackDrop = spots.filter(s => s.x > 105 && s.y > 105 && s.x < WORLD - 105 && s.y < WORLD - 105 && openReach(s.x, s.y, 1));
  const drop = yardCells.length > 24 ? yardCells : fallbackDrop.length ? fallbackDrop : spots;

  // ---------- посылки ----------
  const need = Math.min(3 + (level - 1), 8);
  const parcels = [];
  const parcelGuardPools = [];
  const usedParcelHouses = new Set();
  const parcelGap = Math.max(190, 290 - (need - 3) * 20);
  const START_PARCEL_GAP = 320;
  const START_GUARD_GAP = 285;
  const safeDrop = drop.filter(s => Math.hypot(s.x - start.x, s.y - start.y) > START_PARCEL_GAP);
  if (!safeDrop.length) safeDrop.push(...spots.filter(s =>
    Math.hypot(s.x - start.x, s.y - start.y) > START_PARCEL_GAP && openReach(s.x, s.y, 1)));
  for (let k = 0; k < need; k++) {
    let choices = safeDrop.filter(s =>
      (!s.house || !usedParcelHouses.has(s.house)) &&
      parcels.every(p => Math.hypot(s.x - p.x, s.y - p.y) > parcelGap));
    if (!choices.length) choices = safeDrop.filter(s =>
      parcels.every(p => Math.hypot(s.x - p.x, s.y - p.y) > parcelGap * .72));
    if (!choices.length) choices = safeDrop;

    let bestSpot = pick(choices), guards = [];
    // Несколько попыток нужны не для поиска дальнего угла, а для площадки с местом охране.
    for (let t = 0; t < 36; t++) {
      const s = pick(choices);
      const ring = onFoot.filter(q => {
        const d = Math.hypot(q.x - s.x, q.y - s.y);
        return d >= 48 && d <= 118 && Math.hypot(q.x - start.x, q.y - start.y) > START_GUARD_GAP && openReach(q.x, q.y, 0);
      });
      if (ring.length >= 6) { bestSpot = s; guards = ring; break; }
    }
    if (!guards.length) guards = onFoot.filter(q => {
      const d = Math.hypot(q.x - bestSpot.x, q.y - bestSpot.y);
      return d >= 38 && d <= 138 && Math.hypot(q.x - start.x, q.y - start.y) > START_GUARD_GAP;
    });
    if (!guards.length) guards = onFoot.filter(q =>
      Math.hypot(q.x - bestSpot.x, q.y - bestSpot.y) >= 30 &&
      Math.hypot(q.x - start.x, q.y - start.y) > START_GUARD_GAP)
      .sort((a, b) => Math.hypot(a.x - bestSpot.x, a.y - bestSpot.y) - Math.hypot(b.x - bestSpot.x, b.y - bestSpot.y))
      .slice(0, 16);
    parcels.push({ x: bestSpot.x, y: bestSpot.y, got: false, ph: Math.random() * 6.283 });
    parcelGuardPools.push(guards);
    if (bestSpot.house) usedParcelHouses.add(bestSpot.house);
  }

  // ---------- дом-адресат: дверь смотрит на улицу, подход должен быть достижим ----------
  const doorOf = h => {
    const L = h.face * (h.hh + 17);
    return { x: h.cx - L * Math.sin(h.ang), y: h.cy + L * Math.cos(h.ang) };
  };
  const doorOpen = (h, d) => {
    const nx = -Math.sin(h.ang) * h.face, ny = Math.cos(h.ang) * h.face;
    for (const step of [0, 20, 40, 60]) {
      const x = d.x + nx * step, y = d.y + ny * step;
      const gx = (x / CELL) | 0, gy = (y / CELL) | 0;
      if (gx < 0 || gy < 0 || gx >= gw || gy >= gw || !reach[gy * gw + gx]) return false;
    }
    return true;
  };
  let goal = null;
  let cand = houses.filter(h => {
    const d = doorOf(h);
    const edge = Math.min(h.cx, h.cy, WORLD - h.cx, WORLD - h.cy);
    return edge > 185 && Math.hypot(h.cx - start.x, h.cy - start.y) > 210 &&
           !usedParcelHouses.has(h) && parcels.every(p => Math.hypot(h.cx - p.x, h.cy - p.y) > 135) && doorOpen(h, d);
  });
  if (!cand.length) cand = houses.filter(h => doorOpen(h, doorOf(h)));
  if (cand.length) {
    const h = pick(cand), d = doorOf(h);
    h.target = true; goal = { house: h, ...d };
  }
  if (!goal) { const h = houses[0]; h.target = true; goal = { house: h, ...doorOf(h) }; }

  // ---------- едущие машины: катятся по улицам и сворачивают на перекрёстках ----------
  const cars = [];
  const nCars = Math.min(7 + level, 14);       // больше улицы не держат: начинается сплошная толчея
  const spd = Math.min(1.34, 1 + (level - 1) * .08);   // быстрее улицы просто не успевают разъезжаться
  for (let k = 0; k < nCars; k++) {
    for (let t = 0; t < 50; t++) {
      const e = pick(R.edges);
      if (e.len < 120) continue;
      const c = { id: k, edge: e, dir: Math.random() < .5 ? 1 : -1, s: rnd(40, e.len - 40),
                  mode: 'edge', turn: null,
                  v: 0, max: rnd(115, 175) * spd, col: pick(CARCOL), honk: 0, honked: false,
                  stall: 0, stuck: 0, cd: 0, dead: 0, creep: 0, hold: false, node: -1, jx: 0, jy: 0,
                  broken: false, breakReason: '', hazard: 0, smokeCd: 0, zombieHits: 0, zombieLoad: 0,
                  damage: newCarDamage(), body: createCarBody(), seed: Math.random(), model: k % 3,
                  driverMode: 'traffic', driverTimer: 0, shotHits: 0, bulletDents: [], hitFlash: 0,
                  x: 0, y: 0, hx: 1, hy: 0, box: obb(0, 0, 0, CAR_L / 2, CAR_W / 2) };
      applyCarBuild(c);
      placeCar(c);
      if (cars.some(o => Math.hypot(o.x - c.x, o.y - c.y) < 100)) continue;
      cars.push(c); break;
    }
  }
  // патруль: белая с мигалкой, идёт заметно быстрее потока
  for (let k = 0, want = level >= 4 ? 2 : 1; k < want && k < cars.length; k++) {
    const c = cars[k];
    c.police = true; c.col = '#eef2f7'; c.max *= 1.35; c.beacon = rnd(0, 6.283);
    c.mass *= 1.12; c.stiffness *= 1.12; c.durability *= 1.18;
  }
  for (const c of cars) c.baseMax = c.max;

  // Детерминированная QA-сцена: обычный запуск её никогда не включает.
  // Она ставит готовый дымящий остов в стартовый луч и позволяет проверить Canvas без ожидания случайной аварии.
  const carDamageQa = qaMode === 'car-damage';
  if (carDamageQa && cars.length) {
    const c = cars.find(car => !car.police) || cars[0];
    let qaPos = null;
    for (const radius of [58, 76, 94]) for (let i = 0; i < 8 && !qaPos; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 4, x = start.x + Math.cos(a) * radius, y = start.y + Math.sin(a) * radius;
      if (insideEdge(x, y, CAR_L / 2 + 2) && farFrom(x, y, CAR_L / 2 + 8) &&
          trees.every(t => Math.hypot(t.x - x, t.y - y) > t.r + CAR_L / 2 + 4)) qaPos = { x, y };
    }
    if (!qaPos) qaPos = { x: start.x, y: start.y > 95 ? start.y - 64 : start.y + 64 };
    c.x = qaPos.x; c.y = qaPos.y; c.hx = 1; c.hy = 0; c.v = 0;
    c.broken = true; c.breakReason = 'qa'; c.hazard = 17.8; c.hold = true;
    c.damage.integrity = 24; c.damage.engine = 4; c.damage.wheel = .72;
    c.damage.crush.front = 1; c.damage.crush.left = .58;
    c.damage.glass.front = .05; c.damage.glass.left = .12;
    c.damage.lights.frontLeft = 0; c.damage.lights.frontRight = 0;
    c.damage.mirrors.left = 0;
    setOBB(c.box, c.x, c.y, 0, CAR_L / 2, CAR_W / 2);
    syncCarBody(c);
    deformCarBody(c, c.x + 23, c.y - 5, 1, 0, 238);
    deformCarBody(c, c.x + 18, c.y + 10, .35, 1, 142);
    c.damage.plasticWork = c.body.plasticWork; c.damage.maxStrain = c.body.maxStrain;
  }

  // ---------- зомби ----------
  const zombies = [];
  // Первый район сразу даёт достаточно целей для стрельбы, затем толпа растёт,
  // но верхний предел сохраняет приемлемую квадратичную проверку раздвигания тел.
  const nz = Math.min(11 + level * 3, 32);
  const zspd = 1 + (level - 1) * .06;
  const typeOffset = (Math.random() * ZOMBIE_TYPES.length) | 0;
  const addZombie = (s, guardParcel = -1) => {
    const k = zombies.length, parcel = guardParcel >= 0 ? parcels[guardParcel] : null;
    const type = ZOMBIE_TYPES[(k + typeOffset) % ZOMBIE_TYPES.length];
    zombies.push({
      x: s.x, y: s.y, kind: type.id, hp: type.hp, maxHp: type.hp,
      skin: type.skin, clothes: type.clothes, eye: type.eye, trail: type.trail, mapColor: type.map,
      blood: type.blood, stain: type.stain, shot: type.shot,
      ang: rnd(0, 6.283), wdir: rnd(0, 6.283), wander: rnd(0, 2.5),
      spd: rnd(type.speed[0], type.speed[1]) * zspd, walk: rnd(0, 6), hit: 0, kx: 0, ky: 0, seed: Math.random(),
      bleed: 0, bleedCd: 0,
      alert: 0, tx: 0, ty: 0, hunt: 0, moan: rnd(0, 3),
      throwCd: rnd(1.8, 4.8), throwWind: 0, throwAimX: 0, throwAimY: 0,
      flankSide: k % 2 ? 1 : -1, flankBias: rnd(.78, 1.16), flankTimer: rnd(.6, 2.2), pressure: 0,
      dodgeTime: 0, dodgeDir: k % 2 ? 1 : -1, dodgeCd: rnd(.25, 1.35), recoil: 0,
      surge: 0, surgeCd: rnd(.8, 2.8), guardParcel,
      guardX: parcel ? parcel.x : 0, guardY: parcel ? parcel.y : 0, guardRadius: rnd(76, 112)
    });
  };

  // У каждой посылки всегда трое охранников. Получаются небольшие боевые группы,
  // а не одиночные цели, при сохранении безопасной дистанции от старта.
  for (let pi = 0; pi < parcels.length; pi++) {
    const pool = parcelGuardPools[pi].slice();
    for (let n = 0; n < 3; n++) {
      let choices = pool.filter(s => zombies.every(z => Math.hypot(z.x - s.x, z.y - s.y) > 34));
      if (!choices.length) choices = pool;
      if (!choices.length) choices = onFoot.filter(s =>
        Math.hypot(s.x - start.x, s.y - start.y) > START_GUARD_GAP &&
        Math.hypot(s.x - parcels[pi].x, s.y - parcels[pi].y) < 180);
      const s = choices.length ? pick(choices) : pick(onFoot.filter(q => Math.hypot(q.x - start.x, q.y - start.y) > START_GUARD_GAP));
      addZombie(s, pi);
    }
  }

  // Остальная часть популяции свободно бродит. Охрана входит в общий лимит сложности.
  const totalZombies = Math.max(nz, parcels.length * 3);
  while (zombies.length < totalZombies) {
    let s = null;
    for (let t = 0; t < 80 && !s; t++) {
      const c = pick(spots);
      if (Math.hypot(c.x - start.x, c.y - start.y) > 300 &&
          parcels.every(p => Math.hypot(c.x - p.x, c.y - p.y) > 135)) s = c;
    }
    if (!s) s = pick(spots);
    addZombie(s);
  }

  // Детерминированная мишень для визуальной проверки фонтанов и следов крови.
  // Обычная игра эту ветку никогда не включает.
  if (qaMode === 'zombie-blood' && zombies.length) {
    const z = zombies.find(o => o.kind === 'brute') || zombies[0];
    zombies.splice(0, zombies.length, z);
    cars.splice(0, cars.length);
    z.x = start.x; z.y = start.y - 58; z.ang = Math.PI / 2;
    z.hp = z.maxHp = 8; z.spd = 0; z.wander = 999; z.guardParcel = -1;
    z.alert = 0; z.hunt = 0; z.throwCd = 999; z.dodgeCd = 999; z.surgeCd = 999;
  }

  // ---------- ящики: патроны и батарейки ----------
  const ammoBoxes = [];
  for (let k = 0; k < 8; k++) {
    let s = null;
    for (let t = 0; t < 60 && !s; t++) {
      const c = pick(drop);
      if (Math.hypot(c.x - start.x, c.y - start.y) > 170 &&
          !ammoBoxes.some(a => Math.hypot(a.x - c.x, a.y - c.y) < 190)) s = c;
    }
    if (!s) {
      const fallback = drop.filter(c => Math.hypot(c.x - start.x, c.y - start.y) > 170 &&
        ammoBoxes.every(a => Math.hypot(a.x - c.x, a.y - c.y) >= 105));
      if (fallback.length) s = pick(fallback);
    }
    if (s) ammoBoxes.push({ x: s.x, y: s.y, batt: k % 2 === 1, n: 8, ph: Math.random() * 6.283 });
  }

  return {
    level, solids, trees, soft, houses, props, parcels, cars, goal, need, zombies, ammoBoxes,
    roads: R, lamps: props.filter(p => p.t === 'lamp'), parked: props.filter(p => p.t === 'parked'), roadDist,
    stat: renderStatic({ houses, trees, soft, props, roads: R, roadDist }),
    p: { x: start.x, y: start.y, vx: 0, vy: 0, kx: 0, ky: 0, ang: -Math.PI / 2, aim: -Math.PI / 2,
         tx: start.x, ty: start.y - 300,
         walk: 0, inv: 0, cool: 0, muzzle: 0, stagger: 0,
         torch: true, batt: 1, stam: 1, running: false, rest: 0, step: 0, flick: 1 },
    bullets: [], zombieShots: [], splats: [], stains: [], bloodDrops: [], rings: [], splash: [], carSmoke: [],
    weather: newWeather(), ammo: 24, killed: 0, filthThrown: 0, filthHits: 0, dodges: 0, surges: 0,
    carsBroken: carDamageQa ? 1 : 0, roadKills: 0,
    fog: new Float32Array(FW * FW), seen: new Uint8Array(FW * FW),   // туман войны
    fogActive: [], fogActiveMark: new Uint8Array(FW * FW),
    got: 0, lives: 3, time: 0, spawnGrace: 5, done: false, shake: 0, parts: [], cam: { x: 0, y: 0 },
    bloodQa: qaMode === 'zombie-blood', bloodQaDone: false
  };
}

// ---------- статичный слой города ----------
function renderStatic(g) {
  const s = document.createElement('canvas');
  s.width = s.height = WORLD;
  const c = s.getContext('2d');

  // трава по всему миру
  c.fillStyle = '#78b859'; c.fillRect(0, 0, WORLD, WORLD);
  for (let i = 0; i < 9000; i++) {
    c.fillStyle = Math.random() < .5 ? 'rgba(102,166,72,.6)' : 'rgba(150,210,114,.55)';
    c.fillRect(Math.random() * WORLD, Math.random() * WORLD, 3 + Math.random() * 5, 2);
  }
  for (let i = 0; i < 620; i++) {                    // цветочки
    c.fillStyle = pick(['#f6e05e', '#f6a5c0', '#ffffff', '#c3a2f0']);
    c.beginPath(); c.arc(Math.random() * WORLD, Math.random() * WORLD, 2, 0, 6.283); c.fill();
  }

  // ---------- улицы: широкой линией по кривой ----------
  const stroke = (w, style, dash) => {
    c.lineWidth = w; c.strokeStyle = style; c.lineCap = 'round'; c.lineJoin = 'round';
    c.setLineDash(dash || []);
    for (const e of g.roads.edges) {
      c.beginPath(); c.moveTo(e.pts[0].x, e.pts[0].y);
      for (let i = 1; i < e.pts.length; i++) c.lineTo(e.pts[i].x, e.pts[i].y);
      c.stroke();
    }
    c.setLineDash([]);
  };
  stroke(ROAD + 42, '#cfc9ba');                      // тротуар
  stroke(ROAD + 10, '#b3ac9c');                      // бордюр
  stroke(ROAD, '#4d525b');                           // асфальт
  for (let i = 0; i < 9000; i++) {                   // шум асфальта
    const x = Math.random() * WORLD, y = Math.random() * WORLD;
    if (g.roadDist(x, y) > ROAD / 2 - 7) continue;
    c.fillStyle = Math.random() < .5 ? 'rgba(255,255,255,.035)' : 'rgba(0,0,0,.07)';
    c.fillRect(x, y, 3, 3);
  }
  stroke(3, 'rgba(240,225,150,.75)', [22, 20]);      // осевая

  // зебры на подходах к перекрёсткам
  for (const n of g.roads.nodes) {
    if (n.e.length < 3) continue;
    for (const ei of n.e) {
      const e = g.roads.edges[ei];
      const at = e.a === n.i ? ROAD * .85 : e.len - ROAD * .85;
      if (at < 20 || at > e.len - 20) continue;
      const p = onEdge(e, at);
      c.save(); c.translate(p.x, p.y); c.rotate(Math.atan2(p.ty, p.tx));
      c.fillStyle = 'rgba(235,235,228,.8)';
      for (let k = -3; k <= 3; k++) c.fillRect(-6, k * 11 - 3, 12, 6);
      c.restore();
    }
  }

  // площадки и изгороди
  for (const p of g.props) {
    if (p.t !== 'lot' && p.t !== 'hedge') continue;
    c.save(); c.translate(p.cx, p.cy); c.rotate(p.ang);
    const w = p.hw * 2, h = p.hh * 2;
    if (p.t === 'lot') {
      c.fillStyle = '#6d6f72'; roundRect(c, -p.hw, -p.hh, w, h, 6); c.fill();
      c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 2;
      c.strokeRect(-p.hw + 5, -p.hh + 5, w - 10, h - 10);
    } else {
      c.fillStyle = 'rgba(0,0,0,.16)'; roundRect(c, -p.hw + 3, -p.hh + 5, w, h, 8); c.fill();
      c.fillStyle = '#3f7f3c'; roundRect(c, -p.hw, -p.hh, w, h, 8); c.fill();
      const n = Math.max(2, Math.round(w / 16));
      for (let k = 0; k < n; k++) {
        c.fillStyle = k % 2 ? '#4e9646' : '#59a850';
        c.beginPath(); c.arc(-p.hw + w * (k + .5) / n, 0, 9, 0, 6.283); c.fill();
      }
    }
    c.restore();
  }

  // кусты
  for (const b of g.soft) {
    c.fillStyle = 'rgba(0,0,0,.15)';
    c.beginPath(); c.ellipse(b.x + 3, b.y + 6, b.r, b.r * .6, 0, 0, 6.283); c.fill();
    for (let k = 0; k < 4; k++) {
      const a = b.seed * 6.283 + k * 1.57;
      c.fillStyle = ['#67b25c', '#74c268', '#5aa551', '#7ecd70'][k];
      c.beginPath(); c.arc(b.x + Math.cos(a) * b.r * .38, b.y + Math.sin(a) * b.r * .32, b.r * .62, 0, 6.283); c.fill();
    }
  }

  // дома
  for (const h of g.houses) drawHouse(c, h);

  // припаркованные машины
  for (const p of g.props) if (p.t === 'parked') {
    c.save(); c.translate(p.cx, p.cy); c.rotate(p.ang);
    drawCarShape(c, p);
    c.restore();
  }

  // деревья — поверх всего, кроме динамики
  for (const t of g.trees) {
    c.fillStyle = 'rgba(0,0,0,.22)';
    c.beginPath(); c.ellipse(t.x + 7, t.y + 10, t.r * 1.05, t.r * .7, 0, 0, 6.283); c.fill();
    c.fillStyle = '#6b4a2f';
    c.beginPath(); c.arc(t.x, t.y, t.r * .28, 0, 6.283); c.fill();
    const greens = ['#2f7a35', '#3c8c3c', '#49a247', '#57b354'];
    for (let k = 0; k < 6; k++) {
      const a = t.seed * 6.283 + k * 1.047, d = t.r * .5;
      c.fillStyle = greens[k % 4];
      c.beginPath(); c.arc(t.x + Math.cos(a) * d, t.y + Math.sin(a) * d, t.r * .62, 0, 6.283); c.fill();
    }
    c.fillStyle = 'rgba(160,225,140,.55)';
    c.beginPath(); c.arc(t.x - t.r * .3, t.y - t.r * .35, t.r * .34, 0, 6.283); c.fill();
  }

  // фонари и лавки
  for (const p of g.props) {
    if (p.t === 'lamp') {
      c.fillStyle = 'rgba(0,0,0,.2)';
      c.beginPath(); c.ellipse(p.x + 5, p.y + 6, 7, 4.5, 0, 0, 6.283); c.fill();
      c.fillStyle = '#3c4450'; c.beginPath(); c.arc(p.x, p.y, 4.5, 0, 6.283); c.fill();
      c.fillStyle = '#ffe9a8'; c.beginPath(); c.arc(p.x, p.y, 2.4, 0, 6.283); c.fill();
    }
    if (p.t === 'bench') {
      c.save(); c.translate(p.x, p.y); c.rotate(p.a);
      c.fillStyle = 'rgba(0,0,0,.2)'; roundRect(c, -13, -4, 28, 13, 3); c.fill();
      c.fillStyle = '#a9773f'; roundRect(c, -15, -7, 30, 12, 3); c.fill();
      c.fillStyle = '#8a5f31'; c.fillRect(-15, -7, 30, 3);
      c.restore();
    }
  }
  return s;
}

function drawHouse(c, h) {
  const hw = h.hw, hh = h.hh, w = hw * 2, hg = hh * 2;
  c.save(); c.translate(h.cx + 7, h.cy + 11); c.rotate(h.ang);      // тень падает вниз-вправо
  c.fillStyle = 'rgba(0,0,0,.25)'; roundRect(c, -hw, -hh, w, hg, 4); c.fill();
  c.restore();

  c.save(); c.translate(h.cx, h.cy); c.rotate(h.ang);
  // стены
  c.fillStyle = h.wall; roundRect(c, -hw, -hh, w, hg, 3); c.fill();
  c.strokeStyle = 'rgba(0,0,0,.28)'; c.lineWidth = 2; c.stroke();
  // крыша: скаты от краёв к коньку
  const in1 = Math.min(w, hg) * .2;
  const rx = -hw + in1, ry = -hh + in1, rw = w - in1 * 2, rh = hg - in1 * 2;
  c.fillStyle = h.roof;
  roundRect(c, -hw + 3, -hh + 3, w - 6, hg - 6, 3); c.fill();
  c.fillStyle = 'rgba(255,255,255,.13)';
  c.beginPath(); c.moveTo(-hw + 3, -hh + 3); c.lineTo(hw - 3, -hh + 3); c.lineTo(rx + rw, ry); c.lineTo(rx, ry); c.fill();
  c.fillStyle = 'rgba(0,0,0,.22)';
  c.beginPath(); c.moveTo(-hw + 3, hh - 3); c.lineTo(hw - 3, hh - 3); c.lineTo(rx + rw, ry + rh); c.lineTo(rx, ry + rh); c.fill();
  c.strokeStyle = 'rgba(0,0,0,.3)'; c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(-hw + 3, -hh + 3); c.lineTo(rx, ry); c.moveTo(hw - 3, -hh + 3); c.lineTo(rx + rw, ry);
  c.moveTo(-hw + 3, hh - 3); c.lineTo(rx, ry + rh); c.moveTo(hw - 3, hh - 3); c.lineTo(rx + rw, ry + rh);
  c.stroke();
  // конёк
  c.strokeStyle = 'rgba(255,255,255,.28)'; c.lineWidth = 3;
  c.beginPath();
  if (rw > rh) { c.moveTo(rx, ry + rh / 2); c.lineTo(rx + rw, ry + rh / 2); }
  else { c.moveTo(rx + rw / 2, ry); c.lineTo(rx + rw / 2, ry + rh); }
  c.stroke();
  // труба
  c.fillStyle = '#8b6b57'; c.fillRect(-hw + w * (.22 + h.seed * .5), -hh + hg * .18, 13, 13);
  c.fillStyle = 'rgba(0,0,0,.3)'; c.fillRect(-hw + w * (.22 + h.seed * .5), -hh + hg * .18, 13, 4);
  // крыльцо с дверью — со стороны улицы
  c.save(); c.scale(1, h.face);
  c.fillStyle = '#bdb3a1'; c.fillRect(-18, hh - 4, 36, 9);
  c.fillStyle = h.target ? '#57c057' : '#6d4b32';
  roundRect(c, -13, hh - 12, 26, 14, 3); c.fill();
  c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1.5; c.stroke();
  c.restore();
  if (h.target) {
    c.fillStyle = 'rgba(120,240,120,.35)';
    c.beginPath(); c.arc(0, h.face * (hh + 4), 30, 0, 6.283); c.fill();
  }
  c.restore();
}

function drawCarShape(c, car) {
  // Машина смотрит вправо. Все точки ниже проходят через физическую сетку кузова.
  const d = car.damage || newCarDamage();
  const body = car.body || (car.body = createCarBody());
  const seed = car.seed || .37;
  const hazardOn = car.hazard > 0 && ((car.hazard * 5) | 0) % 2 === 0;
  const M = (x, y) => bodyPointLocal(car, x, y);
  const polygon = points => {
    c.beginPath();
    points.forEach((p, i) => { const q = M(p[0], p[1]); if (i) c.lineTo(q.x, q.y); else c.moveTo(q.x, q.y); });
    c.closePath();
  };
  const line = points => {
    c.beginPath();
    points.forEach((p, i) => { const q = M(p[0], p[1]); if (i) c.lineTo(q.x, q.y); else c.moveTo(q.x, q.y); });
    c.stroke();
  };
  const outline = body.outline.map(i => body.nodes[i]);

  // Тень и четыре отдельные шины; при повреждении ходовой колёса стоят чуть криво.
  c.fillStyle = 'rgba(0,0,0,.3)';
  c.beginPath(); outline.forEach((p, i) => i ? c.lineTo(p.x + 4, p.y + 6) : c.moveTo(p.x + 4, p.y + 6)); c.closePath(); c.fill();
  const wheelDamage = d.wheel || 0;
  for (const wheel of [[-13, -11], [13, -11], [-13, 11], [13, 11]]) {
    const p = M(wheel[0], wheel[1]), q = M(wheel[0] + 4, wheel[1]);
    c.save(); c.translate(p.x, p.y);
    c.rotate(Math.atan2(q.y - p.y, q.x - p.x) + (wheel[0] > 0 ? 1 : -1) * wheelDamage * .32);
    c.fillStyle = '#171a1e'; roundRect(c, -4.2, -2.1, 8.4, 4.2, 1.4); c.fill();
    c.fillStyle = '#777d82'; c.fillRect(-2.1, -.55, 4.2, 1.1);
    c.restore();
  }

  // Сам внешний контур — это граничные узлы физического тела, без отдельной художественной деформации.
  c.beginPath(); outline.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.closePath();
  c.fillStyle = car.col || '#9a4f47'; c.fill();
  c.strokeStyle = 'rgba(8,10,13,.78)'; c.lineWidth = 1.45; c.stroke();
  if (car.hitFlash > 0) {
    c.fillStyle = `rgba(255,235,175,${clamp(car.hitFlash * 3.5, 0, .55)})`;
    c.beginPath(); outline.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.closePath(); c.fill();
  }

  // Сжатые ячейки дают постоянные тёмные плоскости на самом металле. Это не
  // маска повреждения: четырёхугольники являются теми же физическими ячейками,
  // а интенсивность определяется потерей площади и смещением их узлов.
  if (body.revision) for (let gy = 0; gy < body.rows - 1; gy++) for (let gx = 0; gx < body.cols - 1; gx++) {
    const i = gy * body.cols + gx;
    const a = body.nodes[i], b = body.nodes[i + 1], d0 = body.nodes[i + body.cols], e = body.nodes[i + body.cols + 1];
    const restArea = Math.abs((b.restX - a.restX) * (d0.restY - a.restY)) || 1;
    const area = Math.abs((b.x - a.x) * (d0.y - a.y) - (b.y - a.y) * (d0.x - a.x));
    const offset = (Math.hypot(a.x-a.restX,a.y-a.restY) + Math.hypot(b.x-b.restX,b.y-b.restY) +
      Math.hypot(d0.x-d0.restX,d0.y-d0.restY) + Math.hypot(e.x-e.restX,e.y-e.restY)) * .25;
    const stress = Math.max(Math.abs(1 - area / restArea), offset / 8);
    if (stress < .12) continue;
    c.fillStyle = `rgba(16,18,21,${clamp(.08 + stress * .28, .1, .36)})`;
    c.beginPath(); c.moveTo(a.x,a.y); c.lineTo(b.x,b.y); c.lineTo(e.x,e.y); c.lineTo(d0.x,d0.y); c.closePath(); c.fill();
  }

  // Бамперы, капот, багажник и дверные щели делают автомобиль читаемым даже без повреждений.
  c.strokeStyle = 'rgba(20,22,25,.5)'; c.lineWidth = .8;
  line([[13,-10],[13,10]]); line([[-15,-10],[-15,10]]); line([[-1,-9],[-1,9]]);
  c.fillStyle = 'rgba(255,255,255,.18)';
  polygon([[-19,-10],[19,-10],[15,-8],[-18,-8]]); c.fill();

  // Складки рисуются там, где реально растянулись или сжались связи сетки.
  if (body.revision) for (const spring of body.springs) {
    const a = body.nodes[spring.a], b = body.nodes[spring.b];
    const strain = Math.abs(Math.hypot(b.x - a.x, b.y - a.y) / spring.rest - 1);
    const mx = (a.restX + b.restX) * .5, my = (a.restY + b.restY) * .5;
    if (strain < .045 || (Math.abs(mx) < 10 && Math.abs(my) < 7)) continue;
    c.strokeStyle = `rgba(12,14,16,${clamp(.32 + strain * 2.2, .35, .92)})`; c.lineWidth = .85 + Math.min(.85, strain * 1.5);
    c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
  }

  const glassFill = value => value <= .16 ? '#15181b' : value < .55 ? '#24303a' : '#2d4354';
  const drawCracks = (x, y, value, sx, sy) => {
    if (value >= .78) return;
    c.strokeStyle = value <= .16 ? 'rgba(210,226,235,.42)' : 'rgba(225,238,245,.7)';
    c.lineWidth = .65;
    const rays = value <= .16 ? 5 : 3;
    for (let i = 0; i < rays; i++) {
      const a = seed * 5.7 + i * 2.07;
      line([[x,y],[x + Math.cos(a) * sx,y + Math.sin(a) * sy]]);
    }
  };

  // Переднее и заднее стёкла плюс отдельные боковые окна.
  c.fillStyle = glassFill(d.glass.front); polygon([[6,-7.6],[10,-6.7],[10,6.7],[6,7.6]]); c.fill();
  drawCracks(8, 0, d.glass.front, 3.5, 6.5);
  c.fillStyle = glassFill(d.glass.rear); polygon([[-10,-6.9],[-6.5,-7.8],[-6.5,7.8],[-10,6.9]]); c.fill();
  drawCracks(-8.2, 0, d.glass.rear, 3, 5.8);

  c.fillStyle = glassFill(d.glass.left); polygon([[-5.5,-9],[5,-9],[6.6,-7.6],[-6.3,-7.6]]); c.fill();
  drawCracks(0, -8.2, d.glass.left, 5.5, 2.2);
  c.fillStyle = glassFill(d.glass.right); polygon([[-6.3,7.6],[6.6,7.6],[5,9],[-5.5,9]]); c.fill();
  drawCracks(0, 8.2, d.glass.right, 5.5, 2.2);
  c.strokeStyle = 'rgba(205,225,238,.32)'; c.lineWidth = .65; line([[-4.8,-8.7],[3.7,-8.7]]); line([[-4.8,8.7],[3.7,8.7]]);

  // Зеркала выступают за кузов и исчезают после бокового удара.
  for (const sideName of ['left', 'right']) {
    const sy = sideName === 'left' ? -12.1 : 12.1, p = M(6, sy);
    if (d.mirrors[sideName] > .2) {
      c.fillStyle = car.col || '#9a4f47'; c.beginPath(); c.arc(p.x, p.y, 2, 0, 6.283); c.fill();
      c.fillStyle = '#9fb4c0'; c.beginPath(); c.arc(p.x + .65, p.y, .65, 0, 6.283); c.fill();
    } else {
      c.strokeStyle = '#25292d'; line([[4,sideName === 'left' ? -11 : 11],[6,sy]]);
    }
  }

  const lamp = (x, y, value, normal, hazard) => {
    const p = M(x, y);
    c.fillStyle = value > .22 ? (hazard ? '#ffb13e' : normal) : '#25292d';
    c.beginPath(); c.ellipse(p.x, p.y, 1.6, 2.35, 0, 0, 6.283); c.fill();
    if (value <= .22) { c.strokeStyle = '#8d969b'; c.lineWidth = .6; c.beginPath(); c.moveTo(p.x - 1, p.y - 1.6); c.lineTo(p.x + 1, p.y + 1.6); c.stroke(); }
  };
  lamp(22, -7, d.lights.frontLeft, '#fff0a8', hazardOn);
  lamp(22, 7, d.lights.frontRight, '#fff0a8', hazardOn);
  lamp(-22, -7, d.lights.rearLeft, '#d94b42', hazardOn);
  lamp(-22, 7, d.lights.rearRight, '#d94b42', hazardOn);

  if (car.broken) {                                             // заклинивший капот и обгоревшая решётка
    c.fillStyle = 'rgba(23,24,25,.55)'; polygon([[12,-9],[22,-7],[19,8],[11,9]]); c.fill();
    c.strokeStyle = '#0f1112'; c.lineWidth = 1.2;
    line([[14,-5],[20,0],[13,5]]);
  }

  // Пулевые отметины хранятся в локальных координатах физического кузова,
  // поэтому продолжают следовать за панелью, если следующий удар её сомнёт.
  for (const dent of car.bulletDents || []) {
    const p = M(dent.x, dent.y), a = dent.seed * 6.283;
    c.fillStyle = '#111417'; c.beginPath(); c.arc(p.x, p.y, 1.25, 0, 6.283); c.fill();
    c.strokeStyle = 'rgba(205,215,220,.72)'; c.lineWidth = .55;
    c.beginPath(); c.arc(p.x, p.y, 2.1, a, a + 4.7); c.stroke();
  }

  if (car.police) {                                             // ливрея и мигалка на крыше
    c.strokeStyle = '#1f3f7a'; c.lineWidth = 2;
    line([[-19,-8.8],[18,-8.8]]); line([[-19,8.8],[18,8.8]]);
    const rp = .5 + .5 * Math.sin((car.beacon || 0) * 3.1), bp = 1 - rp;
    const beacon = M(0, 0);
    c.fillStyle = '#20242c'; roundRect(c, beacon.x - 3.8, beacon.y - 3, 7.6, 6, 1.5); c.fill();
    c.fillStyle = `rgba(255,70,70,${.25 + .75 * rp})`; c.fillRect(beacon.x - 3.2, beacon.y - 2.4, 3.2, 4.8);
    c.fillStyle = `rgba(90,140,255,${.25 + .75 * bp})`; c.fillRect(beacon.x, beacon.y - 2.4, 3.2, 4.8);
  }

  if (car.honk > 0 && !car.broken) {
    const front = M(23, 0);
    c.strokeStyle = `rgba(255,240,140,${car.honk})`; c.lineWidth = 2;
    for (let k = 1; k <= 2; k++) { c.beginPath(); c.arc(front.x + 4, front.y, 6 + k * 6, -.7, .7); c.stroke(); }
  }
}

return Object.freeze({ buildTown, drawHouse, drawCarShape });
})();

