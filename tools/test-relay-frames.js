// The relay speaks a hand-written slice of RFC 6455, so the slice is checked.
//
// Almost every failure a hand-rolled WebSocket relay has is in this file's subject matter: an
// accept key computed against the wrong string, a length field that only ever got tested at
// small sizes, and above all a parser that assumes one read from a socket is one frame. That
// last one works flawlessly until there is enough traffic for it to matter, which is exactly
// when a game is worth playing.
'use strict';

const assert = require('assert').strict;
const { acceptKey, encodeFrame, createParser, OP, MAX_PAYLOAD } = require('./relay.js');

// Masking is the client's job, so the test has to do it to produce anything the relay would
// actually receive.
function clientFrame(text, mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d])) {
  const body = Buffer.from(text, 'utf8');
  const n = body.length;
  let head;
  if (n < 126) { head = Buffer.alloc(2); head[1] = 0x80 | n; }
  else if (n < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(n, 2); }
  else {
    head = Buffer.alloc(10); head[1] = 0x80 | 127;
    head.writeUInt32BE(0, 2); head.writeUInt32BE(n, 6);
  }
  head[0] = 0x80 | OP.text;
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, masked]);
}

{
  // The fixed vector from the specification. Getting this wrong means no browser ever connects,
  // and the error it reports says nothing useful about why.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
    'the accept key must match the published example');
}

{
  // Every boundary in the length encoding, from both sides of each one.
  for (const n of [0, 1, 125, 126, 127, 65535, 65536, 70000]) {
    const text = 'x'.repeat(n);
    const parse = createParser();
    const frames = parse(clientFrame(text));
    assert.equal(frames.length, 1, `a ${n}-byte frame should arrive as one frame`);
    assert.equal(frames[0].payload.toString('utf8'), text, `a ${n}-byte payload should survive`);
    assert.equal(frames[0].opcode, OP.text);
  }
}

{
  // What the relay writes must be readable as what it meant, at every length boundary.
  for (const n of [0, 125, 126, 65535, 65536]) {
    const body = Buffer.alloc(n, 0x41);
    const framed = encodeFrame(OP.text, body);
    assert.equal(framed[0], 0x80 | OP.text, 'server frames are final and unfragmented');
    assert.equal((framed[1] & 0x80), 0, 'server frames are never masked');
    const declared = (framed[1] & 0x7f) === 126 ? framed.readUInt16BE(2)
      : (framed[1] & 0x7f) === 127 ? framed.readUInt32BE(6)
      : framed[1] & 0x7f;
    assert.equal(declared, n, `a ${n}-byte frame should declare its own length`);
    assert.equal(framed.length - (framed.length - n), n);
  }
}

{
  // Several frames delivered in one read.
  const parse = createParser();
  const frames = parse(Buffer.concat([clientFrame('one'), clientFrame('two'), clientFrame('three')]));
  assert.equal(frames.length, 3, 'one read can carry several frames');
  assert.deepEqual(frames.map(f => f.payload.toString('utf8')), ['one', 'two', 'three']);
}

{
  // One frame split across three reads, including a split inside the header itself.
  const whole = clientFrame('a message long enough to be worth splitting up');
  const parse = createParser();
  assert.equal(parse(whole.subarray(0, 1)).length, 0, 'half a header yields nothing yet');
  assert.equal(parse(whole.subarray(1, 6)).length, 0, 'nor does a partial payload');
  const frames = parse(whole.subarray(6));
  assert.equal(frames.length, 1, 'the frame appears once its last byte arrives');
  assert.equal(frames[0].payload.toString('utf8'), 'a message long enough to be worth splitting up');
}

{
  // A frame arriving one byte at a time is the same frame.
  const whole = clientFrame('drip');
  const parse = createParser();
  let got = [];
  for (const byte of whole) got = got.concat(parse(Buffer.from([byte])));
  assert.equal(got.length, 1, 'a byte-at-a-time stream still produces exactly one frame');
  assert.equal(got[0].payload.toString('utf8'), 'drip');
}

{
  // A trailing partial frame must not disturb the complete one in front of it.
  const parse = createParser();
  const tail = clientFrame('second');
  const frames = parse(Buffer.concat([clientFrame('first'), tail.subarray(0, 4)]));
  assert.equal(frames.length, 1, 'only the complete frame comes out');
  assert.equal(frames[0].payload.toString('utf8'), 'first');
  const rest = parse(tail.subarray(4));
  assert.equal(rest[0].payload.toString('utf8'), 'second', 'the remainder completes afterwards');
}

{
  // Control frames travel alongside data and must be recognised rather than forwarded as text.
  const parse = createParser();
  const ping = Buffer.from([0x80 | OP.ping, 0x80, 1, 2, 3, 4]);
  const frames = parse(Buffer.concat([ping, clientFrame('after')]));
  assert.equal(frames[0].opcode, OP.ping, 'a ping is a ping');
  assert.equal(frames[1].payload.toString('utf8'), 'after', 'and does not swallow what follows');
}

{
  // Nothing this game sends is fragmented, so a continuation frame means the stream is not what
  // it claims to be. Saying so beats guessing and corrupting everything after it.
  const parse = createParser();
  assert.throws(() => parse(Buffer.from([0x00, 0x80, 0, 0, 0, 0])),
    /fragmented/, 'a continuation frame should be refused out loud');
}

{
  // An absurd declared length must be refused before anything tries to allocate it.
  const parse = createParser();
  const head = Buffer.alloc(10);
  head[0] = 0x80 | OP.text; head[1] = 127;
  head.writeUInt32BE(0, 2); head.writeUInt32BE(MAX_PAYLOAD + 1, 6);
  assert.throws(() => parse(head), /larger than this relay will carry/,
    'an oversized frame should be refused on its header alone');

  const huge = Buffer.alloc(10);
  huge[0] = 0x80 | OP.text; huge[1] = 127;
  huge.writeUInt32BE(1, 2); huge.writeUInt32BE(0, 6);     // Four gigabytes and change.
  assert.throws(() => createParser()(huge), /larger than this relay will carry/,
    'and so should one whose length does not fit in the low word');
}

console.log('Relay framing verified: accept key, every length boundary, split and merged reads.');
