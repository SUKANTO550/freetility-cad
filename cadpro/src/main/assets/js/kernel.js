// FreeTility CAD PRO - geometry kernel adapter (OpenCascade B-rep via opencascade.js).
// Same exports as the FreeTility CAD kernel (Manifold), plus fillet, chamfer,
// shell and STEP. Shapes are TopoDS_Shape wrappers; call free() when done.

import initOC from '../lib/replicad_single.js';
import { toWorld, v3 } from './mat.js';

export const KERNEL = {
  name: 'OpenCascade',
  license: 'Open CASCADE Technology (LGPL 2.1) via opencascade.js',
  pro: true,
  can: { fillet: true, chamfer: true, shell: true, hole: true, step: true },
};

let oc = null;
let quality = 'normal';

export async function init() {
  if (oc) return;
  oc = await initOC({ locateFile: (f) => new URL('../lib/' + f, import.meta.url).href });
}

export function setQuality(q) { quality = q; }

// ------------------------------------------------------------------ helpers

/** Run fn with a tracker; every tracked wasm object is deleted afterwards. */
function scope(fn) {
  const tmp = [];
  const T = (o) => { tmp.push(o); return o; };
  try { return fn(T); } finally { for (let i = tmp.length - 1; i >= 0; i--) { try { tmp[i].delete(); } catch (e) { /* ignore */ } } }
}
const PR = (T) => T(new oc.Message_ProgressRange());
const pnt = (T, p) => T(new oc.gp_Pnt(p[0], p[1], p[2]));
const dir = (T, d) => T(new oc.gp_Dir(d[0], d[1], d[2]));

function fail(e, msg) {
  if (e && e.message && !(e instanceof WebAssembly.Exception)) return new Error(e.message);
  return new Error(msg);
}

/** Merge faces and edges split by booleans so the model stays clean (and fillets work). */
function unify(T, s) {
  try {
    const u = T(new oc.ShapeUpgrade_UnifySameDomain(s, true, true, false));
    u.Build();
    return u.Shape();
  } catch (e) { return dup(T, s); }
}

/** A new wrapper for the same shape (so the caller owns it). */
function dup(T, s) {
  return T(new oc.BRepBuilderAPI_Transform(s, T(new oc.gp_Trsf()), false, false)).Shape();
}

/**
 * Accept a feature result only if it is a valid solid with a sensible volume;
 * OCCT sometimes reports success for broken offsets or blends.
 */
function checked(T, shape, msg, before) {
  let ok = false;
  try {
    ok = !shape.IsNull() && T(new oc.BRepCheck_Analyzer(shape, true, false, false)).IsValid();
    if (ok) {
      const p = T(new oc.GProp_GProps());
      oc.BRepGProp.VolumeProperties(shape, p, false, false, false);
      const v = p.Mass();
      ok = Number.isFinite(v) && v > 1e-9 && (before == null || v < before * 1.5 + 1);
    }
  } catch (e) { ok = false; }
  if (!ok) { try { shape.delete(); } catch (e) { /* ignore */ } throw new Error(msg); }
  return shape;
}

// ------------------------------------------------------------------ profiles

function edgeOf(T, c, pl) {
  const W = (q) => toWorld(pl, q[0], q[1]);
  if (c.t === 'line') return T(T(new oc.BRepBuilderAPI_MakeEdge(pnt(T, W(c.a)), pnt(T, W(c.b)))).Edge());
  const axisDir = c.t === 'circle' || c.ccw ? pl.n : v3.mul(pl.n, -1);
  const circ = T(new oc.gp_Circ(T(new oc.gp_Ax2(pnt(T, W(c.c)), dir(T, axisDir))), c.r));
  if (c.t === 'circle') return T(T(new oc.BRepBuilderAPI_MakeEdge(circ)).Edge());
  return T(T(new oc.BRepBuilderAPI_MakeEdge(circ, pnt(T, W(c.a)), pnt(T, W(c.b)))).Edge());
}

function wireOf(T, face, pl) {
  const mw = T(new oc.BRepBuilderAPI_MakeWire());
  for (const c of face.curves) mw.Add(edgeOf(T, c, pl));
  if (!mw.IsDone()) throw new Error('A sketch loop could not be closed');
  return T(mw.Wire());
}

/** Planar face of a region (outer loop + holes) on a sketch plane. */
function faceOf(T, r, pl) {
  const mf = T(new oc.BRepBuilderAPI_MakeFace(wireOf(T, r.outer, pl), true));
  for (const h of r.holes) { const w = wireOf(T, h, pl); w.Reverse(); mf.Add(w); }
  if (!mf.IsDone()) throw new Error('The profile could not be turned into a face');
  return T(mf.Face());
}

function fuseList(T, list) {
  let acc = list[0];
  for (let i = 1; i < list.length; i++) {
    const op = T(new oc.BRepAlgoAPI_Fuse(acc, list[i], PR(T)));
    acc = T(op.Shape());
  }
  return acc;
}

export function extrudeRegions(regions, pl, z0, h) {
  return scope((T) => {
    try {
      const p2 = { ...pl, o: v3.add(pl.o, v3.mul(pl.n, z0)) };
      const vec = T(new oc.gp_Vec(pl.n[0] * h, pl.n[1] * h, pl.n[2] * h));
      const solids = regions.map((r) => T(T(new oc.BRepPrimAPI_MakePrism(faceOf(T, r, p2), vec, false, true)).Shape()));
      return unify(T, fuseList(T, solids));
    } catch (e) { throw fail(e, 'The extrusion failed'); }
  });
}

export function revolveRegions(regions, pl, ax, startDeg, deg) {
  return scope((T) => {
    try {
      const A = toWorld(pl, ax.A[0], ax.A[1]);
      const D = v3.add(v3.mul(pl.x, ax.d[0]), v3.mul(pl.y, ax.d[1]));
      const axis = T(new oc.gp_Ax1(pnt(T, A), dir(T, D)));
      const solids = regions.map((r) => {
        let f = faceOf(T, r, pl);
        if (startDeg) {
          const tr = T(new oc.gp_Trsf()); tr.SetRotation(axis, startDeg * Math.PI / 180);
          f = T(T(new oc.BRepBuilderAPI_Transform(f, tr, true, false)).Shape());
        }
        const mk = deg >= 360 ? T(new oc.BRepPrimAPI_MakeRevol(f, axis, false)) : T(new oc.BRepPrimAPI_MakeRevol(f, axis, deg * Math.PI / 180, false));
        return T(mk.Shape());
      });
      return unify(T, fuseList(T, solids));
    } catch (e) { throw fail(e, 'The revolve failed'); }
  });
}

// ------------------------------------------------------------------ booleans / transforms

export function union(a, b) {
  return scope((T) => { try { return unify(T, T(T(new oc.BRepAlgoAPI_Fuse(a, b, PR(T))).Shape())); } catch (e) { throw fail(e, 'Adding the material failed'); } });
}
export function subtract(a, b) {
  return scope((T) => { try { return unify(T, T(T(new oc.BRepAlgoAPI_Cut(a, b, PR(T))).Shape())); } catch (e) { throw fail(e, 'The cut failed'); } });
}
/** Always returns a new handle. */
export function unionAll(list) {
  if (list.length === 1) return transform(list[0], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return scope((T) => { try { return unify(T, fuseList(T, list)); } catch (e) { throw fail(e, 'Joining the copies failed'); } });
}

/** Rigid transform from a column-major 4x4 (rotation + translation only). */
export function transform(s, m) {
  return scope((T) => {
    const R = (i, j) => m[j * 4 + i];
    const tr = T(new oc.gp_Trsf());
    const cosA = Math.max(-1, Math.min(1, (R(0, 0) + R(1, 1) + R(2, 2) - 1) / 2));
    const ang = Math.acos(cosA);
    if (ang > 1e-9) {
      let ax;
      if (Math.PI - ang > 1e-6) ax = [R(2, 1) - R(1, 2), R(0, 2) - R(2, 0), R(1, 0) - R(0, 1)];
      else {   // 180 degrees: axis from the diagonal
        const xx = Math.sqrt(Math.max(0, (R(0, 0) + 1) / 2)), yy = Math.sqrt(Math.max(0, (R(1, 1) + 1) / 2)), zz = Math.sqrt(Math.max(0, (R(2, 2) + 1) / 2));
        ax = [xx, R(0, 1) >= 0 ? yy : -yy, R(0, 2) >= 0 ? zz : -zz];
        if (xx < 1e-6) ax = [0, yy, R(1, 2) >= 0 ? zz : -zz];
      }
      tr.SetRotation(T(new oc.gp_Ax1(pnt(T, [0, 0, 0]), dir(T, v3.norm(ax)))), ang);
    }
    const t = [m[12], m[13], m[14]];
    if (Math.hypot(...t) > 0) {
      const tt = T(new oc.gp_Trsf());
      tt.SetTranslation(T(new oc.gp_Vec(t[0], t[1], t[2])));
      tt.Multiply(tr);
      return T(new oc.BRepBuilderAPI_Transform(s, tt, true, false)).Shape();
    }
    return T(new oc.BRepBuilderAPI_Transform(s, tr, true, false)).Shape();
  });
}

export function mirror(s, o, n) {
  return scope((T) => {
    const tr = T(new oc.gp_Trsf());
    tr.SetMirror(T(new oc.gp_Ax2(pnt(T, o), dir(T, n))));
    return T(new oc.BRepBuilderAPI_Transform(s, tr, true, false)).Shape();
  });
}

// ------------------------------------------------------------------ properties

export function volume(s) {
  if (!s) return 0;
  return scope((T) => { const p = T(new oc.GProp_GProps()); oc.BRepGProp.VolumeProperties(s, p, false, false, false); return p.Mass(); });
}
export function area(s) {
  if (!s) return 0;
  return scope((T) => { const p = T(new oc.GProp_GProps()); oc.BRepGProp.SurfaceProperties(s, p, false, false); return p.Mass(); });
}
export function isEmpty(s) {
  if (!s || s.IsNull()) return true;
  return scope((T) => { const ex = T(new oc.TopExp_Explorer(s, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE)); return !ex.More(); });
}
export function bbox(s) {
  return scope((T) => {
    const b = T(new oc.Bnd_Box());
    oc.BRepBndLib.Add(s, b, false);
    const a = T(b.CornerMin()), c = T(b.CornerMax());
    return { min: [a.X(), a.Y(), a.Z()], max: [c.X(), c.Y(), c.Z()] };
  });
}

// ------------------------------------------------------------------ topology + mesh

const info = new WeakMap();   // shape wrapper -> { mesh, edges, faces }

function listOf(T, s, type) {
  const out = [];
  const ex = T(new oc.TopExp_Explorer(s, type, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  for (; ex.More(); ex.Next()) out.push(T(ex.Current()));
  return out;
}

/** Unique edges of s with a polyline, mid point and direction. */
function edgesOf(T, s, lin, angD) {
  const raw = listOf(T, s, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
  const uniq = [], buckets = new Map();
  for (const sh of raw) {
    const e = T(oc.TopoDS.Edge(sh));
    if (oc.BRep_Tool.Degenerated(e)) continue;
    const ca = T(new oc.BRepAdaptor_Curve(e));
    const u0 = ca.FirstParameter(), u1 = ca.LastParameter();
    const pm = T(ca.Value((u0 + u1) / 2));
    const key = Math.round(pm.X() * 100) + ',' + Math.round(pm.Y() * 100) + ',' + Math.round(pm.Z() * 100);
    const list = buckets.get(key) || [];
    if (list.some((u) => u.e.IsSame(e))) continue;
    const td = T(new oc.GCPnts_TangentialDeflection(ca, u0, u1, angD, lin, 2, 1e-9, 1e-7));
    const n = td.NbPoints();
    const pts = new Float32Array(n * 3);
    for (let i = 1; i <= n; i++) { const p = T(td.Value(i)); pts[(i - 1) * 3] = p.X(); pts[(i - 1) * 3 + 1] = p.Y(); pts[(i - 1) * 3 + 2] = p.Z(); }
    const mid = [pm.X(), pm.Y(), pm.Z()];
    const k = Math.max(1, Math.floor(n / 2));
    const dvec = v3.norm([pts[k * 3] - pts[(k - 1) * 3], pts[k * 3 + 1] - pts[(k - 1) * 3 + 1], pts[k * 3 + 2] - pts[(k - 1) * 3 + 2]]);
    const rec = { e, pts, mid, dir: dvec, id: uniq.length, kind: 'curve', closed: ca.IsClosed() };
    const ty = ca.GetType();
    if (ty === oc.GeomAbs_CurveType.GeomAbs_Line) rec.kind = 'line';
    else if (ty === oc.GeomAbs_CurveType.GeomAbs_Circle) {
      const ci = T(ca.Circle()), lo = T(ci.Location()), ax = T(ci.Axis()), dr = T(ax.Direction());
      rec.kind = 'circle';
      rec.circ = { c: [lo.X(), lo.Y(), lo.Z()], r: ci.Radius(), n: [dr.X(), dr.Y(), dr.Z()] };
    }
    list.push(rec); buckets.set(key, list);
    uniq.push(rec);
  }
  return { uniq, buckets };
}

function findEdge(T, edges, e) {
  for (const r of edges.uniq) if (r.e.IsSame(e)) return r.id;
  return -1;
}

function deflections(s) {
  const b = bbox(s);
  const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1;
  const k = quality === 'low' ? 0.003 : quality === 'high' ? 0.0005 : 0.0012;
  return { lin: Math.max(0.002, diag * k), ang: quality === 'low' ? 0.5 : quality === 'high' ? 0.15 : 0.3, diag };
}

/**
 * Triangle mesh with topology: pos, idx, faceOf (face per triangle),
 * faceInfo [{flat, n, d, edges:[edge ids]}], edges [{pts, mid, dir}].
 */
export function mesh(s) {
  const hit = info.get(s);
  if (hit) return hit.mesh;
  return scope((T) => {
    const { lin, ang } = deflections(s);
    T(new oc.BRepMesh_IncrementalMesh(s, lin, false, ang, false));
    const edges = edgesOf(T, s, lin, ang);
    const pos = [], idx = [], faceOf = [], faceInfo = [];
    const faces = listOf(T, s, oc.TopAbs_ShapeEnum.TopAbs_FACE);
    faces.forEach((sh, fi) => {
      const f = T(oc.TopoDS.Face(sh));
      const loc = T(new oc.TopLoc_Location());
      const tri = oc.BRep_Tool.Triangulation(f, loc, 0);
      const rev = f.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      const ad = T(new oc.BRepAdaptor_Surface(f, true));
      const fInfo = { flat: false, n: null, d: 0, edges: [] };
      if (ad.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        const pln = T(ad.Plane()), axis = T(pln.Axis()), dr = T(axis.Direction()), lo = T(pln.Location());
        let n = [dr.X(), dr.Y(), dr.Z()];
        if (rev) n = v3.mul(n, -1);
        fInfo.flat = true; fInfo.n = n; fInfo.d = v3.dot(n, [lo.X(), lo.Y(), lo.Z()]);
      }
      for (const esh of listOf(T, f, oc.TopAbs_ShapeEnum.TopAbs_EDGE)) {
        const id = findEdge(T, edges, esh);
        if (id >= 0 && !fInfo.edges.includes(id)) fInfo.edges.push(id);
      }
      faceInfo.push(fInfo);
      if (!tri) return;
      T(tri);
      const trsf = loc.IsIdentity() ? null : T(loc.Transformation());
      const base = pos.length / 3;
      const nn = tri.NbNodes();
      for (let i = 1; i <= nn; i++) {
        let p = T(tri.Node(i));
        if (trsf) p = T(p.Transformed(trsf));
        pos.push(p.X(), p.Y(), p.Z());
      }
      const nt = tri.NbTriangles();
      for (let i = 1; i <= nt; i++) {
        const t = T(tri.Triangle(i));
        const a = t.Value(1) - 1, b = t.Value(2) - 1, c = t.Value(3) - 1;
        if (rev) idx.push(base + a, base + c, base + b); else idx.push(base + a, base + b, base + c);
        faceOf.push(fi);
      }
    });
    const m = {
      pos: Float32Array.from(pos), idx: Uint32Array.from(idx), faceOf: Uint32Array.from(faceOf), faceInfo,
      edges: edges.uniq.map((r) => ({ pts: r.pts, mid: r.mid, dir: r.dir, kind: r.kind, circ: r.circ, closed: r.closed })),
    };
    info.set(s, { mesh: m });
    return m;
  });
}

// ------------------------------------------------------------------ picking stored references on a new shape

function distPtPoly(p, pts) {
  let best = Infinity;
  for (let i = 0; i + 5 < pts.length + 3; i += 3) {
    const ax = pts[i], ay = pts[i + 1], az = pts[i + 2];
    const bx = pts[i + 3], by = pts[i + 4], bz = pts[i + 5];
    if (bx === undefined) { best = Math.min(best, Math.hypot(p[0] - ax, p[1] - ay, p[2] - az)); break; }
    const dx = bx - ax, dy = by - ay, dz = bz - az, l2 = dx * dx + dy * dy + dz * dz || 1;
    let t = ((p[0] - ax) * dx + (p[1] - ay) * dy + (p[2] - az) * dz) / l2;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy, p[2] - az - t * dz));
  }
  return best;
}

/** Edges of s matching stored refs {p, d}; throws when one is gone. */
function matchEdges(T, s, refs) {
  const { lin, ang, diag } = deflections(s);
  const edges = edgesOf(T, s, lin, ang).uniq;
  const tol = Math.max(0.05, diag * 0.01);
  const out = [];
  for (const r of refs) {
    let best = null, bs = Infinity;
    for (const e of edges) {
      const dist = distPtPoly(r.p, e.pts);
      if (dist > tol) continue;
      const align = r.d ? Math.abs(v3.dot(r.d, e.dir)) : 1;
      const score = dist + (1 - align) * tol;
      if (score < bs) { bs = score; best = e; }
    }
    if (!best) throw new Error('A selected edge no longer exists. Edit the feature and pick it again');
    if (!out.includes(best)) out.push(best);
  }
  return out.map((e) => e.e);
}

/** Planar faces of s matching stored refs {p, n}. */
function matchFaces(T, s, refs) {
  const m = mesh(s);
  const { diag } = deflections(s);
  const tol = Math.max(0.05, diag * 0.005);
  const faces = listOf(T, s, oc.TopAbs_ShapeEnum.TopAbs_FACE);
  const out = [];
  for (const r of refs) {
    let best = -1, bd = Infinity;
    m.faceInfo.forEach((fi, i) => {
      if (!fi.flat || v3.dot(fi.n, r.n) < 0.995) return;
      if (Math.abs(v3.dot(fi.n, r.p) - fi.d) > tol) return;
      // distance from the point to this face's triangles (centroids, cheap)
      let d = Infinity;
      for (let t = 0; t < m.faceOf.length; t++) {
        if (m.faceOf[t] !== i) continue;
        const a = m.idx[t * 3] * 3, b = m.idx[t * 3 + 1] * 3, c = m.idx[t * 3 + 2] * 3;
        if (pointInTri(r.p, m.pos, a, b, c, fi.n)) { d = 0; break; }
        const cx = (m.pos[a] + m.pos[b] + m.pos[c]) / 3, cy = (m.pos[a + 1] + m.pos[b + 1] + m.pos[c + 1]) / 3, cz = (m.pos[a + 2] + m.pos[b + 2] + m.pos[c + 2]) / 3;
        d = Math.min(d, Math.hypot(r.p[0] - cx, r.p[1] - cy, r.p[2] - cz));
      }
      if (d < bd) { bd = d; best = i; }
    });
    if (best < 0) throw new Error('A selected face no longer exists. Edit the feature and pick it again');
    out.push(faces[best]);
  }
  return out;
}

function pointInTri(p, P, a, b, c, n) {
  const sub = (i) => [P[i] - p[0], P[i + 1] - p[1], P[i + 2] - p[2]];
  const A = sub(a), B = sub(b), C = sub(c);
  const s1 = v3.dot(v3.cross(A, B), n), s2 = v3.dot(v3.cross(B, C), n), s3 = v3.dot(v3.cross(C, A), n);
  return (s1 >= -1e-9 && s2 >= -1e-9 && s3 >= -1e-9) || (s1 <= 1e-9 && s2 <= 1e-9 && s3 <= 1e-9);
}

// ------------------------------------------------------------------ PRO features

/** Run a builder; on any OCCT failure or an invalid result, throw msg. */
function build(T, s, msg, make, bounded = true) {
  let out = null;
  try { out = make(); } catch (e) { out = null; }
  if (!out) throw new Error(msg);
  return checked(T, out, msg, bounded ? volume(s) : null);
}

export function fillet(s, refs, r) {
  return scope((T) => {
    const edges = matchEdges(T, s, refs);
    return build(T, s, 'The fillet failed: try a smaller radius or fewer edges', () => {
      const mk = T(new oc.BRepFilletAPI_MakeFillet(s, oc.ChFi3d_FilletShape.ChFi3d_Rational));
      for (const e of edges) mk.Add(r, e);
      mk.Build(PR(T));
      return mk.IsDone() ? mk.Shape() : null;
    });
  });
}

export function chamfer(s, refs, d) {
  return scope((T) => {
    const edges = matchEdges(T, s, refs);
    return build(T, s, 'The chamfer failed: try a smaller distance or fewer edges', () => {
      const mk = T(new oc.BRepFilletAPI_MakeChamfer(s));
      for (const e of edges) mk.Add(d, e);
      mk.Build(PR(T));
      return mk.IsDone() ? mk.Shape() : null;
    });
  });
}

export function shell(s, refs, t, outward) {
  return scope((T) => {
    if (!refs.length) throw new Error('Tap the faces to remove (open)');
    const faces = matchFaces(T, s, refs);
    return build(T, s, 'The shell failed: try a thinner wall, or shell before adding fillets and holes', () => {
      const list = T(new oc.NCollection_List_TopoDS_Shape());
      for (const f of faces) list.Append(f);
      const mk = T(new oc.BRepOffsetAPI_MakeThickSolid());
      mk.MakeThickSolidByJoin(s, list, outward ? t : -t, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, true, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false, PR(T));
      return mk.IsDone() ? mk.Shape() : null;
    }, false);
  });
}

// ------------------------------------------------------------------ STEP

export function importSTEP(text) {
  return scope((T) => {
    const path = '/import.step';
    oc.FS.writeFile(path, text);
    try {
      const r = T(new oc.STEPControl_Reader());
      const st = r.ReadFile(path);
      if (st !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error('This STEP file could not be read');
      r.TransferRoots(PR(T));
      const s = r.OneShape();
      if (!s || s.IsNull()) throw new Error('The STEP file has no shape');
      if (isEmpty(s)) { s.delete(); throw new Error('The STEP file has no solid body (only surfaces or curves)'); }
      return s;
    } catch (e) { throw fail(e, 'This STEP file could not be read'); }
    finally { try { oc.FS.unlink(path); } catch (e) { /* ignore */ } }
  });
}

export function exportSTEP(s) {
  return scope((T) => {
    const path = '/export.step';
    const w = T(new oc.STEPControl_Writer());
    w.Transfer(s, oc.STEPControl_StepModelType.STEPControl_AsIs, true, PR(T));
    if (w.Write(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error('Writing the STEP file failed');
    const bytes = oc.FS.readFile(path);
    try { oc.FS.unlink(path); } catch (e) { /* ignore */ }
    return bytes;
  });
}

export function free(h) {
  if (!h || !h.delete) return;
  info.delete(h);
  try { h.delete(); } catch (e) { /* already freed */ }
}
