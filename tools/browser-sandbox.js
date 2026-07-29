// A browser stub good enough to load the game's subsystems under plain node.
//
// The vehicle damage test builds its own tiny stub because it needs two modules and a handful
// of methods. The determinism tests need nearly every subsystem, a district generated for real,
// and a canvas that survives the whole static-layer pass, so they share this one instead of
// growing a third and fourth copy of the same fiction.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const noop = () => {};

// Nothing here draws anything: the tests read game state, never pixels. Every call is accepted
// and discarded, and every property assignment simply sticks, which is all the renderer needs.
function context2d() {
  const gradient = { addColorStop: noop };
  return {
    canvas: null,
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    miterLimit: 10, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
    shadowBlur: 0, shadowColor: 'transparent', shadowOffsetX: 0, shadowOffsetY: 0,
    filter: 'none', imageSmoothingEnabled: true, lineDashOffset: 0,
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop, transform: noop,
    setTransform: noop, resetTransform: noop, clip: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, rect: noop, arc: noop,
    arcTo: noop, ellipse: noop, quadraticCurveTo: noop, bezierCurveTo: noop,
    fill: noop, stroke: noop, fillRect: noop, strokeRect: noop, clearRect: noop,
    fillText: noop, strokeText: noop, setLineDash: noop, getLineDash: () => [],
    measureText: text => ({ width: String(text).length * 6 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createConicGradient: () => gradient,
    createPattern: () => ({ setTransform: noop }),
    drawImage: noop,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop,
    isPointInPath: () => false
  };
}

// Listeners are kept rather than dropped so a test can press a key for real and watch it travel
// through the actual handler in input.js, instead of reaching into runtime and pretending.
function listenerBox() {
  const byType = new Map();
  return {
    add(type, fn) {
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(fn);
    },
    emit(type, event = {}) {
      const list = byType.get(type) || [];
      const full = { type, preventDefault: noop, stopPropagation: noop, changedTouches: [], touches: [], ...event };
      for (const fn of list.slice()) fn(full);
      return list.length;
    }
  };
}

function canvasEl(width = 0, height = 0) {
  const events = listenerBox();
  const el = {
    width, height, dataset: {}, style: {}, classList: classListStub(),
    addEventListener: (type, fn) => events.add(type, fn),
    removeEventListener: noop,
    emit: (type, event) => events.emit(type, event),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: el.width, height: el.height })
  };
  const ctx = context2d();
  ctx.canvas = el;
  // A WebGL request must fail so lighting falls back to Canvas 2D; the tests never load it,
  // but quality detection asks, and a truthy answer here would be a lie worth avoiding.
  el.getContext = kind => (kind === '2d' ? ctx : null);
  return el;
}

const classListStub = () => {
  const set = new Set();
  return {
    add: (...c) => c.forEach(n => set.add(n)),
    remove: (...c) => c.forEach(n => set.delete(n)),
    toggle: n => (set.has(n) ? (set.delete(n), false) : (set.add(n), true)),
    contains: n => set.has(n)
  };
};

function element(id) {
  return {
    id, textContent: '', value: '', dataset: {}, style: {},
    classList: classListStub(),
    addEventListener: noop, removeEventListener: noop,
    querySelector: () => element(`${id}-child`),
    appendChild: noop
  };
}

function storageStub() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    clear: () => map.clear()
  };
}

// The seed is installed from inside the context so it patches the sandbox realm's own Math.
// Handing the host realm's Math across the boundary, as the vehicle test does, would make a
// seeded run silently replace the test runner's Math.random as well.
const SEED_PRELUDE = `
globalThis.__seed = value => {
  let seed = value | 0;
  Math.random = () => {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0;
    let n = Math.imul(seed ^ seed >>> 15, 1 | seed);
    n = n + Math.imul(n ^ n >>> 7, 61 | n) ^ n;
    return ((n ^ n >>> 14) >>> 0) / 4294967296;
  };
};
`;

// Every id core.js resolves at load time. Missing one is a null dereference deep inside a
// subsystem, so they are listed rather than conjured on demand.
const ELEMENT_IDS = ['overlay', 'startBtn', 'overlayMessage', 'lvl', 'box', 'ammo', 'hp',
  'lives', 'cash', 'time', 'best', 'qualitySelect', 'qualityStatus',
  'partner', 'partnerBox', 'roomCode', 'hostBtn', 'joinBtn', 'netStatus'];

/**
 * Loads the named subsystems in order and returns the populated TownGame namespace.
 * `modules` are file basenames without the extension, in load order.
 */
function load({ modules, seed = null, search = '' } = {}) {
  const cv = canvasEl(720, 560);
  const nodes = new Map(ELEMENT_IDS.map(id => [id, element(id)]));
  nodes.set('c', cv);
  const windowEvents = listenerBox();

  const sandbox = {
    console,
    document: {
      getElementById: id => nodes.get(id) || null,
      createElement: tag => (tag === 'canvas' ? canvasEl() : element(tag)),
      addEventListener: noop, removeEventListener: noop,
      documentElement: element('html'), body: element('body')
    },
    localStorage: storageStub(),
    location: { search, href: 'http://localhost/', protocol: 'http:' },
    performance: { now: () => 0 },
    requestAnimationFrame: noop,
    cancelAnimationFrame: noop,
    setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
    addEventListener: (type, fn) => windowEvents.add(type, fn),
    removeEventListener: noop,
    devicePixelRatio: 1,
    navigator: { userAgent: 'node' },
    // A pure parser with no bearing on the random stream, so the host's implementation is safe
    // to share across the boundary where Math deliberately is not.
    URLSearchParams
  };
  // No AudioContext, so the sound engine stays inert and never allocates a node.
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.TownGame = {};
  sandbox.window.TownGame = sandbox.TownGame;

  const context = vm.createContext(sandbox);
  vm.runInContext(SEED_PRELUDE, context, { filename: 'seed-prelude.js' });
  if (seed !== null) sandbox.__seed(seed);

  for (const name of modules) {
    const file = path.join(SRC, `${name}.js`);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: `${name}.js` });
  }

  return {
    context,
    sandbox,
    TownGame: sandbox.TownGame,
    canvas: cv,
    reseed: value => sandbox.__seed(value),
    key: (down, code) => windowEvents.emit(down ? 'keydown' : 'keyup', { code }),
    canvasEvent: (type, event) => cv.emit(type, event),
    // Math belongs to the sandbox realm rather than to the stub, which is the whole point of
    // seeding in there. Reading the stream back therefore has to be asked from inside as well.
    nextRandom: () => vm.runInContext('Math.random()', context)
  };
}

// FNV-1a over a string. Small, stable across engines, and enough to catch a single moved
// random draw, which is the only thing these tests are trying to notice.
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Floats are rounded before hashing so the digest survives the last bit of arithmetic noise
// while still moving the moment a value is genuinely different.
const q = (v, places = 4) => {
  if (typeof v !== 'number') return v;
  if (!Number.isFinite(v)) return String(v);
  const k = 10 ** places;
  return Math.round(v * k) / k;
};

module.exports = { load, fnv1a, q, canvasEl, element };
