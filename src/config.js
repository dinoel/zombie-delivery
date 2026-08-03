// Every number that decides how the game feels, in one place.
//
// This file is data. It holds no logic, reads nothing, and is loaded before anything else, so any
// module may take what it needs from it without a dependency pointing the wrong way. Derived
// figures live here too when the derivation is itself a decision — `WORLD` is what the grid adds up
// to, `TURN_IN` is a fraction of the road — but a value that is merely an internal consequence of a
// setting stays with the code that consumes it.
//
// The reason each number is what it is travels with the number. Most of them were arrived at by
// measuring something, and the measurement is the only thing that makes the number changeable by
// somebody who was not there: without it, every constant looks equally arbitrary and equally
// dangerous to touch. If you change one, change the comment with it.
window.TownGame.config = (() => {
'use strict';

// ---------- the town ----------
const ROAD  = 116;                   // Asphalt width.
const GN    = 5;                     // Road nodes per side.
const GS    = 530;                   // Node spacing: wide blocks leave room to build.
const MRG   = 165;                   // Grid margin from the world edge.
const WORLD = MRG * 2 + (GN - 1) * GS;   // 2450. The district is square and this is its side.
const LANE  = 29;                    // Lane offset from the centerline.

// ---------- bodies ----------
const PR    = 12;                    // Player radius.
const ZR    = 12;                    // Zombie radius.
const CAR_L = 46, CAR_W = 22;        // Car length and width. The deformable mesh is built to fit these.

// ---------- the courier ----------
const WALK  = 166, RUN = 252;        // Walk and sprint speeds.
const SNEAK_SPEED = 68;              // Crawling. Slow enough that crossing a street is a decision.
const HP_MAX = 5;                    // Hits the courier survives inside one district.
const LIVES_MAX = 3;                 // Districts may be retried this many times per run.
const CARRY_MAX = 2;                 // Parcels the courier can carry at once.
const BATT_DRAIN = 1 / 52;           // The flashlight drains in about 52 seconds.
const STAM_DRAIN = .42, STAM_REGEN = .3;   // Sprint costs about twice what resting returns.
const PICKUP_REACH = 22;             // How close to a parcel or a doorstep counts as being there.
const REVIVE_REACH = 28, REVIVE_TIME = 3;  // Standing over a fallen partner. Three seconds is meant to hurt.

// ---------- shooting ----------
const BV    = 660;                   // Bullet speed.
const FIRE_CD = .26;                 // Delay between shots.

// ---------- the knife ----------
const TAKEDOWN_RANGE = 26;
const TAKEDOWN_ARC = 1.9;            // The courier must be well behind the shoulder line.
const TAKEDOWN_LOCK = .35;           // A short freeze: finishing inside a crowd is a bad idea.

// ---------- roofs ----------
const LADDER_REACH = 22;             // How close to the foot, or to the parapet above it, you must be.
const CLIMB_TIME = .9;               // Rooted for this long, both ways. Long enough to be a bad idea in a crowd.
const ROOF_EDGE = 9;                 // How far in from the parapet a courier is kept.
const ROOF_SIGHT = 1.7;              // How much further the fog opens from up there.

// ---------- a car with a steering wheel ----------
//
// The tail is allowed to let go. Cornering needs the tyres to supply v²/R of sideways grip, and
// when the corner asks for more than they have the rear steps out, which rotates the car further
// into the corner, which asks for more still. That runaway is what a slide is, and it is bounded
// by the ceilings below rather than by hoping the numbers stay small.
const WHEELBASE = 26;             // The wheels are drawn at ±13, so this is the real figure.
const MAX_LOCK = .62;             // About thirty-five degrees, which is a road car on full lock.
const STEER_RATE = 3.6;           // How fast the wheels themselves can be turned.
const GRIP = 430;                 // Sideways pixels per second per second the tyres hold on dry asphalt.
const SLIP_KEEP = .045;           // What is left of a slide after a second of tyres clawing it back.
const SLIP_YAW = .02;             // How hard a sliding tail rotates the car. This is the oversteer.
const SLIP_MAX = 300;             // Ceiling on sideways speed, however badly it goes.
const SPIN_MAX = 4.2;             // Nothing rotates faster than this, however badly it goes.
const SLIP_LOST = 95;             // Sideways speed at which the driver has stopped being in charge.
// The district ends at its own border. The courier is clamped to it, so is every zombie and every
// severed part; traffic was the one thing still allowed through, and a car that slid off the outer
// road simply kept going into the void. Half the diagonal keeps the whole body inside rather than
// only its centre, so a car pinned against the border never has a corner hanging over the edge.
const CAR_EDGE = Math.hypot(CAR_L, CAR_W) / 2;
const TURN_IN = ROAD * .62;       // Distance before an intersection where turning begins.

// ---------- losing it, and getting it back ----------
const LOST_SPIN = 2.6;            // Rotating faster than this and it is no longer a correction.
const LOST_SETTLE = 34;           // Slow enough to gather it up again.
const LOST_MAX = 6;               // Nobody stays out of control forever; the district has to keep moving.
const REV_SPEED = 62;             // Reversing out of a jam is a manoeuvre, not an escape.
const TURN_MAX = 6;               // An arc is 24-200 px taken at about 85 px/s. Six seconds is a jam, not a corner.

// ---------- driving one yourself ----------
const CAR_REACH = 20;             // How close to the panels you must stand to open a door.
const CAR_TOP = 1.15;             // A little brisker than traffic: taking a car should be an upgrade.
const CAR_TOP_MADNESS = 1.7;      // Madness is not a district to be crossed at the speed of traffic.
const CAR_REV = 96;               // Reverse. Faster than the AI's crawl, still clearly a manoeuvre.
const CAR_BRAKE_AT = 24;          // Below this the car has stopped, so the brake key means reverse.
// How fast a player may turn the car, in rad/s. Swept over four values against drift angle on dry
// asphalt and in the rain: 1.6 never breaks traction at all and throws the slide physics away, 2.8
// is loose enough on dry asphalt to cost speed on every corner. 2.4 is clean and predictable dry
// (2 degrees of drift off a flick) and genuinely slides in the wet (17 degrees), which is where a
// slide belongs — in the conditions rather than in the first corner.
const CAR_YAW_MAX = 2.4;
// Madness puts more on the street than a courier on foot can walk through, so a car taken there has
// to survive being driven through it. This goes in where `durability` already goes rather than
// being a shield bolted on top, so every consequence follows rules that were already balanced
// against each other: panels crumple ten times slower, the horde carries ten times before the
// bodywork gives, and the write-off speed rises by its square root.
const MADNESS_DRIVER_DURABILITY = 10;

// ---------- damage ----------
// A siege is hands working on a panel, not a body packed into the radiator at speed, and the rest
// of the zombie damage model was measured against cars that were driving. Measured with a parked
// car and the horde on it: 21 s under three, 12 s under six, and about 10 s from ten upwards — the
// last a plateau because only so many pairs of hands reach the panels at once.
const CLAW_IMPACT = 23;
// How long a wreck burns before the fuel goes. A wreck used to smoke for the rest of the district:
// half a minute of that is atmosphere, ten minutes of it is a street nobody can see across, and a
// district with a few of them ends up behind a permanent grey wall.
const WRECK_FUSE = 30;
// `g.shake` is multiplied by seven and added to the camera in pixels, and it winds down at three a
// second, so a request for fourteen is a screen jumping half its own width for the better part of
// five seconds. That is what a wreck going up asked for when its shake was written as four times a
// head's without checking what four times meant on the far end.
const SHAKE_MAX = 6;              // Six is 42 pixels and two seconds, which is already a lot.

// ---------- what the horde throws, and getting out of the way ----------
const FILTH_MIN_RANGE = 145;      // Closer than this and a thrower closes instead.
const FILTH_MAX_RANGE = 360;
const FILTH_DMG = 1;
const DODGE_TIME = .34;
const DODGE_RANGE = 430;

// ---------- the flamethrower ----------
// Short, wide and slow to kill. What it is for is not the body in front of you; it is that the
// body walks away on fire and takes the street's attention with it.
const FLAME_REACH = 155;
const FLAME_SPREAD = .42;         // Half-angle. Wide enough that aiming is barely a skill at this range.
const FLAME_DPS = 1;              // The stream itself barely hurts. It is not what kills anybody.
const FLAME_FALLOFF = .45;        // What is left of that at the tip of the stream.
const FLAME_IGNITE = 8;           // Seconds of burning added per second of contact,
const FLAME_BURN_MAX = 7;         // and the most a body can be carrying at once.
const FLAME_NOISE = 210;          // A roar, but a much quieter one than a gunshot.
const FLAME_PARTICLES = 5;        // Drawn per frame while the trigger is held, at sixty a second.
const FLAME_CAP = 190;            // Ceiling on how many of them exist at once.

// ---------- being on fire ----------
// The damage is slow on purpose: a full seven seconds of burning is worth about nine hits, so a
// walker is finished by it, a brute needs a proper soaking and a tank needs it held on more than once.
const BURN_TICK = .4;
const BURN_DAMAGE = .5;
const BURN_NOISE = 175;           // Loud enough to keep pulling the street after it.
const PANIC_SPEED = 1.5;          // Running rather than walking.
const PANIC_WANDER = 2.2;         // Radians a second the heading drifts: panic, not a withdrawal.
// How far alight something has to be before it stops caring about the courier. Bolting on the
// first spark made the weapon useless: a body was singed, fled the cone within a few frames, and
// walked back a second later barely hurt, so the stream never got to soak anybody.
const PANIC_AT = 2;

// ---------- blasts ----------
const BLAST_SHAKE = 3.5;          // What a head going off does to a screen standing on top of it.
const HEAD_BLAST_R = 190;
// A wreck going up. The inner ring takes four times the wound, which is enough to take a tank off
// its feet from the middle; a courier standing on it does not survive, and should not after half a
// minute of the car saying so. Two hits out in the rest of the ring leaves the mistake payable.
const WRECK_RADIUS = 380;
const WRECK_POWER = 4;
const WRECK_NEAR = 128;
const WRECK_CAR_R = 130;          // What it does to other traffic reaches barely past the next parking space.
const WRECK_SHAKE = 6;            // Firmly more than a head, and the most a screen is asked to take.

// ---------- cash ----------
// The horde carries what it was carrying when the district went quiet.
const CASH_DROP = Object.freeze({ runner: [2, 5], walker: [3, 8], brute: [9, 16], tank: [26, 42] });
const CASH_CHANCE = .62;          // Not every body has a wallet on it.

// ---------- patrol gunfire ----------
const COP_CD = [.42, .8];         // Cadence, not an ammunition count: the patrol never runs dry.
const COP_AGGRO = 250;            // A patrol closer than this becomes a target for the horde.
const COP_DROP = 420;             // And is forgotten past this range.
// What a patrol is holding. A night shift issues the service weapon out of a side window; madness
// bolts a heavy gun to the roof and hands the crew a belt nobody counts. Firing is one code path
// and the difference between the two is a row here rather than a branch inside it.
//
// The heavy gun is deliberately worse per round than an aimed service shot. It gets its effect
// from how many rounds there are: a burst that lands three from nine reads as a machine gun, while
// one that landed eight would read as a turret and would empty a street faster than madness can
// fill it. What it does have is weight — a round goes through the body it hits and keeps going.
const GUNS = Object.freeze({
  service: Object.freeze({
    speed: 700, dmg: .5,          // Half a hit, so a standard walker takes four.
    range: 330,                   // Anything further is hopeless from a moving car.
    pierce: 0, phantom: true,     // A miss is not a real round.
    acc: .45, sway: .1,           // Hit chance standing still, and what a car at full speed costs.
    wild: [6, 32], drift: 4,      // Pixels a miss is thrown wide by, and the wobble left on an aimed one.
    flash: .07, sparks: 3, noise: 300, roof: false, sound: 'copshot'
  }),
  heavy: Object.freeze({
    speed: 1050, dmg: 2,          // A walker in one round, a brute in two, a tank in five.
    range: 430,
    pierce: 2, phantom: false,    // Every round is real: a burst into a crowd should find somebody.
    acc: .3, sway: .12,
    wild: [10, 52], drift: 9,
    flash: .055, sparks: 6, noise: 420, roof: true, sound: 'mgshot'
  })
});
const MG_ROF = .075;              // Seconds between rounds while the trigger is held.
const MG_BURST = [5, 12];         // How many go before the gunner lets go of it,
const MG_PAUSE = [1.2, 2.4];      // and how long the barrel gets before the next burst.
const MG_SWING = 3.4;             // Radians a second the mount can traverse. It is the real limit on
                                  // the gun: it cannot snap from one body to the next, so the rounds
                                  // walk across the street and some of them land on the way.

// ---------- the horde falling out among itself ----------
const FEUD_TIME = [8, 13];        // How long a grudge lasts before the horde re-focuses on the courier.
const INFIGHT_SCALE = .3;

// ---------- being noticed ----------
const FRONT_ARC = 1.75;           // A zombie watches roughly a 200-degree arc in front of itself.
const NOTICE_RUN = 150, NOTICE_WALK = 90, NOTICE_STILL = 45, NOTICE_SNEAK = 38;
const BACK_FACTOR = .38;          // From behind everything shrinks: 57 / 34 / 17 steps.
const NOTICE_FILL = 1 / .55;      // Full awareness in just over half a second in the open.
const NOTICE_FILL_BEAM = 1 / .2;  // A beam in the face is almost instant.
const NOTICE_FADE = 1 / 2.4;      // And it cools down slowly.
const NOTICE_SNEAK_FILL = .65;    // Crawling buys time, not invisibility at close range.
const CONTACT_NOTICE_PAD = 2;     // Physical contact always defeats stealth from any direction.

// ---------- madness ----------
const MADNESS_LIVE_CAP = 64;      // What the frame can carry at once.
const MADNESS_SLOW = 1.9;         // Seconds between arrivals at the start,
const MADNESS_FAST = .3;          // and at their most relentless.
const MADNESS_RAMP = 110;         // How long it takes to get from one to the other.
const MADNESS_BURST = 2.6;        // How many arrive at once by the end.
const MADNESS_MIN_GAP = 520;      // Further from every courier than a screen is wide.

// ---------- fog of war and weather ----------
const FCELL = 14;                 // Fog cell size. The grid is WORLD/FCELL square.
const REMEMBER = .46;             // Brightness of explored but currently hidden areas.
const RAIN_Z = [.15, .55, 1];     // Three depth layers; distant drops are smaller and slower.

// ---------- how much of everything a district gets ----------
// Densities are tuned per unit of area rather than per district, so houses, trees, traffic and the
// horde survive any change to the road grid. The reference is the original 1530-pixel town.
const AREA = (WORLD / 1530) ** 2;

// ---------- street furniture ----------
// It must stay inside the narrow visible sidewalk strip, and clear of junctions: measuring from
// the nearest road rather than only offsetting from the current edge is what stops a lamp beside
// an acute junction landing on another branch of asphalt.
const SIDEWALK_CENTER = ROAD / 2 + 14;
const SIDEWALK_INNER = ROAD / 2 + 9;
const SIDEWALK_OUTER = (ROAD + 42) / 2 - 4;
const FURNITURE_NODE_CLEARANCE = ROAD * 1.15;
// A street lamp is a mast on the kerb with a bracket reaching out over the asphalt, so the pool of
// light lands on the lane rather than on the pavement behind it.
const LAMP_ARM = 38;
const LAMP_FAULTY_SHARE = .16;    // Roughly one lamp in six is failing.
const LAMP_HEAD_R = 6.5;          // The glass a bullet has to find.
const CROSSWALK_SETBACKS = [ROAD * 1.05, ROAD * 1.35, ROAD * 1.65];
const CROSSWALK_MIN_GAP = ROAD * .74;
// Fire escapes: how many houses carry one, how far the foot stands off the wall, and how far
// inside the parapet a climber comes over the edge.
const LADDER_SHARE = .28;
const LADDER_OUT = 15;
const LADDER_IN = 16;

// ---------- the madness bench ----------
// A body that falls goes back on the bench and comes out again as somebody else, so the reserve
// limits how many can be on the street at once rather than how long the mode lasts.
const MADNESS_RESERVE = 96;
const MADNESS_FIRST = 3;          // Seconds of quiet before the first arrival.

// ---------- car bodies ----------
// The three constructions differ in more than colour: light cars crumple more and accelerate
// faster, while heavy cars transfer more impulse and survive impacts.
const CAR_BUILDS = Object.freeze([
  Object.freeze({ name: 'light', mass: .78, stiffness: .76, durability: .82, speed: 1.08 }),
  Object.freeze({ name: 'standard', mass: 1, stiffness: 1, durability: 1, speed: 1 }),
  Object.freeze({ name: 'heavy', mass: 1.38, stiffness: 1.36, durability: 1.32, speed: .88 })
]);

// ---------- the horde ----------
// Base archetypes cycle so every district is guaranteed to contain all types.
const ZOMBIE_TYPES = Object.freeze([
  Object.freeze({
    id: 'walker', hp: 2, speed: [104, 132], skin: '#8fae63', clothes: '#5d6b4a', eye: '#ff5a45',
    trail: '#a8cc79', map: '#9fd36a', blood: ['#8bc83e', '#568b27', '#b1df5a'], stain: [58, 102, 28],
    shot: Object.freeze({ speed: 230, radius: 7, life: 2.2, windup: .62, cooldown: [4.5, 7.2],
      body: '#9fb43f', edge: '#d2dd72', dark: '#66772a', held: '#a8bd47', heldEdge: '#d9e982',
      trail: 'rgba(177,200,75,.45)', splash: ['#8da63a', '#b1c84b', '#62752d'], splat: [104, 126, 42], light: [.67, .8, .24] })
  }),
  Object.freeze({
    id: 'runner', hp: 1, speed: [152, 178], skin: '#d78352', clothes: '#7d4035', eye: '#ffd05a',
    trail: '#efad6f', map: '#f0a25d', blood: ['#76bd2c', '#477f20', '#a5e446'], stain: [66, 112, 25],
    shot: Object.freeze({ speed: 275, radius: 5.5, life: 1.9, windup: .48, cooldown: [5, 7.4],
      body: '#d99a35', edge: '#ffe08a', dark: '#8d5524', held: '#e6a93d', heldEdge: '#ffe6a2',
      trail: 'rgba(255,185,65,.5)', splash: ['#d98c2f', '#f2b94b', '#9b5f26'], splat: [184, 116, 39], light: [1, .55, .16] })
  }),
  Object.freeze({
    id: 'brute', hp: 4, speed: [72, 92], skin: '#7d86ae', clothes: '#4b4968', eye: '#e0a8ff',
    trail: '#a7acd0', map: '#aab2e4', blood: ['#669b32', '#3c6a22', '#8fbd48'], stain: [49, 88, 27],
    shot: Object.freeze({ speed: 185, radius: 10, life: 2.5, windup: .82, cooldown: [6, 8.4],
      body: '#8560b2', edge: '#d7b1ff', dark: '#4d3568', held: '#936ac2', heldEdge: '#e1c3ff',
      trail: 'rgba(170,112,225,.48)', splash: ['#8560b2', '#a778d7', '#5d427e'], splat: [105, 70, 138], light: [.65, .35, 1] })
  })
]);
// The tank is deliberately kept out of the cycled archetypes: it never guards a parcel and never
// appears alone. It roams in packs, soaks ten hits, throws nothing, and has no tactics at all — it
// simply walks at whatever it noticed. It is meant to be walked around.
const TANK_TYPE = Object.freeze({
  id: 'tank', hp: 10, speed: [44, 56], size: 1.7, dumb: true,
  skin: '#7a8878', clothes: '#3d4753', eye: '#ff7a2f', trail: '#93a2ae', map: '#cdd8e4',
  blood: ['#6f9c33', '#456f22', '#95c247'], stain: [56, 92, 26], shot: null
});

// ---------- palettes ----------
const WALLS = ['#e9dcc3', '#dcc8ac', '#cdd8dd', '#e7cfc1', '#dae0c6', '#d8cbd8'];
const ROOFS = ['#a4503f', '#7d4c39', '#4e6b7c', '#6c7052', '#8a5a4a', '#5a5f6e'];
const CARCOL = ['#d94f45', '#3f7fd0', '#e0b23c', '#5aa35c', '#e8e4dc', '#7a4fb0', '#3b3f46', '#d8752f'];
const BURNT_DEBRIS = ['#2b2724', '#4a423c', '#ff7a2e', '#8a7d72', '#1d1a18', '#ffc46b'];
// Courier hands in aim space: flashlight on the left, pistol on the right.
const HAND_T = { f: 13, s: -10 }, HAND_G = { f: 14, s: 8 };

// ---------- light ----------
const RGB_LAMP = [1, .84, .55], RGB_HEAD = [1, .96, .82], RGB_WARM = [1, .96, .78];
const RGB_RED = [1, .25, .2], RGB_HAZARD = [1, .56, .16], RGB_BEACON_RED = [1, .16, .18];
const RGB_BEACON_BLUE = [.24, .38, 1], RGB_ROOF_RED = [1, .2, .24], RGB_ROOF_BLUE = [.3, .42, 1];
const RGB_MUZZLE = [1, .95, .75], RGB_FILTH = [.67, .8, .24], RGB_PARCEL = [1, .82, .35];
const RGB_AMMO = [.63, .82, 1], RGB_GOAL = [.47, .94, .47], RGB_ZOMBIE = [1, .27, .2];
const RGB_CASH = [.66, .9, .69];
const RGB_FLAME = [1, .62, .22];
// Street lighting in a town like this is sodium, not daylight: the whole range sits in the yellows,
// and the coolest lamp on the block is a tired white rather than anything blue. The spread is kept
// because a street where every lamp matches looks designed instead of built.
const LAMP_TEMPERATURES = Object.freeze([
  Object.freeze({ rgb: Object.freeze([1, .52, .17]), bulb: '#ffbe62', power: 1.04 }),
  Object.freeze({ rgb: Object.freeze([1, .62, .25]), bulb: '#ffcc78', power: 1.02 }),
  Object.freeze({ rgb: Object.freeze([1, .71, .34]), bulb: '#ffd68e', power: 1 }),
  Object.freeze({ rgb: Object.freeze([1, .79, .46]), bulb: '#ffe1a6', power: .98 }),
  Object.freeze({ rgb: Object.freeze([1, .88, .62]), bulb: '#ffecc4', power: .95 })
]);
const LAMP_INTENSITY = .85;
const LAMP_POOL_R = 148;          // The lit patch itself: wide and close to even.
const LAMP_POOL_INT = 1.1;
const LAMP_POOL_REACH = 13;       // A head tilts down and a little out over the road.
const LAMP_HAZE_R = 260;          // The lift around it.
const LAMP_HAZE_INT = .2;
const SHADOW_LEN = 2400;          // Shadow wedges extend beyond the screen.
const MAX_FOLIAGE_LOBES = 8;
const AMB = [.085, .105, .21];    // Night multiplier for unlit pixels.
const ROOF_AMB = [.24, .28, .37]; // Up on a roof there is sky rather than street to be lit by.

// ---------- tracers ----------
// A round in flight is a light and not a painted surface, so it is drawn in three passes: a wide
// dim halo, a brighter core, and a hot centre line.
const TRACER = [
  { reach: 2.6, width: 5.2, warm: 'rgba(255,196,88,.17)', cold: 'rgba(150,196,255,.15)' },
  { reach: 1.5, width: 2.6, warm: 'rgba(255,224,140,.52)', cold: 'rgba(186,220,255,.46)' },
  { reach: .55, width: 1.3, warm: '#fff6d8', cold: '#eaf4ff' }
];
// Three kinds of round can be in the air, and they should not look alike, because which one is
// coming is worth knowing at a glance. The courier's is warm; a service round out of a patrol
// window is cold and thin; a heavy round off a roof mount is the same cold at twice the width with
// a longer tail behind it.
const TRACER_PASSES = [
  { own: false, heavy: false, tint: 'warm', scale: 1, stretch: 1, head: 1.7, dot: '#fffbe8' },
  { own: true, heavy: false, tint: 'cold', scale: 1, stretch: 1, head: 1.7, dot: '#f4faff' },
  { own: true, heavy: true, tint: 'cold', scale: 2.1, stretch: 1.35, head: 2.8, dot: '#ffffff' }
];

// ---------- touch controls ----------
const TORCH_BTN = { x: 58, y: 52, r: 34 };   // The flashlight target in the top-left corner.

// ---------- the wire ----------
const SNAPSHOT_HZ = 20;
const DELAY = .1;                 // Render this far behind the host, to have something to interpolate toward.
const KEEP = 16;                  // Snapshots kept for interpolation.
const SNAP_AT = 60;               // Past this the host is telling us something we cannot ease into.
const HISTORY_MAX = 240;          // Frames of local prediction kept for reconciliation.

// ---------- the static broad phase ----------
const GRID_CELL = 128;            // Uniform grid for houses, hedges, parked cars, trees and lamps.
// Resolving one obstacle nudges a body toward the next, and the query happens before any of that.
// The margin keeps objects just out of reach in the candidate list.
const QUERY_PAD = 48;

return Object.freeze({
  ROAD, GN, GS, MRG, WORLD, LANE,
  PR, ZR, CAR_L, CAR_W,
  WALK, RUN, SNEAK_SPEED, HP_MAX, LIVES_MAX, CARRY_MAX, BATT_DRAIN, STAM_DRAIN, STAM_REGEN,
  PICKUP_REACH, REVIVE_REACH, REVIVE_TIME,
  BV, FIRE_CD,
  TAKEDOWN_RANGE, TAKEDOWN_ARC, TAKEDOWN_LOCK,
  LADDER_REACH, CLIMB_TIME, ROOF_EDGE, ROOF_SIGHT,
  WHEELBASE, MAX_LOCK, STEER_RATE, GRIP, SLIP_KEEP, SLIP_YAW, SLIP_MAX, SPIN_MAX, SLIP_LOST,
  CAR_EDGE, TURN_IN,
  LOST_SPIN, LOST_SETTLE, LOST_MAX, REV_SPEED, TURN_MAX,
  CAR_REACH, CAR_TOP, CAR_TOP_MADNESS, CAR_REV, CAR_BRAKE_AT, CAR_YAW_MAX,
  MADNESS_DRIVER_DURABILITY,
  CLAW_IMPACT, WRECK_FUSE, SHAKE_MAX,
  FCELL, REMEMBER, RAIN_Z,
  FILTH_MIN_RANGE, FILTH_MAX_RANGE, FILTH_DMG, DODGE_TIME, DODGE_RANGE,
  FLAME_REACH, FLAME_SPREAD, FLAME_DPS, FLAME_FALLOFF, FLAME_IGNITE, FLAME_BURN_MAX, FLAME_NOISE,
  FLAME_PARTICLES, FLAME_CAP,
  BURN_TICK, BURN_DAMAGE, BURN_NOISE, PANIC_SPEED, PANIC_WANDER, PANIC_AT,
  BLAST_SHAKE, HEAD_BLAST_R, WRECK_RADIUS, WRECK_POWER, WRECK_NEAR, WRECK_CAR_R, WRECK_SHAKE,
  CASH_DROP, CASH_CHANCE,
  COP_CD, COP_AGGRO, COP_DROP, GUNS, MG_ROF, MG_BURST, MG_PAUSE, MG_SWING,
  FEUD_TIME, INFIGHT_SCALE,
  FRONT_ARC, NOTICE_RUN, NOTICE_WALK, NOTICE_STILL, NOTICE_SNEAK, BACK_FACTOR,
  NOTICE_FILL, NOTICE_FILL_BEAM, NOTICE_FADE, NOTICE_SNEAK_FILL, CONTACT_NOTICE_PAD,
  MADNESS_LIVE_CAP, MADNESS_SLOW, MADNESS_FAST, MADNESS_RAMP, MADNESS_BURST, MADNESS_MIN_GAP,
  AREA,
  SIDEWALK_CENTER, SIDEWALK_INNER, SIDEWALK_OUTER, FURNITURE_NODE_CLEARANCE,
  LAMP_ARM, LAMP_FAULTY_SHARE, LAMP_HEAD_R, CROSSWALK_SETBACKS, CROSSWALK_MIN_GAP,
  LADDER_SHARE, LADDER_OUT, LADDER_IN,
  MADNESS_RESERVE, MADNESS_FIRST,
  CAR_BUILDS, ZOMBIE_TYPES, TANK_TYPE,
  WALLS, ROOFS, CARCOL, BURNT_DEBRIS, HAND_T, HAND_G,
  RGB_LAMP, RGB_HEAD, RGB_WARM, RGB_RED, RGB_HAZARD, RGB_BEACON_RED, RGB_BEACON_BLUE,
  RGB_ROOF_RED, RGB_ROOF_BLUE, RGB_MUZZLE, RGB_FILTH, RGB_PARCEL, RGB_AMMO, RGB_GOAL,
  RGB_ZOMBIE, RGB_CASH, RGB_FLAME,
  LAMP_TEMPERATURES, LAMP_INTENSITY, LAMP_POOL_R, LAMP_POOL_INT, LAMP_POOL_REACH,
  LAMP_HAZE_R, LAMP_HAZE_INT, SHADOW_LEN, MAX_FOLIAGE_LOBES, AMB, ROOF_AMB,
  SNAPSHOT_HZ, DELAY, KEEP, SNAP_AT, HISTORY_MAX,
  GRID_CELL, QUERY_PAD, TRACER, TRACER_PASSES, TORCH_BTN
});
})();
