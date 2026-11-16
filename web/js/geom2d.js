// FreeTility CAD - 2D sketch geometry: tessellation, hit tests, intersections,
// closed profile detection (planar face walk), trim and offset helpers.

export const TAU = Math.PI * 2;
const normA = (a) => { a %= TAU; return a < 0 ? a + TAU : a; };

export function entById(sk, id) { return sk.ents.find((e) => e.id === id); }
export const P = (sk, id) => sk.pts[id];

export function arcInfo(sk, e) {
  const c = P(sk, e.c), a = P(sk, e.a), b = P(sk, e.b);
  const r = Math.hypot(a.x - c.x, a.y - c.y);
  const a0 = Math.atan2(a.y - c.y, a.x - c.x);
  let a1 = Math.atan2(b.y - c.y, b.x - c.x);
  let sweep = normA(a1 - a0);
  if (sweep < 1e-9) sweep = TAU;
  return { cx: c.x, cy: c.y, r, a0, sweep };
}

export function circleInfo(sk, e) {
  if (e.t === 'circle') { const c = P(sk, e.c); return { cx: c.x, cy: c.y, r: e.r, a0: 0, sweep: TAU }; }
  return arcInfo(sk, e);
}

/** Polyline of an entity in sketch coordinates. tol = max chord deviation. */
export function tess(sk, e, tol = 0.02) {
  if (e.t === 'line') { const a = P(sk, e.a), b = P(sk, e.b); return [[a.x, a.y], [b.x, b.y]]; }
  const { cx, cy, r, a0, sweep } = circleInfo(sk, e);
  const step = r > tol ? Math.min(Math.PI / 18, 2 * Math.acos(Math.max(-1, 1 - tol / r))) : Math.PI / 4;
  const n = Math.max(e.t === 'circle' ? 24 : 4, Math.ceil(sweep / step));
  const out = [];
  const last = e.t === 'circle' ? n - 1 : n;
  for (let i = 0; i <= last; i++) {
    const t = a0 + sweep * i / n;
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  if (e.t === 'arc') {   // exact end points so loops close
    const a = P(sk, e.a), b = P(sk, e.b);
    out[0] = [a.x, a.y]; out[out.length - 1] = [b.x, b.y];
  }
  return out;
}

// ------------------------------------------------------------------ distances

export function distPtSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(px - ax - t * dx, py - ay - t * dy), t };
}

export function onArc(info, ang) {
  if (info.sweep >= TAU - 1e-9) return true;
  return normA(ang - info.a0) <= info.sweep + 1e-9;
}

/** Distance from a point to an entity. */
export function distToEnt(sk, e, px, py) {
  if (e.t === 'line') { const a = P(sk, e.a), b = P(sk, e.b); return distPtSeg(px, py, a.x, a.y, b.x, b.y).d; }
  const info = circleInfo(sk, e);
  const ang = Math.atan2(py - info.cy, px - info.cx);
  const dc = Math.hypot(px - info.cx, py - info.cy);
  if (onArc(info, ang)) return Math.abs(dc - info.r);
  const a = P(sk, e.a), b = P(sk, e.b);
  return Math.min(Math.hypot(px - a.x, py - a.y), Math.hypot(px - b.x, py - b.y));
}

/** Closest point on an entity. */
export function closestOnEnt(sk, e, px, py) {
  if (e.t === 'line') {
    const a = P(sk, e.a), b = P(sk, e.b), { t } = distPtSeg(px, py, a.x, a.y, b.x, b.y);
    return [a.x + t * (b.x - a.x), a.y + t * (b.y - a.y)];
  }
  const info = circleInfo(sk, e);
  const ang = Math.atan2(py - info.cy, px - info.cx);
  return [info.cx + info.r * Math.cos(ang), info.cy + info.r * Math.sin(ang)];
}

// ------------------------------------------------------------------ intersections

/** Intersection points between two entities (as [x,y]), restricted to their extents. */
export function intersect(sk, e1, e2) {
  const out = [];
  if (e1.t === 'line' && e2.t === 'line') {
    const a = P(sk, e1.a), b = P(sk, e1.b), c = P(sk, e2.a), d = P(sk, e2.b);
    const r = [b.x - a.x, b.y - a.y], s = [d.x - c.x, d.y - c.y];
    const den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-12) return out;
    const t = ((c.x - a.x) * s[1] - (c.y - a.y) * s[0]) / den;
    const u = ((c.x - a.x) * r[1] - (c.y - a.y) * r[0]) / den;
    if (t > -1e-9 && t < 1 + 1e-9 && u > -1e-9 && u < 1 + 1e-9) out.push([a.x + t * r[0], a.y + t * r[1]]);
    return out;
  }
  if (e1.t !== 'line' && e2.t === 'line') return intersect(sk, e2, e1);
  if (e1.t === 'line') {
    const a = P(sk, e1.a), b = P(sk, e1.b), ci = circleInfo(sk, e2);
    const dx = b.x - a.x, dy = b.y - a.y, fx = a.x - ci.cx, fy = a.y - ci.cy;
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - ci.r * ci.r;
    let disc = B * B - 4 * A * C;
    if (disc < -1e-9 * A || A < 1e-18) return out;
    disc = Math.sqrt(Math.max(0, disc));
    for (const t of disc < 1e-12 ? [-B / (2 * A)] : [(-B - disc) / (2 * A), (-B + disc) / (2 * A)]) {
      if (t < -1e-9 || t > 1 + 1e-9) continue;
      const x = a.x + t * dx, y = a.y + t * dy;
      if (onArc(ci, Math.atan2(y - ci.cy, x - ci.cx))) out.push([x, y]);
    }
    return out;
  }
  const c1 = circleInfo(sk, e1), c2 = circleInfo(sk, e2);
  const dx = c2.cx - c1.cx, dy = c2.cy - c1.cy, d = Math.hypot(dx, dy);
  if (d < 1e-12 || d > c1.r + c2.r + 1e-9 || d < Math.abs(c1.r - c2.r) - 1e-9) return out;
  const a = (c1.r * c1.r - c2.r * c2.r + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, c1.r * c1.r - a * a));
  const mx = c1.cx + a * dx / d, my = c1.cy + a * dy / d;
  const pts = h < 1e-12 ? [[mx, my]] : [[mx + h * dy / d, my - h * dx / d], [mx - h * dy / d, my + h * dx / d]];
  for (const p of pts) {
    if (onArc(c1, Math.atan2(p[1] - c1.cy, p[0] - c1.cx)) && onArc(c2, Math.atan2(p[1] - c2.cy, p[0] - c2.cx))) out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------ polygons

export function area(poly) {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export function inPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A point strictly inside a simple polygon. */
export function interiorPoint(poly) {
  let mny = Infinity, mxy = -Infinity;
  for (const p of poly) { mny = Math.min(mny, p[1]); mxy = Math.max(mxy, p[1]); }
  for (const f of [0.5, 0.37, 0.63, 0.21, 0.79, 0.11, 0.89]) {
    const y = mny + (mxy - mny) * f;
    const xs = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y)) xs.push(xi + (y - yi) * (xj - xi) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    let best = null, bw = 0;
    for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1] - xs[k] > bw) { bw = xs[k + 1] - xs[k]; best = [(xs[k] + xs[k + 1]) / 2, y]; }
    if (best && bw > 1e-9) return best;
  }
  return poly[0];
}

// ------------------------------------------------------------------ profiles

/**
 * Closed regions of a sketch. Returns { faces: [{poly, area}], open: bool }.
 * Each face is a CCW simple polygon bounded by sketch curves (construction
 * geometry ignored). Nested faces are separate; combining them with the
 * even-odd rule gives holes.
 */
export function findFaces(sk, tol = 0.02) {
  const ents = sk.ents.filter((e) => !e.cons);
  // union-find on point ids: shared ids, coincident constraints, same position
  const ids = Object.keys(sk.pts);
  const par = {};
  ids.forEach((i) => (par[i] = i));
  const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  const unite = (a, b) => { a = find(String(a)); b = find(String(b)); if (a !== b) par[a] = b; };
  for (const c of sk.cons) if (c.t === 'co') unite(c.a, c.b);
  const used = new Set();
  for (const e of ents) if (e.t !== 'circle') { used.add(String(e.a)); used.add(String(e.b)); }
  const ul = [...used];
  for (let i = 0; i < ul.length; i++) for (let j = i + 1; j < ul.length; j++) {
    const a = sk.pts[ul[i]], b = sk.pts[ul[j]];
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) unite(ul[i], ul[j]);
  }

  const faces = [];
  const edges = [];
  for (const e of ents) {
    if (e.t === 'circle') {
      const poly = tess(sk, e, tol);
      const c = sk.pts[e.c];
      faces.push({ poly, area: Math.abs(area(poly)), curves: [{ t: 'circle', c: [c.x, c.y], r: e.r }] });
      continue;
    }
    const u = find(String(e.a)), v = find(String(e.b));
    const poly = tess(sk, e, tol);
    if (u === v) continue;   // zero-length line or full-turn arc: ignore
    const A = sk.pts[e.a], B = sk.pts[e.b];
    let curve;
    if (e.t === 'line') curve = { t: 'line', a: [A.x, A.y], b: [B.x, B.y] };
    else { const C = sk.pts[e.c]; curve = { t: 'arc', c: [C.x, C.y], r: Math.hypot(A.x - C.x, A.y - C.y), a: [A.x, A.y], b: [B.x, B.y], ccw: true }; }
    edges.push({ u, v, poly, curve, alive: true });
  }

  // prune dangling edges
  let changed = true;
  let open = false;
  while (changed) {
    changed = false;
    const deg = {};
    for (const e of edges) if (e.alive) { deg[e.u] = (deg[e.u] || 0) + 1; deg[e.v] = (deg[e.v] || 0) + 1; }
    for (const e of edges) if (e.alive && (deg[e.u] === 1 || deg[e.v] === 1)) { e.alive = false; changed = true; open = true; }
  }

  // half-edge face walk
  const he = [];
  const out = {};
  for (const e of edges) {
    if (!e.alive) continue;
    const rc = e.curve.t === 'line' ? { ...e.curve, a: e.curve.b, b: e.curve.a } : { ...e.curve, a: e.curve.b, b: e.curve.a, ccw: false };
    const h0 = { from: e.u, to: e.v, poly: e.poly, curve: e.curve }, h1 = { from: e.v, to: e.u, poly: e.poly.slice().reverse(), curve: rc };
    h0.twin = h1; h1.twin = h0;
    for (const h of [h0, h1]) {
      const [p, q] = h.poly;
      h.ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
      (out[h.from] = out[h.from] || []).push(h);
      he.push(h);
    }
  }
  for (const k in out) out[k].sort((a, b) => a.ang - b.ang);
  const seen = new Set();
  for (const h0 of he) {
    if (seen.has(h0)) continue;
    const poly = [], curves = [];
    let h = h0, guard = 0;
    while (h && !seen.has(h) && guard++ < 100000) {
      seen.add(h);
      for (let i = 0; i < h.poly.length - 1; i++) poly.push(h.poly[i]);
      curves.push(h.curve);
      const lst = out[h.to];
      const i = lst.indexOf(h.twin);
      h = lst[(i - 1 + lst.length) % lst.length];
    }
    const A = area(poly);
    if (A > 1e-9) faces.push({ poly, area: A, curves });
  }
  return { faces, open };
}

/**
 * Regions for a feature. pick = list of [x,y] taps (null = everything).
 * Returns a list of { outer: poly, holes: [poly] } using only containment tests.
 */
export function pickRegions(faces, pick) {
  if (!pick || !pick.length) return null;
  const res = [];
  for (const [x, y] of pick) {
    const containing = faces.filter((f) => inPoly(f.poly, x, y)).sort((a, b) => a.area - b.area);
    if (!containing.length) continue;
    const f = containing[0];
    const inside = (g, h) => g !== h && g.area < h.area && inPoly(h.poly, ...interiorPoint(g.poly));
    const kids = faces.filter((g) => inside(g, f) && !inPoly(g.poly, x, y));
    const holes = kids.filter((g) => !kids.some((h) => inside(g, h)));
    res.push({ outer: f, holes, key: f });
  }
  return res;
}

/** Each face with its direct holes (faces nested right inside it), for display. */
export function faceRegions(faces) {
  const inside = (g, f) => g !== f && g.area < f.area && inPoly(f.poly, ...interiorPoint(g.poly));
  return faces.map((f) => {
    const kids = faces.filter((g) => inside(g, f));
    const direct = kids.filter((g) => !kids.some((h) => h !== g && inside(g, h)));
    return { key: f, outer: f.poly, holes: direct.map((g) => g.poly) };
  });
}

/**
 * Even-odd fill of all faces as solid regions: faces nested an even number of
 * levels deep are material, their direct children are holes.
 */
export function evenOddRegions(faces) {
  const inside = (g, f) => g !== f && g.area < f.area && inPoly(f.poly, ...interiorPoint(g.poly));
  const depth = faces.map((f) => faces.filter((g) => inside(f, g)).length);
  const res = [];
  faces.forEach((f, i) => {
    if (depth[i] % 2) return;
    const holes = faces.filter((g, j) => depth[j] === depth[i] + 1 && inside(g, f));
    res.push({ outer: f, holes, key: f });
  });
  return res;
}

/** Region area (outer minus holes). */
export const regionArea = (r) => Math.abs(area(r.outer.poly)) - r.holes.reduce((s, h) => s + Math.abs(area(h.poly)), 0);

// ------------------------------------------------------------------ trim

/** Parameter of a point along an entity: line t in [0,1]; arc/circle angle offset from start. */
export function paramOn(sk, e, x, y) {
  if (e.t === 'line') {
    const a = P(sk, e.a), b = P(sk, e.b), dx = b.x - a.x, dy = b.y - a.y;
    return ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1);
  }
  const ci = circleInfo(sk, e);
  return normA(Math.atan2(y - ci.cy, x - ci.cx) - ci.a0);
}

/**
 * Pieces of entity e cut by every other (non-construction or construction)
 * entity. Returns the cut parameters sorted, with the entity extent ends.
 */
export function cutParams(sk, e) {
  const ts = [];
  for (const o of sk.ents) {
    if (o === e) continue;
    for (const p of intersect(sk, e, o)) ts.push({ t: paramOn(sk, e, p[0], p[1]), p, by: o.id });
  }
  // also points of other entities that lie on e (e.g. a T junction ending on it)
  for (const o of sk.ents) {
    if (o === e || o.t === 'circle') continue;
    for (const pid of [o.a, o.b]) {
      if (pid === e.a || pid === e.b || pid === e.c) continue;
      const p = P(sk, pid);
      if (distToEnt(sk, e, p.x, p.y) < 1e-6) ts.push({ t: paramOn(sk, e, p.x, p.y), p: [p.x, p.y], by: o.id, pid });
    }
  }
  const span = e.t === 'line' ? 1 : circleInfo(sk, e).sweep;
  const inner = ts.filter((c) => c.t > 1e-7 * Math.max(1, span) && c.t < span - 1e-7 * Math.max(1, span))
    .sort((a, b) => a.t - b.t);
  const uniq = [];
  for (const c of inner) if (!uniq.length || Math.abs(c.t - uniq[uniq.length - 1].t) > 1e-7 * Math.max(1, span)) uniq.push(c);
  return { cuts: uniq, span };
}

// ------------------------------------------------------------------ offset

/** Ordered chain of connected entities (lines/arcs) containing e, following shared point ids. */
export function chainOf(sk, e) {
  if (e.t === 'circle') return { ents: [e], closed: true, dirs: [1] };
  const ends = (x) => [x.a, x.b];
  const cand = sk.ents.filter((x) => x.t !== 'circle' && !!x.cons === !!e.cons);
  const byPt = {};
  for (const x of cand) for (const p of ends(x)) (byPt[p] = byPt[p] || []).push(x);
  const chain = [e], dirs = [1];
  const used = new Set([e]);
  // forward from e.b
  let tip = e.b;
  while (true) {
    const nx = (byPt[tip] || []).filter((x) => !used.has(x));
    if ((byPt[tip] || []).length !== 2 || !nx.length) break;
    const x = nx[0];
    used.add(x); chain.push(x);
    const d = x.a === tip ? 1 : -1; dirs.push(d);
    tip = d === 1 ? x.b : x.a;
  }
  const closed = tip === e.a;
  if (!closed) {
    let tail = e.a;
    while (true) {
      const nx = (byPt[tail] || []).filter((x) => !used.has(x));
      if ((byPt[tail] || []).length !== 2 || !nx.length) break;
      const x = nx[0];
      used.add(x); chain.unshift(x);
      const d = x.b === tail ? 1 : -1; dirs.unshift(d);
      tail = d === 1 ? x.a : x.b;
    }
  }
  return { ents: chain, closed, dirs };
}

/** Line-line infinite intersection. */
export function lineX(p1, d1, p2, d2) {
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den;
  return [p1[0] + t * d1[0], p1[1] + t * d1[1]];
}
