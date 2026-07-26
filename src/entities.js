// Персонажи, шкалы состояния и мини-карта.
window.TownGame.entities = (() => {
'use strict';

const { ctx, W, H, WORLD, ROAD, roundRect } = window.TownGame.core;
const SND = window.TownGame.audio;
const { FW, fogCv, fogAt } = window.TownGame.environment;
const { TORCH_BTN } = window.TownGame.input;

function drawZombie(c, z) {
  const sw = Math.sin(z.walk) * 3.2;
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
  c.fillStyle = 'rgba(0,0,0,.3)';
  c.beginPath(); c.ellipse(z.x + 3, z.y + 8, 13, 7.5, 0, 0, 6.283); c.fill();
  c.save(); c.translate(z.x, z.y); c.rotate(z.ang);
  const skin = z.hit > 0 ? '#ffd2d2' : (z.skin || '#8fae63');
  // вытянутые руки
  c.fillStyle = skin;
  roundRect(c, 4, -12 - sw * .5, 16, 5, 2.5); c.fill();
  roundRect(c, 4, 7 + sw * .5, 16, 5, 2.5); c.fill();
  // ноги
  c.fillStyle = '#4a4436';
  roundRect(c, -5, -8 + sw, 11, 6, 3); c.fill();
  roundRect(c, -5, 2 - sw, 11, 6, 3); c.fill();
  // рваная одежда
  c.fillStyle = z.hit > 0 ? '#e9b6b6' : (z.clothes || '#5d6b4a');
  roundRect(c, -10, -9, 19, 18, 6); c.fill();
  c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1.5; c.stroke();
  if (z.guardParcel >= 0) {
    c.fillStyle = '#e2b84e'; roundRect(c, -1, -10, 6, 4, 1); c.fill();
  }
  c.fillStyle = 'rgba(0,0,0,.18)';
  c.beginPath(); c.arc(-2 + z.seed * 4, -3, 3.5, 0, 6.283); c.fill();
  // голова и глаза
  c.fillStyle = skin;
  c.beginPath(); c.arc(2, 0, 7.5, 0, 6.283); c.fill();
  c.strokeStyle = 'rgba(0,0,0,.3)'; c.lineWidth = 1.2; c.stroke();
  c.fillStyle = '#7b3b2a';
  c.beginPath(); c.arc(-1, 0, 7.2, 1.7, 4.6); c.fill();
  c.fillStyle = z.eye || '#ff5a45';
  c.beginPath(); c.arc(6, -2.6, 1.7, 0, 6.283); c.fill();
  c.beginPath(); c.arc(6, 2.6, 1.7, 0, 6.283); c.fill();
  if (z.throwWind > 0) {
    const pulse = .85 + Math.sin(z.throwWind * 24) * .15;
    const heldR = Math.min(9, Math.max(5, z.shot.radius * .82));
    c.fillStyle = z.shot.held; c.strokeStyle = z.shot.heldEdge; c.lineWidth = 1.2;
    c.beginPath(); c.arc(20, 0, heldR * pulse, 0, 6.283); c.fill(); c.stroke();
  }
  c.restore();
  if (z.hit > 0 && z.hp > 0 && z.maxHp > 1) {
    const w = 24;
    c.fillStyle = 'rgba(10,14,24,.75)'; c.fillRect(z.x - w / 2, z.y - 24, w, 4);
    c.fillStyle = z.mapColor || '#9fd36a'; c.fillRect(z.x - w / 2 + 1, z.y - 23, (w - 2) * z.hp / z.maxHp, 2);
  }
}

function nearestParcel(g) {
  let bestP = null, bd = 1e9;
  for (const b of g.parcels) {
    if (b.got) continue;
    const dx = b.x - g.p.x, dy = b.y - g.p.y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; bestP = b; }
  }
  return bestP;
}

function drawPlayer(c, p, g) {
  if (p.inv > 0 && ((p.inv * 12) | 0) % 2 === 0) return;   // мигание после наезда
  const sw = Math.sin(p.walk) * 3.4;
  c.fillStyle = 'rgba(0,0,0,.28)';
  c.beginPath(); c.ellipse(p.x + 3, p.y + 8, 14, 8, 0, 0, 6.283); c.fill();
  // ноги идут туда, куда бежим — и торчат из-под корпуса, иначе шага не видно
  c.save(); c.translate(p.x, p.y); c.rotate(p.ang); c.scale(1.22, 1.22);
  for (const s of [-1, 1]) {
    const oy = s * 8 + sw * s;
    c.fillStyle = '#38507a'; roundRect(c, -9, oy - 3, 14, 6, 3); c.fill();
    c.fillStyle = '#26314a';
    roundRect(c, 1, oy - 2.5, 5, 5, 2); c.fill();                    // ботинок
  }
  c.restore();

  // корпус развёрнут туда, куда светим и целимся
  c.save(); c.translate(p.x, p.y); c.rotate(p.aim); c.scale(1.22, 1.22);
  // руки: левая держит фонарь, правая — пистолет
  c.fillStyle = '#e8b48a';
  roundRect(c, 1, -11 - sw * .3, 9, 5, 2.5); c.fill();
  roundRect(c, 1, 6 + sw * .3, 9, 5, 2.5); c.fill();
  // корпус + сумка
  c.fillStyle = '#e0603f'; roundRect(c, -10, -9, 20, 18, 6); c.fill();
  c.strokeStyle = 'rgba(0,0,0,.3)'; c.lineWidth = 1.5; c.stroke();
  c.fillStyle = '#b7452c'; roundRect(c, -11, -7, 8, 14, 3); c.fill();
  if (g.got > 0) { c.fillStyle = '#c9a26a'; roundRect(c, -12, -5, 5, 10, 2); c.fill(); }
  // голова
  c.fillStyle = '#f0c39a'; c.beginPath(); c.arc(2, 0, 7.5, 0, 6.283); c.fill();
  c.strokeStyle = 'rgba(0,0,0,.25)'; c.lineWidth = 1.2; c.stroke();
  c.fillStyle = '#3b3630'; c.beginPath(); c.arc(-.5, 0, 7.2, 1.6, 4.7); c.fill();  // затылок/волосы
  c.fillStyle = '#ffd766'; roundRect(c, 3.5, -6, 4.5, 12, 2); c.fill();            // козырёк кепки
  // фонарь в кулаке — отсюда и бьёт луч
  c.fillStyle = '#2f3a46'; roundRect(c, 7, -10.5 - sw * .3, 8, 4.5, 1.5); c.fill();
  if (p.torch && p.batt > 0) {
    c.fillStyle = `rgba(255,242,200,${.5 + .5 * p.flick})`;
    c.fillRect(14.5, -10 - sw * .3, 2.5, 3.5);
  }
  // пистолет
  c.fillStyle = '#33383f'; roundRect(c, 7, 6 + sw * .3, 9, 3.5, 1); c.fill();
  c.restore();
}

// шкалы фонаря и дыхания + кнопка фонаря на телефоне
function drawGauges(g) {
  const p = g.p, x = 16, y = H - 46;
  const bar = (yy, v, col, label, on) => {
    ctx.fillStyle = 'rgba(10,14,26,.6)'; roundRect(ctx, x, yy, 132, 12, 6); ctx.fill();
    ctx.fillStyle = col; roundRect(ctx, x + 2, yy + 2, Math.max(0, 128 * v), 8, 4); ctx.fill();
    ctx.fillStyle = on ? '#e8f0ff' : 'rgba(232,240,255,.45)';
    ctx.font = 'bold 10px Trebuchet MS, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(label, x + 138, yy + 10);
  };
  const low = p.batt < .2 && p.torch;
  bar(y, p.batt, low && Math.sin(g.time * 12) > 0 ? '#ff8b5a' : '#ffd766',
      p.torch ? 'ФОНАРЬ (F)' : 'ФОНАРЬ ВЫКЛ (F)', p.torch);
  bar(y + 18, p.stam, p.stam < .2 ? '#ff8b7a' : '#8ee6a0', 'БЕГ (SHIFT)', p.running);
  ctx.fillStyle = SND.muted ? 'rgba(232,240,255,.4)' : 'rgba(232,240,255,.8)';
  ctx.font = 'bold 10px Trebuchet MS, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(SND.muted ? '♪ ЗВУК ВЫКЛ (M)' : '♪ ЗВУК (M)', x, y - 7);

  if ('ontouchstart' in window) {
    ctx.save();
    ctx.globalAlpha = p.torch ? .9 : .45;
    ctx.strokeStyle = '#ffd766'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(TORCH_BTN.x, TORCH_BTN.y, TORCH_BTN.r, 0, 6.283); ctx.stroke();
    ctx.fillStyle = '#ffd766'; ctx.font = 'bold 12px Trebuchet MS, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('ФОНАРЬ', TORCH_BTN.x, TORCH_BTN.y + 4);
    ctx.restore();
  }
}

function drawMinimap(g) {
  const S = 118, k = S / WORLD, mx = W - S - 12, my = 12;
  // Улицы и дома не меняются в течение уровня: готовим их один раз вместо
  // сотен path/rotate/fill на каждом кадре.
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
  // карта открыта лишь там, где курьер побывал
  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = .94;
  ctx.drawImage(fogCv, 0, 0, FW, FW, mx, my, S, S);
  ctx.globalAlpha = .85;

  for (const c of g.cars) {                      // живое видно только в поле зрения
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
  ctx.fillStyle = '#ffd766';
  for (const b of g.parcels) if (!b.got) { ctx.beginPath(); ctx.arc(mx + b.x * k, my + b.y * k, 2.6, 0, 6.283); ctx.fill(); }
  if (g.got >= g.need) {
    ctx.fillStyle = '#8fe388';
    ctx.beginPath(); ctx.arc(mx + g.goal.x * k, my + g.goal.y * k, 3.4, 0, 6.283); ctx.fill();
  }
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(mx + g.p.x * k, my + g.p.y * k, 3, 0, 6.283); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(mx + g.p.x * k, my + g.p.y * k, 5.5, 0, 6.283); ctx.stroke();
  ctx.restore();
}

return Object.freeze({ drawZombie, nearestParcel, drawPlayer, drawGauges, drawMinimap });
})();

