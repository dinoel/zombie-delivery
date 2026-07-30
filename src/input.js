// Keyboard, mouse, and touch controls.
window.TownGame.input = (() => {
'use strict';

const { cv, startBtn, runtime } = window.TownGame.core;
const SND = window.TownGame.audio;

// The flashlight and the crawl are presses, not states. A handler cannot simply flip them on the
// courier any more: the courier it would flip may be running on somebody else's machine, and the
// rules flip the flashlight themselves when the battery dies. Counting presses instead lets the
// same record describe a local key and a key pressed across a network, and lets whoever owns the
// simulation decide what the press means.
let torchPresses = 0, sneakPresses = 0, weaponPresses = 0;

// ---------- input ----------
addEventListener('keydown', e => {
  const code = e.code;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(code)) e.preventDefault();
  if (!runtime.keys[code] && runtime.state === 'play' && runtime.game && code === 'KeyF') torchPresses++;
  if (!runtime.keys[code] && runtime.state === 'play' && runtime.game && code === 'KeyC') sneakPresses++;
  if (!runtime.keys[code] && runtime.state === 'play' && runtime.game && code === 'KeyQ') weaponPresses++;
  if (!runtime.keys[code] && code === 'KeyM') SND.toggle();
  // Pause freezes the district but keeps the frame on screen. A district shared with somebody
  // else belongs to both of them, so only the end running the rules may stop it — a guest that
  // paused alone would sit watching a still frame while snapshots piled up behind it.
  if (!runtime.keys[code] && (code === 'KeyP' || code === 'Escape') && runtime.game &&
      (runtime.state === 'play' || runtime.state === 'paused')) {
    const net = window.TownGame.net;
    if (net && !net.authoritative()) {
      net.note('The host holds the pause on a shared district.');
      runtime.keys[code] = 1;
      return;
    }
    runtime.state = runtime.state === 'play' ? 'paused' : 'play';
    if (runtime.state === 'paused') { SND.rain(0); SND.flame(0); }
    if (net) net.sendPause(runtime.state === 'paused');
    runtime.keys[code] = 1;
    return;                                   // A paused game must not also fire or start a district.
  }
  runtime.keys[code] = 1;
  if (runtime.state !== 'play' && runtime.state !== 'paused' &&
      (code === 'Space' || code === 'Enter')) startBtn.click();
});
addEventListener('keyup', e => { runtime.keys[e.code] = 0; });
addEventListener('blur', () => {
  for (const code of Object.keys(runtime.keys)) runtime.keys[code] = 0;
});

const tpos = t => {
  const r = cv.getBoundingClientRect();
  return [(t.clientX - r.left) * cv.width / r.width, (t.clientY - r.top) * cv.height / r.height];
};
// First finger controls movement, additional fingers fire; the top-left corner toggles the flashlight.
const TORCH_BTN = { x: 58, y: 52, r: 34 };
cv.addEventListener('touchstart', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    const p = tpos(t);
    if (runtime.state === 'play' && runtime.game && Math.hypot(p[0] - TORCH_BTN.x, p[1] - TORCH_BTN.y) < TORCH_BTN.r) {
      torchPresses++;
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
  if (runtime.joyId === null && e.touches.length) {         // Reassign the joystick to a remaining finger.
    const t = e.touches[0], p = tpos(t);
    runtime.joyId = t.identifier;
    runtime.touch = { ox: p[0], oy: p[1], x: p[0], y: p[1] };
    runtime.fireHeld = e.touches.length > 1;
  }
};
cv.addEventListener('touchend', touchOff, { passive: false });
cv.addEventListener('touchcancel', touchOff, { passive: false });

// Mouse aiming and fire.
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

// The arrows double for WASD alone in a district, and become the partner's controls in the
// local two-courier harness, which is the only time this is asked to leave them out.
function inputDir(arrowsToo = true) {
  const { keys, touch } = runtime;
  let dx = 0, dy = 0, run = !!(keys.ShiftLeft || keys.ShiftRight);
  if (keys.KeyA || (arrowsToo && keys.ArrowLeft)) dx -= 1;
  if (keys.KeyD || (arrowsToo && keys.ArrowRight)) dx += 1;
  if (keys.KeyW || (arrowsToo && keys.ArrowUp)) dy -= 1;
  if (keys.KeyS || (arrowsToo && keys.ArrowDown)) dy += 1;
  if (touch) {
    const tx = touch.x - touch.ox, ty = touch.y - touch.oy, d = Math.hypot(tx, ty);
    if (d > 10) { const k = Math.min(d, 55) / 55 / d; dx = tx * k; dy = ty * k; }
    if (d > 50) run = true;                       // Pushing the stick to its limit starts a sprint.
  }
  const m = Math.hypot(dx, dy);
  const v = m > 1 ? { x: dx / m, y: dy / m, m: 1 } : { x: dx, y: dy, m };
  v.run = run;
  return v;
}

// Everything the devices in front of this screen are saying, written onto the courier as one
// record. The simulation reads only the record, so it cannot tell — and does not need to tell —
// whether the courier is holding this keyboard or a keyboard somewhere else.
//
// Aim is the one field that cannot be settled here. A mouse names a point on this screen, and
// that only becomes a point in the town once the camera is known, which is not until the courier
// has moved. So the screen position travels and the rules convert it at the instant they always
// did. A courier on another machine has already made that conversion against their own camera,
// and sends tx and ty in world coordinates instead.
function readLocalInput(g, p) {
  const v = inputDir(g.players.length < 2);
  const rec = p.in || (p.in = { tx: 0, ty: 0 });
  rec.n = (rec.n || 0) + 1;
  rec.x = v.x; rec.y = v.y; rec.m = v.m; rec.run = v.run;
  rec.fire = !!(runtime.mouse.down || runtime.fireHeld || runtime.keys.Space || runtime.keys.KeyK);
  rec.finish = !!runtime.keys.KeyE;
  rec.aimScreen = runtime.mouse.active;
  rec.sx = runtime.mouse.sx; rec.sy = runtime.mouse.sy;
  rec.torchSeq = torchPresses; rec.sneakSeq = sneakPresses; rec.weaponSeq = weaponPresses;
  return rec;
}

// The partner in the local harness. Two couriers on one keyboard is not a way to play — there
// is one screen, one camera and one mouse — but it is the only way to exercise the rules that
// exist solely because there are two of them, without a network in the way.
let partnerTorch = 0, partnerSneak = 0, partnerWeapon = 0;
addEventListener('keydown', e => {
  if (runtime.keys[e.code] || runtime.state !== 'play' || !runtime.game) return;
  if (e.code === 'Slash') partnerTorch++;
  if (e.code === 'Period') partnerSneak++;
  if (e.code === 'Comma') partnerWeapon++;
});
function readSecondInput(g, p) {
  const keys = runtime.keys;
  let dx = 0, dy = 0;
  if (keys.ArrowLeft) dx -= 1;
  if (keys.ArrowRight) dx += 1;
  if (keys.ArrowUp) dy -= 1;
  if (keys.ArrowDown) dy += 1;
  const m = Math.hypot(dx, dy);
  const rec = p.in || (p.in = { tx: 0, ty: 0 });
  rec.n = (rec.n || 0) + 1;
  if (m > 1) { rec.x = dx / m; rec.y = dy / m; rec.m = 1; } else { rec.x = dx; rec.y = dy; rec.m = m; }
  rec.run = !!keys.ShiftRight;
  rec.fire = !!keys.Numpad0 || !!keys.ControlRight;
  rec.finish = !!keys.Numpad1;
  rec.aimScreen = false;                     // No second mouse: the partner shoots where they walk.
  rec.torchSeq = partnerTorch; rec.sneakSeq = partnerSneak; rec.weaponSeq = partnerWeapon;
  return rec;
}

return Object.freeze({ inputDir, readLocalInput, readSecondInput, TORCH_BTN });
})();

