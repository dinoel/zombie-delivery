// A relay for two browsers, and a static server so they can both reach the game.
//
// It is deliberately not a game server: it never parses a snapshot, knows nothing about
// districts or couriers, and could forward anything at all. One of the two browsers runs the
// simulation and the other watches; this only carries bytes between them. That keeps the rules
// in one place — the game — instead of growing a second, subtly different copy in node.
//
// Nothing here is installed. It is node's own http and crypto, a hand-written slice of RFC 6455,
// and no dependencies, because the rest of the project has none either and playing alone over
// file:// must keep working whether or not this is ever started.
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1 << 20;          // A snapshot is kilobytes. A megabyte is already a bug.
const OP = Object.freeze({ text: 0x1, close: 0x8, ping: 0x9, pong: 0xA });
const PING_EVERY = 20000, SILENCE_LIMIT = 45000;

const acceptKey = key => crypto.createHash('sha1').update(key + GUID).digest('base64');

// Server frames are never fragmented and never masked, which is the whole of what we send.
function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const n = body.length;
  let head;
  if (n < 126) { head = Buffer.alloc(2); head[1] = n; }
  else if (n < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(n, 2); }
  else {
    head = Buffer.alloc(10); head[1] = 127;
    head.writeUInt32BE(Math.floor(n / 4294967296), 2);
    head.writeUInt32BE(n >>> 0, 6);
  }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, body]);
}

// One read from a socket is not one frame. It can carry several frames, half of one, or a header
// split down the middle, and a parser that assumes otherwise works perfectly until the moment
// there is enough traffic to matter. So bytes accumulate here and a frame is only taken out once
// all of it has arrived.
function createParser() {
  let buf = Buffer.alloc(0);
  return function push(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (buf.length < 2) break;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) {
        if (buf.length < 4) break;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) break;
        if (buf.readUInt32BE(2) !== 0) throw new Error('frame larger than this relay will carry');
        len = buf.readUInt32BE(6); off = 10;
      }
      if (len > MAX_PAYLOAD) throw new Error('frame larger than this relay will carry');
      // Nothing this game sends is fragmented, so a continuation frame means the stream is not
      // what it claims to be. Better to say so than to guess.
      if (opcode === 0x0) throw new Error('fragmented frames are not supported');
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) break;
      let payload;
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        payload = Buffer.from(buf.subarray(off + 4, need));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      } else {
        payload = Buffer.from(buf.subarray(off, need));
      }
      out.push({ opcode, payload });
      buf = buf.subarray(need);
    }
    return out;
  };
}

// ---------- rooms ----------
// Two peers to a room. The first in is the host and runs the simulation; the second watches.
const rooms = new Map();

const sendRaw = (peer, buffer) => { if (!peer.socket.destroyed) peer.socket.write(buffer); };
const sendJson = (peer, obj) => sendRaw(peer, encodeFrame(OP.text, JSON.stringify(obj)));

function partnerOf(peer) {
  const room = rooms.get(peer.room);
  if (!room) return null;
  return room.find(other => other !== peer) || null;
}

// A peer says whether it meant to open a room or walk into one. The relay still knows nothing
// about the game, but honouring the intent is the difference between "that room is taken" and
// two people silently both believing they are hosting.
function joinRoom(peer, code, want) {
  const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!clean) { sendJson(peer, { t: 'error', reason: 'room' }); return; }
  const room = rooms.get(clean) || [];
  if (room.length >= 2) { sendJson(peer, { t: 'full' }); peer.socket.end(); return; }
  if (want === 'host' && room.length) { sendJson(peer, { t: 'error', reason: 'taken' }); return; }
  if (want === 'guest' && !room.length) { sendJson(peer, { t: 'error', reason: 'empty' }); return; }
  peer.room = clean;
  peer.role = room.length === 0 ? 'host' : 'guest';
  room.push(peer);
  rooms.set(clean, room);
  sendJson(peer, { t: 'joined', role: peer.role, room: clean, peers: room.length });
  const other = partnerOf(peer);
  if (other) {
    sendJson(other, { t: 'peer', event: 'join', role: peer.role });
    sendJson(peer, { t: 'peer', event: 'join', role: other.role });
  }
}

function leaveRoom(peer) {
  if (!peer.room) return;
  const room = rooms.get(peer.room);
  if (!room) return;
  const i = room.indexOf(peer);
  if (i >= 0) room.splice(i, 1);
  for (const other of room) sendJson(other, { t: 'peer', event: 'leave', role: peer.role });
  if (!room.length) rooms.delete(peer.room);
  peer.room = null;
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  // Chrome offers permessage-deflate. Echoing it back would promise an inflate implementation
  // this relay does not have, and every frame after the handshake would be unreadable.
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  socket.setNoDelay(true);

  const peer = { socket, room: null, role: null, lastSeen: Date.now() };
  const parse = createParser();

  socket.on('data', chunk => {
    peer.lastSeen = Date.now();
    let frames;
    try { frames = parse(chunk); }
    catch (err) { socket.destroy(); return; }
    for (const frame of frames) {
      if (frame.opcode === OP.close) { socket.end(); return; }
      if (frame.opcode === OP.ping) { sendRaw(peer, encodeFrame(OP.pong, frame.payload)); continue; }
      if (frame.opcode === OP.pong) continue;
      if (frame.opcode !== OP.text) continue;
      // Only the first message is read, and only far enough to find a room. After that the relay
      // stops looking: forwarding raw bytes keeps it out of the protocol the game speaks.
      if (!peer.room) {
        let msg = null;
        try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { /* not for us */ }
        if (msg && msg.t === 'join') joinRoom(peer, msg.room, msg.want);
        else sendJson(peer, { t: 'error', reason: 'join first' });
        continue;
      }
      const other = partnerOf(peer);
      if (other) sendRaw(other, encodeFrame(OP.text, frame.payload));
    }
  });

  const keepalive = setInterval(() => {
    if (Date.now() - peer.lastSeen > SILENCE_LIMIT) { socket.destroy(); return; }
    sendRaw(peer, encodeFrame(OP.ping, Buffer.alloc(0)));
  }, PING_EVERY);

  const done = () => { clearInterval(keepalive); leaveRoom(peer); };
  socket.on('close', done);
  socket.on('error', done);
}

// ---------- static files ----------
// Serving the project from the same port means both machines open one URL and the game arrives
// with the query string intact, which file:// does not manage.
const ROOT = path.join(__dirname, '..');
const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
});

function serveFile(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {   // No climbing out of the project.
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces() || {}))
    for (const net of list || [])
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
  return out;
}

function start(port = Number(process.env.PORT) || 8787) {
  const server = http.createServer(serveFile);
  server.on('upgrade', handleUpgrade);
  server.listen(port, () => {
    console.log(`COURIER relay listening on port ${port}`);
    console.log(`  this machine:  http://localhost:${port}/`);
    for (const address of localAddresses())
      console.log(`  same network:  http://${address}:${port}/`);
    console.log('Open the page on both machines, host with a room code, and join with the same one.');
  });
  return server;
}

module.exports = { acceptKey, encodeFrame, createParser, start, OP, MAX_PAYLOAD };

if (require.main === module) start();
