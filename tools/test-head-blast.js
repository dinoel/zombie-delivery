// A tank's head, shot until it goes off.
//
// This exists because it did not. A courier put five rounds into a tank head and the frame died
// on a stale variable — a name that had belonged to the single-player blast block, still being
// read after that block became a loop over the shift. Ten tests passed on either side of it,
// because not one of them ever detonated anything: the district-wide digest never puts five
// rounds into the same head, and the co-op tests have no tanks in them.
//
// The game already scripts this scene for the browser, so the test drives that same script rather
// than inventing a second version of it — which also means the thing under test is the path a
// player actually takes.
'use strict';

const assert = require('assert').strict;
const { load } = require('./browser-sandbox.js');

const MODULES = ['core', 'quality', 'audio', 'car-physics', 'environment',
  'world', 'physics', 'input', 'gameplay'];

// The scripted scene: a tank is killed, its head is planted, and five rounds go into it on a
// timer. Two and a half seconds of district covers the whole sequence.
function detonate(prepare) {
  const env = load({ modules: MODULES, seed: 0x51ed5eed, search: '?qa=zombie-head-explosion' });
  const g = env.TownGame.world.buildTown(3);
  const rt = env.TownGame.core.runtime;
  rt.game = g; rt.state = 'play';
  let head = null, prepared = false;
  for (let f = 0; f < 60 * 3; f++) {
    env.TownGame.gameplay.update(g, 1 / 60);
    if (!head) head = g.zombieParts.find(part => part.kind === 'head' && part.explosive) || null;
    // Once the head exists and before it goes off, let the caller arrange what is standing near it.
    if (head && !prepared && !g.headExplosions) { prepared = true; if (prepare) prepare(g, head); }
    if (g.headExplosions) break;
  }
  return { env, g, head };
}

{
  // The sequence itself. Before the fix this threw on the fifth round instead of exploding.
  const { g, head } = detonate();
  assert.ok(head, 'killing a tank should leave an explosive head');
  assert.equal(g.headExplosions, 1, 'five rounds into it should set it off exactly once');
  assert.equal(g.explosiveHeadHits, 5, 'and it should have taken five to get there');
  assert.ok(g.blasts.length > 0, 'the blast should exist in the world');
}

{
  // What the blast reaches. Each of these became a loop over the shift during the refactor, so
  // each is a place the same mistake could have been made and nothing would have noticed.
  let hpBefore = 0, victim = null, victimHpBefore = 0, lampsBefore = 0;
  const { g } = detonate((g, head) => {
    const p = g.p;
    p.x = head.x + 18; p.y = head.y; p.inv = 0; p.vx = p.vy = 0;
    hpBefore = p.hp;
    const lamp = g.lamps.find(l => !l.broken);
    lamp.hx = head.x + 40; lamp.hy = head.y + 12;
    lampsBefore = g.lamps.filter(l => l.broken).length;
    victim = g.zombies.find(z => !z.gone && z.kind !== 'tank');
    if (victim) { victim.x = head.x + 26; victim.y = head.y - 12; victimHpBefore = victim.hp; }
  });
  assert.ok(g.headExplosions > 0, 'the head should have gone off');
  assert.ok(g.p.hp < hpBefore, 'a courier standing on a blast should be hurt by it');
  assert.ok(g.shake > 0, 'and should feel it');
  assert.ok(victim && (victim.gone || victim.hp < victimHpBefore),
    'a zombie standing in the blast should take it too');
  assert.ok(g.lamps.filter(l => l.broken).length > lampsBefore,
    'and a lamp inside it should lose its glass');
}

{
  // A blast writes one note, and it carries a place rather than a loudness: how hard it lands is
  // a question about where a screen is, and each end answers that for itself.
  const { env, g } = detonate((g, head) => { g.p.x = head.x + 18; g.p.y = head.y; g.p.inv = 0; });
  const { EV } = env.TownGame.environment;
  const note = g.events.find(e => e[0] === EV.blast);
  assert.ok(note, 'the blast should be written down for a peer that never ran the rule');
  assert.equal(note.length, 3, 'and should carry only where it happened');

  // Replayed on a peer that never simulated, it has to shake that peer's own screen.
  g.shake = 0; g.events.length = 0;
  g.events.push([EV.blast, g.p.x, g.p.y]);
  env.TownGame.gameplay.presentFrame(g, 1 / 60);
  const underfoot = g.shake;
  g.shake = 0;
  g.events.push([EV.blast, g.p.x + 4000, g.p.y]);
  env.TownGame.gameplay.presentFrame(g, 1 / 60);
  assert.ok(underfoot > 1, `a replayed blast underfoot should land hard (was ${underfoot.toFixed(2)})`);
  assert.equal(g.shake, 0, 'and one across the district should not be felt at all');
}

console.log('Head blast verified: five rounds, the blast, what it reaches, and the note it leaves.');
