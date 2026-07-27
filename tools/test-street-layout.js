const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROAD = 116;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const noop = () => {};

function onEdge(edge, distance) {
  const s = clamp(distance, 0, edge.len);
  let i = 1;
  while (i < edge.cum.length - 1 && edge.cum[i] < s) i++;
  const p = edge.pts[i - 1], q = edge.pts[i];
  const span = edge.cum[i] - edge.cum[i - 1] || 1;
  const t = (s - edge.cum[i - 1]) / span;
  const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1;
  return { x: p.x + dx * t, y: p.y + dy * t, tx: dx / d, ty: dy / d };
}

function nearRoad(roads, x, y) {
  let best = 1e9;
  for (const edge of roads.edges) for (let i = 1; i < edge.pts.length; i++) {
    const p = edge.pts[i - 1], q = edge.pts[i];
    const dx = q.x - p.x, dy = q.y - p.y, len2 = dx * dx + dy * dy || 1;
    const t = clamp(((x - p.x) * dx + (y - p.y) * dy) / len2, 0, 1);
    best = Math.min(best, Math.hypot(x - p.x - dx * t, y - p.y - dy * t));
  }
  return { d: best };
}

function edge(id, a, b, ax, ay, bx, by) {
  const len = Math.hypot(bx - ax, by - ay);
  return { id, a, b, pts: [{ x: ax, y: ay }, { x: bx, y: by }], cum: [0, len], len };
}

const sandbox = {
  console,
  Math,
  location: { search: '' },
  document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }) },
  window: { TownGame: {
    core: {
      W: 720, H: 540, WORLD: 2450, ROAD, CAR_L: 46, CAR_W: 22, ZR: 12, HP_MAX: 5,
      clamp, rnd: (a, b) => (a + b) / 2, pick: values => values[0],
      obb: noop, setOBB: noop, distOBB: () => 999, roundRect: noop,
      WALLS: ['#fff'], ROOFS: ['#fff'], CARCOL: ['#fff']
    },
    environment: {
      FW: 1, makeRoads: noop, onEdge, nearRoad, newWeather: noop, placeCar: noop, newCarDamage: noop
    },
    carPhysics: {
      createCarBody: noop, syncCarBody: noop, deformCarBody: noop, bodyPointLocal: noop
    }
  } }
};
sandbox.globalThis = sandbox;

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'world.js'), 'utf8');
vm.runInNewContext(source, sandbox, { filename: 'world.js' });
const { layoutCrosswalks, sidewalkPoint } = sandbox.window.TownGame.world;

// A 25-degree branch used to paint directly over the neighboring crosswalk.
const angles = [0, 25, 180, 270].map(degrees => degrees * Math.PI / 180);
const nodes = [{ i: 0, x: 0, y: 0, e: angles.map((_, i) => i) }];
const edges = angles.map((angle, i) => {
  const x = Math.cos(angle) * 420, y = Math.sin(angle) * 420;
  nodes.push({ i: i + 1, x, y, e: [i] });
  return edge(i, 0, i + 1, 0, 0, x, y);
});
const roads = { nodes, edges };
const marks = layoutCrosswalks(roads);
assert.equal(marks.length, angles.length, 'adaptive setbacks should preserve every approach when space exists');
for (let i = 0; i < marks.length; i++) for (let j = i + 1; j < marks.length; j++)
  assert.ok(Math.hypot(marks[i].x - marks[j].x, marks[i].y - marks[j].y) >= ROAD * .74,
    'crosswalk paint envelopes must not overlap');

// Near a junction, the offset from one edge can still land on another road.
const crossingRoads = {
  nodes: [
    { i: 0, x: 0, y: 0, e: [0, 1] },
    { i: 1, x: 400, y: 0, e: [0] },
    { i: 2, x: 0, y: 400, e: [1] }
  ],
  edges: [edge(0, 0, 1, 0, 0, 400, 0), edge(1, 0, 2, 0, 0, 0, 400)]
};
assert.equal(sidewalkPoint(crossingRoads, crossingRoads.edges[0], 60, 1), null,
  'a lamp candidate on another branch of asphalt must be rejected');
const safeLamp = sidewalkPoint(crossingRoads, crossingRoads.edges[0], 150, 1);
assert.ok(safeLamp, 'a clear sidewalk candidate should remain available');
const lampDistance = nearRoad(crossingRoads, safeLamp.x, safeLamp.y).d;
assert.ok(lampDistance > ROAD / 2 && lampDistance < (ROAD + 42) / 2,
  'the accepted lamp must sit inside the visible sidewalk band');

console.log('Street layout verified: lamps stay on sidewalks and crosswalks do not overlap.');
