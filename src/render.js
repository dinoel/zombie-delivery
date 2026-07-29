// Main frame rendering pass.
window.TownGame.render = (() => {
'use strict';

const {
  ctx, W, H, WORLD, clamp, rnd, gunHand, roundRect, runtime
} = window.TownGame.core;
const { drawFog, drawRain, drawGlowThroughFog } = window.TownGame.environment;
const { drawCarShape, drawLamp } = window.TownGame.world;
const { drawLight } = window.TownGame.lighting;
const {
  drawZombie, drawNotice, nearestParcel, nearestDrop, drawPlayer, drawGauges, drawMinimap
} = window.TownGame.entities;
const legacyPerf = typeof URLSearchParams !== 'undefined' && typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('qa') === 'perf-legacy';

// Five small sprites are built once. A soft gradient looks more natural than hard
// circles and costs far less than applying ctx.filter continuously on an old GPU.
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

// Smoke is drawn after night lighting and fog. Otherwise the final darkening pass
// almost completely hides dark clouds even though their particles still exist.
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
    // A second small lobe breaks up the cloud's perfectly circular shape.
    ctx.globalAlpha = alpha * .34;
    ctx.drawImage(sprite, x - size * .44, y - size * .47, size * .7, size * .7);
    if (s.hot && life > .58) {
      ctx.globalAlpha = .38 * life; ctx.fillStyle = '#f09a43';
      ctx.beginPath(); ctx.arc(x, y + s.r * .18, s.r * .34, 0, 6.283); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function drawZombiePart(part) {
  const height = Math.max(0, part.h), size = part.size || 1;
  ctx.globalAlpha = Math.min(1, part.l * .5);
  ctx.fillStyle = 'rgba(0,0,0,.28)';
  ctx.beginPath(); ctx.ellipse(part.x + 2, part.y + 4, (part.kind === 'head' ? 8 : 10) * size,
    (part.kind === 'head' ? 4 : 3.5) * size, 0, 0, 6.283); ctx.fill();
  ctx.save();
  ctx.translate(part.x, part.y - height * .28);
  ctx.rotate(part.ang);
  if (size !== 1) ctx.scale(size, size);
  if (part.kind === 'arm') {
    ctx.fillStyle = part.skin; roundRect(ctx, -8, -2.5, 17, 5, 2.5); ctx.fill();
    ctx.fillStyle = part.blood && part.blood[0] || '#8fd34f';
    ctx.beginPath(); ctx.arc(-7.5, 0, 2.5, 0, 6.283); ctx.fill();
    ctx.fillStyle = 'rgba(210,255,145,.42)';
    ctx.beginPath(); ctx.arc(-8, -.6, 1, 0, 6.283); ctx.fill();
  } else {
    ctx.fillStyle = part.skin; ctx.beginPath(); ctx.arc(0, 0, 7.5, 0, 6.283); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = '#7b3b2a'; ctx.beginPath(); ctx.arc(-3, 0, 6.8, 1.7, 4.6); ctx.fill();
    ctx.fillStyle = part.eye; ctx.beginPath(); ctx.arc(4, -2.5, 1.6, 0, 6.283); ctx.fill();
    ctx.beginPath(); ctx.arc(4, 2.5, 1.6, 0, 6.283); ctx.fill();
    ctx.fillStyle = part.blood && part.blood[0] || '#8fd34f';
    ctx.beginPath(); ctx.arc(-6.4, 0, 2.2, 0, 6.283); ctx.fill();
    if (part.explosive && part.heat > 0) {
      const heat = clamp(part.heat, 0, 1), pulse = .5 + Math.sin(performance.now() * .018) * .5;
      ctx.fillStyle = `rgba(255,35,24,${.08 + heat * .64})`;
      ctx.beginPath(); ctx.arc(0, 0, 7.6, 0, 6.283); ctx.fill();
      ctx.strokeStyle = `rgba(255,180,72,${.3 + heat * .55 + pulse * heat * .12})`;
      ctx.lineWidth = .7 + heat * 1.4;
      ctx.beginPath(); ctx.arc(0, 0, 8.2 + pulse * heat * 1.4, 0, 6.283); ctx.stroke();
      ctx.strokeStyle = `rgba(79,10,4,${.42 + heat * .48})`; ctx.lineWidth = .8;
      for (let k = 0; k < (part.shotHits || 0); k++) {
        const a = -.9 + k * 1.37;
        ctx.beginPath(); ctx.moveTo(Math.cos(a) * 2, Math.sin(a) * 2);
        ctx.lineTo(Math.cos(a + .16) * 5.2, Math.sin(a + .16) * 5.2);
        ctx.lineTo(Math.cos(a - .12) * 7.3, Math.sin(a - .12) * 7.3); ctx.stroke();
      }
      ctx.fillStyle = `rgba(255,238,180,${.3 + heat * .68})`;
      ctx.beginPath(); ctx.arc(4, -2.5, 1.25 + heat * .55, 0, 6.283); ctx.fill();
      ctx.beginPath(); ctx.arc(4, 2.5, 1.25 + heat * .55, 0, 6.283); ctx.fill();
      if (part.hitFlash > 0) {
        ctx.fillStyle = `rgba(255,255,224,${clamp(part.hitFlash * 3.8, 0, .82)})`;
        ctx.beginPath(); ctx.arc(0, 0, 8.1, 0, 6.283); ctx.fill();
      }
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// The blast is composited above night lighting and fog so its flash and expanding
// pressure ring stay readable even in bad weather.
function drawBlastOverlays(g, camx, camy) {
  for (const blast of (g.blasts || [])) {
    const x = blast.x - camx, y = blast.y - camy;
    if (x < -blast.maxR || y < -blast.maxR || x > W + blast.maxR || y > H + blast.maxR) continue;
    const life = clamp(blast.l / blast.max, 0, 1), progress = 1 - life;
    const flash = clamp(1 - progress * 2.4, 0, 1), glowRadius = 30 + blast.r * .72;
    const glow = ctx.createRadialGradient(x, y, 2, x, y, glowRadius);
    glow.addColorStop(0, `rgba(255,255,224,${.82 * flash + .12 * life})`);
    glow.addColorStop(.16, `rgba(255,188,54,${.72 * life})`);
    glow.addColorStop(.43, `rgba(255,65,32,${.4 * life})`);
    glow.addColorStop(.7, `rgba(124,220,48,${.22 * life})`);
    glow.addColorStop(1, 'rgba(64,145,30,0)');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, glowRadius, 0, 6.283); ctx.fill();

    ctx.globalAlpha = Math.pow(life, .55);
    ctx.strokeStyle = '#fff2a0'; ctx.lineWidth = 2 + life * 8;
    ctx.beginPath(); ctx.arc(x, y, blast.r, 0, 6.283); ctx.stroke();
    ctx.globalAlpha = Math.pow(life, .8) * .72;
    ctx.strokeStyle = '#82e444'; ctx.lineWidth = 1.5 + life * 5;
    ctx.beginPath(); ctx.arc(x, y, blast.r * .68, 0, 6.283); ctx.stroke();

    if (flash > 0) {
      ctx.globalAlpha = flash;
      ctx.fillStyle = '#fff8d2'; ctx.beginPath(); ctx.arc(x, y, 11 + flash * 28, 0, 6.283); ctx.fill();
      ctx.strokeStyle = '#ffb238'; ctx.lineWidth = 5;
      for (let k = 0; k < 12; k++) {
        const a = blast.seed * 31 + k * .524, inner = 18 + (k % 3) * 4, outer = 50 + flash * (26 + (k % 4) * 9);
        ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * inner, y + Math.sin(a) * inner);
        ctx.lineTo(x + Math.cos(a) * outer, y + Math.sin(a) * outer); ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;
}

// ---------- rendering ----------
function draw(g) {
  const p = g.p;
  let camx = clamp(p.x - W / 2, 0, WORLD - W), camy = clamp(p.y - H / 2, 0, WORLD - H);
  if (g.shake > 0) { camx += rnd(-1, 1) * g.shake * 7; camy += rnd(-1, 1) * g.shake * 7; }
  camx = clamp(camx, 0, WORLD - W); camy = clamp(camy, 0, WORLD - H);
  // drawImage already clips the static town. Skip dynamic objects whose bounding
  // circle is completely outside the viewport as well.
  const visible = (x, y, r = 0) =>
    legacyPerf || (x + r >= camx && y + r >= camy && x - r <= camx + W && y - r <= camy + H);
  const segmentVisible = (x1, y1, x2, y2, r = 0) =>
    legacyPerf || (Math.max(x1, x2) + r >= camx && Math.max(y1, y2) + r >= camy &&
    Math.min(x1, x2) - r <= camx + W && Math.min(y1, y2) - r <= camy + H);

  ctx.drawImage(g.stat, camx, camy, W, H, 0, 0, W, H);
  if (g.weather.wet > .02) {                       // A wet town looks darker and colder.
    ctx.fillStyle = `rgba(28,46,74,${.2 * g.weather.wet})`;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.save();
  ctx.translate(-camx, -camy);

  // Draw splashes before lighting so headlights and the flashlight illuminate them.
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

  // Zombie stains.
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

  // Fresh filth splats gradually dry out.
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

  // Ammo and battery boxes.
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

  // Cash dropped by the horde.
  for (const m of g.cash) {
    if (!visible(m.x, m.y, 14)) continue;
    const bob = Math.sin(m.ph) * 1.5;
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.beginPath(); ctx.ellipse(m.x, m.y + 6, 8, 3.5, 0, 0, 6.283); ctx.fill();
    ctx.save(); ctx.translate(m.x, m.y + bob); ctx.rotate(m.tilt);
    ctx.fillStyle = '#5f9c62'; roundRect(ctx, -9, -5.5, 18, 11, 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#cfe8c4';
    ctx.beginPath(); ctx.arc(0, 0, 2.5, 0, 6.283); ctx.fill();      // The face on the note.
    ctx.fillRect(-7.5, -3.5, 1.5, 7); ctx.fillRect(6, -3.5, 1.5, 7);
    ctx.restore();
  }

  // Noise rings.
  for (const r of g.rings) {
    if (!visible(r.x, r.y, r.r + 3)) continue;
    ctx.strokeStyle = `rgba(255,225,150,${clamp(r.l * .5, 0, .35)})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, 6.283); ctx.stroke();
  }

  // Parcels waiting on the ground.
  for (const b of g.parcels) {
    if (b.state !== 'ground' || !visible(b.x, b.y, 18)) continue;
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

  // The door each carried parcel is addressed to. Nothing is marked before the pickup and
  // nothing stays marked after the delivery, so the street only ever shows live work.
  if (!g.done) for (const b of g.parcels) {
    if (b.state !== 'carried' || !visible(b.dest.x, b.dest.y, 40)) continue;
    const bob = Math.sin(g.time * 5 + b.ph) * 4;
    ctx.fillStyle = 'rgba(143,227,136,.22)';
    ctx.beginPath(); ctx.ellipse(b.dest.x, b.dest.y, 26, 13, 0, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#8fe388';
    ctx.beginPath();
    ctx.moveTo(b.dest.x, b.dest.y - 16 + bob);
    ctx.lineTo(b.dest.x - 11, b.dest.y - 34 + bob);
    ctx.lineTo(b.dest.x + 11, b.dest.y - 34 + bob);
    ctx.closePath(); ctx.fill();
  }

  // A parcel the courier has no hand left for.
  if (p.handsFull && visible(p.handsFull.x, p.handsFull.y, 30)) {
    ctx.save();
    ctx.globalAlpha = .55 + .45 * Math.sin(g.time * 7);
    ctx.fillStyle = '#ffd766';
    ctx.font = 'bold 11px Trebuchet MS, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('HANDS FULL', p.handsFull.x, p.handsFull.y - 22);
    ctx.restore();
  }

  // Zombies.
  for (const z of g.zombies) if (visible(z.x, z.y, 48)) { drawZombie(ctx, z); drawNotice(ctx, z); }

  // Prompt over a zombie that can be finished silently right now.
  if (p.finishTarget) {
    const z = p.finishTarget;
    ctx.save();
    ctx.globalAlpha = .55 + .45 * Math.sin(g.time * 7);
    ctx.fillStyle = '#e8f0ff';
    ctx.font = 'bold 11px Trebuchet MS, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('E', z.x, z.y - 24);
    ctx.strokeStyle = 'rgba(232,240,255,.7)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(z.x, z.y, 17, 0, 6.283); ctx.stroke();
    ctx.restore();
  }

  // Thrown filth: a bright outline and trail give the player time to spot the threat.
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

  // Player.
  drawPlayer(ctx, p, g);

  // Bullets.
  // Two passes: the courier's tracer is warm, the patrol's is cold.
  ctx.lineCap = 'round';
  for (let pass = 0; pass < 2; pass++) {
    ctx.strokeStyle = pass ? '#cfe4ff' : '#ffe9a0';
    ctx.lineWidth = pass ? 2 : 2.5;
    ctx.beginPath();
    let any = false;
    for (const b of g.bullets) {
      if (!!b.own !== !!pass) continue;
      if (!segmentVisible(b.px, b.py, b.x, b.y, 3)) continue;
      ctx.moveTo(b.px, b.py); ctx.lineTo(b.x, b.y); any = true;
    }
    if (any) ctx.stroke();
  }
  ctx.lineCap = 'butt';
  if (p.muzzle > 0) {                                  // Muzzle flash.
    const h = gunHand(p), a = Math.atan2(p.ty - h.y, p.tx - h.x);
    const fx = h.x + Math.cos(a) * 9, fy = h.y + Math.sin(a) * 9;
    ctx.fillStyle = 'rgba(255,231,150,.95)';
    ctx.beginPath(); ctx.moveTo(fx + Math.cos(a) * 13, fy + Math.sin(a) * 13);
    ctx.lineTo(fx + Math.cos(a + 2.2) * 8, fy + Math.sin(a + 2.2) * 8);
    ctx.lineTo(fx + Math.cos(a - 2.2) * 8, fy + Math.sin(a - 2.2) * 8);
    ctx.closePath(); ctx.fill();
  }

  // Cars.
  for (const c of g.cars) {
    if (!visible(c.x, c.y, (c.box && c.box.rad || 32) + 10)) continue;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(Math.atan2(c.hy, c.hx));
    drawCarShape(ctx, c);
    if (c.copFlash > 0) {                              // Muzzle flash in the open side window.
      const s = c.copSide, a = clamp(c.copFlash / .07, 0, 1);
      ctx.fillStyle = `rgba(255,241,200,${.85 * a})`;
      ctx.beginPath();
      ctx.moveTo(0, s * (8.3 + 10 * a));
      ctx.lineTo(-5.5, s * 8.3);
      ctx.lineTo(5.5, s * 8.3);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  // Street lamps hang above the street, so they pass over the traffic and the courier.
  for (const l of g.lamps) if (visible(l.x, l.y, 56)) drawLamp(ctx, l);

  // Detached parts mark the fight; heads remain until the district is rebuilt.
  for (const part of (g.zombieParts || [])) {
    if (!visible(part.x, part.y, 22 * (part.size || 1))) continue;
    drawZombiePart(part);
  }

  // Airborne droplets have a short bright trail and a small ground shadow.
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

  // Particles.
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
  drawBlastOverlays(g, camx, camy);
  drawCarSmoke(g, camx, camy);
  if (g.weather.flash > 0) {                       // Lightning flashes above the fog layer.
    ctx.fillStyle = `rgba(226,238,255,${Math.min(.55, g.weather.flash * g.weather.flash * .7)})`;
    ctx.fillRect(0, 0, W, H);
  }
  drawRain(g);

  // Damage vignette.
  if (p.inv > 1.2) {
    ctx.fillStyle = `rgba(220,60,50,${(p.inv - 1.2) * .45})`;
    ctx.fillRect(0, 0, W, H);
  }

  // Off-screen pointer to the nearest objective: a door while carrying, otherwise the next
  // parcel to pick up.
  const drop = nearestDrop(g);
  const tgt = drop || nearestParcel(g);
  if (tgt) {
    const sx = tgt.x - camx, sy = tgt.y - camy;
    if (sx < 20 || sy < 20 || sx > W - 20 || sy > H - 20) {
      // Clamp the arrow to the screen frame rather than to a circle.
      const a = Math.atan2(sy - H / 2, sx - W / 2);
      const ca = Math.cos(a), sa = Math.sin(a);
      const t = Math.min(Math.abs((W / 2 - 26) / (ca || 1e-6)), Math.abs((H / 2 - 26) / (sa || 1e-6)));
      const ex = W / 2 + ca * t, ey = H / 2 + sa * t;
      ctx.save(); ctx.translate(ex, ey); ctx.rotate(a);
      ctx.fillStyle = drop ? 'rgba(143,227,136,.9)' : 'rgba(255,215,102,.9)';
      ctx.beginPath(); ctx.moveTo(13, 0); ctx.lineTo(-9, -9); ctx.lineTo(-9, 9); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  drawGauges(g);
  drawMinimap(g);

  // Paused: the frame stays on screen, dimmed, so the player keeps their bearings.
  if (runtime.state === 'paused') {
    ctx.fillStyle = 'rgba(8,12,22,.58)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd766';
    ctx.font = 'bold 34px Trebuchet MS, sans-serif';
    ctx.fillText('PAUSED', W / 2, H / 2 - 6);
    ctx.fillStyle = 'rgba(207,224,242,.85)';
    ctx.font = '14px Trebuchet MS, sans-serif';
    ctx.fillText('P or ESC — resume', W / 2, H / 2 + 22);
    ctx.textAlign = 'left';
  }

  // Mobile fire hint.
  if ('ontouchstart' in window) {
    ctx.save();
    ctx.globalAlpha = runtime.fireHeld ? .9 : .4;
    ctx.strokeStyle = '#ffd766'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(W - 62, H - 62, 34, 0, 6.283); ctx.stroke();
    ctx.fillStyle = '#ffd766'; ctx.font = 'bold 13px Trebuchet MS, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('FIRE', W - 62, H - 57);
    ctx.restore();
  }

  // Mobile joystick.
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

