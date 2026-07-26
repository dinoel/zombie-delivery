// Точка входа: связывает подсистемы и запускает игровой цикл.
(() => {
'use strict';

const {
  cv, overlay, startBtn, runtime, clamp
} = window.TownGame.core;
const SND = window.TownGame.audio;
const { buildTown } = window.TownGame.world;
const { prepareCarImpactComparison } = window.TownGame.environment;
const { update } = window.TownGame.gameplay;
const { draw } = window.TownGame.render;

// После загрузки всех подсистем набор публичных модулей больше не меняется.
Object.freeze(window.TownGame);

// ---------- цикл ----------
const qaMode = new URLSearchParams(location.search).get('qa');
const perfQa = qaMode === 'perf' || qaMode === 'perf-legacy';
if (perfQa) {
  // Повторяемые города и погода нужны только для честного A/B-профилирования.
  let seed = 0x6d2b79f5;
  Math.random = () => {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0;
    let n = Math.imul(seed ^ seed >>> 15, 1 | seed);
    n = n + Math.imul(n ^ n >>> 7, 61 | n) ^ n;
    return ((n ^ n >>> 14) >>> 0) / 4294967296;
  };
}
let last = performance.now();
let perfFrames = 0, perfUpdate = 0, perfDraw = 0, perfFrame = 0;
function loop(t) {
  const rawFrame = t - last;
  const dt = clamp(rawFrame / 1000, 0, .05); last = t;   // метка кадра бывает раньше старта — не даём времени идти вспять
  if (runtime.state === 'play' && runtime.game) {
    if (perfQa && runtime.game.time > 1 && cv.dataset.perfReady !== '1') {
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
    } else {
      update(runtime.game, dt); draw(runtime.game);
    }
  } else if (runtime.game) draw(runtime.game);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

startBtn.addEventListener('click', () => {
  SND.init();                                 // звук можно включать только из жеста пользователя
  const next = runtime.state === 'win' ? runtime.game.level + 1 : 1;
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
});
})();
