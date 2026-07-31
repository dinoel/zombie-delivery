// How a change feels over a whole district, rather than in the one frame a test looks at.
//
// Every weapon and every hazard added to madness has needed the same measurement — how full the
// street stays, how fast it fills, how much of it something is taking out — and every one of them
// was wrong the first time. The patrol gun re-pointed the whole horde at the car four times a
// second and had the crew pulled apart in half a minute. A wreck going up disabled every vehicle
// inside four hundred pixels and turned the road network into a scrapyard by the third minute.
// The flamethrower panicked bodies on the first spark, so the stream never soaked anybody and it
// was a worse shotgun. None of those were visible in a unit test; all three were obvious in a
// two-minute run with a column of numbers beside it.
//
// The script for that was written from scratch three times and thrown away three times. It lives
// here now. Run it directly for the madness comparison it ships with, or require `measure` and
// hand it a `drive` for something else.
//
//   node tools/balance.js
//
'use strict';

const { scene } = require('./scene.js');

const DEFAULT_COLUMNS = Object.freeze({
  live: s => s.g.zombies.length,
  arrived: s => s.g.spawned || 0,
  killed: s => s.g.killed,
  bench: s => (s.g.reserve || []).length
});

/**
 * Run a district and sample it as it goes.
 *
 * measure({
 *   label,                  what this run is
 *   seconds, every,         how long, and how often to write a row
 *   madness, level, seed,   the district
 *   drive(s, frame),        called before each frame: hold keys, aim, whatever the run is about
 *   columns                 { name: s => value }, merged over the default four
 * })
 *
 * The courier is held upright throughout. A run is about the district, and a courier who died in
 * the first minute measures nothing after it — in madness they also freeze the spawner on the way
 * down, so the numbers stop meaning anything at all.
 */
function measure(options = {}) {
  const {
    label = 'run', seconds = 150, every = 30,
    madness = true, level = 2, seed = 0x51ed5eed,
    drive = null, columns = null
  } = options;

  const s = scene({ madness, level, seed });
  s.immortal();
  const read = Object.assign({}, DEFAULT_COLUMNS, columns);
  const rows = [];
  const frames = Math.round(seconds * 60);
  const sampleEvery = Math.round(every * 60);

  for (let frame = 0; frame < frames; frame++) {
    if (drive) drive(s, frame);
    if (frame % sampleEvery === 0) {
      const row = { at: Math.round(frame / 60) };
      for (const name of Object.keys(read)) row[name] = read[name](s);
      rows.push(row);
    }
    s.step(1 / 60);
  }
  return { label, rows, scene: s };
}

// A column of numbers, wide enough to read and no wider.
function report(runs) {
  for (const run of Array.isArray(runs) ? runs : [runs]) {
    console.log(`\n${run.label}`);
    const names = Object.keys(run.rows[0]).filter(n => n !== 'at');
    const width = {};
    for (const n of names) width[n] = Math.max(n.length, ...run.rows.map(r => String(r[n]).length));
    console.log('   ' + '    '.slice(0, 4) + names.map(n => n.padStart(width[n])).join('  '));
    for (const r of run.rows)
      console.log(`  ${String(r.at).padStart(3)}s ` +
        names.map(n => String(r[n]).padStart(width[n])).join('  '));
  }
}

// Aim at whoever is nearest. Short-range weapons are used this way, and a courier spinning on the
// spot measures the sweep rather than the weapon.
function aimAtNearest(s) {
  const p = s.g.p;
  let best = null, bd = Infinity;
  for (const z of s.g.zombies) {
    if (z.gone) continue;
    const d = Math.hypot(z.x - p.x, z.y - p.y);
    if (d < bd) { bd = d; best = z; }
  }
  if (best) p.ang = Math.atan2(best.y - p.y, best.x - p.x);
}

// What ships with it: madness as it stands, against madness with each weapon held down. The
// control matters more than either of the others — the question is never "does this kill things"
// but "does it kill them faster than the district can replace them".
function madnessComparison() {
  const burning = { burning: s => s.g.zombies.filter(z => z.burn > 0).length };
  return [
    measure({
      label: 'control: madness, courier idle',
      drive: s => s.keys(null)
    }),
    measure({
      label: 'pistol held down',
      drive: s => { s.g.p.weapon = 0; s.keys(['Space']); aimAtNearest(s); }
    }),
    measure({
      label: 'flamethrower held down',
      columns: burning,
      drive: s => { s.g.p.weapon = 1; s.keys(['Space']); aimAtNearest(s); }
    })
  ];
}

if (require.main === module) {
  report(madnessComparison());
  console.log('\nThe street caps at 64. A weapon that keeps it well below that for the whole run ' +
    'is out-clearing the spawner,\nwhich is the failure this exists to catch.');
}

module.exports = { measure, report, aimAtNearest, DEFAULT_COLUMNS };
