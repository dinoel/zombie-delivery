// Characters, status gauges, and minimap.
window.TownGame.entities = (() => {
'use strict';

const { ctx, W, H, WORLD, ROAD, clamp, roundRect } = window.TownGame.core;
const SND = window.TownGame.audio;
const { FW, fogCv, fogAt } = window.TownGame.environment;
const { TORCH_BTN } = window.TownGame.input;

// Awareness arc above a zombie that has started to notice the courier but has not
// locked on yet. Without it stealth reads as random luck.
function drawNotice(c, z) {
  const S = z.size || 1, r = 15 * S, y = z.y - 21 * S;
  if (z.hunt > 0) {
    c.save();
    c.fillStyle = 'rgba(50,10,14,.88)'; c.strokeStyle = '#ff6b5a'; c.lineWidth = 2;
    c.beginPath(); c.arc(z.x, y, 8 * S, 0, 6.283); c.fill(); c.stroke();
    c.fillStyle = '#fff0df'; c.font = `bold ${Math.round(12 * S)}px Trebuchet MS, sans-serif`;
    c.textAlign = 'center'; c.fillText('!', z.x, y + 4 * S); c.restore();
    return;
  }
  if (z.notice <= .04) return;
  c.save();
  c.lineWidth = 2.6; c.lineCap = 'round';
  c.strokeStyle = 'rgba(12,16,24,.55)';
  c.beginPath(); c.arc(z.x, y, r, -2.35, -.79); c.stroke();
  c.strokeStyle = z.notice > .7 ? '#ff9a5a' : '#ffd766';
  c.beginPath(); c.arc(z.x, y, r, -2.35, -2.35 + 1.56 * z.notice); c.stroke();
  c.restore();
}

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
  const S = z.size || 1;
  c.fillStyle = 'rgba(0,0,0,.3)';
  c.beginPath(); c.ellipse(z.x + 3 * S, z.y + 8 * S, 13 * S, 7.5 * S, 0, 0, 6.283); c.fill();
  c.save(); c.translate(z.x, z.y); c.rotate(z.ang); if (S !== 1) c.scale(S, S);
  const skin = z.hit > 0 ? '#ffd2d2' : (z.skin || '#8fae63');
  // Outstretched arms.
  c.fillStyle = skin;
  for (const side of [-1, 1]) {
    const armY = side < 0 ? -12 - sw * .5 : 7 + sw * .5;
    const missing = z.lostArms >= 2 || (z.lostArms >= 1 && side === (z.armOrder || 1));
    if (!missing) { roundRect(c, 4, armY, 16, 5, 2.5); c.fill(); }
    else {
      c.fillStyle = z.clothes || '#5d6b4a'; roundRect(c, 4, armY, 6, 5, 2); c.fill();
      c.fillStyle = z.blood && z.blood[0] || '#8fd34f';
      c.beginPath(); c.arc(9, armY + 2.5, 2.4, 0, 6.283); c.fill();
      c.fillStyle = skin;
    }
  }
  // Legs.
  c.fillStyle = '#4a4436';
  roundRect(c, -5, -8 + sw, 11, 6, 3); c.fill();
  roundRect(c, -5, 2 - sw, 11, 6, 3); c.fill();
  // Torn clothing.
  c.fillStyle = z.hit > 0 ? '#e9b6b6' : (z.clothes || '#5d6b4a');
  roundRect(c, -10, -9, 19, 18, 6); c.fill();
  c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1.5; c.stroke();
  if (z.guardParcel >= 0) {
    c.fillStyle = '#e2b84e'; roundRect(c, -1, -10, 6, 4, 1); c.fill();
  }
  if (z.dumb) {                                  // Slab shoulders read as bulk, not as a blown-up walker.
    c.fillStyle = '#2f3742';
    roundRect(c, -7, -13, 13, 5, 2); c.fill();
    roundRect(c, -7, 8, 13, 5, 2); c.fill();
    c.fillStyle = 'rgba(255,255,255,.08)';
    roundRect(c, -8, -7, 7, 14, 3); c.fill();
  }
  c.fillStyle = 'rgba(0,0,0,.18)';
  c.beginPath(); c.arc(-2 + z.seed * 4, -3, 3.5, 0, 6.283); c.fill();
  // Head, or the wet neck stump after enough damage.
  if (!z.headless) {
    c.fillStyle = skin;
    c.beginPath(); c.arc(2, 0, 7.5, 0, 6.283); c.fill();
    c.strokeStyle = 'rgba(0,0,0,.3)'; c.lineWidth = 1.2; c.stroke();
    c.fillStyle = '#7b3b2a';
    c.beginPath(); c.arc(-1, 0, 7.2, 1.7, 4.6); c.fill();
    c.fillStyle = z.eye || '#ff5a45';
    c.beginPath(); c.arc(6, -2.6, 1.7, 0, 6.283); c.fill();
    c.beginPath(); c.arc(6, 2.6, 1.7, 0, 6.283); c.fill();
  } else {
    c.fillStyle = '#26301e'; c.beginPath(); c.arc(4, 0, 4.6, 0, 6.283); c.fill();
    c.fillStyle = z.blood && z.blood[0] || '#8fd34f';
    c.beginPath(); c.arc(4.8, 0, 2.8, 0, 6.283); c.fill();
  }
  if (z.throwWind > 0 && z.lostArms < 2 && !z.headless) {
    const pulse = .85 + Math.sin(z.throwWind * 24) * .15;
    const heldR = Math.min(9, Math.max(5, z.shot.radius * .82));
    c.fillStyle = z.shot.held; c.strokeStyle = z.shot.heldEdge; c.lineWidth = 1.2;
    c.beginPath(); c.arc(20, 0, heldR * pulse, 0, 6.283); c.fill(); c.stroke();
  }
  c.restore();
  if (z.hit > 0 && z.hp > 0 && z.maxHp > 1) {
    const w = 24 * S, top = z.y - 24 * S;
    c.fillStyle = 'rgba(10,14,24,.75)'; c.fillRect(z.x - w / 2, top, w, 4);
    c.fillStyle = z.mapColor || '#9fd36a'; c.fillRect(z.x - w / 2 + 1, top + 1, (w - 2) * z.hp / z.maxHp, 2);
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
  if (p.inv > 0 && ((p.inv * 12) | 0) % 2 === 0) return;   // Flash after an impact.
  const crawling = p.sneaking, sw = Math.sin(p.walk) * 3.4;

  if (crawling) {
    const stride = Math.sin(p.walk) * 1.8, sway = Math.cos(p.walk) * .7;
    c.save(); c.translate(p.x, p.y); c.rotate(p.aim);
    c.fillStyle = 'rgba(0,0,0,.25)';
    c.beginPath(); c.ellipse(-2, 4, 22, 8.5, 0, 0, 6.283); c.fill();

    // A purpose-built top-down crawl pose: alternating legs extend behind the torso.
    for (const side of [-1, 1]) {
      const lx = -17 + stride * side, ly = side * 5 + sway * side;
      c.fillStyle = '#38507a'; roundRect(c, lx, ly - 2.8, 14, 5.6, 2.8); c.fill();
      c.fillStyle = '#26314a'; roundRect(c, lx - 4, ly - 2.5, 6, 5, 2); c.fill();
    }

    // Arms reach forward in opposition to the legs, giving the crawl a readable cycle.
    for (const side of [-1, 1]) {
      const reach = stride * -side;
      c.fillStyle = '#e8b48a'; roundRect(c, -1 + reach, side * 9 - 2.4, 14, 4.8, 2.4); c.fill();
      c.beginPath(); c.arc(13 + reach, side * 9, 2.8, 0, 6.283); c.fill();
    }

    // Backpack and torso retain their full width; nothing is globally squashed.
    c.fillStyle = '#b7452c'; roundRect(c, -12, -6.5, 8, 13, 3); c.fill();
    if (g.got > 0) { c.fillStyle = '#c9a26a'; roundRect(c, -14, -5, 5, 10, 2); c.fill(); }
    c.fillStyle = '#e0603f'; roundRect(c, -8, -8, 19, 16, 6); c.fill();
    c.strokeStyle = 'rgba(0,0,0,.3)'; c.lineWidth = 1.5; c.stroke();

    // Head and cap point forward, making the facing direction obvious from above.
    c.fillStyle = '#f0c39a'; c.beginPath(); c.arc(10, 0, 7.2, 0, 6.283); c.fill();
    c.strokeStyle = 'rgba(0,0,0,.25)'; c.lineWidth = 1.2; c.stroke();
    c.fillStyle = '#3b3630'; c.beginPath(); c.arc(8, 0, 6.8, 1.55, 4.73); c.fill();
    c.fillStyle = '#ffd766'; roundRect(c, 14, -5.5, 4.5, 11, 2); c.fill();

    c.fillStyle = '#2f3a46'; roundRect(c, 12 - stride, -11, 9, 4.5, 1.5); c.fill();
    if (p.torch && p.batt > 0) {
      c.fillStyle = `rgba(255,242,200,${.5 + .5 * p.flick})`;
      c.fillRect(20.5 - stride, -10.5, 2.5, 3.5);
    }
    c.fillStyle = '#33383f'; roundRect(c, 12 + stride, 7.2, 10, 3.5, 1); c.fill();
    c.restore();
    return;
  }

  c.fillStyle = 'rgba(0,0,0,.28)';
  c.beginPath(); c.ellipse(p.x + 3, p.y + 8, 14, 8, 0, 0, 6.283); c.fill();
  // Legs face the movement direction and protrude from the body so the stride remains visible.
  c.save(); c.translate(p.x, p.y); c.rotate(p.ang); c.scale(1.22, 1.22);
  for (const s of [-1, 1]) {
    const oy = s * 8 + sw * s;
    c.fillStyle = '#38507a'; roundRect(c, -9, oy - 3, 14, 6, 3); c.fill();
    c.fillStyle = '#26314a';
    roundRect(c, 1, oy - 2.5, 5, 5, 2); c.fill();                    // Boot.
  }
  c.restore();

  // The torso faces the aim and flashlight direction.
  c.save(); c.translate(p.x, p.y); c.rotate(p.aim); c.scale(1.22, 1.22);
  // Left hand holds the flashlight; right hand holds the pistol.
  c.fillStyle = '#e8b48a';
  roundRect(c, 1, -11 - sw * .3, 9, 5, 2.5); c.fill();
  roundRect(c, 1, 6 + sw * .3, 9, 5, 2.5); c.fill();
  // Torso and bag.
  c.fillStyle = '#e0603f'; roundRect(c, -10, -9, 20, 18, 6); c.fill();
  c.strokeStyle = 'rgba(0,0,0,.3)'; c.lineWidth = 1.5; c.stroke();
  c.fillStyle = '#b7452c'; roundRect(c, -11, -7, 8, 14, 3); c.fill();
  if (g.got > 0) { c.fillStyle = '#c9a26a'; roundRect(c, -12, -5, 5, 10, 2); c.fill(); }
  // Head.
  c.fillStyle = '#f0c39a'; c.beginPath(); c.arc(2, 0, 7.5, 0, 6.283); c.fill();
  c.strokeStyle = 'rgba(0,0,0,.25)'; c.lineWidth = 1.2; c.stroke();
  c.fillStyle = '#3b3630'; c.beginPath(); c.arc(-.5, 0, 7.2, 1.6, 4.7); c.fill();  // Back of the head and hair.
  c.fillStyle = '#ffd766'; roundRect(c, 3.5, -6, 4.5, 12, 2); c.fill();            // Cap visor.
  // The flashlight beam originates from the fist.
  c.fillStyle = '#2f3a46'; roundRect(c, 7, -10.5 - sw * .3, 8, 4.5, 1.5); c.fill();
  if (p.torch && p.batt > 0) {
    c.fillStyle = `rgba(255,242,200,${.5 + .5 * p.flick})`;
    c.fillRect(14.5, -10 - sw * .3, 2.5, 3.5);
  }
  // Pistol.
  c.fillStyle = '#33383f'; roundRect(c, 7, 6 + sw * .3, 9, 3.5, 1); c.fill();
  c.restore();
}

// Flashlight and stamina gauges, plus the mobile flashlight button.
function drawGauges(g) {
  const p = g.p, x = 16, y = H - 46;
  const bar = (yy, v, col, label, on) => {
    ctx.fillStyle = 'rgba(10,14,26,.6)'; roundRect(ctx, x, yy, 132, 12, 6); ctx.fill();
    if (v > .005) { ctx.fillStyle = col; roundRect(ctx, x + 2, yy + 2, Math.max(0, 128 * v), 8, 4); ctx.fill(); }
    ctx.fillStyle = on ? '#e8f0ff' : 'rgba(232,240,255,.45)';
    ctx.font = 'bold 10px Trebuchet MS, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(label, x + 138, yy + 10);
  };
  const low = p.batt < .2 && p.torch;
  bar(y, p.batt, low && Math.sin(g.time * 12) > 0 ? '#ff8b5a' : '#ffd766',
      p.torch ? 'FLASHLIGHT (F)' : 'FLASHLIGHT OFF (F)', p.torch);
  bar(y + 18, p.stam, p.stam < .2 ? '#ff8b7a' : '#8ee6a0', 'SPRINT (SHIFT)', p.running);
  const awareness = clamp(g.stealthNotice || 0, 0, 1);
  const stealthLabel = g.stealthDetected ? 'DETECTED' : awareness > .68 ? 'DANGER' :
    awareness > .04 ? `SUSPICION ${Math.round(awareness * 100)}%` :
    p.sneaking ? 'HIDDEN · CRAWLING (C: STAND)' : 'HIDDEN · C: CROUCH';
  const stealthColor = g.stealthDetected ? (Math.sin(g.time * 15) > 0 ? '#fff0a0' : '#ff5b4d') :
    awareness > .68 ? '#ff9a5a' : '#ffd766';
  bar(y - 20, awareness, stealthColor, stealthLabel, p.sneaking || awareness > .04 || g.stealthDetected);
  ctx.fillStyle = SND.muted ? 'rgba(232,240,255,.4)' : 'rgba(232,240,255,.8)';
  ctx.font = 'bold 10px Trebuchet MS, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(SND.muted ? '♪ SOUND OFF (M)' : '♪ SOUND (M)', x, y - 29);

  if ('ontouchstart' in window) {
    ctx.save();
    ctx.globalAlpha = p.torch ? .9 : .45;
    ctx.strokeStyle = '#ffd766'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(TORCH_BTN.x, TORCH_BTN.y, TORCH_BTN.r, 0, 6.283); ctx.stroke();
    ctx.fillStyle = '#ffd766'; ctx.font = 'bold 12px Trebuchet MS, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('LIGHT', TORCH_BTN.x, TORCH_BTN.y + 4);
    ctx.restore();
  }
}

function drawMinimap(g) {
  const S = 118, k = S / WORLD, mx = W - S - 12, my = 12;
  // Roads and houses do not change during a level, so prepare them once instead
  // of issuing hundreds of path, rotate, and fill operations every frame.
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
  // The map is revealed only where the courier has explored.
  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = .94;
  ctx.drawImage(fogCv, 0, 0, FW, FW, mx, my, S, S);
  ctx.globalAlpha = .85;

  for (const c of g.cars) {                      // Moving objects are visible only within sight.
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
  ctx.fillStyle = '#a9e6b0';
  for (const m of g.cash) if (fogAt(g, m.x, m.y) > 0)
    ctx.fillRect(mx + m.x * k - 1, my + m.y * k - 1, 2, 2);
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

return Object.freeze({ drawZombie, drawNotice, nearestParcel, drawPlayer, drawGauges, drawMinimap });
})();

