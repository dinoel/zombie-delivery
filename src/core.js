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
  qualityStatus: $('qualityStatus'),
  roomCode: $('roomCode'),
  hostBtn: $('hostBtn'),
  joinBtn: $('joinBtn'),
  netStatus: $('netStatus'),
  partner: $('partner'),
  partnerBox: $('partnerBox'),
  mode: $('modeSelect')
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

// Only what the helpers below are written in terms of. Everything else that used to be declared
// here is a setting and lives in `config.js`, which every module reads directly. `core` is not a
// settings API and should not grow back into one.
const { WORLD, LIVES_MAX, HAND_T, HAND_G } = window.TownGame.config;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const rnd  = (a, b) => a + Math.random() * (b - a);
const pick = a => a[(Math.random() * a.length) | 0];
// Math.hypot protects against overflow at magnitudes this town never reaches and pays for
// that on every call. Distances here are pixels inside a 2450-pixel district, so the plain
// formula is exact for the same inputs and several times cheaper in the frame loops.
const len = (x, y) => Math.sqrt(x * x + y * y);

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

return Object.freeze({
  cv, ctx, W, H, overlay, startBtn, UI,
  STORAGE_KEYS, gameStorage, runtime,
  clamp, rnd, pick, len,
  setOBB, obb, inOBB, distOBB,
  camOf, torchHand, gunHand, roundRect
});
})();

