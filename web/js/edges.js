// FreeTility CAD - model edges for sketching: snap targets, live links and
// Convert Entities. Edge records (world coordinates):
//   { pts: Float32Array (polyline xyz), a, b (ends), mid, dir, kind: 'line'|'circle'|'curve', circ?: {c, r, n}, closed }
// FreeTility CAD PRO gets exact edges from OpenCascade; FreeTility CAD finds
// sharp edges in the triangle mesh (straight edges exact, curves as polylines).

import { v3 } from './mat.js';

const cache = new WeakMap();

/** Edge records for a kernel mesh (cached per mesh object). */
export function edgesOf(m) {
  if (!m) return [];
  let e = cache.get(m);
  if (e) return e;
  e = m.edges ? fromKernel(m.edges) : fromMesh(m);
  cache.set(m, e);
  return e;
}

function rec(pts, kind, extra = {}) {
  const n = pts.length / 3;
  const a = [pts[0], pts[1], pts[2]], b = [pts[n * 3 - 3], pts[n * 3 - 2], pts[n * 3 - 1]];
  let mid = extra.mid;
  if (!mid) {   // arc-length midpoint
    let L = 0;
    for (let i = 1; i < n; i++) L += Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]);
    let acc = 0; mid = a;
    for (let i = 1; i < n; i++) {
      const s = Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]);
      if (acc + s >= L / 2) { const t = s ? (L / 2 - acc) / s : 0; mid = [0, 1, 2].map((k) => pts[i * 3 - 3 + k] + t * (pts[i * 3 + k] - pts[i * 3 - 3 + k])); break; }
      acc += s;
    }
  }
  const dir = extra.dir || v3.norm(v3.sub(b, a));
  return { pts, a, b, mid, dir, kind, ...extra };
}

function fromKernel(list) {
  return list.map((e) => rec(e.pts, e.kind || 'curve', { mid: e.mid, dir: e.dir, circ: e.circ, closed: !!e.closed }));
}

/** Sharp edges of a triangle mesh, chained into polylines and split at corners. */
function fromMesh(m) {
  const { pos, idx } = m;
  const nt = idx.length / 3;
  // merge coincident vertices
  const key = (v) => Math.round(pos[v * 3] * 1e4) + ',' + Math.round(pos[v * 3 + 1] * 1e4) + ',' + Math.round(pos[v * 3 + 2] * 1e4);
  const canon = new Map(), vk = new Int32Array(pos.length / 3), P = [];
  for (let v = 0; v < vk.length; v++) {
    const k = key(v);
    let c = canon.get(k);
    if (c === undefined) { c = P.length; canon.set(k, c); P.push([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]); }
    vk[v] = c;
  }
  const fn = [];
  for (let t = 0; t < nt; t++) {
    const A = P[vk[idx[t * 3]]], B = P[vk[idx[t * 3 + 1]]], C = P[vk[idx[t * 3 + 2]]];
    fn.push(v3.norm(v3.cross(v3.sub(B, A), v3.sub(C, A))));
  }
  const em = new Map();
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const a = vk[idx[t * 3 + k]], b = vk[idx[t * 3 + (k + 1) % 3]];
    if (a === b) continue;
    const kk = a < b ? a + '_' + b : b + '_' + a;
    let l = em.get(kk); if (!l) em.set(kk, l = { a: Math.min(a, b), b: Math.max(a, b), t: [] }); l.t.push(t);
  }
  const cosSharp = Math.cos(20 * Math.PI / 180);
  const adj = new Map();
  const segs = [];
  for (const e of em.values()) {
    const sharp = e.t.length !== 2 || v3.dot(fn[e.t[0]], fn[e.t[1]]) < cosSharp;
    if (!sharp) continue;
    const s = { a: e.a, b: e.b, used: false };
    segs.push(s);
    for (const v of [e.a, e.b]) { let l = adj.get(v); if (!l) adj.set(v, l = []); l.push(s); }
  }
  // walk chains; continue through a vertex only if it joins exactly two segments with a gentle turn
  const cosTurn = Math.cos(16 * Math.PI / 180);
  const smooth = (v, s1, s2) => {
    const o1 = s1.a === v ? s1.b : s1.a, o2 = s2.a === v ? s2.b : s2.a;
    const d1 = v3.norm(v3.sub(P[v], P[o1])), d2 = v3.norm(v3.sub(P[o2], P[v]));
    return v3.dot(d1, d2) > cosTurn;
  };
  const chains = [];
  const walk = (s0, from) => {
    const chain = [from];
    let s = s0, v = from;
    while (s && !s.used) {
      s.used = true;
      const nv = s.a === v ? s.b : s.a;
      chain.push(nv);
      const l = adj.get(nv);
      if (!l || l.length !== 2) break;
      const next = l[0] === s ? l[1] : l[0];
      if (next.used || !smooth(nv, s, next)) break;
      s = next; v = nv;
    }
    return chain;
  };
  // start at ends / corners first, then whatever is left (closed loops)
  for (const [v, l] of adj) {
    if (l.length === 2 && smooth(v, l[0], l[1])) continue;
    for (const s of l) if (!s.used) chains.push(walk(s, v));
  }
  for (const s of segs) if (!s.used) chains.push(walk(s, s.a));

  const out = [];
  for (const ch of chains) {
    const pts = new Float32Array(ch.length * 3);
    ch.forEach((v, i) => pts.set(P[v], i * 3));
    const a = P[ch[0]], b = P[ch[ch.length - 1]];
    const L = v3.len(v3.sub(b, a));
    let straight = L > 1e-9;
    if (straight) {
      const d = v3.norm(v3.sub(b, a));
      for (const v of ch) { const w = v3.sub(P[v], a); const off = v3.len(v3.sub(w, v3.mul(d, v3.dot(w, d)))); if (off > 1e-4 * L + 1e-5) { straight = false; break; } }
    }
    if (straight) out.push(rec(new Float32Array([...a, ...b]), 'line'));
    else out.push(rec(pts, 'curve', { closed: ch[0] === ch[ch.length - 1] }));
  }
  return out;
}

// ------------------------------------------------------------------ geometry helpers

export function distToPoly(p, pts) {
  const n = pts.length / 3;
  if (n === 1) return Math.hypot(p[0] - pts[0], p[1] - pts[1], p[2] - pts[2]);
  let best = Infinity;
  for (let i = 0; i + 1 < n; i++) {
    const a = [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]], b = [pts[i * 3 + 3], pts[i * 3 + 4], pts[i * 3 + 5]];
    const d = v3.sub(b, a), l2 = v3.dot(d, d) || 1;
    const t = Math.max(0, Math.min(1, v3.dot(v3.sub(p, a), d) / l2));
    best = Math.min(best, v3.len(v3.sub(p, v3.add(a, v3.mul(d, t)))));
  }
  return best;
}

/** Sketch (u, v) of a world point, and its distance off the plane. */
export function toSketch(pl, p) {
  const d = v3.sub(p, pl.o);
  return { u: v3.dot(d, pl.x), v: v3.dot(d, pl.y), off: v3.dot(d, pl.n) };
}

/** Edges lying in a sketch plane (within tol). */
export function inPlane(edges, pl, tol = 1e-3) {
  return edges.filter((e) => {
    const n = e.pts.length / 3;
    for (let i = 0; i < n; i++) if (Math.abs(v3.dot(v3.sub([e.pts[i * 3], e.pts[i * 3 + 1], e.pts[i * 3 + 2]], pl.o), pl.n)) > tol) return false;
    return true;
  });
}

/** Edge matching a stored reference {p (a point on it, its midpoint), d (direction)}. */
export function matchEdge(edges, ref, tol) {
  let best = null, bs = Infinity;
  for (const e of edges) {
    const d = distToPoly(ref.p, e.pts);
    if (d > tol) continue;
    const align = ref.d && e.kind === 'line' ? Math.abs(v3.dot(ref.d, e.dir)) : 1;
    const sc = d + (1 - align) * tol * 2;
    if (sc < bs) { bs = sc; best = e; }
  }
  return best;
}

/** World point a link refers to: 'v' end nearest `at`, 'm' midpoint, 'c' circle centre. */
export function targetOf(e, k, at) {
  if (k === 'm') return e.mid;
  if (k === 'c') return e.circ ? e.circ.c : null;
  if (!at) return e.a;
  return v3.len(v3.sub(e.a, at)) <= v3.len(v3.sub(e.b, at)) ? e.a : e.b;
}

export const edgeRef = (e) => ({ p: e.mid.map(r4), d: e.dir.map(r4) });
const r4 = (v) => Math.round(v * 1e4) / 1e4;

export function sizeOf(edges) {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const e of edges) for (const p of [e.a, e.b]) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
  return Number.isFinite(mn[0]) ? Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) : 100;
}

/**
 * Re-link a sketch's model references against new edges. Updates the stored
 * targets (con.x/y, line or circle data) and self-heals the references.
 * Returns { changed, broken }.
 */
export function relink(sk, edges) {
  const pl = sk.plane;
  const tol = Math.max(0.05, sizeOf(edges) * 0.01);
  let changed = false, broken = 0;
  for (const c of sk.cons) {
    if (c.t !== 'ext' && c.t !== 'exton' && c.t !== 'extr') continue;
    const e = edges.length ? matchEdge(edges, c.ref.e, tol) : null;
    if (!e) { if (!c.broken) changed = true; c.broken = true; broken++; continue; }
    if (c.broken) changed = true;
    delete c.broken;
    c.ref.e = edgeRef(e);
    if (c.t === 'ext') {
      const P = targetOf(e, c.ref.k, c.ref.at);
      if (!P) { c.broken = true; broken++; continue; }
      c.ref.at = P.map(r4);
      const s = toSketch(pl, P);
      if (Math.abs(s.u - c.x) > 1e-7 || Math.abs(s.v - c.y) > 1e-7) { c.x = s.u; c.y = s.v; changed = true; }
    } else if (c.t === 'exton') {
      if (e.kind === 'circle' && e.circ) {
        const s = toSketch(pl, e.circ.c);
        const nc = { cx: s.u, cy: s.v, r: e.circ.r };
        if (!c.circ || Math.abs(nc.cx - c.circ.cx) + Math.abs(nc.cy - c.circ.cy) + Math.abs(nc.r - c.circ.r) > 1e-7) changed = true;
        c.circ = nc; delete c.line;
      } else {
        const A = toSketch(pl, e.a), B = toSketch(pl, e.b);
        const nl = [A.u, A.v, B.u, B.v];
        if (!c.line || nl.some((v, i) => Math.abs(v - c.line[i]) > 1e-7)) changed = true;
        c.line = nl; delete c.circ;
      }
    } else if (c.t === 'extr') {
      if (!e.circ) { c.broken = true; broken++; continue; }
      if (Math.abs(e.circ.r - c.r) > 1e-7) { c.r = e.circ.r; changed = true; }
    }
  }
  return { changed, broken };
}
