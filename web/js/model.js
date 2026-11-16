// FreeTility CAD - document model and feature rebuild.
// A document is a list of features. Sketches hold 2D geometry on a plane;
// extrude / revolve turn sketch regions into tool solids that are added to or
// cut from the body; patterns and mirrors repeat earlier features. CAD PRO adds
// fillet, chamfer, shell, hole and STEP import (kernel.js decides what exists).

import * as K from './kernel.js';
import { findFaces, pickRegions, evenOddRegions, regionArea } from './geom2d.js';
import { v3, basis, mmul, translate, rotAxis, reflect, toWorld } from './mat.js';
import { edgesOf, relink } from './edges.js';
import * as S from './solver.js';

export { v3, basis, mmul, translate, rotAxis, reflect, toWorld };

export const PLANES = {
  front: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] },
  top: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 0, -1], n: [0, 1, 0] },
  right: { o: [0, 0, 0], x: [0, 0, -1], y: [0, 1, 0], n: [1, 0, 0] },
};
export const PLANE_NAMES = { front: 'Front Plane', top: 'Top Plane', right: 'Right Plane' };

export const TYPE_LABEL = {
  sketch: 'Sketch', lpattern: 'LPattern', cpattern: 'CirPattern', mirror: 'Mirror',
  fillet: 'Fillet', chamfer: 'Chamfer', shell: 'Shell', hole: 'Hole', import: 'Imported',
};
/** Feature types that need the CAD PRO kernel. */
export const PRO_TYPES = ['fillet', 'chamfer', 'shell', 'hole', 'import'];
export const usesPro = (doc) => doc.features.some((f) => PRO_TYPES.includes(f.type) && !f.sup);

export function newDoc(app) {
  return { format: 'ftcad', version: 1, app, units: 'mm', nid: 1, features: [], created: Date.now() };
}

export function newSketch(plane, ref) {
  return {
    plane: JSON.parse(JSON.stringify(plane)), ref,
    pts: { 0: { x: 0, y: 0, origin: true } }, ents: [], cons: [], nid: 1,
  };
}

/** Name such as "Boss-Extrude3": next free number for that label. */
export function nextName(doc, label) {
  let n = 1;
  const re = new RegExp('^' + label.replace(/[-]/g, '\\-') + '(\\d+)$');
  for (const f of doc.features) { const m = re.exec(f.name); if (m) n = Math.max(n, +m[1] + 1); }
  return label + n;
}

export function labelOf(f) {
  if (f.type === 'extrude') return f.op === 'cut' ? 'Cut-Extrude' : 'Boss-Extrude';
  if (f.type === 'revolve') return f.op === 'cut' ? 'Cut-Revolve' : 'Revolve';
  return TYPE_LABEL[f.type] || f.type;
}

export const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** Mirror plane of a feature: reference plane name or stored face plane. */
export function mirrorPlane(f) {
  if (f.plane && PLANES[f.plane]) return { o: [0, 0, 0], n: PLANES[f.plane].n };
  if (f.plane && f.plane.n) return f.plane;
  return { o: [0, 0, 0], n: [1, 0, 0] };
}

// ------------------------------------------------------------------ hashing / cache

function hash(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

const cache = new Map();   // key -> { body, tool, ownsBody }

const edgeCache = new WeakMap();
/** Model edges of a body (see edges.js), cached per body handle. */
export function bodyEdges(body) {
  let e = edgeCache.get(body);
  if (!e) { e = edgesOf(K.mesh(body)); edgeCache.set(body, e); }
  return e;
}

export function clearCache() {
  for (const e of cache.values()) { if (e.ownsBody) K.free(e.body); K.free(e.tool); }
  cache.clear();
}

// ------------------------------------------------------------------ build

let quality = 'normal';
export function setQuality(q) { quality = q; K.setQuality(q); clearCache(); }
const tolOf = () => (quality === 'low' ? 0.08 : quality === 'high' ? 0.008 : 0.025);

/** Solid regions ({outer, holes} of faces with polygons + exact curves) of a sketch. */
export function regionsOf(sk, pick) {
  const { faces, open } = findFaces(sk, tolOf());
  if (!faces.length) throw new Error(open ? 'The sketch has no closed profile (open contour)' : 'The sketch has no closed profile');
  if (pick && !pick.length) throw new Error('Tap the regions of the sketch to use');
  let regs;
  if (pick) {
    regs = pickRegions(faces, pick);
    if (!regs || !regs.length) throw new Error('None of the selected regions exist any more');
    // the same region tapped twice counts once
    regs = regs.filter((r, i) => regs.findIndex((q) => q.key === r.key) === i);
  } else regs = evenOddRegions(faces);
  const total = regs.reduce((s, r) => s + regionArea(r), 0);
  if (total < 1e-9) throw new Error('The selected profile has no area');
  return { regs, faces };
}

function sketchById(doc, id) {
  const f = doc.features.find((x) => x.id === id);
  if (!f || f.type !== 'sketch') throw new Error('Its sketch was deleted');
  return f;
}

/** Bounding size used for "through all". */
function bigLen(body, pl, pts) {
  let s = 100;
  if (body && !K.isEmpty(body)) {
    const b = K.bbox(body);
    s = Math.max(s, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]),
      ...b.min.map(Math.abs), ...b.max.map(Math.abs));
  }
  for (const p of pts || []) s = Math.max(s, Math.abs(p[0]), Math.abs(p[1]));
  return 2 * s + 2 * v3.len(pl.o) + 10;
}

/** Polygon (lines only) as a region usable by the kernels. */
function polyRegion(pts) {
  const curves = pts.map((p, i) => ({ t: 'line', a: p, b: pts[(i + 1) % pts.length] }));
  const face = { poly: pts, curves, area: 1 };
  return { outer: face, holes: [] };
}

/** Tool solid of an extrude / revolve feature. */
function toolOf(doc, f, body) {
  if (f.type === 'hole') return holeTool(f, body);
  const sf = sketchById(doc, f.sketch);
  if (sf.sup) throw new Error('Its sketch is suppressed');
  const sk = sf.sketch, pl = sk.plane;
  const ptsOf = () => Object.values(sk.pts).map((p) => [p.x, p.y]);
  if (f.type === 'extrude') {
    const { regs } = regionsOf(sk, f.regions);
    let h, z0;
    const L = bigLen(body, pl, ptsOf());
    if (f.end === 'through') { h = L; z0 = f.rev ? -L : 0; }
    else if (f.end === 'through2') { h = 2 * L; z0 = -L; }
    else {
      h = +f.depth;
      if (!(h > 0)) throw new Error('Depth must be more than 0');
      z0 = f.end === 'mid' ? -h / 2 : f.rev ? -h : 0;
    }
    return K.extrudeRegions(regs, pl, z0, h);
  }
  if (f.type === 'revolve') {
    let axis = f.axis != null ? sk.ents.find((e) => e.id === f.axis && e.t === 'line') : null;
    if (!axis) {
      const cl = sk.ents.filter((e) => e.t === 'line' && e.cons);
      if (cl.length === 1) axis = cl[0];
    }
    if (!axis) throw new Error('Pick a line or centerline as the axis');
    const A = sk.pts[axis.a], B = sk.pts[axis.b];
    let d = [B.x - A.x, B.y - A.y];
    const dl = Math.hypot(d[0], d[1]);
    if (dl < 1e-9) throw new Error('The axis has no length');
    d = [d[0] / dl, d[1] / dl];
    let e = [-d[1], d[0]];
    const { regs } = regionsOf(sk, f.regions);
    let pos = 0, neg = 0;
    for (const r of regs) for (const p of r.outer.poly) {
      const s = (p[0] - A.x) * e[0] + (p[1] - A.y) * e[1];
      if (s > 1e-6) pos++; else if (s < -1e-6) neg++;
    }
    if (pos && neg) throw new Error('The profile crosses the axis');
    if (neg > pos) e = [-e[0], -e[1]];
    const ang = Math.min(360, Math.max(0.01, +f.angle || 360));
    const start = ang < 360 ? (f.mid ? -ang / 2 : f.rev ? -ang : 0) : 0;
    return K.revolveRegions(regs, pl, { A: [A.x, A.y], d, e }, start, ang);
  }
  if (f.type === 'hole') return holeTool(f, body);
  throw new Error('Unknown feature');
}

/** Hole wizard tool: one revolved profile per point, into the material (-n). */
function holeTool(f, body) {
  if (!K.KERNEL.can.hole) throw new Error('Holes need FreeTility CAD PRO');
  const pl = f.plane;
  if (!pl || !f.pts || !f.pts.length) throw new Error('Tap the hole positions on the face');
  const R = +f.dia / 2;
  if (!(R > 0)) throw new Error('Diameter must be more than 0');
  const D = f.end === 'through' ? bigLen(body, pl, f.pts) : +f.depth;
  if (!(D > 0)) throw new Error('Depth must be more than 0');
  const up = 0.5;   // start a little outside the face so the cut is clean
  let prof;
  if (f.kind === 'cbore') {
    const Rc = +f.cbDia / 2, Dc = +f.cbDepth;
    if (!(Rc > R)) throw new Error('Counterbore diameter must be larger than the hole');
    if (!(Dc > 0 && Dc < D)) throw new Error('Counterbore depth must be between 0 and the hole depth');
    prof = [[0, -up], [Rc, -up], [Rc, Dc], [R, Dc], [R, D], [0, D]];
  } else if (f.kind === 'csink') {
    const Rs = +f.csDia / 2, a = (+f.csAng || 90) * Math.PI / 360;
    if (!(Rs > R)) throw new Error('Countersink diameter must be larger than the hole');
    const dz = (Rs - R) / Math.tan(a);
    if (!(dz < D)) throw new Error('The countersink is deeper than the hole');
    prof = [[0, -up], [Rs + up * Math.tan(a), -up], [R, dz], [R, D], [0, D]];
  } else prof = [[0, -up], [R, -up], [R, D], [0, D]];
  if (f.end !== 'through' && f.tip !== false) {   // 118° drill point
    const last = prof.pop();
    prof.push([0, last[1] + R / Math.tan(59 * Math.PI / 180)]);
  }
  const tools = [];
  try {
    for (const [u, v] of f.pts) {
      const P = toWorld(pl, u, v);
      const y = v3.mul(pl.n, -1), x = pl.x, n = v3.cross(x, y);
      const lp = { o: P, x, y, n };
      tools.push(K.revolveRegions([polyRegion(prof)], lp, { A: [0, 0], d: [0, 1], e: [1, 0] }, 0, 360));
    }
    return K.unionAll(tools);   // always a new shape
  } finally { tools.forEach((t) => K.free(t)); }
}

/** Copies of earlier tools for a pattern / mirror, as matrices (mirror uses its plane). */
function patternMatrices(f) {
  const ms = [];
  if (f.type === 'lpattern') {
    const dir = v3.mul(AXES[f.dir] || AXES.x, f.rev ? -1 : 1);
    const n = Math.max(2, Math.min(200, Math.round(+f.n || 2)));
    for (let k = 1; k < n; k++) ms.push(translate(v3.mul(dir, k * +f.d)));
    if (f.dir2 && f.n2 > 1) {
      const dir2 = v3.mul(AXES[f.dir2] || AXES.y, f.rev2 ? -1 : 1);
      const base = [translate([0, 0, 0]), ...ms];
      const n2 = Math.max(2, Math.min(200, Math.round(+f.n2)));
      for (let j = 1; j < n2; j++) for (const b of base) ms.push(mmul(translate(v3.mul(dir2, j * +f.d2)), b));
    }
  } else if (f.type === 'cpattern') {
    const n = Math.max(2, Math.min(360, Math.round(+f.n || 2)));
    const total = Math.min(360, Math.max(0.01, +f.angle || 360));
    const step = f.equal === false ? total : (total >= 360 ? 360 / n : total / (n - 1));
    const sgn = f.rev ? -1 : 1;
    for (let k = 1; k < n; k++) ms.push(rotAxis(AXES[f.axis] || AXES.y, sgn * k * step * Math.PI / 180));
  }
  return ms;
}
function copiesOf(f, t) {
  if (f.type === 'mirror') { const p = mirrorPlane(f); return [K.mirror(t, p.o, p.n)]; }
  return patternMatrices(f).map((m) => K.transform(t, m));
}

/**
 * Rebuild every feature (or up to index `upto`, exclusive). `extra` is an
 * uncommitted feature shown as a preview. Returns { body, status, previewTool, tools }.
 */
export function rebuild(doc, opts = {}) {
  const feats = doc.features.slice(0, opts.upto != null ? opts.upto : doc.features.length);
  if (opts.extra) {
    const i = opts.replace != null ? feats.findIndex((f) => f.id === opts.replace) : -1;
    if (i >= 0) feats[i] = opts.extra; else feats.push(opts.extra);
  }
  const status = {};
  const tools = {};
  let body = null, key = 'root';
  const used = new Set();
  let previewTool = null;
  let prevBody = null;
  let relinked = false;

  for (const f of feats) {
    if (f.type === 'sketch') {
      // sketches linked to model edges follow the body built so far
      const st = { ok: true };
      if (!f.sup && f.sketch.cons.some((c) => c.t === 'ext' || c.t === 'exton' || c.t === 'extr')) {
        const edges = body && !K.isEmpty(body) ? bodyEdges(body) : [];
        const r = relink(f.sketch, edges);
        if (r.changed) { S.solve(f.sketch); relinked = true; }
        if (r.broken) st.warn = r.broken + ' broken link' + (r.broken > 1 ? 's' : '') + ' to the model: edit the sketch to fix';
      }
      status[f.id] = st;
      continue;
    }
    if (f.sup) { status[f.id] = { ok: true, sup: true }; continue; }
    let sigObj = f;
    if (f.sketch != null) {
      const sf = doc.features.find((x) => x.id === f.sketch);
      sigObj = { f, s: sf ? sf.sketch : null, ss: sf && sf.sup };
    }
    const k = hash(key + '|' + JSON.stringify(sigObj) + '|' + quality);
    let ent = cache.get(k);
    if (!ent) {
      ent = { body, tool: null, ownsBody: false, err: null };
      try {
        if (PRO_TYPES.includes(f.type) && !K.KERNEL.pro) throw new Error(labelOf(f) + ' needs FreeTility CAD PRO');
        if (f.type === 'extrude' || f.type === 'revolve' || f.type === 'hole') {
          const tool = toolOf(doc, f, body);
          ent.tool = tool;
          if (f.op === 'cut' || f.type === 'hole') {
            if (!body || K.isEmpty(body)) throw new Error('There is nothing to cut yet');
            ent.body = K.subtract(body, tool);
            if (K.volume(ent.body) > K.volume(body) - 1e-9) ent.warn = 'The cut did not remove any material';
          } else {
            ent.body = body ? K.union(body, tool) : K.transform(tool, translate([0, 0, 0]));
          }
          ent.ownsBody = true;
        } else if (f.type === 'fillet' || f.type === 'chamfer' || f.type === 'shell') {
          if (!body || K.isEmpty(body)) throw new Error('There is no body yet');
          if (f.type === 'shell') {
            if (!(+f.t > 0)) throw new Error('Thickness must be more than 0');
            ent.body = K.shell(body, f.faces || [], +f.t, !!f.out);
          } else {
            if (!f.edges || !f.edges.length) throw new Error('Tap the edges to ' + (f.type === 'fillet' ? 'round' : 'bevel'));
            const v = f.type === 'fillet' ? +f.r : +f.d;
            if (!(v > 0)) throw new Error((f.type === 'fillet' ? 'Radius' : 'Distance') + ' must be more than 0');
            ent.body = f.type === 'fillet' ? K.fillet(body, f.edges, v) : K.chamfer(body, f.edges, v);
          }
          ent.ownsBody = true;
        } else if (f.type === 'import') {
          const s = K.importSTEP(f.data);
          ent.tool = s;
          ent.body = body ? K.union(body, s) : K.transform(s, translate([0, 0, 0]));
          ent.ownsBody = true;
        } else if (f.type === 'lpattern' || f.type === 'cpattern' || f.type === 'mirror') {
          if (f.whole) {
            if (!body || K.isEmpty(body)) throw new Error('There is no body to repeat');
            const copies = copiesOf(f, body);
            const all = K.unionAll(copies);
            copies.forEach((c) => { if (c !== all) K.free(c); });
            ent.body = K.union(body, all);
            ent.tool = all; ent.gop = 'add';   // kept for the feature tree ghost
            ent.ownsBody = true;
          } else {
            const src = (f.feats || []).map((id) => feats.find((x) => x.id === id)).filter(Boolean);
            if (!src.length) throw new Error('Pick the features to repeat');
            let cur = body, owned = false;
            const ghosts = [];
            let anyAdd = false;
            for (const s of src) {
              const t = tools[s.id];
              if (!t) throw new Error(s.name + ' has no geometry to repeat');
              const copies = copiesOf(f, t);
              const all = K.unionAll(copies);
              copies.forEach((c) => { if (c !== all) K.free(c); });
              let next;
              const cut = s.op === 'cut' || s.type === 'hole';
              if (!cut) anyAdd = true;
              ghosts.push(all);
              if (cut) {
                if (!cur || K.isEmpty(cur)) continue;
                next = K.subtract(cur, all);
              } else next = cur ? K.union(cur, all) : K.transform(all, translate([0, 0, 0]));
              if (owned) K.free(cur);
              cur = next; owned = true;
            }
            ent.body = cur; ent.ownsBody = owned;
            if (ghosts.length) {
              ent.tool = K.unionAll(ghosts);
              ent.gop = anyAdd ? 'add' : 'cut';
            }
            ghosts.forEach((g) => K.free(g));
          }
        }
      } catch (e) {
        if (ent.tool) { K.free(ent.tool); ent.tool = null; }
        if (ent.ownsBody && ent.body !== body) K.free(ent.body);
        ent.body = body; ent.ownsBody = false; ent.err = (e && e.message) || 'This feature failed';
      }
      cache.set(k, ent);
    }
    used.add(k);
    status[f.id] = ent.err ? { ok: false, err: ent.err } : { ok: true, warn: ent.warn, gop: ent.gop };
    if (ent.tool) tools[f.id] = ent.tool;
    if (opts.extra && f === opts.extra) { previewTool = ent.tool; prevBody = body; }
    body = ent.body;
    key = k;
  }
  if (!opts.extra && !opts.keepCache) {
    for (const [k, e] of cache) {
      if (used.has(k)) continue;
      if (e.ownsBody) K.free(e.body);
      K.free(e.tool);
      cache.delete(k);
    }
  }
  return { body: body && !K.isEmpty(body) ? body : null, status, previewTool, tools, before: prevBody, relinked };
}

// ------------------------------------------------------------------ export

/** Binary STL bytes from a mesh {pos, idx}. */
export function meshToSTL(m, name) {
  const nt = m.idx.length / 3;
  const buf = new ArrayBuffer(84 + nt * 50);
  const dv = new DataView(buf);
  const head = ('FreeTility CAD ' + (name || '')).slice(0, 79);
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i) & 0x7f);
  dv.setUint32(80, nt, true);
  let o = 84;
  const P = m.pos, I = m.idx;
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true); o += 12;
    for (const v of [a, b, c]) { dv.setFloat32(o, P[v], true); dv.setFloat32(o + 4, P[v + 1], true); dv.setFloat32(o + 8, P[v + 2], true); o += 12; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return new Uint8Array(buf);
}
export const toSTL = (body, name) => meshToSTL(K.mesh(body, true), name);

export function massProps(body) {
  return body ? { volume: K.volume(body), area: K.area(body), bbox: K.bbox(body) } : null;
}

// ------------------------------------------------------------------ frozen mesh (PRO parts viewed in CAD)

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(str) {
  const s = atob(str), b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
export function packMesh(m) {
  return { pos: b64(new Uint8Array(m.pos.buffer, m.pos.byteOffset, m.pos.byteLength)), idx: b64(new Uint8Array(m.idx.buffer, m.idx.byteOffset, m.idx.byteLength)) };
}
export function unpackMesh(p) {
  const a = unb64(p.pos), b = unb64(p.idx);
  return { pos: new Float32Array(a.buffer), idx: new Uint32Array(b.buffer) };
}
