// Isolated collision tests and resolution.
window.TownGame.physics = (() => {
'use strict';

const { clamp } = window.TownGame.core;

// ---------- collisions ----------
// Circle against an oriented box: calculate in box space, then push back into world space.
function hitOBB(p, r, o) {
  if (Math.hypot(p.x - o.cx, p.y - o.cy) > r + o.rad) return false;
  const ca = Math.cos(o.ang), sa = Math.sin(o.ang);
  const dx = p.x - o.cx, dy = p.y - o.cy;
  const lx = dx * ca + dy * sa, ly = dy * ca - dx * sa;
  let ox = lx - clamp(lx, -o.hw, o.hw), oy = ly - clamp(ly, -o.hh, o.hh);
  const d = Math.hypot(ox, oy);
  if (d >= r) return false;
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
  if (Math.hypot(A.cx - B.cx, A.cy - B.cy) > A.rad + B.rad) return false;
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
  const dx = p.x - C.x, dy = p.y - C.y, d = Math.hypot(dx, dy);
  if (d >= r + C.r) return false;
  if (d < .0001) { p.x += r + C.r; return true; }
  const k = (r + C.r - d) / d; p.x += dx * k; p.y += dy * k; return true;
}

return Object.freeze({ hitOBB, obbHit, hitCircle });
})();

