// Base dependencies, configuration, and mutable application state.
window.TownGame.core = (() => {
'use strict';

const cv = document.getElementById('c'), ctx = cv.getContext('2d');
const W = cv.width, H = cv.height;
const $ = id => document.getElementById(id);
const overlay = $('overlay'), startBtn = $('startBtn');
const UI = Object.freeze({
  overlayTitle: overlay.querySelector('h1'),
  overlaySubtitle: overlay.querySelector('h2'),
  overlayMessage: $('overlayMessage'),
  level: $('lvl'),
  parcels: $('box'),
  ammo: $('ammo'),
  hp: $('hp'),
  lives: $('lives'),
  cash: $('cash'),
  time: $('time'),
  best: $('best'),
  quality: $('qualitySelect'),
  qualityStatus: $('qualityStatus')
});

const STORAGE_KEYS = Object.freeze({ mute: 'townMute', best: 'townBest', quality: 'townQuality' });
const gameStorage = Object.freeze({
  get(key, fallback = null) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); }
    catch { /* The game remains available even when browser storage is disabled. */ }
  }
});

// ---------- town dimensions ----------
const ROAD  = 116;                   // Asphalt width.
const GN    = 5;                     // Road nodes per side.
const GS    = 530;                   // Node spacing: wide blocks leave room to build.
const MRG   = 165;                   // Grid margin from the world edge.
const WORLD = MRG * 2 + (GN - 1) * GS;
const LANE  = 29;                    // Lane offset from the centerline.
const PR    = 12;                    // Player radius.
const ZR    = 12;                    // Zombie radius.
const CAR_L = 46, CAR_W = 22;
const BV    = 660;                   // Bullet speed.
const FIRE_CD = .26;                 // Delay between shots.
const WALK  = 166, RUN = 252;        // Walk and sprint speeds.
const HP_MAX = 5;                    // Hits the courier survives inside one district.
const LIVES_MAX = 3;                 // Districts may be retried this many times per run.
const CARRY_MAX = 2;                 // Parcels the courier can carry at once.
const BATT_DRAIN = 1 / 52;           // The flashlight drains in about 52 seconds.
const STAM_DRAIN = .42, STAM_REGEN = .3;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const rnd  = (a, b) => a + Math.random() * (b - a);
const pick = a => a[(Math.random() * a.length) | 0];

// ---------- oriented boxes: houses, hedges, cars ----------
const CORN = [[-1, -1], [1, -1], [1, 1], [-1, 1]];   // Clockwise, matching the shadow code.
function setOBB(o, cx, cy, ang, hw, hh) {
  o.cx = cx; o.cy = cy; o.ang = ang; o.hw = hw; o.hh = hh; o.rad = Math.hypot(hw, hh);
  const c = Math.cos(ang), s = Math.sin(ang);
  const p = o.pts || (o.pts = [[0, 0], [0, 0], [0, 0], [0, 0]]);
  for (let i = 0; i < 4; i++) {
    const lx = CORN[i][0] * hw, ly = CORN[i][1] * hh;
    p[i][0] = cx + lx * c - ly * s; p[i][1] = cy + lx * s + ly * c;
  }
  return o;
}
const obb = (cx, cy, ang, hw, hh, extra) => Object.assign(setOBB({}, cx, cy, ang, hw, hh), extra);

function inOBB(x, y, o) {
  const c = Math.cos(o.ang), s = Math.sin(o.ang), dx = x - o.cx, dy = y - o.cy;
  return Math.abs(dx * c + dy * s) < o.hw && Math.abs(dy * c - dx * s) < o.hh;
}
// Distance from a point to a box; zero means inside.
function distOBB(x, y, o) {
  const c = Math.cos(o.ang), s = Math.sin(o.ang), dx = x - o.cx, dy = y - o.cy;
  const lx = Math.abs(dx * c + dy * s) - o.hw, ly = Math.abs(dy * c - dx * s) - o.hh;
  return Math.hypot(Math.max(lx, 0), Math.max(ly, 0));
}

const runtime = {
  state: 'menu',
  game: null,
  keys: Object.create(null),
  touch: null,
  joyId: null,
  fireHeld: false,
  mouse: { sx: W / 2, sy: H / 2, down: 0, active: false },
  lives: LIVES_MAX,                  // Survives district rebuilds: the budget belongs to the run, not the level.
  cash: 0,                           // The wallet belongs to the run as well. Nothing sells anything yet.
  best: +(gameStorage.get(STORAGE_KEYS.best, '1')) || 1
};
UI.best.textContent = runtime.best;

const camOf = g => ({
  x: clamp(g.p.x - W / 2, 0, WORLD - W),
  y: clamp(g.p.y - H / 2, 0, WORLD - H)
});

// Courier hands in aim space: flashlight on the left, pistol on the right.
const HAND_T = { f: 13, s: -10 }, HAND_G = { f: 14, s: 8 };
const handAt = (p, h) => {
  const c = Math.cos(p.aim), s = Math.sin(p.aim);
  return { x: p.x + c * h.f - s * h.s, y: p.y + s * h.f + c * h.s };
};
const torchHand = p => handAt(p, HAND_T);
const gunHand = p => handAt(p, HAND_G);

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath(); c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

// ---------- palettes ----------
const WALLS  = ['#e9dcc3', '#dcc8ac', '#cdd8dd', '#e7cfc1', '#dae0c6', '#d8cbd8'];
const ROOFS  = ['#a4503f', '#7d4c39', '#4e6b7c', '#6c7052', '#8a5a4a', '#5a5f6e'];
const CARCOL = ['#d94f45', '#3f7fd0', '#e0b23c', '#5aa35c', '#e8e4dc', '#7a4fb0', '#3b3f46', '#d8752f'];

return Object.freeze({
  cv, ctx, W, H, overlay, startBtn, UI,
  STORAGE_KEYS, gameStorage, runtime,
  ROAD, GN, GS, MRG, WORLD, LANE, PR, ZR, CAR_L, CAR_W,
  BV, FIRE_CD, WALK, RUN, BATT_DRAIN, STAM_DRAIN, STAM_REGEN, HP_MAX, LIVES_MAX, CARRY_MAX,
  WALLS, ROOFS, CARCOL,
  clamp, rnd, pick,
  setOBB, obb, inOBB, distOBB,
  camOf, torchHand, gunHand, roundRect
});
})();

