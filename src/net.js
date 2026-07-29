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

return Object.freeze({
  available, connect, disconnect, send,
  authoritative, state,
  hostDistrict, declareLayout,
  get pendingStart() { return pendingStart; },
  set onStatus(fn) { onStatus = fn; },
  set onStart(fn) { onStart = fn; }
});
})();
