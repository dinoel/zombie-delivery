// Isolated collision tests and resolution.
window.TownGame.physics = (() => {
'use strict';

const { WORLD, clamp } = window.TownGame.core;

// ---------- collisions ----------
// Circle against an oriented box: calculate in box space, then push back into world space.
function hitOBB(p, r, o) {
  const bx = p.x - o.cx, by = p.y - o.cy, reach = r + o.rad;
  if (bx * bx + by * by > reach * reach) return false;
  const ca = Math.cos(o.ang), sa = Math.sin(o.ang);
  const lx = bx * ca + by * sa, ly = by * ca - bx * sa;
  let ox = lx - clamp(lx, -o.hw, o.hw), oy = ly - clamp(ly, -o.hh, o.hh);
  const d2 = ox * ox + oy * oy;
  if (d2 >= r * r) return false;
  const d = Math.sqrt(d2);
  if (d > .0001) { const k = (r - d) / d; ox *= k; oy *= k; }
  else {                                                   // Center is inside; move it out through the nearest face.
    const dl = lx + o.hw, dr = o.hw - lx, dt = ly + o.hh, db = o.hh - ly;
    const m = Math.min(dl, dr, dt, db);
    if (m === dl) { ox = -(dl + r); oy = 0; }
    else if (m === dr) { ox = dr + r; oy = 0; }
    else if (m === dt) { ox = 0; oy = -(dt + r); }
    else { ox = 0; oy = db + r; }
  }
  p.x += ox * ca - oy * sa; p.y += ox * sa + oy * ca;
  return true;
}
// Two oriented boxes: test separating axes from the face normals of both boxes.
function obbHit(A, B) {
  const bx = A.cx - B.cx, by = A.cy - B.cy, reach = A.rad + B.rad;
  if (bx * bx + by * by > reach * reach) return false;
  for (let o = 0; o < 2; o++) {
    const O = o ? B : A, c = Math.cos(O.ang), s = Math.sin(O.ang);
    for (let k = 0; k < 2; k++) {
      const ax = k ? -s : c, ay = k ? c : s;
      let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
      for (let i = 0; i < 4; i++) {
        const pa = A.pts[i][0] * ax + A.pts[i][1] * ay, pb = B.pts[i][0] * ax + B.pts[i][1] * ay;
        if (pa < a0) a0 = pa; if (pa > a1) a1 = pa;
        if (pb < b0) b0 = pb; if (pb > b1) b1 = pb;
      }
      if (a1 < b0 || b1 < a0) return false;
    }
  }
  return true;
}

function hitCircle(p, r, C) {
  const dx = p.x - C.x, dy = p.y - C.y, reach = r + C.r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= reach * reach) return false;
  const d = Math.sqrt(d2);
  if (d < .0001) { p.x += reach; return true; }
  const k = (reach - d) / d; p.x += dx * k; p.y += dy * k; return true;
}

// ---------- static broad phase ----------
// Houses, hedges, parked cars, trees, and bushes never move once a district is built, so
// asking "what is near this point" can go through one uniform grid instead of walking the
// whole list every time. The grid only narrows the candidate set: every candidate still
// goes through the exact test above, and candidates come back in list order, so resolution
// behaves exactly as it did against the full array.
const CELL = 128;
// Resolving one obstacle nudges a body toward the next, and the query happens before any
// of that. The margin keeps objects just out of reach in the candidate list.
const QUERY_PAD = 48;

function makeGrid(items, xOf, yOf, rOf) {
  const cols = Math.max(1, Math.ceil(WORLD / CELL));
  const cells = new Array(cols * cols).fill(null);
  const cellAt = v => v < 0 ? 0 : v >= cols ? cols - 1 : v;
  for (let i = 0; i < items.length; i++) {
    const o = items[i], r = rOf(o);
    const x0 = cellAt(((xOf(o) - r) / CELL) | 0), x1 = cellAt(((xOf(o) + r) / CELL) | 0);
    const y0 = cellAt(((yOf(o) - r) / CELL) | 0), y1 = cellAt(((yOf(o) + r) / CELL) | 0);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const k = cy * cols + cx;
      (cells[k] || (cells[k] = [])).push(i);
    }
  }
  // An object spanning several cells is reported once: the stamp marks what this query
  // has already taken, and the token makes clearing the marks unnecessary.
  return { items, cols, cells, marks: new Int32Array(items.length), token: 0, found: [], scratch: [] };
}

function gridNear(grid, x, y, r, out, pad = QUERY_PAD) {
  out = out || grid.scratch;
  out.length = 0;
  const items = grid.items;
  if (!items.length) return out;
  const cols = grid.cols, cells = grid.cells, marks = grid.marks, stamp = ++grid.token;
  const found = grid.found;
  found.length = 0;
  const reach = r + pad;
  const cellAt = v => v < 0 ? 0 : v >= cols ? cols - 1 : v;
  const x0 = cellAt(((x - reach) / CELL) | 0), x1 = cellAt(((x + reach) / CELL) | 0);
  const y0 = cellAt(((y - reach) / CELL) | 0), y1 = cellAt(((y + reach) / CELL) | 0);
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
    const bucket = cells[cy * cols + cx];
    if (!bucket) continue;
    for (let b = 0; b < bucket.length; b++) {
      const i = bucket[b];
      if (marks[i] === stamp) continue;
      marks[i] = stamp;
      let j = found.length;                    // Insertion keeps list order, and lists are short.
      found.push(i);
      while (j > 0 && found[j - 1] > i) { found[j] = found[j - 1]; j--; }
      found[j] = i;
    }
  }
  for (let n = 0; n < found.length; n++) out.push(items[found[n]]);
  return out;
}

// The index is rebuilt when a district replaces its furniture, which happens between runs
// and in the QA layouts — never inside a frame.
function staticIndex(g) {
  const cached = g.staticIndex;
  if (cached && cached.solids === g.solids && cached.solidCount === g.solids.length &&
      cached.trees === g.trees && cached.treeCount === g.trees.length &&
      cached.soft === g.soft && cached.softCount === g.soft.length &&
      cached.parked === g.parked && cached.parkedCount === g.parked.length) return cached;
  const boxX = o => o.cx, boxY = o => o.cy, boxR = o => o.rad;
  const dotX = o => o.x, dotY = o => o.y, dotR = o => o.r;
  return (g.staticIndex = {
    solids: g.solids, solidCount: g.solids.length,
    trees: g.trees, treeCount: g.trees.length,
    soft: g.soft, softCount: g.soft.length,
    parked: g.parked, parkedCount: g.parked.length,
    solidGrid: makeGrid(g.solids, boxX, boxY, boxR),
    treeGrid: makeGrid(g.trees, dotX, dotY, dotR),
    softGrid: makeGrid(g.soft, dotX, dotY, dotR),
    parkedGrid: makeGrid(g.parked, boxX, boxY, boxR)
  });
}

const solidsNear = (g, x, y, r, out, pad) => gridNear(staticIndex(g).solidGrid, x, y, r, out, pad);
const treesNear = (g, x, y, r, out, pad) => gridNear(staticIndex(g).treeGrid, x, y, r, out, pad);
const softNear = (g, x, y, r, out, pad) => gridNear(staticIndex(g).softGrid, x, y, r, out, pad);
const parkedNear = (g, x, y, r, out, pad) => gridNear(staticIndex(g).parkedGrid, x, y, r, out, pad);

return Object.freeze({
  hitOBB, obbHit, hitCircle, staticIndex, solidsNear, treesNear, softNear, parkedNear
});
})();
