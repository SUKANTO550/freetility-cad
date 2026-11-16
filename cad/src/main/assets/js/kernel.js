// FreeTility CAD - geometry kernel adapter (Manifold, mesh based).
// FreeTility CAD PRO ships a different kernel.js (OpenCascade) with the same exports.
// All handles are opaque; call free() on anything you no longer need.

import Module from '../lib/manifold.js';
import { basis, mmul, translate, rotAxis, reflect, toWorld } from './mat.js';

export const KERNEL = {
  name: 'Manifold',
  license: 'Manifold (Apache 2.0)',
  pro: false,
  can: { fillet: false, chamfer: false, shell: false, hole: false, step: false },
};

let M = null;
let segs = 64;
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export async function init() {
  if (M) return;
  const url = new URL('../lib/manifold.wasm', import.meta.url).href;
  const bin = await (await fetch(url)).arrayBuffer();
  M = await Module({ wasmBinary: bin, locateFile: () => url });
  M.setup();
}

export function setQuality(q) { segs = q === 'low' ? 36 : q === 'high' ? 128 : 64; }

const signedArea = (poly) => { let s = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };

/** Union of regions ({outer, holes} faces with .poly), mapped by fn. */
function section(regions, fn) {
  let acc = null;
  const pts = (f) => {
    let p = fn ? f.poly.map(fn) : f.poly;
    if (signedArea(p) < 0) p = p.slice().reverse();
    return p;
  };
  for (const r of regions) {
    let cs = new M.CrossSection([pts(r.outer)], 'Positive');
    if (r.holes.length) {
      const h = new M.CrossSection(r.holes.map(pts), 'Positive');
      const d = cs.subtract(h); cs.delete(); h.delete(); cs = d;
    }
    if (!acc) acc = cs; else { const u = acc.add(cs); acc.delete(); cs.delete(); acc = u; }
  }
  return acc;
}

/** Extrude regions of a sketch plane from z0 to z0+h along its normal. */
export function extrudeRegions(regions, pl, z0, h) {
  const cs = section(regions);
  try {
    const s = cs.extrude(h);
    const t = s.transform(mmul(basis(pl.x, pl.y, pl.n, pl.o), translate([0, 0, z0])));
    s.delete();
    return t;
  } finally { cs.delete(); }
}

/** Revolve regions around a sketch line (A point, d direction, e = side of the profile). */
export function revolveRegions(regions, pl, ax, startDeg, deg) {
  const { A, d, e } = ax;
  const cs = section(regions, (p) => [(p[0] - A[0]) * e[0] + (p[1] - A[1]) * e[1], (p[0] - A[0]) * d[0] + (p[1] - A[1]) * d[1]]);
  try {
    const E = [pl.x[0] * e[0] + pl.y[0] * e[1], pl.x[1] * e[0] + pl.y[1] * e[1], pl.x[2] * e[0] + pl.y[2] * e[1]];
    const Dv = [pl.x[0] * d[0] + pl.y[0] * d[1], pl.x[1] * d[0] + pl.y[1] * d[1], pl.x[2] * d[0] + pl.y[2] * d[1]];
    const Y = [Dv[1] * E[2] - Dv[2] * E[1], Dv[2] * E[0] - Dv[0] * E[2], Dv[0] * E[1] - Dv[1] * E[0]];
    let m = basis(E, Y, Dv, toWorld(pl, A[0], A[1]));
    if (startDeg) m = mmul(m, rotAxis([0, 0, 1], startDeg * Math.PI / 180));
    const s = cs.revolve(segs, deg);
    const t = s.transform(m); s.delete();
    return t;
  } finally { cs.delete(); }
}

export function union(a, b) { return a.add(b); }
export function subtract(a, b) { return a.subtract(b); }
/** Always returns a new handle. */
export function unionAll(list) { return list.length === 1 ? list[0].transform(IDENT) : M.Manifold.union(list); }
export function transform(s, m4) { return s.transform(m4); }
export function mirror(s, o, n) { return s.transform(reflect(o, n)); }
export function isEmpty(s) { return !s || s.isEmpty(); }
export function volume(s) { return s ? s.volume() : 0; }
export function area(s) { return s ? s.surfaceArea() : 0; }
export function bbox(s) { const b = s.boundingBox(); return { min: b.min, max: b.max }; }

/** Triangle mesh: positions (xyz per vertex) and triangle indices. */
export function mesh(s) {
  const m = s.getMesh();
  const np = m.numProp, vp = m.vertProperties, nv = vp.length / np;
  const pos = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) { pos[i * 3] = vp[i * np]; pos[i * 3 + 1] = vp[i * np + 1]; pos[i * 3 + 2] = vp[i * np + 2]; }
  return { pos, idx: Uint32Array.from(m.triVerts) };
}

export function free(h) { if (h && h.delete) try { h.delete(); } catch (e) { /* already freed */ } }
