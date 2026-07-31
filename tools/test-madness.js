// Madness: ammunition is free and the horde keeps arriving.
//
// The interesting constraint is not the mode, it is that the mode had to fit an existing promise.
// A snapshot names entities by id and the far end only ever updates what it already holds, so a
// horde that grew would be a horde a guest could not see. Nothing is created: the district is
// built with a reserve on the bench, arrivals come off it, and bodies go back on. That is the
// claim most worth pinning, because breaking it would look fine alone and be invisibly broken
// with two players.
'use strict';

const assert = require('assert').strict;
const { scene } = require('./scene.js');

// A courier standing still in madness is dead inside a minute, and a dead one freezes the
// spawner — so every run here holds them upright, or the sample measures its own death rather
// than the mode. `scene` does that without painting the screen; the reason is written down there.
const district = madness => {
  const s = scene({ madness });
  s.immortal();
  return s;
};

{
  // A normal district is untouched by any of this: no bench, no arrivals, rounds still cost.
  const s = district(false);
  assert.equal(s.g.madness, false, 'a night shift is not madness');
  assert.equal(s.g.reserve.length, 0, 'and keeps nobody on a bench');
  assert.equal(s.g.ground, null, 'and does not pay to remember every walkable spot');
  const before = s.g.zombies.length;
  s.hold(['Space'], 6);
  assert.ok(s.g.p.ammo < 24, 'rounds should still be spent');
  assert.ok(s.g.zombies.length <= before, 'and the horde should not grow on its own');
}

{
  // Madness: free rounds.
  const s = district(true);
  s.g.p.ammo = 3;
  s.hold(['Space'], 8);
  assert.equal(s.g.p.ammo, 3, 'madness should not count rounds');
  assert.ok(s.g.bullets.length > 0 || s.g.killed > 0, 'and should still actually fire');
}

{
  // The bench exists, and arrivals come off it rather than from nowhere. Every zombie that ever
  // walks must be one of the objects the district was built with.
  const s = district(true);
  const g = s.g;
  const built = new Set(g.zombies.concat(g.reserve).map(z => z.id));
  const objects = new Set(g.zombies.concat(g.reserve));
  assert.ok(g.reserve.length > 40, `the bench should be deep (was ${g.reserve.length})`);
  assert.ok(g.ground && g.ground.length > 50, 'and there should be somewhere to arrive from');

  // How long the bench is says more about how hard the patrol is working than about where
  // arrivals come from, so this watches identities instead: whoever ends up on the bench without
  // having started there fell, and seeing one of those walk again is the whole promise of the
  // mode — nobody is created and nobody is spent. The bench is a stack, so under real pressure it
  // is the recently fallen that return rather than whoever has been waiting longest. That is
  // fine, because a body coming off it has been put back to exactly how it was built.
  const waiting = new Set(g.reserve);
  const buried = new Set();
  let recycled = 0;
  for (let n = 0; n < 180; n++) {
    s.step(.25);
    for (const z of g.reserve) if (!waiting.has(z)) buried.add(z);
    for (const z of g.zombies) if (buried.has(z)) { recycled++; buried.delete(z); }
  }
  assert.ok(g.spawned > 10, `arrivals should be steady inside a minute (spawned ${g.spawned})`);
  assert.ok(recycled > 0, 'and a body that falls should come back out as somebody new');
  for (const z of g.zombies) {
    assert.ok(built.has(z.id), 'every zombie on the street must be one the district was built with');
    assert.ok(objects.has(z), 'and must be the same object, not a copy of it');
  }
  assert.equal(g.zombies.length + g.reserve.length, objects.size,
    'nobody should be lost between the street and the bench, or exist in both');
}

{
  // Arrivals happen where nobody is looking. Something appearing in front of a courier reads as
  // a bug rather than as pressure.
  const s = district(true);
  const seen = new Set(s.g.zombies);
  let closest = Infinity;
  // Sampled often, so an arrival is caught near where it arrived rather than after it has walked.
  for (let n = 0; n < 360; n++) {
    s.step(.25);
    for (const z of s.g.zombies) {
      if (seen.has(z)) continue;
      seen.add(z);
      closest = Math.min(closest, Math.hypot(z.x - s.g.p.x, z.y - s.g.p.y));
    }
  }
  assert.ok(closest > 400,
    `an arrival should never appear near a courier (closest was ${Math.round(closest)})`);
}

{
  // It keeps up the pressure without drowning the frame, and a body that falls comes back.
  const s = district(true);
  s.step(90);
  const pressed = s.g.zombies.length;
  s.step(150);
  assert.ok(pressed >= 60, `the street should fill up within ninety seconds (reached ${pressed})`);
  assert.ok(s.g.zombies.length <= 64, `and stay inside its cap (was ${s.g.zombies.length})`);
  assert.ok(s.g.spawned > 60, `arrivals should keep coming for as long as it runs (spawned ${s.g.spawned})`);
  assert.ok(s.g.reserve.length > 0, 'and the bench should never run dry and quietly end the mode');
}

{
  // The patrol carries a different weapon in madness, and it is a different weapon rather than
  // the same one fired faster: it goes on the roof, it goes through bodies, and the belt is never
  // counted. A night shift must not have picked any of that up.
  const shift = district(false), mad = district(true);
  const shiftPatrol = shift.g.cars.filter(c => c.police);
  const madPatrol = mad.g.cars.filter(c => c.police);
  assert.ok(madPatrol.length > 0, 'madness should still put a patrol on the street');
  assert.equal(shiftPatrol.length, madPatrol.length, 'and the same number of them');
  assert.ok(shiftPatrol.every(c => !c.roofGun), 'a night shift patrol carries the service weapon');
  assert.ok(madPatrol.every(c => c.roofGun), 'a madness patrol carries the gun on the roof');

  // Every round a patrol puts up in a minute, recorded as it leaves rather than read off the
  // object afterwards: a heavy round spends its penetration on the way and would look like an
  // ordinary one by the time the run ends.
  const rounds = s => {
    const out = [], seen = new Set();
    for (let i = 0; i < 60 * 60; i++) {
      s.step(1 / 60);
      for (const b of s.g.bullets) if (b.own && !seen.has(b)) {
        seen.add(b);
        out.push({ heavy: !!b.heavy, pierce: b.pierce || 0, dmg: b.dmg, whiff: !!b.whiff });
      }
    }
    return out;
  };
  const service = rounds(shift), heavy = rounds(mad);
  assert.ok(service.length > 20 && heavy.length > 20,
    `both patrols should have fired (${service.length} service, ${heavy.length} heavy)`);
  assert.ok(heavy.length > service.length * 2,
    `a machine gun should put out far more rounds than a service pistol ` +
    `(${heavy.length} against ${service.length} in the same minute)`);
  assert.ok(heavy.every(b => b.heavy && b.pierce > 0 && b.dmg >= 2),
    'every madness round should be a heavy one that goes through what it hits');
  assert.ok(service.every(b => !b.heavy && !b.pierce && b.dmg < 1),
    'and no service round should have picked any of that up');
  // A miss out of a service weapon is a phantom, so it cannot land on a neighbour and inflate the
  // patrol's real hit rate. A burst into a crowd is the opposite case and every round is real.
  assert.ok(service.some(b => b.whiff), 'a service patrol should still miss');
  assert.ok(heavy.every(b => !b.whiff), 'while a burst puts real rounds in the air, hit or not');

  assert.ok(madPatrol.every(c => !('copAmmo' in c)), 'nothing on the car counts rounds');
}

{
  // The belt is never counted, which is what makes it a belt. A mode that quietly ran the patrol
  // dry would look identical for the first minute, so this holds one car together on purpose and
  // watches its rate of fire over four minutes rather than whether it survives them — the horde
  // wrecking the crew is a different claim, and it would hide this one.
  const s = district(true);
  const car = s.g.cars.find(c => c.police);
  const seen = new Set();
  // Rounds are counted against targets put in front of the gun on purpose, not against whatever
  // the district happens to leave nearby. An earlier version of this simply watched the car for
  // four minutes and compared the first minute with the last, which measured the street thinning
  // out around it rather than the belt — the number fell and the belt had nothing to do with it.
  const volley = seconds => {
    let fired = 0;
    for (let i = 0; i < seconds * 60; i++) {
      car.broken = false; car.zombieLoad = 0;        // The crew is not what is being measured.
      // Three of the horde, kept standing in the open beside the car for the whole sample.
      for (let k = 0; k < 3; k++) {
        const z = s.g.zombies[k];
        if (!z) break;
        s.place(z, { from: car, angle: k * .28, range: 96, hp: 40, still: false });
      }
      s.step(1 / 60);
      for (const b of s.g.bullets) if (b.own === car && !seen.has(b)) { seen.add(b); fired++; }
    }
    return fired;
  };
  const early = volley(20);
  for (let i = 0; i < 200 * 60; i++) {              // Three and a half minutes of ordinary district.
    car.broken = false; car.zombieLoad = 0;
    s.step(1 / 60);
  }
  const late = volley(20);
  assert.ok(early > 40, `a machine gun should put out real volume (${early} rounds in twenty seconds)`);
  assert.ok(late > early * .75,
    `and should be firing just as freely four minutes later (${early} then, ${late} now)`);
}

{
  // A heavy round goes through the body it hits. Set up as a queue standing in a line, because
  // that is exactly the case the gun exists for and the case a first-hit-only bullet gets wrong.
  const s = district(true);
  s.scatter();
  const line = s.g.zombies.slice(0, 4);
  assert.equal(line.length, 4, 'the district should have bodies to line up');
  // Deep enough that nobody falls and leaves a gap for the round to pass through.
  line.forEach((z, i) => s.place(z, { from: { x: 600, y: 600 }, angle: 0, range: i * 40, hp: 20 }));
  s.g.bullets.length = 0;
  s.g.bullets.push({ x: 560, y: 600, px: 560, py: 600, vx: 1050, vy: 0, l: .5,
                     own: s.g.cars[0], dmg: 2, pierce: 2, heavy: true });
  const before = line.map(z => z.hp);
  s.step(.5);
  const hurt = line.filter((z, i) => z.hp < before[i]).length;
  assert.equal(hurt, 3, `one heavy round should reach three of a queue of four (reached ${hurt})`);

  // And the same round must not strike the same body twice as it travels through it.
  assert.ok(line.every((z, i) => before[i] - z.hp <= 2),
    'a round should wound each body it passes through exactly once');
}

{
  // Two ends build the same madness district, bench included — otherwise they would disagree
  // about every arrival for the rest of the run.
  const a = district(true), b = district(true);
  assert.equal(a.world.layoutChecksum(a.g), b.world.layoutChecksum(b.g),
    'one seed and one mode should build one district');
  const plain = district(false);
  assert.notEqual(a.world.layoutChecksum(a.g), plain.world.layoutChecksum(plain.g),
    'and a madness district is not the same district as a night shift');
}

console.log('Madness verified: free rounds, arrivals off the bench, and nobody created.');
