// Game rules and dynamic-state updates.
window.TownGame.gameplay = (() => {
'use strict';

const {
  cv, WORLD, PR, ZR, CAR_L, BV, FIRE_CD, WALK, RUN,
  BATT_DRAIN, STAM_DRAIN, STAM_REGEN,
  clamp, rnd, pick, inOBB,
  UI, STORAGE_KEYS, gameStorage, runtime,
  camOf, torchHand, gunHand, overlay, startBtn
} = window.TownGame.core;
const SND = window.TownGame.audio;
const {
  TURN_IN, updateFog, updateWeather,
  lanePoint, steerCar, startTurn, ahead, carSmokeProfile,
  damageCarWithZombie, damageCarWithPlayer, damageCarWithBullet,
  crash, crashObstacle,
  bezAt, bezDir,
  makeNoise, surfaceAt
} = window.TownGame.environment;
const { hitOBB, obbHit, hitCircle } = window.TownGame.physics;
const {
  carCollisionManifold, circleCarContact, resolveCircleCar, bodyPointWorld, segmentCarContact
} = window.TownGame.carPhysics;
const { inputDir } = window.TownGame.input;

const FILTH_MIN_RANGE = 145;
const FILTH_MAX_RANGE = 360;
const DODGE_TIME = .34;
const DODGE_RANGE = 430;

// An alerted zombie can notice a muzzle flash and leave the firing line.
// The reaction is deliberately unreliable and has a cooldown, so a good shot is still rewarded.
function warnZombiesOfShot(g, x, y, hx, hy) {
  let reacted = 0;
  for (const z of g.zombies) {
    if (z.gone || (z.hunt <= 0 && z.alert <= 0) || z.dodgeCd > 0) continue;
    const rx = z.x - x, ry = z.y - y;
    const along = rx * hx + ry * hy;
    if (along < 55 || along > DODGE_RANGE) continue;
    const lateral = -rx * hy + ry * hx;
    if (Math.abs(lateral) > 32 || Math.random() > .72 - along * .00045) continue;

    z.dodgeDir = Math.abs(lateral) > 4 ? Math.sign(lateral) : (Math.random() < .5 ? -1 : 1);
    z.dodgeTime = DODGE_TIME;
    z.dodgeCd = rnd(1.55, 2.55);
    z.throwWind = 0;                         // Dodging for safety interrupts the throw.
    z.throwCd = Math.max(z.throwCd, .7);
    z.hunt = Math.max(z.hunt, 2.4);
    g.dodges++;
    if (++reacted >= 2) break;               // The entire horde cannot read one shot at once.
  }
}

// A shot creates a bullet, flash, recoil, and neighborhood-wide noise.
function fire(g) {
  // The barrel points at the aim target instead of running parallel to the view direction.
  const p = g.p, h = gunHand(p), a = Math.atan2(p.ty - h.y, p.tx - h.x) + rnd(-.045, .045);
  const hx = Math.cos(a), hy = Math.sin(a);
  g.spawnGrace = 0;                           // Firing voluntarily ends the quiet start.
  g.ammo--; p.cool = FIRE_CD; p.muzzle = .08;
  g.shake = Math.max(g.shake, .3);
  warnZombiesOfShot(g, h.x, h.y, hx, hy);
  g.bullets.push({ x: h.x + Math.cos(a) * 10, y: h.y + Math.sin(a) * 10, px: h.x, py: h.y,
                   vx: hx * BV, vy: hy * BV, l: .5 });
  p.kx -= hx * 55; p.ky -= hy * 55;
  for (let k = 0; k < 5; k++)
    g.parts.push({ x: h.x + Math.cos(a) * 11, y: h.y + Math.sin(a) * 11,
                   vx: Math.cos(a) * rnd(40, 150) + rnd(-60, 60), vy: Math.sin(a) * rnd(40, 150) + rnd(-60, 60),
                   l: rnd(.1, .25), c: '#ffe08a', s: rnd(2, 3) });
  makeNoise(g, p.x, p.y, 430, 7, true);           // A shot is audible across the block.
  SND.play('shot', p.x, p.y);
}

function throwFilth(g, z) {
  const spec = z.shot;
  const dx = z.throwAimX - z.x, dy = z.throwAimY - z.y;
  const a = Math.atan2(dy, dx) + rnd(-.055, .055);
  const x = z.x + Math.cos(a) * 17, y = z.y + Math.sin(a) * 17;
  g.zombieShots.push({
    x, y, px: x, py: y,
    vx: Math.cos(a) * spec.speed, vy: Math.sin(a) * spec.speed,
    r: spec.radius, l: spec.life, spin: rnd(0, 6.283), kind: z.kind,
    body: spec.body, edge: spec.edge, dark: spec.dark, trail: spec.trail,
    splash: spec.splash, splat: spec.splat, light: spec.light
  });
  g.filthThrown++;
  z.throwCd = rnd(spec.cooldown[0], spec.cooldown[1]);
  for (let k = 0; k < 4; k++)
    g.parts.push({ x, y, vx: rnd(-35, 35), vy: rnd(-55, 25), l: rnd(.18, .35), c: spec.body, s: rnd(2, 4) });
  SND.play('spit', z.x, z.y);
}

function splatFilth(g, shot) {
  g.splats.push({ x: shot.x, y: shot.y, seed: Math.random(), l: 6, rgb: shot.splat });
  if (g.splats.length > 28) g.splats.shift();
  for (let k = 0; k < 12; k++) {
    const a = rnd(0, 6.283), v = rnd(35, 125);
    g.parts.push({ x: shot.x, y: shot.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
                   l: rnd(.28, .65), c: pick(shot.splash), s: rnd(2, 5) });
  }
  SND.play('splat', shot.x, shot.y);
}

function addGroundBlood(g, x, y, rgb, radius, vx = 0, vy = 0) {
  const speed = Math.hypot(vx, vy), stretch = clamp(speed / 150, 0, .85);
  g.stains.push({
    x: clamp(x, 2, WORLD - 2), y: clamp(y, 2, WORLD - 2), seed: Math.random(), rgb,
    r: radius, blobs: radius < 3 ? 2 : radius < 6 ? 3 : 5,
    stretch, ang: speed > 2 ? Math.atan2(vy, vx) : rnd(0, 6.283), alpha: rnd(.58, .76), blood: true
  });
  // Blood lasts for the district, but stain count is capped for old GPUs.
  if (g.stains.length > 240) g.stains.splice(0, g.stains.length - 240);
}

function addBloodDrop(g, z, x, y, vx, vy, vz, radius, height = 4) {
  if (!g.bloodDrops) g.bloodDrops = [];
  if (g.bloodDrops.length >= 120) g.bloodDrops.shift();
  g.bloodDrops.push({
    x, y, px: x, py: y, z: height, pz: height,
    vx, vy, vz, r: radius, l: 1.8, c: pick(z.blood), rgb: z.stain
  });
}

// The spray follows the bullet direction while splitting into droplets of different mass.
function sprayZombieBlood(g, z, x, y, dx, dy, count = 14, power = 1) {
  const len = Math.hypot(dx, dy) || 1, nx = dx / len, ny = dy / len;
  const px = -ny, py = nx;
  for (let k = 0; k < count; k++) {
    const speed = rnd(45, 185) * power, side = rnd(-.62, .62) * speed;
    addBloodDrop(g, z, x, y,
      nx * speed + px * side, ny * speed + py * side,
      rnd(45, 125) * power, rnd(1.4, 3.8), rnd(3, 11));
  }
  for (let k = 0; k < Math.min(12, count); k++)
    g.parts.push({ x, y, vx: nx * rnd(30, 145) + px * rnd(-75, 75),
      vy: ny * rnd(30, 145) + py * rnd(-75, 75), l: rnd(.22, .58), c: pick(z.blood), s: rnd(2, 5) });
}

// Continuous bullet-to-circle intersection: at low FPS one bullet step is longer
// than a zombie body, so endpoint-only tests allowed shots to pass through.
function segmentCircleT(x1, y1, x2, y2, cx, cy, radius) {
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy || 1;
  const t = clamp(((cx - x1) * dx + (cy - y1) * dy) / len2, 0, 1);
  const px = x1 + dx * t, py = y1 + dy * t;
  const ox = cx - px, oy = cy - py;
  return ox * ox + oy * oy <= radius * radius ? t : null;
}

function killZombie(g, z) {
  if (z.gone) return;
  z.gone = true; z.hp = 0; g.killed++;
  addGroundBlood(g, z.x, z.y, z.stain, z.kind === 'brute' ? 14 : 10);
  sprayZombieBlood(g, z, z.x, z.y, Math.cos(z.ang), Math.sin(z.ang), z.kind === 'brute' ? 22 : 17, 1.08);
  for (let k = 0; k < 18; k++)
    g.parts.push({ x: z.x, y: z.y, vx: rnd(-170, 170), vy: rnd(-170, 170), l: rnd(.3, .8), c: pick(z.blood), s: rnd(2, 5) });
  const drop = Math.random();
  if (drop < .48) g.ammoBoxes.push({ x: z.x, y: z.y, batt: drop < .14, n: 7, ph: Math.random() * 6.283 });
  SND.play('die', z.x, z.y, z.seed);
}

// Apply one player hit from a car or zombie.
function hurt(g, dx, dy, power, stagger = .5) {
  const p = g.p;
  g.lives--; p.inv = 1.9; p.stagger = stagger; g.shake = 1;
  p.kx = dx * power; p.ky = dy * power;
  for (let k = 0; k < 16; k++)
    g.parts.push({ x: p.x, y: p.y, vx: rnd(-160, 160), vy: rnd(-160, 160), l: rnd(.3, .7), c: '#ff6b5a', s: rnd(2, 5) });
  SND.play('hurt', p.x, p.y);
  if (g.lives <= 0) gameOver(g);
}

// Bodies must separate physically after a bite. Otherwise the pursuer remains inside
// the player, closes the gap during invulnerability, and guarantees another bite.
function settleCircleBody(g, body, radius) {
  body.x = clamp(body.x, radius, WORLD - radius);
  body.y = clamp(body.y, radius, WORLD - radius);
  for (const s of g.solids) hitOBB(body, radius, s);
  for (const t of g.trees) hitCircle(body, radius, t);
  body.x = clamp(body.x, radius, WORLD - radius);
  body.y = clamp(body.y, radius, WORLD - radius);
}

function resolveZombieContact(g, z) {
  const p = g.p;
  let dx = p.x - z.x, dy = p.y - z.y;
  let d = Math.hypot(dx, dy);
  const contactDistance = PR + ZR + 2;
  if (d >= contactDistance) return;

  // Separate coincident centers along the zombie view direction to avoid NaN.
  const nx = d > .001 ? dx / d : -Math.cos(z.ang);
  const ny = d > .001 ? dy / d : -Math.sin(z.ang);
  d = Math.max(d, .001);
  const overlap = contactDistance - d + 1.5;
  const protectedPlayer = p.inv > 0 || g.spawnGrace > 0 || g.done;
  const playerShare = protectedPlayer ? .12 : .55;

  p.x += nx * overlap * playerShare;
  p.y += ny * overlap * playerShare;
  z.x -= nx * overlap * (1 - playerShare);
  z.y -= ny * overlap * (1 - playerShare);
  settleCircleBody(g, p, PR);
  settleCircleBody(g, z, ZR);

  // While flashing, the player can slip out of the horde. The enemy is still pushed
  // away, but no repeat bite or additional movement lock occurs.
  if (protectedPlayer) return;

  z.recoil = .48;
  z.kx = -nx * 260;
  z.ky = -ny * 260;
  z.dodgeTime = 0;
  z.surge = 0;
  z.pressure = 0;
  z.throwWind = 0;
  z.throwCd = Math.max(z.throwCd, .75);
  hurt(g, nx, ny, 190, .28);
}

function emitCarSmoke(g, c, dt) {
  const smoke = carSmokeProfile(c);
  if (!smoke.active) return;
  // Distant wrecks must not consume the off-screen particle budget.
  if (Math.abs(c.x - g.p.x) > 520 || Math.abs(c.y - g.p.y) > 440) {
    c.smokeCd = Math.min(c.smokeCd || 0, .12);
    return;
  }
  c.smokeCd = (c.smokeCd || 0) - dt;
  if (c.smokeCd > 0 || g.carSmoke.length >= 72) return;
  c.smokeCd = smoke.interval * rnd(.78, 1.22);
  const side = rnd(-4 - smoke.level * 2, 4 + smoke.level * 2), front = rnd(10, 17);
  const hot = smoke.level > .82 && Math.random() < .08 + smoke.level * .08;
  const source = bodyPointWorld(c, front, side);
  const life = smoke.life * rnd(.82, 1.18);
  g.carSmoke.push({
    x: source.x, y: source.y,
    vx: rnd(-7, 7) + g.weather.wind * (5 + smoke.level * 10) - c.hx * rnd(1, 5),
    vy: -smoke.rise * rnd(.8, 1.15) - c.hy * rnd(1, 4),
    l: life, max: life, r: smoke.radius * rnd(.82, 1.15), growth: smoke.growth,
    darkness: smoke.darkness, opacity: smoke.opacity, hot
  });
}

// ---------- update ----------
function update(g, dt) {
  g.time += dt;
  if (g.bloodQa && !g.bloodQaDone && g.time >= .35 && g.zombies[0]) {
    const z = g.zombies[0];
    g.bloodQaDone = true; z.hp--; z.hit = .45; z.alert = 0;
    z.bleed = 3.8; z.bleedCd = 0;
    sprayZombieBlood(g, z, z.x, z.y, 0, -1, 18, 1.08);
  }
  g.spawnGrace = Math.max(0, g.spawnGrace - dt);
  g.shake = Math.max(0, g.shake - dt * 3);
  const p = g.p;
  SND.listen(p.x, p.y);
  p.inv = Math.max(0, p.inv - dt);

  // Bushes slow movement.
  let inBush = false;
  for (const b of g.soft) {
    const dx = b.x - p.x, dy = b.y - p.y, r = b.r * .9;
    if (dx * dx + dy * dy < r * r) { inBush = true; break; }
  }
  const dir = inputDir();

  // The flashlight drains and flickers at low charge.
  if (p.torch && p.batt > 0) {
    p.batt = Math.max(0, p.batt - BATT_DRAIN * dt);
    p.flick = p.batt < .16 ? (Math.random() < .12 ? rnd(.15, .5) : rnd(.75, 1)) : 1;
    if (p.batt === 0) p.torch = false;
  } else p.flick = 1;

  // Sprinting consumes stamina and creates noise.
  p.running = dir.run && dir.m > .2 && p.stam > .06 && p.stagger <= 0;
  if (p.running) { p.stam = Math.max(0, p.stam - STAM_DRAIN * dt); p.rest = .55; }
  else {
    p.rest = Math.max(0, p.rest - dt);
    if (p.rest <= 0) p.stam = Math.min(1, p.stam + STAM_REGEN * dt);
  }
  // The courier moves noticeably faster on asphalt than through grass and yards.
  const road = surfaceAt(g, p.x, p.y);
  const speed = (inBush ? .62 : 1) * (p.running ? RUN : WALK) * (p.stagger > 0 ? .35 : 1) * (1 + .18 * road);
  p.stagger = Math.max(0, (p.stagger || 0) - dt);

  // Sprinting carries far, walking is quiet, and soles sound sharper on asphalt.
  if (dir.m > .2) {
    p.step -= dt;
    if (p.step <= 0) {
      p.step = (p.running ? .34 : .8) * (1 - .12 * road);
      makeNoise(g, p.x, p.y, (p.running ? 210 : 78) * (1 + .3 * road), p.running ? 3.5 : 1.2, p.running);
      SND.play(road > .5 ? 'stepA' : 'stepG', p.x, p.y);
    }
  } else p.step = .1;

  const tvx = dir.x * speed, tvy = dir.y * speed;
  const acc = (14 - 5 * road * g.weather.wet) * dt;      // Wet asphalt makes acceleration and braking sluggish.
  p.vx += (tvx - p.vx) * Math.min(1, acc);
  p.vy += (tvy - p.vy) * Math.min(1, acc);
  if (p.kx) { p.x += p.kx * dt; p.y += p.ky * dt; p.kx *= .88; p.ky *= .88; if (Math.abs(p.kx) < 5) p.kx = p.ky = 0; }
  p.x += p.vx * dt; p.y += p.vy * dt;
  if (dir.m > .05) { p.ang = Math.atan2(p.vy, p.vx); p.walk += dt * (inBush ? 7 : 11); }
  else p.walk += dt * 1.5;

  p.x = clamp(p.x, PR, WORLD - PR); p.y = clamp(p.y, PR, WORLD - PR);
  for (const s of g.solids) hitOBB(p, PR, s);
  for (const t of g.trees) hitCircle(p, PR, t);
  g.cam = camOf(g);

  // Aim with the mouse, or fall back to the movement direction.
  if (runtime.mouse.active) {
    p.tx = runtime.mouse.sx + g.cam.x; p.ty = runtime.mouse.sy + g.cam.y;
  }
  else { p.tx = p.x + Math.cos(p.ang) * 300; p.ty = p.y + Math.sin(p.ang) * 300; }
  p.aim = Math.atan2(p.ty - p.y, p.tx - p.x);
  updateWeather(g, dt);
  updateFog(g, dt);

  // Fire.
  p.cool = Math.max(0, p.cool - dt);
  p.muzzle = Math.max(0, p.muzzle - dt);
  const wantFire = runtime.mouse.down || runtime.fireHeld ||
    runtime.keys[' '] || runtime.keys['k'];
  if (wantFire && p.cool <= 0 && g.ammo > 0 && !g.done) fire(g);

  // Bullets.
  for (let i = g.bullets.length - 1; i >= 0; i--) {
    const b = g.bullets[i];
    b.l -= dt; b.px = b.x; b.py = b.y;
    b.x += b.vx * dt; b.y += b.vy * dt;
    let gone = b.l <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD || b.y > WORLD;
    if (!gone) for (const c of g.parked) {
      const contact = segmentCarContact(c, b.px, b.py, b.x, b.y);
      if (!contact) continue;
      b.x = contact.x; b.y = contact.y; damageCarWithBullet(g, c, contact, b); gone = 'c'; break;
    }
    if (!gone) for (const s of g.solids)
      if (s.t !== 'parked' && inOBB(b.x, b.y, s)) { gone = 'w'; break; }
    if (!gone) for (const t of g.trees)
      { const dx = t.x - b.x, dy = t.y - b.y;
        if (dx * dx + dy * dy < t.r * t.r) { gone = 'w'; break; } }
    if (!gone) {
      let carHit = null, hitCar = null;
      for (const c of g.cars) {
        const contact = segmentCarContact(c, b.px, b.py, b.x, b.y);
        if (contact && (!carHit || contact.t < carHit.t)) { carHit = contact; hitCar = c; }
      }
      if (carHit) {
        b.x = carHit.x; b.y = carHit.y;
        damageCarWithBullet(g, hitCar, carHit, b); gone = 'c';
      }
    }
    if (!gone) {
      let zombieHit = null, zombieT = 2;
      for (const z of g.zombies) {
        if (z.gone) continue;
        const t = segmentCircleT(b.px, b.py, b.x, b.y, z.x, z.y, ZR + 3);
        if (t !== null && t < zombieT) { zombieHit = z; zombieT = t; }
      }
      if (zombieHit) {
      const z = zombieHit;
      b.x = b.px + (b.x - b.px) * zombieT; b.y = b.py + (b.y - b.py) * zombieT;
      const bulletSpeed = Math.hypot(b.vx, b.vy) || 1;
      z.hp--; z.hit = .2; z.alert = 6;
      z.kx += b.vx * .12; z.ky += b.vy * .12;
      z.bleed = Math.min(7, (z.bleed || 0) + (z.kind === 'brute' ? 3.8 : 2.7));
      z.bleedCd = 0;
      sprayZombieBlood(g, z, b.x, b.y, b.vx / bulletSpeed, b.vy / bulletSpeed,
        z.kind === 'brute' ? 18 : 14, z.kind === 'brute' ? 1.08 : 1);
      if (z.hp <= 0) killZombie(g, z); else SND.play('hit', b.x, b.y);
      gone = 'z';
      }
    }
    if (gone) {
      if (gone === 'w') SND.play('wall', b.x, b.y);
      for (let k = 0; k < 3; k++)
        g.parts.push({ x: b.x, y: b.y, vx: rnd(-70, 70), vy: rnd(-70, 70), l: rnd(.1, .25),
          c: gone === 'c' ? pick(['#d8e0e6', '#ffe08a', '#7c858d']) : '#ffe08a', s: 2 });
      g.bullets.splice(i, 1);
    }
  }

  // Zombies.
  let activeSurges = 0;
  for (const z of g.zombies) if (!z.gone && z.surge > 0) activeSurges++;
  for (const z of g.zombies) {
    if (z.gone) continue;
    if (z.guardParcel >= 0 && g.parcels[z.guardParcel].got) z.guardParcel = -1;
    z.hit = Math.max(0, z.hit - dt);
    z.alert = Math.max(0, z.alert - dt);
    z.hunt = Math.max(0, z.hunt - dt);
    z.throwCd = Math.max(0, z.throwCd - dt);
    z.dodgeCd = Math.max(0, z.dodgeCd - dt);
    z.dodgeTime = Math.max(0, z.dodgeTime - dt);
    z.surgeCd = Math.max(0, z.surgeCd - dt);
    z.surge = Math.max(0, z.surge - dt);
    z.recoil = Math.max(0, (z.recoil || 0) - dt);
    z.bleed = Math.max(0, (z.bleed || 0) - dt);
    z.bleedCd = Math.max(0, (z.bleedCd || 0) - dt);
    if (z.bleed > 0 && z.bleedCd <= 0) {
      z.bleedCd = rnd(.16, .32);
      addBloodDrop(g, z, z.x + rnd(-4, 4), z.y + rnd(-4, 4),
        rnd(-18, 18), rnd(-18, 18), rnd(18, 42), rnd(1.2, 2.6), rnd(1, 4));
    }
    const dx = p.x - z.x, dy = p.y - z.y, d = Math.hypot(dx, dy) || 1;

    // During the opening seconds, the district ignores the spawn and starting beam.
    // Afterward, zombies always notice at close range and at distance when illuminated.
    const canNotice = !g.done && g.spawnGrace <= 0;
    const lightRange = z.guardParcel >= 0 ? 275 : 400;
    let sees = canNotice && d < 120;
    if (!sees && canNotice && p.torch && p.batt > 0 && d < lightRange - 64 * g.weather.rain) {
      const h = torchHand(p), hx = z.x - h.x, hy = z.y - h.y, hd = Math.hypot(hx, hy) || 1;
      const ca = Math.cos(p.aim), sa = Math.sin(p.aim);
      if ((hx * ca + hy * sa) > hd * Math.cos(.62)) sees = true;   // Zombie is inside the hand-held light cone.
    }
    if (sees) { z.hunt = 3.2; z.tx = p.x; z.ty = p.y; }

    let ax, ay, chase = false;
    if (z.hunt > 0) {
      // Instead of chasing directly, the horde flanks from both sides and leads the courier's movement.
      z.flankTimer -= dt;
      if (z.flankTimer <= 0) {
        z.flankTimer = rnd(1.8, 3.3);
        if (Math.random() < .18) z.flankSide *= -1;
      }
      const lead = d > 100 ? Math.min(.58, d / 520) : .12;
      const flank = d > 82 ? Math.min(112, (d - 70) * .38) * z.flankSide * z.flankBias : 0;
      const gx = p.x + p.vx * lead - dy / d * flank;
      const gy = p.y + p.vy * lead + dx / d * flank;
      const nx = gx - z.x, ny = gy - z.y, nd = Math.hypot(nx, ny) || 1;
      ax = nx / nd; ay = ny / nd; chase = true;

      // A long retreat charges a short surge. Sprinting can still create distance,
      // but walking backward while shooting is no longer free.
      const retreat = (p.vx * dx + p.vy * dy) / d;
      z.pressure = clamp(z.pressure + dt * (retreat > 58 && d > 72 && d < 330 ? 1.35 : -2.1), 0, 1);
      if (z.pressure >= 1 && z.surgeCd <= 0 && activeSurges < 2) {
        z.surge = rnd(.46, .62);
        z.surgeCd = rnd(2.9, 4.6);
        z.pressure = 0;
        activeSurges++;
        g.surges++;
      }
    }
    else if (z.alert > 0) {                                        // Move toward a remembered noise.
      const nx = z.tx - z.x, ny = z.ty - z.y, nd = Math.hypot(nx, ny) || 1;
      if (nd < 26) { z.alert = Math.min(z.alert, .6); ax = Math.cos(z.wdir); ay = Math.sin(z.wdir); }
      else { ax = nx / nd; ay = ny / nd; chase = true; }
    } else {
      z.pressure = Math.max(0, z.pressure - dt * 2.1);
      z.wander -= dt;
      if (z.guardParcel >= 0) {
        const gx = z.guardX - z.x, gy = z.guardY - z.y, gd = Math.hypot(gx, gy) || 1;
        if (gd > z.guardRadius) { ax = gx / gd; ay = gy / gd; }
        else {
          if (z.wander <= 0) { z.wander = rnd(.9, 2.2); z.wdir = rnd(0, 6.283); }
          const pull = clamp((gd - z.guardRadius * .55) / (z.guardRadius * .45), 0, 1);
          ax = Math.cos(z.wdir) * (1 - pull) + gx / gd * pull;
          ay = Math.sin(z.wdir) * (1 - pull) + gy / gd * pull;
        }
      } else {
        if (z.wander <= 0) { z.wander = rnd(1.2, 3.4); z.wdir = rnd(0, 6.283); }
        ax = Math.cos(z.wdir); ay = Math.sin(z.wdir);
      }
    }
    let moveScale = 1;
    z.ang = Math.atan2(ay, ax);
    if (z.recoil > 0) {
      // Brief recoil after a bite prevents the pursuer from stepping back immediately.
      ax = ay = 0;
      moveScale = 0;
      z.throwWind = 0;
    } else if (z.dodgeTime > 0) {
      // A lateral dodge leaves the firing line while preserving slight forward pressure.
      ax = -dy / d * z.dodgeDir + dx / d * .14;
      ay =  dx / d * z.dodgeDir + dy / d * .14;
      const ad = Math.hypot(ax, ay) || 1;
      ax /= ad; ay /= ad;
      z.ang = Math.atan2(ay, ax);
      moveScale = 1.48;
    } else if (z.throwWind > 0) {
      z.throwWind -= dt;
      z.ang = Math.atan2(z.throwAimY - z.y, z.throwAimX - z.x);
      moveScale = .16;
      if (z.throwWind <= 0) throwFilth(g, z);
    } else if (z.surge > 0) {
      moveScale = 1.55;
    } else if (!g.done && g.spawnGrace <= 0 && (z.hunt > 0 || (z.alert > 0 && (z.tx - p.x) ** 2 + (z.ty - p.y) ** 2 < 4900)) && z.throwCd <= 0 &&
               d > FILTH_MIN_RANGE && d < FILTH_MAX_RANGE && g.zombieShots.length < 5) {
      const lead = Math.min(.55, d / z.shot.speed * .45);
      z.throwAimX = clamp(p.x + p.vx * lead + rnd(-16, 16), 8, WORLD - 8);
      z.throwAimY = clamp(p.y + p.vy * lead + rnd(-16, 16), 8, WORLD - 8);
      z.throwWind = z.shot.windup;
      z.ang = Math.atan2(z.throwAimY - z.y, z.throwAimX - z.x);
      moveScale = .16;
    }

    // Growl and alert nearby zombies.
    z.moan -= dt;
    if (z.moan <= 0) {
      z.moan = chase ? rnd(1.6, 2.8) : rnd(5, 9);
      if (chase) makeNoise(g, z.x, z.y, 190, 3, false, z);
      SND.play('moan', z.x, z.y, z.seed);
    }

    // Zombies also gain speed on asphalt, but far less than the courier.
    const sp = z.spd * (chase ? 1 : .34) * (1 + .07 * surfaceAt(g, z.x, z.y)) * moveScale;
    z.x += ax * sp * dt; z.y += ay * sp * dt;
    z.walk += dt * (chase ? 7 : 3);
    if (z.kx || z.ky) {
      z.x += z.kx * dt; z.y += z.ky * dt; z.kx *= .86; z.ky *= .86;
      if (Math.abs(z.kx) < 5 && Math.abs(z.ky) < 5) z.kx = z.ky = 0;
    }
    z.x = clamp(z.x, ZR, WORLD - ZR); z.y = clamp(z.y, ZR, WORLD - ZR);
    for (const s of g.solids) hitOBB(z, ZR, s);
    for (const t of g.trees) hitCircle(z, ZR, t);
    for (const o of g.zombies) {                       // Keep bodies from merging into one clump.
      if (o === z) continue;
      const ox = z.x - o.x, oy = z.y - o.y, od2 = ox * ox + oy * oy;
      if (od2 > 0 && od2 < ZR * ZR * 4) {
        const od = Math.sqrt(od2), k = (ZR * 2 - od) / od * .5;
        z.x += ox * k; z.y += oy * k;
      }
    }
    // Moving cars run zombies down, while repeated bodies damage the radiator and suspension.
    for (const c of g.cars) {
      const carContact = circleCarContact(c, z.x, z.y, ZR - 4);
      if (c.broken) { if (carContact) resolveCircleCar(c, z, ZR); continue; }
      if (c.v > 40 && carContact) {
        z.kx = c.hx * 260; z.ky = c.hy * 260; c.honk = 1;
        damageCarWithZombie(g, c, z, carContact);
        g.roadKills++;
        killZombie(g, z); break;
      }
    }
    if (!z.gone) resolveZombieContact(g, z);
    if (g.lives <= 0) return;
  }
  for (let i = g.zombies.length - 1; i >= 0; i--) if (g.zombies[i].gone) g.zombies.splice(i, 1);

  // Filth projectiles move slowly, break on the environment, and remain dodgeable.
  for (let i = g.zombieShots.length - 1; i >= 0; i--) {
    const s = g.zombieShots[i];
    s.l -= dt; s.px = s.x; s.py = s.y; s.spin += dt * 8;
    s.x += s.vx * dt; s.y += s.vy * dt;
    let gone = s.l <= 0 || s.x < 0 || s.y < 0 || s.x > WORLD || s.y > WORLD;
    if (!gone) for (const o of g.solids)
      if (inOBB(s.x, s.y, o)) { gone = true; break; }
    if (!gone) for (const t of g.trees)
      { const dx = t.x - s.x, dy = t.y - s.y, r = t.r + s.r;
        if (dx * dx + dy * dy < r * r) { gone = true; break; } }
    if (!gone) for (const c of g.cars)
      if (circleCarContact(c, s.x, s.y, s.r)) { gone = true; break; }

    const pdx = p.x - s.x, pdy = p.y - s.y, pr = PR + s.r;
    if (!gone && !g.done && pdx * pdx + pdy * pdy < pr * pr) {
      const speed = Math.hypot(s.vx, s.vy) || 1;
      splatFilth(g, s);
      g.zombieShots.splice(i, 1);
      if (p.inv <= 0) {
        g.filthHits++;
        hurt(g, s.vx / speed, s.vy / speed, 105);
      }
      if (g.lives <= 0) return;
      continue;
    }
    if (gone) {
      splatFilth(g, s);
      g.zombieShots.splice(i, 1);
    }
  }

  // Ammo and batteries.
  for (let i = g.ammoBoxes.length - 1; i >= 0; i--) {
    const a = g.ammoBoxes[i];
    a.ph += dt * 3;
    if (Math.hypot(a.x - p.x, a.y - p.y) < 22) {
      if (a.batt) p.batt = Math.min(1, p.batt + .5); else g.ammo += a.n;
      g.ammoBoxes.splice(i, 1);
      SND.play('pick', a.x, a.y);
      for (let k = 0; k < 10; k++)
        g.parts.push({ x: a.x, y: a.y, vx: rnd(-80, 80), vy: rnd(-130, -20), l: rnd(.3, .6),
                       c: a.batt ? '#8ee6a0' : '#cfe0f2', s: rnd(2, 4) });
    }
  }

  // Noise rings show how far the player has revealed their position.
  for (let i = g.rings.length - 1; i >= 0; i--) {
    const r = g.rings[i];
    r.l -= dt; r.r += (r.max - r.r) * Math.min(1, dt * 5);
    if (r.l <= 0) g.rings.splice(i, 1);
  }

  // A parked car cannot drive without a driver, but its alarm flashes and honks.
  for (const c of g.parked) {
    c.hitFlash = Math.max(0, (c.hitFlash || 0) - dt);
    c.hazard = Math.max(0, (c.hazard || 0) - dt);
    c.alarm = Math.max(0, (c.alarm || 0) - dt);
    c.honk = c.alarm > 0 && ((c.alarm * 3) | 0) % 2 === 0 ? .8 : 0;
    emitCarSmoke(g, c, dt);
  }

  // Cars.
  for (const c of g.cars) {
    c.hazard = Math.max(0, (c.hazard || 0) - dt);
    c.cd = Math.max(0, c.cd - dt);
    c.playerBodyCd = Math.max(0, (c.playerBodyCd || 0) - dt);
    c.hitFlash = Math.max(0, (c.hitFlash || 0) - dt);
    c.driverTimer = Math.max(0, (c.driverTimer || 0) - dt);
    if (c.driverTimer <= 0 && (c.driverMode === 'chase' || c.driverMode === 'flee')) c.driverMode = 'traffic';
    emitCarSmoke(g, c, dt);
    if (c.jx) {                                      // Residual displacement after impact.
      c.jx *= .86; c.jy *= .86;
      if (Math.abs(c.jx) < .3 && Math.abs(c.jy) < .3) c.jx = c.jy = 0;
    }

    // A disabled car never revives; it becomes cover and a physical obstacle.
    if (c.broken) {
      c.v = 0;
      c.hold = true;
      c.honk = Math.max(0, c.honk - dt * 4);
      if (c.police && c.hazard > 0) c.beacon += dt * 4.2;
      resolveCircleCar(c, p, PR);
      continue;
    }

    // Scan the full corridor ahead with overlapping boxes and no gaps.
    const look = Math.max(52, c.v * 1.05), nb = Math.min(10, Math.ceil(look / 42));
    const close = Math.max(46, c.v * .55);
    let near = false, far = false;
    for (let li = 1; li <= nb && !near; li++) {
      const dist = look * li / nb, isNear = dist <= close;
      const box = ahead(c, dist);
      let hit = false;
      for (const o of g.cars) {
        if (o === c) continue;
        // Brake for anyone nearby; the higher id yields when approaching an intersection.
        const same = o.edge === c.edge && o.dir === c.dir;
        if (!isNear && !(same || o.id < c.id || o.stall > 0)) continue;
        if (obbHit(box, o.box)) { hit = true; break; }
      }
      if (!hit && isNear) for (const q of g.parked) if (obbHit(box, q)) { hit = true; break; }
      if (hit) { if (isNear) near = true; else far = true; }
    }
    // Forced movement ignores waiting and distant scans, but still brakes for immediate obstacles.
    const reacting = c.driverTimer > 0 && (c.driverMode === 'chase' || c.driverMode === 'flee');
    let brake = near || (!reacting && c.creep <= 0 && (far || c.hold));
    if (reacting) c.hold = false;
    c.stuck = brake && c.v < 14 ? c.stuck + dt : 0;
    if (c.stall > 0) c.stall -= dt;
    c.dead = c.v < 8 ? c.dead + dt : 0;
    // If nobody yields or cars face off, force movement until the intersection is clear.
    const forcedCreep = c.creep > 0;
    if (forcedCreep) { c.creep -= dt; brake = false; }
    else if (c.stuck > 2.5 || c.dead > 4) { c.creep = 1.4; c.stall = c.stuck = c.dead = 0; brake = false; }
    if (c.stall > 0) brake = true;                    // Traffic logic cannot push a stalled engine forward.

    // A badly damaged engine loses power and stalls; damaged suspension slows steering.
    const engine = c.damage ? c.damage.engine : 100;
    const wheelDamage = c.damage ? c.damage.wheel : 0;
    if (engine < 38 && c.stall <= 0 && Math.random() < dt * .085) { c.stall = rnd(.28, .72); brake = true; }

    if (c.police) {
      c.beacon += dt * 7;                                      // Rotate the beacon.
      c.siren = (c.siren || 0) - dt;                           // Zombies follow the audible siren.
      if (c.siren <= 0) { c.siren = 1.1; makeNoise(g, c.x, c.y, 250, 3.2); SND.play('siren', c.x, c.y); }
    }
    const turning = c.mode === 'turn', wet = g.weather.wet;
    const condition = (.42 + .58 * engine / 100) * (1 - .28 * wheelDamage);
    const driverBoost = c.driverMode === 'chase' ? 1.32 : c.driverMode === 'flee' ? 1.2 : 1;
    const wish = brake ? 0 : forcedCreep && near ? 18 :
      c.baseMax * condition * driverBoost * (turning ? .58 - .1 * wet : 1);  // Slow down for turns, especially when wet.
    c.v += (wish - c.v) * Math.min(1, (brake ? 6 - 2.4 * wet : turning ? 3.4 : 2.2) * dt);
    if (turning) {
      const T = c.turn;
      T.t += c.v * dt / T.len;
      if (T.t >= 1) {                                          // Entered a new road.
        c.edge = T.next; c.dir = T.ndir; c.s = T.sIn; c.mode = 'edge'; c.turn = null; c.node = -1;
        const l = lanePoint(c.edge, c.s, c.dir);
        steerCar(c, l.x, l.y, l.hx, l.hy, dt, 4.5 * (1 - .42 * wheelDamage));
      } else {
        const q = bezAt(T, T.t), tg = bezDir(T, T.t);
        steerCar(c, q.x, q.y, tg.x, tg.y, dt, 2.9 * (1 - .42 * wheelDamage)); // Damaged suspension holds the arc poorly.
      }
    } else {
      c.s = clamp(c.s + c.dir * c.v * dt, -20, c.edge.len + 20);   // Keep the distance value near the road.
      // Cars enter an intersection one at a time; waiting cars stop before the node.
      const at = c.dir > 0 ? c.edge.b : c.edge.a;
      let left = c.dir > 0 ? c.edge.len - c.s : c.s;
      c.hold = !reacting && left <= TURN_IN + 46 + c.v * .55 &&
               g.cars.some(o => o !== c && o.mode === 'turn' && o.node === at);
      if (c.hold) {
        const stop = c.dir > 0 ? c.edge.len - TURN_IN - 10 : TURN_IN + 10;
        c.s = c.dir > 0 ? Math.min(c.s, stop) : Math.max(c.s, stop);
        left = c.dir > 0 ? c.edge.len - c.s : c.s;
      }
      const l = lanePoint(c.edge, c.s, c.dir);
      steerCar(c, l.x, l.y, l.hx, l.hy, dt, 4.5 * (1 - .42 * wheelDamage));
      if (left <= TURN_IN && !c.hold) startTurn(g, c);
    }

    // Honk when the player is near the path.
    const dx = p.x - c.x, dy = p.y - c.y;
    const rel = dx * c.hx + dy * c.hy, side = Math.abs(dy * c.hx - dx * c.hy);
    const angryHonk = c.driverMode === 'chase' && Math.hypot(dx, dy) < 260;
    c.honk = angryHonk || (rel > 0 && rel < 130 && side < 26) ? Math.min(1, c.honk + dt * 4) : Math.max(0, c.honk - dt * 3);
    if (c.honk > .5 && !c.honked) { c.honked = true; SND.play('honk', c.x, c.y); }
    else if (c.honk < .1) c.honked = false;

    // Player impact.
    const playerCarContact = !g.done ? circleCarContact(c, p.x, p.y, PR) : null;
    if (playerCarContact) {
      const carVx = c.hx * c.v, carVy = c.hy * c.v;
      const closing = Math.max(0, (carVx - p.vx) * playerCarContact.nx + (carVy - p.vy) * playerCarContact.ny);
      const sgn = (dy * c.hx - dx * c.hy) > 0 ? 1 : -1;      // Choose which side to throw the player toward.
      if (closing > 24 && c.playerBodyCd <= 0) {
        damageCarWithPlayer(g, c, p, playerCarContact, closing);
        c.playerBodyCd = .55;
      }
      if (c.v > 35 && p.inv <= 0) {
        hurt(g, c.hx - c.hy * .7 * sgn, c.hy + c.hx * .7 * sgn, 230);
        if (g.lives <= 0) return;
      }
      // Every car is a physical body rather than a pass-through sprite. After the
      // impulse is calculated, separate the player circle from the deformed outline.
      resolveCircleCar(c, p, PR);
    }
  }

  // Cars that fail to yield collide.
  for (let i = 0; i < g.cars.length; i++) for (let j = i + 1; j < g.cars.length; j++) {
    const a = g.cars[i], b = g.cars[j];
    if (a.cd > 0 || b.cd > 0) continue;
    // Bounding circles are only a cheap broad phase. The old OBB cannot be used
    // because it could reject contact with a panel protruding after an impact.
    const ar = a.body ? a.body.collider.rad : CAR_L / 2 + 3;
    const br = b.body ? b.body.collider.rad : CAR_L / 2 + 3;
    if (Math.hypot(a.x - b.x, a.y - b.y) > ar + br) continue;
    const manifold = carCollisionManifold(a, b);
    if (manifold) crash(g, a, b, manifold);
  }

  // A rare failure to brake before a parked car also has real consequences.
  for (const c of g.cars) {
    if (c.cd > 0 || c.broken || c.v < 24) continue;
    for (const parked of g.parked) if (obbHit(c.box, parked)) { crashObstacle(g, c, parked); break; }
  }

  for (let i = g.carSmoke.length - 1; i >= 0; i--) {
    const s = g.carSmoke[i];
    s.l -= dt;
    s.x += s.vx * dt; s.y += s.vy * dt;
    s.vx *= Math.pow(.985, dt * 60); s.vy -= 5 * dt;
    s.r += dt * (s.growth || 7);
    if (s.l <= 0) g.carSmoke.splice(i, 1);
  }

  // Parcels.
  for (const b of g.parcels) {
    if (b.got) continue;
    b.ph += dt * 3;
    if (Math.hypot(b.x - p.x, b.y - p.y) < 22) {
      b.got = true; g.got++;
      SND.play('pick', b.x, b.y);
      for (let k = 0; k < 14; k++)
        g.parts.push({ x: b.x, y: b.y, vx: rnd(-90, 90), vy: rnd(-140, -20), l: rnd(.4, .8), c: '#ffd766', s: rnd(2, 4) });
    }
  }

  // Delivery.
  if (g.got >= g.need && !g.done && Math.hypot(g.goal.x - p.x, g.goal.y - p.y) < 26) {
    g.done = true;
    SND.play('win');
    for (let k = 0; k < 40; k++)
      g.parts.push({ x: g.goal.x, y: g.goal.y, vx: rnd(-200, 200), vy: rnd(-260, -40), l: rnd(.6, 1.3), c: pick(['#8fe388', '#ffd766', '#ffffff']), s: rnd(2, 5) });
    if (g.level + 1 > runtime.best) {
      runtime.best = g.level + 1;
      gameStorage.set(STORAGE_KEYS.best, runtime.best);
      UI.best.textContent = runtime.best;
    }
    setTimeout(() => {
      runtime.state = 'win';
      cv.classList.remove('aim');
      overlay.classList.remove('hidden');
      UI.overlayTitle.textContent = 'DELIVERED!';
      UI.overlaySubtitle.textContent = `district ${g.level} completed in ${g.time.toFixed(1)} s`;
      UI.overlayMessage.innerHTML =
        `Zombies eliminated: <b>${g.killed}</b>. Dodges / surges: <b>${g.dodges}</b> / <b>${g.surges}</b>.<br>` +
        `Filth hits: <b>${g.filthHits}</b> of ${g.filthThrown}.<br>` +
        `Road kills: <b>${g.roadKills}</b>; vehicles disabled: <b>${g.carsBroken}</b>.<br>` +
        `Next is district <b>${g.level + 1}</b>, with more parcels, cars, and zombies.<br>` +
        `Lives and ammunition reset.`;
      startBtn.textContent = 'NEXT DISTRICT';
    }, 900);
  }

  // Volumetric blood droplets become ground stains after a short flight.
  for (let i = g.bloodDrops.length - 1; i >= 0; i--) {
    const d = g.bloodDrops[i];
    d.l -= dt; d.px = d.x; d.py = d.y; d.pz = d.z;
    d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
    d.vz -= 255 * dt; d.vx *= Math.pow(.986, dt * 60); d.vy *= Math.pow(.986, dt * 60);
    if ((d.z <= 0 && d.vz < 0) || d.l <= 0) {
      addGroundBlood(g, d.x, d.y, d.rgb, d.r * rnd(.72, 1.2), d.vx, d.vy);
      g.bloodDrops.splice(i, 1);
    }
  }

  // Remaining particles.
  for (let i = g.parts.length - 1; i >= 0; i--) {
    const q = g.parts[i];
    q.l -= dt; q.x += q.vx * dt; q.y += q.vy * dt; q.vy += 320 * dt; q.vx *= .98;
    if (q.l <= 0) g.parts.splice(i, 1);
  }
  for (let i = g.splats.length - 1; i >= 0; i--)
    if ((g.splats[i].l -= dt) <= 0) g.splats.splice(i, 1);

  drawHud(g);
}

function drawHud(g) {
  UI.level.textContent = g.level;
  UI.parcels.textContent = `${g.got}/${g.need}`;
  UI.ammo.textContent = g.ammo;
  UI.lives.textContent = '♥'.repeat(Math.max(0, g.lives)) + '·'.repeat(clamp(3 - g.lives, 0, 3));
  UI.time.textContent = g.time.toFixed(1);
  if (typeof location !== 'undefined' && location.search.includes('qa=zombie-blood')) {
    cv.dataset.bloodDrops = String((g.bloodDrops || []).length);
    cv.dataset.bloodStains = String(g.stains.filter(s => s.blood).length);
    cv.dataset.zombieHp = String(g.zombies[0] ? g.zombies[0].hp : -1);
    cv.dataset.zombieHit = String(g.zombies[0] ? g.zombies[0].hit : 0);
    cv.dataset.bullets = String(g.bullets.length);
  }
  if (typeof location !== 'undefined' && location.search.includes('qa=population')) {
    cv.dataset.zombies = String(g.zombies.length);
    cv.dataset.ammoBoxes = String(g.ammoBoxes.filter(a => !a.batt).length);
    cv.dataset.batteryBoxes = String(g.ammoBoxes.filter(a => a.batt).length);
  }
}

function gameOver(g) {
  runtime.state = 'over';
  SND.play('over'); SND.rain(0);
  cv.classList.remove('aim');
  drawHud(g);
  overlay.classList.remove('hidden');
  UI.overlayTitle.textContent = 'SHIFT OVER';
  UI.overlaySubtitle.textContent = `district ${g.level}, parcels ${g.got} of ${g.need}, zombies eliminated ${g.killed}`;
  UI.overlayMessage.innerHTML =
    `Filth thrown: <b>${g.filthThrown}</b>; hits taken: <b>${g.filthHits}</b>.<br>` +
    `Dodges / pursuing surges: <b>${g.dodges}</b> / <b>${g.surges}</b>.<br>` +
    `Road kills: <b>${g.roadKills}</b>; vehicles disabled: <b>${g.carsBroken}</b>.<br>` +
    'Wrecked vehicles block the road; use them as cover from the horde.<br>' +
    'Do not fire blindly: ammunition is limited, and noise draws the whole district.';
  startBtn.textContent = 'TRY AGAIN';
}

return Object.freeze({ update });
})();

