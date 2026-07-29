// Two browsers working one district.
//
// The peer that opened the room runs the rules; the peer that walked into it watches. That
// asymmetry is the whole design, and it is here rather than anywhere else in the game: nothing
// in the simulation knows this file exists, and playing alone never touches it.
//
// The district itself is never sent. It is a 2450-pixel canvas, a closure and a fog grid, and
// even the parts that would serialize are far too large to be worth it. Instead both peers grow
// the same town from the same seed and then agree on a fingerprint of the result, so a
// disagreement is caught in the lobby with a plain sentence instead of ten seconds later as
// inexplicable drift.
window.TownGame.net = (() => {
'use strict';

const { runtime } = window.TownGame.core;

const PROTOCOL = 1;

let socket = null;
let role = 'solo';                    // solo until a room is joined, then host or guest.
let phase = 'idle';                   // idle, connecting, lobby, syncing, playing, lost.
let room = '';
let partnerPresent = false;
let pendingStart = null;              // A start message a guest has received but not yet built.
let onStatus = null, onStart = null;

// Whoever is not a guest owns the rules, which alone in a district is always this peer.
const authoritative = () => role !== 'guest';
const state = () => ({ role, phase, room, partner: partnerPresent });

function announce(text) {
  if (onStatus) onStatus(text, state());
}

// Co-op needs the page to have come from the relay, because that is also what it talks to.
// Opening index.html straight off the disk is still a complete game; it just cannot be two.
const available = () => location.protocol === 'http:' || location.protocol === 'https:';

const relayUrl = () =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/`;

function send(message) {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(message));
}

function disconnect(reason) {
  if (socket) { try { socket.close(); } catch { /* already gone */ } }
  socket = null;
  role = 'solo'; phase = 'idle'; room = ''; partnerPresent = false; pendingStart = null;
  if (reason) announce(reason);
}

function connect(want, code) {
  if (!available()) {
    announce('Co-op needs the page served by the relay. Run "node tools/relay.js" and open the address it prints.');
    return false;
  }
  const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (!clean) { announce('Pick a room code first — any few letters, the same on both machines.'); return false; }
  // A district built under a qa flag is not the district the other peer would build, and the
  // seed cannot express that. Better to refuse than to desync on purpose.
  if (new URLSearchParams(location.search).get('qa')) {
    announce('Co-op is not available with a qa flag set: the district would not match.');
    return false;
  }
  disconnect(null);
  room = clean; phase = 'connecting';
  announce(want === 'host' ? `Opening room ${clean}…` : `Looking for room ${clean}…`);
  try { socket = new WebSocket(relayUrl()); }
  catch { announce('Could not reach the relay.'); phase = 'idle'; return false; }

  socket.addEventListener('open', () => send({ t: 'join', room: clean, want }));
  socket.addEventListener('message', e => receive(e.data));
  socket.addEventListener('close', () => {
    if (phase === 'idle') return;
    phase = 'lost'; partnerPresent = false;
    announce('Connection lost.');
  });
  socket.addEventListener('error', () => announce('The relay refused the connection.'));
  return true;
}

function receive(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  switch (msg.t) {
    case 'joined':
      role = msg.role; phase = 'lobby';
      announce(role === 'host'
        ? `Room ${room} is open. Waiting for a partner.`
        : `Joined room ${room}. Waiting for the host to start.`);
      break;
    case 'peer':
      partnerPresent = msg.event === 'join';
      announce(partnerPresent
        ? (role === 'host' ? 'Partner connected. Press start when ready.' : 'Connected to the host.')
        : 'Partner disconnected.');
      break;
    case 'full': disconnect(`Room ${room} already has two couriers.`); break;
    case 'error':
      disconnect(msg.reason === 'taken' ? `Room ${room} is already open — press JOIN instead.`
        : msg.reason === 'empty' ? `Nobody is hosting room ${room} yet.`
        : 'The relay could not place you in that room.');
      break;

    // ---------- the game's own messages ----------
    case 'start':
      if (msg.proto !== PROTOCOL) { disconnect('The other machine is running a different version of the game.'); break; }
      pendingStart = msg; phase = 'syncing';
      announce('Building the district…');
      if (onStart) onStart(msg);
      break;
    case 'ready':
      if (msg.proto !== PROTOCOL) { disconnect('The other machine is running a different version of the game.'); break; }
      if (msg.sum !== hostChecksum) {
        send({ t: 'abort', reason: 'layout' });
        disconnect('The two machines built different districts. Use the same browser on both.');
        break;
      }
      phase = 'playing';
      announce('Partner is in the district.');
      break;
    case 'abort':
      disconnect(msg.reason === 'layout'
        ? 'The two machines built different districts. Use the same browser on both.'
        : 'The host ended the session.');
      break;
    case 'bye': disconnect('Partner left.'); break;

    case 's': receiveSnapshot(msg); break;
    case 'i': if (role === 'host' && runtime.game) applyRemoteInput(runtime.game, msg); break;
  }
}

// ---------- district handshake ----------
let hostChecksum = '';

// The host picks the seed, so there is exactly one answer to what this district looks like.
function hostDistrict(level) {
  const seed = (Math.random() * 4294967296) >>> 0;
  return { level, seed };
}

// Called by the host once its own district exists, and by the guest once it has copied it.
function declareLayout(g, sum) {
  if (role === 'host') {
    hostChecksum = sum;
    send({ t: 'start', proto: PROTOCOL, level: g.level, seed: g.seed, sum });
    phase = 'playing';
  } else if (role === 'guest') {
    send({ t: 'ready', proto: PROTOCOL, sum });
    phase = 'playing';
    announce('In the district.');
  }
}

// ---------- the wire ----------
//
// Only what changes travels. The town, the horde's colours, which house a parcel is addressed
// to, the shape of every car — all of that was settled by the seed and is already standing on
// both machines, so a snapshot names things by id and carries nothing but their state.
//
// Cosmetic debris is not sent at all. Sparks, stains, blood, smoke and noise rings are made
// locally from the events beside the snapshot, so the two screens differ in where a particular
// spark landed and agree about everything a rule can read.
const SNAPSHOT_HZ = 20;
const DELAY = .1;                     // Render this far behind the host, to have something to interpolate toward.
const KEEP = 16;                      // Snapshots kept for interpolation.

const q1 = v => Math.round(v * 10) / 10;
const q2 = v => Math.round(v * 100) / 100;
const flag = (on, n) => (on ? 1 << n : 0);
const has = (bits, n) => (bits & (1 << n)) !== 0;

const TWO_PI = Math.PI * 2;
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= TWO_PI;
  while (d < -Math.PI) d += TWO_PI;
  return a + d * t;
}

function encodeSnapshot(g, ack) {
  const live = [];
  for (const z of g.zombies) {
    if (z.gone) continue;
    live.push([z.id, q1(z.x), q1(z.y), q2(z.ang), z.hp, q2(z.notice), q2(z.hunt), q1(z.walk),
      flag(z.headless, 0) | flag(z.silent, 1) | ((z.lostArms || 0) << 2)]);
  }
  return {
    t: 's', ack,
    gs: [q2(g.time), g.delivered, g.killed, g.earned, q2(g.spawnGrace),
      flag(g.done, 0) | flag(g.dead, 1)],
    pl: g.players.map(p => [q1(p.x), q1(p.y), q1(p.vx), q1(p.vy), q2(p.ang), q2(p.aim),
      p.hp, p.ammo, q2(p.batt), q2(p.stam), p.carried, q2(p.inv), q2(p.stagger), q1(p.walk),
      q2(p.reviveT),
      flag(p.torch, 0) | flag(p.sneaking, 1) | flag(p.running, 2) | flag(p.moving, 3) | flag(p.down, 4)]),
    z: live,
    c: g.cars.map(c => [c.id, q1(c.x), q1(c.y), q2(c.hx), q2(c.hy), q1(c.v), q2(c.damage.integrity),
      q2(c.beacon || 0), q2(c.honk || 0), q2(c.hazard || 0),
      flag(c.broken, 0) | flag(c.police, 1)]),
    b: g.bullets.map(b => [q1(b.x), q1(b.y), q1(b.vx), q1(b.vy), q2(b.l), b.own ? 1 : 0]),
    f: g.zombieShots.map(s => [q1(s.x), q1(s.y), q1(s.vx), q1(s.vy), q2(s.l), q2(s.r), s.kind, q2(s.spin)]),
    pt: g.zombieParts.map(part => [part.id, part.zid, part.kind, part.side || 0,
      q1(part.x), q1(part.y), q1(part.h), q2(part.ang), q2(part.size || 1), q2(part.heat || 0),
      flag(part.explosive, 0)]),
    cs: g.cash.map(m => [q1(m.x), q1(m.y), m.n]),
    ab: g.ammoBoxes.map(a => [q1(a.x), q1(a.y), a.batt ? 1 : 0, a.n]),
    pc: g.parcels.map(b => [b.state === 'ground' ? 0 : b.state === 'carried' ? 1 : 2, b.carrier]),
    lb: g.lamps.reduce((out, l, i) => { if (l.broken) out.push(i); return out; }, []),
    w: [q2(g.weather.rain), q2(g.weather.wet), q2(g.weather.wind), q2(g.weather.flash)],
    rn: [runtime.lives, runtime.cash],
    e: g.events.length ? g.events : undefined
  };
}

// A snapshot arriving is not a snapshot being shown. They go into a short queue and are read out
// a tenth of a second behind, which is what makes a partner walk rather than teleport twenty
// times a second.
const queue = [];
let renderTime = null;
let lastAck = 0;

function receiveSnapshot(s) {
  queue.push(s);
  while (queue.length > KEEP) queue.shift();
  lastAck = s.ack || 0;
}

// Put a district into the state one snapshot describes. This stands on its own — a peer with a
// single snapshot and nothing to interpolate toward still ends up somewhere sensible — and
// interpolate then eases the handful of values that are worth easing.
function applySnapshot(g, s) {
  const gs = s.gs;
  g.time = gs[0]; g.delivered = gs[1]; g.killed = gs[2]; g.earned = gs[3]; g.spawnGrace = gs[4];
  g.done = has(gs[5], 0); g.dead = has(gs[5], 1);
  runtime.lives = s.rn[0]; runtime.cash = s.rn[1];
  const w = g.weather;
  w.rain = s.w[0]; w.wet = s.w[1]; w.wind = s.w[2]; w.flash = s.w[3];

  for (let i = 0; i < s.pl.length && i < g.players.length; i++) {
    const p = g.players[i], row = s.pl[i], bits = row[15];
    p.hp = row[6]; p.ammo = row[7]; p.batt = row[8]; p.stam = row[9]; p.carried = row[10];
    p.x = row[0]; p.y = row[1]; p.vx = row[2]; p.vy = row[3];
    p.ang = row[4]; p.aim = row[5]; p.walk = row[13];
    p.inv = row[11]; p.stagger = row[12]; p.reviveT = row[14];
    p.torch = has(bits, 0); p.sneaking = has(bits, 1);
    p.running = has(bits, 2); p.moving = has(bits, 3); p.down = has(bits, 4);
  }

  // The roster was built from the seed, so nothing is created here — the horde is only narrowed
  // down to whoever is still standing.
  const byId = zombieIndex(g);
  g.zombies.length = 0;
  for (const row of s.z) {
    const z = byId.get(row[0]);
    if (!z) continue;
    z.x = row[1]; z.y = row[2]; z.ang = row[3]; z.walk = row[7];
    z.hp = row[4]; z.notice = row[5]; z.hunt = row[6];
    z.headless = has(row[8], 0); z.silent = has(row[8], 1); z.lostArms = row[8] >> 2;
    z.gone = false;
    g.zombies.push(z);
  }

  const cars = carIndex(g);
  for (const row of s.c) {
    const c = cars.get(row[0]);
    if (!c) continue;
    c.x = row[1]; c.y = row[2]; c.hx = row[3]; c.hy = row[4];
    c.v = row[5]; c.damage.integrity = row[6];
    c.beacon = row[7]; c.honk = row[8]; c.hazard = row[9];
    c.broken = has(row[10], 0);
  }

  rebuild(g.bullets, s.b, row => ({ x: row[0], y: row[1], px: row[0], py: row[1],
    vx: row[2], vy: row[3], l: row[4], own: row[5] ? true : undefined }));
  rebuild(g.zombieShots, s.f, row => ({ x: row[0], y: row[1], px: row[0], py: row[1],
    vx: row[2], vy: row[3], l: row[4], r: row[5], kind: row[6], spin: row[7] }));
  rebuild(g.cash, s.cs, row => ({ x: row[0], y: row[1], n: row[2], vx: 0, vy: 0, ph: row[0] * .1, tilt: 0 }));
  rebuild(g.ammoBoxes, s.ab, row => ({ x: row[0], y: row[1], batt: !!row[2], n: row[3], ph: row[0] * .1 }));

  applyParts(g, s.pt);

  for (let i = 0; i < s.pc.length && i < g.parcels.length; i++) {
    const b = g.parcels[i];
    b.state = ['ground', 'carried', 'done'][s.pc[i][0]];
    b.carrier = s.pc[i][1];
  }
  for (const l of g.lamps) l.broken = false;
  for (const i of s.lb) if (g.lamps[i]) g.lamps[i].broken = true;

  if (s.e) for (const e of s.e) g.events.push(e);
}

function rebuild(list, rows, make) {
  list.length = 0;
  for (const row of rows) list.push(make(row));
}

// A severed head is a physical object for the rest of the district, so it is streamed rather
// than guessed at. Its colours come from the zombie it used to belong to, which is still on the
// roster and still knows what it looked like.
function applyParts(g, rows) {
  const byId = zombieIndex(g);
  const existing = new Map(g.zombieParts.map(part => [part.id, part]));
  g.zombieParts.length = 0;
  for (const row of rows) {
    let part = existing.get(row[0]);
    if (!part) {
      const owner = byId.get(row[1]);
      part = {
        id: row[0], zid: row[1], kind: row[2], side: row[3],
        vx: 0, vy: 0, vh: 0, spin: 0, l: Infinity, kickCd: 0, bleed: 0, bleedCd: 0,
        skin: owner ? owner.skin : '#7f8f7a', clothes: owner ? owner.clothes : '#3d4753',
        eye: owner ? owner.eye : '#ff7a2f', blood: owner ? owner.blood : ['#6f9c33'],
        stain: owner ? owner.stain : [56, 92, 26], seed: owner ? owner.seed : .5,
        shotHits: 0
      };
    }
    part.x = row[4]; part.y = row[5]; part.h = row[6]; part.ang = row[7];
    part.size = row[8]; part.heat = row[9]; part.explosive = has(row[10], 0);
    g.zombieParts.push(part);
  }
}

function zombieIndex(g) {
  if (!g.zombieById) g.zombieById = new Map(g.zombies.map(z => [z.id, z]));
  return g.zombieById;
}
function carIndex(g) {
  if (!g.carById) g.carById = new Map(g.cars.map(c => [c.id, c]));
  return g.carById;
}

// Positions are the one thing worth easing between two snapshots; everything else simply is what
// the newer one says.
function interpolate(g, a, b, t) {
  for (let i = 0; i < g.players.length; i++) {
    const p = g.players[i], ra = a.pl[i], rb = b && b.pl[i];
    if (!ra) continue;
    if (!rb) { p.x = ra[0]; p.y = ra[1]; p.vx = ra[2]; p.vy = ra[3]; p.ang = ra[4]; p.aim = ra[5]; p.walk = ra[13]; continue; }
    p.x = ra[0] + (rb[0] - ra[0]) * t;
    p.y = ra[1] + (rb[1] - ra[1]) * t;
    p.vx = ra[2] + (rb[2] - ra[2]) * t;
    p.vy = ra[3] + (rb[3] - ra[3]) * t;
    p.ang = lerpAngle(ra[4], rb[4], t);
    p.aim = lerpAngle(ra[5], rb[5], t);
    p.walk = ra[13] + (rb[13] - ra[13]) * t;
  }
  const older = new Map(a.z.map(row => [row[0], row]));
  const newer = b ? new Map(b.z.map(row => [row[0], row])) : null;
  for (const z of g.zombies) {
    const ra = older.get(z.id);
    const rb = newer && newer.get(z.id);
    if (!ra) continue;
    if (!rb) { z.x = ra[1]; z.y = ra[2]; z.ang = ra[3]; z.walk = ra[7]; continue; }
    z.x = ra[1] + (rb[1] - ra[1]) * t;
    z.y = ra[2] + (rb[2] - ra[2]) * t;
    z.ang = lerpAngle(ra[3], rb[3], t);
    z.walk = ra[7] + (rb[7] - ra[7]) * t;
  }
  const olderCars = new Map(a.c.map(row => [row[0], row]));
  const newerCars = b ? new Map(b.c.map(row => [row[0], row])) : null;
  for (const c of g.cars) {
    const ra = olderCars.get(c.id);
    const rb = newerCars && newerCars.get(c.id);
    if (!ra) continue;
    if (!rb) { c.x = ra[1]; c.y = ra[2]; c.hx = ra[3]; c.hy = ra[4]; continue; }
    c.x = ra[1] + (rb[1] - ra[1]) * t;
    c.y = ra[2] + (rb[2] - ra[2]) * t;
    c.hx = ra[3] + (rb[3] - ra[3]) * t;
    c.hy = ra[4] + (rb[4] - ra[4]) * t;
  }
}

// Bullets and thrown filth travel in straight lines and live for a fraction of a second. Waiting
// for the next snapshot would show them stepping twenty times a second, so between snapshots
// they are simply carried forward — which is exactly where they were going anyway.
function carryProjectiles(g, dt) {
  for (const b of g.bullets) { b.px = b.x; b.py = b.y; b.x += b.vx * dt; b.y += b.vy * dt; }
  for (const s of g.zombieShots) { s.px = s.x; s.py = s.y; s.x += s.vx * dt; s.y += s.vy * dt; s.spin += dt * 8; }
}

// Make the district current, then hand it to the frame. This is where a guest spends its time:
// it never decides anything, it catches up.
function pump(g, dt) {
  if (!queue.length) return;
  const newest = queue[queue.length - 1];
  const target = newest.gs[0] - DELAY;
  if (renderTime === null || Math.abs(target - renderTime) > 1) renderTime = target;
  else renderTime += dt + (target - renderTime) * Math.min(1, dt * 2);

  let a = queue[0], b = null;
  for (let i = 0; i < queue.length - 1; i++) {
    if (queue[i].gs[0] <= renderTime && queue[i + 1].gs[0] >= renderTime) { a = queue[i]; b = queue[i + 1]; break; }
    if (queue[i].gs[0] <= renderTime) a = queue[i];
  }
  const span = b ? b.gs[0] - a.gs[0] : 0;
  const t = span > 0 ? Math.min(1, Math.max(0, (renderTime - a.gs[0]) / span)) : 0;
  applySnapshot(g, b || a);
  interpolate(g, a, b, t);
  carryProjectiles(g, dt);
  while (queue.length > 2 && queue[1].gs[0] < renderTime - DELAY * 2) queue.shift();
}

// ---------- what each end does with a frame ----------
let inputSeq = 0, sinceSnapshot = 0;

// A guest says what its courier is doing and nothing else. Aim travels in world coordinates,
// because a point on its screen means nothing on the host's.
function sendInput(p) {
  if (role !== 'guest' || !p.in) return;
  const i = p.in;
  send({ t: 'i', n: ++inputSeq, x: q2(i.x), y: q2(i.y), m: q2(i.m),
    run: i.run ? 1 : 0, fire: i.fire ? 1 : 0, finish: i.finish ? 1 : 0,
    tx: q1(p.tx), ty: q1(p.ty), ts: i.torchSeq, ss: i.sneakSeq });
}

function hostTick(g, dt) {
  if (role !== 'host') return;
  sinceSnapshot += dt;
  if (sinceSnapshot < 1 / SNAPSHOT_HZ) return;
  sinceSnapshot = 0;
  send(encodeSnapshot(g, remoteSeq));
}

// Input from the partner is written straight onto their courier's record, so the rules read it
// the same way they read a keyboard.
let remoteSeq = 0;
function applyRemoteInput(g, msg) {
  const p = g.players[1];
  if (!p) return;
  const rec = p.in;
  // The first packet says where the partner's counters already stand. Treating that as presses
  // would flick their flashlight on arrival for no reason.
  if (p.torchSeen === null) { p.torchSeen = msg.ts; p.sneakSeen = msg.ss; }
  remoteSeq = msg.n;
  rec.n = msg.n;
  rec.x = msg.x; rec.y = msg.y; rec.m = msg.m;
  rec.run = !!msg.run; rec.fire = !!msg.fire; rec.finish = !!msg.finish;
  rec.aimScreen = true; rec.tx = msg.tx; rec.ty = msg.ty;
  rec.torchSeq = msg.ts; rec.sneakSeq = msg.ss;
}

return Object.freeze({
  available, connect, disconnect, send,
  authoritative, state,
  hostDistrict, declareLayout,
  encodeSnapshot, applySnapshot, pump, hostTick, sendInput,
  receiveSnapshot, applyRemoteInput,
  get pendingStart() { return pendingStart; },
  set onStatus(fn) { onStatus = fn; },
  set onStart(fn) { onStart = fn; }
});
})();
