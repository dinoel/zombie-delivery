// Entry point: connects the subsystems and starts the game loop.
(() => {
'use strict';

const {
  cv, ctx, W, H, UI, overlay, startBtn, runtime, clamp, LIVES_MAX
} = window.TownGame.core;
const SND = window.TownGame.audio;
const { buildTown } = window.TownGame.world;
const { prepareCarImpactComparison } = window.TownGame.environment;
const { update, presentFrame } = window.TownGame.gameplay;
const { draw } = window.TownGame.render;

// Once every subsystem has loaded, the public module collection no longer changes.
Object.freeze(window.TownGame);

// ---------- loop ----------
const qaMode = new URLSearchParams(location.search).get('qa');
const perfQa = qaMode === 'perf' || qaMode === 'perf-legacy';
const hashQa = qaMode === 'frame-hash';
if (perfQa || hashQa) {
  // Repeatable towns and weather exist only for fair A/B profiling and for the picture check.
  let seed = 0x51ed5eed;
  Math.random = () => {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0;
    let n = Math.imul(seed ^ seed >>> 15, 1 | seed);
    n = n + Math.imul(n ^ n >>> 7, 61 | n) ^ n;
    return ((n ^ n >>> 14) >>> 0) / 4294967296;
  };
}

if (hashQa) {
  // The light budget, shadow count and fog cadence all come from the quality profile, so two
  // runs are only comparable if they chose the same one — and the choice is normally restored
  // from browser storage. Forcing it through the control itself leaves quality.js the only
  // thing that decides what a profile means.
  UI.quality.value = 'low';
  UI.quality.dispatchEvent(new Event('change'));
  // Sound is muted for the same reason, and it is not about sound. Several voices draw from the
  // same random stream as the town, and a muted engine returns before it draws — so the mute
  // setting silently decides where every later draw lands. Two runs are only comparable if they
  // agree about it, and muted is the one state that also holds when audio never started.
  if (!SND.muted) SND.toggle();
}

// A district drawn from a fixed seed on a fixed input script must produce a fixed picture.
// The node tests hash game state, which catches a rule that changed; this hashes pixels, which
// catches a frame that changed. The sample runs to completion in one go rather than one step
// per animation frame, so the answer never depends on how fast the machine happened to be.
const HASH_STEPS = 300, HASH_DT = 1 / 60;
function scriptHashInput(frame) {
  const keys = runtime.keys;
  for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft']) keys[code] = 0;
  const leg = Math.floor(frame / 150) % 4;
  keys[['KeyW', 'KeyD', 'KeyS', 'KeyA'][leg]] = 1;
  keys.ShiftLeft = leg === 1 || leg === 3 ? 1 : 0;
  keys.Space = frame > 150 && frame % 37 === 0 ? 1 : 0;
  runtime.mouse.active = true;
  const a = frame * .031;
  runtime.mouse.sx = W / 2 + Math.cos(a) * 250;
  runtime.mouse.sy = H / 2 + Math.sin(a) * 200;
  if (frame === 120) dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF' }));
  if (frame === 121) dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyF' }));
  if (frame === 200) dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF' }));
  if (frame === 201) dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyF' }));
}
function runFrameHash() {
  const g = runtime.game;
  for (let frame = 0; frame < HASH_STEPS; frame++) {
    scriptHashInput(frame);
    update(g, HASH_DT); draw(g);
  }
  const px = ctx.getImageData(0, 0, W, H).data;
  let h = 0x811c9dc5;
  for (let i = 0; i < px.length; i++) { h ^= px[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  cv.dataset.frameHash = h.toString(16).padStart(8, '0');
  cv.dataset.frameHashQuality = window.TownGame.quality.current.key;
  cv.dataset.frameHashSteps = String(HASH_STEPS);
}
// Whether this peer owns the simulation. Alone in a district it always does, and it will keep
// doing so while hosting; only a guest hands the rules to somebody else.
const authoritative = () => !window.TownGame.net || window.TownGame.net.authoritative();
let last = performance.now();
let perfFrames = 0, perfUpdate = 0, perfDraw = 0, perfFrame = 0;
function loop(t) {
  const rawFrame = t - last;
  const dt = clamp(rawFrame / 1000, 0, .05); last = t;   // The frame timestamp may predate startup; never move time backward.
  if (runtime.state === 'play' && runtime.game) {
    if (hashQa) { /* The sample runs to completion on its own, off the animation clock. */ }
    else if (perfQa && runtime.game.time > 1 && cv.dataset.perfReady !== '1') {
      const updateStart = performance.now();
      update(runtime.game, dt);
      const drawStart = performance.now();
      draw(runtime.game);
      perfUpdate += drawStart - updateStart;
      perfDraw += performance.now() - drawStart;
      perfFrame += rawFrame;
      perfFrames++;
      if (perfFrames >= 180) {
        cv.dataset.perfUpdate = (perfUpdate / perfFrames).toFixed(3);
        cv.dataset.perfDraw = (perfDraw / perfFrames).toFixed(3);
        cv.dataset.perfFrame = (perfFrame / perfFrames).toFixed(3);
        cv.dataset.perfFps = (1000 * perfFrames / perfFrame).toFixed(1);
        cv.dataset.perfReady = '1';
      }
    } else if (authoritative()) {
      update(runtime.game, dt); draw(runtime.game);
    } else {
      // Someone else is running the rules. This peer only works out what the district looks
      // like, sounds like and feels like from the state that reached it.
      presentFrame(runtime.game, dt); draw(runtime.game);
    }
  } else if (runtime.game) draw(runtime.game);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

startBtn.addEventListener('click', () => {
  SND.init();                                 // Audio can only start from a user gesture.
  // A win advances the district, a lost life replays it, anything else starts a fresh run.
  const won = runtime.state === 'win', retry = runtime.state === 'retry';
  if (!won && !retry) { runtime.lives = LIVES_MAX; runtime.cash = 0; }
  const next = won ? runtime.game.level + 1 : retry ? runtime.game.level : 1;
  runtime.game = buildTown(next);
  const impactQa = qaMode === 'impact-compare';
  if (impactQa) prepareCarImpactComparison(runtime.game);
  overlay.classList.add('hidden');
  cv.classList.add('aim');
  runtime.mouse.down = 0; runtime.fireHeld = false;
  runtime.state = impactQa ? 'qa' : 'play';
  delete cv.dataset.perfReady;
  delete cv.dataset.perfUpdate;
  delete cv.dataset.perfDraw;
  delete cv.dataset.perfFrame;
  delete cv.dataset.perfFps;
  perfFrames = perfUpdate = perfDraw = perfFrame = 0;
  last = performance.now();
  if (hashQa) {
    // Rain is the one thing on screen that a seed cannot reach: the drop field is a module-level
    // array filled when environment.js loads, which is before this file exists to replace
    // Math.random. A dry night is what makes one seed mean one picture.
    Object.assign(runtime.game.weather, { rain: 0, target: 0, wet: 0, next: 999, strike: 999 });
    // Deliberately not driven by requestAnimationFrame: the sample is one blocking run either
    // way, and a check that does not need the compositor also works in a background tab.
    setTimeout(runFrameHash, 0);
  }
});
})();
