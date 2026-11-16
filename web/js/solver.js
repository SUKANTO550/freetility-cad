// FreeTility CAD - 2D sketch constraint solver.
//
// Unknowns: x,y of every free point and r of every circle. Each constraint adds
// one or more residual equations. Levenberg-Marquardt with numeric (central
// difference) Jacobians, solved per independent component. When there are fewer
// equations than unknowns the minimum-norm step is used, so geometry moves as
// little as possible (good for dragging).
//
// analyze() row-reduces the Jacobian to find which unknowns are fixed by the
// constraints (fully defined) and whether equations are redundant.

const EPS_RES = 1e-7;   // residual accepted as solved (mm)
const MAX_IT = 80;

// ------------------------------------------------------------------ system

function charLen(sk) {
  let mnx = 0, mny = 0, mxx = 0, mxy = 0;
  for (const id in sk.pts) {
    const p = sk.pts[id];
    if (p.x < mnx) mnx = p.x; if (p.x > mxx) mxx = p.x;
    if (p.y < mny) mny = p.y; if (p.y > mxy) mxy = p.y;
  }
  return Math.max(10, mxx - mnx, mxy - mny);
}

/** Build the unknown vector and the residual equations for a sketch. */
export function buildSystem(sk, extra) {
  const pidx = {}, ridx = {};
  const x = [];
  for (const id in sk.pts) {
    const p = sk.pts[id];
    if (p.origin) continue;
    pidx[id] = x.length; x.push(p.x, p.y);
  }
  const ents = {};
  for (const e of sk.ents) {
    ents[e.id] = e;
    if (e.t === 'circle') { ridx[e.id] = x.length; x.push(e.r); }
  }
  const L = charLen(sk);
  const sys = { sk, pidx, ridx, x, eqs: [], conOf: [], L, ents };

  const P = (id) => {
    const i = pidx[id], p = sk.pts[id];
    if (i === undefined) return { v: [], x: () => p.x, y: () => p.y };
    return { v: [i, i + 1], x: (X) => X[i], y: (X) => X[i + 1] };
  };
  sys.P = P;
  const R = (e) => {   // radius accessor for circle/arc
    if (e.t === 'circle') { const i = ridx[e.id]; return { v: [i], r: (X) => X[i] }; }
    const c = P(e.c), a = P(e.a);
    return { v: [...c.v, ...a.v], r: (X) => Math.hypot(a.x(X) - c.x(X), a.y(X) - c.y(X)) };
  };
  sys.R = R;

  const add = (con, vars, f) => {
    sys.eqs.push({ vars: [...new Set(vars)], f });
    sys.conOf.push(con);
  };

  // arcs: both ends at the same radius
  for (const e of sk.ents) {
    if (e.t !== 'arc') continue;
    const c = P(e.c), a = P(e.a), b = P(e.b);
    add(null, [...c.v, ...a.v, ...b.v], (X) =>
      Math.hypot(a.x(X) - c.x(X), a.y(X) - c.y(X)) - Math.hypot(b.x(X) - c.x(X), b.y(X) - c.y(X)));
  }

  for (const con of sk.cons) addConstraint(sys, con, add);
  if (extra) for (const con of extra) addConstraint(sys, con, add);
  return sys;
}

function lineAcc(sys, eid) {
  const e = sys.ents[eid];
  if (!e || e.t !== 'line') return null;
  const a = sys.P(e.a), b = sys.P(e.b);
  return {
    v: [...a.v, ...b.v], a, b,
    dx: (X) => b.x(X) - a.x(X), dy: (X) => b.y(X) - a.y(X),
  };
}

function circAcc(sys, eid) {
  const e = sys.ents[eid];
  if (!e || (e.t !== 'circle' && e.t !== 'arc')) return null;
  const c = sys.P(e.c), r = sys.R(e);
  return { v: [...c.v, ...r.v], c, r: r.r };
}

const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a <= -Math.PI) a += 2 * Math.PI; return a; };

/** Signed distance from point (px,py) to the infinite line of l (left side positive). */
function sdist(l, X, px, py) {
  const dx = l.dx(X), dy = l.dy(X), len = Math.hypot(dx, dy) || 1e-12;
  return (dx * (py - l.a.y(X)) - dy * (px - l.a.x(X))) / len;
}

function addConstraint(sys, con, add) {
  const L = sys.L, P = sys.P;
  switch (con.t) {
    case 'h': { const l = lineAcc(sys, con.e); if (l) add(con, l.v, (X) => l.dy(X)); break; }
    case 'v': { const l = lineAcc(sys, con.e); if (l) add(con, l.v, (X) => l.dx(X)); break; }
    case 'hp': { const a = P(con.a), b = P(con.b); add(con, [...a.v, ...b.v], (X) => b.y(X) - a.y(X)); break; }
    case 'vp': { const a = P(con.a), b = P(con.b); add(con, [...a.v, ...b.v], (X) => b.x(X) - a.x(X)); break; }
    case 'co': {
      const a = P(con.a), b = P(con.b), v = [...a.v, ...b.v];
      add(con, v, (X) => b.x(X) - a.x(X)); add(con, v, (X) => b.y(X) - a.y(X)); break;
    }
    case 'fix': {
      const a = P(con.p);
      add(con, a.v, (X) => a.x(X) - con.x); add(con, a.v, (X) => a.y(X) - con.y); break;
    }
    case 'ext': {   // point linked to a model corner / edge midpoint / circle centre (target kept in x, y)
      if (con.broken) break;
      const a = P(con.p);
      add(con, a.v, (X) => a.x(X) - con.x); add(con, a.v, (X) => a.y(X) - con.y); break;
    }
    case 'exton': {   // point on a model edge (projected line or circle)
      if (con.broken) break;
      const a = P(con.p);
      if (con.line) {
        const [x1, y1, x2, y2] = con.line, dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1e-12;
        add(con, a.v, (X) => (dx * (a.y(X) - y1) - dy * (a.x(X) - x1)) / len);
      } else if (con.circ) {
        const { cx, cy, r } = con.circ;
        add(con, a.v, (X) => Math.hypot(a.x(X) - cx, a.y(X) - cy) - r);
      }
      break;
    }
    case 'extr': {   // circle / arc radius linked to a model circle
      if (con.broken) break;
      const c = circAcc(sys, con.e);
      if (c) add(con, c.v, (X) => c.r(X) - con.r);
      break;
    }
    case 'amid': {   // point at the middle of an arc
      const e = sys.ents[con.e];
      if (!e || e.t !== 'arc') break;
      const p = P(con.p), c = P(e.c), a = P(e.a), b = P(e.b), v = [...p.v, ...c.v, ...a.v, ...b.v];
      add(con, v, (X) => Math.hypot(p.x(X) - c.x(X), p.y(X) - c.y(X)) - Math.hypot(a.x(X) - c.x(X), a.y(X) - c.y(X)));
      add(con, v, (X) => Math.hypot(p.x(X) - a.x(X), p.y(X) - a.y(X)) - Math.hypot(p.x(X) - b.x(X), p.y(X) - b.y(X)));
      break;
    }
    case 'par': case 'perp': case 'col': {
      const l1 = lineAcc(sys, con.e1), l2 = lineAcc(sys, con.e2);
      if (!l1 || !l2) break;
      const v = [...l1.v, ...l2.v];
      if (con.t === 'perp') {
        add(con, v, (X) => { const a = l1.dx(X), b = l1.dy(X), c = l2.dx(X), d = l2.dy(X);
          return L * (a * c + b * d) / ((Math.hypot(a, b) * Math.hypot(c, d)) || 1e-12); });
      } else {
        add(con, v, (X) => { const a = l1.dx(X), b = l1.dy(X), c = l2.dx(X), d = l2.dy(X);
          return L * (a * d - b * c) / ((Math.hypot(a, b) * Math.hypot(c, d)) || 1e-12); });
      }
      if (con.t === 'col') add(con, v, (X) => sdist(l1, X, l2.a.x(X), l2.a.y(X)));
      break;
    }
    case 'eq': {
      const l1 = lineAcc(sys, con.e1), l2 = lineAcc(sys, con.e2);
      if (l1 && l2) { add(con, [...l1.v, ...l2.v], (X) => Math.hypot(l1.dx(X), l1.dy(X)) - Math.hypot(l2.dx(X), l2.dy(X))); break; }
      const c1 = circAcc(sys, con.e1), c2 = circAcc(sys, con.e2);
      if (c1 && c2) add(con, [...c1.v, ...c2.v], (X) => c1.r(X) - c2.r(X));
      break;
    }
    case 'conc': {
      const c1 = circAcc(sys, con.e1), c2 = circAcc(sys, con.e2);
      if (!c1 || !c2) break;
      const v = [...c1.c.v, ...c2.c.v];
      add(con, v, (X) => c2.c.x(X) - c1.c.x(X)); add(con, v, (X) => c2.c.y(X) - c1.c.y(X)); break;
    }
    case 'tan': {
      const l = lineAcc(sys, con.e1) || lineAcc(sys, con.e2);
      const c1 = circAcc(sys, con.e1), c2 = circAcc(sys, con.e2);
      const s = con.s || 1;
      if (l) {
        const c = c1 || c2;
        if (c) add(con, [...l.v, ...c.v], (X) => sdist(l, X, c.c.x(X), c.c.y(X)) - s * c.r(X));
      } else if (c1 && c2) {
        const k = con.k || 0;
        add(con, [...c1.v, ...c2.v], (X) => {
          const d = Math.hypot(c2.c.x(X) - c1.c.x(X), c2.c.y(X) - c1.c.y(X));
          const r1 = c1.r(X), r2 = c2.r(X);
          return k === 0 ? d - (r1 + r2) : k === 1 ? d - (r1 - r2) : d - (r2 - r1);
        });
      }
      break;
    }
    case 'onl': {
      const p = P(con.p), l = lineAcc(sys, con.e);
      if (l) add(con, [...p.v, ...l.v], (X) => sdist(l, X, p.x(X), p.y(X)));
      break;
    }
    case 'onc': {
      const p = P(con.p), c = circAcc(sys, con.e);
      if (c) add(con, [...p.v, ...c.v], (X) => Math.hypot(p.x(X) - c.c.x(X), p.y(X) - c.c.y(X)) - c.r(X));
      break;
    }
    case 'mid': {
      const p = P(con.p), l = lineAcc(sys, con.e);
      if (!l) break;
      const v = [...p.v, ...l.v];
      add(con, v, (X) => p.x(X) - (l.a.x(X) + l.b.x(X)) / 2);
      add(con, v, (X) => p.y(X) - (l.a.y(X) + l.b.y(X)) / 2);
      break;
    }
    case 'd': {
      if (con.drv) break;
      const f = dimFn(sys, con);
      if (f) add(con, f.v, (X) => f.f(X) - f.target);
      break;
    }
    case 'drag': {   // soft pull used while dragging
      const p = P(con.p), w = con.w;
      add(con, p.v, (X) => w * (p.x(X) - con.x)); add(con, p.v, (X) => w * (p.y(X) - con.y)); break;
    }
  }
}

/** Measured value of a dimension, as {v: vars, f: X => value, target}. Angles use L-scaled radians. */
function dimFn(sys, con) {
  const P = sys.P, L = sys.L;
  switch (con.k) {
    case 'len': {
      const l = lineAcc(sys, con.e); if (!l) return null;
      return { v: l.v, f: (X) => Math.hypot(l.dx(X), l.dy(X)), target: con.v };
    }
    case 'pp': {
      const a = P(con.a), b = P(con.b);
      if (con.dir === 'h') return { v: [...a.v, ...b.v], f: (X) => (b.x(X) - a.x(X)) * (con.s || 1), target: con.v };
      if (con.dir === 'v') return { v: [...a.v, ...b.v], f: (X) => (b.y(X) - a.y(X)) * (con.s || 1), target: con.v };
      return { v: [...a.v, ...b.v], f: (X) => Math.hypot(b.x(X) - a.x(X), b.y(X) - a.y(X)), target: con.v };
    }
    case 'pl': {
      const p = P(con.p), l = lineAcc(sys, con.e); if (!l) return null;
      return { v: [...p.v, ...l.v], f: (X) => sdist(l, X, p.x(X), p.y(X)) * (con.s || 1), target: con.v };
    }
    case 'll': {
      const l1 = lineAcc(sys, con.e1), l2 = lineAcc(sys, con.e2); if (!l1 || !l2) return null;
      return { v: [...l1.v, ...l2.v], f: (X) => sdist(l1, X, (l2.a.x(X) + l2.b.x(X)) / 2, (l2.a.y(X) + l2.b.y(X)) / 2) * (con.s || 1), target: con.v };
    }
    case 'dia': case 'rad': {
      const c = circAcc(sys, con.e); if (!c) return null;
      const m = con.k === 'dia' ? 2 : 1;
      return { v: c.v, f: (X) => m * c.r(X), target: con.v };
    }
    case 'ang': {
      const l1 = lineAcc(sys, con.e1), l2 = lineAcc(sys, con.e2); if (!l1 || !l2) return null;
      const t = (con.s || 1) * con.v * Math.PI / 180;
      return {
        v: [...l1.v, ...l2.v],
        f: (X) => { const a = l1.dx(X), b = l1.dy(X), c = l2.dx(X), d = l2.dy(X);
          return L * (wrapPi(Math.atan2(a * d - b * c, a * c + b * d) - t) + t); },
        target: L * t,
      };
    }
  }
  return null;
}

/** Current value of a dimension in its own units (mm or degrees, unsigned for display). */
export function measure(sk, con) {
  const sys = buildSystem(sk);
  const f = dimFn(sys, { ...con, drv: false, v: 0 });
  if (!f) return 0;
  let v = f.f(sys.x);
  if (con.k === 'ang') return Math.abs(v / sys.L) * 180 / Math.PI;
  return Math.abs(v);
}

/** Raw signed measurement (used to pick a sign when a dimension is created). */
export function measureSigned(sk, con) {
  const sys = buildSystem(sk);
  const f = dimFn(sys, { ...con, s: 1, v: 0 });
  if (!f) return 0;
  const v = f.f(sys.x);
  return con.k === 'ang' ? (v / sys.L) * 180 / Math.PI : v;
}

// ------------------------------------------------------------------ numerics

function evalR(eqs, X) {
  const r = new Float64Array(eqs.length);
  for (let i = 0; i < eqs.length; i++) r[i] = eqs[i].f(X);
  return r;
}

/** Dense Jacobian over the given unknown columns (cols: global indices). */
function jacobian(eqs, X, cols) {
  const n = cols.length, m = eqs.length;
  const colPos = new Map(cols.map((c, i) => [c, i]));
  const J = new Array(m);
  for (let i = 0; i < m; i++) {
    const row = new Float64Array(n);
    const e = eqs[i];
    for (const g of e.vars) {
      const j = colPos.get(g);
      if (j === undefined) continue;
      const x0 = X[g], h = 1e-6 * (1 + Math.abs(x0));
      X[g] = x0 + h; const fp = e.f(X);
      X[g] = x0 - h; const fm = e.f(X);
      X[g] = x0;
      row[j] = (fp - fm) / (2 * h);
    }
    J[i] = row;
  }
  return J;
}

/** Solve symmetric positive-definite A y = b in place (Cholesky). Returns null if not PD. */
function chol(A, b, k) {
  const Lm = new Float64Array(k * k);
  for (let i = 0; i < k; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * k + j];
      for (let p = 0; p < j; p++) s -= Lm[i * k + p] * Lm[j * k + p];
      if (i === j) { if (s <= 0) return null; Lm[i * k + i] = Math.sqrt(s); }
      else Lm[i * k + j] = s / Lm[j * k + j];
    }
  }
  const y = new Float64Array(k);
  for (let i = 0; i < k; i++) { let s = b[i]; for (let p = 0; p < i; p++) s -= Lm[i * k + p] * y[p]; y[i] = s / Lm[i * k + i]; }
  for (let i = k - 1; i >= 0; i--) { let s = y[i]; for (let p = i + 1; p < k; p++) s -= Lm[p * k + i] * y[p]; y[i] = s / Lm[i * k + i]; }
  return y;
}

/** One LM step direction for damping mu. Minimum-norm (dual) form when m <= n. */
function lmStep(J, r, m, n, mu) {
  if (m <= n) {
    const A = new Float64Array(m * m);
    for (let i = 0; i < m; i++) for (let j = 0; j <= i; j++) {
      let s = 0; const a = J[i], b = J[j];
      for (let p = 0; p < n; p++) s += a[p] * b[p];
      A[i * m + j] = A[j * m + i] = s;
    }
    for (let i = 0; i < m; i++) A[i * m + i] += mu;
    const y = chol(A, r, m);
    if (!y) return null;
    const dx = new Float64Array(n);
    for (let i = 0; i < m; i++) { const yi = y[i], a = J[i]; if (yi) for (let p = 0; p < n; p++) dx[p] -= a[p] * yi; }
    return dx;
  }
  const A = new Float64Array(n * n), g = new Float64Array(n);
  for (let i = 0; i < m; i++) {
    const a = J[i], ri = r[i];
    for (let p = 0; p < n; p++) {
      const ap = a[p]; if (!ap) continue;
      g[p] -= ap * ri;
      for (let q = 0; q <= p; q++) A[p * n + q] += ap * a[q];
    }
  }
  for (let p = 0; p < n; p++) { for (let q = 0; q < p; q++) A[q * n + p] = A[p * n + q]; A[p * n + p] += mu; }
  return chol(A, g, n);
}

const norm2 = (r) => { let s = 0; for (let i = 0; i < r.length; i++) s += r[i] * r[i]; return s; };
const maxAbs = (r) => { let s = 0; for (let i = 0; i < r.length; i++) s = Math.max(s, Math.abs(r[i])); return s; };

/** Levenberg-Marquardt on one component. X is modified in place. */
function lm(eqs, X, cols, maxIt = MAX_IT) {
  let r = evalR(eqs, X), cost = norm2(r);
  if (maxAbs(r) < EPS_RES) return true;
  let mu = 1e-9;
  const n = cols.length, m = eqs.length;
  for (let it = 0; it < maxIt; it++) {
    const J = jacobian(eqs, X, cols);
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const dx = lmStep(J, r, m, n, mu);
      if (!dx) { mu = Math.max(mu * 10, 1e-9); continue; }
      const old = cols.map((c) => X[c]);
      for (let p = 0; p < n; p++) X[cols[p]] += dx[p];
      const r2 = evalR(eqs, X), c2 = norm2(r2);
      if (c2 < cost && Number.isFinite(c2)) {
        r = r2; cost = c2; mu = Math.max(mu / 10, 1e-12); improved = true;
        break;
      }
      for (let p = 0; p < n; p++) X[cols[p]] = old[p];
      mu = Math.max(mu * 10, 1e-9);
    }
    if (maxAbs(r) < 1e-11) return true;
    if (!improved) break;
  }
  return maxAbs(r) < EPS_RES;
}

/** Split equations into independent groups that share no unknowns. */
function components(sys) {
  const n = sys.x.length;
  const par = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  for (const e of sys.eqs) for (let k = 1; k < e.vars.length; k++) {
    const a = find(e.vars[0]), b = find(e.vars[k]); if (a !== b) par[a] = b;
  }
  const groups = new Map();
  sys.eqs.forEach((e, i) => {
    if (!e.vars.length) { const g = groups.get(-1) || { eqs: [], cols: new Set() }; g.eqs.push(i); groups.set(-1, g); return; }
    const root = find(e.vars[0]);
    let g = groups.get(root);
    if (!g) groups.set(root, g = { eqs: [], cols: new Set() });
    g.eqs.push(i);
    for (const v of e.vars) g.cols.add(v);
  });
  return [...groups.values()].map((g) => ({ eqs: g.eqs, cols: [...g.cols].sort((a, b) => a - b) }));
}

function writeBack(sys) {
  const { sk, pidx, ridx, x } = sys;
  for (const id in pidx) { const i = pidx[id]; sk.pts[id].x = x[i]; sk.pts[id].y = x[i + 1]; }
  for (const e of sk.ents) if (e.t === 'circle') e.r = x[ridx[e.id]];
}

/** Circles must keep a positive radius; arcs must not collapse. */
function sane(sys) {
  for (const e of sys.sk.ents) if (e.t === 'circle' && !(sys.x[sys.ridx[e.id]] > 1e-9)) return false;
  return true;
}

function solveSys(sys) {
  let ok = true;
  for (const comp of components(sys)) {
    const eqs = comp.eqs.map((i) => sys.eqs[i]);
    if (!comp.cols.length) {   // equations on constants only (e.g. dimension between origin and a fixed point)
      if (maxAbs(evalR(eqs, sys.x)) > EPS_RES) ok = false;
      continue;
    }
    if (!lm(eqs, sys.x, comp.cols)) ok = false;
  }
  return ok;
}

/**
 * Solve the sketch in place. opts.drag = [{p, x, y}] pulls points toward targets.
 * Returns true when every constraint is satisfied. On failure the sketch is left unchanged.
 */
export function solve(sk, opts = {}) {
  const save = snapshot(sk);
  if (opts.drag && opts.drag.length) {
    const extra = opts.drag.map((d) => ({ t: 'drag', p: d.p, x: d.x, y: d.y, w: 0.05 }));
    const sys = buildSystem(sk, extra);
    solveSys(sys);
    if (sane(sys)) writeBack(sys);
  }
  const sys = buildSystem(sk);
  const ok = solveSys(sys) && sane(sys);
  if (ok) writeBack(sys);
  else restore(sk, save);
  return ok;
}

export function snapshot(sk) {
  const p = {};
  for (const id in sk.pts) p[id] = [sk.pts[id].x, sk.pts[id].y];
  return { p, r: sk.ents.filter((e) => e.t === 'circle').map((e) => [e.id, e.r]) };
}

export function restore(sk, s) {
  for (const id in s.p) if (sk.pts[id]) { sk.pts[id].x = s.p[id][0]; sk.pts[id].y = s.p[id][1]; }
  const byId = new Map(sk.ents.map((e) => [e.id, e]));
  for (const [id, r] of s.r) { const e = byId.get(id); if (e) e.r = r; }
}

/**
 * Degrees-of-freedom analysis at the current geometry.
 * Returns { dof, rank, m, redundant, ok, pt: {id: full?}, ent: {id: full?} }.
 */
export function analyze(sk) {
  const sys = buildSystem(sk);
  const n = sys.x.length, m = sys.eqs.length;
  const det = new Uint8Array(n);
  let rank = 0;
  const resid = maxAbs(evalR(sys.eqs, sys.x));
  for (const comp of components(sys)) {
    const eqs = comp.eqs.map((i) => sys.eqs[i]);
    if (!comp.cols.length) continue;
    const J = jacobian(eqs, sys.x, comp.cols);
    const res = rref(J, comp.cols.length);
    rank += res.rank;
    res.det.forEach((d, j) => { if (d) det[comp.cols[j]] = 1; });
  }
  const pt = {}, ent = {};
  for (const id in sk.pts) {
    const i = sys.pidx[id];
    pt[id] = i === undefined ? true : !!(det[i] && det[i + 1]);
  }
  for (const e of sk.ents) {
    if (e.t === 'line') ent[e.id] = pt[e.a] && pt[e.b];
    else if (e.t === 'circle') ent[e.id] = pt[e.c] && !!det[sys.ridx[e.id]];
    else ent[e.id] = pt[e.c] && pt[e.a] && pt[e.b];
  }
  return { dof: n - rank, rank, m, n, redundant: rank < m, ok: resid < 1e-5, pt, ent };
}

/** Row-reduce J (m x n). det[j] = unknown j is fixed by the equations. */
function rref(J, n) {
  const m = J.length;
  const A = J.map((r) => Float64Array.from(r));
  let mx = 0;
  for (const r of A) for (let j = 0; j < n; j++) mx = Math.max(mx, Math.abs(r[j]));
  const tol = 1e-7 * Math.max(1, mx);
  const pivRow = new Int32Array(n).fill(-1);
  let row = 0;
  for (let c = 0; c < n && row < m; c++) {
    let best = row, bv = Math.abs(A[row][c]);
    for (let i = row + 1; i < m; i++) { const v = Math.abs(A[i][c]); if (v > bv) { bv = v; best = i; } }
    if (bv < tol) continue;
    [A[row], A[best]] = [A[best], A[row]];
    const pr = A[row], pv = pr[c];
    for (let j = 0; j < n; j++) pr[j] /= pv;
    for (let i = 0; i < m; i++) {
      if (i === row) continue;
      const f = A[i][c]; if (!f) continue;
      const ri = A[i];
      for (let j = 0; j < n; j++) ri[j] -= f * pr[j];
    }
    pivRow[c] = row++;
  }
  const free = [];
  for (let c = 0; c < n; c++) if (pivRow[c] < 0) free.push(c);
  const det = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    if (pivRow[c] < 0) continue;
    const r = A[pivRow[c]];
    det[c] = free.every((f) => Math.abs(r[f]) < 1e-6) ? 1 : 0;
  }
  return { rank: row, det };
}

/**
 * Try adding constraints. Returns 'ok' (added and solved), 'redundant'
 * (already implied: would over-define) or 'conflict' (cannot be satisfied).
 * The sketch is unchanged unless the result is 'ok'.
 */
export function tryAdd(sk, cons) {
  const before = analyze(sk);
  const save = snapshot(sk);
  sk.cons.push(...cons);
  if (!solve(sk)) {
    sk.cons.splice(sk.cons.length - cons.length, cons.length);
    restore(sk, save);
    return 'conflict';
  }
  const after = analyze(sk);
  const added = after.m - before.m;
  if (after.rank - before.rank < added) {
    sk.cons.splice(sk.cons.length - cons.length, cons.length);
    restore(sk, save);
    return 'redundant';
  }
  return 'ok';
}
