// District generation and static-object rendering.
window.TownGame.world = (() => {
'use strict';

const {
  W, H, WORLD, ROAD, CAR_L, CAR_W, ZR, HP_MAX,
  clamp, rnd, pick, obb, setOBB, distOBB, roundRect,
  WALLS, ROOFS, CARCOL
} = window.TownGame.core;
const {
  FW, makeRoads, onEdge, nearRoad, newWeather, placeCar, newCarDamage
} = window.TownGame.environment;
const { createCarBody, syncCarBody, deformCarBody, bodyPointLocal } = window.TownGame.carPhysics;

// The three body constructions differ in more than color: light cars crumple more
// and accelerate faster, while heavy cars transfer more impulse and survive impacts.
const CAR_BUILDS = Object.freeze([
  Object.freeze({ name: 'light', mass: .78, stiffness: .76, durability: .82, speed: 1.08 }),
  Object.freeze({ name: 'standard', mass: 1, stiffness: 1, durability: 1, speed: 1 }),
  Object.freeze({ name: 'heavy', mass: 1.38, stiffness: 1.36, durability: 1.32, speed: .88 })
]);
// Street lighting in a town like this is sodium, not daylight: the whole range sits in the
// yellows, and the coolest lamp on the block is a tired white rather than anything blue. The
// spread is kept because a street where every lamp matches looks designed instead of built.
const LAMP_TEMPERATURES = Object.freeze([
  Object.freeze({ rgb: Object.freeze([1, .52, .17]), bulb: '#ffbe62', power: 1.04 }),
  Object.freeze({ rgb: Object.freeze([1, .62, .25]), bulb: '#ffcc78', power: 1.02 }),
  Object.freeze({ rgb: Object.freeze([1, .71, .34]), bulb: '#ffd68e', power: 1 }),
  Object.freeze({ rgb: Object.freeze([1, .79, .46]), bulb: '#ffe1a6', power: .98 }),
  Object.freeze({ rgb: Object.freeze([1, .88, .62]), bulb: '#ffecc4', power: .95 })
]);
// Everything below is tuned per unit of area rather than per district, so the density of
// houses, trees, traffic, and the horde survives any change to the road grid. The
// reference is the original 1530-pixel town.
const AREA = (WORLD / 1530) ** 2;
const per = n => Math.round(n * AREA);

// Street furniture must stay inside the narrow visible sidewalk strip. Checking
// the nearest road, rather than only offsetting from the current edge, keeps a
// lamp beside an acute junction from landing on another branch of asphalt.
const SIDEWALK_CENTER = ROAD / 2 + 14;
const SIDEWALK_INNER = ROAD / 2 + 9;
const SIDEWALK_OUTER = (ROAD + 42) / 2 - 4;
const FURNITURE_NODE_CLEARANCE = ROAD * 1.15;
// A street lamp is a mast on the kerb with a bracket reaching out over the asphalt, so the
// pool of light lands on the lane rather than on the pavement behind it.
const LAMP_ARM = 38;
const LAMP_FAULTY_SHARE = .16;                    // Roughly one lamp in six is failing.

// ---------- madness ----------
// The bench, and how fast it empties. A body that falls goes back on the bench and comes out
// again as somebody else, so the reserve is a limit on how many can be on the street at once
// rather than on how long the mode lasts.
const MADNESS_RESERVE = 96;
const MADNESS_FIRST = 3;                          // Seconds of quiet before the first arrival.
const LAMP_HEAD_R = 6.5;                          // The glass a bullet has to find.
const CROSSWALK_SETBACKS = [ROAD * 1.05, ROAD * 1.35, ROAD * 1.65];
const CROSSWALK_MIN_GAP = ROAD * .74;

// One lamp: the mast stands where it was placed, the head hangs at the end of the bracket,
// and the light is emitted from the head. A broken lamp keeps its geometry and loses its glow.
function makeLamp(x, y, armX, armY, temperature, arm = LAMP_ARM) {
  // One draw, as before. Whether the bulb is on its way out is read off that same number rather
  // than spending another, which keeps the district's random stream exactly where it was.
  const seed = Math.random();
  return {
    t: 'lamp', x, y, arm,
    hx: x + armX * arm, hy: y + armY * arm, ang: Math.atan2(armY, armX), headR: LAMP_HEAD_R,
    lampRgb: temperature.rgb, bulb: temperature.bulb, lampPower: temperature.power,
    broken: false, faulty: seed < LAMP_FAULTY_SHARE, seed
  };
}

// A bulb on its way out does not blink on a beat. It sits low, wavers, and every few seconds
// drops almost out before catching again. Three waves whose periods do not divide into each
// other never settle into a rhythm, and the whole thing is a function of the district clock and
// the lamp's own seed — so it costs no random draw, and two machines sharing a district flicker
// in step without a byte crossing between them.
function lampGlow(l, time) {
  if (!l.faulty) return 1;
  const t = time * (1.7 + l.seed * 2.6) + l.seed * 37;
  const w = Math.sin(t) + Math.sin(t * 2.31) + Math.sin(t * 5.77);
  return w < -1.7 ? .1 : clamp(.78 + w * .07, 0, 1);
}

function sidewalkPoint(roads, edge, distance, side) {
  const p = onEdge(edge, distance);
  const x = p.x - p.ty * SIDEWALK_CENTER * side;
  const y = p.y + p.tx * SIDEWALK_CENTER * side;
  const d = nearRoad(roads, x, y).d;
  if (d < SIDEWALK_INNER || d > SIDEWALK_OUTER) return null;
  return { x, y, side, tx: p.tx, ty: p.ty };
}

// Acute approaches need different setbacks. Try several conventional positions
// and accept a crossing only when its entire painted envelope has room. This also
// protects both ends of an unusually short street from painting over each other.
function layoutCrosswalks(roads) {
  const marks = [];
  for (const n of roads.nodes) {
    if (n.e.length < 3) continue;
    for (const ei of n.e) {
      const e = roads.edges[ei];
      const fromStart = e.a === n.i;
      for (const setback of CROSSWALK_SETBACKS) {
        const at = fromStart ? setback : e.len - setback;
        if (at < 20 || at > e.len - 20) continue;
        const p = onEdge(e, at);
        if (marks.some(q => Math.hypot(q.x - p.x, q.y - p.y) < CROSSWALK_MIN_GAP)) continue;
        marks.push({ x: p.x, y: p.y, tx: p.tx, ty: p.ty, edge: ei, node: n.i, setback });
        break;
      }
    }
  }
  return marks;
}

function applyCarBuild(c) {
  const build = CAR_BUILDS[c.model % CAR_BUILDS.length];
  c.build = build.name; c.mass = build.mass; c.stiffness = build.stiffness; c.durability = build.durability;
  if (Number.isFinite(c.max)) c.max *= build.speed;
  return c;
}

// Base archetypes cycle so every district is guaranteed to contain all types.
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

// The tank is deliberately kept out of the cycled archetypes: it never guards a parcel and
// never appears alone. It roams the map in packs, soaks ten hits, throws nothing, and has
// no tactics at all — it simply walks at whatever it noticed. It is meant to be walked around.
const TANK_TYPE = Object.freeze({
  id: 'tank', hp: 10, speed: [44, 56], size: 1.7, dumb: true,
  skin: '#7a8878', clothes: '#3d4753', eye: '#ff7a2f', trail: '#93a2ae', map: '#cdd8e4',
  blood: ['#6f9c33', '#456f22', '#95c247'], stain: [56, 92, 26], shot: null
});

// One courier on the shift. Health, ammunition, the flashlight and what is on the back belong
// to the person carrying them rather than to the district, which is what lets a second one
// exist without either of them reaching into the other's pockets.
function makeCourier(start, index, torch) {
  return {
    id: index,
    x: start.x, y: start.y, vx: 0, vy: 0, kx: 0, ky: 0,
    ang: -Math.PI / 2, aim: -Math.PI / 2, tx: start.x, ty: start.y - 300,
    walk: 0, inv: 0, cool: 0, muzzle: 0, stagger: 0,
    torch, batt: 1, stam: 1, running: false, moving: false, rest: 0, step: 0, flick: 1,
    takedown: 0, finishHeld: false, sneaking: false, sneakToggle: false,
    torchSeen: null, sneakSeen: null,             // Adopted from the press counters on the first frame.
    // A courier always has a record, even before anyone has told it anything: standing still,
    // holding nothing. A partner whose first packet has not landed yet must not stop the frame.
    in: { n: 0, x: 0, y: 0, m: 0, run: false, fire: false, finish: false,
          aimScreen: false, sx: 0, sy: 0, tx: 0, ty: 0, torchSeq: 0, sneakSeq: 0 },
    reviveT: 0,                                   // How long a partner has been kneeling over them.
    hp: HP_MAX, hpMax: HP_MAX, ammo: 24, down: false,
    carried: 0, handsFull: null, finishTarget: null,
    stealthNotice: 0, stealthWatchers: 0, stealthDetected: false, stealthCrawlTime: 0
  };
}

// Put a zombie back to how it stood the moment the district was built, at a new place.
//
// Madness never creates a zombie. It cannot: a snapshot names entities by id and the far end
// only ever updates what it already has, so a horde that grew would be a horde the guest could
// not see. Instead the district is built with a reserve nobody is simulating, and this is what
// wakes one — and what takes a body and hands it back as somebody new, which is why madness can
// go on longer than the reserve is deep.
//
// Everything a type decides — how it looks, how fast it is, what it throws — is left alone. Only
// what a life did to it is undone.
function resetZombie(z, x, y) {
  z.x = x; z.y = y;
  z.hp = z.maxHp; z.gone = false;
  z.ang = rnd(0, 6.283); z.wdir = rnd(0, 6.283); z.wander = rnd(0, 2.5);
  z.walk = rnd(0, 6); z.hit = 0; z.kx = 0; z.ky = 0; z.mvx = 0; z.mvy = 0;
  z.lostArms = 0; z.headless = false; z.silent = false;
  z.bleed = 0; z.bleedCd = 0; z.recoil = 0;
  z.alert = 0; z.tx = 0; z.ty = 0; z.hunt = 0; z.notice = 0; z.moan = rnd(0, 3);
  z.throwCd = rnd(1.8, 4.8); z.throwWind = 0; z.throwAimX = 0; z.throwAimY = 0;
  z.flankTimer = rnd(.6, 2.2); z.pressure = 0;
  z.dodgeTime = 0; z.dodgeCd = rnd(.25, 1.35);
  z.surge = 0; z.surgeCd = rnd(.8, 2.8);
  z.guardParcel = -1; z.guardX = 0; z.guardY = 0;      // A latecomer guards nothing; it just arrives.
  z.foeCar = null; z.foeCd = rnd(0, 1.2); z.foeHitCd = 0; z.tankHitCd = 0;
  z.rival = null; z.rivalCd = 0; z.prey = null;
  return z;
}

// A fingerprint of the shape of a district, so two peers can prove they really did build the
// same one before anybody starts walking around in it.
//
// Generation leans on cos, sin, atan2 and hypot, and the language does not require those to
// agree to the last bit across engines. One ulp in the wrong place moves a house, which moves
// everything decided after it — and that would otherwise surface as a desync ten seconds into a
// shift, looking like a network fault rather than what it is. Coordinates are rounded before
// mixing, so the check tolerates the last bit of arithmetic noise and still catches a district
// that is genuinely not the same district.
function layoutChecksum(g) {
  let h = 0x811c9dc5;
  const mix = v => { h ^= Math.round(v) | 0; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(g.level); mix(g.need);
  for (const n of g.roads.nodes) { mix(n.x); mix(n.y); }
  for (const house of g.houses) { mix(house.cx); mix(house.cy); mix(house.hw); mix(house.hh); }
  for (const b of g.parcels) { mix(b.x); mix(b.y); mix(b.dest.x); mix(b.dest.y); }
  for (const z of g.zombies) { mix(z.x); mix(z.y); mix(z.hp); }
  // The bench is part of the district too: two ends that disagree about it would disagree about
  // every arrival for the rest of the run.
  for (const z of (g.reserve || [])) { mix(z.x); mix(z.y); mix(z.hp); }
  for (const c of g.cars) { mix(c.x); mix(c.y); }
  for (const l of g.lamps) { mix(l.x); mix(l.y); }
  for (const p of g.players) { mix(p.x); mix(p.y); }
  return h.toString(16).padStart(8, '0');
}

// ---------- district generation ----------
function buildTown(level, couriers = 1, madness = false) {
  const qaMode = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('qa') : '';
  const stealthQa = qaMode === 'stealth' || qaMode === 'stealth-walk' || qaMode === 'stealth-crawl';
  const R = makeRoads();
  const solids = [];   // Oriented boxes: houses, hedges, and parked cars.
  const trees  = [];   // {x,y,r}
  const soft   = [];   // Bushes that slow movement.
  const houses = [];
  const props  = [];   // Lamps, benches, and driveways used only for rendering.
  const CELL = 20, gw = Math.ceil(WORLD / CELL);
  const EDGE_LANE = 54; // Clear route along the edge where no solid object may be placed.
  const insideEdge = (x, y, r = 0) =>
    x - r > EDGE_LANE && y - r > EDGE_LANE && x + r < WORLD - EDGE_LANE && y + r < WORLD - EDGE_LANE;

  // ---------- distance field from asphalt ----------
  const rdist = new Float32Array(gw * gw).fill(1e9);
  for (const e of R.edges) for (let s = 0; s <= e.len; s += 8) {
    const p = onEdge(e, s);
    const gx = (p.x / CELL) | 0, gy = (p.y / CELL) | 0;
    // The window must cover the whole strip where houses may stand, otherwise the
    // field never measures those cells and every candidate there looks infinitely far.
    for (let j = Math.max(0, gy - 13); j <= Math.min(gw - 1, gy + 13); j++)
      for (let i = Math.max(0, gx - 13); i <= Math.min(gw - 1, gx + 13); i++) {
        const d = Math.hypot(i * CELL + 10 - p.x, j * CELL + 10 - p.y);
        if (d < rdist[j * gw + i]) rdist[j * gw + i] = d;
      }
  }
  const roadDist = (x, y) =>
    rdist[clamp((y / CELL) | 0, 0, gw - 1) * gw + clamp((x / CELL) | 0, 0, gw - 1)];
  const farFrom = (x, y, pad, skip) => !solids.some(q => q !== skip && Math.hypot(q.cx - x, q.cy - y) < q.rad + pad);

  // ---------- houses along roads, facing the street ----------
  const CURB = ROAD / 2 + 30;
  for (let tries = 0; tries < per(2600) && houses.length < per(32); tries++) {
    // Sample the strip along the road directly. Uniform sampling over the whole map
    // spends almost every try deep inside a block where no house may stand anyway.
    const e = pick(R.edges);
    const q = onEdge(e, rnd(0, e.len));
    const off = rnd(CURB + 40, CURB + 132) * (Math.random() < .5 ? 1 : -1);
    const x = q.x - q.ty * off, y = q.y + q.tx * off;
    if (x < 70 || y < 70 || x > WORLD - 70 || y > WORLD - 70) continue;
    const d = roadDist(x, y);
    if (d < CURB + 34 || d > CURB + 140) continue;   // A band of houses along each side of the street.
    const near = nearRoad(R, x, y);
    const ang = near.ang + rnd(-.1, .1);
    const hw = rnd(50, 78), hh = rnd(42, 62);
    const c = Math.cos(ang), s = Math.sin(ang);
    const face = ((near.y - y) * c - (near.x - x) * s) > 0 ? 1 : -1;   // Which side the street is on.
    const h = obb(x, y, ang, hw, hh, { wall: pick(WALLS), roof: pick(ROOFS), seed: Math.random(), face });
    if (!insideEdge(x, y, h.rad)) continue;
    if (!farFrom(x, y, h.rad + 22)) continue;
    houses.push(h); solids.push(h);

    // Driveway with a car beside the house.
    if (Math.random() < .5) {
      const lx = (Math.random() < .5 ? 1 : -1) * (hw + 36), ly = face * hh * .3;
      const px = x + lx * c - ly * s, py = y + lx * s + ly * c;
      if (insideEdge(px, py, 36) && roadDist(px, py) > CURB - 4 && farFrom(px, py, 40, h)) { // The house itself does not block its driveway.
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

  // ---------- hedges ----------
  for (let tries = 0, k = 0; tries < per(1400) && k < per(16); tries++) {
    const x = rnd(60, WORLD - 60), y = rnd(60, WORLD - 60);
    if (roadDist(x, y) < CURB + 24) continue;
    const o = obb(x, y, rnd(0, 6.283), rnd(38, 78), 9, { t: 'hedge' });
    if (!insideEdge(x, y, o.rad)) continue;
    if (!farFrom(x, y, o.rad + 18)) continue;
    solids.push(o); props.push(o); k++;
  }

  // ---------- trees and bushes ----------
  for (let tries = 0; tries < per(4000) && trees.length < per(62); tries++) {
    const x = rnd(34, WORLD - 34), y = rnd(34, WORLD - 34), r = rnd(15, 22);
    if (!insideEdge(x, y, r)) continue;
    if (roadDist(x, y) < ROAD / 2 + 19) continue;
    if (!farFrom(x, y, r + 16)) continue;
    if (trees.some(t => Math.hypot(t.x - x, t.y - y) < t.r + r + 20)) continue;
    trees.push({ x, y, r, seed: Math.random(), foliage: 'tree' });
  }
  for (let tries = 0; tries < per(2600) && soft.length < per(46); tries++) {
    const x = rnd(30, WORLD - 30), y = rnd(30, WORLD - 30), r = rnd(16, 26);
    if (roadDist(x, y) < ROAD / 2 + 14) continue;
    if (!farFrom(x, y, r + 8)) continue;
    if (trees.some(t => Math.hypot(t.x - x, t.y - y) < t.r + r + 6)) continue;
    soft.push({ x, y, r, seed: Math.random(), foliage: 'bush' });
  }

  // ---------- lamps and benches along sidewalks ----------
  for (const e of R.edges) {
    let side = Math.random() < .5 ? 1 : -1;
    for (let s = FURNITURE_NODE_CLEARANCE + rnd(0, 70);
      s < e.len - FURNITURE_NODE_CLEARANCE; s += rnd(150, 210)) {
      let p = null;
      for (const candidateSide of [side, -side]) {
        const q = sidewalkPoint(R, e, s, candidateSide);
        if (!q || !insideEdge(q.x, q.y, 7)) continue;
        if (trees.some(t => Math.hypot(t.x - q.x, t.y - q.y) < t.r + 10)) continue;
        p = q; break;
      }
      if (!p) { side = -side; continue; }
      // The bracket points from the kerb toward the centreline of the street it belongs to.
      const armX = p.ty * p.side, armY = -p.tx * p.side;
      props.push(makeLamp(p.x, p.y, armX, armY, pick(LAMP_TEMPERATURES)));
      if (Math.random() < .3) {
        const bx = p.x - p.ty * 23 * p.side, by = p.y + p.tx * 23 * p.side;
        if (insideEdge(bx, by, 17) && nearRoad(R, bx, by).d > SIDEWALK_OUTER + 5 &&
          !trees.some(t => Math.hypot(t.x - bx, t.y - by) < t.r + 18))
          props.push({ t: 'bench', x: bx, y: by, a: Math.atan2(p.ty, p.tx) });
      }
      side = -p.side;
    }
  }

  // ---------- walkability grid for placement and reachability ----------
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

  // Spawn in the yard nearest the center instead of the middle of an intersection.
  let start = null;
  for (let pass = 0; pass < 2 && !start; pass++)
    for (let rad = 0; rad < 60 && !start; rad++) for (let a = 0; a < 32; a++) {
      const x = WORLD / 2 + Math.cos(a / 32 * 6.283) * rad * 14, y = WORLD / 2 + Math.sin(a / 32 * 6.283) * rad * 14;
      const gx = (x / CELL) | 0, gy = (y / CELL) | 0;
      if (gx < 0 || gy < 0 || gx >= gw || gy >= gw || !free[gy * gw + gx]) continue;
      if (!pass && rdist[gy * gw + gx] < ROAD / 2 + 30) continue;      // First pass searches yards only.
      start = { x: gx * CELL + 10, y: gy * CELL + 10 }; break;
    }

  // Flood fill from the spawn point to find all reachable cells.
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
  const spots = [], onFoot = [];                  // Yard spots and general walkable spots.
  for (let i = 0; i < reach.length; i++) if (reach[i]) {
    const x = (i % gw) * CELL + CELL / 2, y = ((i / gw) | 0) * CELL + CELL / 2;
    onFoot.push({ x, y });
    if (rdist[i] > ROAD / 2 + 26) spots.push({ x, y });
  }
  if (spots.length < 20) spots.push(...onFoot);   // Fall back when the district is mostly asphalt.
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

  // Reachable yard spots across the district. A clear 3x3 cell area prevents
  // parcels from appearing between a house and the edge or inside a narrow pocket.
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

  // ---------- parcels ----------
  const need = Math.min(4 + (level - 1), 12);
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
    // Multiple attempts find a spot with room for guards, not a distant corner.
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
    // carrier is the courier whose back it is on, so a parcel is signed off by whoever picked it up.
    parcels.push({ x: bestSpot.x, y: bestSpot.y, state: 'ground', dest: null, carrier: -1, ph: Math.random() * 6.283 });
    parcelGuardPools.push(guards);
    if (bestSpot.house) usedParcelHouses.add(bestSpot.house);
  }

  // ---------- destinations: one street-facing door per parcel ----------
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
  // Every parcel is addressed to its own house. No door is marked in the static layer:
  // an address is worth nothing until the parcel is on the courier's back, and twelve
  // green doors would give the whole district away from the start.
  const DEST_TRIP = 300;               // A delivery should be a walk, not a step aside.
  let destHouses = houses.filter(h => {
    const edge = Math.min(h.cx, h.cy, WORLD - h.cx, WORLD - h.cy);
    return edge > 150 && !usedParcelHouses.has(h) && doorOpen(h, doorOf(h));
  });
  if (destHouses.length < parcels.length) destHouses = houses.filter(h => doorOpen(h, doorOf(h)));
  if (!destHouses.length) destHouses = houses.slice();
  const takenDest = new Set();
  for (const b of parcels) {
    let choices = destHouses.filter(h => !takenDest.has(h) && Math.hypot(h.cx - b.x, h.cy - b.y) > DEST_TRIP);
    if (!choices.length) choices = destHouses.filter(h => !takenDest.has(h));
    if (!choices.length) choices = destHouses;          // A small district may address two parcels to one house.
    const h = pick(choices);
    takenDest.add(h);
    b.dest = { house: h, ...doorOf(h) };
  }

  // ---------- moving cars: follow roads and turn at intersections ----------
  const cars = [];
  const nCars = Math.min(11 + level, 22);           // More traffic than this turns the roads into a permanent jam.
  const spd = Math.min(1.34, 1 + (level - 1) * .08);   // Higher speeds prevent traffic from separating safely.
  for (let k = 0; k < nCars; k++) {
    for (let t = 0; t < 50; t++) {
      const e = pick(R.edges);
      if (e.len < 120) continue;
      const c = { id: k, edge: e, dir: Math.random() < .5 ? 1 : -1, s: rnd(40, e.len - 40),
                  mode: 'edge', turn: null,
                  v: 0, max: rnd(115, 175) * spd, col: pick(CARCOL), honk: 0, honked: false,
                  stall: 0, stuck: 0, cd: 0, dead: 0, hold: false, node: -1, jx: 0, jy: 0,
                  // Untangling a jam: back out, yield, and finally take another road.
                  rev: 0, revCd: 0, yieldTo: null, yieldT: 0, jamTries: 0, freeT: 0,
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
  // Patrol car: white with a beacon and noticeably faster than traffic.
  for (let k = 0, want = Math.min(3, cars.length); k < want; k++) {
    const c = cars[k];
    c.police = true; c.col = '#eef2f7'; c.max *= 1.35; c.beacon = rnd(0, 6.283);
    c.mass *= 1.12; c.stiffness *= 1.12; c.durability *= 1.18;
    c.copCd = rnd(.3, 1.1); c.copFlash = 0; c.copSide = 1;   // Ammunition is unlimited; only the cadence is limited.
    // Madness bolts a heavy gun to the roof. The mount has to traverse to point anywhere, so where
    // it is pointing is state the car carries: null until the crew first sees something worth
    // swinging onto, and held wherever the last burst left it after that.
    c.roofGun = madness; c.copAim = null; c.copBurst = 0; c.copPrey = null;
  }
  for (const c of cars) c.baseMax = c.max;

  // Deterministic QA scene that normal startup never enables.
  // It places a smoking wreck in the starting beam for immediate Canvas inspection.
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

  // ---------- zombies ----------
  const zombies = [];
  // The first district provides enough targets immediately, then the horde grows;
  // the upper limit keeps quadratic body-separation checks affordable.
  const nz = Math.min(per(11) + level * 4, 52);     // The cap keeps quadratic body separation affordable.
  const zspd = 1 + (level - 1) * .06;
  const typeOffset = (Math.random() * ZOMBIE_TYPES.length) | 0;
  const addZombie = (s, guardParcel = -1, forced = null) => {
    const k = zombies.length, parcel = guardParcel >= 0 ? parcels[guardParcel] : null;
    const type = forced || ZOMBIE_TYPES[(k + typeOffset) % ZOMBIE_TYPES.length];
    const size = type.size || 1;
    zombies.push({
      // A name that survives dying. The horde is spliced as it thins, so a place in the array
      // stops meaning anything the moment anyone falls — and the other end of a co-op session has
      // to be able to say which zombie it meant.
      id: k,
      x: s.x, y: s.y, kind: type.id, hp: type.hp, maxHp: type.hp,
      size, r: ZR * size, dumb: !!type.dumb,
      skin: type.skin, clothes: type.clothes, eye: type.eye, trail: type.trail, mapColor: type.map,
      blood: type.blood, stain: type.stain, shot: type.shot,
      ang: rnd(0, 6.283), wdir: rnd(0, 6.283), wander: rnd(0, 2.5),
      spd: rnd(type.speed[0], type.speed[1]) * zspd, walk: rnd(0, 6), hit: 0, kx: 0, ky: 0, seed: Math.random(),
      lostArms: 0, armOrder: k % 2 ? 1 : -1, headless: false,
      bleed: 0, bleedCd: 0,
      alert: 0, tx: 0, ty: 0, hunt: 0, moan: rnd(0, 3),
      notice: 0, silent: false,                        // Awareness meter and the silent-kill flag.
      throwCd: rnd(1.8, 4.8), throwWind: 0, throwAimX: 0, throwAimY: 0,
      flankSide: k % 2 ? 1 : -1, flankBias: rnd(.78, 1.16), flankTimer: rnd(.6, 2.2), pressure: 0,
      dodgeTime: 0, dodgeDir: k % 2 ? 1 : -1, dodgeCd: rnd(.25, 1.35), recoil: 0,
      surge: 0, surgeCd: rnd(.8, 2.8), guardParcel,
      mvx: 0, mvy: 0,                                  // Last frame's velocity: the patrol leads its shots with it.
      foeCar: null, foeCd: rnd(0, 1.2), foeHitCd: 0,   // A nearby patrol car is an alternative target.
      tankHitCd: 0,                                    // Spacing between vehicle impacts on a tank.
      rival: null, rivalCd: 0,                         // Doom-style feud after being splattered by a neighbour.
      guardX: parcel ? parcel.x : 0, guardY: parcel ? parcel.y : 0, guardRadius: rnd(76, 112)
    });
  };

  // Every parcel has three guards, creating small combat groups rather than isolated
  // targets while preserving a safe distance from the spawn point.
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

  // The remaining population wanders freely. Guards count toward the difficulty cap.
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

  // Tank packs: a few clusters of three or four, scattered far from the spawn and away
  // from the parcels, so the player meets them as a place to avoid rather than a guard post.
  const packs = Math.min(2 + Math.floor(level / 2), 5);
  for (let n = 0; n < packs; n++) {
    let anchor = null;
    for (let t = 0; t < 120 && !anchor; t++) {
      const c = pick(onFoot.length ? onFoot : spots);
      if (Math.hypot(c.x - start.x, c.y - start.y) < 520) continue;
      if (parcels.some(q => Math.hypot(c.x - q.x, c.y - q.y) < 230)) continue;
      if (zombies.some(z => z.kind === 'tank' && Math.hypot(z.x - c.x, z.y - c.y) < 460)) continue;
      anchor = c;
    }
    if (!anchor) continue;
    const size = 3 + ((Math.random() * 2) | 0);
    for (let i = 0; i < size; i++) {
      const near = (onFoot.length ? onFoot : spots).filter(q =>
        Math.hypot(q.x - anchor.x, q.y - anchor.y) < 90 &&
        zombies.every(z => Math.hypot(z.x - q.x, z.y - q.y) > 40));
      addZombie(near.length ? pick(near) : anchor, -1, TANK_TYPE);
    }
  }

  // Madness keeps a reserve on the bench. It is built here, with the rest of the district and
  // from the same seed, so both ends of a co-op session have the identical bodies waiting.
  const liveCount = zombies.length;
  if (madness) for (let i = 0; i < MADNESS_RESERVE; i++) addZombie(pick(onFoot.length ? onFoot : spots));
  const reserve = zombies.splice(liveCount);
  // Somewhere to put them. A thinned list of walkable spots is plenty for choosing an arrival and
  // costs a fraction of keeping every cell the flood fill found.
  const ground = madness ? (onFoot.length ? onFoot : spots).filter((_, i) => i % 3 === 0) : null;

  // Deterministic target for visual checks of blood sprays and stains.
  // Normal gameplay never enables this branch.
  if (qaMode === 'zombie-blood' && zombies.length) {
    const z = zombies.find(o => o.kind === 'brute') || zombies[0];
    zombies.splice(0, zombies.length, z);
    cars.splice(0, cars.length);
    z.x = start.x; z.y = start.y - 58; z.ang = Math.PI / 2;
    z.hp = z.maxHp = 8; z.spd = 0; z.wander = 999; z.guardParcel = -1;
    z.alert = 0; z.hunt = 0; z.throwCd = 999; z.dodgeCd = 999; z.surgeCd = 999;
  }

  // Ten health points put each dismemberment threshold on an exact test shot.
  if (qaMode === 'zombie-dismember' && zombies.length) {
    const z = zombies.find(o => o.kind === 'walker') || zombies[0];
    zombies.splice(0, zombies.length, z);
    cars.splice(0, cars.length);
    z.x = start.x; z.y = start.y - 68; z.ang = Math.PI / 2;
    z.hp = z.maxHp = 10; z.spd = 0; z.wander = 999; z.guardParcel = -1;
    z.alert = 0; z.hunt = 0; z.throwCd = 999; z.dodgeCd = 999; z.surgeCd = 999;
  }

  // One stationary watcher makes normal movement and C-key crawling directly comparable.
  if (stealthQa && zombies.length) {
    const z = zombies.find(o => o.kind === 'walker') || zombies[0];
    zombies.splice(0, zombies.length, z); cars.splice(0, cars.length);
    houses.splice(0); trees.splice(0); soft.splice(0); props.splice(0); solids.splice(0);
    z.x = start.x; z.y = start.y - 170; z.ang = Math.PI / 2;
    z.spd = 0; z.wdir = Math.PI / 2; z.wander = 999; z.guardParcel = -1; z.alert = z.hunt = z.notice = 0;
    z.throwCd = z.dodgeCd = z.surgeCd = 999;
  }

  // A tank head, one victim, and one stationary car make the fifth-shot blast repeatable.
  if (qaMode === 'zombie-head-explosion' && zombies.length) {
    const source = zombies.find(o => o.kind === 'tank') || zombies[0];
    const victim = zombies.find(o => o !== source && o.kind === 'brute') || zombies.find(o => o !== source);
    zombies.splice(0, zombies.length, source, ...(victim ? [victim] : []));
    source.x = start.x; source.y = start.y - 82; source.ang = Math.PI / 2;
    source.spd = 0; source.wander = 999; source.guardParcel = -1; source.alert = source.hunt = 0;
    if (victim) {
      victim.x = start.x + 94; victim.y = start.y - 82; victim.ang = Math.PI;
      victim.hp = victim.maxHp = 10; victim.spd = 0; victim.wander = 999; victim.guardParcel = -1;
      victim.alert = victim.hunt = 0; victim.throwCd = victim.dodgeCd = victim.surgeCd = 999;
    }
    if (cars.length) {
      const car = cars[0]; cars.splice(1);
      car.x = start.x - 55; car.y = start.y - 82; car.hx = 1; car.hy = 0;
      car.v = 0; car.max = 0; car.baseMax = 0; car.stall = 99; car.hold = true;
      setOBB(car.box, car.x, car.y, 0, CAR_L / 2, CAR_W / 2); syncCarBody(car);
    }
  }

  // A clean lighting laboratory keeps three color temperatures and three foliage
  // silhouettes in the same viewport for HIGH/LOW visual comparison.
  if (qaMode === 'foliage-lighting') {
    const cx = clamp(start.x, 220, WORLD - 220), cy = clamp(start.y - 110, 190, WORLD - 230);
    start = { x: cx, y: cy + 90 };
    houses.splice(0); trees.splice(0); soft.splice(0); props.splice(0); solids.splice(0);
    cars.splice(0); zombies.splice(0);
    const tree = { x: cx - 145, y: cy + 48, r: 22, seed: .17, foliage: 'tree' };
    const bush = { x: cx, y: cy + 48, r: 24, seed: .53, foliage: 'bush' };
    const hedge = obb(cx + 145, cy + 48, 0, 43, 9, { t: 'hedge', seed: .81 });
    trees.push(tree); soft.push(bush); props.push(hedge); solids.push(hedge);
    // The comparison lab keeps its lamps armless so each colour sits exactly above its subject.
    for (let i = 0; i < 3; i++)
      props.push(makeLamp(cx + (i - 1) * 145, cy, 0, 1, LAMP_TEMPERATURES[i * 2], 0));
  }

  // A single tall house in a clear flashlight beam verifies that roofs receive
  // ambient sky light but never ground-level illumination.
  if (qaMode === 'roof-lighting') {
    const cx = clamp(start.x, 180, WORLD - 180), cy = clamp(start.y - 145, 150, WORLD - 240);
    start = { x: cx, y: cy + 155 };
    houses.splice(0); trees.splice(0); soft.splice(0); props.splice(0); solids.splice(0);
    cars.splice(0); zombies.splice(0);
    const house = obb(cx, cy, 0, 66, 52,
      { wall: WALLS[0], roof: ROOFS[1], seed: .42, face: 1 });
    houses.push(house); solids.push(house);
  }

  // ---------- ammo and battery boxes ----------
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

  const weather = newWeather();
  const fog = new Float32Array(FW * FW), seen = new Uint8Array(FW * FW);
  if (qaMode === 'foliage-lighting' || qaMode === 'roof-lighting' || stealthQa) {
    Object.assign(weather, { rain: 0, target: 0, wet: 0, next: 999, strike: 999 });
    fog.fill(1); seen.fill(1);
  }

  // Building the roster before the literal keeps every courier made in one place. It draws no
  // randomness, so the static layer below still meets the stream exactly where it always did.
  const torchOn = qaMode !== 'foliage-lighting' && !stealthQa;
  const coopLocal = qaMode === 'coop-local';
  // A shift is however many couriers were agreed before the district was built. Both ends of a
  // co-op session build the same roster, because the roster is part of what they are proving
  // matched — a district with one courier in it is not the same district as one with two.
  const shift = Math.max(1, coopLocal ? 2 : couriers);
  const players = [];
  for (let i = 0; i < shift; i++)
    players.push(makeCourier({ x: start.x + i * 34, y: start.y }, i, torchOn));

  return {
    level, solids, trees, soft, houses, props, parcels, cars, need, zombies, ammoBoxes,
    roads: R, lamps: props.filter(p => p.t === 'lamp'), parked: props.filter(p => p.t === 'parked'), roadDist,
    stat: renderStatic({ houses, trees, soft, props, roads: R, roadDist }),
    players, p: players[0], coopLocal,              // The local courier; the rest of the shift is alongside.
    madness, reserve, ground,                       // The bench, and the places it can walk on from.
    spawnClock: madness ? MADNESS_FIRST : 0, spawned: 0,
    bullets: [], zombieShots: [], splats: [], stains: [], bloodDrops: [], zombieParts: [], blasts: [], rings: [], splash: [], carSmoke: [],
    cash: [],                                                       // Notes dropped by the horde, not yet picked up.
    weather, killed: 0, earned: 0, filthThrown: 0, filthHits: 0, dodges: 0, surges: 0,
    headKicks: 0,
    carsBroken: carDamageQa ? 1 : 0, roadKills: 0, takedowns: 0,
    fog, seen,                                                    // Fog of war.
    fogActive: [], fogActiveMark: new Uint8Array(FW * FW),
    delivered: 0,                                   // Signed off. What is on a back belongs to the courier.
    events: [],                                     // Loud moments of this frame, for a peer that only watches.
    nextPartId: 1,                                  // Severed limbs are born mid-district and need naming.
    dead: false,                                    // The run is over: every courier is down.
    time: 0, spawnGrace: stealthQa ? 0 : 5, done: false, shake: 0, parts: [], cam: { x: 0, y: 0 },
    bloodQa: qaMode === 'zombie-blood', bloodQaDone: false,
    dismemberQa: qaMode === 'zombie-dismember', dismemberQaStep: 0, headKickQaDone: false,
    headExplosionQa: qaMode === 'zombie-head-explosion', headExplosionQaStep: 0,
    stealthQaInput: qaMode === 'stealth-walk' ? 'walk' : qaMode === 'stealth-crawl' ? 'crawl' : ''
  };
}

// ---------- static town layer ----------
function renderStatic(g) {
  const s = document.createElement('canvas');
  s.width = s.height = WORLD;
  const c = s.getContext('2d');

  // Grass across the entire world.
  c.fillStyle = '#78b859'; c.fillRect(0, 0, WORLD, WORLD);
  for (let i = 0; i < per(9000); i++) {
    c.fillStyle = Math.random() < .5 ? 'rgba(102,166,72,.6)' : 'rgba(150,210,114,.55)';
    c.fillRect(Math.random() * WORLD, Math.random() * WORLD, 3 + Math.random() * 5, 2);
  }
  for (let i = 0; i < 620; i++) {                    // Flowers.
    c.fillStyle = pick(['#f6e05e', '#f6a5c0', '#ffffff', '#c3a2f0']);
    c.beginPath(); c.arc(Math.random() * WORLD, Math.random() * WORLD, 2, 0, 6.283); c.fill();
  }

  // ---------- roads as wide strokes along curves ----------
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
  stroke(ROAD + 42, '#cfc9ba');                      // Sidewalk.
  stroke(ROAD + 10, '#b3ac9c');                      // Curb.
  stroke(ROAD, '#4d525b');                           // Asphalt.
  for (let i = 0; i < per(9000); i++) {                   // Asphalt texture noise.
    const x = Math.random() * WORLD, y = Math.random() * WORLD;
    if (g.roadDist(x, y) > ROAD / 2 - 7) continue;
    c.fillStyle = Math.random() < .5 ? 'rgba(255,255,255,.035)' : 'rgba(0,0,0,.07)';
    c.fillRect(x, y, 3, 3);
  }
  stroke(3, 'rgba(240,225,150,.75)', [22, 20]);      // Centerline.

  // Crosswalks near intersections.
  for (const p of layoutCrosswalks(g.roads)) {
    c.save(); c.translate(p.x, p.y); c.rotate(Math.atan2(p.ty, p.tx));
    c.fillStyle = 'rgba(235,235,228,.8)';
    for (let k = -3; k <= 3; k++) c.fillRect(-6, k * 11 - 3, 12, 6);
    c.restore();
  }

  // Driveways and hedges.
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

  // Bushes.
  for (const b of g.soft) {
    c.fillStyle = 'rgba(0,0,0,.15)';
    c.beginPath(); c.ellipse(b.x + 3, b.y + 6, b.r, b.r * .6, 0, 0, 6.283); c.fill();
    for (let k = 0; k < 4; k++) {
      const a = b.seed * 6.283 + k * 1.57;
      c.fillStyle = ['#67b25c', '#74c268', '#5aa551', '#7ecd70'][k];
      c.beginPath(); c.arc(b.x + Math.cos(a) * b.r * .38, b.y + Math.sin(a) * b.r * .32, b.r * .62, 0, 6.283); c.fill();
    }
  }

  // Houses.
  for (const h of g.houses) drawHouse(c, h);

  // Parked cars.
  for (const p of g.props) if (p.t === 'parked') {
    c.save(); c.translate(p.cx, p.cy); c.rotate(p.ang);
    drawCarShape(c, p);
    c.restore();
  }

  // Trees above everything except dynamic objects.
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

  // Benches. Lamps are drawn with the frame instead: a lamp can be shot out, and the
  // static layer is painted once when the district is built.
  for (const p of g.props) {
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

// A street lamp from above: the mast on the kerb, the bracket reaching out over the asphalt,
// and the lantern at its end. The ground shadow falls the same way for every lamp no matter
// which way its bracket points, which is what makes the arm read as hanging above the street.
function drawLamp(c, l, glow = 1) {
  c.fillStyle = 'rgba(0,0,0,.22)';
  c.beginPath(); c.ellipse(l.x + 5, l.y + 7, 6, 4, 0, 0, 6.283); c.fill();
  if (l.arm) {
    c.strokeStyle = 'rgba(0,0,0,.18)'; c.lineWidth = 4; c.lineCap = 'round';
    c.beginPath(); c.moveTo(l.x + 5, l.y + 7); c.lineTo(l.hx + 5, l.hy + 7); c.stroke();
    c.lineCap = 'butt';
    c.beginPath(); c.ellipse(l.hx + 5, l.hy + 7, 7, 4.5, 0, 0, 6.283); c.fill();
  }
  c.save();
  c.translate(l.x, l.y); c.rotate(l.ang);
  c.fillStyle = '#39414d'; c.beginPath(); c.arc(0, 0, 5.2, 0, 6.283); c.fill();   // Mast.
  c.fillStyle = '#5b6675'; c.beginPath(); c.arc(0, 0, 3.4, 0, 6.283); c.fill();
  c.fillStyle = '#2a313b'; c.beginPath(); c.arc(0, 0, 1.6, 0, 6.283); c.fill();
  if (l.arm) {
    c.fillStyle = '#4a5462'; roundRect(c, 1, -2.1, l.arm - 1, 4.2, 2.1); c.fill();
    c.fillStyle = 'rgba(255,255,255,.16)'; c.fillRect(2, -1.9, l.arm - 3, 1.3);
  }
  const head = l.arm;
  c.fillStyle = l.broken ? '#333b45' : '#414b58';
  roundRect(c, head - 8, -4.6, 15, 9.2, 3.4); c.fill();
  c.strokeStyle = 'rgba(10,12,16,.6)'; c.lineWidth = 1; c.stroke();
  if (!l.broken) {
    // A lit lens, not a light. Drawn at full strength the head was the brightest thing in the
    // district — brighter than the patch it was supposed to be casting — which read as the lamp
    // glowing at the camera rather than at the road.
    c.globalAlpha = (.22 + glow * .34) * (l.arm ? 1 : .8);
    c.fillStyle = l.bulb || '#ffe9a8';
    c.beginPath(); c.ellipse(head - .6, 0, 4.2, 2.4, 0, 0, 6.283); c.fill();
    c.globalAlpha = (.12 + glow * .16);
    c.fillStyle = '#fff';
    c.beginPath(); c.ellipse(head - 1.4, -.5, 1.6, .9, 0, 0, 6.283); c.fill();
    c.globalAlpha = 1;
  } else {
    c.fillStyle = '#14181e';                       // An empty socket where the glass was.
    c.beginPath(); c.ellipse(head - .6, 0, 5, 3, 0, 0, 6.283); c.fill();
    c.strokeStyle = 'rgba(198,214,228,.45)'; c.lineWidth = .8;
    for (let k = 0; k < 3; k++) {                  // The last shards still in the frame.
      const a = l.seed * 6.283 + k * 2.1;
      c.beginPath(); c.moveTo(head - .6, 0);
      c.lineTo(head - .6 + Math.cos(a) * 4.4, Math.sin(a) * 2.6); c.stroke();
    }
  }
  c.restore();
}

function drawHouse(c, h) {
  const hw = h.hw, hh = h.hh, w = hw * 2, hg = hh * 2;
  c.save(); c.translate(h.cx + 7, h.cy + 11); c.rotate(h.ang);      // Shadow falls down and right.
  c.fillStyle = 'rgba(0,0,0,.25)'; roundRect(c, -hw, -hh, w, hg, 4); c.fill();
  c.restore();

  c.save(); c.translate(h.cx, h.cy); c.rotate(h.ang);
  // Walls.
  c.fillStyle = h.wall; roundRect(c, -hw, -hh, w, hg, 3); c.fill();
  c.strokeStyle = 'rgba(0,0,0,.28)'; c.lineWidth = 2; c.stroke();
  // Roof planes rise from the edges to the ridge.
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
  // Ridge.
  c.strokeStyle = 'rgba(255,255,255,.28)'; c.lineWidth = 3;
  c.beginPath();
  if (rw > rh) { c.moveTo(rx, ry + rh / 2); c.lineTo(rx + rw, ry + rh / 2); }
  else { c.moveTo(rx + rw / 2, ry); c.lineTo(rx + rw / 2, ry + rh); }
  c.stroke();
  // Chimney.
  c.fillStyle = '#8b6b57'; c.fillRect(-hw + w * (.22 + h.seed * .5), -hh + hg * .18, 13, 13);
  c.fillStyle = 'rgba(0,0,0,.3)'; c.fillRect(-hw + w * (.22 + h.seed * .5), -hh + hg * .18, 13, 4);
  // Porch and door on the street-facing side.
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
  // The car faces right. Every point below passes through the physical body mesh.
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

  // Shadow and four independent tires; suspension damage tilts the wheels.
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

  // The outer outline uses physical boundary nodes with no separate artistic deformation.
  c.beginPath(); outline.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.closePath();
  c.fillStyle = car.col || '#9a4f47'; c.fill();
  c.strokeStyle = 'rgba(8,10,13,.78)'; c.lineWidth = 1.45; c.stroke();
  if (car.hitFlash > 0) {
    c.fillStyle = `rgba(255,235,175,${clamp(car.hitFlash * 3.5, 0, .55)})`;
    c.beginPath(); outline.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.closePath(); c.fill();
  }

  // Compressed cells create permanent dark planes on the metal itself. This is not
  // a damage mask: the quadrilaterals are the physical cells, and intensity follows
  // area loss and node displacement.
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

  // Bumpers, hood, trunk, and door seams keep an undamaged car readable.
  c.strokeStyle = 'rgba(20,22,25,.5)'; c.lineWidth = .8;
  line([[13,-10],[13,10]]); line([[-15,-10],[-15,10]]); line([[-1,-9],[-1,9]]);
  c.fillStyle = 'rgba(255,255,255,.18)';
  polygon([[-19,-10],[19,-10],[15,-8],[-18,-8]]); c.fill();

  // Creases appear where mesh constraints actually stretch or compress.
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

  // Front and rear glass plus separate side windows.
  c.fillStyle = glassFill(d.glass.front); polygon([[6,-7.6],[10,-6.7],[10,6.7],[6,7.6]]); c.fill();
  drawCracks(8, 0, d.glass.front, 3.5, 6.5);
  c.fillStyle = glassFill(d.glass.rear); polygon([[-10,-6.9],[-6.5,-7.8],[-6.5,7.8],[-10,6.9]]); c.fill();
  drawCracks(-8.2, 0, d.glass.rear, 3, 5.8);

  c.fillStyle = glassFill(d.glass.left); polygon([[-5.5,-9],[5,-9],[6.6,-7.6],[-6.3,-7.6]]); c.fill();
  drawCracks(0, -8.2, d.glass.left, 5.5, 2.2);
  c.fillStyle = glassFill(d.glass.right); polygon([[-6.3,7.6],[6.6,7.6],[5,9],[-5.5,9]]); c.fill();
  drawCracks(0, 8.2, d.glass.right, 5.5, 2.2);
  c.strokeStyle = 'rgba(205,225,238,.32)'; c.lineWidth = .65; line([[-4.8,-8.7],[3.7,-8.7]]); line([[-4.8,8.7],[3.7,8.7]]);

  // Mirrors protrude from the body and disappear after a side impact.
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
  // Reversing lights: white while the car backs out, so the manoeuvre is readable.
  const reverseOn = car.rev > 0 && !car.broken;
  lamp(-22, -7, d.lights.rearLeft, reverseOn ? '#f2f6ff' : '#d94b42', hazardOn);
  lamp(-22, 7, d.lights.rearRight, reverseOn ? '#f2f6ff' : '#d94b42', hazardOn);

  if (car.broken) {                                             // Jammed hood and scorched grille.
    c.fillStyle = 'rgba(23,24,25,.55)'; polygon([[12,-9],[22,-7],[19,8],[11,9]]); c.fill();
    c.strokeStyle = '#0f1112'; c.lineWidth = 1.2;
    line([[14,-5],[20,0],[13,5]]);
  }

  // A hull the fire has already been through. It keeps its shape, because it is still cover and
  // still something traffic has to go around, and loses its paint to say it has nothing left.
  if (car.exploded) {
    c.fillStyle = 'rgba(16,15,14,.72)';
    c.beginPath(); outline.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y));
    c.closePath(); c.fill();
    c.strokeStyle = 'rgba(58,50,44,.85)'; c.lineWidth = 1.4;
    line([[-16,-6],[-4,2],[6,-4],[17,3]]);                      // Buckled roof skin.
  }

  // Bullet marks are stored in local coordinates of the physical body, so they
  // continue following a panel when a later impact crumples it.
  for (const dent of car.bulletDents || []) {
    const p = M(dent.x, dent.y), a = dent.seed * 6.283;
    c.fillStyle = '#111417'; c.beginPath(); c.arc(p.x, p.y, 1.25, 0, 6.283); c.fill();
    c.strokeStyle = 'rgba(205,215,220,.72)'; c.lineWidth = .55;
    c.beginPath(); c.arc(p.x, p.y, 2.1, a, a + 4.7); c.stroke();
  }

  if (car.police) {                                             // Livery and roof beacon.
    c.strokeStyle = '#1f3f7a'; c.lineWidth = 2;
    line([[-19,-8.8],[18,-8.8]]); line([[-19,8.8],[18,8.8]]);
    const rp = .5 + .5 * Math.sin((car.beacon || 0) * 3.1), bp = 1 - rp;
    const beacon = M(0, 0);
    c.fillStyle = '#20242c'; roundRect(c, beacon.x - 3.8, beacon.y - 3, 7.6, 6, 1.5); c.fill();
    c.fillStyle = `rgba(255,70,70,${.25 + .75 * rp})`; c.fillRect(beacon.x - 3.2, beacon.y - 2.4, 3.2, 4.8);
    c.fillStyle = `rgba(90,140,255,${.25 + .75 * bp})`; c.fillRect(beacon.x, beacon.y - 2.4, 3.2, 4.8);
  }

  // The madness gun sits behind the beacon on a mount that turns, so it is drawn in its own frame
  // rather than through the body mesh: a crumpled roof should dent around the pedestal, not bend
  // the barrel. Only the pedestal is placed by the mesh; everything above it belongs to the gun.
  if (car.roofGun) {
    const base = M(-7, 0);
    c.save();
    c.translate(base.x, base.y);
    c.rotate((car.copAim || 0) - Math.atan2(car.hy, car.hx));
    c.fillStyle = '#20242c';
    c.beginPath(); c.arc(0, 0, 4.8, 0, 6.283); c.fill();
    c.fillStyle = '#2b3138';
    roundRect(c, -5.5, -3.6, 10, 7.2, 1.4); c.fill();          // Receiver and belt box.
    c.fillStyle = '#171a1f';
    c.fillRect(3.5, -1.4, 12.5, 2.8);                          // Barrel,
    c.fillRect(14.5, -2.3, 3.6, 4.6);                          // and the brake on the end of it.
    c.fillStyle = 'rgba(120,132,146,.85)';
    roundRect(c, -1.6, -5.6, 3.2, 11.2, 1); c.fill();          // Shield plate.
    c.restore();
  }

  if (car.honk > 0 && !car.broken) {
    const front = M(23, 0);
    c.strokeStyle = `rgba(255,240,140,${car.honk})`; c.lineWidth = 2;
    for (let k = 1; k <= 2; k++) { c.beginPath(); c.arc(front.x + 4, front.y, 6 + k * 6, -.7, .7); c.stroke(); }
  }
}

return Object.freeze({
  buildTown, makeCourier, resetZombie, layoutChecksum, lampGlow, drawHouse, drawCarShape, drawLamp,
  sidewalkPoint, layoutCrosswalks
});
})();

