// Characters, status gauges, and minimap.
window.TownGame.entities = (() => {
'use strict';

const { ctx, W, H, clamp, roundRect } = window.TownGame.core;
const {
  WORLD, ROAD, TORCH_BTN, ZOMBIE_BUILDS, BODY_GAIT, ZOMBIE_WARDROBE, BODY_SCALE, FLAME_BURN_MAX, PANIC_AT,
  COURIER_BUILD, CRAWL_CYCLE, ROOF_LIFT, COURIER_WARDROBE, HAND_T, HAND_G, CLIMB_TIME, TAKEDOWN_LOCK
} = window.TownGame.config;
const SND = window.TownGame.audio;
const quality = window.TownGame.quality;
const { FW, fogCv, fogAt } = window.TownGame.environment;

// Awareness arc above a zombie that has started to notice the courier but has not
// locked on yet. Without it stealth reads as random luck.
function drawNotice(c, z) {
  const S = z.size || 1, r = 15 * S, y = z.y - 21 * S;
  if (z.hunt > 0) {
    c.save();
    c.fillStyle = 'rgba(50,10,14,.88)'; c.strokeStyle = '#ff6b5a'; c.lineWidth = 2;
    c.beginPath(); c.arc(z.x, y, 8 * S, 0, 6.283); c.fill(); c.stroke();
    c.fillStyle = '#fff0df'; c.font = `bold ${Math.round(12 * S)}px Trebuchet MS, sans-serif`;
    c.textAlign = 'center'; c.fillText('!', z.x, y + 4 * S); c.restore();
    return;
  }
  if (z.notice <= .04) return;
  c.save();
  c.lineWidth = 2.6; c.lineCap = 'round';
  c.strokeStyle = 'rgba(12,16,24,.55)';
  c.beginPath(); c.arc(z.x, y, r, -2.35, -.79); c.stroke();
  c.strokeStyle = z.notice > .7 ? '#ff9a5a' : '#ffd766';
  c.beginPath(); c.arc(z.x, y, r, -2.35, -2.35 + 1.56 * z.notice); c.stroke();
  c.restore();
}

// ---------- the zombie model ----------
// A body the way a drone would see it at night, rather than a token with arms.
//
// Three things carry it at thirty pixels, and none of them is fine detail:
// - proportions measured off people (ZOMBIE_BUILDS), so the head is a third of the shoulders;
// - one light, fixed in the world, that the body turns under: the one every drop shadow in the town
//   already falls away from. Lit that way a body reads as a solid, not as a sticker being rotated;
// - feet that are put down on the street and stay there. The stride is driven by the distance the
//   body covered since the last frame, not by a clock, so nothing skates, and a shove is a stumble.
//
// What a body looks like comes from its own seed and never from Math.random: a draw must not move
// the simulation's random sequence, and both ends of a co-op session grow the same seeds, so both
// see the same crowd. What it is doing is read off the record the rules already keep, plus a little
// private memory per body — how fast it has been moving, where it is in its stride, how far its arms
// are up — kept in WeakMaps here that die with the body. None of it is district state and no rule
// ever reads it.

const TAU = Math.PI * 2;
// The light every drop shadow in the town falls away from: shadows go toward (+3, +8).
const LIGHT_X = -.351, LIGHT_Y = -.936, SHADOW_X = 3, SHADOW_Y = 8;
// Shoulder to fingertip. About three quarters of a real arm on purpose: at full length a reaching
// hand would end a body-length past the bite range, and the eye reads the hand as the threat.
const UPPER = 9.8, FORE = 8.6, PALM = 2.5, FINGER = 2.8;
const FAN = [-.3, -.1, .1, .3];
const WHITE = [255, 255, 255], BLACK = [0, 0, 0];

const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const rgbOf = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (a, k) => k >= 0 ? mix(a, WHITE, k) : mix(a, BLACK, -k);
const css = (a, alpha = 1) => alpha >= 1
  ? `rgb(${a[0] | 0},${a[1] | 0},${a[2] | 0})`
  : `rgba(${a[0] | 0},${a[1] | 0},${a[2] | 0},${alpha})`;
// Rim, face and ridge of one material. A limb is those three strokes laid side by side, which is
// what makes it read as round from above without a gradient per limb per frame.
const tone = rgb => ({ rgb, d: css(shade(rgb, -.3)), m: css(rgb), l: css(shade(rgb, .12)), dd: css(shade(rgb, -.6)) });

// mulberry32. Only the look of a body draws from it.
function seeded(seed) {
  let s = (Math.floor(seed * 4294967296) >>> 0) || 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = (t + Math.imul(t ^ t >>> 7, 61 | t)) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ---- shared paint ----
// Grime and weave for cloth and skin, and the dark bands of a flannel check. Alpha only, so one
// texture serves every colour. A pattern follows the transform it is filled under, which is what
// keeps the dirt on the body as it turns rather than sliding across it.
let grainPat = null, plaidPat = null;
function textures(c) {
  if (grainPat !== null) return grainPat;
  grainPat = plaidPat = false;
  if (typeof document === 'undefined' || typeof DOMMatrix === 'undefined') return false;
  const r = seeded(.2718), n = 48;
  const cv = document.createElement('canvas'); cv.width = cv.height = n;
  const g = cv.getContext('2d');
  for (let k = 0; k < 70; k++) {
    const x = r() * n, y = r() * n, rad = 2 + r() * 6;
    g.fillStyle = k % 3 ? `rgba(0,0,0,${.02 + r() * .05})` : `rgba(255,255,255,${.015 + r() * .03})`;
    // Drawn nine times over so the tile wraps without a seam.
    for (let ox = -n; ox <= n; ox += n) for (let oy = -n; oy <= n; oy += n) {
      g.beginPath(); g.arc(x + ox, y + oy, rad, 0, TAU); g.fill();
    }
  }
  const img = g.getImageData(0, 0, n, n), px = img.data;
  for (let i = 0; i < px.length; i += 4) if (r() < .25) {
    px[i] = px[i + 1] = px[i + 2] = 0;
    px[i + 3] = Math.min(255, px[i + 3] + 8 + r() * 18);
  }
  g.putImageData(img, 0, 0);
  const pl = document.createElement('canvas'); pl.width = pl.height = 10;
  const q = pl.getContext('2d');
  q.fillStyle = 'rgba(0,0,0,.26)'; q.fillRect(0, 0, 4, 10); q.fillRect(0, 0, 10, 4);
  q.fillStyle = 'rgba(0,0,0,.16)'; q.fillRect(6, 0, 1, 10); q.fillRect(0, 6, 10, 1);
  q.fillStyle = 'rgba(255,255,255,.1)'; q.fillRect(8, 0, 1, 10); q.fillRect(0, 8, 10, 1);
  grainPat = c.createPattern(cv, 'repeat');
  plaidPat = c.createPattern(pl, 'repeat');
  // Half a body pixel per texel: fine enough to read as weave when zoomed in, and at game scale
  // it averages out into mottling, which is what cloth looks like from a few metres up.
  const half = new DOMMatrix([.5, 0, 0, .5, 0, 0]);
  if (grainPat.setTransform) { grainPat.setTransform(half); plaidPat.setTransform(half); }
  return grainPat;
}

// Unit-radius gradients shared by every body. A gradient is read in whatever transform it is
// filled under, so one object serves every body at every size: the caller scales the unit circle
// to the part and turns it back to the world, and the lit side lands where the light is.
const grads = {};
function gradient(c, key) {
  if (grads[key]) return grads[key];
  let g;
  if (key === 'shadow') {
    g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, 'rgba(0,0,0,.36)'); g.addColorStop(.55, 'rgba(0,0,0,.22)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  } else {
    const head = key === 'head';
    g = c.createRadialGradient(LIGHT_X * .38, LIGHT_Y * .38, 0, 0, 0, 1);
    g.addColorStop(0, head ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.14)');
    g.addColorStop(.4, 'rgba(255,255,255,0)');
    g.addColorStop(.74, head ? 'rgba(0,0,0,.12)' : 'rgba(0,0,0,.14)');
    g.addColorStop(1, head ? 'rgba(0,0,0,.5)' : 'rgba(0,0,0,.4)');
  }
  return (grads[key] = g);
}

// ---- what a body looks like ----
const looks = new WeakMap();
// Everything a body looks like, drawn once from its seed. A head or an arm that comes off carries
// the same seed, kind and colours, so it comes out of the same wardrobe as the body it left.
function lookOf(src) {
  let L = looks.get(src);
  if (L) return L;
  const WD = ZOMBIE_WARDROBE;
  const kind = src.zkind || (ZOMBIE_BUILDS[src.kind] ? src.kind : 'walker');
  const B = ZOMBIE_BUILDS[kind] || ZOMBIE_BUILDS.walker;
  const seed = typeof src.seed === 'number' ? src.seed : .5;
  const r = seeded(seed);
  const from = list => list[(r() * list.length) | 0];
  const span = (a, b) => a + r() * (b - a);
  const sign = () => r() < .5 ? -1 : 1;
  const W = B.shoulder, hl = B.headLen, hw = B.headWid;

  const skin = shade(mix(rgbOf(src.skin || '#8fae63'), WD.deadGrey, B.pallor), span(-.08, .08));
  const garment = from(WD.garments[kind] || WD.garments.walker);
  const cloth = shade(mix(mix(rgbOf(src.clothes || '#5d6b4a'), rgbOf(from(WD.fabrics)), .2), WD.grime, .14),
    span(-.08, .1));
  const pants = shade(mix(rgbOf(from(WD.pants)), WD.grime, .2), span(-.08, .06));
  const shoe = rgbOf(kind === 'tank' ? WD.shoes[2] : from(WD.shoes));        // Riot boots are black.
  const hairdo = from(WD.hairdos[kind] || WD.hairdos.walker);
  const hair = hairdo === 'bald' ? null : shade(rgbOf(from(WD.hair)), span(-.1, .05));
  const limp = r() < B.limpShare ? span(B.limp[0], B.limp[1]) : 0;
  const limpSide = sign();
  const bare = kind !== 'tank' && r() < .16 ? sign() : 0;      // One shoe lost somewhere along the way.
  const drop = span(-.7, .7);                                   // One shoulder hangs lower than the other.

  // Marks on the torso, stored against the shoulder line so they ride along when the body leans.
  const onTorso = (u, v) => [u > 0 ? u * B.chest * .8 : u * B.back * .8, v * W * .82];
  const stains = [];
  for (let k = 0, n = 2 + (r() * 3 | 0); k < n; k++) {
    // The first one runs down from the collar: whatever they bled or drooled when they turned.
    const [x, y] = k ? onTorso(span(-.9, .7), span(-.85, .85)) : onTorso(span(.25, .8), span(-.35, .35));
    const rad = span(1.2, 3.4);
    stains.push({ x, y, rx: rad, ry: rad * span(.55, .95), a: span(0, TAU),
      c: r() < .72 ? css(WD.oldBlood, span(.3, .6)) : css(WD.grime, span(.25, .45)) });
  }
  const tears = [];
  for (let k = 0, n = r() * 2.6 | 0; k < n; k++) {
    const [x, y] = onTorso(span(-.8, .75), span(-.8, .8));
    const rad = span(.9, 2.1);
    tears.push({ x, y, rx: rad, ry: rad * span(.45, .8), a: span(0, TAU), wound: r() < .6 });
  }
  let bite = null;
  if (r() < .55) {                                              // Where it started: the shoulder.
    const [x, y] = onTorso(span(-.35, .25), sign() * span(.5, .66));
    bite = { x, y, r: span(1.4, 2) };
  }
  const folds = [];
  for (let k = 0; k < 3; k++) {
    const s = k === 2 ? sign() : k ? 1 : -1;
    folds.push([span(0, 1.4), s * W * span(.35, .6), -span(1.5, 3), s * W * span(.15, .4),
      -B.back * span(.55, .85), s * W * span(0, .25)]);
  }

  // The crown, where hair grows out from.
  const whorlX = -hl * .35, whorlY = span(-.6, .6);
  const strands = [];
  if (hair) for (let k = 0; k < 6; k++) {
    const a = span(-2.8, 2.8), len = span(2.2, 4.4), bend = span(-.5, .5);
    const ex = whorlX + Math.cos(a) * len, ey = whorlY + Math.sin(a) * len;
    const f = Math.min(1, .88 / Math.hypot(ex / hl, ey / hw));     // Keep the tip on the skull.
    strands.push([whorlX, whorlY, whorlX + Math.cos(a + bend) * len * .5, whorlY + Math.sin(a + bend) * len * .5,
      ex * f, ey * f]);
  }

  const reachArm = [span(.55, 1), span(.55, 1)];
  reachArm[r() < .5 ? 0 : 1] = 1;                               // One arm always leads the grab.

  L = {
    kind, build: B, seed, garment, hairdo, limp, limpSide, bare,
    sleeve: garment === 'vest' ? 0 : garment === 'tee' || garment === 'overalls' ? .55 : 1,
    wR: W - Math.max(0, drop) * .9, wL: W - Math.max(0, -drop) * .9,
    tilt: span(-1.1, 1.1), yaw0: span(-.25, .25), twitch: sign(), reachArm,
    stains, tears, bite, folds, strands,
    grain: [span(0, 24), span(0, 24)],
    tones: { skin: tone(skin), cloth: tone(cloth), pants: tone(pants), shoe: tone(shoe),
      hair: hair ? tone(hair) : null, vest: tone(WD.vest) },
    oldBlood: css(WD.oldBlood, .7), wound: css(shade(WD.flesh, -.2)), woundDark: css(shade(WD.flesh, -.55)),
    boneDirty: css(mix(WD.bone, WD.oldBlood, .35)),
    ichor: src.blood && src.blood[1] || '#568b27', ichorWet: src.blood && src.blood[0] || '#8bc83e'
  };
  looks.set(src, L);
  return L;
}

// A hit flashes a body the way the old token did; fire chars it for as long as it is alight.
function tonesOf(L, hit, burnt) {
  if (hit <= 0 && burnt <= 0) return L.tones;
  const WD = ZOMBIE_WARDROBE, t = L.tones;
  const f = x => {
    if (!x) return null;
    let c = x.rgb;
    if (burnt > 0) c = mix(c, WD.char, burnt);
    if (hit > 0) c = mix(c, WD.flash, hit * .75);
    return tone(c);
  };
  return { skin: f(t.skin), cloth: f(t.cloth), pants: f(t.pants), shoe: f(t.shoe), hair: f(t.hair), vest: f(t.vest) };
}

// ---- what a body is doing ----
const motions = new WeakMap();
const STRIDE = { run: 0, beta: 0, cycle: 0 };
// How far one stride carries a body of this build at `vn` px/s (world pixels, per unit of
// `size`), and the share of it a foot is down for. Past the build's reach a stride stops growing
// and the steps come quicker instead. `cycle` comes back in the body's own drawn pixels.
function strideAt(B, vn) {
  const G = BODY_GAIT;
  STRIDE.run = smooth(G.RUN_FROM, G.RUN_AT, vn);
  STRIDE.beta = G.STANCE_WALK + (G.STANCE_RUN - G.STANCE_WALK) * STRIDE.run;
  STRIDE.cycle = Math.min((G.CYCLE + G.CYCLE_PER_SPEED * vn) / BODY_SCALE, 2 * B.stride / STRIDE.beta);
  return STRIDE;
}

function motionOf(z, L) {
  const now = performance.now(), S = z.size || 1;
  let m = motions.get(z);
  if (!m) {
    m = { x: z.x, y: z.y, at: now, v: 0, phase: z.walk || 0, reach: 0, flail: 0, time: L.seed * 100 };
    motions.set(z, m);
    return m;
  }
  const gap = now - m.at;
  if (gap <= 0) return m;
  const dt = Math.min(.1, gap / 1000);
  const dx = z.x - m.x, dy = z.y - m.y, d = Math.sqrt(dx * dx + dy * dy);
  m.x = z.x; m.y = z.y; m.at = now; m.time += dt;
  const G = BODY_GAIT, ease = k => 1 - Math.exp(-dt / k);
  // A body that was off screen, or jumped further than it can walk in a frame — the bench, a
  // snapshot too far off to ease into — was put there. That is not a stride and not a speed.
  if (gap < 250 && d < 60 * S) {
    m.v += (d / dt - m.v) * ease(G.SPEED_EASE);
    const ca = Math.cos(z.ang), sa = Math.sin(z.ang);
    const fwd = dx * ca + dy * sa, side = Math.abs(dy * ca - dx * sa) * .6;
    m.phase += (fwd + (fwd < 0 ? -side : side)) / (strideAt(L.build, m.v / S).cycle * S * BODY_SCALE) * TAU;
  }
  // Arms come up for prey, halfway for something it has only half noticed, and grope blindly
  // once there is no head to aim them.
  let want = z.hunt > 0 ? 1 : smooth(.3, .9, z.notice || 0) * .55;
  if (z.headless) want = .75;
  m.reach += (want - m.reach) * ease(G.REACH_EASE);
  m.flail += ((z.burn > PANIC_AT && !z.dumb ? 1 : 0) - m.flail) * ease(G.FLAIL_EASE);
  return m;
}

// ---- drawing ----
function limb(c, x1, y1, x2, y2, w, tn, lx, ly, fine) {
  c.lineCap = 'round';
  c.strokeStyle = tn.d; c.lineWidth = w;
  c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
  // Offsets stop at the rim, so neither pass ever paints outside the limb it shades.
  const ox = lx * w * .12, oy = ly * w * .12;
  c.strokeStyle = tn.m; c.lineWidth = w * .62;
  c.beginPath(); c.moveTo(x1 + ox, y1 + oy); c.lineTo(x2 + ox, y2 + oy); c.stroke();
  if (!fine) return;                              // The ridge is the first thing to go on low.
  const hx = lx * w * .16, hy = ly * w * .16;
  c.strokeStyle = tn.l; c.lineWidth = w * .34;
  c.beginPath(); c.moveTo(x1 + hx, y1 + hy); c.lineTo(x2 + hx, y2 + hy); c.stroke();
}

function ellipse(c, x, y, rx, ry, a, fill) {
  c.fillStyle = fill;
  c.beginPath(); c.ellipse(x, y, rx, ry, a, 0, TAU); c.fill();
}

// Torn edges, wounds and stains are never ellipses. This is an ellipse whose radius wanders by the
// fixed pattern below, started at a different place for each mark so no two come out alike, and
// smoothed through the midpoints so the edge is ragged without being spiky.
const JAG = [1, .78, 1.12, .9, 1.06, .74, 1.15, .88, .82, 1.1, .95, .8];
function blob(c, x, y, rx, ry, a, from, fill) {
  const n = JAG.length, ca = Math.cos(a), sa = Math.sin(a);
  const px = i => { const k = JAG[(i + from) % n], t = i / n * TAU; return rx * k * Math.cos(t); };
  const py = i => { const k = JAG[(i + from) % n], t = i / n * TAU; return ry * k * Math.sin(t); };
  c.beginPath();
  for (let i = 0; i <= n; i++) {
    const x0 = px(i % n), y0 = py(i % n), x1 = px((i + 1) % n), y1 = py((i + 1) % n);
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const X = x + mx * ca - my * sa, Y = y + mx * sa + my * ca;
    if (i === 0) c.moveTo(X, Y);
    else c.quadraticCurveTo(x + x0 * ca - y0 * sa, y + x0 * sa + y0 * ca, X, Y);
  }
  c.closePath();
  c.fillStyle = fill; c.fill();
}

// Fills whatever path is current with a shared gradient, laid over the ellipse (x, y, rx, ry) and
// turned back by `ang`, the frame's total rotation in the world, so the lit side faces the light.
function lightPath(c, key, x, y, rx, ry, ang) {
  c.save();
  c.translate(x, y); c.scale(rx, ry); c.rotate(-ang);
  c.fillStyle = gradient(c, key); c.fill();
  c.restore();
}

const FEET = [{}, {}], ARMS = [{}, {}];

// Where the arm's joints are, from a pose given as angles: `al` swings it forward from hanging
// straight down, `ga` lifts it out to the side, `de` turns it in across the body, `E` bends the
// elbow, `droop` lets the wrist hang, and `up` bends the elbow up and back instead of forward, which
// is the cocked arm of a throw. The arm is solved in three dimensions and seen from above, so a
// hanging arm is a short blob at the shoulder and a reaching one is its full length.
function solveArm(A, s, jx, jy, al, ga, de, E, droop, up, len) {
  const ca = Math.cos(al), sa = Math.sin(al), cg = Math.cos(ga), sg = Math.sin(ga);
  let ux = sa, uy = s * ca * sg;
  const uz = -ca * cg;
  let ax = ca + (-.5 - ca) * up, ay = -s * .25 * sa * (1 - up), az = sa + (.87 - sa) * up;
  const d = ax * ux + ay * uy + az * uz;
  ax -= d * ux; ay -= d * uy;
  let bz = az - d * uz;
  const n = Math.sqrt(ax * ax + ay * ay + bz * bz) || 1;
  ax /= n; ay /= n; bz /= n;
  const cy = Math.cos(s * de), sy = -Math.sin(s * de);
  let t = ux * cy - uy * sy; uy = ux * sy + uy * cy; ux = t;
  t = ax * cy - ay * sy; ay = ax * sy + ay * cy; ax = t;
  const cE = Math.cos(E), sE = Math.sin(E);
  const wx = ux * cE + ax * sE, wy = uy * cE + ay * sE, wz = uz * cE + bz * sE;
  // The hand hangs off the wrist toward the ground by `droop`.
  let hx = wx, hy = wy;
  const px = wz * wx, py = wz * wy, pz = -1 + wz * wz, pn = Math.sqrt(px * px + py * py + pz * pz);
  if (pn > 1e-3) {
    const cd = Math.cos(droop), sd = Math.sin(droop);
    hx = wx * cd + px / pn * sd; hy = wy * cd + py / pn * sd;
  }
  const lu = UPPER * len, lf = FORE * len;
  A.jx = jx; A.jy = jy;
  A.ex = jx + ux * lu; A.ey = jy + uy * lu; A.ez = uz * lu;
  A.wx = A.ex + wx * lf; A.wy = A.ey + wy * lf;
  A.hx = hx; A.hy = hy;       // Not unit length: how much of the hand shows from above.
}

function drawArm(c, A, s, L, B, T, lx, ly, fine, close) {
  const k = B.limb, sleeve = L.sleeve;
  const px = A.wx + A.hx * PALM * k, py = A.wy + A.hy * PALM * k;
  // Furthest from the eye first. A hanging hand is under its own forearm, and the forearm is
  // under the upper arm. Fingers are drawn only close enough to be more than a pixel wide.
  if (close) {
    const fl = FINGER * k * (1 - .55 * A.curl), spread = 1.2 - .5 * A.curl;
    c.strokeStyle = T.skin.d; c.lineWidth = .95 * k; c.lineCap = 'round';
    c.beginPath();
    for (const a of FAN) {
      const cs = Math.cos(a * spread), sn = Math.sin(a * spread);
      c.moveTo(px, py);
      c.lineTo(px + (A.hx * cs - A.hy * sn) * fl, py + (A.hx * sn + A.hy * cs) * fl);
    }
    const ta = -s * 1.05, tc = Math.cos(ta), ts = Math.sin(ta);      // The thumb, on the inside.
    c.moveTo(A.wx + A.hx * .9 * k, A.wy + A.hy * .9 * k);
    c.lineTo(A.wx + (A.hx * (.9 + 2.2 * tc) - A.hy * 2.2 * ts) * k, A.wy + (A.hy * (.9 + 2.2 * tc) + A.hx * 2.2 * ts) * k);
    c.stroke();
  }
  limb(c, A.wx, A.wy, px, py, (close ? 3.1 : 3.6) * k, T.skin, lx, ly, fine);
  if (sleeve >= 1) {
    const fx = A.ex + (A.wx - A.ex) * .8, fy = A.ey + (A.wy - A.ey) * .8;   // The cuff.
    limb(c, fx, fy, A.wx, A.wy, 2.9 * k, T.skin, lx, ly, fine);
    limb(c, A.ex, A.ey, fx, fy, 3.9 * k, T.cloth, lx, ly, fine);
    limb(c, A.jx, A.jy, A.ex, A.ey, 4.6 * k, T.cloth, lx, ly, fine);
  } else {
    limb(c, A.ex, A.ey, A.wx, A.wy, 3.2 * k, T.skin, lx, ly, fine);
    limb(c, A.jx, A.jy, A.ex, A.ey, 4.1 * k, T.skin, lx, ly, fine);
    if (sleeve > 0) {
      const mx = A.jx + (A.ex - A.jx) * sleeve, my = A.jy + (A.ey - A.jy) * sleeve;
      limb(c, A.jx, A.jy, mx, my, 5 * k, T.cloth, lx, ly, fine);
    }
  }
}

// Where an arm was: the sleeve torn off round it, and what is inside.
function drawArmStump(c, x, y, L, T, k, fine) {
  blob(c, x, y, 2.5 * k, 2.8 * k, .3, 0, L.sleeve > 0 ? T.cloth.d : T.skin.d);
  blob(c, x + .2, y, 1.8 * k, 2 * k, .3, 5, L.woundDark);
  if (fine) {
    blob(c, x + .4, y + .3, 1.1 * k, .9 * k, .8, 3, L.wound);
    ellipse(c, x - .3 * k, y - .5 * k, .5 * k, .42 * k, 0, L.boneDirty);
    ellipse(c, x + .8 * k, y + .6 * k, .45 * k, .3 * k, .8, L.ichor);
  }
}

function drawLeg(c, f, L, B, T, lx, ly, fine, close, hipX) {
  const k = B.leg, grow = 1 + .08 * f.up;        // A lifted foot is nearer the eye.
  const fc = Math.cos(f.yaw), fs = Math.sin(f.yaw);
  const hy = f.s * B.stance * .85;
  const kx = (hipX + f.x) * .5 + 1.2 + 2.4 * f.up, ky = (hy + f.y) * .5;   // Knees bend forward.
  // A foot is a foot whatever the body on top of it: a bloated tank does not get longer shoes.
  // Seen from above, a foot pointing down at the street is a short one.
  const fk = Math.sqrt(k), pl = f.pitch, cx = f.x + fc * 2.7 * fk * pl, cy = f.y + fs * 2.7 * fk * pl;
  if (fine && f.up < .6)                          // Where the sole meets the street.
    ellipse(c, cx - lx * .6, cy - ly * .6, 5.6 * fk * pl, 2.3 * fk, f.yaw, `rgba(0,0,0,${.3 * (1 - f.up)})`);
  if (f.bare) {
    ellipse(c, cx - fc * .6, cy - fs * .6, 4.6 * fk * grow * pl, 1.75 * fk * grow, f.yaw, T.skin.m);
    if (close) {
      c.fillStyle = T.skin.d;
      for (let i = 0; i < 5; i++) {
        const o = (i - 2) * .7 * fk, a = (3.7 * fk - Math.abs(i - 1.5) * .3) * pl;
        c.beginPath(); c.arc(cx - fc * .6 + fc * a - fs * o, cy - fs * .6 + fs * a + fc * o, .42 * fk, 0, TAU); c.fill();
      }
    }
  } else {
    ellipse(c, cx, cy, 5.3 * fk * grow * pl, 1.95 * fk * grow, f.yaw, T.shoe.m);
    c.strokeStyle = T.shoe.dd; c.lineWidth = .5; c.stroke();
    if (close) {                                  // The instep catches the light.
      c.strokeStyle = T.shoe.l; c.lineWidth = .8 * fk; c.globalAlpha = .6;
      c.beginPath(); c.moveTo(f.x + fc * fk * pl, f.y + fs * fk * pl); c.lineTo(f.x + fc * 4 * fk * pl, f.y + fs * 4 * fk * pl); c.stroke();
      c.globalAlpha = 1;
    }
  }
  limb(c, f.x, f.y, kx, ky, 4.3 * k, T.pants, lx, ly, fine);
  limb(c, kx, ky, hipX, hy, 5.4 * k, T.pants, lx, ly, fine);
}

function torsoPath(c, L, B, xs) {
  const F = xs + B.chest, K = xs - B.back, r = L.wR, l = L.wL;
  c.beginPath(); c.moveTo(F, 0);
  c.bezierCurveTo(F, r * .5, xs + 2.8, r * .84, xs + 1.2, r * .98);
  c.bezierCurveTo(xs + .2, r * 1.06, xs - 1.8, r * 1.05, xs - 2.6, r * .9);      // Deltoid.
  c.bezierCurveTo(K + 1.4, r * .78, K, r * .46, K, 0);                            // Stooped back.
  c.bezierCurveTo(K, -l * .46, K + 1.4, -l * .78, xs - 2.6, -l * .9);
  c.bezierCurveTo(xs - 1.8, -l * 1.05, xs + .2, -l * 1.06, xs + 1.2, -l * .98);
  c.bezierCurveTo(xs + 2.8, -l * .84, F, -l * .5, F, 0);
  c.closePath();
}

// The layers of a torso that never move on it: cloth, dirt, old blood, tears, whatever is round
// the neck. Painted at shoulder line `xs`, without light, which goes over the top every frame.
function paintTorso(c, L, B, T, xs, tex) {
  const W = B.shoulder, K = xs - B.back, F = xs + B.chest, nx = xs + 1.3;
  torsoPath(c, L, B, xs);
  c.fillStyle = T.cloth.m; c.fill();
  c.save(); c.clip();                             // Everything painted on the torso stays inside it.
  if (tex) {
    c.save(); c.translate(L.grain[0], L.grain[1]);
    if (L.garment === 'flannel') { c.fillStyle = plaidPat; c.fill(); }
    c.fillStyle = grainPat; c.fill();
    c.restore();
  }
  L.stains.forEach((d, i) => blob(c, xs + d.x, d.y, d.rx, d.ry, d.a, i * 5, d.c));
  if (L.bite) blob(c, xs + L.bite.x, L.bite.y, L.bite.r * 2.2, L.bite.r * 1.7, .3, 3, L.oldBlood);
  c.globalAlpha = .5; c.strokeStyle = T.cloth.dd; c.lineWidth = .55;
  c.beginPath();
  for (const f of L.folds) { c.moveTo(xs + f[0], f[1]); c.quadraticCurveTo(xs + f[2], f[3], xs + f[4], f[5]); }
  c.stroke(); c.globalAlpha = 1;
  if (L.garment === 'vest') {                     // The back plate of a riot vest.
    c.fillStyle = T.vest.m;
    roundRect(c, K + .8, -W * .6, xs + .6 - K - .8, W * 1.2, 3.5); c.fill();
    c.strokeStyle = T.vest.dd; c.lineWidth = .6; c.stroke();
    c.strokeStyle = T.vest.d; c.lineWidth = .6; c.globalAlpha = .6;
    c.beginPath();
    for (let i = 0; i < 3; i++) { const x = K + 2 + i * 1.8; c.moveTo(x, -W * .48); c.lineTo(x, W * .48); }
    c.stroke(); c.globalAlpha = 1;
  } else if (L.garment === 'overalls') {
    c.strokeStyle = T.pants.m; c.lineWidth = 2.2; c.lineCap = 'butt';
    c.beginPath();
    for (let s = -1; s <= 1; s += 2) { c.moveTo(K + 1, s * W * .34); c.quadraticCurveTo(xs, s * W * .44, F - .8, s * W * .34); }
    c.stroke(); c.lineCap = 'round';
    c.fillStyle = '#b9b3a2';
    for (let s = -1; s <= 1; s += 2) c.fillRect(xs + 2.2, s * W * .34 - .7, 1.2, 1.4);
  }
  for (let i = 0; i < L.tears.length; i++) {
    const d = L.tears[i];
    blob(c, xs + d.x, d.y, d.rx, d.ry, d.a, i * 7 + 1, T.skin.d);
    if (d.wound) blob(c, xs + d.x, d.y, d.rx * .6, d.ry * .6, d.a, i * 7 + 4, L.wound);
    c.strokeStyle = T.cloth.d; c.lineWidth = .3;  // Frayed threads round the hole.
    c.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = k * 1.047 + d.a, ex = Math.cos(a), ey = Math.sin(a);
      c.moveTo(xs + d.x + ex * d.rx, d.y + ey * d.ry); c.lineTo(xs + d.x + ex * d.rx * 1.4, d.y + ey * d.ry * 1.4);
    }
    c.stroke();
  }
  if (L.bite) {                                   // Cloth torn away round the bite, and the bite.
    const b = L.bite, x = xs + b.x;
    blob(c, x, b.y, b.r, b.r * .75, .4, 6, T.cloth.dd);
    blob(c, x + .15, b.y, b.r * .7, b.r * .45, .5, 2, L.woundDark);
    blob(c, x - .2, b.y + .1, b.r * .4, b.r * .26, .3, 8, L.wound);
  }
  c.restore();
  // What sits round the neck.
  switch (L.garment) {
    case 'hoodie':                                // The hood, bunched behind the neck.
      ellipse(c, xs - 1.4, 0, 2.8, 4.6, 0, T.cloth.m);
      c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = .6; c.stroke();
      ellipse(c, xs - .6, 0, 1.3, 3.2, 0, T.cloth.dd);
      c.strokeStyle = 'rgba(210,205,190,.7)'; c.lineWidth = .45;
      c.beginPath(); c.moveTo(nx + 1, -1.3); c.lineTo(nx + 3.6, -1.7); c.moveTo(nx + 1, 1.3); c.lineTo(nx + 3.6, 1.7); c.stroke();
      break;
    case 'shirt': case 'flannel':
      c.strokeStyle = T.cloth.d; c.lineWidth = .8;
      c.beginPath(); c.ellipse(nx, 0, 2.4, 3, 0, 0, TAU); c.stroke();
      c.fillStyle = T.cloth.l;
      for (let s = -1; s <= 1; s += 2) {
        c.beginPath(); c.moveTo(nx - 1.2, s * 2.5); c.lineTo(nx + 2, s * 1.1); c.lineTo(nx + .5, s * 3.5); c.closePath(); c.fill();
      }
      break;
    case 'jacket':
      c.strokeStyle = T.cloth.d; c.lineWidth = 1.5;
      c.beginPath(); c.ellipse(nx, 0, 2.7, 3.3, 0, 0, TAU); c.stroke();
      break;
    case 'vest':
      c.strokeStyle = T.vest.dd; c.lineWidth = 1.2;
      c.beginPath(); c.ellipse(nx, 0, 2.8, 3.3, 0, 0, TAU); c.stroke();
      break;
    default:
      c.strokeStyle = T.cloth.d; c.lineWidth = .8;
      c.beginPath(); c.ellipse(nx, 0, 2.4, 3, 0, 0, TAU); c.stroke();
  }
}

// The layers of a head that never move on it: ears, skin, hair. Centred on the skull.
function paintHead(c, L, B, T, tex) {
  const hl = B.headLen, hw = B.headWid, hair = T.hair;
  for (let s = -1; s <= 1; s += 2) ellipse(c, -.4, s * hw * .95, 1.2, .8, s * .3, T.skin.d);
  if (L.hairdo === 'long' && hair) {              // Locks fall behind, over the collar.
    c.lineCap = 'round';
    c.beginPath();
    for (let s = -1; s <= 1; s += 2) { c.moveTo(-hl * .2, s * hw * .55); c.quadraticCurveTo(-hl * .9, s * hw * .98, -hl - 3, s * hw * .7); }
    c.moveTo(-hl * .4, 0); c.lineTo(-hl - 3.4, .3);
    c.strokeStyle = hair.d; c.lineWidth = 2.4; c.stroke();
    c.strokeStyle = hair.m; c.lineWidth = 1.2; c.stroke();
  }
  c.beginPath(); c.ellipse(-.2, 0, hl, hw, 0, 0, TAU);
  c.fillStyle = T.skin.m; c.fill();
  if (tex) { c.globalAlpha = .6; c.fillStyle = grainPat; c.fill(); c.globalAlpha = 1; }
  if (!hair) return;
  if (L.hairdo === 'balding') {
    c.globalAlpha = .8; c.strokeStyle = hair.m; c.lineWidth = 1.1;
    c.beginPath(); c.ellipse(-.2, 0, hl - .6, hw - .6, 0, Math.PI * .55, Math.PI * 1.45); c.stroke();
    c.globalAlpha = 1;
    return;
  }
  // A soft fringe first, then the hair itself: the edge of hair is never a line.
  c.globalAlpha = .45; ellipse(c, -.2 - hl * .1, 0, hl * .97, hw * 1.02, 0, hair.m); c.globalAlpha = 1;
  ellipse(c, -.2 - hl * .14, 0, hl * .86, hw * .93, 0, hair.m);
  // Matted, not combed: a few clumps catch the light and the rest lies flat.
  c.globalAlpha = .28; c.strokeStyle = hair.l; c.lineWidth = .7;
  c.beginPath();
  for (const s of L.strands) { c.moveTo(s[0], s[1]); c.quadraticCurveTo(s[2], s[3], s[4], s[5]); }
  c.stroke(); c.globalAlpha = 1;
}

// Everything that does not move on a body is painted once into a small canvas and stamped every
// frame; the light, the hit flash and the char of a fire change every frame and go over the stamp.
// A body then costs the same handful of calls however much it is wearing. A stamp covers the box
// (x0, y0, w, h) of the frame it is painted in, is painted at about 1.5 texels to every screen pixel
// it is first seen at, and is painted again finer only if it is later seen much closer, so the game
// pays for game scale and a close-up stays sharp. `ox` shifts where it lands without repainting it,
// which is how a torso leans without its stamp being painted again.
const TORSO_PAD = 3, HEAD_BACK = 4.5, HEAD_PAD = 2;
function stamp(c, L, key, ox, x0, y0, w, h, paint) {
  if (typeof document === 'undefined') { c.save(); c.translate(ox, 0); paint(c); c.restore(); return; }
  let D = 3;
  if (c.getTransform) {
    const m = c.getTransform();
    D = clamp(Math.pow(2, Math.ceil(Math.log2(Math.sqrt(m.a * m.a + m.b * m.b) * 1.5))), 2, 16);
  }
  const stamps = L.stamps || (L.stamps = {});
  let s = stamps[key];
  if (!s || s.D < D) {
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(w * D); cv.height = Math.ceil(h * D);
    const g = cv.getContext('2d');
    g.setTransform(D, 0, 0, D, -x0 * D, -y0 * D);
    paint(g);
    s = stamps[key] = { cv, D };
  }
  c.drawImage(s.cv, ox + x0, y0, w, h);
}

function tint(c, hit, burnt) {
  const WD = ZOMBIE_WARDROBE;
  if (burnt > 0) { c.fillStyle = css(WD.char, burnt); c.fill(); }
  if (hit > 0) { c.fillStyle = css(WD.flash, hit * .75); c.fill(); }
}

function drawTorso(c, z, L, B, T, xs, ang, hit, burnt) {
  const WD = ZOMBIE_WARDROBE, W = B.shoulder, K = xs - B.back;
  stamp(c, L, 'torso', xs, -B.back - TORSO_PAD, -W - TORSO_PAD, B.back + B.chest + 2 * TORSO_PAD, 2 * W + 2 * TORSO_PAD,
    g => paintTorso(g, L, B, L.tones, 0, textures(c)));
  torsoPath(c, L, B, xs);
  tint(c, hit, burnt);
  lightPath(c, 'torso', xs + (B.chest - B.back) * .5, 0, (B.chest + B.back) * .62, W * 1.12, ang);
  c.strokeStyle = 'rgba(0,0,0,.3)'; c.lineWidth = .6; c.stroke();
  if (L.garment === 'vest') {
    // Riot shoulder plates: the slab shoulders the tank has always had, which is what makes it
    // read as bulk at a glance rather than as a walker drawn larger. They stand proud of the
    // torso, so they take the light for themselves.
    for (let s = -1; s <= 1; s += 2) {
      const y = s * (s > 0 ? L.wR : L.wL) * .78;
      c.save(); c.translate(xs - 1.2, y); c.rotate(s * .12);
      roundRect(c, -3.8, -2.4, 7.6, 4.8, 2);
      c.fillStyle = T.vest.m; c.fill();
      lightPath(c, 'torso', 0, 0, 4.4, 3, ang + s * .12);
      c.strokeStyle = T.vest.dd; c.lineWidth = .6; c.stroke();
      c.restore();
    }
  }
  // A guard is a courier who did not make it: the same bag, across the back.
  if (z.guardParcel >= 0) {
    c.strokeStyle = '#4a3624'; c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(xs + 1.2, -L.wL * .7); c.lineTo(K + 2.4, L.wR * .62); c.stroke();
    c.save(); c.translate(K + 1.4, L.wR * .8); c.rotate(.25);
    c.fillStyle = WD.courierBag; roundRect(c, -3, -2.4, 6, 4.8, 1.2); c.fill();
    c.strokeStyle = 'rgba(0,0,0,.45)'; c.lineWidth = .6; c.stroke();
    c.fillStyle = 'rgba(255,255,255,.14)'; c.fillRect(-2.6, -2.1, 5.2, 1.5);
    c.restore();
  }
}

function drawNeckStump(c, x, L, T, B, fine) {
  const w = B.headWid;
  blob(c, x, 0, w * .66, w * .76, 0, 2, L.garment === 'vest' ? T.vest.d : T.cloth.d);
  blob(c, x + .2, 0, w * .52, w * .6, .2, 7, T.skin.d);
  blob(c, x + .3, .1, w * .4, w * .46, .2, 4, L.woundDark);
  if (fine) {
    blob(c, x + .6, .3, w * .24, w * .2, .6, 9, L.wound);
    ellipse(c, x - .6, 0, w * .12, w * .14, 0, L.boneDirty);      // The spine.
  }
}

// A head from above: the crown and the back of the skull, ears halfway back, the face turned down
// and away. `ang` is the head frame's rotation in the world, for the light.
function drawHead(c, L, B, ang, eye, hit, burnt) {
  const hl = B.headLen, hw = B.headWid;
  stamp(c, L, 'head', 0, -hl - HEAD_BACK, -hw - HEAD_PAD, 2 * hl + HEAD_BACK + 1.5, 2 * (hw + HEAD_PAD),
    g => paintHead(g, L, B, L.tones, textures(c)));
  c.beginPath(); c.ellipse(-.2, 0, hl, hw, 0, 0, TAU);
  tint(c, hit, burnt);
  lightPath(c, 'head', -.2, 0, hl * 1.05, hw * 1.05, ang);
  c.strokeStyle = 'rgba(0,0,0,.3)'; c.lineWidth = .5; c.stroke();
  // Eyeshine. From straight above an eye is hidden under the brow, but a flashlight finds it,
  // and the courier needs to see which way a head is pointing in the dark.
  if (eye) {
    c.fillStyle = eye;
    c.beginPath();
    c.moveTo(hl * .78 + .5, hw * .34); c.arc(hl * .78, hw * .34, .5, 0, TAU);
    c.moveTo(hl * .78 + .5, -hw * .34); c.arc(hl * .78, -hw * .34, .5, 0, TAU);
    c.fill();
  }
}

// Feet. A foot on the ground travels back under the body exactly as fast as the body goes forward,
// so it stays where it was put; a bad leg takes shorter steps, drags, swings out wide and gets less
// of the body's weight. Fills FEET and returns the sideways lurch over whichever foot is loaded.
function plantFeet(L, B, phase, st, move, hipX) {
  let sway = 0;
  for (let i = 0; i < 2; i++) {
    const s = i ? 1 : -1, f = FEET[i], bad = s === L.limpSide ? L.limp : 0;
    const b = clamp(st.beta - .08 * bad + .05 * (L.limp - bad), .3, .78);
    const R = Math.min(B.stride, b * st.cycle * .5) * move * (1 - .35 * bad);
    let u = (phase / TAU + i * .5) % 1;
    if (u < 0) u += 1;
    let x, arc = 0, load = 0, pitch;
    if (u < b) {
      x = R * (1 - 2 * u / b); load = Math.sin(Math.PI * u / b);
      pitch = 1 - .4 * smooth(.62, 1, u / b) * move;      // The heel comes up before the foot leaves.
    } else {
      const q = (u - b) / (1 - b), e = Math.pow(q, 1 + bad);
      x = R * (2 * e * e * (3 - 2 * e) - 1);
      arc = Math.sin(Math.PI * q) * move;
      pitch = 1 - .4 * (1 - smooth(0, .55, q)) * move * (1 - bad);   // A dragged foot stays flat.
    }
    f.s = s; f.R = R; f.rel = x; f.x = hipX + x;
    f.y = s * (B.stance + (.35 + 2.6 * bad) * arc);
    f.up = arc * (1 - .8 * bad); f.yaw = s * (.08 + .5 * bad); f.bare = L.bare === s; f.pitch = pitch;
    sway += s * load * (1 + 1.5 * bad);
  }
  return sway;
}

function drawZombie(c, z) {
  if (z.dodgeTime > 0 || z.surge > 0) {
    c.save(); c.translate(z.x, z.y); c.rotate(z.ang);
    c.globalAlpha = z.dodgeTime > 0 ? .65 : .4;
    c.strokeStyle = z.trail || '#a8cc79';
    c.lineWidth = 2; c.lineCap = 'round';
    for (let k = 0; k < 3; k++) {
      c.beginPath(); c.moveTo(-12 - k * 7, -6 + k * 6); c.lineTo(-24 - k * 7, -6 + k * 6); c.stroke();
    }
    c.restore();
  }
  const S = z.size || 1, L = lookOf(z), B = L.build, m = motionOf(z, L);
  const hit = z.hit > 0 ? Math.min(1, z.hit / .15) : 0;
  const burnt = z.burn > 0 ? Math.min(.7, z.burn / FLAME_BURN_MAX * 1.4) : 0;
  const T = tonesOf(L, hit, burnt);
  const fine = quality.current.key !== 'low';
  const vn = m.v / S, t = m.time, st = strideAt(B, vn), run = st.run;
  const move = smooth(3, 24, vn), hipX = -1.2;
  const ca = Math.cos(z.ang), sa = Math.sin(z.ang);

  let sway = plantFeet(L, B, m.phase, st, move, hipX);
  sway = sway * BODY_GAIT.SWAY * B.sway * (1 - .55 * run) * move
       + Math.sin(t * 1.3 + L.seed * 40) * .6 * (1 - move);           // Standing is not standing still.

  // Shoulders turn against the hips, and a throw winds the whole upper body up and lets it go.
  const Rn = Math.max(4, (FEET[0].R + FEET[1].R) * .5);
  let twist = .07 * (FEET[1].rel - FEET[0].rel) / Rn * move * (1 + .7 * run);
  const thrower = -(z.armOrder || 1);             // The arm that is lost last.
  let cock = 0, whip = 0;
  if (z.throwWind > 0 && z.shot && z.lostArms < 2 && !z.headless) {
    const q = clamp(1 - z.throwWind / z.shot.windup, 0, 1);
    cock = smooth(0, .6, q); whip = smooth(.8, 1, q);
    twist += thrower * (.4 * cock * (1 - whip) - .3 * whip);
  }
  twist += Math.sin(t * 13) * .22 * m.flail;
  // Every few seconds something misfires: the head jerks, an arm spasms.
  const twitch = Math.pow(Math.max(0, Math.sin(t * .77 + L.seed * 50) - .94) / .06, 2);

  // A round lands as a flinch in the direction it pushed.
  const kx = z.kx || 0, ky = z.ky || 0;
  const bx = clamp((kx * ca + ky * sa) * .014, -2.5, 2.5) / (S * BODY_SCALE) - (z.hit > 0 ? z.hit * 4 : 0);
  const by = clamp((ky * ca - kx * sa) * .014, -2.5, 2.5) / (S * BODY_SCALE);

  // The light, turned into the body's frame and then into the upper body's.
  const blx = LIGHT_X * ca + LIGHT_Y * sa, bly = LIGHT_Y * ca - LIGHT_X * sa;
  const ct = Math.cos(twist), stw = Math.sin(twist);
  const ulx = blx * ct + bly * stw, uly = bly * ct - blx * stw;

  const xs = B.shoulderX + 2.3 * run * B.lean;    // Running, the shoulders go out over the feet.
  const nx = xs + 1.3;
  const hx = nx + B.hunch * 2.4 + run * 1.2 * B.lean;
  const hy = L.tilt * (1 + .3 * move) + Math.sin(m.phase - 1.2) * .55 * move * (1 - .5 * run)
           + Math.sin(t * 17) * .5 * m.flail;
  const hyaw = -twist * .65 + L.yaw0 * (1 - m.reach) + twitch * .5 * L.twitch
             + Math.sin(t * .6 + L.seed * 9) * .12 * (1 - move) + Math.sin(t * 19) * .35 * m.flail;

  for (let i = 0; i < 2; i++) {
    const s = i ? 1 : -1, A = ARMS[i], f = FEET[i];
    A.jx = xs - .6; A.jy = s * ((s > 0 ? L.wR : L.wL) - 1.7);
    A.gone = z.lostArms >= 2 || (z.lostArms >= 1 && s === (z.armOrder || 1));
    if (A.gone) continue;
    const swing = -f.rel / Math.max(4, f.R) * move;       // Against the leg on the same side.
    // Limp: a dead arm swings a little, from the shoulder, and hardly bends until it runs.
    let al = .03 + .2 * swing * (1 + 1.2 * run) + Math.sin(t * 1.6 + s) * .05 * (1 - move);
    let ga = .14 + .05 * B.limb + .2 * run, de = 0, E = .12 + 1.2 * run, droop = .1, up = 0;
    const w = m.reach * L.reachArm[i] * B.reach;
    if (w > 0) {                                  // Reaching: arms up and out, wrists limp, clawing.
      const claw = Math.sin(m.phase * 2 + s * 1.7) * .1 * move + Math.sin(t * 2.7 + s * 2) * .07;
      al += (1 + claw - al) * w; ga += (-.05 - ga) * w; de += .24 * w;
      E += (.75 + .15 * Math.sin(t * 2.1 + s) - E) * w; droop += (.75 - droop) * w;
    }
    if (m.flail > 0) {                            // On fire: beating at it.
      const k = m.flail;
      al += (1.1 + .55 * Math.sin(t * 9 + s * 2) - al) * k; ga += (.6 + .4 * Math.sin(t * 7.3 + s) - ga) * k;
      E += (.9 + .6 * Math.sin(t * 11 + s) - E) * k; droop += (.2 - droop) * k;
    }
    if (s === thrower && cock > 0) {              // Wound back past the shoulder, then over and through.
      const k = cock * (1 - whip);
      al += (-.35 - al) * k; ga += (1.25 - ga) * k; E += (1.9 - E) * k; up = k; droop -= droop * k; de -= de * k;
      al += (1.5 - al) * whip; ga += (.1 - ga) * whip; de += (.3 - de) * whip; E += (.12 - E) * whip;
    }
    al += twitch * .25 * (i ? 1 : -.6);
    solveArm(A, s, A.jx, A.jy, al, ga, de, E, droop, up, B.armLen);
    A.curl = w > 0 ? .5 + .5 * Math.sin(t * 4 + s * 1.3) : .35;
    A.high = A.ez > -UPPER * B.armLen * .45;      // Above the chest: drawn over the torso.
  }

  c.save();
  c.translate(z.x, z.y);
  // A soft shadow, laid in the world's axes: the light does not turn with the body.
  c.save();
  const Sd = S * BODY_SCALE;
  c.translate(SHADOW_X * S * .7, SHADOW_Y * S * .7); c.rotate(z.ang);
  c.scale(Sd * B.shoulder * 1.45 * .72, Sd * B.shoulder * 1.45);
  c.fillStyle = gradient(c, 'shadow');
  c.beginPath(); c.arc(0, 0, 1, 0, TAU); c.fill();
  c.restore();

  c.rotate(z.ang);
  c.scale(Sd, Sd);
  let close = fine;
  if (fine && c.getTransform) {                   // Fingers and laces only past 1.6 px per body pixel.
    const tm = c.getTransform();
    close = tm.a * tm.a + tm.b * tm.b >= 2.56;
  }
  // Raised arms throw their own shadow on the street, further out than the body's because they are
  // higher up. It is what makes a reaching arm read as held up rather than lying flat.
  const sox = (SHADOW_X * ca + SHADOW_Y * sa) / Sd, soy = (SHADOW_Y * ca - SHADOW_X * sa) / Sd;
  c.strokeStyle = 'rgba(0,0,0,.16)'; c.lineCap = 'round'; c.lineWidth = 3.6 * B.limb;
  c.beginPath();
  for (let i = 0; i < 2; i++) {
    const A = ARMS[i];
    if (A.gone || !A.high) continue;
    c.moveTo(A.jx + sox * 1.1, A.jy + sway + soy * 1.1);
    c.lineTo(A.ex + sox * 1.3, A.ey + sway + soy * 1.3);
    c.lineTo(A.wx + sox * 1.3, A.wy + sway + soy * 1.3);
  }
  c.stroke();
  const first = FEET[0].up <= FEET[1].up ? 0 : 1;          // The lifted foot passes over the planted one.
  drawLeg(c, FEET[first], L, B, T, blx, bly, fine, close, hipX);
  drawLeg(c, FEET[1 - first], L, B, T, blx, bly, fine, close, hipX);

  c.save();
  c.translate(bx, sway + by);
  c.translate(hipX, 0); c.rotate(twist); c.translate(-hipX, 0);
  for (let i = 0; i < 2; i++) if (!ARMS[i].gone && !ARMS[i].high) drawArm(c, ARMS[i], i ? 1 : -1, L, B, T, ulx, uly, fine, close);
  drawTorso(c, z, L, B, T, xs, z.ang + twist, hit, burnt);
  if (z.headless) drawNeckStump(c, nx + .2, L, T, B, fine);
  else ellipse(c, nx, hy * .35, B.headWid * .55, B.headWid * .62, 0, T.skin.d);
  for (let i = 0; i < 2; i++) if (ARMS[i].gone) drawArmStump(c, ARMS[i].jx, ARMS[i].jy, L, T, B.limb, fine);
  for (let i = 0; i < 2; i++) {
    const A = ARMS[i];
    if (A.gone || !A.high) continue;
    drawArm(c, A, i ? 1 : -1, L, B, T, ulx, uly, fine, close);
  }
  if (cock > 0) {                                 // What it is about to throw, in the throwing hand.
    const A = ARMS[thrower > 0 ? 1 : 0], pulse = .9 + Math.sin(z.throwWind * 24) * .1;
    const r = clamp(z.shot.radius * .4, 2.2, 3.6) * pulse;
    const px = A.wx + A.hx * PALM * B.limb, py = A.wy + A.hy * PALM * B.limb;
    c.fillStyle = z.shot.held; c.strokeStyle = z.shot.heldEdge; c.lineWidth = .9;
    c.beginPath(); c.arc(px, py, r, 0, TAU); c.fill(); c.stroke();
  }
  if (!z.headless) {
    // The head shades the shoulders under it.
    ellipse(c, hx - ulx * 1.6, hy - uly * 1.6, B.headLen * 1.05, B.headWid * 1.05, hyaw, 'rgba(0,0,0,.22)');
    c.save();
    c.translate(hx, hy); c.rotate(hyaw);
    drawHead(c, L, B, z.ang + twist + hyaw, z.eye || '#ff5a45', hit, burnt);
    c.restore();
  }
  c.restore();
  c.restore();
  if (z.hit > 0 && z.hp > 0 && z.maxHp > 1) {
    const w = 24 * S, top = z.y - 24 * S;
    c.fillStyle = 'rgba(10,14,24,.75)'; c.fillRect(z.x - w / 2, top, w, 4);
    c.fillStyle = z.mapColor || '#9fd36a'; c.fillRect(z.x - w / 2 + 1, top + 1, (w - 2) * z.hp / z.maxHp, 2);
  }
}

// ---- what comes off ----
// Drawn in the part's own frame: the caller has already moved, turned and scaled to it, including
// BODY_SCALE, so a head on the street is the size it was on the shoulders.
function drawLooseArm(c, part) {
  const L = lookOf(part), B = L.build, fine = quality.current.key !== 'low';
  const a = part.ang || 0, lx = LIGHT_X * Math.cos(a) + LIGHT_Y * Math.sin(a), ly = LIGHT_Y * Math.cos(a) - LIGHT_X * Math.sin(a);
  // Lying flat, the arm shows its whole length: shoulder end back, hand forward.
  const A = { jx: -10.5, jy: 0, ex: -1, ey: .6, wx: 7.6, wy: .2, hx: .96, hy: .18, curl: .7 };
  drawArm(c, A, 1, L, B, L.tones, lx, ly, fine, fine);
  drawArmStump(c, -10.9, 0, L, L.tones, B.limb * .9, fine);
}

function drawLooseHead(c, part) {
  const L = lookOf(part), B = L.build, fine = quality.current.key !== 'low';
  const w = B.headWid;                            // The neck it came off, behind the skull.
  blob(c, -B.headLen * .75, 0, w * .5, w * .6, 0, 3, L.woundDark);
  blob(c, -B.headLen * .85, .2, w * .3, w * .34, .4, 8, L.wound);
  ellipse(c, -B.headLen * .95, 0, w * .12, w * .14, 0, L.boneDirty);
  drawHead(c, L, B, part.ang || 0, part.eye, 0, 0);
}

// The size of a head that came off, for whatever is drawn over it.
const looseHeadSize = part => lookOf(part).build;

function nearestParcel(g, p) {
  let bestP = null, bd = 1e9;
  for (const b of g.parcels) {
    if (b.state !== 'ground') continue;
    const dx = b.x - p.x, dy = b.y - p.y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; bestP = b; }
  }
  return bestP;
}

// The nearest door the courier is currently carrying something for. A parcel on the back
// outranks one still lying in a yard: it is already committed work.
function nearestDrop(g, p) {
  let best = null, bd = 1e9;
  for (const b of g.parcels) {
    if (b.state !== 'carried' || (b.carrier >= 0 && b.carrier !== p.id)) continue;
    const dx = b.dest.x - p.x, dy = b.dest.y - p.y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = b.dest; }
  }
  return best;
}

// ---------- the courier ----------
// The one living person in the district, drawn by the same model as the dead: the same light, the
// same measured proportions, feet planted by the distance covered. What the rules read off the
// picture stays where it was. The lens of the flashlight sits on HAND_T and the pistol's muzzle on
// HAND_G, because the beam and the rounds come from there; the bill of the cap says which way the
// courier faces; the boxes on the backpack say how many parcels are carried.
//
// The torso always faces the aim, as the beam and the gun do. The hips face where the courier is
// going, as far as a waist turns, and past that the legs walk backwards: strafing is a turned
// pelvis and a side step, backing away is backing away.

const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };

function courierLook(p) {
  let L = looks.get(p);
  if (L) return L;
  const WD = COURIER_WARDROBE, B = COURIER_BUILD, id = Math.max(0, p.id | 0);
  const pick = list => list[id % list.length];
  const cap = rgbOf(pick(WD.cap));
  L = {
    build: B, seed: .31 + id * .27, garment: 'jacket', sleeve: 1, limp: 0, limpSide: 1, bare: 0,
    wR: B.shoulder, wL: B.shoulder, grain: [5 + id * 7, 11 - id * 3], stamps: {},
    // Lying down, the same torso is seen along its length: shoulders to hips, not chest to back.
    prone: Object.freeze(Object.assign({}, B, { chest: 1.8, back: 15 })),
    tones: {
      skin: tone(rgbOf(pick(WD.skin))), hair: tone(rgbOf(pick(WD.hair))), cloth: tone(rgbOf(WD.jacket)),
      pants: tone(rgbOf(WD.pants)), shoe: tone(rgbOf(WD.shoe)), cap: tone(cap), bill: tone(shade(cap, -.2)),
      stripe: tone(rgbOf(WD.stripe)), pack: tone(rgbOf(WD.pack)), parcel: tone(rgbOf(WD.parcel)),
      torch: tone(rgbOf(WD.torch)), gun: tone(rgbOf(WD.gun)), flamer: tone(rgbOf(WD.flamer))
    }
  };
  looks.set(p, L);
  return L;
}

function courierMotion(p, L, prone) {
  const now = performance.now();
  let m = motions.get(p);
  if (!m) {
    m = { x: p.x, y: p.y, at: now, v: 0, phase: 0, time: L.seed * 100, hip: 0 };
    motions.set(p, m);
    return m;
  }
  const gap = now - m.at;
  if (gap <= 0) return m;
  const dt = Math.min(.1, gap / 1000);
  const dx = p.x - m.x, dy = p.y - m.y, d = Math.sqrt(dx * dx + dy * dy);
  m.x = p.x; m.y = p.y; m.at = now; m.time += dt;
  const ease = k => 1 - Math.exp(-dt / k);
  // A sprint is four pixels a frame. Anything much past that was put there — off the top of a
  // ladder, into a new district — and is not a stride.
  if (gap < 250 && d < 24) {
    m.v += (d / dt - m.v) * ease(BODY_GAIT.SPEED_EASE);
    let want = 0;
    if (!prone && m.v > 8 && d > 1e-3) {
      const rel = angDiff(Math.atan2(dy, dx), p.aim);
      want = Math.abs(rel) <= 1.95 ? clamp(rel, -1.05, 1.05) : clamp(angDiff(rel + Math.PI, 0), -.9, .9);
    }
    m.hip += (want - m.hip) * ease(.12);
    const ha = p.aim + m.hip, ca = Math.cos(ha), sa = Math.sin(ha);
    const fwd = dx * ca + dy * sa, side = Math.abs(dy * ca - dx * sa) * .6;
    const cycle = prone ? CRAWL_CYCLE : strideAt(L.build, m.v).cycle * BODY_SCALE;
    m.phase += (fwd + (fwd < 0 ? -side : side)) / cycle * TAU;
  } else m.v = 0;
  return m;
}

// Two bones from the shoulder to a hand that has to be at (tx, ty), `tz` above or below the
// shoulder. The elbow falls toward the pole: nearly straight down for something held out in front,
// which keeps it in under the shoulder rather than jutting out; out to the side for elbows on the
// ground.
function reachArm(A, s, jx, jy, tx, ty, tz, len, poleY, poleZ, poleX = 0) {
  const a = UPPER * len, b = FORE * len;
  let dx = tx - jx, dy = ty - jy, dz = tz;
  let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const far = (a + b) * .998;
  if (d > far) { const k = far / d; dx *= k; dy *= k; dz *= k; d = far; }
  d = Math.max(d, .01);
  const ux = dx / d, uy = dy / d, uz = dz / d;
  const ca = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1), sa = Math.sqrt(1 - ca * ca);
  let px = poleX, py = s * poleY, pz = poleZ;
  const pd = px * ux + py * uy + pz * uz;
  px -= pd * ux; py -= pd * uy; pz -= pd * uz;
  const pn = Math.sqrt(px * px + py * py + pz * pz) || 1;
  A.jx = jx; A.jy = jy;
  A.ex = jx + (ux * ca + px / pn * sa) * a; A.ey = jy + (uy * ca + py / pn * sa) * a;
  A.ez = (uz * ca + pz / pn * sa) * a;
  A.wx = jx + dx; A.wy = jy + dy;
  A.hx = .88; A.hy = 0; A.curl = 1;             // A fist round whatever it holds, pointing ahead.
}

function paintCourierTorso(c, L, B, T, prone, tex) {
  const W = B.shoulder, K = -B.back, F = B.chest, nx = 1.3;
  torsoPath(c, L, B, 0);
  c.fillStyle = T.cloth.m; c.fill();
  c.save(); c.clip();
  if (tex) { c.save(); c.translate(L.grain[0], L.grain[1]); c.fillStyle = grainPat; c.fill(); c.restore(); }
  // Reflective strips over each shoulder and down the back, the part of a courier's jacket that
  // a headlight finds first.
  c.strokeStyle = T.stripe.m; c.lineWidth = 1.2; c.lineCap = 'butt';
  c.beginPath();
  for (let s = -1; s <= 1; s += 2) { c.moveTo(F + 1, s * W * .52); c.lineTo(K - 1, s * W * (prone ? .4 : .52)); }
  c.stroke();
  c.strokeStyle = T.cloth.dd; c.lineWidth = .4;        // The zip.
  c.beginPath(); c.moveTo(nx + 2, 0); c.lineTo(F + 1, .2); c.stroke();
  c.restore();
  c.lineCap = 'round';
  c.strokeStyle = T.cloth.d; c.lineWidth = 1.3;       // Stand collar.
  c.beginPath(); c.ellipse(nx, 0, 2.6, 3.2, 0, 0, TAU); c.stroke();
  // The delivery backpack: a box on the back, lid seam, the firm's patch, straps over the shoulders.
  const [x0, x1] = packSpan(B, prone);
  roundRect(c, x0, -W * .62, x1 - x0, W * 1.24, 1.3);
  c.fillStyle = T.pack.m; c.fill();
  c.strokeStyle = T.pack.dd; c.lineWidth = .5; c.stroke();
  roundRect(c, x0 + .8, -W * .62 + .8, x1 - x0 - 1.6, W * 1.24 - 1.6, .8);
  c.strokeStyle = T.pack.d; c.lineWidth = .4; c.stroke();
  c.fillStyle = COURIER_WARDROBE.logo;
  roundRect(c, (x0 + x1) / 2 - 1.6, -1, 3.2, 2, .5); c.fill();
  c.strokeStyle = T.pack.dd; c.lineWidth = 1.2;
  c.beginPath();
  for (let s = -1; s <= 1; s += 2) { c.moveTo(x1, s * W * .42); c.lineTo(prone ? 1.2 : 2.6, s * W * .34); }
  c.stroke();
}
// Where the backpack sits along the body, relative to the shoulder line.
const packSpan = (B, prone) => prone ? [-B.back + 3, -2.2] : [-B.back - 2.2, -.6];

function paintCourierHead(c, L, B, T, tex) {
  const hl = B.headLen, hw = B.headWid;
  for (let s = -1; s <= 1; s += 2) ellipse(c, -.4, s * hw * .95, 1.2, .8, s * .3, T.skin.d);
  c.beginPath(); c.ellipse(-.2, 0, hl, hw, 0, 0, TAU);
  c.fillStyle = T.skin.m; c.fill();
  if (tex) { c.globalAlpha = .5; c.fillStyle = grainPat; c.fill(); c.globalAlpha = 1; }
  ellipse(c, -.2 - hl * .18, 0, hl * .86, hw * .97, 0, T.hair.m);   // What shows under the cap.
  ellipse(c, .1, 0, hl * .84, hw * .9, 0, T.cap.m);                 // The crown.
  c.globalAlpha = .45; c.strokeStyle = T.cap.dd; c.lineWidth = .3;  // Panel seams to the button.
  c.beginPath();
  for (const a of [.8, -.8, 2.3, -2.3]) {
    c.moveTo(-.3, 0); c.lineTo(-.3 + Math.cos(a) * hl * .82, Math.sin(a) * hw * .86);
  }
  c.stroke(); c.globalAlpha = 1;
  ellipse(c, -.3, 0, .5, .5, 0, T.cap.d);
  // The bill: the one part of a head from above that says which way it looks.
  c.beginPath();
  c.moveTo(hl * .55, -hw * .86);
  c.quadraticCurveTo(hl + 3.6, -hw * .78, hl + 3.8, 0);
  c.quadraticCurveTo(hl + 3.6, hw * .78, hl * .55, hw * .86);
  c.closePath();
  c.fillStyle = T.bill.m; c.fill();
  c.strokeStyle = T.bill.dd; c.lineWidth = .4; c.stroke();
  c.strokeStyle = T.bill.l; c.lineWidth = .3;
  c.beginPath(); c.moveTo(hl * .7, -hw * .7); c.quadraticCurveTo(hl + 2.9, -hw * .62, hl + 3.1, 0);
  c.quadraticCurveTo(hl + 2.9, hw * .62, hl * .7, hw * .7); c.stroke();
}

function drawCourierHead(c, L, B, T, ang) {
  const hl = B.headLen, hw = B.headWid;
  stamp(c, L, 'head', 0, -hl - 2, -hw - HEAD_PAD, 2 * hl + 6.5, 2 * (hw + HEAD_PAD),
    g => paintCourierHead(g, L, B, L.tones, textures(c)));
  c.beginPath(); c.ellipse(-.2, 0, hl, hw, 0, 0, TAU);
  lightPath(c, 'head', -.2, 0, hl * 1.05, hw * 1.05, ang);
  c.strokeStyle = 'rgba(0,0,0,.3)'; c.lineWidth = .5; c.stroke();
}

function drawCourierTorso(c, L, B, T, xs, ang, prone, carried) {
  const W = B.shoulder, key = prone ? 'prone' : 'torso';
  stamp(c, L, key, xs, -B.back - TORSO_PAD, -W - TORSO_PAD, B.back + B.chest + 2 * TORSO_PAD, 2 * W + 2 * TORSO_PAD,
    g => paintCourierTorso(g, L, B, L.tones, prone, textures(c)));
  torsoPath(c, L, B, xs);
  lightPath(c, 'torso', xs + (B.chest - B.back) * .5, 0, (B.chest + B.back) * .62, W * 1.12, ang);
  c.strokeStyle = 'rgba(0,0,0,.3)'; c.lineWidth = .6; c.stroke();
  // The backpack stands proud of the back, so it takes the light for itself.
  const [x0, x1] = packSpan(B, prone), ph = W * 1.24;
  roundRect(c, xs + x0, -ph / 2, x1 - x0, ph, 1.3);
  lightPath(c, 'torso', xs + (x0 + x1) / 2, 0, (x1 - x0) * .7, ph * .7, ang);
  // Parcels ride on top of it: one sits centred, two sit side by side. The count is readable at
  // a glance, which is the whole point of putting them on the figure rather than only in the HUD.
  const n = Math.min(carried | 0, 2), len = x1 - x0;
  for (let i = 0; i < n; i++) {
    const oy = n === 1 ? 0 : (i ? 1 : -1) * ph * .25, bw = len * (n === 1 ? .78 : .72), bh = ph * (n === 1 ? .62 : .44);
    c.save();
    c.translate(xs + (x0 + x1) / 2, oy); c.rotate(i ? .07 : -.05);
    roundRect(c, -bw / 2, -bh / 2, bw, bh, .6);
    c.fillStyle = T.parcel.m; c.fill();
    lightPath(c, 'torso', 0, 0, bw * .75, bh * .75, ang + (i ? .07 : -.05));
    c.strokeStyle = T.parcel.dd; c.lineWidth = .45; c.stroke();
    c.fillStyle = COURIER_WARDROBE.tape; c.fillRect(-bw / 2, -.45, bw, .9);
    c.fillStyle = COURIER_WARDROBE.label; c.fillRect(bw * .1, -bh * .4, bw * .28, bh * .24);
    c.restore();
  }
}

// What is in each hand, laid along the aim from the fist. The fist is drawn over it afterwards.
const TORCH_LENS = 3.35;                          // From the fist to the glass.
function drawHeld(c, A, what, T, p, lx, ly, fine) {
  const x = A.wx, y = A.wy;
  if (what === 'torch') {
    limb(c, x - 1, y, x + 2.4, y, 2.1, T.torch, lx, ly, fine);
    limb(c, x + 2.2, y, x + 3.1, y, 2.8, T.torch, lx, ly, fine);           // The head, wider.
    const lit = p.torch && p.batt > 0;
    ellipse(c, x + TORCH_LENS, y, .4, 1.15, 0, lit ? `rgba(255,242,200,${.5 + .5 * p.flick})` : '#3c434b');
  } else if (what === 'gun') {
    limb(c, x - .6, y, x + 3.9, y, 1.6, T.gun, lx, ly, fine);
    c.strokeStyle = T.gun.l; c.lineWidth = .35;                              // The slide catches the light.
    c.beginPath(); c.moveTo(x + .2, y - .25); c.lineTo(x + 3.7, y - .25); c.stroke();
  } else {                                        // The flamethrower's wand; its tank rides on the pack.
    limb(c, x - 2.4, y, x + 6, y, 2, T.flamer, lx, ly, fine);
    limb(c, x + 5.6, y, x + 6.3, y, 2.6, T.gun, lx, ly, fine);
    ellipse(c, x + 6.5, y, .5, .5, 0, p.flaming ? '#ffd27a' : `rgba(255,150,60,${.55 + .35 * Math.sin(performance.now() * .02)})`);
  }
}

function drawPlayer(c, p, g) {
  if (p.inv > 0 && ((p.inv * 12) | 0) % 2 === 0) return;   // Flash after an impact.
  // A courier who is down is flat on the street, with a ring underneath that fills as their
  // partner gets them back up.
  if (p.down) {
    c.save(); c.translate(p.x, p.y);
    c.strokeStyle = 'rgba(255,91,77,.85)'; c.lineWidth = 2.4;
    c.beginPath(); c.arc(0, 0, 17, 0, 6.283); c.stroke();
    if (p.reviveT > 0) {
      c.strokeStyle = '#8fe388'; c.lineWidth = 3.2;
      c.beginPath(); c.arc(0, 0, 17, -1.5708, -1.5708 + 6.283 * Math.min(1, p.reviveT / 3)); c.stroke();
    }
    c.restore();
  }
  const L = courierLook(p), B = L.build, T = L.tones, fine = quality.current.key !== 'low';
  const climbing = p.climb > 0 && !p.down, prone = (p.sneaking || p.down) && !climbing;
  const m = courierMotion(p, L, prone);

  // On the ladder the courier faces the wall and is drawn part of the way up it, growing toward
  // the size they will be on the roof; the rules move them there in one go when the climb ends.
  let x = p.x, y = p.y, ang = p.aim, lift = p.roof ? ROOF_LIFT : 1, rung = 0;
  if (climbing) {
    let l = p.climbTo;
    if (!l && g && g.ladders) {                   // A partner's ladder never crosses the wire.
      let best = 40;
      for (const o of g.ladders) {
        const d = p.roof ? Math.hypot(p.x - o.topX, p.y - o.topY) : Math.hypot(p.x - o.x, p.y - o.y);
        if (d < best) { best = d; l = o; }
      }
    }
    const q = 1 - clamp(p.climb / CLIMB_TIME, 0, 1), up = !p.roof, h = up ? q : 1 - q;
    if (l) {
      const ex = up ? l.topX : l.x, ey = up ? l.topY : l.y;
      x += (ex - x) * q; y += (ey - y) * q; ang = l.ang + Math.PI;
    }
    lift = 1 + (ROOF_LIFT - 1) * h;
    rung = h;
  }
  const Sd = BODY_SCALE * lift, ca = Math.cos(ang), sa = Math.sin(ang);
  const blx = LIGHT_X * ca + LIGHT_Y * sa, bly = LIGHT_Y * ca - LIGHT_X * sa;

  c.save();
  c.translate(x, y);
  c.save();                                       // Shadow, in the world's axes.
  c.globalAlpha = 1 - .5 * Math.sin(Math.PI * rung);
  c.translate(SHADOW_X * .7 * lift, SHADOW_Y * .7 * lift); c.rotate(ang);
  if (prone) { c.translate(-6 * Sd, 0); c.scale(Sd * 21, Sd * 11); }
  else c.scale(Sd * B.shoulder * 1.45 * .72, Sd * B.shoulder * 1.45);
  c.fillStyle = gradient(c, 'shadow');
  c.beginPath(); c.arc(0, 0, 1, 0, TAU); c.fill();
  c.restore();
  c.rotate(ang);
  c.scale(Sd, Sd);
  let close = fine;
  if (fine && c.getTransform) { const tm = c.getTransform(); close = tm.a * tm.a + tm.b * tm.b >= 2.56; }

  const what = p.weapon === 1 || p.flaming ? 'flamer' : 'gun';
  const recoil = p.muzzle > 0 ? clamp(p.muzzle / .08, 0, 1) : 0;
  const stag = clamp(p.stagger || 0, 0, .4) / .4;
  const tk = p.takedown > 0 ? Math.sin(Math.PI * (1 - clamp(p.takedown / TAKEDOWN_LOCK, 0, 1))) : 0;
  // Where the rules say the hands are, in the body's own pixels. The beam starts at the glass, so
  // the torch fist sits a torch-length behind HAND_T. The pistol is held out at arm's length with
  // the fist on HAND_G, where the rounds start; the flamethrower's nozzle is on HAND_G instead,
  // because that is where its flames start.
  const torchX = HAND_T.f / BODY_SCALE - TORCH_LENS, torchY = HAND_T.s / BODY_SCALE;
  const gunX = HAND_G.f / BODY_SCALE - (what === 'gun' ? .5 : 6.5), gunY = HAND_G.s / BODY_SCALE;
  if (prone) drawProneCourier(c, p, L, T, m, ang, blx, bly, fine, close, what, torchX, torchY, gunX, gunY);
  else {
    const vn = m.v, st = strideAt(B, vn), run = st.run, move = climbing ? 0 : smooth(3, 24, vn), hipX = -1.2;
    let sway = plantFeet(L, B, m.phase, st, move, hipX) * BODY_GAIT.SWAY * B.sway * (1 - .55 * run) * move;
    if (climbing) for (let i = 0; i < 2; i++) {    // Feet on the rungs, one stepping up past the other.
      const f = FEET[i], s = i ? 1 : -1, up = .5 + .5 * Math.sin(p.walk + i * Math.PI);
      f.x = 1.5 + 1.6 * up; f.y = s * 3.2; f.up = up; f.pitch = .75; f.yaw = 0; f.rel = 0; f.R = 0;
    }
    const hip = climbing ? 0 : m.hip, ch = Math.cos(hip), sh = Math.sin(hip);
    c.save(); c.rotate(hip);
    const first = FEET[0].up <= FEET[1].up ? 0 : 1;
    drawLeg(c, FEET[first], L, B, T, blx * ch + bly * sh, bly * ch - blx * sh, fine, close, hipX);
    drawLeg(c, FEET[1 - first], L, B, T, blx * ch + bly * sh, bly * ch - blx * sh, fine, close, hipX);
    c.restore();

    // Upper body, square to the aim. A shot kicks it back, a hit knocks it, a takedown lunges.
    const ux = -.4 * recoil - 1.8 * stag, uy = sway * .6;
    const xs = B.shoulderX + 1.4 * run * B.lean + 1.2 * tk;
    c.save(); c.translate(ux, uy);
    const bob = Math.sin(m.phase * 2) * (.5 + .9 * run) * move;
    for (let i = 0; i < 2; i++) {
      const s = i ? 1 : -1, A = ARMS[i], jx = xs - .6, jy = s * (B.shoulder - 1.7);
      if (climbing) {                             // Both hands on the rungs, one reaching past the other.
        reachArm(A, s, jx, jy, 7.2, s * 4.4, 2.5 + 2.4 * Math.sin(p.walk + (i ? 0 : Math.PI)), B.armLen, .5, -1);
        A.hx = .6;
      } else if (s < 0) {
        reachArm(A, s, jx, jy, torchX - ux - .6 * run, torchY - uy, -4.5 + bob, B.armLen, .12, -1, .1);
      } else {
        reachArm(A, s, jx, jy, gunX - ux - 1.6 * recoil + 3 * tk - .6 * run, gunY - uy - 4 * tk, -3.5 + bob + .9 * recoil + 2 * tk,
          B.armLen, .12, -1, .1);
      }
      A.high = A.ez > -UPPER * B.armLen * .45;
    }
    // An arm whose elbow hangs below the chest goes under the torso, so the torso covers where the
    // sleeve leaves the shoulder; what the hand holds is out in front of the chest either way.
    const arm = i => {
      const A = ARMS[i], s = i ? 1 : -1;
      if (!climbing) drawHeld(c, A, s < 0 ? 'torch' : what, T, p, blx, bly, fine);
      drawArm(c, A, s, L, B, T, blx, bly, fine, close);
    };
    for (let i = 0; i < 2; i++) if (!ARMS[i].high) arm(i);
    drawCourierTorso(c, L, B, T, xs, ang, false, p.carried);
    if (what === 'flamer' && !climbing) drawFlamerTank(c, B, T, xs, blx, bly, fine);
    for (let i = 0; i < 2; i++) if (ARMS[i].high) arm(i);
    const hx = xs + 1.3 + B.hunch * 2.4 + run * .8 * B.lean + .8 * tk, hy = uy * -.3;
    ellipse(c, hx - blx * 1.6, hy - bly * 1.6, B.headLen * 1.05, B.headWid * 1.05, 0, 'rgba(0,0,0,.22)');
    c.save(); c.translate(hx, hy); c.rotate(-.1 * stag);
    drawCourierHead(c, L, B, T, ang - .1 * stag);
    c.restore();
    c.restore();
  }
  c.restore();
}

function drawFlamerTank(c, B, T, xs, lx, ly, fine) {
  // A slim fuel tank strapped to the side of the pack, on the gun side, with the hose to the wand.
  const [x0, x1] = packSpan(B, false), y = B.shoulder * .7;
  limb(c, xs + x0 + .4, y, xs + x1 - 1.4, y, 2.6, T.flamer, lx, ly, fine);
  c.strokeStyle = '#1f2226'; c.lineWidth = .8;
  c.beginPath(); c.moveTo(xs + x1 - 1.4, y); c.quadraticCurveTo(xs + 2, y + 2.2, ARMS[1].wx - 2.4, ARMS[1].wy); c.stroke();
}

// Flat on the street: shoulders up on the elbows, a knee drawn up to one side as the other leg
// pushes, the gear held out in front. Down, the same body lies still with its arms out and the
// head turned, and what was in the hands lies on the street beside them.
function drawProneCourier(c, p, L, T, m, ang, lx, ly, fine, close, what, torchX, torchY, gunX, gunY) {
  const B = L.prone, down = p.down;
  const crawl = down ? 0 : smooth(3, 20, m.v), ph = m.phase;
  const xs = 2.4, hipX = xs - B.back + 2.4;
  const sw = Math.sin(ph) * 1.1 * crawl;          // The hips swing toward the knee coming up.
  for (let i = 0; i < 2; i++) {
    const s = i ? 1 : -1;
    const bend = down ? 0 : crawl * (.5 + .5 * Math.sin(ph + (i ? Math.PI : 0))) + (1 - crawl) * (i ? .45 : .1);
    const hy = s * 3.6 + sw;
    const kx = hipX - 9.5 + 7 * bend, ky = s * (4.3 + 6.2 * bend + (down ? 1.2 : 0)) + sw * .6;
    const fx = hipX - 18.5 + 7.5 * bend, fy = s * (4.6 + 6.9 * bend + (down ? 2.8 : 0)) + sw * .3;
    const a = Math.atan2(fy - ky, fx - kx), fc = Math.cos(a), fs = Math.sin(a);
    // Toes on the street and heels up: from above that is a short shoe, sole showing.
    ellipse(c, fx + fc * 1.6, fy + fs * 1.6, 3, 1.9, a, T.shoe.m);
    ellipse(c, fx + fc * .6, fy + fs * .6, 1.4, 1.5, a, '#cfcac0');
    limb(c, fx, fy, kx, ky, 4.3, T.pants, lx, ly, fine);
    limb(c, kx, ky, hipX, hy, 5.4 * B.leg, T.pants, lx, ly, fine);
  }
  for (let i = 0; i < 2; i++) {                   // Elbows on the ground, working in turn.
    const s = i ? 1 : -1, A = ARMS[i], jx = xs - .6, jy = s * (B.shoulder - 1.7);
    const pull = 1.4 * Math.sin(ph + (i ? 0 : Math.PI)) * crawl;
    if (down) {
      reachArm(A, s, jx, jy, 3.5, s * 15, -3.5, B.armLen, 1, -.2);
      A.hx = .6; A.hy = s * .45; A.curl = .5;     // Open hands, fallen out to the sides.
    } else if (s < 0) reachArm(A, s, jx, jy, torchX + pull, torchY, -3.5, B.armLen, .45, -.4);
    else reachArm(A, s, jx, jy, gunX + pull, gunY, -3.5, B.armLen, .45, -.4);
  }
  for (let i = 0; i < 2; i++) {
    const A = ARMS[i], s = i ? 1 : -1;
    if (down) {                                   // Dropped, a little way past the open hand.
      c.save(); c.translate(A.wx, A.wy); c.rotate(s * .9);
      const H = { wx: 3, wy: 0 };
      drawHeld(c, H, s < 0 ? 'torch' : what, T, p, lx, ly, fine);
      c.restore();
    } else drawHeld(c, A, s < 0 ? 'torch' : what, T, p, lx, ly, fine);
    drawArm(c, A, s, L, B, T, lx, ly, fine, close);
  }
  c.save();
  c.translate(0, sw * .4); c.rotate(Math.sin(ph) * .05 * crawl);
  drawCourierTorso(c, L, B, T, xs, ang, true, p.carried);
  const hx = xs + 4.4, hy = down ? -.6 : 0;
  ellipse(c, hx - lx * 1.2, hy - ly * 1.2, B.headLen * 1.05, B.headWid * 1.05, 0, 'rgba(0,0,0,.22)');
  c.save(); c.translate(hx, hy); c.rotate(down ? .9 : 0);
  drawCourierHead(c, L, B, T, ang + (down ? .9 : 0));
  c.restore();
  c.restore();
}

// Flashlight and stamina gauges, plus the mobile flashlight button.
function drawGauges(g) {
  const p = g.p, x = 16, y = H - 46;
  const bar = (yy, v, col, label, on) => {
    ctx.fillStyle = 'rgba(10,14,26,.6)'; roundRect(ctx, x, yy, 132, 12, 6); ctx.fill();
    if (v > .005) { ctx.fillStyle = col; roundRect(ctx, x + 2, yy + 2, Math.max(0, 128 * v), 8, 4); ctx.fill(); }
    ctx.fillStyle = on ? '#e8f0ff' : 'rgba(232,240,255,.45)';
    ctx.font = 'bold 10px Trebuchet MS, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(label, x + 138, yy + 10);
  };
  const low = p.batt < .2 && p.torch;
  bar(y, p.batt, low && Math.sin(g.time * 12) > 0 ? '#ff8b5a' : '#ffd766',
      p.torch ? 'FLASHLIGHT (F)' : 'FLASHLIGHT OFF (F)', p.torch);
  bar(y + 18, p.stam, p.stam < .2 ? '#ff8b7a' : '#8ee6a0', 'SPRINT (SHIFT)', p.running);
  const awareness = clamp(p.stealthNotice || 0, 0, 1);
  const stealthLabel = p.stealthDetected ? 'DETECTED' : awareness > .68 ? 'DANGER' :
    awareness > .04 ? `SUSPICION ${Math.round(awareness * 100)}%` :
    p.sneaking ? 'HIDDEN · CRAWLING (C: STAND)' : 'HIDDEN · C: CROUCH';
  const stealthColor = p.stealthDetected ? (Math.sin(g.time * 15) > 0 ? '#fff0a0' : '#ff5b4d') :
    awareness > .68 ? '#ff9a5a' : '#ffd766';
  bar(y - 20, awareness, stealthColor, stealthLabel, p.sneaking || awareness > .04 || p.stealthDetected);
  ctx.fillStyle = SND.muted ? 'rgba(232,240,255,.4)' : 'rgba(232,240,255,.8)';
  ctx.font = 'bold 10px Trebuchet MS, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(SND.muted ? '♪ SOUND OFF (M)' : '♪ SOUND (M)', x, y - 29);

  if ('ontouchstart' in window) {
    ctx.save();
    ctx.globalAlpha = p.torch ? .9 : .45;
    ctx.strokeStyle = '#ffd766'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(TORCH_BTN.x, TORCH_BTN.y, TORCH_BTN.r, 0, 6.283); ctx.stroke();
    ctx.fillStyle = '#ffd766'; ctx.font = 'bold 12px Trebuchet MS, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('LIGHT', TORCH_BTN.x, TORCH_BTN.y + 4);
    ctx.restore();
  }
}

function drawMinimap(g) {
  const S = 118, k = S / WORLD, mx = W - S - 12, my = 12;
  // Roads and houses do not change during a level, so prepare them once instead
  // of issuing hundreds of path, rotate, and fill operations every frame.
  if (!g.minimapStatic) {
    const map = document.createElement('canvas'); map.width = map.height = S;
    const m = map.getContext('2d');
    m.fillStyle = '#5b8f4d'; m.fillRect(0, 0, S, S);
    m.strokeStyle = '#3d434c'; m.lineWidth = Math.max(2, ROAD * k);
    m.lineCap = 'round'; m.lineJoin = 'round';
    for (const e of g.roads.edges) {
      m.beginPath(); m.moveTo(e.pts[0].x * k, e.pts[0].y * k);
      for (let i = 1; i < e.pts.length; i++) m.lineTo(e.pts[i].x * k, e.pts[i].y * k);
      m.stroke();
    }
    m.fillStyle = 'rgba(230,220,200,.75)';
    for (const h of g.houses) {
      m.save(); m.translate(h.cx * k, h.cy * k); m.rotate(h.ang);
      m.fillRect(-h.hw * k, -h.hh * k, h.hw * 2 * k, h.hh * 2 * k);
      m.restore();
    }
    g.minimapStatic = map;
  }
  ctx.save();
  ctx.globalAlpha = .85;
  ctx.fillStyle = '#2b3446'; roundRect(ctx, mx - 4, my - 4, S + 8, S + 8, 6); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.drawImage(g.minimapStatic, mx, my);
  // The map is revealed only where the courier has explored.
  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = .94;
  ctx.drawImage(fogCv, 0, 0, FW, FW, mx, my, S, S);
  ctx.globalAlpha = .85;

  for (const c of g.cars) {                      // Moving objects are visible only within sight.
    if (fogAt(g, c.x, c.y) < .8) continue;
    ctx.fillStyle = c.broken ? '#666a70' : c.police ? (Math.sin(c.beacon * 3.1) > 0 ? '#ff6a6a' : '#6a9cff') : '#ff8b7a';
    ctx.fillRect(mx + c.x * k - (c.police ? 2 : 1.5), my + c.y * k - (c.police ? 2 : 1.5), c.police ? 4 : 3, c.police ? 4 : 3);
  }
  for (const z of g.zombies) if (fogAt(g, z.x, z.y) >= .8) {
    ctx.fillStyle = z.mapColor || '#9fd36a';
    ctx.beginPath(); ctx.arc(mx + z.x * k, my + z.y * k, 2, 0, 6.283); ctx.fill();
  }
  ctx.fillStyle = '#a9d6ff';
  for (const a of g.ammoBoxes) if (fogAt(g, a.x, a.y) > 0)
    ctx.fillRect(mx + a.x * k - 1.5, my + a.y * k - 1.5, 3, 3);
  ctx.fillStyle = '#a9e6b0';
  for (const m of g.cash) if (fogAt(g, m.x, m.y) > 0)
    ctx.fillRect(mx + m.x * k - 1, my + m.y * k - 1, 2, 2);
  ctx.fillStyle = '#ffd766';
  for (const b of g.parcels) if (b.state === 'ground') { ctx.beginPath(); ctx.arc(mx + b.x * k, my + b.y * k, 2.6, 0, 6.283); ctx.fill(); }
  // An address shows on the map only while its parcel is on the courier's back. Fog does
  // not hide it: the courier knows where they are going, they just have to get there.
  ctx.fillStyle = '#8fe388';
  for (const b of g.parcels) if (b.state === 'carried') {
    ctx.beginPath(); ctx.arc(mx + b.dest.x * k, my + b.dest.y * k, 3.4, 0, 6.283); ctx.fill();
  }
  // A partner is drawn wherever they are, fog or no fog: on a shift you always know roughly
  // where the other one is, and losing them on the map helps nobody.
  for (const courier of g.players) {
    if (courier === g.p) continue;
    ctx.fillStyle = courier.down ? '#ff5b4d' : '#57c7ff';
    ctx.beginPath(); ctx.arc(mx + courier.x * k, my + courier.y * k, 3, 0, 6.283); ctx.fill();
    ctx.strokeStyle = 'rgba(87,199,255,.9)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(mx + courier.x * k, my + courier.y * k, 5.5, 0, 6.283); ctx.stroke();
  }
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(mx + g.p.x * k, my + g.p.y * k, 3, 0, 6.283); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(mx + g.p.x * k, my + g.p.y * k, 5.5, 0, 6.283); ctx.stroke();
  ctx.restore();
}

return Object.freeze({
  drawZombie, drawNotice, drawLooseArm, drawLooseHead, looseHeadSize,
  nearestParcel, nearestDrop, drawPlayer, drawGauges, drawMinimap
});
})();

