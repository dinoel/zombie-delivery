// Базовые зависимости, конфигурация и изменяемое состояние приложения.
window.TownGame.core = (() => {
'use strict';

const cv = document.getElementById('c'), ctx = cv.getContext('2d');
const W = cv.width, H = cv.height;
const $ = id => document.getElementById(id);
const overlay = $('overlay'), startBtn = $('startBtn');
const UI = Object.freeze({
  overlayTitle: overlay.querySelector('h1'),
  overlaySubtitle: overlay.querySelector('h2'),
  overlayMessage: overlay.querySelector('p'),
  level: $('lvl'),
  parcels: $('box'),
  ammo: $('ammo'),
  lives: $('lives'),
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
    catch { /* Игра остаётся доступной, даже если хранилище браузера отключено. */ }
  }
});

// ---------- размеры города ----------
const ROAD  = 116;                   // ширина асфальта
const GN    = 4;                     // узлов улиц по стороне
const GS    = 400;                   // шаг узлов
const MRG   = 165;                   // отступ сетки от края мира
const WORLD = MRG * 2 + (GN - 1) * GS;
const LANE  = 29;                    // смещение полосы от осевой
const PR    = 12;                    // радиус игрока
const ZR    = 12;                    // радиус зомби
const CAR_L = 46, CAR_W = 22;
const BV    = 660;                   // скорость пули
const FIRE_CD = .26;                 // задержка между выстрелами
const WALK  = 166, RUN = 252;        // шаг и рывок
const BATT_DRAIN = 1 / 52;           // фонарь съедает заряд за ~52 секунды
const STAM_DRAIN = .42, STAM_REGEN = .3;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const rnd  = (a, b) => a + Math.random() * (b - a);
const pick = a => a[(Math.random() * a.length) | 0];

// ---------- повёрнутые коробки: дома, изгороди, машины ----------
const CORN = [[-1, -1], [1, -1], [1, 1], [-1, 1]];   // по часовой — так же читают тени
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
// насколько точка близка к коробке (0 — внутри)
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
  best: +(gameStorage.get(STORAGE_KEYS.best, '1')) || 1
};
UI.best.textContent = runtime.best;

const camOf = g => ({
  x: clamp(g.p.x - W / 2, 0, WORLD - W),
  y: clamp(g.p.y - H / 2, 0, WORLD - H)
});

// Руки курьера в системе прицела: фонарь в левой, пистолет в правой.
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

// ---------- палитры ----------
const WALLS  = ['#e9dcc3', '#dcc8ac', '#cdd8dd', '#e7cfc1', '#dae0c6', '#d8cbd8'];
const ROOFS  = ['#a4503f', '#7d4c39', '#4e6b7c', '#6c7052', '#8a5a4a', '#5a5f6e'];
const CARCOL = ['#d94f45', '#3f7fd0', '#e0b23c', '#5aa35c', '#e8e4dc', '#7a4fb0', '#3b3f46', '#d8752f'];

return Object.freeze({
  cv, ctx, W, H, overlay, startBtn, UI,
  STORAGE_KEYS, gameStorage, runtime,
  ROAD, GN, GS, MRG, WORLD, LANE, PR, ZR, CAR_L, CAR_W,
  BV, FIRE_CD, WALK, RUN, BATT_DRAIN, STAM_DRAIN, STAM_REGEN,
  WALLS, ROOFS, CARCOL,
  clamp, rnd, pick,
  setOBB, obb, inOBB, distOBB,
  camOf, torchHand, gunHand, roundRect
});
})();

