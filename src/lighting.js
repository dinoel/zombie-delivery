// Canvas 2D and WebGL lighting.
window.TownGame.lighting = (() => {
'use strict';

const { ctx, W, H, len, torchHand, gunHand } = window.TownGame.core;
const {
  RGB_LAMP, RGB_HEAD, RGB_WARM, RGB_RED, RGB_HAZARD, RGB_BEACON_RED, RGB_BEACON_BLUE,
  RGB_ROOF_RED, RGB_ROOF_BLUE, RGB_MUZZLE, RGB_FILTH, RGB_PARCEL, RGB_AMMO, RGB_GOAL,
  RGB_ZOMBIE, RGB_CASH, RGB_FLAME,
  LAMP_INTENSITY, LAMP_POOL_R, LAMP_POOL_INT, LAMP_POOL_REACH,
  LAMP_HAZE_R, LAMP_HAZE_INT, SHADOW_LEN, MAX_FOLIAGE_LOBES, AMB, ROOF_AMB,
  HEADLIGHT_R, HEADLIGHT_R_DRIVEN
} = window.TownGame.config;
const quality = window.TownGame.quality;
const { bodyPointWorld } = window.TownGame.carPhysics;
const { solidsNear, treesNear, softNear } = window.TownGame.physics;
const { lampGlow } = window.TownGame.world;
const legacyPerf = typeof URLSearchParams !== 'undefined' && typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('qa') === 'perf-legacy';

// ---------- lighting: every source casts its own shadows ----------
const lightCv = document.createElement('canvas');
lightCv.width = W; lightCv.height = H;
const lctx = lightCv.getContext('2d');
const tmpCv = document.createElement('canvas');       // Buffer for one light source.
tmpCv.width = tmpCv.height = 560;
const tctx = tmpCv.getContext('2d');

// Lamps used to flatten the night into an evenly lit stage. A street should be walkable and
// still feel like somewhere you would rather not be standing, so they throw about a third less.
// A street lamp points down. From above that is a compact patch on the asphalt under the head,
// not something spraying sideways across the map, and along a street you should be able to count
// the patches. Around each one there is a soft lift — the haze a lamp puts into the air — which
// keeps the road from going black between lamps without being light anyone could read a street by.
// Two sources per lamp, because those are two different things: one you can see by, and one you
// can only just see.
const GOLDEN_ANGLE = 2.399963;

const foliageNoise = (seed, i) => {
  const n = Math.sin((seed || .37) * 913.7 + i * 78.233) * 43758.5453;
  return n - Math.floor(n);
};

// High quality models foliage as separated leaf clusters. Their shadow wedges
// overlap irregularly and leave stable pinholes for light instead of forming a wall.
function forEachFoliageLobe(o, visit) {
  if (o.t === 'hedge') {
    const count = Math.max(4, Math.ceil(o.hw * 2 / 17));
    const ca = Math.cos(o.ang), sa = Math.sin(o.ang);
    for (let i = 0; i < count; i++) {
      const noise = foliageNoise(o.seed || o.cx * .001 + o.cy * .002, i);
      const along = (-.88 + 1.76 * (i + .5) / count) * o.hw;
      const across = (noise - .5) * o.hh * .9;
      visit(o.cx + ca * along - sa * across, o.cy + sa * along + ca * across,
        o.hh * (.46 + noise * .2));
    }
    return;
  }
  const bush = o.foliage === 'bush', count = bush ? 4 : 6;
  for (let i = 0; i < count; i++) {
    const noise = foliageNoise(o.seed, i), angle = (o.seed || 0) * 6.283 + i * GOLDEN_ANGLE;
    const distance = i === 0 ? 0 : o.r * (.4 + noise * .22);
    const radius = o.r * (i === 0 ? .13 : (bush ? .15 : .13) + noise * .07);
    visit(o.x + Math.cos(angle) * distance, o.y + Math.sin(angle) * distance, radius);
  }
}

const isFoliageOccluder = o => o.r !== undefined || o.t === 'hedge';

// Occluders near a point: houses, hedges, trees, and cars. The static furniture comes out
// of the district's broad-phase grid; only the traffic is still walked in full, and there
// is never much of it.
const occSolids = [], occTrees = [], occSoft = [];
function occNear(g, x, y, r, skip, detailedFoliage = false) {
  const out = [];
  for (const s of solidsNear(g, x, y, r, occSolids, 0)) {
    const dx = s.cx - x, dy = s.cy - y, reach = r + s.rad;
    if (dx * dx + dy * dy < reach * reach) out.push(s);
  }
  for (const t of treesNear(g, x, y, r, occTrees, 0))
    if (Math.abs(t.x - x) < r + t.r && Math.abs(t.y - y) < r + t.r) out.push(t);
  if (detailedFoliage) for (const b of softNear(g, x, y, r, occSoft, 0))
    if (Math.abs(b.x - x) < r + b.r && Math.abs(b.y - y) < r + b.r) out.push(b);
  for (const c of g.cars) {
    const dx = c.x - x, dy = c.y - y, reach = r + c.box.rad;
    if (c !== skip && dx * dx + dy * dy < reach * reach) out.push(c.body ? c.body.collider : c.box);
  }
  return out;
}

// Cut every obstacle shadow out of the light pool.
function castShadows(c, lx, ly, occ, detailedFoliage) {
  c.globalCompositeOperation = 'destination-out';
  c.fillStyle = '#000';
  const circleShadow = (x, y, r, startPad = 0) => {
    const dx = x - lx, dy = y - ly, d = len(dx, dy);
    if (d < r) return;
    const px = -dy / d * r, py = dx / d * r;
    const ux = dx / d, uy = dy / d;
    const ax = x + px + ux * startPad, ay = y + py + uy * startPad;
    const bx = x - px + ux * startPad, by = y - py + uy * startPad;
    const da = len(ax - lx, ay - ly) || 1, db = len(bx - lx, by - ly) || 1;
    c.beginPath();
    c.moveTo(ax, ay); c.lineTo(bx, by);
    c.lineTo(bx + (bx - lx) / db * SHADOW_LEN, by + (by - ly) / db * SHADOW_LEN);
    c.lineTo(ax + (ax - lx) / da * SHADOW_LEN, ay + (ay - ly) / da * SHADOW_LEN);
    c.closePath(); c.fill();
  };
  for (const o of occ) {
    if (detailedFoliage && isFoliageOccluder(o)) {
      c.globalAlpha = .24;
      const pad = o.r !== undefined ? o.r * .68 : o.hh * .75;
      forEachFoliageLobe(o, (x, y, r) => circleShadow(x, y, r, pad));
      c.globalAlpha = 1;
      continue;
    }
    if (o.r !== undefined) {                          // Tree: wedge between tangents.
      circleShadow(o.x, o.y, o.r);                    // The crown is lit while its shadow extends behind it.
    } else {                                          // House, hedge, or car: wedges from far faces.
      const pts = o.pts;
      for (let i = 0; i < 4; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % 4];
        const nx = y2 - y1, ny = x1 - x2;             // Outward face normal.
        if ((x1 - lx) * nx + (y1 - ly) * ny <= 0) continue;   // A face looking at the light casts no shadow.
        const d1 = len(x1 - lx, y1 - ly) || 1, d2 = len(x2 - lx, y2 - ly) || 1;
        c.beginPath();
        c.moveTo(x1, y1); c.lineTo(x2, y2);
        c.lineTo(x2 + (x2 - lx) / d2 * SHADOW_LEN, y2 + (y2 - ly) / d2 * SHADOW_LEN);
        c.lineTo(x1 + (x1 - lx) / d1 * SHADOW_LEN, y1 + (y1 - ly) / d1 * SHADOW_LEN);
        c.closePath(); c.fill();
      }
    }
  }
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
}

// How a pool fades from its centre. Most lights want a hot middle; a lamp pointing straight
// down does not — its patch on the asphalt is close to even, and a bright core made the lamp
// itself look like the brightest thing in the district. `even` runs 0 (normal) to 1 (flat).
function radialFade(gradient, col, even) {
  const exponent = 1 - even * .62;
  for (const t of [0, .2, .4, .6, .8, 1])
    gradient.addColorStop(t, col.replace("%a", Math.pow(1 - t, exponent).toFixed(3)));
}

// Draw one source into a buffer, subtract shadows, then apply it to color and darkness masks.
function paintLight(g, camx, camy, x, y, r, col, tint, punch, ang, spread, skip, shadows, even) {
  const size = Math.min(tmpCv.width, Math.ceil(r * 2) + 8);
  const sx = Math.round(x - camx - size / 2), sy = Math.round(y - camy - size / 2);
  if (sx > W || sy > H || sx + size < 0 || sy + size < 0) return;

  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.clearRect(0, 0, size, size);
  tctx.setTransform(1, 0, 0, 1, size / 2 - x, size / 2 - y);   // Work in world coordinates.
  tctx.save();
  if (spread) {
    tctx.beginPath(); tctx.moveTo(x, y); tctx.arc(x, y, r, ang - spread, ang + spread);
    tctx.closePath(); tctx.clip();
  }
  const gr = tctx.createRadialGradient(x, y, 0, x, y, r);
  radialFade(gr, col, even);
  tctx.fillStyle = gr; tctx.fillRect(x - r, y - r, r * 2, r * 2);
  tctx.restore();
  if (shadows && r > 20) {
    const foliage = quality.current.foliageShadows;
    castShadows(tctx, x, y, occNear(g, x, y, r, skip, foliage), foliage);
  }
  tctx.setTransform(1, 0, 0, 1, 0, 0);

  ctx.save();                                          // Color above the scene.
  ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = tint;
  ctx.drawImage(tmpCv, 0, 0, size, size, sx, sy, size, size);
  ctx.restore();
  lctx.save();                                         // A matching hole in the night layer.
  lctx.globalCompositeOperation = 'destination-out'; lctx.globalAlpha = punch;
  lctx.drawImage(tmpCv, 0, 0, size, size, sx, sy, size, size);
  lctx.restore();
}

// Without shadows, an intermediate buffer is unnecessary: apply the same gradient
// directly to the town and night mask. This removes two large drawImage calls per light.
function paintLightDirect(camx, camy, x, y, r, col, tint, punch, ang, spread, even) {
  const sx = x - camx, sy = y - camy;
  const paint = (c, operation, alpha) => {
    c.save(); c.globalCompositeOperation = operation; c.globalAlpha = alpha;
    if (spread) {
      c.beginPath(); c.moveTo(sx, sy); c.arc(sx, sy, r, ang - spread, ang + spread);
      c.closePath(); c.clip();
    }
    const gr = c.createRadialGradient(sx, sy, 0, sx, sy, r);
    radialFade(gr, col, even);
    c.fillStyle = gr; c.fillRect(sx - r, sy - r, r * 2, r * 2);
    c.restore();
  };
  paint(ctx, 'lighter', tint);
  paint(lctx, 'destination-out', punch);
}

// One light list keeps the GL and 2D paths consistent.
function collectLights(g, camx, camy) {
  const out = [];
  const add = (x, y, r, rgb, int, tint, punch, ang, spread, soft, priority = 1, skip) => {
    if (!legacyPerf && (x + r < camx || y + r < camy || x - r > camx + W || y - r > camy + H)) return;
    const light = { x, y, r, rgb, int, tint, punch, ang: ang || 0, spread: spread || 0,
                    soft: soft || 0, priority, skip };
    out.push(light);
    return light;                                     // Handed back so a caller can mark it flat.
  };

  // A working street lamp is the main light on the block: it hangs over the asphalt and
  // reaches far enough that neighbouring pools overlap along a street. A shot-out one
  // keeps its mast and leaves the road to the flashlight.
  for (const l of g.lamps) {
    if (l.broken) continue;
    const glow = lampGlow(l, g.time);
    if (glow < .02) continue;
    const rgb = l.lampRgb || RGB_LAMP, power = (l.lampPower || 1) * glow;
    // The haze goes in first so the patch sits nearer the front of the list and keeps its shadows.
    const haze = add(l.hx, l.hy, LAMP_HAZE_R, rgb,
                     LAMP_INTENSITY * LAMP_HAZE_INT * power, .26, .4, 0, 0, 0, 4);
    if (haze) haze.flat = true;                       // A glow in the air casts nothing.
    const pool = add(l.hx + Math.cos(l.ang) * LAMP_POOL_REACH, l.hy + Math.sin(l.ang) * LAMP_POOL_REACH,
                     LAMP_POOL_R * (.82 + glow * .18), rgb,
                     LAMP_INTENSITY * LAMP_POOL_INT * power, .34, .98, 0, 0, 5, 6);
    if (pool) pool.even = 1;                          // Flat across the patch, no hot core.
  }
  for (const c of g.cars) {
    if (!legacyPerf && (c.x + 270 < camx || c.y + 270 < camy || c.x - 270 > camx + W || c.y - 270 > camy + H)) continue;
    const a = Math.atan2(c.hy, c.hx);
    const lights = c.damage ? c.damage.lights : { frontLeft: 1, frontRight: 1, rearLeft: 1, rearRight: 1 };
    const hazardOn = c.hazard > 0 && ((c.hazard * 5) | 0) % 2 === 0;
    // Each headlight is independent; a broken one produces neither a beam nor a glow.
    const frontRight = bodyPointWorld(c, 22, 7), frontLeft = bodyPointWorld(c, 22, -7);
    const frontRightBase = bodyPointWorld(c, 14, 7), frontLeftBase = bodyPointWorld(c, 14, -7);
    const rightAngle = Math.atan2(frontRight.y - frontRightBase.y, frontRight.x - frontRightBase.x);
    const leftAngle = Math.atan2(frontLeft.y - frontLeftBase.y, frontLeft.x - frontLeftBase.x);
    // A car being driven throws further than one going past, because the fog opens to the beam and
    // the two have to agree — a cone of explored darkness in front of the bonnet is worse than
    // either. The lamps are the same lamps; what changed is that somebody is steering by them.
    const beam = c.driver ? HEADLIGHT_R_DRIVEN : HEADLIGHT_R;
    if (!c.broken && lights.frontRight > .22)
      add(frontRight.x, frontRight.y, beam, RGB_HEAD, .62 * lights.frontRight, .1, .78, rightAngle + .03, .4, 5, 3, c);
    if (!c.broken && lights.frontLeft > .22)
      add(frontLeft.x, frontLeft.y, beam, RGB_HEAD, .62 * lights.frontLeft, .1, .78, leftAngle - .03, .4, 5, 3, c);

    const rearRight = bodyPointWorld(c, -22, 7), rearLeft = bodyPointWorld(c, -22, -7);
    const tailRgb = hazardOn ? RGB_HAZARD : RGB_RED;
    if ((!c.broken || hazardOn) && lights.rearRight > .22)
      add(rearRight.x, rearRight.y, hazardOn ? 43 : 30, tailRgb, (hazardOn ? .8 : .48) * lights.rearRight, .22, .55, 0, 0, 0, 1, c);
    if ((!c.broken || hazardOn) && lights.rearLeft > .22)
      add(rearLeft.x, rearLeft.y, hazardOn ? 43 : 30, tailRgb, (hazardOn ? .8 : .48) * lights.rearLeft, .22, .55, 0, 0, 0, 1, c);
    if (!c.police) continue;
    // A heavy gun firing at night lights the street it is firing down. It goes in before the
    // beacon so a burst reads as flashes over the top of the rotating light rather than under it.
    if (c.copFlash > 0 && c.roofGun) {
      const m = bodyPointWorld(c, -7, 0);
      add(m.x, m.y, 250, RGB_MUZZLE, 2.1, .5, 1, c.copAim || 0, .9, 16, 10);
    }
    if (c.broken && c.hazard <= 0) continue;
    // Beacon: two rotating beams with an additional pulse.
    const b = c.beacon || 0, pulse = .55 + .45 * Math.sin(b * 3.1);
    const beaconPower = c.broken ? .55 : 1;
    add(c.x, c.y, 235, RGB_BEACON_RED, 1.5 * pulse * beaconPower, .3, .86, a + b, .5, 7, 3, c);
    add(c.x, c.y, 235, RGB_BEACON_BLUE, 1.5 * (1.55 - pulse) * beaconPower, .3, .86, a + b + Math.PI, .5, 7, 3, c);
    add(c.x, c.y, 52, RGB_ROOF_RED, .8 * pulse, .34, .5, 0, 0, 0, 1, c);      // Roof reflection.
    add(c.x, c.y, 52, RGB_ROOF_BLUE, .8 * (1.55 - pulse), .34, .5, 0, 0, 0, 1, c);
  }
  // Every courier carries their own light. A partner's beam sweeping the far pavement is
  // often the first thing that says where they are.
  for (const courier of g.players) {
    const lit = courier.torch && courier.batt > 0;
    if (lit) {                                                                           // Flashlight originates from the hand.
      const h = torchHand(courier);
      add(h.x, h.y, 250 - 40 * g.weather.rain, RGB_WARM, 1.15 * courier.flick, .18, .95, courier.aim, .45, 6, 10);
    }
    add(courier.x, courier.y, lit ? 74 : 52, RGB_WARM, lit ? .5 : .3, .1, lit ? .8 : .6, 0, 0, 0, 9); // Pool around the feet.
    if (courier.muzzle > 0) { const h = gunHand(courier); add(h.x, h.y, 190, RGB_MUZZLE, 1.7, .5, 1, 0, 0, 16, 10); }
    // A jet of burning fuel is the brightest thing in the district while it lasts, and it lights
    // the cone it is filling rather than a circle around the courier. The flashlight's shape with
    // a much hotter colour, a shorter reach and a wider mouth.
    if (courier.flaming && !courier.down) {
      const h = gunHand(courier);
      add(h.x, h.y, 210, RGB_FLAME, 1.9, .42, 1, courier.aim, .5, 14, 10);
    }
  }
  // Each body that is alight carries its own. A street with four of them running across it is lit
  // by them, which is most of what makes the weapon worth firing at night.
  for (const z of g.zombies) if (!z.gone && z.burn > 0)
    add(z.x, z.y, 96, RGB_FLAME, .95, .4, .8, 0, 0, 0, 6);
  for (const s of g.zombieShots) add(s.x, s.y, 23 + s.r, s.light || RGB_FILTH, .75, .28, .62, 0, 0, 0, 8);
  for (const b of g.parcels) if (b.state === 'ground') add(b.x, b.y, 46, RGB_PARCEL, .7, .24, .8, 0, 0, 0, 5);
  for (const a of g.ammoBoxes) add(a.x, a.y, 42, RGB_AMMO, .6, .22, .78, 0, 0, 0, 5);
  // A note is small and there can be many of them, so it glows faintly and yields the
  // light budget to everything else on the street.
  for (const m of g.cash) add(m.x, m.y, 26, RGB_CASH, .38, .18, .6, 0, 0, 0, 4);
  // Only the doors with something owed to them are lit.
  if (!g.done) for (const b of g.parcels) if (b.state === 'carried')
    add(b.dest.x, b.dest.y, 76, RGB_GOAL, 1, .32, .95, 0, 0, 0, 5);
  for (const z of g.zombies) add(z.x + Math.cos(z.ang) * 6, z.y + Math.sin(z.ang) * 6, 14, RGB_ZOMBIE, .7, .32, .3, 0, 0, 0, 0);

  const max = quality.current.maxLights;
  if (legacyPerf) {
    const visible = out.filter(l => l.x + l.r >= camx && l.y + l.r >= camy &&
      l.x - l.r <= camx + W && l.y - l.r <= camy + H);
    if (!Number.isFinite(max) || visible.length <= max) return visible;
    const cx = camx + W / 2, cy = camy + H / 2;
    visible.sort((a, b) => b.priority - a.priority ||
      Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    return visible.slice(0, max);
  }
  if (!Number.isFinite(max) || out.length <= max) return out;
  const cx = camx + W / 2, cy = camy + H / 2;
  for (const l of out) { const dx = l.x - cx, dy = l.y - cy; l.dist2 = dx * dx + dy * dy; }
  out.sort((a, b) => b.priority - a.priority || a.dist2 - b.dist2);
  out.length = max;
  return out;
}

function drawLight(g, camx, camy) {
  g.lit = collectLights(g, camx, camy);           // Glow through fog uses the same list.
  if (gl) drawLightGL(g, camx, camy);
  else drawLight2D(g, camx, camy);
}

function drawLight2D(g, camx, camy) {
  // Night plus dim moonlight keeps silhouettes visible.
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.globalCompositeOperation = 'source-over';
  lctx.fillStyle = 'rgba(10,14,38,.92)';
  lctx.fillRect(0, 0, W, H);
  lctx.globalCompositeOperation = 'destination-out';
  lctx.fillStyle = 'rgba(255,255,255,.12)';
  lctx.fillRect(0, 0, W, H);
  lctx.globalCompositeOperation = 'source-over';

  const profile = quality.current;
  for (let i = 0; i < g.lit.length; i++) {
    const l = g.lit[i];
    const col = `rgba(${Math.round(l.rgb[0] * 255)},${Math.round(l.rgb[1] * 255)},${Math.round(l.rgb[2] * 255)},%a)`;
    const shadows = i < profile.shadowLights && !l.flat;
    if (!legacyPerf && !shadows)
      paintLightDirect(camx, camy, l.x, l.y, l.r, col, l.tint, l.punch, l.ang, l.spread, l.even || 0);
    else paintLight(g, camx, camy, l.x, l.y, l.r, col, l.tint, l.punch, l.ang, l.spread, l.skip, shadows, l.even || 0);
  }
  // Ground-level light may hit walls, but it cannot land on a roof above it. Replace every
  // visible roof with sky light after all light holes are cut: no lamp reaches up there, and
  // the moon reaches nothing else as well.
  if (g.houses.length) {
    lctx.save(); lctx.beginPath();
    for (const h of g.houses) {
      if (h.cx + h.rad < camx || h.cy + h.rad < camy || h.cx - h.rad > camx + W || h.cy - h.rad > camy + H) continue;
      lctx.moveTo(h.pts[0][0] - camx, h.pts[0][1] - camy);
      for (let i = 1; i < 4; i++) lctx.lineTo(h.pts[i][0] - camx, h.pts[i][1] - camy);
      lctx.closePath();
    }
    lctx.clip(); lctx.clearRect(0, 0, W, H);
    lctx.fillStyle = 'rgba(10,14,38,.68)'; lctx.fillRect(0, 0, W, H); lctx.restore();
  }
  ctx.drawImage(lightCv, 0, 0);
}

// ---------- WebGL: shadow volumes with multisample penumbra ----------
const glCv = document.createElement('canvas');
glCv.width = W; glCv.height = H;
// A roof is the one surface in the district that faces the sky, so it is the one surface lit
// by it. Street lamps still never reach up there — the roof simply gets more moonlight than
// the ground does, which is what keeps a row of houses reading as slate and tile at night
// instead of as holes cut out of the street.
let gl = (() => {
  if (location.search.includes('2d')) return null;    // ?2d forces the fallback path.
  const opt = { alpha: false, depth: false, stencil: true, antialias: false, preserveDrawingBuffer: false };
  try {
    const c = glCv.getContext('webgl2', opt) || glCv.getContext('webgl', opt);
    return c && c.getContextAttributes().stencil ? c : null;   // Shadows require a stencil buffer.
  } catch (e) { return null; }
})();

const GLR = gl && (() => { try {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = (vs, fs) => {
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'a_pos'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  };
  // Screen pixels to clip space, with y pointing down as in 2D.
  const TO_CLIP = 'vec4(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0, 0.0, 1.0)';

  // Stages do not share uniforms because GLSL ES rejects mismatched precision.
  const litP = prog(`
    attribute vec2 a_pos;                       // Unit square, 0..1.
    uniform vec2 u_res, u_light, u_cam; uniform float u_radius;
    varying mediump vec2 v_unit, v_pixel, v_light, v_world;
    void main() {
      v_unit = a_pos * 2.0 - 1.0;
      vec2 p = u_light + v_unit * u_radius;
      v_pixel = p; v_light = u_light; v_world = p + u_cam;
      gl_Position = ${TO_CLIP};
    }`, `
    precision mediump float;
    uniform vec3 u_color; uniform float u_ang, u_spread, u_amount, u_even;
    uniform float u_foliageCount;
    uniform vec4 u_foliage[8];                 // Screen x/y, cluster radius, clear start distance.
    varying mediump vec2 v_unit, v_pixel, v_light, v_world;
    float foliageTransmission() {
      if (u_foliageCount < .5) return 1.0;
      vec2 ray = v_pixel - v_light;
      float rayLength = max(length(ray), .001);
      vec2 direction = ray / rayLength;
      float transmission = 1.0;
      for (int i = 0; i < 8; i++) {
        if (float(i) < u_foliageCount) {
          vec4 leaf = u_foliage[i];
          vec2 relative = leaf.xy - v_light;
          float along = dot(relative, direction);
          float across = abs(relative.x * direction.y - relative.y * direction.x);
          float behind = step(1.0, along) * step(along + leaf.w, rayLength);
          float cluster = 1.0 - smoothstep(leaf.z * .5, leaf.z * 1.3, across);
          vec2 leafWorld = leaf.xy + (v_world - v_pixel);
          float grain = .5 + .25 * sin(v_world.x * .105 + leafWorld.y * .047)
                             + .25 * sin(v_world.y * .137 - leafWorld.x * .039);
          float denseLeaves = smoothstep(.28, .76, grain);
          float shade = behind * cluster * (.1 + denseLeaves * .24);
          transmission *= 1.0 - shade;
        }
      }
      return max(.55, transmission);             // Leaves transmit light; they can never make a black wall.
    }
    void main() {
      // Soft falloff toward the edge, flattened for a lamp so its patch has no hot core.
      float f = pow(max(0.0, 1.0 - length(v_unit)), mix(2.0, 0.75, u_even));
      if (u_spread > 0.0) {                     // Headlight and flashlight cone.
        float a = mod(atan(v_unit.y, v_unit.x) - u_ang + 9.42477796, 6.28318531) - 3.14159265;
        f *= 1.0 - smoothstep(u_spread * 0.55, u_spread, abs(a));
      }
      f *= foliageTransmission();
      gl_FragColor = vec4(u_color * f * u_amount, 1.0);
    }`);

  const shadP = prog(`
    attribute vec2 a_pos; uniform vec2 u_res;
    void main() { vec2 p = a_pos; gl_Position = ${TO_CLIP}; }`, `
    precision mediump float;
    void main() { gl_FragColor = vec4(0.0); }`);

  const roofP = prog(`
    attribute vec2 a_pos; uniform vec2 u_res;
    void main() { vec2 p = a_pos; gl_Position = ${TO_CLIP}; }`, `
    precision mediump float;
    void main() { gl_FragColor = vec4(${ROOF_AMB[0]}, ${ROOF_AMB[1]}, ${ROOF_AMB[2]}, 1.0); }`);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

  const shadowBuf = gl.createBuffer();
  const verts = new Float32Array(60000);              // Enough for about 5,000 wedges.
  const foliageData = new Float32Array(MAX_FOLIAGE_LOBES * 4);
  // The store is allocated once and refilled in place. Every light, every penumbra sample,
  // and the roof pass write through the same buffer, so a frame no longer asks the driver
  // for a few hundred fresh allocations.
  const gl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  gl.bindBuffer(gl.ARRAY_BUFFER, shadowBuf);
  gl.bufferData(gl.ARRAY_BUFFER, verts.byteLength, gl.DYNAMIC_DRAW);
  const uploadVerts = count => {
    gl.bindBuffer(gl.ARRAY_BUFFER, shadowBuf);
    if (gl2) gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts, 0, count);
    else gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts.subarray(0, count));
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  };

  const U = (p, n) => gl.getUniformLocation(p, n);
  // The canvas never resizes, and uniforms belong to the program rather than to the draw
  // call, so the resolution is uploaded once instead of a few hundred times per frame.
  for (const p of [litP, shadP, roofP]) { gl.useProgram(p); gl.uniform2f(U(p, 'u_res'), W, H); }
  return {
    litP, shadP, roofP, quad, shadowBuf, verts, uploadVerts,
    lit: { light: U(litP, 'u_light'), radius: U(litP, 'u_radius'),
           cam: U(litP, 'u_cam'), color: U(litP, 'u_color'), ang: U(litP, 'u_ang'),
           spread: U(litP, 'u_spread'), amount: U(litP, 'u_amount'), even: U(litP, 'u_even'),
           foliageCount: U(litP, 'u_foliageCount'), foliage: U(litP, 'u_foliage[0]') },
    foliageData
  };
} catch (e) { console.warn('WebGL lighting failed; using Canvas 2D:', e.message); gl = null; return null; } })();

quality.setRenderer(gl ? 'webgl' : 'canvas2d');

// Sorting by squared distance orders the clusters exactly as the true distance would,
// and the scratch list keeps one array allocation out of every light in the frame.
const foliageSort = [];
function buildFoliageData(occ, lightX, lightY, camx, camy, out) {
  out.fill(0);
  const foliage = foliageSort;
  foliage.length = 0;
  for (const o of occ) {
    if (!isFoliageOccluder(o)) continue;
    const ox = o.r !== undefined ? o.x : o.cx, oy = o.r !== undefined ? o.y : o.cy;
    const dx = ox - lightX, dy = oy - lightY;
    o.lightDist2 = dx * dx + dy * dy;
    foliage.push(o);
  }
  foliage.sort((a, b) => a.lightDist2 - b.lightDist2);
  let count = 0;
  for (const o of foliage) {
    const pad = o.r !== undefined ? o.r * .68 : o.hh * .75;
    forEachFoliageLobe(o, (x, y, r) => {
      if (count >= MAX_FOLIAGE_LOBES) return;
      const at = count++ * 4;
      out[at] = x - camx; out[at + 1] = y - camy; out[at + 2] = r; out[at + 3] = pad;
    });
    if (count >= MAX_FOLIAGE_LOBES) break;
  }
  return count;
}

// Opaque obstacle shadow wedges in screen coordinates, stored in a shared buffer.
function buildShadowVerts(occ, lx, ly, camx, camy, arr) {
  let n = 0;
  const push = (x1, y1, x2, y2, x3, y3, x4, y4) => {          // A quadrilateral as two triangles.
    arr[n++] = x1; arr[n++] = y1; arr[n++] = x2; arr[n++] = y2; arr[n++] = x3; arr[n++] = y3;
    arr[n++] = x1; arr[n++] = y1; arr[n++] = x3; arr[n++] = y3; arr[n++] = x4; arr[n++] = y4;
  };
  const circleShadow = (worldX, worldY, radius) => {
    const ox = worldX - camx, oy = worldY - camy;
    const dx = ox - lx, dy = oy - ly, d = len(dx, dy);
    if (d < radius || n > arr.length - 12) return;
    const px = -dy / d * radius, py = dx / d * radius;
    const ax = ox + px, ay = oy + py, bx = ox - px, by = oy - py;
    const da = len(ax - lx, ay - ly) || 1, db = len(bx - lx, by - ly) || 1;
    push(ax, ay, bx, by,
      bx + (bx - lx) / db * SHADOW_LEN, by + (by - ly) / db * SHADOW_LEN,
      ax + (ax - lx) / da * SHADOW_LEN, ay + (ay - ly) / da * SHADOW_LEN);
  };
  for (const o of occ) {
    if (o.r !== undefined) {                                   // Tree.
      circleShadow(o.x, o.y, o.r);
    } else {                                                   // House, hedge, or car.
      const pts = o.pts;
      for (let i = 0; i < 4; i++) {
        const ax = pts[i][0] - camx, ay = pts[i][1] - camy;
        const bx = pts[(i + 1) % 4][0] - camx, by = pts[(i + 1) % 4][1] - camy;
        if ((ax - lx) * (by - ay) + (ay - ly) * (ax - bx) <= 0) continue;   // Face points toward the light.
        const da = len(ax - lx, ay - ly) || 1, db = len(bx - lx, by - ly) || 1;
        push(ax, ay, bx, by,
             bx + (bx - lx) / db * SHADOW_LEN, by + (by - ly) / db * SHADOW_LEN,
             ax + (ax - lx) / da * SHADOW_LEN, ay + (ay - ly) / da * SHADOW_LEN);
      }
    }
    if (n > arr.length - 48) break;
  }
  return n;
}

function buildRoofVerts(houses, camx, camy, arr) {
  let n = 0;
  for (const h of houses) {
    if (h.cx + h.rad < camx || h.cy + h.rad < camy || h.cx - h.rad > camx + W || h.cy - h.rad > camy + H) continue;
    const a = h.pts[0], b = h.pts[1], c = h.pts[2], d = h.pts[3];
    for (const p of [a, b, c, a, c, d]) { arr[n++] = p[0] - camx; arr[n++] = p[1] - camy; }
    if (n > arr.length - 12) break;
  }
  return n;
}

function drawLightGL(g, camx, camy) {
  const R = GLR;
  const profile = quality.current;
  gl.viewport(0, 0, W, H);
  gl.disable(gl.SCISSOR_TEST);
  gl.clearColor(AMB[0], AMB[1], AMB[2], 1);
  gl.clearStencil(0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  gl.enable(gl.STENCIL_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);                        // Additive light blending.
  gl.enableVertexAttribArray(0);

  for (let li = 0; li < g.lit.length; li++) {
    const L = g.lit[li];
    const lx = L.x - camx, ly = L.y - camy, r = L.r;
    const bx = Math.max(0, Math.floor(lx - r)), by = Math.max(0, Math.floor(ly - r));
    const bw = Math.min(W, Math.ceil(lx + r)) - bx, bh = Math.min(H, Math.ceil(ly + r)) - by;
    if (bw <= 0 || bh <= 0) continue;                  // Source is off-screen.
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(bx, H - (by + bh), bw, bh);             // GL coordinates start at the bottom.

    const shadows = li < profile.shadowLights && !L.flat;
    const occ = shadows && r > 20 ? occNear(g, L.x, L.y, r, L.skip, profile.foliageShadows) : null;
    const foliageCount = profile.foliageShadows && occ
      ? buildFoliageData(occ, L.x, L.y, camx, camy, R.foliageData) : 0;
    const opaqueOcc = profile.foliageShadows && occ ? occ.filter(o => !isFoliageOccluder(o)) : occ;
    const wantedSamples = L.soft > 0 ? (L.soft < 6 ? 4 : 8) : 1;
    const n = shadows ? Math.min(wantedSamples, profile.shadowSamples) : 1;
    for (let s = 0; s < n; s++) {
      const a = s / n * 6.283, ox = Math.cos(a) * L.soft, oy = Math.sin(a) * L.soft;

      if (opaqueOcc && opaqueOcc.length) {             // 1) Solid shadows into the stencil buffer.
        const cnt = buildShadowVerts(opaqueOcc, lx + ox, ly + oy, camx, camy, R.verts);
        if (cnt) {
          gl.colorMask(false, false, false, false);
          gl.stencilFunc(gl.ALWAYS, 1, 0xff);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
          gl.useProgram(R.shadP);
          R.uploadVerts(cnt);
          gl.drawArrays(gl.TRIANGLES, 0, cnt / 2);
          gl.colorMask(true, true, true, true);
        }
      }

      gl.stencilFunc(gl.EQUAL, 0, 0xff);               // 2) Light where no shadow exists.
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      gl.useProgram(R.litP);
      gl.uniform2f(R.lit.light, lx, ly);
      gl.uniform1f(R.lit.radius, r);
      gl.uniform2f(R.lit.cam, camx, camy);
      gl.uniform3f(R.lit.color, L.rgb[0], L.rgb[1], L.rgb[2]);
      gl.uniform1f(R.lit.ang, L.ang);
      gl.uniform1f(R.lit.spread, L.spread);
      gl.uniform1f(R.lit.even, L.even || 0);
      gl.uniform1f(R.lit.amount, L.int / n);
      gl.uniform1f(R.lit.foliageCount, foliageCount);
      // With no leaf clusters the shader never reads the array, so it is not uploaded.
      if (foliageCount) gl.uniform4fv(R.lit.foliage, R.foliageData);
      gl.bindBuffer(gl.ARRAY_BUFFER, R.quad);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      if (s < n - 1) gl.clear(gl.STENCIL_BUFFER_BIT);  // Clear stencil for the next sample.
    }
    gl.clear(gl.STENCIL_BUFFER_BIT);
  }
  gl.disable(gl.SCISSOR_TEST);

  // One height pass overwrites every roof with ambient moonlight. This is cheaper
  // than testing roof height inside every headlight and prevents ground beams from
  // painting the top of a tall building.
  const roofCount = buildRoofVerts(g.houses, camx, camy, R.verts);
  if (roofCount) {
    gl.disable(gl.STENCIL_TEST); gl.disable(gl.BLEND);
    gl.useProgram(R.roofP);
    R.uploadVerts(roofCount);
    gl.drawArrays(gl.TRIANGLES, 0, roofCount / 2);
  }

  ctx.save();
  ctx.globalCompositeOperation = 'multiply';           // Multiply the town by the light map.
  ctx.drawImage(glCv, 0, 0);
  ctx.globalCompositeOperation = 'lighter';            // Add a little light-core glow.
  ctx.globalAlpha = .22;
  ctx.drawImage(glCv, 0, 0);
  ctx.restore();
}

return Object.freeze({ drawLight });
})();

