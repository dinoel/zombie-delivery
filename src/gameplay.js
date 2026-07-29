// Game rules and dynamic-state updates.
window.TownGame.gameplay = (() => {
'use strict';

const {
  cv, WORLD, PR, ZR, CAR_L, BV, FIRE_CD, WALK, RUN,
  BATT_DRAIN, STAM_DRAIN, STAM_REGEN,
  clamp, rnd, pick, inOBB, distOBB, LIVES_MAX, CARRY_MAX,
  UI, STORAGE_KEYS, gameStorage, runtime,
  camOf, torchHand, gunHand, overlay, startBtn
} = window.TownGame.core;
const SND = window.TownGame.audio;
const {
  TURN_IN, updateFog, updateWeather, updateWeatherVisuals,
  lanePoint, steerCar, startTurn, startUTurn, ahead, placeCar, carSmokeProfile,
  damageCar, damageCarWithZombie, damageCarWithPlayer, damageCarWithBullet,
  crash, crashObstacle,
  bezAt, bezDir,
  makeNoise, surfaceAt, EV, emit, shakeAt
} = window.TownGame.environment;
const {
  hitOBB, obbHit, hitCircle, solidsNear, treesNear, parkedNear, lampsNear
} = window.TownGame.physics;
const {
  carCollisionManifold, circleCarContact, resolveCircleCar, bodyPointWorld, segmentCarContact
} = window.TownGame.carPhysics;
const { readLocalInput, readSecondInput } = window.TownGame.input;

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
    if (z.dumb) continue;                    // A tank has no tactics: it never sidesteps.
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
function fire(g, p) {
  // The barrel points at the aim target instead of running parallel to the view direction.
  const h = gunHand(p), a = Math.atan2(p.ty - h.y, p.tx - h.x) + rnd(-.045, .045);
  const hx = Math.cos(a), hy = Math.sin(a);
  g.spawnGrace = 0;                           // Firing voluntarily ends the quiet start.
  p.ammo--; p.cool = FIRE_CD; p.muzzle = .08;
  shakeAt(g, p.x, p.y, .3);
  emit(g, EV.shot, h.x, h.y, a);
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
    x, y, px: x, py: y, owner: z,                  // Whose throw it was: friendly fire starts feuds.
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

function zombieLocalPoint(z, x, y) {
  const ca = Math.cos(z.ang), sa = Math.sin(z.ang), size = z.size || 1;
  return { x: z.x + (x * ca - y * sa) * size, y: z.y + (x * sa + y * ca) * size };
}

function kickZombieHead(g, head, nx, ny, power, extraVx = 0, extraVy = 0) {
  const len = Math.hypot(nx, ny) || 1;
  nx /= len; ny /= len;
  head.vx += nx * power + extraVx;
  head.vy += ny * power + extraVy;
  head.h = Math.max(head.h, Math.min(7, power * .025));
  head.vh = Math.max(head.vh, Math.min(105, 28 + power * .28));
  head.spin += rnd(-7, 7) + (nx * head.vy - ny * head.vx) * .018;
  head.bleed = Math.max(head.bleed, 1.4 + Math.min(1.8, power / 170));
  head.bleedCd = 0;
  head.kickCd = .12;
  g.headKicks = (g.headKicks || 0) + 1;
  SND.play('hit', head.x, head.y, Math.random());
}

function wakeHeadBlood(head, impact) {
  if (head.kind !== 'head' || impact < 34) return;
  head.bleed = Math.max(head.bleed, .8 + Math.min(1.8, impact / 120));
  head.bleedCd = 0;
}

function bounceHeadFromCorrection(head, beforeX, beforeY, restitution = .48) {
  const cx = head.x - beforeX, cy = head.y - beforeY, length = Math.hypot(cx, cy);
  if (length < .0001) return;
  const nx = cx / length, ny = cy / length;
  const towardSurface = head.vx * nx + head.vy * ny;
  if (towardSurface >= 0) return;
  wakeHeadBlood(head, -towardSurface);
  head.vx -= (1 + restitution) * towardSurface * nx;
  head.vy -= (1 + restitution) * towardSurface * ny;
  head.spin *= .72;
}

function explodeZombieHead(g, head) {
  if (head.exploded) return false;
  head.exploded = true;
  const x = head.x, y = head.y, radius = 190;
  const index = g.zombieParts.indexOf(head);
  if (index >= 0) g.zombieParts.splice(index, 1);
  g.headExplosions = (g.headExplosions || 0) + 1;
  g.blasts.push({ x, y, l: 1.5, max: 1.5, r: 0, maxR: radius, seed: Math.random() });
  if (g.blasts.length > 8) g.blasts.shift();
  addGroundBlood(g, x, y, head.stain, 24, 0, 0);

  for (let k = 0; k < 48; k++) {
    const a = rnd(0, 6.283), speed = rnd(90, 370);
    addBloodDrop(g, head, x, y, Math.cos(a) * speed, Math.sin(a) * speed,
      rnd(70, 210), rnd(1.8, 4.8), rnd(5, 18));
  }
  for (let k = 0; k < 92; k++) {
    const a = rnd(0, 6.283), speed = rnd(90, 430), hot = k < 28;
    g.parts.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
      l: rnd(.45, 1.35), c: hot ? pick(['#fff0a0', '#ffb14e', '#ff5b39']) : pick(head.blood), s: rnd(2, 7) });
  }

  for (const z of g.zombies) {
    if (z.gone) continue;
    const dx = z.x - x, dy = z.y - y, d = Math.hypot(dx, dy) || 1;
    if (d >= radius + z.r) continue;
    const force = clamp(1 - d / radius, .08, 1);
    damageZombie(g, z, .65 + 3.5 * force, dx, dy);
    z.hit = .35; z.alert = 6; z.kx += dx / d * (130 + force * 310); z.ky += dy / d * (130 + force * 310);
    sprayZombieBlood(g, z, z.x, z.y, dx / d, dy / d, Math.round(6 + force * 14), .75 + force * .55);
    if (z.hp <= 0) killZombie(g, z);
  }

  // A blast does not pick a victim: everyone standing inside it is caught by it.
  for (const p of g.players) {
    const pdx = p.x - x, pdy = p.y - y, playerDistance = Math.hypot(pdx, pdy) || 1;
    if (g.done || g.dead || p.down || p.inv > 0 || playerDistance >= radius) continue;
    const force = 1 - playerDistance / radius;
    hurt(g, p, pdx / playerDistance, pdy / playerDistance, 210 + force * 260, .65, playerDistance < 72 ? 2 : 1);
  }

  for (const car of g.cars) {
    const dx = car.x - x, dy = car.y - y, d = Math.hypot(dx, dy) || 1;
    if (d >= radius + 34) continue;
    const force = clamp(1 - d / (radius + 34), .08, 1), nx = dx / d, ny = dy / d;
    damageCar(g, car, 58 + force * 145, nx, ny, 'explosion', car.x - nx * 22, car.y - ny * 11);
    car.v += (car.hx * nx + car.hy * ny) * (35 + force * 95);
    car.hitFlash = Math.max(car.hitFlash || 0, .28);
  }

  // A blast that shatters car windows takes the street lighting with it.
  for (const l of lampsNear(g, x, y, radius)) {
    const dx = l.hx - x, dy = l.hy - y;
    if (dx * dx + dy * dy < radius * radius) breakLamp(g, l);
  }

  for (const part of g.zombieParts) {
    const dx = part.x - x, dy = part.y - y, d = Math.hypot(dx, dy) || 1;
    if (d >= radius) continue;
    const force = 1 - d / radius;
    if (part.kind === 'head') kickZombieHead(g, part, dx, dy, 110 + force * 250);
    else { part.vx += dx / d * (90 + force * 280); part.vy += dy / d * (90 + force * 280); part.vh += 45 + force * 100; }
  }

  const near = clamp(1 - playerDistance / 560, 0, 1);
  shakeAt(g, x, y, .8 + near * 2.7, 900);
  emit(g, EV.blast, x, y, near);
  makeNoise(g, x, y, 720, 14, true);
  SND.play('headBlast', x, y);
  return true;
}

function shootZombieHead(g, head, vx, vy) {
  // A tank head is heavy enough to stay aimable through the five-shot sequence.
  kickZombieHead(g, head, vx, vy, head.explosive ? 16 : 225);
  if (!head.explosive) return false;
  head.shotHits = (head.shotHits || 0) + 1;
  g.explosiveHeadHits = (g.explosiveHeadHits || 0) + 1;
  head.heat = clamp(head.shotHits / 5, 0, 1);
  head.hitFlash = .22;
  head.bleed = Math.max(head.bleed, 1.8 + head.heat);
  for (let k = 0; k < 5 + head.shotHits; k++)
    g.parts.push({ x: head.x, y: head.y, vx: rnd(-90, 90), vy: rnd(-105, 60), l: rnd(.18, .45),
      c: pick(['#a4db58', '#ff5a3f', '#ffad54']), s: rnd(2, 4) });
  return head.shotHits >= 5 ? explodeZombieHead(g, head) : false;
}

function severZombiePart(g, z, kind, side, dx, dy) {
  const len = Math.hypot(dx, dy) || 1, nx = dx / len, ny = dy / len;
  const point = zombieLocalPoint(z, kind === 'arm' ? 11 : 3, kind === 'arm' ? side * 10 : 0);
  const lateralX = -Math.sin(z.ang) * side, lateralY = Math.cos(z.ang) * side;
  const quiet = z.silent ? .35 : 1;
  const impulse = rnd(75, 145) * quiet;
  const part = {
    kind, side, x: point.x, y: point.y, h: kind === 'head' ? 10 : 7,
    vx: nx * impulse + lateralX * rnd(25, 70) * quiet,
    vy: ny * impulse + lateralY * rnd(25, 70) * quiet,
    vh: rnd(85, 145) * quiet, ang: z.ang, spin: rnd(-8, 8), size: z.size || 1,
    skin: z.skin || '#8fae63', eye: z.eye || '#ff5a45', blood: z.blood, stain: z.stain,
    explosive: kind === 'head' && z.kind === 'tank', shotHits: 0, heat: 0, hitFlash: 0,
    bleed: kind === 'arm' ? 3.4 : 1.5, bleedCd: 0, kickCd: 0,
    l: kind === 'head' ? Infinity : 18
  };
  g.zombieParts.push(part);
  if (kind === 'arm') {
    const arms = g.zombieParts.filter(o => o.kind === 'arm');
    if (arms.length > 72) g.zombieParts.splice(g.zombieParts.indexOf(arms[0]), 1);
  }
  sprayZombieBlood(g, z, point.x, point.y, nx, ny, kind === 'arm' ? 10 : 14, 1.05);
  z.bleed = Math.min(8, (z.bleed || 0) + (kind === 'arm' ? 2.8 : 4));
  z.bleedCd = 0;
}

function updateZombieDismemberment(g, z, dx, dy) {
  const damage = 1 - clamp(z.hp / Math.max(.01, z.maxHp), 0, 1);
  if (damage >= .3 && z.lostArms < 1) {
    z.lostArms = 1;
    severZombiePart(g, z, 'arm', z.armOrder || 1, dx, dy);
  }
  if (damage >= .7 && z.lostArms < 2) {
    z.lostArms = 2;
    severZombiePart(g, z, 'arm', -(z.armOrder || 1), dx, dy);
  }
  if (damage >= .9 && !z.headless) {
    z.headless = true;
    severZombiePart(g, z, 'head', 0, dx, dy);
  }
  if (z.lostArms >= 2 || z.headless) {
    z.throwWind = 0;
    z.throwCd = Math.max(z.throwCd, 99);
  }
}

function damageZombie(g, z, amount, dx, dy) {
  z.hp -= amount;
  updateZombieDismemberment(g, z, dx, dy);
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

// ---------- cash ----------
// The horde carries what it was carrying when the district went quiet. There is nothing to
// spend it on yet, so the wallet only accumulates across a run.
const CASH_DROP = { runner: [2, 5], walker: [3, 8], brute: [9, 16], tank: [26, 42] };
const CASH_CHANCE = .62;          // Not every body has a wallet on it.
function dropCash(g, z) {
  if (!z.dumb && Math.random() > CASH_CHANCE) return;   // A tank costs enough to always pay out.
  const band = CASH_DROP[z.kind] || CASH_DROP.walker;
  const a = Math.random() * 6.283, s = rnd(34, 82);
  g.cash.push({
    x: z.x, y: z.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
    n: Math.round(rnd(band[0], band[1])), ph: Math.random() * 6.283, tilt: rnd(-.6, .6)
  });
}

// ---------- street lighting ----------
// A lantern is glass on a bracket: one bullet ends it. The street goes dark, which is the
// courier's own problem, and the noise of it carries the way any broken window does.
function breakLamp(g, l) {
  if (l.broken) return false;
  l.broken = true;
  g.lampsBroken = (g.lampsBroken || 0) + 1;
  for (let k = 0; k < 14; k++)
    g.parts.push({ x: l.hx, y: l.hy, vx: rnd(-95, 95), vy: rnd(-125, 45), l: rnd(.3, .85),
      c: pick(['#fff3c8', '#cfe4ff', '#9aa6b2']), s: rnd(2, 4) });
  SND.play('glass', l.hx, l.hy);
  emit(g, EV.lamp, l.hx, l.hy);
  makeNoise(g, l.hx, l.hy, 230, 3, true);
  return true;
}

function killZombie(g, z) {
  if (z.gone) return;
  z.hp = 0;
  updateZombieDismemberment(g, z, Math.cos(z.ang), Math.sin(z.ang));
  z.gone = true; g.killed++;
  dropCash(g, z);
  addGroundBlood(g, z.x, z.y, z.stain, z.kind === 'brute' ? 14 : 10);
  sprayZombieBlood(g, z, z.x, z.y, Math.cos(z.ang), Math.sin(z.ang), z.kind === 'brute' ? 22 : 17, 1.08);
  for (let k = 0; k < 18; k++)
    g.parts.push({ x: z.x, y: z.y, vx: rnd(-170, 170), vy: rnd(-170, 170), l: rnd(.3, .8), c: pick(z.blood), s: rnd(2, 5) });
  const drop = Math.random();
  if (drop < .48) g.ammoBoxes.push({ x: z.x, y: z.y, batt: drop < .14, n: 7, ph: Math.random() * 6.283 });
  SND.play(z.silent ? 'hit' : 'die', z.x, z.y, z.seed);
}

// ---------- patrol gunfire ----------
const COP_RANGE = 330;            // Anything further is hopeless from a moving car.
const COP_CD = [.42, .8];         // Cadence, not an ammunition count: the patrol never runs dry.
const COP_DMG = .5;               // Half a hit, so a standard walker takes four.
const COP_BV = 700;
const COP_AGGRO = 250;            // A patrol closer than this becomes a target for the horde.
const COP_DROP = 420;             // And is forgotten past this range.

// The patrol does not fire through houses, hedges, or parked cars.
function shotBlocked(g, x0, y0, x1, y1) {
  for (let i = 1; i <= 7; i++) {
    const t = i / 8, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    for (const s of solidsNear(g, x, y, 0)) if (inOBB(x, y, s)) return true;
  }
  return false;
}

// Nearest zombie in the clear; only the closest few are ray-checked.
function policeTarget(g, c) {
  const near = [];
  for (const z of g.zombies) {
    if (z.gone) continue;
    const dx = z.x - c.x, dy = z.y - c.y, d2 = dx * dx + dy * dy;
    if (d2 <= COP_RANGE * COP_RANGE) near.push({ z, d2 });
  }
  near.sort((a, b) => a.d2 - b.d2);
  for (let i = 0; i < near.length && i < 4; i++)
    if (!shotBlocked(g, c.x, c.y, near[i].z.x, near[i].z.y)) return near[i].z;
  return null;
}

function policeFire(g, c, z) {
  // Whichever side window faces the target; the muzzle follows the deformed body.
  const side = ((z.x - c.x) * -c.hy + (z.y - c.y) * c.hx) > 0 ? 1 : -1;
  const m = bodyPointWorld(c, 0, side * 8.3);
  c.copSide = side; c.copFlash = .07;

  // A shot from a moving car is a bad shot. The nominal figure runs a few points above
  // the target band: some aimed shots are still eaten by hedges, traffic, and other bodies,
  // so the measured rate lands at roughly 40 % standing still and 30 % at full speed.
  const acc = .45 - .1 * clamp(c.v / (c.baseMax || c.max || 1), 0, 1);
  const hitIntended = Math.random() < acc;
  const range = Math.hypot(z.x - m.x, z.y - m.y) || 1;
  const flight = range / COP_BV;
  const aimX = z.x + z.mvx * flight, aimY = z.y + z.mvy * flight;   // Lead, or the target simply walks out of the shot.
  let a = Math.atan2(aimY - m.y, aimX - m.x);
  // The deflection is measured in pixels rather than degrees: a fixed angle still
  // lands on the target at close range, and the miss rate would drift with distance.
  if (!hitIntended) a += (Math.random() < .5 ? -1 : 1) * (z.r + 7 + rnd(6, 32)) / range;
  else a += rnd(-4, 4) / range;

  const ca = Math.cos(a), sa = Math.sin(a);
  // A miss stays a miss: without this the deflection lands on a neighbour in the crowd
  // and the patrol's real hit rate climbs far above the intended one.
  g.bullets.push({
    x: m.x + ca * 7, y: m.y + sa * 7, px: m.x + ca * 7, py: m.y + sa * 7,
    vx: ca * COP_BV, vy: sa * COP_BV, l: .5, own: c, dmg: COP_DMG, whiff: !hitIntended
  });
  for (let k = 0; k < 3; k++)
    g.parts.push({ x: m.x + ca * 8, y: m.y + sa * 8, vx: ca * rnd(30, 110) + rnd(-40, 40),
      vy: sa * rnd(30, 110) + rnd(-40, 40), l: rnd(.08, .2), c: '#cfe4ff', s: rnd(2, 3) });
  SND.play('copshot', m.x, m.y);
  makeNoise(g, c.x, c.y, 300, 4);          // Gunfire draws the horde to the car, not to the courier.
}

function updatePoliceFire(g, c, dt) {
  c.copFlash = Math.max(0, c.copFlash - dt);
  if (c.broken || g.done) return;
  c.copCd -= dt;
  if (c.copCd > 0) return;
  const z = policeTarget(g, c);
  if (!z) { c.copCd = .18; return; }        // Nothing in sight: check again shortly.
  c.copCd = rnd(COP_CD[0], COP_CD[1]);
  policeFire(g, c, z);
}

// ---------- infighting ----------
const FEUD_TIME = [8, 13];        // How long a grudge lasts before the horde re-focuses on the courier.
const FILTH_DMG = 1;

// Doom rules: whoever gets splattered by a neighbour turns on the thrower.
function startFeud(a, b) {
  const t = rnd(FEUD_TIME[0], FEUD_TIME[1]);
  a.rival = b; a.rivalCd = t; a.foeCar = null;
  b.rival = a; b.rivalCd = t; b.foeCar = null;
}

function hitByFilth(g, z, s) {
  const speed = Math.hypot(s.vx, s.vy) || 1;
  damageZombie(g, z, FILTH_DMG, s.vx, s.vy);
  z.hit = .2;
  z.kx += s.vx * .1; z.ky += s.vy * .1;
  z.bleed = Math.min(7, (z.bleed || 0) + 2.4);
  z.bleedCd = 0;
  sprayZombieBlood(g, z, s.x, s.y, s.vx / speed, s.vy / speed, 13, 1);
  splatFilth(g, s);
  if (s.owner && !s.owner.gone) startFeud(z, s.owner);
  if (z.hp <= 0) killZombie(g, z); else SND.play('splat', z.x, z.y);
}

// ---------- stealth ----------
const FRONT_ARC = 1.75;           // A zombie watches roughly a 200-degree arc in front of itself.
const NOTICE_RUN = 150, NOTICE_WALK = 90, NOTICE_STILL = 45, NOTICE_SNEAK = 38;
const BACK_FACTOR = .38;          // From behind everything shrinks: 57 / 34 / 17 steps.
const NOTICE_FILL = 1 / .55;      // Full awareness in just over half a second in the open.
const NOTICE_FILL_BEAM = 1 / .2;  // A beam in the face is almost instant.
const NOTICE_FADE = 1 / 2.4;      // And it cools down slowly.
const NOTICE_SNEAK_FILL = .65;     // Crawling buys time, not invisibility at close range.
const CONTACT_NOTICE_PAD = 2;      // Physical contact always defeats stealth from any direction.

// Whoever is standing close enough to pick something up off the ground. Reaching in list order
// means that when two couriers arrive on the same frame the same one gets it every time, which
// matters rather more once one of them is deciding it on a different machine.
const PICKUP_REACH = 22;
function pickerAt(g, x, y) {
  for (const p of g.players) {
    if (p.down) continue;
    if (Math.hypot(p.x - x, p.y - y) < PICKUP_REACH) return p;
  }
  return null;
}

// The nearest courier still on their feet. A courier who is down is nobody's target: the horde
// loses interest in a body, which is what leaves their partner a chance to reach them.
function nearestCourier(g, x, y) {
  let best = null, bd = Infinity;
  for (const p of g.players) {
    if (p.down) continue;
    const dx = p.x - x, dy = p.y - y, d2 = dx * dx + dy * dy;
    if (d2 < bd) { bd = d2; best = p; }
  }
  return best;
}

// What one courier is giving away to one zombie this frame. Sprinting in the open carries much
// further than crawling behind it, a zombie only watches its own front, and a flashlight lands
// on the ground regardless of which way it happens to be facing.
function noticeFor(g, z, p, canNotice, lightRange) {
  const dx = p.x - z.x, dy = p.y - z.y, d = Math.hypot(dx, dy) || 1;
  const front = (dx * Math.cos(z.ang) + dy * Math.sin(z.ang)) / d > Math.cos(FRONT_ARC);
  const reach = (p.sneaking ? NOTICE_SNEAK : p.running ? NOTICE_RUN : p.moving ? NOTICE_WALK : NOTICE_STILL) *
                (front ? 1 : BACK_FACTOR) * (z.dumb ? .7 : 1);
  const touching = canNotice && d < PR + z.r + CONTACT_NOTICE_PAD;
  let exposed = canNotice && (touching || d < reach);
  let inBeam = false;
  if (canNotice && p.torch && p.batt > 0 && d < lightRange - 64 * g.weather.rain) {
    const h = torchHand(p), hx = z.x - h.x, hy = z.y - h.y, hd = Math.hypot(hx, hy) || 1;
    const ca = Math.cos(p.aim), sa = Math.sin(p.aim);
    if ((hx * ca + hy * sa) > hd * Math.cos(.62)) inBeam = exposed = true;
  }
  const fill = inBeam ? NOTICE_FILL_BEAM : exposed ? NOTICE_FILL * (front ? 1 : .55) *
               (p.sneaking ? NOTICE_SNEAK_FILL : 1) : 0;
  return { p, dx, dy, d, front, touching, exposed, inBeam, fill };
}
const TAKEDOWN_RANGE = 26;
const TAKEDOWN_ARC = 1.9;         // The courier must be well behind the shoulder line.
const TAKEDOWN_LOCK = .35;        // A short freeze: finishing inside a crowd is a bad idea.
const SNEAK_SPEED = 68;

// One courier's own frame: what they are carrying out with their body, from the input record
// and nothing else. Pulling it out of update is what lets the same code move a courier standing
// in this room and a courier whose keystrokes arrived over a wire — and, later, lets a guest
// replay its own moves ahead of the host without a second implementation to keep honest.
function stepCourier(g, p, dt) {
  const inp = p.in;
  if (p.down) {                                 // Lying in the street: no walking, no torch, no aim.
    p.vx = p.vy = 0;
    p.moving = p.running = p.sneaking = false;
    p.inv = Math.max(0, p.inv - dt);
    p.stagger = Math.max(0, p.stagger - dt);
    return;
  }
  // A courier stepping into a district adopts whatever the counters already read. They keep
  // climbing across districts, and presses made before this shift are not theirs to act on.
  if (p.torchSeen === null) { p.torchSeen = inp.torchSeq; p.sneakSeen = inp.sneakSeq; }
  // A press is only a press the first time it is seen. The rules decide what it means, which is
  // why the flashlight can be switched on here and switched off by a flat battery below.
  if (inp.torchSeq !== p.torchSeen) {
    p.torchSeen = inp.torchSeq;
    p.torch = !p.torch;
    SND.play(p.torch && p.batt > 0 ? 'click' : 'empty');
  }
  if (inp.sneakSeq !== p.sneakSeen) { p.sneakSeen = inp.sneakSeq; p.sneakToggle = !p.sneakToggle; }

  p.inv = Math.max(0, p.inv - dt);

  // Bushes slow movement.
  let inBush = false;
  for (const b of g.soft) {
    const dx = b.x - p.x, dy = b.y - p.y, r = b.r * .9;
    if (dx * dx + dy * dy < r * r) { inBush = true; break; }
  }
  let dirX = inp.x, dirY = inp.y, dirM = inp.m, wantRun = inp.run, wantSneak = p.sneakToggle;
  if (g.stealthQaInput) {
    dirX = 0; dirY = -1; dirM = 1; wantRun = false; wantSneak = g.stealthQaInput === 'crawl';
  }

  // The flashlight drains and flickers at low charge.
  if (p.torch && p.batt > 0) {
    p.batt = Math.max(0, p.batt - BATT_DRAIN * dt);
    p.flick = p.batt < .16 ? (Math.random() < .12 ? rnd(.15, .5) : rnd(.75, 1)) : 1;
    if (p.batt === 0) p.torch = false;
  } else p.flick = 1;

  // Sprinting consumes stamina and creates noise.
  p.sneaking = wantSneak && p.stagger <= 0 && p.takedown <= 0;
  p.running = wantRun && !p.sneaking && dirM > .2 && p.stam > .06 && p.stagger <= 0;
  p.moving = dirM > .2;                         // Standing still is what makes a zombie hard to alert.
  if (p.sneaking && p.moving) p.stealthCrawlTime = (p.stealthCrawlTime || 0) + dt;
  if (p.running) { p.stam = Math.max(0, p.stam - STAM_DRAIN * dt); p.rest = .55; }
  else {
    p.rest = Math.max(0, p.rest - dt);
    if (p.rest <= 0) p.stam = Math.min(1, p.stam + STAM_REGEN * dt);
  }
  // The courier moves noticeably faster on asphalt than through grass and yards.
  const road = surfaceAt(g, p.x, p.y);
  const movementSpeed = p.sneaking ? SNEAK_SPEED : p.running ? RUN : WALK;
  const speed = (inBush ? .62 : 1) * movementSpeed * (p.stagger > 0 ? .35 : 1) * (1 + .18 * road);
  p.stagger = Math.max(0, (p.stagger || 0) - dt);

  // Sprinting carries far, walking is quiet, and soles sound sharper on asphalt.
  if (dirM > .2) {
    p.step -= dt;
    if (p.step <= 0) {
      p.step = (p.sneaking ? 1.15 : p.running ? .34 : .8) * (1 - .12 * road);
      makeNoise(g, p.x, p.y,
        (p.sneaking ? 28 : p.running ? 210 : 78) * (1 + .3 * road),
        p.sneaking ? .35 : p.running ? 3.5 : 1.2, p.running);
      if (!p.sneaking) SND.play(road > .5 ? 'stepA' : 'stepG', p.x, p.y);
    }
  } else p.step = .1;

  const tvx = dirX * speed, tvy = dirY * speed;
  const acc = (14 - 5 * road * g.weather.wet) * dt;      // Wet asphalt makes acceleration and braking sluggish.
  p.vx += (tvx - p.vx) * Math.min(1, acc);
  p.vy += (tvy - p.vy) * Math.min(1, acc);
  if (p.kx) { p.x += p.kx * dt; p.y += p.ky * dt; p.kx *= .88; p.ky *= .88; if (Math.abs(p.kx) < 5) p.kx = p.ky = 0; }
  p.x += p.vx * dt; p.y += p.vy * dt;
  if (dirM > .05) { p.ang = Math.atan2(p.vy, p.vx); p.walk += dt * (p.sneaking ? 5 : inBush ? 7 : 11); }
  else p.walk += dt * 1.5;

  p.x = clamp(p.x, PR, WORLD - PR); p.y = clamp(p.y, PR, WORLD - PR);
  for (const s of solidsNear(g, p.x, p.y, PR)) hitOBB(p, PR, s);
  for (const t of treesNear(g, p.x, p.y, PR)) hitCircle(p, PR, t);
  // The camera belongs to whoever is watching this screen, and it has to be current before a
  // point on that screen can be read as a point in the town.
  if (p === g.p) g.cam = camOf(g);

  // Aim with the mouse, or fall back to the movement direction.
  if (inp.aimScreen && p === g.p) { p.tx = inp.sx + g.cam.x; p.ty = inp.sy + g.cam.y; }
  else if (inp.aimScreen) { p.tx = inp.tx; p.ty = inp.ty; }
  else { p.tx = p.x + Math.cos(p.ang) * 300; p.ty = p.y + Math.sin(p.ang) * 300; }
  p.aim = Math.atan2(p.ty - p.y, p.tx - p.x);
}

// What a courier does with their hands: the pistol and the knife. Kept apart from stepCourier
// because a guest predicts where its own body goes but never predicts a shot — the shot is the
// host's to allow, and a bullet that appears and then unfires would be worse than one that waits.
function actCourier(g, p, dt) {
  p.cool = Math.max(0, p.cool - dt);
  p.muzzle = Math.max(0, p.muzzle - dt);
  if (p.down) { p.finishTarget = null; return; }
  const wantFire = p.in.fire;
  if (wantFire && p.cool <= 0 && p.ammo > 0 && !g.done) fire(g, p);

  // Silent finish from behind: no shot, almost no noise, but the courier is rooted for a
  // moment — doing this in the middle of a crowd gets him bitten.
  p.takedown = Math.max(0, p.takedown - dt);
  p.finishTarget = takedownTarget(g, p);
  const wantFinish = p.in.finish;
  if (wantFinish && !p.finishHeld && p.finishTarget) {
    const z = p.finishTarget;
    p.takedown = TAKEDOWN_LOCK;
    p.stagger = Math.max(p.stagger, TAKEDOWN_LOCK);
    z.silent = true;
    killZombie(g, z);
    makeNoise(g, z.x, z.y, 50, 1);
    g.takedowns++;
    p.finishTarget = null;
  }
  p.finishHeld = wantFinish;
}

// A courier who is down can be brought back by their partner kneeling over them. It is the one
// thing on a shift that either of them can do for the other, and it is deliberately slow enough
// to be a decision: three seconds standing still beside a body, in a district that has noticed.
const REVIVE_REACH = 28, REVIVE_TIME = 3;
function reviveCouriers(g, dt) {
  for (const p of g.players) {
    if (!p.down) continue;
    let helper = null;
    for (const q of g.players) {
      if (q === p || q.down || q.stagger > 0) continue;
      if (Math.hypot(q.x - p.x, q.y - p.y) < REVIVE_REACH) { helper = q; break; }
    }
    p.reviveT = helper ? p.reviveT + dt : Math.max(0, p.reviveT - dt * 1.6);
    if (p.reviveT < REVIVE_TIME) continue;
    p.down = false; p.reviveT = 0;
    p.hp = Math.max(1, Math.round(p.hpMax * .4));   // Back on their feet, not back to full.
    p.inv = 2.2; p.vx = p.vy = p.kx = p.ky = 0;
    SND.play('pick', p.x, p.y);
    emit(g, EV.revive, p.id, p.x, p.y);
  }
}

// A silent finish is only available on an unaware zombie approached from behind.
function takedownTarget(g, p) {
  if (g.done || p.stagger > 0 || p.takedown > 0) return null;
  let best = null, bd = TAKEDOWN_RANGE * TAKEDOWN_RANGE;
  for (const z of g.zombies) {
    if (z.gone || z.dumb || z.hunt > 0 || z.notice > .55) continue;   // Too big to finish quietly.
    const dx = p.x - z.x, dy = p.y - z.y, d2 = dx * dx + dy * dy;
    if (d2 > bd) continue;
    const d = Math.sqrt(d2) || 1;
    if ((dx * Math.cos(z.ang) + dy * Math.sin(z.ang)) / d > Math.cos(TAKEDOWN_ARC)) continue;
    bd = d2; best = z;
  }
  return best;
}

// ---------- untangling traffic ----------
const REV_SPEED = 62;             // Reversing is slow: this is a manoeuvre, not an escape.

// Escalating jam resolution. Backing out alone changes nothing — the geometry stays the
// same and the car drives straight back into the same conflict. Each repeat escalates.
function resolveJam(g, c, blocker) {
  c.jamTries++;
  // Parked and disabled cars never move, so waiting or backing off buys nothing:
  // skip straight to taking another road.
  const willMove = blocker && !blocker.broken && blocker.id !== undefined;
  if (!willMove) c.jamTries = 3;

  if (c.jamTries === 1 && willMove && blocker.id > c.id) {
    c.yieldTo = blocker; c.yieldT = 2.5;            // Lower id keeps priority; stand aside.
    return;
  }
  if (c.jamTries <= 2 && !rearBlocked(g, c)) {
    c.rev = rnd(.75, 1.35); c.revCd = c.rev + rnd(1.1, 1.9);
    if (willMove) { c.yieldTo = blocker; c.yieldT = 2.5; } // Back out, then let them through.
    return;
  }
  // Third attempt: give up on this exit and take another one out of the intersection.
  c.rev = 0; c.yieldTo = null; c.hold = false;
  if (c.jamTries === 3 && c.mode === 'turn' && c.turn) {
    const avoid = c.turn.next.id;
    c.mode = 'edge'; c.turn = null; c.node = -1;    // Release the intersection before retrying.
    startTurn(g, c, avoid);
    c.revCd = 2.5;
    return;
  }
  // Fourth and beyond: the whole intersection is impassable — a wreck can sit right in
  // it — so leave it behind entirely instead of picking yet another blocked exit.
  if (c.mode === 'turn') { c.mode = 'edge'; c.turn = null; c.node = -1; }
  startUTurn(c);
  c.v = Math.min(c.v, 30);
  c.revCd = 2.5;
}

// A car can end up physically boxed in with no legal way out: a wreck standing in the
// intersection, another car behind. Rather than let it grind there forever, put it back
// into traffic somewhere else — but only while the player cannot see it happen.
function respawnCar(g, c) {
  // In sight of the player nothing may teleport, so the caller falls back to the normal
  // escalation instead. Swallowing the attempt here would starve it and freeze the car.
  const cam = camOf(g), m = 90;
  if (c.x > cam.x - m && c.x < cam.x + cv.width + m &&
      c.y > cam.y - m && c.y < cam.y + cv.height + m) return false;
  for (let t = 0; t < 30; t++) {
    const e = pick(g.roads.edges);
    if (e.len < 140) continue;
    c.edge = e; c.dir = Math.random() < .5 ? 1 : -1; c.s = rnd(50, e.len - 50);
    c.mode = 'edge'; c.turn = null; c.node = -1;
    placeCar(c);
    if (Math.hypot(c.x - g.p.x, c.y - g.p.y) < 420) continue;
    if (g.cars.some(o => o !== c && Math.hypot(o.x - c.x, o.y - c.y) < 110)) continue;
    break;
  }
  c.v = 0; c.rev = 0; c.revCd = 0; c.yieldTo = null; c.yieldT = 0;
  c.jamTries = 0; c.stuck = 0; c.dead = 0; c.freeT = 0; c.hold = false;
  return true;
}

// Is there room behind? The rear corridor is scanned exactly like the forward one.
function rearBlocked(g, c) {
  for (let i = 1; i <= 2; i++) {
    const box = ahead(c, -(28 + i * 32));
    for (const o of g.cars) if (o !== c && obbHit(box, o.box)) return true;
    for (const q of parkedNear(g, box.cx, box.cy, box.rad)) if (obbHit(box, q)) return true;
  }
  return false;
}

// Apply one hit to one courier from a car or zombie.
function hurt(g, p, dx, dy, power, stagger = .5, amount = 1) {
  p.hp -= amount; p.inv = 1.9; p.stagger = stagger;
  shakeAt(g, p.x, p.y, 1);
  emit(g, EV.hurt, p.id, p.x, p.y, amount);
  p.kx = dx * power; p.ky = dy * power;
  for (let k = 0; k < 16 + (amount - 1) * 8; k++)
    g.parts.push({ x: p.x, y: p.y, vx: rnd(-160, 160), vy: rnd(-160, 160), l: rnd(.3, .7), c: '#ff6b5a', s: rnd(2, 5) });
  SND.play('hurt', p.x, p.y);
  if (p.hp <= 0) downCourier(g, p);
}

// A courier out of health is down where they fell. The district is only lost when there is
// nobody left standing — which alone in a district is the same moment, and on a shift with a
// partner is a problem somebody else can still walk over and solve.
function downCourier(g, p) {
  p.down = true;
  emit(g, EV.down, p.id, p.x, p.y);
  if (g.players.every(q => q.down)) loseLife(g);
}

// Every district ends on the same screen: the briefing steps aside for the result, and the
// button carries the only action left in this state.
function showResult(title, subtitle, html, button) {
  cv.classList.remove('aim');
  overlay.classList.remove('hidden');
  overlay.classList.add('overlay--result');
  UI.overlayTitle.textContent = title;
  UI.overlaySubtitle.textContent = subtitle;
  UI.overlayMessage.innerHTML = html;
  startBtn.textContent = button;
}

// The last parcel has been signed off. The celebration plays where the courier is standing,
// which is the door they just walked up to.
function finishDistrict(g, p) {
  g.done = true;
  SND.play('win');
  for (let k = 0; k < 40; k++)
    g.parts.push({ x: p.x, y: p.y, vx: rnd(-200, 200), vy: rnd(-260, -40), l: rnd(.6, 1.3),
                   c: pick(['#8fe388', '#ffd766', '#ffffff']), s: rnd(2, 5) });
  if (g.level + 1 > runtime.best) {
    runtime.best = g.level + 1;
    gameStorage.set(STORAGE_KEYS.best, runtime.best);
    UI.best.textContent = runtime.best;
  }
  setTimeout(() => {
    runtime.state = 'win';
    showResult(
      'DELIVERED!',
      `district ${g.level} completed in ${g.time.toFixed(1)} s`,
      `Parcels delivered: <b>${g.delivered}</b>, one address at a time.<br>` +
      `Zombies eliminated: <b>${g.killed}</b>. Dodges / surges: <b>${g.dodges}</b> / <b>${g.surges}</b>.<br>` +
      `Filth hits: <b>${g.filthHits}</b> of ${g.filthThrown}.<br>` +
      `Cash picked up: <b>$${g.earned}</b>; the wallet holds <b>$${runtime.cash}</b>.<br>` +
      `Road kills: <b>${g.roadKills}</b>; vehicles disabled: <b>${g.carsBroken}</b>.<br>` +
      `Next is district <b>${g.level + 1}</b>, with more parcels, cars, and zombies.<br>` +
      `Health and ammunition reset; lives carry over — <b>${runtime.lives}</b> of ${LIVES_MAX} left.`,
      'NEXT DISTRICT');
  }, 900);
}

// Health runs out inside a district; a life is the right to walk that district again.
function loseLife(g) {
  g.dead = true;
  runtime.lives = Math.max(0, runtime.lives - 1);
  if (runtime.lives <= 0) { gameOver(g); return; }
  runtime.state = 'retry';
  SND.play('over'); SND.rain(0);
  drawHud(g);
  showResult(
    'COURIER DOWN',
    `district ${g.level}, parcels ${g.delivered} of ${g.need}, lives left ${runtime.lives}`,
    `Zombies eliminated: <b>${g.killed}</b>; road kills: <b>${g.roadKills}</b>.<br>` +
    `Cash picked up: <b>$${g.earned}</b>; the wallet holds <b>$${runtime.cash}</b>.<br>` +
    `The district is dispatched again from the depot: a fresh street layout, ` +
    `full health, and a full magazine.<br>` +
    `Lives are not restored — <b>${runtime.lives}</b> of ${LIVES_MAX} left for the whole run.`,
    'RETRY DISTRICT');
}

// Bodies must separate physically after a bite. Otherwise the pursuer remains inside
// the player, closes the gap during invulnerability, and guarantees another bite.
function settleCircleBody(g, body, radius) {
  body.x = clamp(body.x, radius, WORLD - radius);
  body.y = clamp(body.y, radius, WORLD - radius);
  for (const s of solidsNear(g, body.x, body.y, radius)) hitOBB(body, radius, s);
  for (const t of treesNear(g, body.x, body.y, radius)) hitCircle(body, radius, t);
  body.x = clamp(body.x, radius, WORLD - radius);
  body.y = clamp(body.y, radius, WORLD - radius);
}

function resolveZombieContact(g, z, p) {
  let dx = p.x - z.x, dy = p.y - z.y;
  let d = Math.hypot(dx, dy);
  const contactDistance = PR + z.r + CONTACT_NOTICE_PAD;
  if (d >= contactDistance) return false;

  // A body bump is impossible to hide. Wake even during post-hit invulnerability so the
  // zombie keeps reacting instead of appearing oblivious while the courier slips through it.
  const canWake = !g.done && g.spawnGrace <= 0;
  const newlyAwake = canWake && z.hunt <= 0;
  if (canWake) {
    z.notice = 1;
    z.hunt = Math.max(z.hunt, z.dumb ? 9 : 3.2);
    z.tx = p.x; z.ty = p.y;
    z.foeCar = null;
    if (newlyAwake) {
      z.moan = rnd(1.6, 2.8);
      makeNoise(g, z.x, z.y, 145, 2.2, false, z);
      SND.play('moan', z.x, z.y, z.seed);
    }
  }

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
  settleCircleBody(g, z, z.r);

  // While flashing, the player can slip out of the horde. The enemy is still pushed
  // away, but no repeat bite or additional movement lock occurs.
  if (protectedPlayer) return canWake;

  z.recoil = .48;
  z.kx = -nx * 260;
  z.ky = -ny * 260;
  z.dodgeTime = 0;
  z.surge = 0;
  z.pressure = 0;
  z.throwWind = 0;
  z.throwCd = Math.max(z.throwCd, .75);
  hurt(g, p, nx, ny, 190, .28);
  return canWake;
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
    g.bloodQaDone = true; damageZombie(g, z, 1, 0, -1); z.hit = .45; z.alert = 0;
    z.bleed = 3.8; z.bleedCd = 0;
    sprayZombieBlood(g, z, z.x, z.y, 0, -1, 18, 1.08);
  }
  if (g.dismemberQa && g.zombies[0]) {
    const z = g.zombies[0];
    const steps = [{ at: .35, damage: 3 }, { at: 1.05, damage: 4 }, { at: 1.75, damage: 2 }];
    while (g.dismemberQaStep < steps.length && g.time >= steps[g.dismemberQaStep].at) {
      const step = steps[g.dismemberQaStep++];
      damageZombie(g, z, step.damage, 0, -1); z.hit = .45; z.alert = 0;
    }
  }
  if (g.dismemberQa && !g.headKickQaDone && g.time >= 2.25) {
    const head = g.zombieParts.find(part => part.kind === 'head');
    if (head) { g.headKickQaDone = true; kickZombieHead(g, head, 1, 0, 185); }
  }
  if (g.headExplosionQa) {
    if (g.headExplosionQaStep === 0 && g.time >= .25) {
      const source = g.zombies.find(z => z.kind === 'tank' && !z.gone);
      if (source) {
        killZombie(g, source);
        const qaHead = g.zombieParts.find(part => part.kind === 'head' && part.explosive);
        if (qaHead) Object.assign(qaHead, { x: source.x, y: source.y, h: 0, vx: 0, vy: 0, vh: 0 });
        g.headExplosionQaStep = 1;
      }
    }
    const hitTimes = [.55, .85, 1.15, 1.45, 1.75];
    const head = g.zombieParts.find(part => part.kind === 'head' && part.explosive);
    while (head && g.headExplosionQaStep >= 1 && g.headExplosionQaStep <= 5 &&
           g.time >= hitTimes[g.headExplosionQaStep - 1]) {
      if (g.headExplosionQaStep === 5 && g.cars[0]) {
        g.cars[0].x = head.x - 70; g.cars[0].y = head.y;
      }
      shootZombieHead(g, head, 1, 0);
      g.headExplosionQaStep++;
    }
  }
  g.events.length = 0;                  // Each frame writes its own notes; a snapshot takes them.
  g.spawnGrace = Math.max(0, g.spawnGrace - dt);
  g.shake = Math.max(0, g.shake - dt * 3);
  const p = g.p;
  listenFor(g, p);
  // The courier in front of this screen reads their own devices; anyone else on the shift
  // arrives with their record already filled in from the wire.
  readLocalInput(g, g.p);
  if (g.coopLocal) for (const courier of g.players) if (courier !== g.p) readSecondInput(g, courier);
  for (const courier of g.players) stepCourier(g, courier, dt);

  updateWeather(g, dt);
  updateFog(g, dt);

  // Firing, finishing, and helping a partner back to their feet.
  for (const courier of g.players) actCourier(g, courier, dt);
  reviveCouriers(g, dt);

  // Bullets.
  for (let i = g.bullets.length - 1; i >= 0; i--) {
    const b = g.bullets[i];
    b.l -= dt; b.px = b.x; b.py = b.y;
    b.x += b.vx * dt; b.y += b.vy * dt;
    let gone = b.l <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD || b.y > WORLD;
    // The flight path of one frame is short, so only the parked cars along it are tested.
    if (!gone) for (const c of parkedNear(g, (b.px + b.x) * .5, (b.py + b.y) * .5,
                                          Math.max(Math.abs(b.x - b.px), Math.abs(b.y - b.py)) * .5)) {
      const contact = segmentCarContact(c, b.px, b.py, b.x, b.y);
      if (!contact) continue;
      b.x = contact.x; b.y = contact.y; damageCarWithBullet(g, c, contact, b); gone = 'c'; break;
    }
    if (!gone) for (const s of solidsNear(g, b.x, b.y, 0))
      if (s.t !== 'parked' && inOBB(b.x, b.y, s)) { gone = 'w'; break; }
    if (!gone) for (const t of treesNear(g, b.x, b.y, 0))
      { const dx = t.x - b.x, dy = t.y - b.y;
        if (dx * dx + dy * dy < t.r * t.r) { gone = 'w'; break; } }
    if (!gone) {
      let carHit = null, hitCar = null;
      for (const c of g.cars) {
        if (c === b.own) continue;                    // The muzzle sits on the body: never shoot your own car.
        const contact = segmentCarContact(c, b.px, b.py, b.x, b.y);
        if (contact && (!carHit || contact.t < carHit.t)) { carHit = contact; hitCar = c; }
      }
      if (carHit) {
        b.x = carHit.x; b.y = carHit.y;
        damageCarWithBullet(g, hitCar, carHit, b); gone = 'c';
      }
    }
    if (!gone) {
      let headHit = null, headT = 2;
      for (const part of g.zombieParts) {
        if (part.kind !== 'head') continue;
        const t = segmentCircleT(b.px, b.py, b.x, b.y, part.x, part.y, 8 * (part.size || 1));
        if (t !== null && t < headT) { headHit = part; headT = t; }
      }
      if (headHit) {
        b.x = b.px + (b.x - b.px) * headT; b.y = b.py + (b.y - b.py) * headT;
        shootZombieHead(g, headHit, b.vx, b.vy);
        gone = 'h';
      }
    }
    if (!gone && !b.whiff) {
      let zombieHit = null, zombieT = 2;
      for (const z of g.zombies) {
        if (z.gone) continue;
        const t = segmentCircleT(b.px, b.py, b.x, b.y, z.x, z.y, z.r + 3);
        if (t !== null && t < zombieT) { zombieHit = z; zombieT = t; }
      }
      if (zombieHit) {
      const z = zombieHit;
      b.x = b.px + (b.x - b.px) * zombieT; b.y = b.py + (b.y - b.py) * zombieT;
      const bulletSpeed = Math.hypot(b.vx, b.vy) || 1;
      const dmg = b.dmg || 1;
      damageZombie(g, z, dmg, b.vx, b.vy); z.hit = .2; z.alert = 6;
      z.kx += b.vx * .12 * dmg; z.ky += b.vy * .12 * dmg;
      z.bleed = Math.min(7, (z.bleed || 0) + (z.kind === 'brute' ? 3.8 : 2.7) * dmg);
      z.bleedCd = 0;
      if (b.own) { z.foeCar = b.own; z.foeCd = rnd(2.2, 3.6); }   // Being shot at makes the shooter the new target.
      sprayZombieBlood(g, z, b.x, b.y, b.vx / bulletSpeed, b.vy / bulletSpeed,
        z.kind === 'brute' ? 18 : 14, z.kind === 'brute' ? 1.08 : 1);
      if (z.hp <= 0) killZombie(g, z); else SND.play('hit', b.x, b.y);
      gone = 'z';
      }
    }
    // A lantern hangs above the street, so it is the last thing a shot can meet: anything
    // standing on the road takes the bullet first, and only a clear line reaches the glass.
    if (!gone) for (const l of lampsNear(g, (b.px + b.x) * .5, (b.py + b.y) * .5,
                                         Math.max(Math.abs(b.x - b.px), Math.abs(b.y - b.py)) * .5)) {
      if (l.broken) continue;
      const t = segmentCircleT(b.px, b.py, b.x, b.y, l.hx, l.hy, l.headR);
      if (t === null) continue;
      b.x = b.px + (b.x - b.px) * t; b.y = b.py + (b.y - b.py) * t;
      breakLamp(g, l);
      gone = 'l';
      break;
    }
    if (gone) {
      if (gone === 'w') SND.play('wall', b.x, b.y);
      for (let k = 0; k < 3; k++)
        g.parts.push({ x: b.x, y: b.y, vx: rnd(-70, 70), vy: rnd(-70, 70), l: rnd(.1, .25),
          c: gone === 'c' ? pick(['#d8e0e6', '#ffe08a', '#7c858d']) : gone === 'h' ? '#96d85a' :
             gone === 'l' ? pick(['#fff3c8', '#cfe4ff']) : '#ffe08a', s: 2 });
      g.bullets.splice(i, 1);
    }
  }

  // Zombies. Stealth is gathered per courier — two of them working opposite ends of a street
  // are in quite different amounts of trouble, and each gauge should say so.
  let activeSurges = 0;
  const noticeBy = g.players.map(() => 0);
  const watchersBy = g.players.map(() => 0);
  const detectedBy = g.players.map(() => false);
  for (const z of g.zombies) if (!z.gone && z.surge > 0) activeSurges++;
  for (const z of g.zombies) {
    if (z.gone) continue;
    if (z.guardParcel >= 0 && g.parcels[z.guardParcel].state !== 'ground') z.guardParcel = -1;
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
    // During the opening seconds, the district ignores the spawn and starting beam.
    const canNotice = !g.done && g.spawnGrace <= 0;
    const lightRange = z.guardParcel >= 0 ? 275 : 400;

    // A zombie works out whoever is giving themselves away hardest, and settles ties by which
    // of them is closer. It has one head, so it can only be watching one courier at a time.
    let look = null;
    for (const courier of g.players) {
      if (courier.down) continue;
      const cand = noticeFor(g, z, courier, canNotice, lightRange);
      if (!look || cand.fill > look.fill || (cand.fill === look.fill && cand.d < look.d)) look = cand;
    }
    // Steering still needs somebody to steer at even when nobody has been noticed, and after a
    // shot or a shout that is simply whoever is nearest.
    const prey = look ? look.p : nearestCourier(g, z.x, z.y) || g.players[0];
    z.prey = prey;
    const dx = look ? look.dx : prey.x - z.x;
    const dy = look ? look.dy : prey.y - z.y;
    const d = look ? look.d : Math.hypot(dx, dy) || 1;
    const touching = look ? look.touching : false;
    const fill = look ? look.fill : 0;
    const front = look ? look.front : true;

    // Awareness fills instead of flipping, so the player can read the danger and back off.
    const bumpedUnaware = touching && z.notice < 1 && z.hunt <= 0;
    z.notice = touching ? 1 : clamp(z.notice + (fill > 0 ? fill : -NOTICE_FADE) * dt, 0, 1);
    const sees = z.notice >= 1;
    // A tank is slow to catch on and slow to let go: it notices from closer, but once it
    // has locked on it keeps walking long after a sharper zombie would have given up.
    if (sees && look) { z.hunt = z.dumb ? 9 : 3.2; z.tx = prey.x; z.ty = prey.y; z.notice = 1; }
    if (bumpedUnaware) {
      z.foeCar = null;
      z.moan = rnd(1.6, 2.8);
      makeNoise(g, z.x, z.y, 145, 2.2, false, z);
      SND.play('moan', z.x, z.y, z.seed);
    }
    // The gauge belongs to the courier being watched: each of them reads their own danger.
    if (z.notice > .02) {
      watchersBy[prey.id]++;
      noticeBy[prey.id] = Math.max(noticeBy[prey.id], z.notice);
    }
    if (z.hunt > 0) detectedBy[prey.id] = true;

    // A patrol car that comes close is a target in its own right. With both within reach
    // the horde still prefers the courier: sixty against forty.
    z.foeCd = Math.max(0, z.foeCd - dt);
    z.foeHitCd = Math.max(0, z.foeHitCd - dt);
    z.tankHitCd = Math.max(0, z.tankHitCd - dt);   // One car impact per tank, not one per frame.
    // A grudge outranks everything else until it burns out or the rival dies.
    z.rivalCd = Math.max(0, z.rivalCd - dt);
    if (z.rival && (z.rival.gone || z.rivalCd <= 0)) { z.rival = null; z.rivalCd = 0; }
    if (z.foeCar && (z.foeCar.broken || Math.hypot(z.foeCar.x - z.x, z.foeCar.y - z.y) > COP_DROP)) z.foeCar = null;
    if (z.foeCd <= 0 && !z.dumb) {          // A tank never picks a vehicle as prey: it would follow it.
      let cop = null, cd = COP_AGGRO * COP_AGGRO;
      for (const c of g.cars) {
        if (!c.police || c.broken) continue;
        const cx = c.x - z.x, cy = c.y - z.y, c2 = cx * cx + cy * cy;
        if (c2 < cd) { cd = c2; cop = c; }
      }
      if (cop) {
        z.foeCd = rnd(1.5, 2.8);
        const huntingPlayer = sees || z.hunt > 0;
        z.foeCar = huntingPlayer && Math.random() < .6 ? null : cop;
      }
    }

    let ax, ay, chase = false;
    if (z.rival) {                                    // Settle the score with whoever splattered you.
      const rx = z.rival.x - z.x, ry = z.rival.y - z.y, rd = Math.hypot(rx, ry) || 1;
      ax = rx / rd; ay = ry / rd; chase = true;
    }
    else if (z.foeCar) {                              // Tear the patrol apart instead of chasing the courier.
      const cx = z.foeCar.x - z.x, cy = z.foeCar.y - z.y, cd = Math.hypot(cx, cy) || 1;
      ax = cx / cd; ay = cy / cd; chase = true;
    }
    else if (z.hunt > 0) {
      // Instead of chasing directly, the horde flanks from both sides and leads the courier's movement.
      z.flankTimer -= dt;
      if (z.flankTimer <= 0) {
        z.flankTimer = rnd(1.8, 3.3);
        if (Math.random() < .18) z.flankSide *= -1;
      }
      const lead = z.dumb ? 0 : d > 100 ? Math.min(.58, d / 520) : .12;
      const flank = !z.dumb && d > 82 ? Math.min(112, (d - 70) * .38) * z.flankSide * z.flankBias : 0;
      const gx = prey.x + prey.vx * lead - dy / d * flank;
      const gy = prey.y + prey.vy * lead + dx / d * flank;
      const nx = gx - z.x, ny = gy - z.y, nd = Math.hypot(nx, ny) || 1;
      ax = nx / nd; ay = ny / nd; chase = true;

      // A long retreat charges a short surge. Sprinting can still create distance,
      // but walking backward while shooting is no longer free.
      const retreat = (prey.vx * dx + prey.vy * dy) / d;
      z.pressure = z.dumb ? 0 : clamp(z.pressure + dt * (retreat > 58 && d > 72 && d < 330 ? 1.35 : -2.1), 0, 1);
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
    } else if (!z.dumb && z.lostArms < 2 && !z.headless && !g.done && g.spawnGrace <= 0 &&
               (z.hunt > 0 || (z.alert > 0 && (z.tx - prey.x) ** 2 + (z.ty - prey.y) ** 2 < 4900)) && z.throwCd <= 0 &&
               d > FILTH_MIN_RANGE && d < FILTH_MAX_RANGE && g.zombieShots.length < 5) {
      const lead = Math.min(.55, d / z.shot.speed * .45);
      z.throwAimX = clamp(prey.x + prey.vx * lead + rnd(-16, 16), 8, WORLD - 8);
      z.throwAimY = clamp(prey.y + prey.vy * lead + rnd(-16, 16), 8, WORLD - 8);
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
    z.mvx = ax * sp; z.mvy = ay * sp;                  // The patrol leads its shots with this.
    z.x += ax * sp * dt; z.y += ay * sp * dt;
    z.walk += dt * (chase ? 7 : 3);
    if (z.kx || z.ky) {
      z.x += z.kx * dt; z.y += z.ky * dt; z.kx *= .86; z.ky *= .86;
      if (Math.abs(z.kx) < 5 && Math.abs(z.ky) < 5) z.kx = z.ky = 0;
    }
    z.x = clamp(z.x, z.r, WORLD - z.r); z.y = clamp(z.y, z.r, WORLD - z.r);
    for (const s of solidsNear(g, z.x, z.y, z.r)) hitOBB(z, z.r, s);
    for (const t of treesNear(g, z.x, z.y, z.r)) hitCircle(z, z.r, t);
    for (const o of g.zombies) {                       // Keep bodies from merging into one clump.
      if (o === z) continue;
      const ox = z.x - o.x, oy = z.y - o.y, od2 = ox * ox + oy * oy;
      const touch = z.r + o.r;
      if (od2 > 0 && od2 < touch * touch) {
        const od = Math.sqrt(od2), k = (touch - od) / od * .5;
        z.x += ox * k; z.y += oy * k;
      }
    }
    // Rivals tear at each other on contact until one of them drops.
    if (z.rival && !z.rival.gone && z.foeHitCd <= 0) {
      const rx = z.rival.x - z.x, ry = z.rival.y - z.y, rd = Math.hypot(rx, ry) || 1;
      if (rd < z.r + z.rival.r + 4) {
        z.foeHitCd = rnd(.5, .85);
        z.recoil = .18;
        const o = z.rival;
        damageZombie(g, o, z.kind === 'brute' ? 1.5 : z.kind === 'runner' ? .5 : 1, rx, ry);
        o.hit = .2; o.rivalCd = Math.max(o.rivalCd, 4);
        o.kx += rx / rd * 90; o.ky += ry / rd * 90;
        o.bleed = Math.min(7, (o.bleed || 0) + 2);
        sprayZombieBlood(g, o, o.x, o.y, rx / rd, ry / rd, 11, 1);
        if (o.hp <= 0) killZombie(g, o); else SND.play('hit', o.x, o.y);
      }
    }

    // Moving cars run zombies down, while repeated bodies damage the radiator and suspension.
    for (const c of g.cars) {
      const carContact = circleCarContact(c, z.x, z.y, z.r - 4);
      if (c.broken) { if (carContact) resolveCircleCar(c, z, z.r); continue; }
      if (c.v > 40 && carContact) {
        c.honk = 1;
        if (z.dumb) {
          // A tank is not roadkill. It loses half its health, shrugs off the rest, and the
          // car takes the worse end of it: the collision all but stops the vehicle.
          if (z.tankHitCd > 0) { resolveCircleCar(c, z, z.r); continue; }
          z.tankHitCd = .8;
          damageZombie(g, z, z.maxHp * .5, c.hx, c.hy);
          z.hit = .25;
          z.kx = c.hx * 90; z.ky = c.hy * 90;          // Barely shifted by the impact.
          damageCarWithZombie(g, c, z, carContact);
          c.v *= .18; c.stall = Math.max(c.stall, rnd(.5, 1.1));
          shakeAt(g, z.x, z.y, .8, 520);
          sprayZombieBlood(g, z, carContact.x, carContact.y, c.hx, c.hy, 16, 1.1);
          if (z.hp <= 0) { g.roadKills++; killZombie(g, z); }
          else resolveCircleCar(c, z, z.r);
          break;
        }
        z.kx = c.hx * 260; z.ky = c.hy * 260;
        damageCarWithZombie(g, c, z, carContact);
        g.roadKills++;
        killZombie(g, z); break;
      }
      // A slow or stationary patrol gets torn at by hand until the body gives way.
      if (c === z.foeCar && carContact && z.foeHitCd <= 0) {
        z.foeHitCd = rnd(.55, .95);
        z.recoil = .22;
        damageCarWithZombie(g, c, z, carContact);
        resolveCircleCar(c, z, z.r);
      }
    }
    // A body bump is impossible to hide from, and it is the courier who walked into it who
    // finds that out.
    if (!z.gone) for (const courier of g.players) {
      if (courier.down) continue;
      if (resolveZombieContact(g, z, courier)) {
        detectedBy[courier.id] = true;
        noticeBy[courier.id] = 1;
      }
    }
    if (g.dead) return;
  }
  for (const courier of g.players) {
    courier.stealthDetected = detectedBy[courier.id];
    courier.stealthNotice = detectedBy[courier.id] ? 1 : noticeBy[courier.id];
    courier.stealthWatchers = watchersBy[courier.id];
  }
  for (let i = g.zombies.length - 1; i >= 0; i--) if (g.zombies[i].gone) g.zombies.splice(i, 1);

  // Filth projectiles move slowly, break on the environment, and remain dodgeable.
  for (let i = g.zombieShots.length - 1; i >= 0; i--) {
    const s = g.zombieShots[i];
    s.l -= dt; s.px = s.x; s.py = s.y; s.spin += dt * 8;
    s.x += s.vx * dt; s.y += s.vy * dt;
    let gone = s.l <= 0 || s.x < 0 || s.y < 0 || s.x > WORLD || s.y > WORLD;
    if (!gone) for (const o of solidsNear(g, s.x, s.y, s.r))
      if (inOBB(s.x, s.y, o)) { gone = true; break; }
    if (!gone) for (const t of treesNear(g, s.x, s.y, s.r))
      { const dx = t.x - s.x, dy = t.y - s.y, r = t.r + s.r;
        if (dx * dx + dy * dy < r * r) { gone = true; break; } }
    if (!gone) for (const c of g.cars)
      if (circleCarContact(c, s.x, s.y, s.r)) { gone = true; break; }

    // A throw that lands on another zombie starts a feud between the two of them.
    if (!gone) for (const z of g.zombies) {
      if (z.gone || z === s.owner) continue;
      const zdx = z.x - s.x, zdy = z.y - s.y, zr = z.r + s.r;
      if (zdx * zdx + zdy * zdy > zr * zr) continue;
      hitByFilth(g, z, s);
      gone = true;
      break;
    }

    // A throw is not aimed at anyone in particular once it is in the air: it lands on whoever
    // is standing where it comes down.
    let struck = null;
    if (!gone && !g.done) for (const courier of g.players) {
      if (courier.down) continue;
      const pdx = courier.x - s.x, pdy = courier.y - s.y, pr = PR + s.r;
      if (pdx * pdx + pdy * pdy < pr * pr) { struck = courier; break; }
    }
    if (struck) {
      const speed = Math.hypot(s.vx, s.vy) || 1;
      splatFilth(g, s);
      g.zombieShots.splice(i, 1);
      if (struck.inv <= 0) {
        g.filthHits++;
        hurt(g, struck, s.vx / speed, s.vy / speed, 105);
      }
      if (g.dead) return;
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
    const taker = pickerAt(g, a.x, a.y);
    if (taker) {
      if (a.batt) taker.batt = Math.min(1, taker.batt + .5); else taker.ammo += a.n;
      g.ammoBoxes.splice(i, 1);
      SND.play('pick', a.x, a.y);
      for (let k = 0; k < 10; k++)
        g.parts.push({ x: a.x, y: a.y, vx: rnd(-80, 80), vy: rnd(-130, -20), l: rnd(.3, .6),
                       c: a.batt ? '#8ee6a0' : '#cfe0f2', s: rnd(2, 4) });
    }
  }

  // Cash. A note slides a short way out of the body, settles against whatever it meets,
  // and then simply lies there until the courier walks over it.
  for (let i = g.cash.length - 1; i >= 0; i--) {
    const m = g.cash[i];
    m.ph += dt * 2.4;
    if (m.vx || m.vy) {
      m.x += m.vx * dt; m.y += m.vy * dt;
      const damp = Math.pow(.0022, dt);          // Paper carries no momentum worth speaking of.
      m.vx *= damp; m.vy *= damp;
      settleCircleBody(g, m, 6);                 // Never comes to rest inside a wall or a hedge.
      if (Math.abs(m.vx) < 4 && Math.abs(m.vy) < 4) { m.vx = 0; m.vy = 0; }
    }
    if (pickerAt(g, m.x, m.y)) {                 // The wallet is shared; the walking is not.
      runtime.cash += m.n; g.earned += m.n;
      g.cash.splice(i, 1);
      SND.play('cash', m.x, m.y);
      for (let k = 0; k < 9; k++)
        g.parts.push({ x: m.x, y: m.y, vx: rnd(-70, 70), vy: rnd(-125, -20), l: rnd(.25, .55),
                       c: pick(['#a9e6b0', '#d8e8c8', '#6fae74']), s: rnd(2, 4) });
    }
  }

  ageRings(g, dt);

  // A parked car cannot drive without a driver, but its alarm flashes and honks.
  for (const c of g.parked) {
    c.hitFlash = Math.max(0, (c.hitFlash || 0) - dt);
    c.hazard = Math.max(0, (c.hazard || 0) - dt);
    c.alarm = Math.max(0, (c.alarm || 0) - dt);
    c.honk = c.alarm > 0 && ((c.alarm * 3) | 0) % 2 === 0 ? .8 : 0;
    emitCarSmoke(g, c, dt);
  }

  // Tanks are wide enough and slow enough to be worth steering around, so traffic treats
  // them as moving obstacles. The rest of the horde is still simply run over.
  const tanks = [];
  for (const z of g.zombies) if (!z.gone && z.dumb) tanks.push(z);

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
    let near = false, far = false, blocker = null;
    for (let li = 1; li <= nb && !near; li++) {
      const dist = look * li / nb, isNear = dist <= close;
      const box = ahead(c, dist);
      let hit = false;
      for (const o of g.cars) {
        if (o === c) continue;
        // Brake for anyone nearby; the higher id yields when approaching an intersection.
        const same = o.edge === c.edge && o.dir === c.dir;
        if (!isNear && !(same || o.id < c.id || o.stall > 0)) continue;
        if (obbHit(box, o.box)) { hit = true; if (!blocker) blocker = o; break; }
      }
      if (!hit && isNear) for (const q of parkedNear(g, box.cx, box.cy, box.rad))
        if (obbHit(box, q)) { hit = true; if (!blocker) blocker = q; break; }
      let tankAhead = false;
      if (!hit) for (const z of tanks)
        if (distOBB(z.x, z.y, box) < z.r) { hit = tankAhead = true; if (!blocker) blocker = z; break; }
      // A tank always counts as an immediate obstacle. A chasing patrol ignores the distant
      // scan, and that is exactly how a police car used to drive straight into one.
      if (hit) { if (isNear || tankAhead) near = true; else far = true; }
    }
    // Forced movement ignores waiting and distant scans, but still brakes for immediate obstacles.
    const reacting = c.driverTimer > 0 && (c.driverMode === 'chase' || c.driverMode === 'flee');
    let brake = near || (!reacting && (far || c.hold));
    if (reacting) c.hold = false;
    if (c.stall > 0) c.stall -= dt;
    c.rev = Math.max(0, c.rev - dt);
    c.revCd = Math.max(0, c.revCd - dt);

    // Escalation resets only after the car has actually been driving for a while. Counting
    // idle time here would reset the counter mid-jam and loop the first step forever.
    c.freeT = Math.abs(c.v) > 40 ? c.freeT + dt : 0;
    if (c.freeT > 2) c.jamTries = 0;

    // Yielding ends when the corridor is actually free, not when a timer runs out.
    if (c.yieldTo) {
      c.yieldT = Math.max(0, c.yieldT - dt);
      if (blocker !== c.yieldTo || c.yieldT <= 0) { c.yieldTo = null; c.yieldT = 0; }
      else brake = true;
    }

    // While the car in front is actively backing out it is making room for us: we are not
    // deadlocked, so the counters must not tick and drag us into a manoeuvre of our own.
    const clearingForUs = !!(blocker && blocker.rev > 0);
    c.stuck = !clearingForUs && brake && Math.abs(c.v) < 14 ? c.stuck + dt : 0;
    c.dead = !clearingForUs && Math.abs(c.v) < 8 ? c.dead + dt : 0;

    // Hopeless and out of sight: back into traffic elsewhere. Otherwise keep escalating.
    if (!(c.dead > 8 && respawnCar(g, c)) &&
        c.rev <= 0 && !c.yieldTo && c.revCd <= 0 && (c.stuck > 2.2 || c.dead > 3.2)) {
      resolveJam(g, c, blocker);
      c.stall = c.stuck = c.dead = 0;
    }
    const reversing = c.rev > 0 && c.stall <= 0;
    if (reversing) brake = false;                     // Obstacles ahead no longer matter going backward.
    if (c.stall > 0) brake = true;                    // Traffic logic cannot push a stalled engine forward.

    // A badly damaged engine loses power and stalls; damaged suspension slows steering.
    const engine = c.damage ? c.damage.engine : 100;
    const wheelDamage = c.damage ? c.damage.wheel : 0;
    if (engine < 38 && c.stall <= 0 && Math.random() < dt * .085) { c.stall = rnd(.28, .72); brake = true; }

    if (c.police) {
      c.beacon += dt * 7;                                      // Rotate the beacon.
      c.siren = (c.siren || 0) - dt;                           // Zombies follow the audible siren.
      if (c.siren <= 0) { c.siren = 1.1; makeNoise(g, c.x, c.y, 250, 3.2); SND.play('siren', c.x, c.y); }
      updatePoliceFire(g, c, dt);
    }
    const turning = c.mode === 'turn', wet = g.weather.wet;
    const condition = (.42 + .58 * engine / 100) * (1 - .28 * wheelDamage);
    const driverBoost = c.driverMode === 'chase' ? 1.32 : c.driverMode === 'flee' ? 1.2 : 1;
    const wish = reversing ? (rearBlocked(g, c) ? 0 : -REV_SPEED) :
      brake ? 0 :
      c.baseMax * condition * driverBoost * (turning ? .58 - .1 * wet : 1);  // Slow down for turns, especially when wet.
    c.v += (wish - c.v) * Math.min(1, (reversing ? 3.2 : brake ? 6 - 2.4 * wet : turning ? 3.4 : 2.2) * dt);
    if (turning) {
      const T = c.turn;
      T.t += c.v * dt / T.len;
      if (T.t <= 0 && c.v < 0) {                               // Backed out of the intersection: release it for others.
        T.t = 0; c.mode = 'edge'; c.turn = null; c.node = -1;
        const l = lanePoint(c.edge, c.s, c.dir);
        steerCar(c, l.x, l.y, l.hx, l.hy, dt, 4.5 * (1 - .42 * wheelDamage));
      }
      else if (T.t >= 1) {                                     // Entered a new road.
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
      c.hold = !reversing && !reacting && left <= TURN_IN + 46 + c.v * .55 &&
               g.cars.some(o => o !== c && o.mode === 'turn' && o.node === at);
      if (c.hold) {
        const stop = c.dir > 0 ? c.edge.len - TURN_IN - 10 : TURN_IN + 10;
        c.s = c.dir > 0 ? Math.min(c.s, stop) : Math.max(c.s, stop);
        left = c.dir > 0 ? c.edge.len - c.s : c.s;
      }
      const l = lanePoint(c.edge, c.s, c.dir);
      steerCar(c, l.x, l.y, l.hx, l.hy, dt, 4.5 * (1 - .42 * wheelDamage));
      if (!reversing && left <= TURN_IN && !c.hold) startTurn(g, c);
    }

    // Honk when a courier is near the path — whichever of them the driver can see coming.
    const honkAt = nearestCourier(g, c.x, c.y) || g.p;
    const dx = honkAt.x - c.x, dy = honkAt.y - c.y;
    const rel = dx * c.hx + dy * c.hy, side = Math.abs(dy * c.hx - dx * c.hy);
    const angryHonk = c.driverMode === 'chase' && Math.hypot(dx, dy) < 260;
    c.honk = angryHonk || (rel > 0 && rel < 130 && side < 26) ? Math.min(1, c.honk + dt * 4) : Math.max(0, c.honk - dt * 3);
    if (c.honk > .5 && !c.honked) { c.honked = true; SND.play('honk', c.x, c.y); }
    else if (c.honk < .1) c.honked = false;

    // Courier impact. A bumper does not check who it is about to hit.
    for (const courier of g.players) {
      const playerCarContact = !g.done ? circleCarContact(c, courier.x, courier.y, PR) : null;
      if (!playerCarContact) continue;
      const carVx = c.hx * c.v, carVy = c.hy * c.v;
      const closing = Math.max(0, (carVx - courier.vx) * playerCarContact.nx + (carVy - courier.vy) * playerCarContact.ny);
      const cdx = courier.x - c.x, cdy = courier.y - c.y;
      const sgn = (cdy * c.hx - cdx * c.hy) > 0 ? 1 : -1;    // Choose which side to throw the courier toward.
      if (closing > 24 && c.playerBodyCd <= 0) {
        damageCarWithPlayer(g, c, courier, playerCarContact, closing);
        c.playerBodyCd = .55;
      }
      if (c.v > 35 && courier.inv <= 0) {
        hurt(g, courier, c.hx - c.hy * .7 * sgn, c.hy + c.hx * .7 * sgn, 230);
        if (g.dead) return;
      }
      // Every car is a physical body rather than a pass-through sprite. After the
      // impulse is calculated, separate the courier circle from the deformed outline.
      resolveCircleCar(c, courier, PR);
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

  ageCarSmoke(g, dt);

  // Parcels. The courier carries two at a time, and a parcel's address is worth nothing
  // until it is on their back: picking one up is what puts its door on the map.
  for (const courier of g.players) courier.handsFull = null;
  for (const b of g.parcels) {
    if (b.state !== 'ground') continue;
    b.ph += dt * 3;
    const taker = pickerAt(g, b.x, b.y);
    if (!taker) continue;
    if (taker.carried >= CARRY_MAX) { taker.handsFull = b; continue; }   // It stays where it is until a hand is free.
    b.state = 'carried'; b.carrier = taker.id; taker.carried++;
    SND.play('pick', b.x, b.y);
    for (let k = 0; k < 14; k++)
      g.parts.push({ x: b.x, y: b.y, vx: rnd(-90, 90), vy: rnd(-140, -20), l: rnd(.4, .8), c: '#ffd766', s: rnd(2, 4) });
  }

  // Delivery. Each parcel is signed off at its own door, by the courier whose back it is on —
  // a partner standing at the right door with the wrong parcel signs nothing.
  if (!g.done) for (const b of g.parcels) {
    if (b.state !== 'carried') continue;
    const carrier = g.players[b.carrier] || g.p;
    if (carrier.down || Math.hypot(b.dest.x - carrier.x, b.dest.y - carrier.y) >= 26) continue;
    b.state = 'done'; carrier.carried--; g.delivered++;
    SND.play('deliver', b.dest.x, b.dest.y);
    emit(g, EV.deliver, b.dest.x, b.dest.y);
    for (let k = 0; k < 18; k++)
      g.parts.push({ x: b.dest.x, y: b.dest.y, vx: rnd(-120, 120), vy: rnd(-180, -30), l: rnd(.4, .9),
                     c: pick(['#8fe388', '#ffd766']), s: rnd(2, 4) });
    if (g.delivered >= g.need) finishDistrict(g, carrier);
  }

  ageBlasts(g, dt);

  // Severed limbs tumble and bleed. Heads remain physical for the entire district.
  for (let i = g.zombieParts.length - 1; i >= 0; i--) {
    const part = g.zombieParts[i];
    part.l -= dt; part.kickCd = Math.max(0, part.kickCd - dt);
    part.hitFlash = Math.max(0, (part.hitFlash || 0) - dt);
    part.x += part.vx * dt; part.y += part.vy * dt;
    if (part.h > 0 || part.vh > 0) {
      part.h += part.vh * dt;
      part.vh -= 255 * dt;
      if (part.h <= 0 && part.vh < 0) {
        part.h = 0;
        if (Math.abs(part.vh) > 38) part.vh *= -.32;
        else { part.vh = 0; part.spin = 0; }
      }
    }

    if (part.kind === 'head') {
      const radius = 8 * (part.size || 1);
      if (part.x < radius) { wakeHeadBlood(part, Math.abs(part.vx)); part.x = radius; part.vx = Math.abs(part.vx) * .55; }
      if (part.x > WORLD - radius) { wakeHeadBlood(part, Math.abs(part.vx)); part.x = WORLD - radius; part.vx = -Math.abs(part.vx) * .55; }
      if (part.y < radius) { wakeHeadBlood(part, Math.abs(part.vy)); part.y = radius; part.vy = Math.abs(part.vy) * .55; }
      if (part.y > WORLD - radius) { wakeHeadBlood(part, Math.abs(part.vy)); part.y = WORLD - radius; part.vy = -Math.abs(part.vy) * .55; }

      for (const solid of g.solids) {
        const beforeX = part.x, beforeY = part.y;
        if (hitOBB(part, radius, solid)) bounceHeadFromCorrection(part, beforeX, beforeY);
      }
      for (const tree of g.trees) {
        const beforeX = part.x, beforeY = part.y;
        if (hitCircle(part, radius, tree)) bounceHeadFromCorrection(part, beforeX, beforeY, .4);
      }

      if (part.h < 11) for (const car of g.cars) {
        const contact = circleCarContact(car, part.x, part.y, radius);
        if (!contact) continue;
        resolveCircleCar(car, part, radius);
        const carVx = car.hx * car.v, carVy = car.hy * car.v;
        const impact = Math.max(0, carVx * contact.nx + carVy * contact.ny);
        if (impact > 7 && part.kickCd <= 0) {
          kickZombieHead(g, part, contact.nx, contact.ny, Math.max(65, impact * .82), carVx * .52, carVy * .52);
        }
      }

      if (part.h < 9) {
        for (const courier of g.players) {
          const pdx = part.x - courier.x, pdy = part.y - courier.y, pd = Math.hypot(pdx, pdy) || 1;
          const touch = radius + PR;
          if (pd >= touch) continue;
          const nx = pdx / pd, ny = pdy / pd;
          part.x = courier.x + nx * (touch + .5); part.y = courier.y + ny * (touch + .5);
          const approach = (courier.vx - part.vx) * nx + (courier.vy - part.vy) * ny;
          if (approach > 12 && part.kickCd <= 0) {
            kickZombieHead(g, part, nx, ny, 58 + approach * .9, courier.vx * .32, courier.vy * .32);
          }
        }

        for (const z of g.zombies) {
          if (z.gone) continue;
          const dx = part.x - z.x, dy = part.y - z.y, d = Math.hypot(dx, dy) || 1;
          const touchZombie = radius + z.r;
          if (d >= touchZombie) continue;
          const nx = dx / d, ny = dy / d;
          part.x = z.x + nx * (touchZombie + .35); part.y = z.y + ny * (touchZombie + .35);
          const approach = ((z.mvx || 0) - part.vx) * nx + ((z.mvy || 0) - part.vy) * ny;
          if (approach > 18 && part.kickCd <= 0) kickZombieHead(g, part, nx, ny, 38 + approach * .55);
        }

        for (let j = 0; j < i; j++) {
          const other = g.zombieParts[j];
          if (other.kind !== 'head' || other.h >= 9) continue;
          const dx = part.x - other.x, dy = part.y - other.y, d = Math.hypot(dx, dy) || 1;
          const otherRadius = 8 * (other.size || 1), touchHead = radius + otherRadius;
          if (d >= touchHead) continue;
          const nx = dx / d, ny = dy / d, overlap = touchHead - d + .2;
          part.x += nx * overlap * .5; part.y += ny * overlap * .5;
          other.x -= nx * overlap * .5; other.y -= ny * overlap * .5;
          const closing = (part.vx - other.vx) * nx + (part.vy - other.vy) * ny;
          if (closing < 0) {
            const impulse = -closing * .72;
            part.vx += nx * impulse; part.vy += ny * impulse;
            other.vx -= nx * impulse; other.vy -= ny * impulse;
            wakeHeadBlood(part, -closing); wakeHeadBlood(other, -closing);
          }
        }
      }
    } else {
      part.x = clamp(part.x, 2, WORLD - 2); part.y = clamp(part.y, 2, WORLD - 2);
    }

    const drag = Math.pow(part.h > 0 ? .986 : .9, dt * 60);
    part.vx *= drag; part.vy *= drag; part.ang += part.spin * dt;
    part.bleed = Math.max(0, part.bleed - dt);
    part.bleedCd -= dt;
    if (part.bleed > 0 && part.bleedCd <= 0) {
      part.bleedCd = part.h > .5 ? rnd(.1, .18) : rnd(.15, .25);
      if (part.h > .5) {
        addBloodDrop(g, part, part.x, part.y, part.vx * .18 + rnd(-14, 14),
          part.vy * .18 + rnd(-14, 14), rnd(12, 34), rnd(1.1, 2.3), part.h + 2);
      } else {
        addGroundBlood(g, part.x + rnd(-2, 2), part.y + rnd(-2, 2), part.stain,
          rnd(1.2, 2.5), part.vx, part.vy);
      }
    }
    if (part.kind !== 'head' && part.l <= 0) g.zombieParts.splice(i, 1);
  }

  ageDebris(g, dt);

  drawHud(g);
}

// ---------- what a peer works out for itself ----------
//
// Everything below is what the game looks, sounds and feels like rather than what it is. A peer
// that is not running the simulation still owns all of it: its own ears, its own weather on the
// glass, its own smoke and sparks, its own screen shaking. Each piece is called from exactly the
// line it used to occupy inside update, because three of them are position-sensitive — rings age
// before a siren pushes a new one, smoke ages between the traffic and the parcels, and the fog
// opens before contacts move anybody — and a frame that ran them in a tidier order would draw a
// different picture.

function listenFor(g, p) { SND.listen(p.x, p.y); }

// Replay the frame's notes as sound, debris and shake. Only a peer that did not run the rules
// calls this — the peer that did already made all of it on the way past.
function playEvents(g) {
  for (const e of g.events) {
    const x = e[1], y = e[2];
    switch (e[0]) {
      case EV.shot: {
        const a = e[3];
        shakeAt(g, x, y, .3);
        SND.play('shot', x, y);
        for (let k = 0; k < 5; k++)
          g.parts.push({ x: x + Math.cos(a) * 11, y: y + Math.sin(a) * 11,
                         vx: Math.cos(a) * rnd(40, 150) + rnd(-60, 60),
                         vy: Math.sin(a) * rnd(40, 150) + rnd(-60, 60),
                         l: rnd(.1, .25), c: '#ffe08a', s: rnd(2, 3) });
        break;
      }
      case EV.hurt: {
        const amount = e[4];
        shakeAt(g, e[2], e[3], 1);
        SND.play('hurt', e[2], e[3]);
        for (let k = 0; k < 16 + (amount - 1) * 8; k++)
          g.parts.push({ x: e[2], y: e[3], vx: rnd(-160, 160), vy: rnd(-160, 160),
                         l: rnd(.3, .7), c: '#ff6b5a', s: rnd(2, 5) });
        break;
      }
      case EV.lamp:
        SND.play('glass', x, y);
        for (let k = 0; k < 14; k++)
          g.parts.push({ x, y, vx: rnd(-95, 95), vy: rnd(-125, 45), l: rnd(.3, .85),
                         c: pick(['#fff3c8', '#cfe4ff', '#9aa6b2']), s: rnd(2, 4) });
        break;
      case EV.blast:
        shakeAt(g, x, y, .8 + e[3] * 2.7, 900);
        SND.play('headBlast', x, y);
        break;
      case EV.ring:
        g.rings.push({ x, y, r: 10, max: e[3], l: .55 });
        break;
      case EV.down: SND.play('hurt', e[2], e[3]); break;
      case EV.revive: SND.play('pick', e[2], e[3]); break;
      case EV.deliver: SND.play('deliver', x, y); break;
    }
  }
  g.events.length = 0;
}

function ageRings(g, dt) {
  // Noise rings show how far a courier has revealed their position.
  for (let i = g.rings.length - 1; i >= 0; i--) {
    const r = g.rings[i];
    r.l -= dt; r.r += (r.max - r.r) * Math.min(1, dt * 5);
    if (r.l <= 0) g.rings.splice(i, 1);
  }
}

function ageCarSmoke(g, dt) {
  for (let i = g.carSmoke.length - 1; i >= 0; i--) {
    const s = g.carSmoke[i];
    s.l -= dt;
    s.x += s.vx * dt; s.y += s.vy * dt;
    s.vx *= Math.pow(.985, dt * 60); s.vy -= 5 * dt;
    s.r += dt * (s.growth || 7);
    if (s.l <= 0) g.carSmoke.splice(i, 1);
  }
}

function ageBlasts(g, dt) {
  for (let i = g.blasts.length - 1; i >= 0; i--) {
    const blast = g.blasts[i];
    blast.l -= dt;
    const progress = 1 - clamp(blast.l / blast.max, 0, 1);
    blast.r = blast.maxR * (1 - Math.pow(1 - progress, 2.4));
    if (blast.l <= 0) g.blasts.splice(i, 1);
  }
}

function ageDebris(g, dt) {
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
}

// One frame for a peer that is only watching. It never touches a rule: no courier moves, no
// zombie decides anything, no bullet is fired. It reads the state that arrived, plays what
// happened since the last one, and makes the district feel like a place.
function presentFrame(g, dt) {
  listenFor(g, g.p);                    // One pair of ears, and they belong to whoever is here.
  updateWeatherVisuals(g, dt);
  updateFog(g, dt);
  for (const c of g.cars) emitCarSmoke(g, c, dt);
  for (const c of g.parked) emitCarSmoke(g, c, dt);
  ageRings(g, dt);
  ageCarSmoke(g, dt);
  ageBlasts(g, dt);
  ageDebris(g, dt);
  playEvents(g);
  drawHud(g);
}

function drawHud(g) {
  const p = g.p;
  UI.level.textContent = g.level;
  UI.parcels.textContent = p.carried ? `${g.delivered}/${g.need} +${p.carried}` : `${g.delivered}/${g.need}`;
  UI.ammo.textContent = p.ammo;
  UI.hp.textContent = '♥'.repeat(Math.max(0, p.hp)) + '·'.repeat(clamp(p.hpMax - p.hp, 0, p.hpMax));
  UI.lives.textContent = '●'.repeat(Math.max(0, runtime.lives)) + '·'.repeat(clamp(LIVES_MAX - runtime.lives, 0, LIVES_MAX));
  UI.cash.textContent = `$${runtime.cash}`;
  UI.time.textContent = g.time.toFixed(1);
  if (typeof location !== 'undefined' && location.search.includes('qa=zombie-blood')) {
    cv.dataset.bloodDrops = String((g.bloodDrops || []).length);
    cv.dataset.bloodStains = String(g.stains.filter(s => s.blood).length);
    cv.dataset.zombieHp = String(g.zombies[0] ? g.zombies[0].hp : -1);
    cv.dataset.zombieHit = String(g.zombies[0] ? g.zombies[0].hit : 0);
    cv.dataset.bullets = String(g.bullets.length);
  }
  if (typeof location !== 'undefined' && location.search.includes('qa=zombie-dismember')) {
    const z = g.zombies[0];
    const head = g.zombieParts.find(part => part.kind === 'head');
    cv.dataset.zombieHp = String(z ? z.hp : 0);
    cv.dataset.lostArms = String(z ? z.lostArms : 2);
    cv.dataset.headless = String(z ? z.headless : true);
    cv.dataset.detachedParts = String(g.zombieParts.length);
    cv.dataset.heads = String(g.zombieParts.filter(part => part.kind === 'head').length);
    cv.dataset.headSpeed = String(head ? Math.hypot(head.vx, head.vy).toFixed(2) : 0);
    cv.dataset.headBleed = String(head ? head.bleed.toFixed(2) : 0);
    cv.dataset.headKicks = String(g.headKicks);
  }
  if (typeof location !== 'undefined' && location.search.includes('qa=zombie-head-explosion')) {
    const head = g.zombieParts.find(part => part.kind === 'head' && part.explosive);
    const victim = g.zombies.find(z => !z.gone);
    cv.dataset.headHits = String(g.explosiveHeadHits || 0);
    cv.dataset.headHeat = String(head ? head.heat.toFixed(2) : 0);
    cv.dataset.headExplosions = String(g.headExplosions || 0);
    cv.dataset.activeBlasts = String(g.blasts.length);
    cv.dataset.victimHp = String(victim ? victim.hp.toFixed(2) : 0);
    cv.dataset.playerHp = String(g.p.hp);
    cv.dataset.carIntegrity = String(g.cars[0] && g.cars[0].damage ? g.cars[0].damage.integrity.toFixed(2) : 0);
  }
  if (typeof location !== 'undefined' && location.search.includes('qa=stealth')) {
    cv.dataset.sneaking = String(!!g.p.sneaking);
    cv.dataset.stealthNotice = String((g.p.stealthNotice || 0).toFixed(2));
    cv.dataset.stealthWatchers = String(g.p.stealthWatchers || 0);
    cv.dataset.stealthDetected = String(!!g.p.stealthDetected);
    cv.dataset.playerSpeed = String(Math.hypot(g.p.vx, g.p.vy).toFixed(2));
    cv.dataset.stealthCrawlTime = String((g.p.stealthCrawlTime || 0).toFixed(2));
    cv.dataset.watcherDistance = String(g.zombies[0] ? Math.hypot(g.zombies[0].x - g.p.x, g.zombies[0].y - g.p.y).toFixed(2) : 0);
  }
  if (typeof location !== 'undefined' && location.search.includes('qa=population')) {
    cv.dataset.zombies = String(g.zombies.length);
    cv.dataset.ammoBoxes = String(g.ammoBoxes.filter(a => !a.batt).length);
    cv.dataset.batteryBoxes = String(g.ammoBoxes.filter(a => a.batt).length);
    cv.dataset.cashDrops = String(g.cash.length);
    cv.dataset.cashEarned = String(g.earned);
  }
}

function gameOver(g) {
  runtime.state = 'over';
  SND.play('over'); SND.rain(0);
  drawHud(g);
  showResult(
    'SHIFT OVER',
    `district ${g.level}, parcels ${g.delivered} of ${g.need}, zombies eliminated ${g.killed}`,
    `Filth thrown: <b>${g.filthThrown}</b>; hits taken: <b>${g.filthHits}</b>.<br>` +
    `Dodges / pursuing surges: <b>${g.dodges}</b> / <b>${g.surges}</b>.<br>` +
    `Cash picked up over the shift: <b>$${runtime.cash}</b>.<br>` +
    `Road kills: <b>${g.roadKills}</b>; vehicles disabled: <b>${g.carsBroken}</b>.<br>` +
    'Wrecked vehicles block the road; use them as cover from the horde.<br>' +
    'Do not fire blindly: ammunition is limited, and noise draws the whole district.',
    'TRY AGAIN');
}

return Object.freeze({ update, presentFrame });
})();

