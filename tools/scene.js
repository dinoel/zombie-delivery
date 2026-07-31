// A district you can drive, with the traps already sprung.
//
// `browser-sandbox.js` hands back loaded subsystems. What every test then wanted was one step
// further on — a district with a courier in it who can be made to walk, shoot and survive — and
// each of them built that for itself. Eight times in one sitting the rig broke in a way that
// looked like a result: a courier held invulnerable painted the whole canvas red and the pixels
// being read were the harness; the horde moved out of the way was moved to one point and set
// about killing itself; input poked straight into the record was gone by the time the rules read
// it. None of those were bugs in the game.
//
// So the knowledge is written down once, here, with the reason attached to each piece. A test
// that uses this cannot make those mistakes, and a test that needs something this does not do
// should add it here rather than beside itself.
'use strict';

const { load } = require('./browser-sandbox.js');

// Everything a rule can reach. `net` is left out by default because two thirds of the suite has
// no wire in it, and loading it drags in a socket the tests then have to ignore.
const RULES = ['core', 'quality', 'audio', 'car-physics', 'environment',
  'world', 'physics', 'input', 'gameplay'];
const WIRED = RULES.concat('net');

// Keys the harness knows how to let go of. Anything held between one step and the next would
// leak into whatever the next block is asking about.
const DRIVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'Space', 'KeyK',
  'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Numpad0', 'Numpad1', 'ControlRight'];

// The damage vignette is painted over the entire frame once `inv` passes this, so a courier held
// invulnerable above it turns every pixel red. Anything reading the canvas would be reading the
// harness. See `src/render.js`, the damage vignette.
const VIGNETTE_AT = 1.2;

/**
 * A district, and the handful of verbs worth having on one.
 *
 * scene({ madness, level, couriers, seed, search, wired })
 */
function scene(options = {}) {
  const {
    madness = false, level = 2, couriers = 1,
    seed = 0x51ed5eed, search = undefined, wired = false
  } = options;

  const env = load({ modules: wired ? WIRED : RULES, seed, search });
  const world = env.TownGame.world;
  const gameplay = env.TownGame.gameplay;
  const g = world.buildTown(level, couriers, madness);
  const rt = env.TownGame.core.runtime;
  rt.game = g; rt.state = 'play';
  // The opening seconds deliberately ignore everything, which is almost never what a test is
  // asking about. Anything that does care can put it back.
  g.spawnGrace = 0;

  let alive = false;

  // Keep the courier upright without painting the screen. A courier standing still in madness is
  // dead inside a minute, and a dead one freezes the spawner — so a test about arrivals that did
  // not do this would be measuring its own death. `inv` is held just under the vignette rather
  // than at some comfortable large number, for the reason on VIGNETTE_AT.
  const immortal = (on = true) => { alive = on; };

  const keepAlive = () => {
    if (!alive) return;
    for (const p of g.players) {
      p.hp = p.hpMax; p.down = false;
      p.inv = Math.min(p.inv, VIGNETTE_AT - .2);
    }
    g.dead = false;
  };

  // Input goes through the key map, never into `p.in`: the record is rebuilt from the devices at
  // the top of every frame, so anything written onto it directly is overwritten before a rule
  // sees it. This is also the path the game itself uses.
  const keys = held => {
    for (const code of DRIVE_KEYS) rt.keys[code] = 0;
    if (Array.isArray(held)) for (const code of held) rt.keys[code] = 1;
    else if (held) for (const code of Object.keys(held)) rt.keys[code] = held[code] ? 1 : 0;
  };

  // One press and release through the real handler in input.js, which is where a toggle becomes
  // a counter. Poking the counter instead would skip the half of the path most worth covering.
  const tap = code => { env.key(true, code); env.key(false, code); };

  const step = (seconds, dt = 1 / 60) => {
    for (let i = 0, n = Math.round(seconds / dt); i < n; i++) {
      keepAlive();
      gameplay.update(g, dt);
    }
  };

  // Run with something held down, and let go afterwards. Almost every test that drives the
  // courier wants exactly this and nothing else.
  const hold = (held, seconds, dt = 1 / 60) => {
    keys(held);
    step(seconds, dt);
    keys(null);
  };

  // The same, on a peer that is only watching. Useful for pinning that a rule did not run.
  const present = (seconds, dt = 1 / 60) => {
    for (let i = 0, n = Math.round(seconds / dt); i < n; i++) gameplay.presentFrame(g, dt);
  };

  // Move the horde out of the way. Spread out, not stacked: piled on one point they touch each
  // other, start grudges and set about killing themselves, which is a perfectly good rule getting
  // in the way of a question about something else.
  const scatter = (x = -4000, y = -4000, gap = 90) => {
    g.zombies.forEach((z, i) => {
      z.x = x - (i % 20) * gap;
      z.y = y - Math.floor(i / 20) * gap;
      z.gone = false; z.burn = 0; z.rival = null; z.foeCar = null;
      z.hunt = 0; z.alert = 0; z.notice = 0;
    });
  };

  // A body put where a test wants it, by bearing and range from the courier.
  //
  // `still` is the default and it matters: a question about the shape of something — a cone, a
  // blast, a firing arc — is not a question about where the horde walked while it was being
  // asked, and a body that closed to arm's length would be caught by a contact rule rather than
  // by the thing under test.
  const place = (which, at = {}) => {
    const { angle = 0, range = 90, hp, still = true, from = g.p } = at;
    const z = typeof which === 'number' ? g.zombies[which] : which;
    if (!z) throw new Error(`no zombie to place: ${which}`);
    z.x = from.x + Math.cos(angle) * range;
    z.y = from.y + Math.sin(angle) * range;
    z.gone = false; z.burn = 0; z.rival = null; z.foeCar = null;
    z.guardParcel = -1;
    if (hp !== undefined) { z.hp = hp; z.maxHp = hp; }
    if (still) z.spd = 0;
    return z;
  };

  // Where the courier stands and which way they are looking. With no mouse in a sandbox the aim
  // follows the heading, so this is also how a test aims — and standing still is what holds it,
  // because the heading turns with the walking.
  const courierAt = (x, y, facing, p = g.p) => {
    p.x = x; p.y = y;
    p.vx = p.vy = p.kx = p.ky = 0;
    if (facing !== undefined) { p.ang = facing; p.aim = facing; }
    return p;
  };

  // A district with nothing in it but what a test puts there.
  const quiet = () => {
    g.zombies.length = 0;
    g.cars.length = 0;
    g.ammoBoxes.length = 0;
    g.bullets.length = 0;
    g.zombieShots.length = 0;
    for (const b of g.parcels) b.state = 'done';
    g.delivered = 0;
  };

  return {
    env, g, rt, world, gameplay,
    step, hold, present, keys, tap, immortal,
    scatter, place, courierAt, quiet,
    a: g.players[0], b: g.players[1]
  };
}

module.exports = { scene, RULES, WIRED, VIGNETTE_AT };
