// Deformable 2D vehicle physics: mesh, plastic deformation, and exact contacts.
window.TownGame.carPhysics = (() => {
'use strict';

const { CAR_L, CAR_W, clamp, len } = window.TownGame.core;
const X = [-CAR_L / 2, -16, -8, 0, 8, 16, CAR_L / 2];
const Y = [-CAR_W / 2, -6, 0, 6, CAR_W / 2];
const COLS = X.length, ROWS = Y.length;
const indexOf = (x, y) => y * COLS + x;
const OUTLINE = [];
for (let x = 0; x < COLS; x++) OUTLINE.push(indexOf(x, 0));
for (let y = 1; y < ROWS; y++) OUTLINE.push(indexOf(COLS - 1, y));
for (let x = COLS - 2; x >= 0; x--) OUTLINE.push(indexOf(x, ROWS - 1));
for (let y = ROWS - 2; y > 0; y--) OUTLINE.push(indexOf(0, y));

function createCarBody() {
  const nodes = [];
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++)
    nodes.push({ restX: X[x], restY: Y[y], x: X[x], y: Y[y], boundary: x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1 });

  const springs = [], neighbors = nodes.map(() => []);
  const connect = (a, b) => {
    const A = nodes[a], B = nodes[b], rest = Math.hypot(B.x - A.x, B.y - A.y);
    springs.push({ a, b, rest }); neighbors[a].push(b); neighbors[b].push(a);
  };
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const a = indexOf(x, y);
    if (x + 1 < COLS) connect(a, indexOf(x + 1, y));
    if (y + 1 < ROWS) connect(a, indexOf(x, y + 1));
    if (x + 1 < COLS && y + 1 < ROWS) connect(a, indexOf(x + 1, y + 1));
    if (x > 0 && y + 1 < ROWS) connect(a, indexOf(x - 1, y + 1));
  }
  return {
    nodes, springs, neighbors, outline: OUTLINE.slice(), cols: COLS, rows: ROWS,
    worldOutline: OUTLINE.map(() => ({ x: 0, y: 0 })),
    collider: { cx: 0, cy: 0, rad: Math.hypot(CAR_L / 2, CAR_W / 2), pts: OUTLINE.map(() => [0, 0]) },
    plasticWork: 0, maxStrain: 0, revision: 0,
    syncedRevision: -1, syncedX: NaN, syncedY: NaN, syncedHx: NaN, syncedHy: NaN
  };
}

function syncCarBody(car) {
  const body = car.body || (car.body = createCarBody());
  if (body.syncedRevision === body.revision && body.syncedX === car.x && body.syncedY === car.y &&
      body.syncedHx === car.hx && body.syncedHy === car.hy) return body;
  let radius2 = 0;
  for (let i = 0; i < body.outline.length; i++) {
    const n = body.nodes[body.outline[i]];
    const wx = car.x + car.hx * n.x - car.hy * n.y;
    const wy = car.y + car.hy * n.x + car.hx * n.y;
    const p = body.worldOutline[i]; p.x = wx; p.y = wy;
    const q = body.collider.pts[i]; q[0] = wx; q[1] = wy;
    const d2 = n.x * n.x + n.y * n.y;
    if (d2 > radius2) radius2 = d2;
  }
  body.collider.cx = car.x; body.collider.cy = car.y; body.collider.rad = Math.sqrt(radius2);
  body.syncedRevision = body.revision;
  body.syncedX = car.x; body.syncedY = car.y; body.syncedHx = car.hx; body.syncedHy = car.hy;
  return body;
}

function worldToLocal(car, x, y) {
  const dx = x - car.x, dy = y - car.y;
  return { x: dx * car.hx + dy * car.hy, y: -dx * car.hy + dy * car.hx };
}

function localToWorld(car, p) {
  return { x: car.x + car.hx * p.x - car.hy * p.y, y: car.y + car.hy * p.x + car.hx * p.y };
}

// Part positions pass through the same bilinear mesh as the body.
function bodyPointLocal(car, x, y) {
  const body = car.body || (car.body = createCarBody());
  let cx = 0, cy = 0;
  while (cx < COLS - 2 && x > X[cx + 1]) cx++;
  while (cy < ROWS - 2 && y > Y[cy + 1]) cy++;
  // Slight extrapolation is required for protruding parts such as mirrors and wheels:
  // they follow the outer cell instead of sticking to the old rectangle.
  const tx = clamp((x - X[cx]) / (X[cx + 1] - X[cx]), -.35, 1.35);
  const ty = clamp((y - Y[cy]) / (Y[cy + 1] - Y[cy]), -.35, 1.35);
  const a = body.nodes[indexOf(cx, cy)], b = body.nodes[indexOf(cx + 1, cy)];
  const c = body.nodes[indexOf(cx, cy + 1)], d = body.nodes[indexOf(cx + 1, cy + 1)];
  const topX = a.x + (b.x - a.x) * tx, topY = a.y + (b.y - a.y) * tx;
  const botX = c.x + (d.x - c.x) * tx, botY = c.y + (d.y - c.y) * tx;
  return { x: topX + (botX - topX) * ty, y: topY + (botY - topY) * ty };
}

function bodyPointWorld(car, x, y) {
  return localToWorld(car, bodyPointLocal(car, x, y));
}

function constrainMesh(body) {
  // Prevent cells from turning inside out while still allowing heavy compression.
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < ROWS; y++) for (let x = 1; x < COLS; x++) {
      const left = body.nodes[indexOf(x - 1, y)], right = body.nodes[indexOf(x, y)];
      if (right.x < left.x + .55) {
        const mid = (left.x + right.x) * .5;
        left.x = mid - .275; right.x = mid + .275;
      }
    }
    for (let x = 0; x < COLS; x++) for (let y = 1; y < ROWS; y++) {
      const top = body.nodes[indexOf(x, y - 1)], bottom = body.nodes[indexOf(x, y)];
      if (bottom.y < top.y + .5) {
        const mid = (top.y + bottom.y) * .5;
        top.y = mid - .25; bottom.y = mid + .25;
      }
    }
  }
  for (const n of body.nodes) {
    const dx = n.x - n.restX, dy = n.y - n.restY;
    const maxOffset = n.boundary ? 10.5 : 8;
    const dist = Math.hypot(dx, dy);
    if (dist > maxOffset) { n.x = n.restX + dx / dist * maxOffset; n.y = n.restY + dy / dist * maxOffset; }
    n.x = clamp(n.x, -CAR_L / 2 - 2, CAR_L / 2 + 2);
    n.y = clamp(n.y, -CAR_W / 2 - 2, CAR_W / 2 + 2);
  }
  // Limiting maximum displacement can bring adjacent nodes close again;
  // a final pass guarantees positive area for every cell.
  for (let y = 0; y < ROWS; y++) for (let x = 1; x < COLS; x++) {
    const left = body.nodes[indexOf(x - 1, y)], right = body.nodes[indexOf(x, y)];
    if (right.x < left.x + .45) right.x = left.x + .45;
  }
  for (let x = 0; x < COLS; x++) for (let y = 1; y < ROWS; y++) {
    const top = body.nodes[indexOf(x, y - 1)], bottom = body.nodes[indexOf(x, y)];
    if (bottom.y < top.y + .42) bottom.y = top.y + .42;
  }
}

// An impulse leaves plastic deformation instead of springing back.
function deformCarBody(car, contactX, contactY, nx, ny, impactSpeed) {
  const body = car.body || (car.body = createCarBody());
  const contact = worldToLocal(car, contactX, contactY);
  const localNx = nx * car.hx + ny * car.hy, localNy = -nx * car.hy + ny * car.hx;
  const stiffness = car.stiffness || 1, model = car.model || 0;
  const severity = clamp((impactSpeed - 12) / (205 * stiffness), 0, 1.5);
  const depth = .35 + severity * 8.6;
  const radius = 11 + severity * 18;
  let dxs = body.nodes.map(() => 0), dys = body.nodes.map(() => 0), weights = body.nodes.map(() => 0);

  for (let i = 0; i < body.nodes.length; i++) {
    const n = body.nodes[i], dist = Math.hypot(n.x - contact.x, n.y - contact.y);
    const w = dist >= radius ? 0 : Math.pow(1 - dist / radius, 1.55);
    if (!w) continue;
    const weakZone = model === 0 ? (n.restX > 5 ? 1.18 : .96) :
      model === 2 ? (Math.abs(n.restY) > 7 ? .88 : .74) : 1;
    const buckleScale = model === 0 ? 1.35 : model === 2 ? .62 : 1;
    const buckle = Math.sin((n.restX + n.restY * 1.7) * .72 + (car.seed || .31) * 8) * severity * 1.05 * w * buckleScale;
    dxs[i] = -localNx * depth * w * weakZone - localNy * buckle;
    dys[i] = -localNy * depth * w * weakZone + localNx * buckle;
    weights[i] = w;
  }

  // Constraints transfer part of the crush to adjacent nodes, so an impact cannot move one vertex independently of the surrounding metal.
  for (let pass = 0; pass < 3; pass++) {
    const nextX = dxs.slice(), nextY = dys.slice();
    for (let i = 0; i < body.nodes.length; i++) {
      if (!body.neighbors[i].length) continue;
      let ax = 0, ay = 0;
      for (const j of body.neighbors[i]) { ax += dxs[j]; ay += dys[j]; }
      ax /= body.neighbors[i].length; ay /= body.neighbors[i].length;
      const spread = weights[i] > 0 ? .2 : .11;
      nextX[i] = dxs[i] * (1 - spread) + ax * spread;
      nextY[i] = dys[i] * (1 - spread) + ay * spread;
    }
    dxs = nextX; dys = nextY;
  }

  let work = 0;
  for (let i = 0; i < body.nodes.length; i++) {
    body.nodes[i].x += dxs[i]; body.nodes[i].y += dys[i];
    work += Math.hypot(dxs[i], dys[i]);
  }
  constrainMesh(body);

  let maxStrain = 0;
  for (const spring of body.springs) {
    const a = body.nodes[spring.a], b = body.nodes[spring.b];
    const strain = Math.abs(Math.hypot(b.x - a.x, b.y - a.y) / spring.rest - 1);
    maxStrain = Math.max(maxStrain, strain);
  }
  body.plasticWork += work;
  body.maxStrain = Math.max(body.maxStrain, maxStrain);
  body.revision++;
  syncCarBody(car);
  return { severity, work, maxStrain, contact };
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / ((b.y - a.y) || 1e-9) + a.x) inside = !inside;
  }
  return inside;
}

function closestOnSegment(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
  const t = clamp(((px - a.x) * dx + (py - a.y) * dy) / len2, 0, 1);
  return { x: a.x + dx * t, y: a.y + dy * t, t };
}

function segmentIntersection(a, b, c, d) {
  const abx = b.x - a.x, aby = b.y - a.y, cdx = d.x - c.x, cdy = d.y - c.y;
  const den = abx * cdy - aby * cdx;
  if (Math.abs(den) < 1e-7) return null;
  const acx = c.x - a.x, acy = c.y - a.y;
  const t = (acx * cdy - acy * cdx) / den, u = (acx * aby - acy * abx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + abx * t, y: a.y + aby * t, t, u };
}

// Continuous bullet test: find the first intersection along the entire frame segment,
// preventing a fast projectile from skipping across the 22-pixel body.
function segmentCarContact(car, x0, y0, x1, y1) {
  const poly = syncCarBody(car).worldOutline;
  const from = { x: x0, y: y0 }, to = { x: x1, y: y1 };
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const hit = segmentIntersection(from, to, a, b);
    if (!hit || (best && hit.t >= best.t)) continue;
    const ex = b.x - a.x, ey = b.y - a.y, edge = len(ex, ey) || 1;
    let nx = ey / edge, ny = -ex / edge;           // Outward normal of the clockwise outline.
    if (nx * (x0 - hit.x) + ny * (y0 - hit.y) < 0) { nx = -nx; ny = -ny; }
    best = { x: hit.x, y: hit.y, nx, ny, t: hit.t, edge: i };
  }
  if (best) return best;
  if (pointInPolygon(x1, y1, poly)) {
    const hit = circleCarContact(car, x1, y1, 0);
    return hit && { ...hit, t: 1, edge: -1 };
  }
  return null;
}

function carCollisionManifold(a, b) {
  const A = syncCarBody(a).worldOutline, B = syncCarBody(b).worldOutline;
  const gapX = a.x - b.x, gapY = a.y - b.y;
  if (gapX * gapX + gapY * gapY > 62 * 62) return null;
  const contacts = [];
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) {
    const p = segmentIntersection(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length]);
    if (p && !contacts.some(q => Math.hypot(q.x - p.x, q.y - p.y) < .5)) contacts.push(p);
  }
  if (!contacts.length) {
    for (const p of A) if (pointInPolygon(p.x, p.y, B)) contacts.push({ x: p.x, y: p.y });
    for (const p of B) if (pointInPolygon(p.x, p.y, A)) contacts.push({ x: p.x, y: p.y });
  }
  if (!contacts.length) return null;
  const contact = contacts.reduce((s, p) => ({ x: s.x + p.x / contacts.length, y: s.y + p.y / contacts.length }), { x: 0, y: 0 });

  let bestEdge = null, bestDist = Infinity;
  for (let i = 0; i < A.length; i++) {
    const p = closestOnSegment(contact.x, contact.y, A[i], A[(i + 1) % A.length]);
    const dist = Math.hypot(contact.x - p.x, contact.y - p.y);
    if (dist < bestDist) { bestDist = dist; bestEdge = [A[i], A[(i + 1) % A.length]]; }
  }
  let nx, ny;
  if (bestEdge) {
    const ex = bestEdge[1].x - bestEdge[0].x, ey = bestEdge[1].y - bestEdge[0].y, len = Math.hypot(ex, ey) || 1;
    nx = ey / len; ny = -ex / len;                        // Outward normal of the clockwise outline.
  } else { nx = b.x - a.x; ny = b.y - a.y; const len = Math.hypot(nx, ny) || 1; nx /= len; ny /= len; }
  if (nx * (b.x - a.x) + ny * (b.y - a.y) < 0) { nx = -nx; ny = -ny; }

  const project = (poly, x, y) => {
    let min = Infinity, max = -Infinity;
    for (const p of poly) { const v = p.x * x + p.y * y; min = Math.min(min, v); max = Math.max(max, v); }
    return { min, max };
  };
  const pa = project(A, nx, ny), pb = project(B, nx, ny);
  const penetration = Math.max(.1, Math.min(pa.max, pb.max) - Math.max(pa.min, pb.min));
  return { x: contact.x, y: contact.y, nx, ny, penetration, points: contacts.length };
}

function circleCarContact(car, x, y, radius) {
  // Most of the horde is nowhere near any given car, so the cheap rejection runs before
  // the body is synchronized and before the outline is walked.
  const cx = x - car.x, cy = y - car.y, gap2 = cx * cx + cy * cy;
  const reach = CAR_L / 2 + radius + 14;
  if (gap2 > reach * reach) return null;
  const body = syncCarBody(car), poly = body.worldOutline;
  let nearestX = 0, nearestY = 0, best2 = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x, ey = b.y - a.y, len2 = ex * ex + ey * ey || 1;
    const t = clamp(((x - a.x) * ex + (y - a.y) * ey) / len2, 0, 1);
    const px = a.x + ex * t, py = a.y + ey * t;
    const ox = x - px, oy = y - py, d2 = ox * ox + oy * oy;
    if (d2 < best2) { best2 = d2; nearestX = px; nearestY = py; }
  }
  const best = Math.sqrt(best2);
  // A point inside the outline is always inside its bounding circle, so a distant point
  // out of contact range needs no polygon test at all.
  const rad = body.collider.rad;
  if (best >= radius && gap2 > rad * rad) return null;
  const inside = pointInPolygon(x, y, poly);
  if (!inside && best >= radius) return null;
  let nx = inside ? nearestX - x : x - nearestX;
  let ny = inside ? nearestY - y : y - nearestY;
  let d = len(nx, ny);
  if (d < 1e-5) { nx = cx; ny = cy; d = len(nx, ny) || 1; }
  nx /= d; ny /= d;
  return { x: nearestX, y: nearestY, nx, ny, penetration: inside ? radius + best : radius - best, inside };
}

function resolveCircleCar(car, object, radius) {
  const contact = circleCarContact(car, object.x, object.y, radius);
  if (!contact) return false;
  object.x += contact.nx * (contact.penetration + .35);
  object.y += contact.ny * (contact.penetration + .35);
  return true;
}

return Object.freeze({
  createCarBody, syncCarBody, deformCarBody,
  bodyPointLocal, bodyPointWorld, worldToLocal, localToWorld,
  carCollisionManifold, circleCarContact, resolveCircleCar, segmentCarContact
});
})();
