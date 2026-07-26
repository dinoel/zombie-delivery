// Клавиатура, мышь и сенсорное управление.
window.TownGame.input = (() => {
'use strict';

const { cv, startBtn, runtime } = window.TownGame.core;
const SND = window.TownGame.audio;

// ---------- ввод ----------
addEventListener('keydown', e => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  const k = e.key.toLowerCase();
  if (!runtime.keys[k] && runtime.state === 'play' && runtime.game && (k === 'f' || k === 'а')) {
    runtime.game.p.torch = !runtime.game.p.torch;
    SND.play(runtime.game.p.torch && runtime.game.p.batt > 0 ? 'click' : 'empty');
  }
  if (!runtime.keys[k] && (k === 'm' || k === 'ь')) SND.toggle();
  runtime.keys[k] = 1;
  if (runtime.state !== 'play' && (e.key === ' ' || e.key === 'Enter')) startBtn.click();
});
addEventListener('keyup', e => { runtime.keys[e.key.toLowerCase()] = 0; });

const tpos = t => {
  const r = cv.getBoundingClientRect();
  return [(t.clientX - r.left) * cv.width / r.width, (t.clientY - r.top) * cv.height / r.height];
};
// первый палец — джойстик, любой следующий — огонь; угол сверху слева — фонарь
const TORCH_BTN = { x: 58, y: 52, r: 34 };
cv.addEventListener('touchstart', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    const p = tpos(t);
    if (runtime.state === 'play' && runtime.game && Math.hypot(p[0] - TORCH_BTN.x, p[1] - TORCH_BTN.y) < TORCH_BTN.r) {
      runtime.game.p.torch = !runtime.game.p.torch;
      SND.play(runtime.game.p.torch && runtime.game.p.batt > 0 ? 'click' : 'empty');
      continue;
    }
    if (runtime.joyId === null) {
      runtime.joyId = t.identifier;
      runtime.touch = { ox: p[0], oy: p[1], x: p[0], y: p[1] };
    } else runtime.fireHeld = true;
  }
}, { passive: false });
cv.addEventListener('touchmove', e => {
  e.preventDefault();
  for (const t of e.changedTouches) if (t.identifier === runtime.joyId && runtime.touch) {
    const p = tpos(t); runtime.touch.x = p[0]; runtime.touch.y = p[1];
  }
}, { passive: false });
const touchOff = e => {
  e.preventDefault();
  for (const t of e.changedTouches) if (t.identifier === runtime.joyId) {
    runtime.joyId = null; runtime.touch = null;
  }
  runtime.fireHeld = [...e.touches].some(t => t.identifier !== runtime.joyId);
  if (runtime.joyId === null && e.touches.length) {         // джойстик уехал — назначаем оставшийся палец
    const t = e.touches[0], p = tpos(t);
    runtime.joyId = t.identifier;
    runtime.touch = { ox: p[0], oy: p[1], x: p[0], y: p[1] };
    runtime.fireHeld = e.touches.length > 1;
  }
};
cv.addEventListener('touchend', touchOff, { passive: false });
cv.addEventListener('touchcancel', touchOff, { passive: false });

// мышь — прицел и огонь
cv.addEventListener('mousemove', e => {
  const p = tpos(e); runtime.mouse.sx = p[0]; runtime.mouse.sy = p[1]; runtime.mouse.active = true;
});
cv.addEventListener('mousedown', e => {
  e.preventDefault();
  const p = tpos(e); runtime.mouse.sx = p[0]; runtime.mouse.sy = p[1]; runtime.mouse.active = true; runtime.mouse.down = 1;
});
addEventListener('mouseup', () => { runtime.mouse.down = 0; });
cv.addEventListener('mouseleave', () => { runtime.mouse.down = 0; });
cv.addEventListener('contextmenu', e => e.preventDefault());

function inputDir() {
  const { keys, touch } = runtime;
  let dx = 0, dy = 0, run = !!keys['shift'];
  if (keys['arrowleft'] || keys['a'] || keys['ф']) dx -= 1;
  if (keys['arrowright'] || keys['d'] || keys['в']) dx += 1;
  if (keys['arrowup'] || keys['w'] || keys['ц']) dy -= 1;
  if (keys['arrowdown'] || keys['s'] || keys['ы']) dy += 1;
  if (touch) {
    const tx = touch.x - touch.ox, ty = touch.y - touch.oy, d = Math.hypot(tx, ty);
    if (d > 10) { const k = Math.min(d, 55) / 55 / d; dx = tx * k; dy = ty * k; }
    if (d > 50) run = true;                       // палец до упора — бежим
  }
  const m = Math.hypot(dx, dy);
  const v = m > 1 ? { x: dx / m, y: dy / m, m: 1 } : { x: dx, y: dy, m };
  v.run = run;
  return v;
}

return Object.freeze({ inputDir, TORCH_BTN });
})();

