// Canvas 2D and WebGL lighting.
window.TownGame.lighting = (() => {
'use strict';

const { ctx, W, H, torchHand, gunHand } = window.TownGame.core;
const quality = window.TownGame.quality;
const { bodyPointWorld } = window.TownGame.carPhysics;
const legacyPerf = typeof URLSearchParams !== 'undefined' && typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('qa') === 'perf-legacy';

// ---------- lighting: every source casts its own shadows ----------
const lightCv = document.createElement('canvas');
lightCv.width = W; lightCv.height = H;
const lctx = lightCv.getContext('2d');
const tmpCv = document.createElement('canvas');       // Buffer for one light source.
tmpCv.width = tmpCv.height = 560;
const tctx = tmpCv.getContext('2d');

const RGB_LAMP = [1, .84, .55], RGB_HEAD = [1, .96, .82], RGB_WARM = [1, .96, .78];
const RGB_RED = [1, .25, .2], RGB_HAZARD = [1, .56, .16], RGB_BEACON_RED = [1, .16, .18];
const RGB_BEACON_BLUE = [.24, .38, 1], RGB_ROOF_RED = [1, .2, .24], RGB_ROOF_BLUE = [.3, .42, 1];
const RGB_MUZZLE = [1, .95, .75], RGB_FILTH = [.67, .8, .24], RGB_PARCEL = [1, .82, .35];
const RGB_AMMO = [.63, .82, 1], RGB_GOAL = [.47, .94, .47], RGB_ZOMBIE = [1, .27, .2];
const SHADOW_LEN = 2400;                              // Shadow wedges extend beyond the screen.

// Occluders near a point: houses, hedges, trees, and cars.
function occNear(g, x, y, r, skip) {
  const out = [];
  for (const s of g.solids) {
    const dx = s.cx - x, dy = s.cy - y, reach = r + s.rad;
    if (dx * dx + dy * dy < reach * reach) out.push(s);
  }
  for (const t of g.trees)
    if (Math.abs(t.x - x) < r + t.r && Math.abs(t.y - y) < r + t.r) out.push(t);
  for (const c of g.cars) {
    const dx = c.x - x, dy = c.y - y, reach = r + c.box.rad;
    if (c !== skip && dx * dx + dy * dy < reach * reach) out.push(c.body ? c.body.collider : c.box);
  }
  return out;
}

// Cut every obstacle shadow out of the light pool.
function castShadows(c, lx, ly, occ) {
  c.globalCompositeOperation = 'destination-out';
  c.fillStyle = '#000';
  for (const o of occ) {
    if (o.r !== undefined) {                          // Tree: wedge between tangents.
      const dx = o.x - lx, dy = o.y - ly, d = Math.hypot(dx, dy);
      if (d < o.r) continue;                          // Ignore a light source inside the crown.
      const px = -dy / d * o.r, py = dx / d * o.r;
      const ax = o.x + px, ay = o.y + py, bx = o.x - px, by = o.y - py;
      const da = Math.hypot(ax - lx, ay - ly) || 1, db = Math.hypot(bx - lx, by - ly) || 1;
      c.beginPath();                                  // The crown is lit while its shadow extends behind it.
      c.moveTo(ax, ay); c.lineTo(bx, by);
      c.lineTo(bx + (bx - lx) / db * SHADOW_LEN, by + (by - ly) / db * SHADOW_LEN);
      c.lineTo(ax + (ax - lx) / da * SHADOW_LEN, ay + (ay - ly) / da * SHADOW_LEN);
      c.closePath(); c.fill();
    } else {                                          // House, hedge, or car: wedges from far faces.
      const pts = o.pts;
      for (let i = 0; i < 4; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % 4];
        const nx = y2 - y1, ny = x1 - x2;             // Outward face normal.
        if ((x1 - lx) * nx + (y1 - ly) * ny <= 0) continue;   // A face looking at the light casts no shadow.
        const d1 = Math.hypot(x1 - lx, y1 - ly) || 1, d2 = Math.hypot(x2 - lx, y2 - ly) || 1;
        c.beginPath();
        c.moveTo(x1, y1); c.lineTo(x2, y2);
        c.lineTo(x2 + (x2 - lx) / d2 * SHADOW_LEN, y2 + (y2 - ly) / d2 * SHADOW_LEN);
        c.lineTo(x1 + (x1 - lx) / d1 * SHADOW_LEN, y1 + (y1 - ly) / d1 * SHADOW_LEN);
        c.closePath(); c.fill();
      }
    }
  }
  c.globalCompositeOperation = 'source-over';
}

// Draw one source into a buffer, subtract shadows, then apply it to color and darkness masks.
function paintLight(g, camx, camy, x, y, r, col, tint, punch, ang, spread, skip, shadows) {
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
  gr.addColorStop(0, col.replace('%a', 1));
  gr.addColorStop(.5, col.replace('%a', .55));
  gr.addColorStop(1, col.replace('%a', 0));
  tctx.fillStyle = gr; tctx.fillRect(x - r, y - r, r * 2, r * 2);
  tctx.restore();
  if (shadows && r > 20) castShadows(tctx, x, y, occNear(g, x, y, r, skip));
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
function paintLightDirect(camx, camy, x, y, r, col, tint, punch, ang, spread) {
  const sx = x - camx, sy = y - camy;
  const paint = (c, operation, alpha) => {
    c.save(); c.globalCompositeOperation = operation; c.globalAlpha = alpha;
    if (spread) {
      c.beginPath(); c.moveTo(sx, sy); c.arc(sx, sy, r, ang - spread, ang + spread);
      c.closePath(); c.clip();
    }
    const gr = c.createRadialGradient(sx, sy, 0, sx, sy, r);
    gr.addColorStop(0, col.replace('%a', 1));
    gr.addColorStop(.5, col.replace('%a', .55));
    gr.addColorStop(1, col.replace('%a', 0));
    c.fillStyle = gr; c.fillRect(sx - r, sy - r, r * 2, r * 2);
    c.restore();
  };
  paint(ctx, 'lighter', tint);
  paint(lctx, 'destination-out', punch);
}

// One light list keeps the GL and 2D paths consistent.
function collectLights(g, camx, camy) {
  const p = g.p, out = [];
  const add = (x, y, r, rgb, int, tint, punch, ang, spread, soft, priority = 1, skip) => {
    if (!legacyPerf && (x + r < camx || y + r < camy || x - r > camx + W || y - r > camy + H)) return;
    out.push({ x, y, r, rgb, int, tint, punch, ang: ang || 0, spread: spread || 0,
               soft: soft || 0, priority, skip });
  };

  for (const l of g.lamps) add(l.x, l.y, 120, RGB_LAMP, 1.15, .24, .95, 0, 0, 14, 1);
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
    if (!c.broken && lights.frontRight > .22)
      add(frontRight.x, frontRight.y, 172, RGB_HEAD, .62 * lights.frontRight, .1, .78, rightAngle + .03, .4, 5, 3, c);
    if (!c.broken && lights.frontLeft > .22)
      add(frontLeft.x, frontLeft.y, 172, RGB_HEAD, .62 * lights.frontLeft, .1, .78, leftAngle - .03, .4, 5, 3, c);

    const rearRight = bodyPointWorld(c, -22, 7), rearLeft = bodyPointWorld(c, -22, -7);
    const tailRgb = hazardOn ? RGB_HAZARD : RGB_RED;
    if ((!c.broken || hazardOn) && lights.rearRight > .22)
      add(rearRight.x, rearRight.y, hazardOn ? 43 : 30, tailRgb, (hazardOn ? .8 : .48) * lights.rearRight, .22, .55, 0, 0, 0, 1, c);
    if ((!c.broken || hazardOn) && lights.rearLeft > .22)
      add(rearLeft.x, rearLeft.y, hazardOn ? 43 : 30, tailRgb, (hazardOn ? .8 : .48) * lights.rearLeft, .22, .55, 0, 0, 0, 1, c);
    if (!c.police) continue;
    if (c.broken && c.hazard <= 0) continue;
    // Beacon: two rotating beams with an additional pulse.
    const b = c.beacon || 0, pulse = .55 + .45 * Math.sin(b * 3.1);
    const beaconPower = c.broken ? .55 : 1;
    add(c.x, c.y, 235, RGB_BEACON_RED, 1.5 * pulse * beaconPower, .3, .86, a + b, .5, 7, 3, c);
    add(c.x, c.y, 235, RGB_BEACON_BLUE, 1.5 * (1.55 - pulse) * beaconPower, .3, .86, a + b + Math.PI, .5, 7, 3, c);
    add(c.x, c.y, 52, RGB_ROOF_RED, .8 * pulse, .34, .5, 0, 0, 0, 1, c);      // Roof reflection.
    add(c.x, c.y, 52, RGB_ROOF_BLUE, .8 * (1.55 - pulse), .34, .5, 0, 0, 0, 1, c);
  }
  const lit = p.torch && p.batt > 0;
  if (lit) {                                                                             // Flashlight originates from the hand.
    const h = torchHand(p);
    add(h.x, h.y, 250 - 40 * g.weather.rain, RGB_WARM, 1.15 * p.flick, .18, .95, p.aim, .45, 6, 10);
  }
  add(p.x, p.y, lit ? 74 : 52, RGB_WARM, lit ? .5 : .3, .1, lit ? .8 : .6, 0, 0, 0, 9); // Pool around the feet.
  if (p.muzzle > 0) { const h = gunHand(p); add(h.x, h.y, 190, RGB_MUZZLE, 1.7, .5, 1, 0, 0, 16, 10); }
  for (const s of g.zombieShots) add(s.x, s.y, 23 + s.r, s.light || RGB_FILTH, .75, .28, .62, 0, 0, 0, 8);
  for (const b of g.parcels) if (!b.got) add(b.x, b.y, 46, RGB_PARCEL, .7, .24, .8, 0, 0, 0, 5);
  for (const a of g.ammoBoxes) add(a.x, a.y, 42, RGB_AMMO, .6, .22, .78, 0, 0, 0, 5);
  const near = g.got >= g.need;
  add(g.goal.x, g.goal.y, 76, RGB_GOAL, near ? 1 : .5, near ? .32 : .15, near ? .95 : .6, 0, 0, 0, 5);
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
    const shadows = i < profile.shadowLights;
    if (!legacyPerf && !shadows)
      paintLightDirect(camx, camy, l.x, l.y, l.r, col, l.tint, l.punch, l.ang, l.spread);
    else paintLight(g, camx, camy, l.x, l.y, l.r, col, l.tint, l.punch, l.ang, l.spread, l.skip, shadows);
  }
  ctx.drawImage(lightCv, 0, 0);
}

// ---------- WebGL: shadow volumes with multisample penumbra ----------
const glCv = document.createElement('canvas');
glCv.width = W; glCv.height = H;
const AMB = [.085, .105, .21];                        // Night multiplier for unlit pixels.
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
    uniform vec2 u_res, u_light; uniform float u_radius;
    varying mediump vec2 v_unit;                // -1..1 within the light pool.
    void main() {
      v_unit = a_pos * 2.0 - 1.0;
      vec2 p = u_light + v_unit * u_radius;
      gl_Position = ${TO_CLIP};
    }`, `
    precision mediump float;
    uniform vec3 u_color; uniform float u_ang, u_spread, u_amount;
    varying mediump vec2 v_unit;
    void main() {
      float f = max(0.0, 1.0 - length(v_unit));
      f *= f;                                   // Soft falloff toward the edge.
      if (u_spread > 0.0) {                     // Headlight and flashlight cone.
        float a = mod(atan(v_unit.y, v_unit.x) - u_ang + 9.42477796, 6.28318531) - 3.14159265;
        f *= 1.0 - smoothstep(u_spread * 0.55, u_spread, abs(a));
      }
      gl_FragColor = vec4(u_color * f * u_amount, 1.0);
    }`);

  const shadP = prog(`
    attribute vec2 a_pos; uniform vec2 u_res;
    void main() { vec2 p = a_pos; gl_Position = ${TO_CLIP}; }`, `
    precision mediump float;
    void main() { gl_FragColor = vec4(0.0); }`);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

  const shadowBuf = gl.createBuffer();
  const verts = new Float32Array(60000);              // Enough for about 5,000 wedges.

  const U = (p, n) => gl.getUniformLocation(p, n);
  return {
    litP, shadP, quad, shadowBuf, verts,
    lit: { res: U(litP, 'u_res'), light: U(litP, 'u_light'), radius: U(litP, 'u_radius'),
           color: U(litP, 'u_color'), ang: U(litP, 'u_ang'), spread: U(litP, 'u_spread'), amount: U(litP, 'u_amount') },
    shad: { res: U(shadP, 'u_res') }
  };
} catch (e) { console.warn('WebGL lighting failed; using Canvas 2D:', e.message); gl = null; return null; } })();

quality.setRenderer(gl ? 'webgl' : 'canvas2d');

// Obstacle shadow wedges in screen coordinates, stored in a shared buffer.
function buildShadowVerts(occ, lx, ly, camx, camy, arr) {
  let n = 0;
  const push = (x1, y1, x2, y2, x3, y3, x4, y4) => {          // A quadrilateral as two triangles.
    arr[n++] = x1; arr[n++] = y1; arr[n++] = x2; arr[n++] = y2; arr[n++] = x3; arr[n++] = y3;
    arr[n++] = x1; arr[n++] = y1; arr[n++] = x3; arr[n++] = y3; arr[n++] = x4; arr[n++] = y4;
  };
  for (const o of occ) {
    if (o.r !== undefined) {                                   // Tree.
      const ox = o.x - camx, oy = o.y - camy;
      const dx = ox - lx, dy = oy - ly, d = Math.hypot(dx, dy);
      if (d < o.r) continue;
      const px = -dy / d * o.r, py = dx / d * o.r;
      const ax = ox + px, ay = oy + py, bx = ox - px, by = oy - py;
      const da = Math.hypot(ax - lx, ay - ly) || 1, db = Math.hypot(bx - lx, by - ly) || 1;
      push(ax, ay, bx, by,
           bx + (bx - lx) / db * SHADOW_LEN, by + (by - ly) / db * SHADOW_LEN,
           ax + (ax - lx) / da * SHADOW_LEN, ay + (ay - ly) / da * SHADOW_LEN);
    } else {                                                   // House, hedge, or car.
      const pts = o.pts;
      for (let i = 0; i < 4; i++) {
        const ax = pts[i][0] - camx, ay = pts[i][1] - camy;
        const bx = pts[(i + 1) % 4][0] - camx, by = pts[(i + 1) % 4][1] - camy;
        if ((ax - lx) * (by - ay) + (ay - ly) * (ax - bx) <= 0) continue;   // Face points toward the light.
        const da = Math.hypot(ax - lx, ay - ly) || 1, db = Math.hypot(bx - lx, by - ly) || 1;
        push(ax, ay, bx, by,
             bx + (bx - lx) / db * SHADOW_LEN, by + (by - ly) / db * SHADOW_LEN,
             ax + (ax - lx) / da * SHADOW_LEN, ay + (ay - ly) / da * SHADOW_LEN);
      }
    }
    if (n > arr.length - 48) break;
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

    const shadows = li < profile.shadowLights;
    const occ = shadows && r > 20 ? occNear(g, L.x, L.y, r, L.skip) : null;
    const wantedSamples = L.soft > 0 ? (L.soft < 6 ? 4 : 8) : 1;
    const n = shadows ? Math.min(wantedSamples, profile.shadowSamples) : 1;
    for (let s = 0; s < n; s++) {
      const a = s / n * 6.283, ox = Math.cos(a) * L.soft, oy = Math.sin(a) * L.soft;

      if (occ && occ.length) {                         // 1) Shadows into the stencil buffer.
        const cnt = buildShadowVerts(occ, lx + ox, ly + oy, camx, camy, R.verts);
        if (cnt) {
          gl.colorMask(false, false, false, false);
          gl.stencilFunc(gl.ALWAYS, 1, 0xff);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
          gl.useProgram(R.shadP);
          gl.uniform2f(R.shad.res, W, H);
          gl.bindBuffer(gl.ARRAY_BUFFER, R.shadowBuf);
          gl.bufferData(gl.ARRAY_BUFFER, R.verts.subarray(0, cnt), gl.DYNAMIC_DRAW);
          gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
          gl.drawArrays(gl.TRIANGLES, 0, cnt / 2);
          gl.colorMask(true, true, true, true);
        }
      }

      gl.stencilFunc(gl.EQUAL, 0, 0xff);               // 2) Light where no shadow exists.
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      gl.useProgram(R.litP);
      gl.uniform2f(R.lit.res, W, H);
      gl.uniform2f(R.lit.light, lx, ly);
      gl.uniform1f(R.lit.radius, r);
      gl.uniform3f(R.lit.color, L.rgb[0], L.rgb[1], L.rgb[2]);
      gl.uniform1f(R.lit.ang, L.ang);
      gl.uniform1f(R.lit.spread, L.spread);
      gl.uniform1f(R.lit.amount, L.int / n);
      gl.bindBuffer(gl.ARRAY_BUFFER, R.quad);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      if (s < n - 1) gl.clear(gl.STENCIL_BUFFER_BIT);  // Clear stencil for the next sample.
    }
    gl.clear(gl.STENCIL_BUFFER_BIT);
  }
  gl.disable(gl.SCISSOR_TEST);

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

