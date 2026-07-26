// Главный проход отрисовки кадра.
window.TownGame.render = (() => {
'use strict';

const {
  ctx, W, H, WORLD, clamp, rnd, gunHand, roundRect, runtime
} = window.TownGame.core;
const { drawFog, drawRain, drawGlowThroughFog } = window.TownGame.environment;
const { drawCarShape } = window.TownGame.world;
const { drawLight } = window.TownGame.lighting;
const {
  drawZombie, nearestParcel, drawPlayer, drawGauges, drawMinimap
} = window.TownGame.entities;
const legacyPerf = typeof URLSearchParams !== 'undefined' && typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('qa') === 'perf-legacy';

// Пять маленьких спрайтов строятся один раз. Мягкий градиент выглядит естественнее
// жёстких окружностей и заметно дешевле постоянного ctx.filter на старом GPU.
const smokeSprites = Array.from({ length: 5 }, (_, i) => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const c = canvas.getContext('2d'), darkness = .22 + i * .19;
  const grey = Math.round(clamp(172 - darkness * 142, 24, 178));
  const gr = c.createRadialGradient(28, 27, 3, 32, 32, 31);
  gr.addColorStop(0, `rgba(${grey},${grey + 3},${grey + 5},.96)`);
  gr.addColorStop(.43, `rgba(${grey + 7},${grey + 10},${grey + 12},.78)`);
  gr.addColorStop(.78, `rgba(${Math.min(190, grey + 28)},${Math.min(194, grey + 31)},${Math.min(194, grey + 31)},.24)`);
  gr.addColorStop(1, 'rgba(205,210,207,0)');
  c.fillStyle = gr; c.fillRect(0, 0, 64, 64);
  return canvas;
});

// Дым рисуется после ночного света и тумана. Иначе финальное затемнение почти
// полностью съедает тёмные клубы, хотя сами частицы продолжают существовать.
function drawCarSmoke(g, camx, camy) {
  for (const s of g.carSmoke) {
    const x = s.x - camx, y = s.y - camy;
    if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
    const life = clamp(s.l / s.max, 0, 1);
    const darkness = s.darkness === undefined ? .55 : s.darkness;
    const alpha = Math.min(.88, (s.opacity || .5) * Math.pow(life, .55));
    const sprite = smokeSprites[Math.round(clamp((darkness - .22) / .19, 0, 4))];
    const size = s.r * 3.35;
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite, x - size * .5, y - size * .5, size, size);
    // Второй маленький лепесток ломает правильную круглую форму облака.
    ctx.globalAlpha = alpha * .34;
    ctx.drawImage(sprite, x - size * .44, y - size * .47, size * .7, size * .7);
    if (s.hot && life > .58) {
      ctx.globalAlpha = .38 * life; ctx.fillStyle = '#f09a43';
      ctx.beginPath(); ctx.arc(x, y + s.r * .18, s.r * .34, 0, 6.283); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// ---------- отрисовка ----------
function draw(g) {
  const p = g.p;
  let camx = clamp(p.x - W / 2, 0, WORLD - W), camy = clamp(p.y - H / 2, 0, WORLD - H);
  if (g.shake > 0) { camx += rnd(-1, 1) * g.shake * 7; camy += rnd(-1, 1) * g.shake * 7; }
  camx = clamp(camx, 0, WORLD - W); camy = clamp(camy, 0, WORLD - H);
  // Статический город уже обрезается drawImage. Динамику тоже не отправляем в
  // Canvas, если её ограничивающий круг целиком за кадром.
  const visible = (x, y, r = 0) =>
    legacyPerf || (x + r >= camx && y + r >= camy && x - r <= camx + W && y - r <= camy + H);
  const segmentVisible = (x1, y1, x2, y2, r = 0) =>
    legacyPerf || (Math.max(x1, x2) + r >= camx && Math.max(y1, y2) + r >= camy &&
    Math.min(x1, x2) - r <= camx + W && Math.min(y1, y2) - r <= camy + H);

  ctx.drawImage(g.stat, camx, camy, W, H, 0, 0, W, H);
  if (g.weather.wet > .02) {                       // мокрый город темнее и холоднее
    ctx.fillStyle = `rgba(28,46,74,${.2 * g.weather.wet})`;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.save();
  ctx.translate(-camx, -camy);

  // брызги: рисуем до света, чтобы фары и фонарь по ним били
  if (g.splash.length) {
    ctx.lineWidth = 1;
    for (const s of g.splash) {
      if (!visible(s.x, s.y, s.r + 8)) continue;
      const k = 1 - s.l / .3;
      ctx.strokeStyle = `rgba(200,225,255,${(1 - k) * .45})`;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, s.r + k * 7, (s.r + k * 7) * .45, 0, 0, 6.283);
      ctx.stroke();
    }
  }

  // следы от зомби
  for (const s of g.stains) {
    const rgb = s.rgb || [58, 92, 30];
    const radius = s.r || 8, blobs = s.blobs || 4, stretch = s.stretch || 0;
    if (!visible(s.x, s.y, radius * (2.6 + stretch * 2))) continue;
    ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${s.alpha || .5})`;
    for (let k = 0; k < blobs; k++) {
      const a = (s.ang || s.seed * 6.283) + k * 1.7;
      const scale = Math.max(.35, 1 - k / (blobs + 1) * .55);
      const lead = k === 0 ? stretch * radius * 1.7 : 0;
      ctx.beginPath();
      ctx.ellipse(s.x + Math.cos(a) * (radius * .48 + lead), s.y + Math.sin(a) * (radius * .34 + lead),
        Math.max(.8, radius * scale * (1 + stretch * .9)), Math.max(.7, radius * scale * .62), a, 0, 6.283);
      ctx.fill();
      if (s.blood) {
        ctx.strokeStyle = `rgba(${Math.min(190, rgb[0] + 74)},${Math.min(225, rgb[1] + 92)},${Math.min(120, rgb[2] + 46)},.72)`;
        ctx.lineWidth = Math.max(.7, radius * .09); ctx.stroke();
      }
    }
    if (s.blood) {
      ctx.fillStyle = `rgba(${Math.min(205, rgb[0] + 92)},${Math.min(238, rgb[1] + 108)},${Math.min(135, rgb[2] + 58)},.34)`;
      ctx.beginPath(); ctx.ellipse(s.x - radius * .12, s.y - radius * .1,
        Math.max(.7, radius * .34), Math.max(.55, radius * .2), s.ang || 0, 0, 6.283); ctx.fill();
    }
  }

  // свежие шлепки от брошенной гнили постепенно высыхают
  for (const s of g.splats) {
    if (!visible(s.x, s.y, 18)) continue;
    const alpha = clamp(s.l / 2.5, 0, .55);
    const rgb = s.rgb || [104, 126, 42];
    ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
    for (let k = 0; k < 3; k++) {
      const a = s.seed * 6.283 + k * 2.15, r = 4 + k * 1.7;
      ctx.beginPath(); ctx.ellipse(s.x + Math.cos(a) * 7, s.y + Math.sin(a) * 5,
        r * 1.35, r, a, 0, 6.283); ctx.fill();
    }
  }

  // ящики: патроны и батарейки
  for (const a of g.ammoBoxes) {
    if (!visible(a.x, a.y, 16)) continue;
    const bob = Math.sin(a.ph) * 2.5;
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.beginPath(); ctx.ellipse(a.x, a.y + 9, 10, 4.5, 0, 0, 6.283); ctx.fill();
    ctx.save(); ctx.translate(a.x, a.y + bob);
    if (a.batt) {
      ctx.fillStyle = '#2f6b3f'; roundRect(ctx, -7, -10, 14, 20, 3); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#8ee6a0'; ctx.fillRect(-4, -6, 8, 9);
      ctx.fillStyle = '#d8e8c8'; ctx.fillRect(-3, -13, 6, 3);
    } else {
      ctx.fillStyle = '#4a5a3c'; roundRect(ctx, -10, -8, 20, 16, 3); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#d9c48a';
      for (let k = -1; k <= 1; k++) ctx.fillRect(k * 5 - 1.5, -4, 3, 8);
    }
    ctx.restore();
  }

  // кольца шума
  for (const r of g.rings) {
    if (!visible(r.x, r.y, r.r + 3)) continue;
    ctx.strokeStyle = `rgba(255,225,150,${clamp(r.l * .5, 0, .35)})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, 6.283); ctx.stroke();
  }

  // посылки
  for (const b of g.parcels) {
    if (b.got || !visible(b.x, b.y, 18)) continue;
    const bob = Math.sin(b.ph) * 3;
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.beginPath(); ctx.ellipse(b.x, b.y + 10, 11, 5, 0, 0, 6.283); ctx.fill();
    ctx.save(); ctx.translate(b.x, b.y + bob);
    ctx.fillStyle = '#c9a26a'; roundRect(ctx, -11, -11, 22, 22, 3); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = '#e8d3a8'; ctx.fillRect(-11, -3, 22, 6); ctx.fillRect(-3, -11, 6, 22);
    ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(-11, -11, 22, 4);
    ctx.restore();
  }

  // цель — стрелка над дверью, когда всё собрано
  if (g.got >= g.need && !g.done && visible(g.goal.x, g.goal.y, 40)) {
    const bob = Math.sin(g.time * 5) * 4;
    ctx.fillStyle = '#8fe388';
    ctx.beginPath();
    ctx.moveTo(g.goal.x, g.goal.y - 16 + bob);
    ctx.lineTo(g.goal.x - 11, g.goal.y - 34 + bob);
    ctx.lineTo(g.goal.x + 11, g.goal.y - 34 + bob);
    ctx.closePath(); ctx.fill();
  }

  // зомби
  for (const z of g.zombies) if (visible(z.x, z.y, 48)) drawZombie(ctx, z);

  // метательные сгустки: яркая кайма и след дают игроку время заметить угрозу
  for (const s of g.zombieShots) {
    if (!segmentVisible(s.px, s.py, s.x, s.y, s.r + 7)) continue;
    ctx.strokeStyle = s.trail; ctx.lineWidth = Math.max(3, s.r * .58); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(s.px, s.py); ctx.lineTo(s.x, s.y); ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.beginPath(); ctx.ellipse(s.x + 3, s.y + 6, s.r * 1.15, s.r * .58, 0, 0, 6.283); ctx.fill();
    ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.spin);
    ctx.fillStyle = s.body; ctx.strokeStyle = s.edge; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, s.r, 0, 6.283); ctx.fill(); ctx.stroke();
    ctx.fillStyle = s.dark;
    ctx.beginPath(); ctx.arc(s.r * .42, -s.r * .28, s.r * .34, 0, 6.283); ctx.fill();
    ctx.beginPath(); ctx.arc(-s.r * .42, s.r * .28, s.r * .25, 0, 6.283); ctx.fill();
    ctx.restore();
  }
  ctx.lineCap = 'butt';

  // игрок
  drawPlayer(ctx, p, g);

  // пули
  ctx.strokeStyle = '#ffe9a0'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
  for (const b of g.bullets) {
    if (!segmentVisible(b.px, b.py, b.x, b.y, 3)) continue;
    ctx.beginPath(); ctx.moveTo(b.px, b.py); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.lineCap = 'butt';
  if (p.muzzle > 0) {                                  // вспышка у ствола
    const h = gunHand(p), a = Math.atan2(p.ty - h.y, p.tx - h.x);
    const fx = h.x + Math.cos(a) * 9, fy = h.y + Math.sin(a) * 9;
    ctx.fillStyle = 'rgba(255,231,150,.95)';
    ctx.beginPath(); ctx.moveTo(fx + Math.cos(a) * 13, fy + Math.sin(a) * 13);
    ctx.lineTo(fx + Math.cos(a + 2.2) * 8, fy + Math.sin(a + 2.2) * 8);
    ctx.lineTo(fx + Math.cos(a - 2.2) * 8, fy + Math.sin(a - 2.2) * 8);
    ctx.closePath(); ctx.fill();
  }

  // машины
  for (const c of g.cars) {
    if (!visible(c.x, c.y, (c.box && c.box.rad || 32) + 10)) continue;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(Math.atan2(c.hy, c.hx));
    drawCarShape(ctx, c);
    ctx.restore();
  }

  // Летящие капли имеют короткий яркий след и маленькую тень на земле.
  ctx.lineCap = 'round';
  for (const d of (g.bloodDrops || [])) {
    if (!segmentVisible(d.px, d.py, d.x, d.y, d.r + 12)) continue;
    const height = Math.max(0, d.z), airY = d.y - height * .28;
    const prevY = d.py - Math.max(0, d.pz) * .28;
    ctx.globalAlpha = .16; ctx.fillStyle = '#071006';
    ctx.beginPath(); ctx.ellipse(d.x + 2, d.y + 3, d.r * .9, d.r * .45, 0, 0, 6.283); ctx.fill();
    ctx.globalAlpha = .86; ctx.strokeStyle = d.c; ctx.lineWidth = Math.max(1.2, d.r * .72);
    ctx.beginPath(); ctx.moveTo(d.px, prevY); ctx.lineTo(d.x, airY); ctx.stroke();
    ctx.fillStyle = d.c; ctx.beginPath(); ctx.arc(d.x, airY, d.r, 0, 6.283); ctx.fill();
    ctx.globalAlpha = .34; ctx.fillStyle = '#d1f47a';
    ctx.beginPath(); ctx.arc(d.x - d.r * .25, airY - d.r * .25, d.r * .34, 0, 6.283); ctx.fill();
  }
  ctx.lineCap = 'butt'; ctx.globalAlpha = 1;

  // частицы
  for (const q of g.parts) {
    if (!visible(q.x, q.y, q.s + 2)) continue;
    ctx.globalAlpha = clamp(q.l * 1.6, 0, 1);
    ctx.fillStyle = q.c;
    ctx.fillRect(q.x - q.s / 2, q.y - q.s / 2, q.s, q.s);
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  drawLight(g, camx, camy);
  drawFog(g, camx, camy);
  drawGlowThroughFog(g, camx, camy);
  drawCarSmoke(g, camx, camy);
  if (g.weather.flash > 0) {                       // молния бьёт поверх тумана
    ctx.fillStyle = `rgba(226,238,255,${Math.min(.55, g.weather.flash * g.weather.flash * .7)})`;
    ctx.fillRect(0, 0, W, H);
  }
  drawRain(g);

  // виньетка при уроне
  if (p.inv > 1.2) {
    ctx.fillStyle = `rgba(220,60,50,${(p.inv - 1.2) * .45})`;
    ctx.fillRect(0, 0, W, H);
  }

  // указатель на ближайшую цель за краем экрана
  const tgt = g.got >= g.need ? g.goal : nearestParcel(g);
  if (tgt) {
    const sx = tgt.x - camx, sy = tgt.y - camy;
    if (sx < 20 || sy < 20 || sx > W - 20 || sy > H - 20) {
      // упираем стрелку в рамку экрана, а не в окружность
      const a = Math.atan2(sy - H / 2, sx - W / 2);
      const ca = Math.cos(a), sa = Math.sin(a);
      const t = Math.min(Math.abs((W / 2 - 26) / (ca || 1e-6)), Math.abs((H / 2 - 26) / (sa || 1e-6)));
      const ex = W / 2 + ca * t, ey = H / 2 + sa * t;
      ctx.save(); ctx.translate(ex, ey); ctx.rotate(a);
      ctx.fillStyle = g.got >= g.need ? 'rgba(143,227,136,.9)' : 'rgba(255,215,102,.9)';
      ctx.beginPath(); ctx.moveTo(13, 0); ctx.lineTo(-9, -9); ctx.lineTo(-9, 9); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  drawGauges(g);
  drawMinimap(g);

  // подсказка про огонь на телефоне
  if ('ontouchstart' in window) {
    ctx.save();
    ctx.globalAlpha = runtime.fireHeld ? .9 : .4;
    ctx.strokeStyle = '#ffd766'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(W - 62, H - 62, 34, 0, 6.283); ctx.stroke();
    ctx.fillStyle = '#ffd766'; ctx.font = 'bold 13px Trebuchet MS, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('ОГОНЬ', W - 62, H - 57);
    ctx.restore();
  }

  // джойстик на телефоне
  if (runtime.touch) {
    const touch = runtime.touch;
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(touch.ox, touch.oy, 42, 0, 6.283); ctx.stroke();
    const dx = touch.x - touch.ox, dy = touch.y - touch.oy, d = Math.hypot(dx, dy) || 1;
    const k = Math.min(d, 42) / d;
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.beginPath(); ctx.arc(touch.ox + dx * k, touch.oy + dy * k, 17, 0, 6.283); ctx.fill();
  }
}

return Object.freeze({ draw });
})();

