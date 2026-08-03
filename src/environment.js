// Weather, visibility, roads, and traffic behavior.
window.TownGame.environment = (() => {
'use strict';

const {
  ctx, W, H, clamp, rnd, pick, obb, setOBB, torchHand
} = window.TownGame.core;
const {
  WORLD, ROAD, GN, GS, MRG, LANE, CAR_L, CAR_W,
  SHAKE_MAX, FCELL, REMEMBER, RAIN_Z, ROOF_SIGHT,
  CAR_SIGHT, CAR_SIGHT_SPREAD, CAR_SIGHT_NEAR, CAR_SIGHT_DARK,
  WHEELBASE, MAX_LOCK, STEER_RATE, GRIP, SLIP_KEEP, SLIP_YAW, SLIP_MAX, SPIN_MAX, SLIP_LOST,
  CAR_EDGE, TURN_IN, WRECK_FUSE, MADNESS_DRIVER_DURABILITY, CLAW_IMPACT
} = window.TownGame.config;
const SND = window.TownGame.audio;
const quality = window.TownGame.quality;
const { createCarBody, syncCarBody, deformCarBody, circleCarContact, worldToLocal } = window.TownGame.carPhysics;
const legacyPerf = typeof URLSearchParams !== 'undefined' && typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('qa') === 'perf-legacy';

// ---------- events: the loud and visible moments, written down ----------
//
// Whoever runs the rules makes its own sparks and plays its own sounds, because that is where
// the information is: a trigger was pulled, a lamp lost its glass, a head went off. A peer that
// is only watching has none of that — a shot reaches it as two positions in a snapshot with no
// memory of anybody firing. So each of those moments is also noted here, and a watching peer
// replays the noise and the debris from the note instead of from a rule it never ran.
const EV = Object.freeze({
  shot: 0, hurt: 1, lamp: 2, blast: 3, ring: 4, down: 5, revive: 6, deliver: 7, copshot: 8
});
function emit(g, code, ...args) {
  if (g.events) g.events.push([code, ...args]);
}

// Screen shake belongs to a screen rather than to a district: an explosion two blocks away is
// somebody else's problem. Each peer works out how much of an event it actually felt from where
// its own courier is standing, so the event travels and the feeling does not.
//
// The ceiling is applied here because this is the only place shake is ever raised, so nothing
// added later can forget it. `SHAKE_MAX` and the measurement behind it live in `config.js`.
function shakeAt(g, x, y, power, falloff = 540) {
  const felt = x === null ? 1 : clamp(1 - Math.hypot(g.p.x - x, g.p.y - y) / falloff, 0, 1);
  g.shake = Math.min(SHAKE_MAX, Math.max(g.shake, power * felt));
}

// Noise tells zombies where an event happened. Rain muffles every source.
function makeNoise(g, x, y, r, strength, ring, skip) {
  r *= 1 - .3 * g.weather.rain;
  const r2 = r * r;
  for (const z of g.zombies) {
    const dx = z.x - x, dy = z.y - y;
    if (z === skip || z.gone || dx * dx + dy * dy > r2) continue;
    z.tx = x; z.ty = y; z.alert = Math.max(z.alert, strength);
  }
  if (ring) { g.rings.push({ x, y, r: 10, max: r, l: .55 }); emit(g, EV.ring, x, y, r); }
}

// The courier nearest a point. Traffic, thunder and crash shake all used to mean the only
// courier there was; with a shift of two they mean whichever of them the event is actually
// happening to.
function nearestPlayer(g, x, y) {
  let best = g.players[0], bd = Infinity;
  for (const p of g.players) {
    const dx = p.x - x, dy = p.y - y, d2 = dx * dx + dy * dy;
    if (d2 < bd) { bd = d2; best = p; }
  }
  return best;
}

// Pavement factor at a point: 1 at the road center, 0 on grass.
const surfaceAt = (g, x, y) => clamp((ROAD / 2 + 8 - g.roadDist(x, y)) / 22, 0, 1);

// ---------- fog of war: cells the courier has already seen ----------
const FW = Math.ceil(WORLD / FCELL);
const fogCv = document.createElement('canvas');
fogCv.width = fogCv.height = FW;
const fctx = fogCv.getContext('2d');
const fogImg = fctx.createImageData(FW, FW);
// The colour of the unexplored layer never changes, so only alpha is ever rewritten.
for (let j = 0; j < fogImg.data.length; j += 4) {
  fogImg.data[j] = 3; fogImg.data[j + 1] = 5; fogImg.data[j + 2] = 13; fogImg.data[j + 3] = 255;
}

function updateFog(g, dt) {
  const fade = Math.min(1, dt * 6), rise = Math.min(1, dt * 9);

  // Cells the player has never seen are already zero. Iterate only the explored
  // part of the map instead of scanning the entire grid every frame.
  const active = g.fogActive, activeMark = g.fogActiveMark;
  const fadeList = legacyPerf ? g.fog : active;
  for (let n = 0; n < fadeList.length; n++) {      // Areas leaving sight fade to memory brightness.
    const i = legacyPerf ? n : fadeList[n];
    const tgt = g.seen[i] ? REMEMBER : 0;
    if (g.fog[i] > tgt) g.fog[i] += (tgt - g.fog[i]) * fade;
  }
  // The map is one map, and a shift shares what it has walked: a street lit by a partner two
  // blocks away is a street this courier no longer has to open up themselves. The fade runs
  // once over the whole explored set, and each courier then writes back what they can see.
  for (const p of g.players) revealAround(g, p, rise);
}

function revealAround(g, p, rise) {
  const w = g.weather;
  // Where the light comes from, how far it throws, how wide, and how much can be seen without
  // looking at all. On foot that is a hand torch swung with the aim; at a wheel it is two sealed
  // lamps bolted to the front of the body, pointed wherever the car is pointed.
  let o, reach, near, halfAngle, aim;
  if (p.car) {
    const c = p.car;
    const lamps = c.damage ? c.damage.lights : null;
    // Whichever lamp still works carries the beam. The pair is not added together, because both
    // light the same piece of road; what a second one buys is not going dark when the first goes.
    const lamp = lamps ? Math.max(lamps.frontLeft, lamps.frontRight) : 1;
    const working = lamp > .22 && !c.broken;
    // The rigid nose rather than the deformed mesh: this is where the driver is looking from, and
    // it should not swim about because the wing took a knock.
    o = { x: c.x + c.hx * (CAR_L / 2), y: c.y + c.hy * (CAR_L / 2) };
    reach = working ? CAR_SIGHT * (.6 + .4 * lamp) - 40 * w.rain : CAR_SIGHT_DARK;
    near = working ? CAR_SIGHT_NEAR : CAR_SIGHT_DARK;
    halfAngle = CAR_SIGHT_SPREAD;
    aim = Math.atan2(c.hy, c.hx);
  } else {
    const lit = p.torch && p.batt > 0;
    o = torchHand(p);                              // Vision starts at the hand, not the body center.
    reach = lit ? 250 - 40 * w.rain : 74;
    near = lit ? 96 : 74;
    halfAngle = .6;
    aim = p.aim;
  }
  // Rain shortens the beam, while lightning briefly reveals the whole block.
  // A roof is the only place in the district you can see out of, and that is half of why anybody
  // climbs one: the fog opens a long way further than it ever does at street level.
  const high = p.roof ? ROOF_SIGHT : 1;
  const R = reach * (1 + w.flash * 2.6) * high, R2 = R * R;
  const PER2 = (near * (1 + w.flash * 6) * high) ** 2;
  const ca = Math.cos(aim), sa = Math.sin(aim), LIM = Math.cos(halfAngle);
  const active = g.fogActive, activeMark = g.fogActiveMark;
  const gx0 = Math.max(0, ((o.x - R) / FCELL) | 0), gx1 = Math.min(FW - 1, ((o.x + R) / FCELL) | 0);
  const gy0 = Math.max(0, ((o.y - R) / FCELL) | 0), gy1 = Math.min(FW - 1, ((o.y + R) / FCELL) | 0);
  for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
    const dx = gx * FCELL + FCELL / 2 - o.x, dy = gy * FCELL + FCELL / 2 - o.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > R2) continue;
    // Nearby surroundings and the flashlight cone are visible.
    if (d2 > PER2 && dx * ca + dy * sa < Math.sqrt(d2) * LIM) continue;
    const i = gy * FW + gx;
    if (!activeMark[i]) { activeMark[i] = 1; active.push(i); }
    g.seen[i] = 1;
    g.fog[i] += (1 - g.fog[i]) * rise;
  }
}

function drawFog(g, camx, camy) {
  g.fogRenderFrame = (g.fogRenderFrame || 0) + 1;
  if (!g.fogRendered || g.fogRenderFrame >= quality.current.fogEvery) {
    const d = fogImg.data;
    if (g.fogImageOwner !== g) {                   // A district arrives with its own starting map.
      for (let i = 0, j = 3; i < g.fog.length; i++, j += 4) d[j] = (1 - g.fog[i]) * 255;
      g.fogImageOwner = g;
    } else {
      // Only cells the courier has already touched ever change brightness; the rest of the
      // map keeps the value written above, so the whole grid does not have to be rewritten.
      const active = g.fogActive;
      for (let n = 0; n < active.length; n++) {
        const i = active[n];
        d[i * 4 + 3] = (1 - g.fog[i]) * 255;
      }
    }
    fctx.putImageData(fogImg, 0, 0);
    g.fogRenderFrame = 0;
    g.fogRendered = true;
  }
  ctx.save();
  ctx.imageSmoothingEnabled = true;               // Smooth boundary instead of visible cells.
  ctx.drawImage(fogCv, camx / FCELL, camy / FCELL, W / FCELL, H / FCELL, 0, 0, W, H);
  ctx.restore();
}
const fogAt = (g, x, y) =>
  g.fog[clamp((y / FCELL) | 0, 0, FW - 1) * FW + clamp((x / FCELL) | 0, 0, FW - 1)];

// ---------- weather: rain comes and goes; thunder distracts zombies ----------
const drops = [];
for (let i = 0; i < 480; i++)
  drops.push({ x: Math.random() * (W + 260) - 130, y: Math.random() * H, z: RAIN_Z[i % 3] });

const newWeather = () => {
  const r = Math.random() < .45 ? rnd(.3, .85) : 0;
  return { rain: r, target: r, next: rnd(10, 26), wind: rnd(-.5, .5), wet: r,
           flash: 0, reflash: 0, strike: rnd(4, 14), boom: 0, boomX: 0, boomY: 0, acc: 0 };
};

function updateWeather(g, dt) {
  const w = g.weather;
  w.next -= dt;
  if (w.next <= 0) {                              // Rain periodically arrives and fades.
    w.next = rnd(16, 42);
    w.target = Math.random() < .42 ? 0 : rnd(.35, 1);
    w.wind = rnd(-.5, .5);
  }
  w.rain += clamp(w.target - w.rain, -.12 * dt, .12 * dt);
  // Asphalt gets wet quickly and takes about a minute to dry.
  w.wet += w.rain > w.wet ? Math.min(w.rain - w.wet, .3 * dt) : Math.max(w.rain - w.wet, -.05 * dt);

  // Lightning flashes immediately; delayed thunder is the useful distraction.
  w.flash = Math.max(0, w.flash - dt * 3.2);
  if (w.reflash > 0 && (w.reflash -= dt) <= 0) w.flash = Math.max(w.flash, .8);
  if (w.rain > .55) {
    w.strike -= dt;
    if (w.strike <= 0) {
      w.strike = rnd(7, 22);
      w.flash = 1; w.reflash = .11;
      const a = rnd(0, 6.283), d = rnd(300, 700);
      // Which courier it lands near is taken from the angle already drawn rather than from a
      // new one, so adding a second courier does not lengthen the random stream.
      const under = g.players[((a / 6.284) * g.players.length) | 0] || g.players[0];
      w.boomX = clamp(under.x + Math.cos(a) * d, 40, WORLD - 40);
      w.boomY = clamp(under.y + Math.sin(a) * d, 40, WORLD - 40);
      w.boom = rnd(.4, 2.2);
    }
  }
  if (w.boom > 0 && (w.boom -= dt) <= 0) {
    w.boom = 0;
    SND.play('thunder');
    g.shake = Math.max(g.shake, .5);
    makeNoise(g, w.boomX, w.boomY, 1300, 6, true);   // The whole district follows the thunder.
  }

  updateWeatherVisuals(g, dt);
}

// The half of the weather that is only ever seen and heard. The drop field is in screen space
// and the splashes are placed against this camera, so they belong to whoever is watching rather
// than to the district — a peer that is not simulating still has rain on its own glass.
function updateWeatherVisuals(g, dt) {
  const w = g.weather;
  SND.rain(w.rain);
  const density = quality.current.rainDensity;
  const n = (drops.length * w.rain * density) | 0;
  for (let i = 0; i < n; i++) {
    const d = drops[i];
    d.y += (760 + d.z * 900) * dt;
    d.x += w.wind * (380 + d.z * 420) * dt;
    if (d.y > H + 20) { d.y = -20; d.x = Math.random() * (W + 260) - 130; }
    if (d.x < -140) d.x += W + 260; else if (d.x > W + 130) d.x -= W + 260;
  }
  w.acc += w.rain * 52 * density * dt;
  while (w.acc >= 1) {
    w.acc--;
    g.splash.push({ x: g.cam.x + rnd(-30, W + 30), y: g.cam.y + rnd(-30, H + 30), l: .3, r: rnd(1.5, 3) });
  }
  for (let i = g.splash.length - 1; i >= 0; i--) if ((g.splash[i].l -= dt) <= 0) g.splash.splice(i, 1);
}

function drawRain(g) {
  const w = g.weather;
  if (w.rain < .02) return;
  const n = (drops.length * w.rain * quality.current.rainDensity) | 0;
  ctx.save();
  ctx.lineCap = 'round';
  for (let layer = 0; layer < 3; layer++) {
    ctx.beginPath();
    for (let i = layer; i < n; i += 3) {
      const d = drops[i], len = 9 + d.z * 17;
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x + w.wind * len * 1.7, d.y + len);
    }
    ctx.strokeStyle = `rgba(190,215,255,${(.08 + layer * .055) * (.55 + w.rain * .45)})`;
    ctx.lineWidth = .7 + layer * .55;
    ctx.stroke();
  }
  ctx.restore();
}

// Lamps and headlights remain visible through fog without revealing the town.
function drawGlowThroughFog(g, camx, camy) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const l of g.lit) {
    if (l.r < 60) continue;                       // Tiny glints cannot be seen from that far away.
    const a = (1 - fogAt(g, l.x, l.y)) * l.int * .12;
    if (a < .012) continue;
    const x = l.x - camx, y = l.y - camy, r = l.r * .8;
    if (x < -r || y < -r || x > W + r || y > H + r) continue;
    const col = `${Math.round(l.rgb[0] * 255)},${Math.round(l.rgb[1] * 255)},${Math.round(l.rgb[2] * 255)}`;
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${col},${a})`);
    gr.addColorStop(.5, `rgba(${col},${a * .45})`);
    gr.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
  }
  ctx.restore();
}

// ---------- road graph: scattered nodes and curved edges ----------
function makeRoads() {
  const nodes = [], at = (i, j) => j * GN + i;
  for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++)
    nodes.push({ i: nodes.length, x: MRG + i * GS + rnd(-95, 95), y: MRG + j * GS + rnd(-95, 95), e: [] });

  const cand = [], diag = [];
  for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) {
    if (i < GN - 1) cand.push([at(i, j), at(i + 1, j)]);
    if (j < GN - 1) cand.push([at(i, j), at(i, j + 1)]);
    if (i < GN - 1 && j < GN - 1) diag.push([at(i, j), at(i + 1, j + 1)]);
    if (i > 0 && j < GN - 1) diag.push([at(i, j), at(i - 1, j + 1)]);
  }
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } };
  shuffle(cand); shuffle(diag);

  // Represent a road as a point-sampled curve.
  const curve = (a, b) => {
    const A = nodes[a], B = nodes[b];
    const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy);
    const k = rnd(-.18, .18);                          // Road curvature.
    const cx = (A.x + B.x) / 2 - dy * k, cy = (A.y + B.y) / 2 + dx * k;
    const n = Math.max(6, Math.round(len / 50)), pts = [], cum = [0];
    for (let s = 0; s <= n; s++) {                     // Sample a quadratic curve.
      const t = s / n, u = 1 - t;
      pts.push({ x: u * u * A.x + 2 * u * t * cx + t * t * B.x,
                 y: u * u * A.y + 2 * u * t * cy + t * t * B.y });
      if (s) cum.push(cum[s - 1] + Math.hypot(pts[s].x - pts[s - 1].x, pts[s].y - pts[s - 1].y));
    }
    return { a, b, pts, cum, len: cum[cum.length - 1] };
  };

  // Roads must not converge outside intersections, where traffic cannot yield.
  const MINSEP = ROAD + 12;
  const segDist = (p, q, r) => {
    const dx = q.x - p.x, dy = q.y - p.y, l2 = dx * dx + dy * dy || 1;
    const t = clamp(((r.x - p.x) * dx + (r.y - p.y) * dy) / l2, 0, 1);
    return Math.hypot(r.x - p.x - dx * t, r.y - p.y - dy * t);
  };
  const tooClose = (P, Q) => {
    for (let i = 1; i < P.length; i++) for (let j = 1; j < Q.length; j++)
      if (segDist(P[i - 1], P[i], Q[j - 1]) < MINSEP || segDist(Q[j - 1], Q[j], P[i - 1]) < MINSEP) return true;
    return false;
  };

  // Build a connected orthogonal skeleton first, then add loops and diagonals.
  const par = nodes.map((_, i) => i);
  const find = i => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
  const keep = [];
  for (const [a, b] of cand) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) { par[ra] = rb; keep.push(curve(a, b)); }
    else if (Math.random() < .3) keep.push(curve(a, b));
  }
  for (const [a, b] of diag) {                         // Keep a diagonal only when it crosses nothing.
    if (Math.random() > .4) continue;
    const e = curve(a, b);
    const shares = o => o.a === a || o.a === b || o.b === a || o.b === b;
    if (keep.some(o => !shares(o) && tooClose(e.pts, o.pts))) continue;
    keep.push(e);
  }

  const edges = keep.map((e, id) => {
    nodes[e.a].e.push(id); nodes[e.b].e.push(id);
    return { id, a: e.a, b: e.b, pts: e.pts, cum: e.cum, len: e.len };
  });
  return { nodes, edges };
}

// Point and tangent at distance s from the start of a road.
function onEdge(e, s) {
  s = clamp(s, 0, e.len);
  let i = 1;
  while (i < e.cum.length - 1 && e.cum[i] < s) i++;
  const t = (s - e.cum[i - 1]) / ((e.cum[i] - e.cum[i - 1]) || 1);
  const p = e.pts[i - 1], q = e.pts[i];
  const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1;
  return { x: p.x + dx * t, y: p.y + dy * t, tx: dx / d, ty: dy / d };
}

// Point and heading on the right lane.
function lanePoint(e, s, dir) {
  const p = onEdge(e, s);
  const hx = p.tx * dir, hy = p.ty * dir;
  return { x: p.x - hy * LANE, y: p.y + hx * LANE, hx, hy };
}
// The body's position is now the body's own. It used to be the lane's, with jx/jy carrying a
// decaying crash displacement on top so a shoved car slid back onto its rails; there are no rails
// under it any more, so a shove is simply where the car ended up and stays there.
function setCar(c, x, y, hx, hy) {
  c.x = x; c.y = y;
  c.hx = hx; c.hy = hy;
  setOBB(c.box, c.x, c.y, Math.atan2(hy, hx), CAR_L / 2, CAR_W / 2);
  syncCarBody(c);
}
function placeCar(c) {                            // On a straight segment.
  const l = lanePoint(c.edge, c.s, c.dir);
  setCar(c, l.x, l.y, l.hx, l.hy);
}
// ---------- a car with a steering wheel ----------
//
// What was here before put the car wherever the lane said and turned the sprite toward the lane's
// direction at a fixed rate. Two things fell out of that and both were visible. The body crabbed
// through every intersection, because the position rode the arc while the nose was still catching
// up. And it turned at the same rate standing still as at full speed, which is a turret rather
// than a car.
//
// So the lane stops being where the car is and becomes where the driver is trying to get to. The
// front wheels are pointed at a spot further along it, the body goes where the wheels take it, and
// how fast it comes round follows from how fast it is going: a car that is not moving cannot turn
// at all, which is the whole difference.
//
// The tail is allowed to let go. Cornering needs the tyres to supply v²/R of sideways grip, and
// when the corner asks for more than they have the rear steps out, which rotates the car further
// into the corner, which asks for more still. That runaway is what a slide is. It is bounded by
// damping and by hard ceilings rather than by hoping the numbers stay small.
// The figures the model is written in terms of — wheelbase, lock, grip, the slide ceilings and the
// district border the body is held inside — are in `config.js`, each with what it was measured
// against. What is left here is the model itself.
const TAU = Math.PI * 2;

const shortestTurn = a => {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
};

// Where the front wheels have to point for the car's arc to pass through a given spot. This is
// pure pursuit, and it is the whole of the driver: everything else follows from the geometry.
function steerToward(c, aimX, aimY, dt, wheelDamage = 0) {
  const dx = aimX - c.x, dy = aimY - c.y;
  const dist = Math.max(18, Math.hypot(dx, dy));
  const alpha = shortestTurn(Math.atan2(dy, dx) - Math.atan2(c.hy, c.hx));
  // Reversing: the driver is looking over their shoulder, so the same aim wants the opposite lock.
  const back = c.v < -4;
  const want = clamp(Math.atan2(2 * WHEELBASE * Math.sin(back ? shortestTurn(alpha + Math.PI) : alpha), dist),
                     -MAX_LOCK, MAX_LOCK);
  const rate = STEER_RATE * (1 - .45 * wheelDamage);
  c.steer = (c.steer || 0) + clamp(want - (c.steer || 0), -rate * dt, rate * dt);
  return c.steer;
}

// One step of the body. `grip` is what the tyres are worth here and now — wet asphalt, grass, a
// bent suspension — and it is the only thing standing between a corner and a slide.
function rollCar(c, dt, grip) {
  const yawFromWheels = (c.v / WHEELBASE) * Math.tan(c.steer || 0);

  // What the corner is asking of the tyres, and what they cannot give.
  const need = c.v * yawFromWheels;
  const over = Math.abs(need) - grip;
  if (over > 0) c.slip = clamp((c.slip || 0) + Math.sign(need) * over * dt, -SLIP_MAX, SLIP_MAX);
  c.slip = (c.slip || 0) * Math.pow(SLIP_KEEP, dt);
  if (Math.abs(c.slip) < .5) c.slip = 0;

  // A tail that has stepped out is a lever on the rest of the car. This is the oversteer the
  // slide is made of, and the ceiling is what keeps it from becoming a spinning top.
  c.spin = clamp(yawFromWheels + c.slip * SLIP_YAW, -SPIN_MAX, SPIN_MAX);

  const a = Math.atan2(c.hy, c.hx) + c.spin * dt;
  const hx = Math.cos(a), hy = Math.sin(a);
  // Forward along the nose, sideways along the door. The second term is the entire visible
  // difference between a car on rails and a car with weight.
  const vx = hx * c.v - hy * c.slip;
  const vy = hy * c.v + hx * c.slip;

  let px = c.x + vx * dt, py = c.y + vy * dt;
  const bx = clamp(px, CAR_EDGE, WORLD - CAR_EDGE), by = clamp(py, CAR_EDGE, WORLD - CAR_EDGE);
  if (bx !== px || by !== py) {
    // Only what was heading out of the district is taken away. A car that arrives at the border at
    // an angle keeps sliding along it, and the driver's aim — always a lane, always inside — brings
    // it back; killing the whole velocity would leave it parked against an invisible wall instead.
    const ex = bx - px, ey = by - py, e = Math.hypot(ex, ey) || 1;
    const nx = ex / e, ny = ey / e, into = vx * nx + vy * ny;
    if (into < 0) {
      const ox = vx - nx * into, oy = vy - ny * into;
      c.v = ox * hx + oy * hy;
      c.slip = -ox * hy + oy * hx;
    }
    px = bx; py = by;
  }
  setCar(c, px, py, hx, hy);
  return Math.abs(c.slip);
}

// How far along an edge the car actually is, rather than how far the driver planned to be. Once
// the body can leave the lane the two stop agreeing, and everything downstream — the corridor
// scan, the turn trigger, who gets the intersection — is asking about the body. Searched locally
// because a car moves a few pixels a frame and the answer is always next to the last one.
// Which lane a car that has ended up somewhere unplanned should rejoin, and facing which way.
// The direction is chosen to suit the heading it actually finished with, so gathering up a spin
// does not snap the car through a handbrake turn — if it ends up pointing the wrong way up a road
// it drives off that way and turns round like anybody else.
// This used to ask `anchorToEdge` starting from the middle of each road. That function is a local
// hill-climb — steps of 32, 16, 8, 4 and 2 — so it can travel 62 px from wherever it is started,
// and roads here are around 530 px long. It was therefore comparing roads by how close their
// middle quarter came, and returning an `s` that could be most of a block out.
//
// Measured over 2332 off-road points in one district: the wrong road entirely 11% of the time, `s`
// wrong by 63 px on average and up to 279, and the rejoin point on average 34 px further away than
// the road the car was actually standing beside. A car that had just gathered up a slide was being
// sent across two gardens to a lane it had no business rejoining — which is most of why traffic
// that left the road never came back.
//
// The projection is exact and costs the same as `nearRoad`, which does it this way already. It
// runs when a driver takes charge again, not every frame.
function nearestLane(roads, x, y, hx, hy) {
  let best = null, bd = Infinity, dir = 1;
  for (const e of roads.edges) {
    for (let i = 1; i < e.pts.length; i++) {
      const p = e.pts[i - 1], q = e.pts[i];
      const dx = q.x - p.x, dy = q.y - p.y, l2 = dx * dx + dy * dy || 1;
      const t = clamp(((x - p.x) * dx + (y - p.y) * dy) / l2, 0, 1);
      const cx = p.x + dx * t - x, cy = p.y + dy * t - y;
      const d = cx * cx + cy * cy;
      if (d >= bd) continue;
      const l = Math.sqrt(l2);
      bd = d; best = { edge: e, s: e.cum[i - 1] + t * l };
      dir = (dx * hx + dy * hy) / l >= 0 ? 1 : -1;   // Whichever way suits the heading it finished with.
    }
  }
  return best ? { edge: best.edge, s: best.s, dir } : null;
}

function anchorToEdge(c, from) {
  const e = c.edge;
  let best = clamp(from, 0, e.len), bd = Infinity;
  for (let step = 32; step >= 2; step *= .5) {
    for (const s of [best - step, best, best + step]) {
      const at = clamp(s, 0, e.len);
      const p = onEdge(e, at);
      const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2;
      if (d < bd) { bd = d; best = at; }
    }
  }
  return best;
}

// ---------- turn: an arc from the current lane to the next road ----------
const bezAt = (T, t) => {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return { x: a * T.x0 + b * T.x1 + d * T.x2 + e * T.x3, y: a * T.y0 + b * T.y1 + d * T.y2 + e * T.y3 };
};
const bezDir = (T, t) => {
  const u = 1 - t;
  const dx = 3 * u * u * (T.x1 - T.x0) + 6 * u * t * (T.x2 - T.x1) + 3 * t * t * (T.x3 - T.x2);
  const dy = 3 * u * u * (T.y1 - T.y0) + 6 * u * t * (T.y2 - T.y1) + 3 * t * t * (T.y3 - T.y2);
  const d = Math.hypot(dx, dy) || 1;
  return { x: dx / d, y: dy / d };
};
function startTurn(g, c, avoidId) {
  const at = c.dir > 0 ? c.edge.b : c.edge.a;     // Node the car has reached.
  let opts = g.roads.nodes[at].e.filter(i => i !== c.edge.id);
  // After a jam the contested exit is skipped: repeating the same turn repeats the jam.
  if (avoidId !== undefined && opts.length > 1) {
    const free = opts.filter(i => i !== avoidId);
    if (free.length) opts = free;
  }
  let nextId = opts.length ? pick(opts) : c.edge.id;
  if (opts.length && c.driverTimer > 0 && (c.driverMode === 'chase' || c.driverMode === 'flee')) {
    // A rattled driver steers by the courier they can see, which is the nearest one.
    const chased = nearestPlayer(g, c.x, c.y);
    let bestScore = c.driverMode === 'chase' ? Infinity : -Infinity;
    for (const id of opts) {
      const candidate = g.roads.edges[id];
      const farNode = g.roads.nodes[candidate.a === at ? candidate.b : candidate.a];
      const score = Math.hypot(farNode.x - chased.x, farNode.y - chased.y);
      if ((c.driverMode === 'chase' && score < bestScore) || (c.driverMode === 'flee' && score > bestScore)) {
        bestScore = score; nextId = id;
      }
    }
  }
  const next = g.roads.edges[nextId];
  const ndir = next.a === at ? 1 : -1;            // Reverse along the same road at a dead end.
  const uturn = next === c.edge;
  const back = uturn ? TURN_IN * 2.4 : TURN_IN;   // Give U-turns extra room to avoid a loop.
  const sIn = ndir > 0 ? Math.min(back, next.len) : Math.max(next.len - back, 0);
  const end = lanePoint(next, sIn, ndir);
  const d = Math.max(uturn ? 78 : 34, Math.hypot(end.x - c.x, end.y - c.y) * (uturn ? .95 : .55));
  const T = {
    x0: c.x, y0: c.y, x1: c.x + c.hx * d, y1: c.y + c.hy * d,
    x2: end.x - end.hx * d, y2: end.y - end.hy * d, x3: end.x, y3: end.y,
    next, ndir, sIn, t: 0, len: 0, age: 0
  };
  measureArc(c, T);
  c.turn = T; c.mode = 'turn'; c.node = at;         // The node remains occupied while the car is inside it.
}

function measureArc(c, T) {
  let px = c.x, py = c.y, L = 0;                  // Approximate arc length with eight segments.
  for (let i = 1; i <= 8; i++) { const q = bezAt(T, i / 8); L += Math.hypot(q.x - px, q.y - py); px = q.x; py = q.y; }
  T.len = Math.max(24, L);
}

// A turn in place onto the opposite lane of the same road. Used as the last resort in a
// jam: the car stops fighting for the contested spot and simply drives the other way.
function startUTurn(c) {
  const ndir = -c.dir;
  const sIn = clamp(c.s - c.dir * 46, 0, c.edge.len);
  const end = lanePoint(c.edge, sIn, ndir);
  const d = Math.max(74, Math.hypot(end.x - c.x, end.y - c.y) * .95);
  const T = {
    x0: c.x, y0: c.y, x1: c.x + c.hx * d, y1: c.y + c.hy * d,
    x2: end.x - end.hx * d, y2: end.y - end.hy * d, x3: end.x, y3: end.y,
    next: c.edge, ndir, sIn, t: 0, len: 0, age: 0
  };
  measureArc(c, T);
  c.turn = T; c.mode = 'turn'; c.node = -1;        // A U-turn never claims an intersection.
}

// Predict the car position after dist pixels along a lane or turn arc.
//
// The corridor is scanned along the plan, and that is right for as long as the body is on it. A car
// that has been thrown into a garden is not on it, and probing the lane from out there makes it
// brake for traffic on a road it is not standing on — measured as cars sitting 240 px off the
// asphalt at 7 px/s for the length of a run, waiting for a queue they were never in. Once the body
// and the plan disagree, what is in front of the car is what matters. `offPlan` is decided once per
// frame by the caller, because this runs up to ten times per car.
const probeBox = obb(0, 0, 0, CAR_L / 2, CAR_W / 2);
function ahead(c, dist) {
  if (c.offPlan)
    return setOBB(probeBox, c.x + c.hx * dist, c.y + c.hy * dist, Math.atan2(c.hy, c.hx),
                  CAR_L / 2 + 4, CAR_W / 2 + 2);
  if (c.mode === 'turn' && c.turn) {
    const T = c.turn, t = Math.min(1, T.t + dist / T.len);
    const q = bezAt(T, t), d = bezDir(T, t);
    return setOBB(probeBox, q.x, q.y, Math.atan2(d.y, d.x), CAR_L / 2 + 4, CAR_W / 2 + 2);
  }
  const l = lanePoint(c.edge, c.s + c.dir * dist, c.dir);
  return setOBB(probeBox, l.x, l.y, Math.atan2(l.hy, l.hx), CAR_L / 2 + 4, CAR_W / 2 + 2);
}

// ---------- vehicle damage ----------
// Every value is persistent: crash damage lasts for the district instead of healing.
function newCarDamage() {
  return {
    integrity: 100, engine: 100, wheel: 0,
    plasticWork: 0, maxStrain: 0,
    crush: { front: 0, rear: 0, left: 0, right: 0 },
    glass: { front: 1, rear: 1, left: 1, right: 1 },
    lights: { frontLeft: 1, frontRight: 1, rearLeft: 1, rearRight: 1 },
    mirrors: { left: 1, right: 1 }
  };
}

function ensureCarDamage(c) {
  return c.damage || (c.damage = newCarDamage());
}


// Smoke communicates damage continuously instead of acting as a binary failure effect.
function carSmokeProfile(c) {
  if (c.exploded) return { active: false, level: 0, urgency: 0 };   // Nothing left in it to burn.
  const d = ensureCarDamage(c);
  const engine = clamp(1 - d.engine / 100, 0, 1);
  const structure = clamp(1 - d.integrity / 100, 0, 1) * .78;
  const plastic = clamp((d.plasticWork || 0) / 190, 0, 1) * .72;
  const damage = c.broken ? 1 : clamp(Math.max(engine, structure, plastic), 0, 1);
  // Very light damage has almost no physical severity, but smoke must still read
  // in the dark scene. An undamaged car creates no particles.
  const level = damage > .004 ? clamp(.22 + damage * .78, .22, 1) : 0;
  // A fuse the player cannot read is a fuse that kills them from nowhere, so the second half of
  // it is meant to look like what it is: the smoke thickens, blackens and starts throwing fire.
  // Half a fuse is fifteen seconds of warning, which is enough to walk out of the blast twice
  // over from anywhere inside it.
  const urgency = c.fuse > 0 ? clamp(1 - c.fuse / (WRECK_FUSE * .5), 0, 1) : 0;
  return {
    active: level > 0,
    level, urgency,
    interval: clamp(.08 + .76 * (1 - level) * (1 - level), .08, .55) * (1 - urgency * .55),
    darkness: clamp(.2 + Math.pow(level, .78) * .78 + urgency * .2, .2, .98),
    opacity: clamp(.32 + level * .48, .32, .8),
    radius: (4.8 + level * 7.2) * (1 + urgency * .5),
    life: 1.8 + level * 1.45,
    growth: 7 + level * 11,
    rise: (15 + level * 25) * (1 + urgency * .6)
  };
}

function disableCar(g, c, reason) {
  if (c.broken) return false;
  const d = ensureCarDamage(c);
  c.broken = true;
  c.breakReason = reason;
  c.v = 0;
  c.stall = 0;
  c.rev = 0; c.yieldTo = null; c.jamTries = 0;
  c.hold = true;
  c.hazard = 18;
  c.smokeCd = 0;
  c.fuse = WRECK_FUSE;                    // From here it is burning, not merely broken.
  d.engine = Math.min(d.engine, 4);
  g.carsBroken = (g.carsBroken || 0) + 1;
  SND.play('engineBreak', c.x, c.y);
  makeNoise(g, c.x, c.y, 270, 4, true);
  for (let i = 0; i < 14; i++) {
    const front = rnd(5, CAR_L / 2), side = rnd(-CAR_W / 2, CAR_W / 2);
    g.parts.push({ x: c.x + c.hx * front - c.hy * side, y: c.y + c.hy * front + c.hx * side,
      vx: rnd(-100, 100), vy: rnd(-115, 70), l: rnd(.35, .9),
      c: pick(['#2a2d31', '#6e7276', '#d6d9db', '#ffb14e']), s: rnd(2, 4) });
  }
  return true;
}

// Madness puts more on the street than a courier on foot can walk through, so a car taken there has
// to be able to survive being driven through it — a shell that folds on the first crowd is a prop.
//
// This goes in where `durability` already goes rather than being a shield bolted on top, so every
// consequence follows rules that were already written and already balanced against each other:
// panels crumple ten times slower, the horde carries ten times before the bodywork gives, and the
// write-off speed rises by its square root, which is the relation the model already used. Derived
// on read rather than written onto the car, so there is no saved figure to restore, nothing to get
// out of step, and a wreck the courier is thrown out of is instantly an ordinary wreck again.
const carDurability = (g, c) =>
  (c.durability || 1) * (g.madness && c.driver ? MADNESS_DRIVER_DURABILITY : 1);

function damageCar(g, c, impactSpeed, nx, ny, source = 'collision', contactX, contactY) {
  const d = ensureCarDamage(c);
  if (c.broken && source !== 'collision') return { severity: 0, zone: 'front', disabled: false };

  if (!Number.isFinite(contactX) || !Number.isFinite(contactY)) {
    contactX = c.x + nx * CAR_L * .48;
    contactY = c.y + ny * CAR_L * .48;
  }
  // The same speed transfers far more energy between two cars than against a soft
  // body. Mechanical damage still uses the original impactSpeed, while the mesh
  // receives an equivalent impulse.
  const deformationImpact = source === 'collision' ? 25 + impactSpeed * 1.28 : impactSpeed;
  const deformation = deformCarBody(c, contactX, contactY, nx, ny, deformationImpact);

  const forward = nx * c.hx + ny * c.hy;
  const side = -nx * c.hy + ny * c.hx;
  const zone = Math.abs(forward) >= Math.abs(side) * .78 ? (forward >= 0 ? 'front' : 'rear') : (side >= 0 ? 'right' : 'left');
  const scaled = Math.max(0, impactSpeed - 12);
  const severity = clamp(scaled / 190, 0, 1.45);
  const armour = c.police ? .84 : 1;
  const durability = carDurability(g, c);
  // A soft body crumples thin outer panels but absorbs most of the energy itself:
  // geometric dents become visible before serious engine damage.
  const bodyFactor = source === 'zombie' ? .32 : source === 'player' ? .4 : source === 'bullet' ? .16 : 1;
  const hpLoss = Math.pow(scaled / 22, 1.18) * 4 * armour * bodyFactor / durability;
  const crushGain = severity * (source === 'zombie' ? .28 : source === 'player' ? .34 : source === 'bullet' ? .14 : .72);
  const beforeGlass = { ...d.glass };

  d.integrity = clamp(d.integrity - hpLoss, 0, 100);
  d.plasticWork = c.body.plasticWork;
  d.maxStrain = c.body.maxStrain;
  d.crush[zone] = clamp(d.crush[zone] + crushGain, 0, 1);
  d.engine = clamp(d.engine - hpLoss * .14, 0, 100);
  c.smokeCd = 0;                                      // The first cloud immediately communicates a hit.

  const sideBias = clamp(.5 + side * .5, 0, 1);
  const breakPair = (leftName, rightName, amount) => {
    d.lights[leftName] = clamp(d.lights[leftName] - amount * (1.15 - sideBias * .6), 0, 1);
    d.lights[rightName] = clamp(d.lights[rightName] - amount * (.55 + sideBias * .6), 0, 1);
  };

  if (zone === 'front') {
    d.engine = clamp(d.engine - hpLoss * .72, 0, 100);            // Radiator and engine absorb frontal impacts.
    d.glass.front = clamp(d.glass.front - Math.max(0, severity - .12) * .78, 0, 1);
    breakPair('frontLeft', 'frontRight', severity * 1.08);
    d.wheel = clamp(d.wheel + severity * .18, 0, 1);
  } else if (zone === 'rear') {
    d.glass.rear = clamp(d.glass.rear - Math.max(0, severity - .18) * .72, 0, 1);
    breakPair('rearLeft', 'rearRight', severity * .95);
    d.wheel = clamp(d.wheel + severity * .1, 0, 1);
  } else {
    d.glass[zone] = clamp(d.glass[zone] - Math.max(0, severity - .06) * .95, 0, 1);
    d.mirrors[zone] = clamp(d.mirrors[zone] - severity * 1.8, 0, 1);
    d.wheel = clamp(d.wheel + severity * .36, 0, 1);
    const frontLamp = zone === 'left' ? 'frontLeft' : 'frontRight';
    const rearLamp = zone === 'left' ? 'rearLeft' : 'rearRight';
    d.lights[frontLamp] = clamp(d.lights[frontLamp] - severity * .55, 0, 1);
    d.lights[rearLamp] = clamp(d.lights[rearLamp] - severity * .45, 0, 1);
  }

  const glassBroke = Object.keys(d.glass).some(k => beforeGlass[k] > .22 && d.glass[k] <= .22);
  if (glassBroke) SND.play('glass', c.x, c.y);

  const catastrophic = impactSpeed >= (c.police ? 250 : 225) * Math.sqrt(durability);
  const disabled = d.integrity <= 4 || d.engine <= 3 || catastrophic;
  if (disabled) disableCar(g, c, catastrophic ? 'impact' : 'damage');
  else if (d.engine < 28) c.stall = Math.max(c.stall, rnd(.65, 1.25));
  return { severity, zone, disabled, deformation };
}

// Zombies are lighter than cars, but bodies gradually clog the radiator and ruin the front suspension.
function softBodyContact(c, body, radius, contact, mass, relativeSpeed = c.v, base = 56, speedFactor = .38) {
  const dx = body.x - c.x, dy = body.y - c.y, dist = Math.hypot(dx, dy) || 1;
  const hit = contact || circleCarContact(c, body.x, body.y, radius);
  return {
    x: hit ? hit.x : body.x - dx / dist * radius,
    y: hit ? hit.y : body.y - dy / dist * radius,
    nx: hit ? hit.nx : dx / dist,
    ny: hit ? hit.ny : dy / dist,
    // Equivalent impulse accounts for vehicle speed and target mass. It controls
    // panel deformation; bodyFactor separately prevents a body from damaging the engine like a wall.
    impact: base + clamp(relativeSpeed, 20, 190) * speedFactor + mass * 8
  };
}

// `clawing` is a siege rather than a collision: hands working on a panel, not a body packed into
// the radiator at speed. Every number below was measured against cars that were driving, where
// contact is a moment — and putting a stationary car through them wrecked it in 0.7 s under three
// zombies, which is no time at all to be sitting in one. So a siege keeps the geometry and the
// sound and takes its own, far smaller bite: a body that was never run over adds nothing to the
// load on the suspension, and hands do panel damage rather than engine damage.

function damageCarWithZombie(g, c, z, contact, clawing = false) {
  if (c.broken) return;
  // A tank is a wall on legs: hitting one wrecks the front of the car rather than the tank.
  // One collision leaves the car barely driveable; a second one finishes it.
  const mass = z.dumb ? 3.4 : z.kind === 'brute' ? 3.2 : z.kind === 'runner' ? 1.1 : 1.6;
  const hit = softBodyContact(c, z, z.r || 10, contact, mass, c.v,
    z.dumb ? 96 : 76, z.dumb ? .6 : .52);
  c.zombieHits = (c.zombieHits || 0) + 1;
  if (!clawing) c.zombieLoad = (c.zombieLoad || 0) + mass;
  damageCar(g, c, clawing ? CLAW_IMPACT + mass * 3 : hit.impact, hit.nx, hit.ny, 'zombie', hit.x, hit.y);
  SND.play('carHit', z.x, z.y);
  // How many bodies a car comes apart under. A patrol carrying the madness gun takes far more,
  // because it is going to be swarmed by design: the gun is what the horde walks toward, and a
  // crew pulled out of the cab a few seconds after opening up is a gun nobody ever sees working.
  const limit = (c.roofGun ? 21 : c.police ? 9.5 : 7.25) * carDurability(g, c);
  if (!c.broken && c.zombieLoad >= limit) disableCar(g, c, 'zombies');
}

function damageCarWithPlayer(g, c, p, contact, relativeSpeed = c.v) {
  if (c.broken) return;
  const hit = softBodyContact(c, p, 12, contact, 1.35, relativeSpeed, 48, .28);
  c.playerHits = (c.playerHits || 0) + 1;
  damageCar(g, c, hit.impact, hit.nx, hit.ny, 'player', hit.x, hit.y);
  SND.play('carHit', p.x, p.y);
}

function damageCarWithBullet(g, c, contact, bullet) {
  const speed = Math.hypot(bullet.vx, bullet.vy) || 1;
  const local = worldToLocal(c, contact.x, contact.y);
  const result = damageCar(g, c, 54, contact.nx, contact.ny, 'bullet', contact.x, contact.y);
  c.shotHits = (c.shotHits || 0) + 1;
  c.bulletDents = c.bulletDents || [];
  c.bulletDents.push({ x: local.x, y: local.y, seed: Math.random() });
  if (c.bulletDents.length > 12) c.bulletDents.shift();
  c.hitFlash = .18;

  // The exact hit point also determines which part breaks.
  const d = ensureCarDamage(c), ax = Math.abs(local.x), ay = Math.abs(local.y);
  if (local.x > 18 && ay > 3.5) {
    const lamp = local.y < 0 ? 'frontLeft' : 'frontRight';
    d.lights[lamp] = clamp(d.lights[lamp] - .42, 0, 1);
  } else if (local.x < -18 && ay > 3.5) {
    const lamp = local.y < 0 ? 'rearLeft' : 'rearRight';
    d.lights[lamp] = clamp(d.lights[lamp] - .38, 0, 1);
  } else if (ax < 11 && ay > 6.2) {
    const glass = local.y < 0 ? 'left' : 'right';
    d.glass[glass] = clamp(d.glass[glass] - .46, 0, 1);
  } else if (local.x > 5 && ax < 13) d.glass.front = clamp(d.glass.front - .38, 0, 1);
  else if (local.x < -5 && ax < 13) d.glass.rear = clamp(d.glass.rear - .38, 0, 1);

  if (!c.broken) {
    if (c.parked) {
      c.driverMode = 'alarm'; c.alarm = 7; c.hazard = 7; c.honk = 1;
    } else {
      const chaseChance = c.police ? .82 : clamp(.22 + c.shotHits * .12, .22, .58);
      c.driverMode = Math.random() < chaseChance ? 'chase' : 'flee';
      c.driverTimer = rnd(9, 15); c.rev = 0; c.yieldTo = null; c.jamTries = 0;
      c.hold = false; c.stall = Math.min(c.stall || 0, .2); c.honk = 1;
      c.hazard = Math.max(c.hazard || 0, c.driverMode === 'flee' ? 4 : 1.2);
    }
  }
  makeNoise(g, contact.x, contact.y, c.parked ? 330 : 250, c.parked ? 5 : 3.5, true);
  SND.play(c.parked ? 'honk' : 'carHit', contact.x, contact.y);
  return { ...result, mode: c.driverMode, local, speed };
}

// QA comparison uses normal district objects and the main renderer.
// Normal gameplay never calls this function.
function prepareCarImpactComparison(g) {
  if (!g || g.cars.length < 3) return false;
  const p = g.p, above = p.y > 125, y = clamp(p.y + (above ? -82 : 82), 32, WORLD - 32);
  const cars = g.cars.slice(0, 3), offsets = [-62, 0, 62];
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    c.x = clamp(p.x + offsets[i], 32, WORLD - 32); c.y = y;
    c.hx = 1; c.hy = 0; c.v = 0; c.baseMax = 0; c.max = 0;
    c.steer = 0; c.slip = 0; c.spin = 0; c.lost = null;
    c.broken = false; c.breakReason = ''; c.hazard = 0; c.body = createCarBody(); c.damage = newCarDamage();
    setOBB(c.box, c.x, c.y, 0, CAR_L / 2, CAR_W / 2); syncCarBody(c);
  }
  cars[0].col = '#b65a4d'; cars[1].col = '#e3e7ec'; cars[2].col = '#9068b8';
  const person = { x: cars[1].x + 33, y: cars[1].y };
  damageCarWithPlayer(g, cars[1], person, circleCarContact(cars[1], person.x, person.y, 12), 125);
  damageCar(g, cars[2], 190, 1, 0, 'collision', cars[2].x + CAR_L / 2, cars[2].y);
  g.cars = cars; g.zombies.length = 0; g.zombieShots.length = 0; g.carSmoke.length = 0;
  g.solids.length = 0; g.houses.length = 0; g.trees.length = 0; g.parked.length = 0; g.lamps.length = 0;
  p.aim = above ? -Math.PI / 2 : Math.PI / 2; p.torch = true; p.batt = 1;
  updateFog(g, 1);
  return true;
}

function crashEffects(g, x, y, impactSpeed) {
  if (impactSpeed < 28) return;
  SND.play('crash', x, y);
  makeNoise(g, x, y, clamp(190 + impactSpeed * 1.25, 220, 520), clamp(2.5 + impactSpeed / 65, 3, 7), true);
  // Shake belongs to a screen, so it is measured from the courier sitting in front of this one.
  g.shake = Math.max(g.shake, clamp(impactSpeed / 170, .25, 1.25) * clamp(1 - Math.hypot(g.p.x - x, g.p.y - y) / 540, 0, 1));
  const count = Math.round(clamp(8 + impactSpeed * .09, 10, 34));
  for (let i = 0; i < count; i++)
    g.parts.push({ x, y, vx: rnd(-170, 170) * (1 + impactSpeed / 260), vy: rnd(-190, 110) * (1 + impactSpeed / 320),
      l: rnd(.3, 1), c: pick(['#ffe08a', '#ffffff', '#9fb4c8', '#ff9a5a', '#34383d']), s: rnd(2, 4) });
}

// Car-to-car impact force uses relative speed along the contact line.
function crash(g, a, b, manifold) {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
  const nx = manifold ? manifold.nx : dx / d, ny = manifold ? manifold.ny : dy / d;
  const contactX = manifold ? manifold.x : (a.x + b.x) * .5;
  const contactY = manifold ? manifold.y : (a.y + b.y) * .5;
  const closing = Math.max(0, (a.hx * a.v - b.hx * b.v) * nx + (a.hy * a.v - b.hy * b.v) * ny);
  const impact = Math.max(32, closing);                         // Even a slow touch leaves a scratch and small dent.
  const hard = closing > 55;
  const separation = manifold ? manifold.penetration * .55 : 0;
  const k = clamp(2.5 + impact * .045 + separation, 2.5, 16);
  const massA = a.mass || 1, massB = b.mass || 1, massSum = massA + massB;
  const impactA = impact * 2 * massB / massSum;
  const impactB = impact * 2 * massA / massSum;
  damageCar(g, a, impactA, nx, ny, 'collision', contactX, contactY);
  damageCar(g, b, impactB, -nx, -ny, 'collision', contactX, contactY);
  const invA = 1 / massA, invB = 1 / massB, invSum = invA + invB;
  const shiftA = k * 2 * invA / invSum, shiftB = k * 2 * invB / invSum;
  const ax = -nx * shiftA, ay = -ny * shiftA, bx = nx * shiftB, by = ny * shiftB;
  // Separate the physical bodies immediately so they no longer overlap in this frame, and leave
  // them there: a body that owns its own position does not need the displacement remembered.
  a.x += ax; a.y += ay; b.x += bx; b.y += by;
  // A shunt in the side is also a shove sideways, which is the thing most likely to break a car's
  // grip on a corner. Half of it goes into the slide, so a nudge at speed can start a spin.
  const lat = (dx, dy, car) => (-car.hy * dx + car.hx * dy) * 5.5;
  a.slip = clamp((a.slip || 0) + lat(ax, ay, a), -SLIP_MAX, SLIP_MAX);
  b.slip = clamp((b.slip || 0) + lat(bx, by, b), -SLIP_MAX, SLIP_MAX);
  if (a.box) setOBB(a.box, a.x, a.y, Math.atan2(a.hy, a.hx), CAR_L / 2, CAR_W / 2);
  if (b.box) setOBB(b.box, b.x, b.y, Math.atan2(b.hy, b.hx), CAR_L / 2, CAR_W / 2);
  syncCarBody(a); syncCarBody(b);
  a.cd = b.cd = hard ? 2.5 : 1.2;
  for (const [c, ownImpact] of [[a, impactA], [b, impactB]]) {
    c.honk = 1;
    c.hazard = Math.max(c.hazard || 0, hard ? 8 : 2.5);
    if (c.broken) { c.v = 0; continue; }
    if (!hard) { c.v *= .38; continue; }                // A side scrape slows the car and still marks the body.
    c.v = 0;
    c.stall = Math.max(c.stall, rnd(.8, 1.7) + ownImpact / 180);
  }
  crashEffects(g, contactX, contactY, Math.max(impactA, impactB));
}

// If traffic fails to stop before a parked car, the moving vehicle is damaged and halted.
function crashObstacle(g, c, obstacle) {
  if (c.cd > 0 || c.broken) return;
  const dx = obstacle.cx - c.x, dy = obstacle.cy - c.y, d = Math.hypot(dx, dy) || 1;
  const nx = dx / d, ny = dy / d;
  const impact = Math.max(32, c.v * Math.max(.55, Math.abs(c.hx * nx + c.hy * ny)));
  const contactX = c.x + nx * CAR_L * .45, contactY = c.y + ny * CAR_L * .45;
  damageCar(g, c, impact, nx, ny, 'collision', contactX, contactY);
  const push = clamp(3 + impact * .04, 4, 12), sx = -nx * push, sy = -ny * push;
  c.x += sx; c.y += sy;
  c.slip = 0; c.spin = 0;                    // Hitting a wall ends a slide rather than feeding it.
  if (c.box) setOBB(c.box, c.x, c.y, Math.atan2(c.hy, c.hx), CAR_L / 2, CAR_W / 2);
  syncCarBody(c);
  c.cd = 2.4;
  c.honk = 1;
  c.hazard = Math.max(c.hazard || 0, 8);
  if (!c.broken) { c.v = 0; c.stall = Math.max(c.stall, rnd(1, 1.9)); }
  crashEffects(g, contactX, contactY, impact);
}

// Nearest road point: distance and direction.
function nearRoad(R, x, y) {
  let bd = 1e9, ba = 0, bx = 0, by = 0;
  for (const e of R.edges) for (let i = 1; i < e.pts.length; i++) {
    const p = e.pts[i - 1], q = e.pts[i];
    const dx = q.x - p.x, dy = q.y - p.y, l2 = dx * dx + dy * dy || 1;
    const t = clamp(((x - p.x) * dx + (y - p.y) * dy) / l2, 0, 1);
    const cx = p.x + dx * t, cy = p.y + dy * t, d = Math.hypot(x - cx, y - cy);
    if (d < bd) { bd = d; ba = Math.atan2(dy, dx); bx = cx; by = cy; }
  }
  return { d: bd, ang: ba, x: bx, y: by };
}

return Object.freeze({
  FW, fogCv,
  updateFog, drawFog, fogAt,
  EV, emit, shakeAt,
  newWeather, updateWeather, updateWeatherVisuals, drawRain, drawGlowThroughFog,
  TURN_IN, makeRoads, onEdge, lanePoint, placeCar, startTurn, startUTurn, ahead,
  GRIP, SLIP_LOST, MAX_LOCK, STEER_RATE, WHEELBASE,
  steerToward, rollCar, anchorToEdge, nearestLane, setCar,
  WRECK_FUSE,
  newCarDamage, carSmokeProfile, damageCar, damageCarWithZombie, damageCarWithPlayer, damageCarWithBullet,
  prepareCarImpactComparison,
  disableCar, crash, crashObstacle,
  bezAt, bezDir, nearRoad,
  makeNoise, surfaceAt
});
})();

