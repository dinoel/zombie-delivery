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
let partnerPaused = false;
let pendingStart = null;              // A start message a guest has received but not yet built.
let onStatus = null, onStart = null;

// Whoever is not a guest owns the rules, which alone in a district is always this peer.
const authoritative = () => role !== 'guest';
const state = () => ({ role, phase, room, partner: partnerPresent, partnerPaused });

function announce(text) {
  if (onStatus) onStatus(text, state());
}

// Co-op needs the page to have come from the relay, because that is also what it talks to.
// Opening index.html straight off the disk is still a complete game; it just cannot be two.
const available = () => location.protocol === 'http:' || location.protocol === 'https:';

const relayUrl = () =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/`;

// Loopback has no latency worth the name, and prediction that is only ever tested at zero
// latency is prediction that has not been tested. ?lag=120 puts a round trip back in, with a
// little jitter, so the correction can be watched doing its job. It deliberately uses its own
// parameter rather than a qa flag, because a qa flag changes the district and this must not.
const lagMs = Math.max(0, Math.min(600, Number(new URLSearchParams(location.search).get('lag')) || 0));
const delayed = fn => {
  if (!lagMs) { fn(); return; }
  setTimeout(fn, lagMs / 2 + Math.random() * lagMs * .15);
};

function send(message) {
  if (!socket || socket.readyState !== 1) return;
  const text = JSON.stringify(message);
  delayed(() => { if (socket && socket.readyState === 1) socket.send(text); });
}

function disconnect(reason) {
  if (socket) { try { socket.close(); } catch { /* already gone */ } }
  socket = null;
  role = 'solo'; phase = 'idle'; room = ''; partnerPresent = false; partnerPaused = false; pendingStart = null;
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
  socket.addEventListener('message', e => delayed(() => receive(e.data)));
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
    // The host has stopped the district. This end keeps drawing the last frame it has and says
    // why, rather than appearing to have frozen on its own.
    case 'pause': partnerPaused = !!msg.on; break;
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
    send({ t: 'start', proto: PROTOCOL, level: g.level, seed: g.seed, madness: !!g.madness, sum });
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

let snapshotSerial = 0, lastReconciled = -1;
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
      flag(z.headless, 0) | flag(z.silent, 1) | ((z.lostArms || 0) << 2), q2(z.burn || 0)]);
  }
  return {
    t: 's', ack, k: ++snapshotSerial,
    gs: [q2(g.time), g.delivered, g.killed, g.earned, q2(g.spawnGrace),
      flag(g.done, 0) | flag(g.dead, 1)],
    pl: g.players.map(p => [q1(p.x), q1(p.y), q1(p.vx), q1(p.vy), q2(p.ang), q2(p.aim),
      p.hp, p.ammo, q2(p.batt), q2(p.stam), p.carried, q2(p.inv), q2(p.stagger), q1(p.walk),
      q2(p.reviveT),
      // Holding the trigger on the flamethrower is one bit, and it is the whole weapon on the
      // wire. There is no flame entity to send: the far end has a position, an aim and this, and
      // draws the entire jet for itself.
      flag(p.torch, 0) | flag(p.sneaking, 1) | flag(p.running, 2) | flag(p.moving, 3) |
      flag(p.down, 4) | flag(p.flaming, 5),
      // Which roof they are standing on, by index, because the houses came from the seed and both
      // ends already have the same list. Minus one is the street.
      p.roof ? g.houses.indexOf(p.roof) : -1, q2(p.climb || 0),
      // Which car they are driving, by the same trick as the roof: the roster is fixed when the
      // district is grown, so an index names a car the far end already holds. Minus one is on foot.
      // The car's own row carries where it is and how it is sitting, so this one number is the
      // whole of driving on the wire.
      p.car ? g.cars.indexOf(p.car) : -1]),
    z: live,
    // The fuse travels because it is the only warning a wreck gives before it goes up, and a
    // guest reading it a beat late is a guest standing next to a car it thought was safe.
    c: g.cars.map(c => [c.id, q1(c.x), q1(c.y), q2(c.hx), q2(c.hy), q1(c.v), q2(c.damage.integrity),
      q2(c.beacon || 0), q2(c.honk || 0), q2(c.hazard || 0),
      flag(c.broken, 0) | flag(c.police, 1) | flag(c.exploded, 2), q2(c.fuse || 0),
      // Where the front wheels are pointed and how far the tail has stepped out. Neither can be
      // worked out from a position and a heading a twentieth of a second apart, and both are what
      // a car in a corner looks like.
      q2(c.steer || 0), q1(c.slip || 0)]),
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
    p.flaming = has(bits, 5);
    p.roof = row[16] >= 0 ? g.houses[row[16]] : null;
    p.climb = row[17];
    // The link is kept pointing both ways, because a watching peer draws from both ends of it:
    // the courier is not drawn while it is set, and the car is what the courier is drawn inside.
    const car = row[18] >= 0 ? g.cars[row[18]] : null;
    if (p.car && p.car !== car) p.car.driver = null;
    p.car = car;
    if (car) car.driver = p;
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
    z.burn = row[9];
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
    c.exploded = has(row[10], 2);
    c.fuse = row[11];
    c.steer = row[12]; c.slip = row[13];
  }

  // Whether a round is heavy is not sent: in madness every patrol round is one, and outside it
  // none of them are, so the one bit it would cost is a bit both ends already hold.
  rebuild(g.bullets, s.b, row => ({ x: row[0], y: row[1], px: row[0], py: row[1],
    vx: row[2], vy: row[3], l: row[4], own: row[5] ? true : undefined,
    heavy: !!(row[5] && g.madness) }));
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
  // Built from the bench as well as the street, because madness takes bodies off the bench and a
  // snapshot will name one the moment it does.
  if (!g.zombieById)
    g.zombieById = new Map(g.zombies.concat(g.reserve || []).map(z => [z.id, z]));
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

// ---------- the guest's own courier ----------
//
// Everything else on a guest's screen is a tenth of a second old, and that is fine: a partner
// half a street away does not need to be current. Its own courier does. Walking with the delay
// on your own legs is the one thing that makes a game feel broken, so this end runs its own
// steps forward and then quietly agrees with the host afterwards.
//
// Aim is deliberately not predicted, and does not need to be: it travels in world coordinates,
// so the host fires along exactly the line the guest drew. Only the muzzle lags, by latency
// times walking speed — about fifteen pixels at sixty milliseconds.
const SNAP_AT = 60;                   // Past this the host is telling us something we cannot ease into.
const history = [];                   // { n, x, y } for each step this end has taken.
const HISTORY_MAX = 240;
let errX = 0, errY = 0;

function predict(g, dt) {
  const p = g.p;
  if (!p || !p.in) return;
  window.TownGame.gameplay.stepCourier(g, p, dt, true);
  history.push({ n: p.in.n, x: p.x, y: p.y });
  if (history.length > HISTORY_MAX) history.shift();

  // Whatever the host disagreed about is folded in over about a quarter of a second, which is
  // slow enough not to be seen and fast enough not to accumulate.
  if (errX || errY) {
    const k = 1 - Math.pow(.002, dt);
    p.x += errX * k; p.y += errY * k;
    errX -= errX * k; errY -= errY * k;
    if (Math.abs(errX) < .05 && Math.abs(errY) < .05) errX = errY = 0;
  }
}

// The host has now told us where our courier really was at the moment it had heard input number
// `ack`. Compare that against where we thought it was at the same moment, not against where we
// are now — a tenth of a second of walking is not an error.
function reconcile(g, row, ack) {
  const p = g.p;
  let past = null;
  for (let i = history.length - 1; i >= 0; i--) if (history[i].n === ack) { past = history[i]; break; }
  while (history.length && history[0].n <= ack) history.shift();
  if (!past) {                        // No memory of that moment: take the host's word for it.
    p.x = row[0]; p.y = row[1]; p.vx = row[2]; p.vy = row[3];
    errX = errY = 0;
    return;
  }
  const dx = row[0] - past.x, dy = row[1] - past.y;
  if (Math.hypot(dx, dy) > SNAP_AT) {
    // A car, a blast or a bite. Nothing about that is worth easing into: it is meant to be sudden.
    p.x = row[0]; p.y = row[1]; p.vx = row[2]; p.vy = row[3];
    history.length = 0; errX = errY = 0;
    return;
  }
  errX = dx; errY = dy;
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
  const newestApplied = b || a;
  const mine = g.p;
  const held = mine ? { x: mine.x, y: mine.y, vx: mine.vx, vy: mine.vy, ang: mine.ang, aim: mine.aim, walk: mine.walk } : null;
  applySnapshot(g, newestApplied);
  interpolate(g, a, b, t);
  // Its own courier is put back where this end had walked it to, and the disagreement with the
  // host is settled separately rather than by jumping.
  if (held && role === 'guest' && newestApplied.k !== lastReconciled) {
    lastReconciled = newestApplied.k;
    const row = newestApplied.pl[mine.id];
    Object.assign(mine, held);
    if (row) reconcile(g, row, newestApplied.ack || 0);
  } else if (held && role === 'guest') {
    Object.assign(mine, held);
  }
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
  // Small courtesies the rest of the game asks for without needing to know how any of it works.
  note: announce,
  sendPause: on => { if (role === 'host') send({ t: 'pause', on: !!on }); },
  authoritative, state,
  hostDistrict, declareLayout,
  encodeSnapshot, applySnapshot, pump, predict, reconcile, hostTick, sendInput,
  // What the guess currently disagrees with the host about, for tuning the correction and for
  // seeing at a glance whether the guess is doing anything at all.
  debug: () => ({ lagMs, history: history.length, errX: +errX.toFixed(2), errY: +errY.toFixed(2),
    queued: queue.length, renderTime: renderTime === null ? null : +renderTime.toFixed(2),
    authoritative: queue.length ? queue[queue.length - 1].pl : null }),
  receiveSnapshot, applyRemoteInput,
  get pendingStart() { return pendingStart; },
  set onStatus(fn) { onStatus = fn; },
  set onStart(fn) { onStart = fn; }
});
})();
