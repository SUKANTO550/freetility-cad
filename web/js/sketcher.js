// FreeTility CAD - sketch mode: drawing tools, snapping, relations, smart
// dimensions, trim / offset, drag with live solving, and the SVG overlay.

import * as S from './solver.js';
import * as G from './geom2d.js';
import * as ME from './edges.js';
import { toWorld } from './model.js';
import { v3 as M3 } from './mat.js';
import { U, fmtAng, parseLen, parseAng } from './units.js';
import { el, esc, toast, dialog, confirmBox, segmented, toggle, haptic, sheet } from './ui.js';

const PT_FIELDS = ['a', 'b', 'p'];
const ENT_FIELDS = ['e', 'e1', 'e2'];

const GLYPH = {
  h: 'H', v: 'V', hp: 'H', vp: 'V', par: '//', perp: '⊥', eq: '=', col: '≡', tan: 'T', conc: '◎',
  co: '●', onl: '◦', onc: '◦', mid: 'M', fix: '⚓', amid: 'M', ext: 'E', exton: 'E', extr: 'E',
};
const REL_NAME = {
  h: 'Horizontal', v: 'Vertical', hp: 'Horizontal', vp: 'Vertical', par: 'Parallel', perp: 'Perpendicular',
  eq: 'Equal', col: 'Collinear', tan: 'Tangent', conc: 'Concentric', co: 'Coincident', onl: 'Coincident',
  onc: 'Coincident', mid: 'Midpoint', fix: 'Fixed', amid: 'Midpoint', ext: 'Linked to model', exton: 'On model edge', extr: 'Radius from model',
};

export const TOOLS = [
  ['select', 'Select'], ['line', 'Line'], ['rect', 'Rectangle'], ['circle', 'Circle'], ['arc', 'Arc'],
  ['dim', 'Dimension'], ['cline', 'Centerline'], ['trim', 'Trim'], ['offset', 'Offset'], ['convert', 'Convert'],
];

export function createSketcher(ctx) {
  const { view, svg } = ctx;
  let sk = null;
  let tool = 'select';
  let sel = new Set();          // 'p:ID' | 'e:ID'
  let an = null;                // analysis
  let draft = null;             // tool state
  let cursor = null;            // {x,y} screen, for previews
  let hits = [];                // screen boxes of dims / glyphs
  let drag = null;
  let isTouch = true;
  const settings = { relations: true, grid: true };

  // ------------------------------------------------------------ coordinates
  const W = (u, v) => toWorld(sk.plane, u, v);
  const scr = (u, v) => view.toScreen(W(u, v));
  const toSk = (x, y) => view.toPlane(x, y, sk.plane) || [0, 0];
  const px = () => view.pxSize();
  const tolPx = () => (isTouch ? 20 : 9);
  /** Snap reach in px: Low / Normal / High strength. */
  const snapPx = () => {
    const st = (cfg().strength) || 'normal';
    return isTouch ? { low: 9, normal: 14, high: 22 }[st] : { low: 5, normal: 8, high: 13 }[st];
  };
  const nid = () => sk.nid++;
  const P = (id) => sk.pts[id];
  const E = (id) => sk.ents.find((e) => e.id === id);

  function addPt(u, v) { const id = nid(); sk.pts[id] = { x: u, y: v }; return id; }

  // ------------------------------------------------------------ hit testing
  function hitPoint(x, y, excl) {
    let best = null, bd = tolPx();
    for (const id in sk.pts) {
      if (excl && excl.has(id)) continue;
      const p = sk.pts[id];
      if (!p.origin && !usedPoint(id)) continue;
      const [sx, sy] = scr(p.x, p.y);
      const d = Math.hypot(sx - x, sy - y);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }
  function usedPoint(id) {
    id = String(id);
    for (const e of sk.ents) if (String(e.a) === id || String(e.b) === id || String(e.c) === id) return true;
    return false;
  }
  function hitEnt(x, y, excl) {
    const [u, v] = toSk(x, y);
    let best = null, bd = tolPx() * px();
    for (const e of sk.ents) {
      if (excl && excl.has(e.id)) continue;
      const d = G.distToEnt(sk, e, u, v);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }
  function hitBox(x, y) {
    const pad = isTouch ? 8 : 3;
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i];
      if (x >= h.x - pad && x <= h.x + h.w + pad && y >= h.y - pad && y <= h.y + h.h + pad) return h;
    }
    return null;
  }
  /** Point or entity under the finger (points win). */
  function hitItem(x, y) {
    const p = hitPoint(x, y);
    if (p != null) return { k: 'p', id: p };
    const e = hitEnt(x, y);
    if (e) return { k: 'e', id: e.id, e };
    return null;
  }

  // ------------------------------------------------------------ snapping
  const SNAP_LABEL = { pt: 'Endpoint', center: 'Center', origin: 'Origin', mid: 'Midpoint', on: 'On curve', grid: 'Grid', mon: 'On model edge' };
  const MODEL_LABEL = { v: 'Model corner', m: 'Model midpoint', c: 'Model centre' };
  const cfg = () => (ctx.snap ? ctx.snap() : { points: true, mid: true, center: true, curve: true, model: true, hv: true, grid: false, gridAuto: true, gridStep: 5 });
  let suspended = false;
  let model = { all: [], plane: [] };   // model edges: all (for Convert) and those lying in the sketch plane

  const isCenter = (id) => sk.ents.some((e) => String(e.c) === String(id));

  /** Projected model edges, rebuilt when the sketch or the edges change. */
  function setModelEdges(edges) {
    const pl = sk.plane;
    const prj = (p) => { const s = ME.toSketch(pl, p); return [s.u, s.v]; };
    const all = (edges || []).map((e, id) => {
      const n = e.pts.length / 3, pts2 = [];
      for (let i = 0; i < n; i++) pts2.push(prj([e.pts[i * 3], e.pts[i * 3 + 1], e.pts[i * 3 + 2]]));
      return { id, e, pts2, a2: prj(e.a), b2: prj(e.b), mid2: prj(e.mid), c2: e.circ ? prj(e.circ.c) : null };
    });
    const tol = Math.max(1e-3, ME.sizeOf(edges || []) * 1e-5);
    const inP = new Set(ME.inPlane(edges || [], pl, tol));
    model = { all, plane: all.filter((m) => inP.has(m.e)) };
  }

  /** Grid spacing in sketch units: from the zoom level, or the fixed setting. */
  function gridStep() {
    const c = cfg();
    if (!c.gridAuto) { const st = U.units === 'in' ? (c.gridStepIn || 0.125) * 25.4 : c.gridStep; if (st > 0) return st; }
    const rough = px() * 40;
    const p10 = Math.pow(10, Math.floor(Math.log10(rough)));
    return [1, 2, 5, 10].map((k) => k * p10).find((k) => k >= rough) || 10 * p10;
  }

  /**
   * Snap a screen point. Priority: points, centres, midpoints and model
   * corners (nearest wins) > on a curve or model edge > grid > free.
   */
  function snapAt(x, y, opt = {}) {
    const [u, v] = toSk(x, y);
    if (suspended || opt.free) return { kind: 'free', u, v };
    const c = cfg();
    const tol = snapPx() * px();
    let best = null, bd = tol;
    const take = (cand, d) => { if (d < bd) { bd = d; best = cand; } };
    // tier 1: exact points
    for (const id in sk.pts) {
      if (opt.exclPts && opt.exclPts.has(id)) continue;
      const p = sk.pts[id];
      if (!p.origin && !usedPoint(id)) continue;
      const cen = isCenter(id);
      if (cen ? !c.center : !c.points && !p.origin) continue;
      take({ kind: 'pt', id, u: p.x, v: p.y, label: p.origin ? SNAP_LABEL.origin : cen ? SNAP_LABEL.center : SNAP_LABEL.pt }, Math.hypot(p.x - u, p.y - v));
    }
    if (c.mid) {
      for (const e of sk.ents) {
        if (opt.exclEnts && opt.exclEnts.has(e.id)) continue;
        if (e.t === 'line') { const a = P(e.a), b = P(e.b); const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2; take({ kind: 'mid', e: e.id, u: mx, v: my, label: SNAP_LABEL.mid }, 1.3 * Math.hypot(mx - u, my - v)); }
        else if (e.t === 'arc') { const m = arcMid(e); take({ kind: 'mid', e: e.id, u: m[0], v: m[1], label: SNAP_LABEL.mid }, 1.3 * Math.hypot(m[0] - u, m[1] - v)); }
      }
    }
    if (c.model) {
      for (const m of model.plane) {
        if (m.e.kind !== 'curve' || !m.e.closed) {
          take({ kind: 'mpt', k: 'v', m, at: m.e.a, u: m.a2[0], v: m.a2[1], label: MODEL_LABEL.v }, 1.15 * Math.hypot(m.a2[0] - u, m.a2[1] - v));
          take({ kind: 'mpt', k: 'v', m, at: m.e.b, u: m.b2[0], v: m.b2[1], label: MODEL_LABEL.v }, 1.15 * Math.hypot(m.b2[0] - u, m.b2[1] - v));
        }
        if (c.mid && !(m.e.closed)) take({ kind: 'mpt', k: 'm', m, u: m.mid2[0], v: m.mid2[1], label: MODEL_LABEL.m }, 1.3 * Math.hypot(m.mid2[0] - u, m.mid2[1] - v));
        if (c.center && m.c2) take({ kind: 'mpt', k: 'c', m, u: m.c2[0], v: m.c2[1], label: MODEL_LABEL.c }, 1.15 * Math.hypot(m.c2[0] - u, m.c2[1] - v));
      }
    }
    if (best) return best;
    // tier 2: on a curve / model edge
    bd = tol;
    if (c.curve) {
      for (const e of sk.ents) {
        if (opt.exclEnts && opt.exclEnts.has(e.id)) continue;
        const d = G.distToEnt(sk, e, u, v);
        if (d < bd) { const [cu, cv] = G.closestOnEnt(sk, e, u, v); take({ kind: 'on', e: e.id, u: cu, v: cv, label: SNAP_LABEL.on }, d); }
      }
    }
    if (c.model) {
      for (const m of model.plane) {
        const q = closestOnPoly(m.pts2, u, v);
        if (q) take({ kind: 'mon', m, u: q[0], v: q[1], label: SNAP_LABEL.mon }, Math.hypot(q[0] - u, q[1] - v));
      }
    }
    if (best) return best;
    // tier 3: grid
    if (c.grid) {
      const g = gridStep();
      return { kind: 'grid', u: Math.round(u / g) * g, v: Math.round(v / g) * g, label: SNAP_LABEL.grid };
    }
    return { kind: 'free', u, v };
  }

  function arcMid(e) {
    const ci = G.circleInfo(sk, e), t = ci.a0 + ci.sweep / 2;
    return [ci.cx + ci.r * Math.cos(t), ci.cy + ci.r * Math.sin(t)];
  }
  function closestOnPoly(pts, u, v) {
    let best = null, bd = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      if (l2 < 1e-18) continue;
      const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / l2));
      const q = [ax + t * dx, ay + t * dy], d = Math.hypot(q[0] - u, q[1] - v);
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }

  /** Horizontal / vertical inference relative to a start point (free points only). */
  function infer(s, from) {
    if (!from || s.kind !== 'free' || suspended || !cfg().hv) return s;
    const dx = s.u - from.u, dy = s.v - from.v, len = Math.hypot(dx, dy);
    if (len < 1e-9) return s;
    const ang = Math.abs(Math.atan2(dy, dx)) * 180 / Math.PI;
    if (ang < 3 || ang > 177) return { ...s, v: from.v, hv: 'h' };
    if (Math.abs(ang - 90) < 3) return { ...s, u: from.u, hv: 'v' };
    return s;
  }

  /** Model link for a snapped model point / edge (stored on the constraint). */
  function linkCon(id, s) {
    const e = s.m.e;
    if (s.kind === 'mpt') return { id: nid(), t: 'ext', p: Number(id), x: s.u, y: s.v, ref: { k: s.k, e: ME.edgeRef(e), at: s.k === 'v' ? s.at.map((q) => Math.round(q * 1e4) / 1e4) : undefined } };
    if (e.kind === 'line') return { id: nid(), t: 'exton', p: Number(id), ref: { k: 'on', e: ME.edgeRef(e) }, line: [s.m.a2[0], s.m.a2[1], s.m.b2[0], s.m.b2[1]] };
    if (e.kind === 'circle' && e.circ && s.m.c2) return { id: nid(), t: 'exton', p: Number(id), ref: { k: 'on', e: ME.edgeRef(e) }, circ: { cx: s.m.c2[0], cy: s.m.c2[1], r: e.circ.r } };
    return null;   // a curved mesh edge: placed only
  }

  /** Turn a snap into a point id, adding the matching relation. */
  function resolve(s, later) {
    if (s.kind === 'pt') return s.id;
    const id = addPt(s.u, s.v);
    if (s.kind === 'on') {
      const e = E(s.e);
      later.push(e.t === 'line' ? { id: nid(), t: 'onl', p: id, e: s.e } : { id: nid(), t: 'onc', p: id, e: s.e });
    } else if (s.kind === 'mid') {
      later.push(E(s.e).t === 'arc' ? { id: nid(), t: 'amid', p: id, e: s.e } : { id: nid(), t: 'mid', p: id, e: s.e });
    } else if (s.kind === 'mpt' || s.kind === 'mon') {
      const c = linkCon(id, s);
      if (c) later.push(c);
    }
    return id;
  }

  function applyLater(list) {
    for (const c of list) {
      const r = S.tryAdd(sk, [c]);
      if (r !== 'ok') { /* skip relations that would over-define */ }
    }
  }

  // ------------------------------------------------------------ change handling
  function changed(label, keepSel) {
    if (!keepSel) sel.clear();
    S.solve(sk);
    cleanup();
    an = S.analyze(sk);
    render();
    status();
    chips();
    ctx.onCommit && ctx.onCommit(label);
  }

  function cleanup() {
    // remove constraints that point at missing items, then unused points
    for (let pass = 0; pass < 3; pass++) {
      const ents = new Set(sk.ents.map((e) => e.id));
      sk.cons = sk.cons.filter((c) => ENT_FIELDS.every((f) => c[f] == null || ents.has(c[f]))
        && PT_FIELDS.every((f) => c[f] == null || sk.pts[c[f]]));
      const used = new Set(['0']);
      for (const e of sk.ents) for (const f of ['a', 'b', 'c']) if (e[f] != null) used.add(String(e[f]));
      let removed = false;
      for (const id in sk.pts) if (!used.has(id)) { delete sk.pts[id]; removed = true; }
      if (!removed) break;
    }
  }

  function status() {
    if (!ctx.onStatus || !an) return;
    const broken = sk.cons.filter((c) => c.broken).length;
    if (broken) ctx.onStatus({ text: `${broken} broken link${broken > 1 ? 's' : ''} to the model`, kind: 'bad' });
    else if (!an.ok) ctx.onStatus({ text: 'Cannot solve', kind: 'bad' });
    else if (an.redundant) ctx.onStatus({ text: 'Over defined', kind: 'bad' });
    else if (an.dof === 0) ctx.onStatus({ text: 'Fully defined', kind: 'full' });
    else ctx.onStatus({ text: `Under defined · ${an.dof} DOF`, kind: 'under' });
  }

  function hint(t) { ctx.onHint && ctx.onHint(t); }

  // ------------------------------------------------------------ rendering
  const COL = { under: 'var(--sk-under)', full: 'var(--sk-full)', bad: 'var(--sk-bad)', sel: 'var(--sk-sel)', cons: 'var(--sk-cons)', draft: 'var(--sk-draft)' };

  function colorOfEnt(e) {
    if (sel.has('e:' + e.id)) return COL.sel;
    if (drag && drag.ents && drag.ents.has(e.id)) return COL.sel;
    if (an && (!an.ok || an.redundant)) return COL.bad;
    return an && an.ent[e.id] ? COL.full : COL.under;
  }

  function polyStr(pts) { return pts.map(([u, v]) => { const s = scr(u, v); return s[0].toFixed(1) + ',' + s[1].toFixed(1); }).join(' '); }

  function render() {
    if (!sk) { svg.innerHTML = ''; return; }
    hits = [];
    const out = [];
    if (settings.grid || cfg().grid) out.push(gridSvg());
    out.push(modelSvg());
    const tol = px() * 0.6;
    // origin
    {
      const [ox, oy] = scr(0, 0), [xx, xy] = scr(px() * 26, 0), [yx, yy] = scr(0, px() * 26);
      out.push(`<g class="org"><line x1="${ox}" y1="${oy}" x2="${xx}" y2="${xy}" stroke="#d9534f" stroke-width="1.6"/><line x1="${ox}" y1="${oy}" x2="${yx}" y2="${yy}" stroke="#3fa34d" stroke-width="1.6"/><circle cx="${ox}" cy="${oy}" r="3" fill="#d9534f"/></g>`);
    }
    // entities
    for (const e of sk.ents) {
      const pts = G.tess(sk, e, tol);
      const col = colorOfEnt(e);
      const w = sel.has('e:' + e.id) ? 2.8 : 2;
      const dash = e.cons ? ' stroke-dasharray="9 4 2 4"' : '';
      const tag = e.t === 'circle' ? 'polygon' : 'polyline';
      out.push(`<${tag} points="${polyStr(pts)}" fill="none" stroke="${col}" stroke-width="${w}"${dash}/>`);
    }
    // midpoint markers while drawing
    if (tool !== 'select' && tool !== 'trim' && tool !== 'convert' && cfg().mid && !suspended) {
      for (const e of sk.ents) {
        if (e.t !== 'line' && e.t !== 'arc') continue;
        let m;
        if (e.t === 'line') { const a = P(e.a), b = P(e.b); m = [(a.x + b.x) / 2, (a.y + b.y) / 2]; } else m = arcMid(e);
        const [x, y] = scr(m[0], m[1]);
        out.push(`<path d="M${x.toFixed(1)} ${(y - 4.5).toFixed(1)}l4 6.5h-8z" class="midm"/>`);
      }
    }
    // points
    for (const id in sk.pts) {
      const p = sk.pts[id];
      if (p.origin || !usedPoint(id)) continue;
      const [x, y] = scr(p.x, p.y);
      const s = sel.has('p:' + id);
      const col = s ? COL.sel : an && (!an.ok || an.redundant) ? COL.bad : an && an.pt[id] ? COL.full : COL.under;
      out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${s ? 5 : 3.2}" fill="${col}"/>`);
    }
    // dimensions
    for (const c of sk.cons) if (c.t === 'd') out.push(dimSvg(c));
    // relation glyphs
    if (settings.relations) out.push(glyphsSvg());
    // draft preview
    out.push(draftSvg());
    svg.innerHTML = out.join('');
  }

  function gridSvg() {
    const step = gridStep();
    if (step / px() < 6) return '';
    const r = svg.getBoundingClientRect();
    const corners = [[0, 0], [r.width, 0], [0, r.height], [r.width, r.height]].map(([x, y]) => toSk(x, y));
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (const [u, v] of corners) { mnx = Math.min(mnx, u); mxx = Math.max(mxx, u); mny = Math.min(mny, v); mxy = Math.max(mxy, v); }
    if (!Number.isFinite(mnx) || (mxx - mnx) / step > 400) return '';
    let d = '', dm = '';
    for (let u = Math.ceil(mnx / step) * step; u <= mxx; u += step) {
      const [a, b] = [scr(u, mny), scr(u, mxy)];
      const major = Math.abs(Math.round(u / step) % 5) === 0;
      const seg = `M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
      if (major) dm += seg; else d += seg;
    }
    for (let v = Math.ceil(mny / step) * step; v <= mxy; v += step) {
      const [a, b] = [scr(mnx, v), scr(mxx, v)];
      const major = Math.abs(Math.round(v / step) % 5) === 0;
      const seg = `M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
      if (major) dm += seg; else d += seg;
    }
    return `<path d="${d}" stroke="var(--grid)" stroke-width="1" fill="none"/><path d="${dm}" stroke="var(--grid2)" stroke-width="1" fill="none"/>`;
  }

  // ---- model edges (in the sketch plane; all of them while converting)
  function modelSvg() {
    const out = [];
    const list = tool === 'convert' ? model.all : cfg().model && !suspended ? model.plane : [];
    const picked = tool === 'convert' && draft && draft.conv ? draft.conv : null;
    for (const m of list) {
      const on = picked && picked.has(m.id);
      out.push(`<polyline points="${polyStr(m.pts2)}" fill="none" class="medge${on ? ' on' : ''}${tool === 'convert' ? ' cv' : ''}"/>`);
    }
    return out.join('');
  }

  // ---- dimensions
  function dimText(c) {
    let t;
    if (c.k === 'ang') t = fmtAng(c.drv ? S.measure(sk, c) : c.v);
    else {
      const v = c.drv ? S.measure(sk, c) : c.v;
      t = (c.k === 'dia' ? '⌀' : c.k === 'rad' ? 'R' : '') + U.fmt(v);
    }
    return c.drv ? '(' + t + ')' : t;
  }

  /** Base geometry of a dimension in sketch coordinates. */
  function dimBase(c) {
    switch (c.k) {
      case 'len': { const e = E(c.e); if (!e) return null; const a = P(e.a), b = P(e.b); return { kind: 'lin', A: [a.x, a.y], B: [b.x, b.y] }; }
      case 'pp': {
        const a = P(c.a), b = P(c.b); if (!a || !b) return null;
        return { kind: c.dir === 'h' ? 'h' : c.dir === 'v' ? 'v' : 'lin', A: [a.x, a.y], B: [b.x, b.y] };
      }
      case 'pl': {
        const p = P(c.p), e = E(c.e); if (!p || !e) return null;
        const a = P(e.a), b = P(e.b), f = foot(p.x, p.y, a, b);
        return { kind: 'lin', A: [p.x, p.y], B: f, line: [a, b] };
      }
      case 'll': {
        const l1 = E(c.e1), l2 = E(c.e2); if (!l1 || !l2) return null;
        const a = P(l1.a), b = P(l1.b), m = [(P(l2.a).x + P(l2.b).x) / 2, (P(l2.a).y + P(l2.b).y) / 2];
        return { kind: 'lin', A: m, B: foot(m[0], m[1], a, b), line: [a, b] };
      }
      case 'dia': case 'rad': {
        const e = E(c.e); if (!e) return null;
        const ci = G.circleInfo(sk, e);
        return { kind: c.k, C: [ci.cx, ci.cy], r: ci.r };
      }
      case 'ang': {
        const l1 = E(c.e1), l2 = E(c.e2); if (!l1 || !l2) return null;
        return { kind: 'ang', l1: [P(l1.a), P(l1.b)], l2: [P(l2.a), P(l2.b)] };
      }
    }
    return null;
  }
  function foot(x, y, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const t = ((x - a.x) * dx + (y - a.y) * dy) / l2;
    return [a.x + t * dx, a.y + t * dy];
  }
  /** Label anchor (sketch) of a dimension. */
  function dimAnchor(c, b) {
    const off = c.off || [0, 0];
    if (b.kind === 'lin' || b.kind === 'h' || b.kind === 'v') return [(b.A[0] + b.B[0]) / 2 + off[0], (b.A[1] + b.B[1]) / 2 + off[1]];
    if (b.kind === 'dia' || b.kind === 'rad') return [b.C[0] + off[0], b.C[1] + off[1]];
    if (b.kind === 'ang') {
      const X = lineCross(b.l1, b.l2) || [(b.l1[0].x + b.l2[0].x) / 2, (b.l1[0].y + b.l2[0].y) / 2];
      return [X[0] + off[0], X[1] + off[1]];
    }
    return [0, 0];
  }
  function lineCross(l1, l2) {
    const d1 = [l1[1].x - l1[0].x, l1[1].y - l1[0].y], d2 = [l2[1].x - l2[0].x, l2[1].y - l2[0].y];
    return G.lineX([l1[0].x, l1[0].y], d1, [l2[0].x, l2[0].y], d2);
  }

  function arrow(x, y, ang) {
    const s = 9, w = 3.2;
    const c = Math.cos(ang), n = Math.sin(ang);
    return `<path d="M${x} ${y}L${x - s * c + w * n} ${y - s * n - w * c}L${x - s * c - w * n} ${y - s * n + w * c}z" fill="var(--dim)"/>`;
  }

  function dimSvg(c) {
    const b = dimBase(c);
    if (!b) return '';
    const L = dimAnchor(c, b);
    const [lx, ly] = scr(L[0], L[1]);
    const out = [];
    const line = (p, q, cls = '') => out.push(`<line x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${q[0].toFixed(1)}" y2="${q[1].toFixed(1)}" class="dl ${cls}"/>`);
    if (b.kind === 'lin' || b.kind === 'h' || b.kind === 'v') {
      let A = b.A, B = b.B, A2, B2;
      if (b.kind === 'h') { A2 = [A[0], L[1]]; B2 = [B[0], L[1]]; }
      else if (b.kind === 'v') { A2 = [L[0], A[1]]; B2 = [L[0], B[1]]; }
      else {
        let dx = B[0] - A[0], dy = B[1] - A[1];
        const len = Math.hypot(dx, dy) || 1;
        const n = [-dy / len, dx / len];
        const d = (L[0] - A[0]) * n[0] + (L[1] - A[1]) * n[1];
        A2 = [A[0] + n[0] * d, A[1] + n[1] * d]; B2 = [B[0] + n[0] * d, B[1] + n[1] * d];
      }
      const sA = scr(...A), sB = scr(...B), sA2 = scr(...A2), sB2 = scr(...B2);
      line(sA, sA2, 'ext'); line(sB, sB2, 'ext');
      line(sA2, sB2);
      // extend the dimension line to the label if it sits outside
      const t = projT(sA2, sB2, [lx, ly]);
      if (t < 0) line(sA2, [lx, ly]); else if (t > 1) line(sB2, [lx, ly]);
      const ang = Math.atan2(sB2[1] - sA2[1], sB2[0] - sA2[0]);
      out.push(arrow(sA2[0], sA2[1], ang + Math.PI), arrow(sB2[0], sB2[1], ang));
      if (b.line) {   // dashed extension of the reference line to the foot
        const [a, bb] = b.line, f = b.B, ends = [[a.x, a.y], [bb.x, bb.y]];
        const near = ends.reduce((m, p) => (Math.hypot(p[0] - f[0], p[1] - f[1]) < Math.hypot(m[0] - f[0], m[1] - f[1]) ? p : m));
        line(scr(...near), scr(...f), 'ext');
      }
    } else if (b.kind === 'dia' || b.kind === 'rad') {
      let u = [L[0] - b.C[0], L[1] - b.C[1]];
      const ul = Math.hypot(u[0], u[1]);
      u = ul > 1e-9 ? [u[0] / ul, u[1] / ul] : [1, 0];
      const p1 = [b.C[0] + u[0] * b.r, b.C[1] + u[1] * b.r];
      const s1 = scr(...p1);
      const start = b.kind === 'dia' ? scr(b.C[0] - u[0] * b.r, b.C[1] - u[1] * b.r) : scr(...b.C);
      const far = ul > b.r ? [lx, ly] : s1;
      line(start, far);
      const ang = Math.atan2(s1[1] - start[1], s1[0] - start[0]);
      out.push(arrow(s1[0], s1[1], ul > b.r ? ang + Math.PI : ang));
      if (b.kind === 'dia') out.push(arrow(start[0], start[1], ul > b.r ? ang : ang + Math.PI));
    } else if (b.kind === 'ang') {
      const X = lineCross(b.l1, b.l2);
      if (X) {
        const R = Math.hypot(L[0] - X[0], L[1] - X[1]);
        const dirOf = (l) => {
          const m = [(l[0].x + l[1].x) / 2 - X[0], (l[0].y + l[1].y) / 2 - X[1]];
          return Math.atan2(m[1], m[0]);
        };
        let a1 = dirOf(b.l1), a2 = dirOf(b.l2);
        let sw = a2 - a1;
        while (sw > Math.PI) sw -= 2 * Math.PI;
        while (sw < -Math.PI) sw += 2 * Math.PI;
        const n = 24, pts = [];
        for (let i = 0; i <= n; i++) { const t = a1 + sw * i / n; pts.push(scr(X[0] + R * Math.cos(t), X[1] + R * Math.sin(t))); }
        out.push(`<polyline points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}" class="dl" fill="none"/>`);
        const e1 = pts[0], e2 = pts[n], p1 = pts[1], p2 = pts[n - 1];
        out.push(arrow(e1[0], e1[1], Math.atan2(e1[1] - p1[1], e1[0] - p1[0])), arrow(e2[0], e2[1], Math.atan2(e2[1] - p2[1], e2[0] - p2[0])));
      }
    }
    const text = dimText(c);
    const w = text.length * 7.6 + 10, h = 19;
    const bx = lx - w / 2, by = ly - h / 2;
    hits.push({ kind: 'dim', con: c, x: bx, y: by, w, h });
    out.push(`<g class="dim${c.drv ? ' drv' : ''}"><rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="4"/><text x="${lx.toFixed(1)}" y="${(ly + 4.6).toFixed(1)}">${esc(text)}</text></g>`);
    return out.join('');
  }
  function projT(a, b, p) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    return ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  }

  // ---- relation glyphs
  function glyphAnchors(c) {
    const mid = (e) => {
      if (!e) return null;
      if (e.t === 'line') { const a = P(e.a), b = P(e.b); return [(a.x + b.x) / 2, (a.y + b.y) / 2]; }
      const ci = G.circleInfo(sk, e);
      const t = ci.a0 + ci.sweep / 2;
      return [ci.cx + ci.r * Math.cos(t), ci.cy + ci.r * Math.sin(t)];
    };
    const pt = (id) => { const p = P(id); return p ? [p.x, p.y] : null; };
    switch (c.t) {
      case 'h': case 'v': return [mid(E(c.e))];
      case 'hp': case 'vp': case 'co': return [pt(c.a), c.t === 'co' ? null : pt(c.b)];
      case 'fix': case 'ext': case 'exton': return [pt(c.p)];
      case 'extr': return [mid(E(c.e))];
      case 'onl': case 'onc': case 'mid': case 'amid': return [pt(c.p)];
      default: return [mid(E(c.e1)), mid(E(c.e2))];
    }
  }
  function glyphsSvg() {
    const out = [];
    const stack = new Map();
    for (const c of sk.cons) {
      if (c.t === 'd' || !GLYPH[c.t]) continue;
      for (const a of glyphAnchors(c)) {
        if (!a) continue;
        const [x, y] = scr(a[0], a[1]);
        const key = Math.round(x / 6) + ',' + Math.round(y / 6);
        const k = stack.get(key) || 0; stack.set(key, k + 1);
        const gx = x + 8 + k * 17, gy = y - 22;
        const selC = sel.has('c:' + c.id);
        hits.push({ kind: 'glyph', con: c, x: gx, y: gy, w: 15, h: 15 });
        out.push(`<g class="gy${selC ? ' on' : ''}${c.broken ? ' bad' : c.t.startsWith('ext') ? ' link' : ''}"><rect x="${gx.toFixed(1)}" y="${gy.toFixed(1)}" width="15" height="15" rx="3"/><text x="${(gx + 7.5).toFixed(1)}" y="${(gy + 11.4).toFixed(1)}">${GLYPH[c.t]}</text></g>`);
      }
    }
    return out.join('');
  }

  // ---- draft preview
  function snapMark(s) {
    if (!s) return '';
    const [x, y] = scr(s.u, s.v);
    let m = '';
    const model = s.kind === 'mpt' || s.kind === 'mon';
    const cls = 'snap' + (model ? ' model' : '');
    if (s.kind === 'pt' || (s.kind === 'mpt' && s.k !== 'm')) m = `<circle cx="${x}" cy="${y}" r="8" class="${cls}"/>`;
    else if (s.kind === 'on' || s.kind === 'mon') m = `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" class="${cls}"/>`;
    else if (s.kind === 'mid' || s.kind === 'mpt') m = `<path d="M${x} ${y - 7}L${x + 7} ${y + 5}L${x - 7} ${y + 5}z" class="${cls}"/>`;
    else if (s.kind === 'grid') m = `<path d="M${x - 7} ${y}h14M${x} ${y - 7}v14" class="${cls}"/>`;
    const label = s.label ? s.label + (s.hv ? ' · ' + s.hv.toUpperCase() : '') : s.hv ? s.hv.toUpperCase() : '';
    if (label) {
      const w = label.length * 6.6 + 12, W = svg.getBoundingClientRect().width;
      const lx = x + 12 + w > W - 4 ? x - 12 - w : x + 12;
      m += `<g class="snapl${model ? ' model' : ''}"><rect x="${lx}" y="${y - 30}" width="${w}" height="18" rx="5"/><text x="${lx + 6}" y="${y - 17}">${esc(label)}</text></g>`;
    }
    return m;
  }
  function draftSvg() {
    if (drag && drag.kind === 'p' && drag.snap) return snapMark(drag.snap);
    if (!draft || (!draft.cur && cursorSnap)) return cursorSnap ? snapMark(cursorSnap) : '';
    const out = [];
    const L = (a, b) => { const p = scr(a.u, a.v), q = scr(b.u, b.v); out.push(`<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" class="draft"/>`); };
    const cur = draft.cur;
    if ((tool === 'line' || tool === 'cline') && draft.start && cur) L(draft.start, cur);
    if (tool === 'rect' && draft.c1 && cur) {
      const a = draft.c1, c = cur, b = { u: c.u, v: a.v }, d = { u: a.u, v: c.v };
      L(a, b); L(b, c); L(c, d); L(d, a);
      out.push(sizeLabel(cur, U.fmt(Math.abs(c.u - a.u)) + ' × ' + U.fmt(Math.abs(c.v - a.v))));
    }
    if (tool === 'circle' && draft.c && cur) {
      const r = Math.hypot(cur.u - draft.c.u, cur.v - draft.c.v);
      const pts = []; for (let i = 0; i <= 64; i++) { const t = i / 64 * Math.PI * 2; pts.push(scr(draft.c.u + r * Math.cos(t), draft.c.v + r * Math.sin(t))); }
      out.push(`<polyline points="${pts.map((p) => p.join(',')).join(' ')}" class="draft" fill="none"/>`);
      L(draft.c, cur);
      out.push(sizeLabel(cur, '⌀' + U.fmt(2 * r)));
    }
    if (tool === 'arc' && draft.c) {
      if (!draft.s && cur) L(draft.c, cur);
      if (draft.s && cur) {
        const r = Math.hypot(draft.s.u - draft.c.u, draft.s.v - draft.c.v);
        const a0 = Math.atan2(draft.s.v - draft.c.v, draft.s.u - draft.c.u);
        const sw = draft.sweep || 0;
        const pts = []; for (let i = 0; i <= 48; i++) { const t = a0 + sw * i / 48; pts.push(scr(draft.c.u + r * Math.cos(t), draft.c.v + r * Math.sin(t))); }
        out.push(`<polyline points="${pts.map((p) => p.join(',')).join(' ')}" class="draft" fill="none"/>`);
        L(draft.c, draft.s);
        out.push(sizeLabel(cur, 'R' + U.fmt(r) + '  ' + fmtAng(Math.abs(sw) * 180 / Math.PI)));
      }
    }
    if (draft.offset) out.push(draft.offset);
    if ((tool === 'line' || tool === 'cline') && draft.start && cur) out.push(sizeLabel(cur, U.fmt(Math.hypot(cur.u - draft.start.u, cur.v - draft.start.v))));
    out.push(snapMark(cur));
    for (const k of ['start', 'c1', 'c', 's']) if (draft[k]) { const [x, y] = scr(draft[k].u, draft[k].v); out.push(`<circle cx="${x}" cy="${y}" r="4" fill="var(--sk-draft)"/>`); }
    if (draft.first) out.push(firstMark(draft.first));
    return out.join('');
  }
  let cursorSnap = null;
  const FIRST_PT_TOOLS = ['line', 'cline', 'rect', 'circle', 'arc'];
  /** Has the current drawing tool already placed its first point? */
  const hasFirstPoint = () => !!draft && !!(draft.start || draft.c1 || draft.c);
  function sizeLabel(at, text) {
    const [x, y] = scr(at.u, at.v);
    const w = text.length * 7.2 + 10;
    return `<g class="szl"><rect x="${x + 14}" y="${y + 10}" width="${w}" height="18" rx="4"/><text x="${x + 19}" y="${y + 23}">${esc(text)}</text></g>`;
  }
  function firstMark(it) {
    if (it.k === 'p') { const p = P(it.id); const [x, y] = scr(p.x, p.y); return `<circle cx="${x}" cy="${y}" r="7" class="snap"/>`; }
    const e = E(it.id); if (!e) return '';
    return `<polyline points="${polyStr(G.tess(sk, e, px()))}" fill="none" stroke="var(--sk-sel)" stroke-width="4" opacity=".55"${e.t === 'circle' ? '' : ''}/>`;
  }

  // ------------------------------------------------------------ entity creation
  function makeLine(s1, s2, cons) {
    const later = [];
    const a = resolve(s1, later);
    const b = resolve(s2, later);
    if (String(a) === String(b)) return null;
    const pa = P(a), pb = P(b);
    if (Math.hypot(pa.x - pb.x, pa.y - pb.y) < 1e-6) return null;
    const e = { id: nid(), t: 'line', a: Number(a), b: Number(b) };
    if (cons) e.cons = true;
    sk.ents.push(e);
    if (s2.hv === 'h') later.push({ id: nid(), t: 'h', e: e.id });
    if (s2.hv === 'v') later.push({ id: nid(), t: 'v', e: e.id });
    applyLater(later);
    return e;
  }

  // ------------------------------------------------------------ tools
  const T = {};

  T.select = {
    down(x, y) {
      const hb = hitBox(x, y);
      if (hb) { drag = { kind: hb.kind, con: hb.con, x0: x, y0: y, moved: false, off0: hb.con.off ? [...hb.con.off] : [0, 0] }; return true; }
      const it = hitItem(x, y);
      if (!it) return false;
      drag = { kind: it.k, id: it.id, x0: x, y0: y, moved: false, start: toSk(x, y), snapshot: S.snapshot(sk) };
      if (it.k === 'e') {
        const e = E(it.id);
        drag.ents = new Set([e.id]);
        drag.orig = {};
        for (const f of ['a', 'b', 'c']) if (e[f] != null) drag.orig[e[f]] = [P(e[f]).x, P(e[f]).y];
        if (e.t === 'circle') drag.r0 = e.r;
      }
      return true;
    },
    move(x, y) {
      if (!drag) return;
      if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) < 8) return;
      drag.moved = true;
      const [u, v] = toSk(x, y);
      if (drag.kind === 'dim') {
        const s0 = toSk(drag.x0, drag.y0);
        drag.con.off = [drag.off0[0] + u - s0[0], drag.off0[1] + v - s0[1]];
        render();
        return;
      }
      if (drag.kind === 'glyph') return;
      if (drag.kind === 'p') {
        if (sk.pts[drag.id].origin) return;
        if (!drag.excl) {   // never snap a point to itself or to the curves it belongs to
          drag.excl = { exclPts: new Set([String(drag.id)]), exclEnts: new Set(sk.ents.filter((e) => [e.a, e.b, e.c].map(String).includes(String(drag.id))).map((e) => e.id)) };
        }
        const sn = snapAt(x, y, drag.excl);
        drag.snap = sn.kind === 'free' ? null : sn;
        S.solve(sk, { drag: [{ p: drag.id, x: sn.u, y: sn.v }] });
      } else {
        const e = E(drag.id);
        if (e.t === 'line') {
          const du = u - drag.start[0], dv = v - drag.start[1];
          S.solve(sk, { drag: [e.a, e.b].map((id) => ({ p: id, x: drag.orig[id][0] + du, y: drag.orig[id][1] + dv })) });
        } else if (e.t === 'circle') {
          const c = P(e.c);
          const keep = e.r;
          e.r = Math.max(1e-3, Math.hypot(u - c.x, v - c.y));
          if (!S.solve(sk)) e.r = keep;
        } else {
          const c = P(e.c), R = Math.max(1e-3, Math.hypot(u - c.x, v - c.y));
          const tgt = [e.a, e.b].map((id) => { const p = P(id), l = Math.hypot(p.x - c.x, p.y - c.y) || 1; return { p: id, x: c.x + (p.x - c.x) * R / l, y: c.y + (p.y - c.y) * R / l }; });
          S.solve(sk, { drag: tgt });
        }
      }
      render();
    },
    up(x, y) {
      const d = drag; drag = null;
      if (!d) return;
      if (!d.moved) { tapSelect(x, y, d); return; }
      if (d.kind === 'dim') { render(); ctx.onCommit && ctx.onCommit('Move dimension'); return; }
      if (d.kind === 'p' && d.snap) dropOnSnap(Number(d.id), d.snap);
      changed('Drag', true);
    },
    cancel() {
      if (drag && drag.snapshot && drag.moved) S.restore(sk, drag.snapshot);
      if (drag && drag.kind === 'dim') drag.con.off = drag.off0;
      drag = null; render();
    },
    tap(x, y) { tapSelect(x, y, null); },
  };

  /** A dragged point dropped on a snap target gets the matching relation. */
  function dropOnSnap(id, s) {
    let con = null;
    if (s.kind === 'pt') { if (String(s.id) !== String(id)) con = { id: nid(), t: 'co', a: id, b: Number(s.id) }; }
    else if (s.kind === 'on') { const e = E(s.e); con = { id: nid(), t: e.t === 'line' ? 'onl' : 'onc', p: id, e: s.e }; }
    else if (s.kind === 'mid') con = { id: nid(), t: E(s.e).t === 'arc' ? 'amid' : 'mid', p: id, e: s.e };
    else if (s.kind === 'mpt' || s.kind === 'mon') con = linkCon(id, s);
    if (!con) return;
    const r = S.tryAdd(sk, [con]);
    if (r === 'redundant') toast('Already placed there: no new relation needed');
    else if (r !== 'ok') toast('Could not attach it there: it conflicts with other relations');
  }

  function tapSelect(x, y, d) {
    const hb = d && (d.kind === 'dim' || d.kind === 'glyph') ? { kind: d.kind, con: d.con } : hitBox(x, y);
    if (hb && hb.kind === 'dim') { editDim(hb.con); return; }
    if (hb && hb.kind === 'glyph') { relMenu(hb.con); return; }
    const it = hitItem(x, y);
    if (!it) { if (sel.size) { sel.clear(); render(); chips(); } return; }
    const key = it.k + ':' + it.id;
    if (sel.has(key)) sel.delete(key); else sel.add(key);
    haptic();
    render(); chips();
  }

  // ---- line / centerline
  const lineTool = (cons) => ({
    down(x, y) {
      draft = draft || {};
      draft.downXY = [x, y];
      draft.downSnap = infer(snapAt(x, y), draft.start);
      draft.cur = draft.downSnap;
      render();
      return true;
    },
    move(x, y) { if (!draft) return; draft.cur = infer(snapAt(x, y, draft.excl), draft.start || draft.downSnap); render(); },
    hover(x, y) { cursor = [x, y]; if (draft && (draft.start)) { draft.cur = infer(snapAt(x, y, draft.excl), draft.start); } else { cursorSnap = snapAt(x, y); if (cursorSnap.kind === 'free') cursorSnap = null; } render(); },
    up(x, y) {
      if (!draft) return;
      const moved = draft.downXY && Math.hypot(x - draft.downXY[0], y - draft.downXY[1]) > 10;
      const endSnap = infer(snapAt(x, y, draft.excl), draft.start || draft.downSnap);
      if (!draft.start) {
        if (!moved) { draft.start = draft.downSnap; draft.cur = null; hint(cons ? 'Tap the end of the centerline' : 'Tap the next point · tap ✓ to finish the chain'); render(); return; }
        segment(draft.downSnap, endSnap);
      } else segment(draft.start, endSnap);
    },
    cancel() { if (draft) { draft.cur = null; render(); } },
  });
  function segment(s1, s2) {
    const tol = tolPx() * px();
    if (Math.hypot(s2.u - s1.u, s2.v - s1.v) < tol * 0.5 && !(s2.kind === 'pt' && s1.kind === 'pt' && s1.id !== s2.id)) {
      // tapped the same spot again: end the chain
      draft = null; hint(toolHint()); render(); return;
    }
    const cons = tool === 'cline';
    const before = new Set(Object.keys(sk.pts));
    const e = makeLine(s1, s2, cons);
    if (!e) { render(); return; }
    haptic();
    const endedOnOld = s2.kind === 'pt' && before.has(String(s2.id));
    if (cons || endedOnOld) { draft = null; hint(toolHint()); }
    else { draft = { start: { kind: 'pt', id: e.b, u: P(e.b).x, v: P(e.b).y } }; hint('Tap the next point · tap ✓ to finish the chain'); }
    changed(cons ? 'Centerline' : 'Line');
  }
  T.line = lineTool(false);
  T.cline = lineTool(true);

  // ---- rectangle
  T.rect = {
    down(x, y) {
      draft = draft || {};
      draft.downXY = [x, y];
      draft.hadC1 = !!draft.c1;
      draft.downSnap = snapAt(x, y);
      draft.cur = draft.downSnap;
      cursorSnap = null;
      render();
      return true;
    },
    move(x, y) {
      if (!draft) return;
      if (!draft.c1 && Math.hypot(x - draft.downXY[0], y - draft.downXY[1]) > 10) draft.c1 = draft.downSnap;
      draft.cur = snapAt(x, y);
      render();
    },
    hover(x, y) { if (draft && draft.c1) { draft.cur = snapAt(x, y); render(); } },
    up(x, y) {
      if (!draft) return;
      if (!draft.c1) { draft.c1 = draft.downSnap; hint('Tap the opposite corner'); render(); return; }
      const moved = Math.hypot(x - draft.downXY[0], y - draft.downXY[1]) > 10;
      if (!draft.hadC1 && !moved) { hint('Tap the opposite corner'); render(); return; }
      rectangle(draft.c1, snapAt(x, y));
    },
    cancel() { draft = null; render(); },
  };
  function rectangle(s1, s3) {
    const tol = tolPx() * px() * 0.5;
    if (Math.abs(s3.u - s1.u) < tol || Math.abs(s3.v - s1.v) < tol) { draft = null; hint(toolHint()); render(); return; }
    const later = [];
    const a = resolve(s1, later), c = resolve(s3, later);
    const b = addPt(P(c).x, P(a).y), d = addPt(P(a).x, P(c).y);
    const ids = [a, b, c, d].map(Number);
    const ls = [];
    for (let i = 0; i < 4; i++) { const e = { id: nid(), t: 'line', a: ids[i], b: ids[(i + 1) % 4] }; sk.ents.push(e); ls.push(e); }
    sk.cons.push({ id: nid(), t: 'h', e: ls[0].id }, { id: nid(), t: 'v', e: ls[1].id }, { id: nid(), t: 'h', e: ls[2].id }, { id: nid(), t: 'v', e: ls[3].id });
    applyLater(later);
    draft = null; hint(toolHint()); haptic();
    changed('Rectangle');
  }

  // ---- circle
  T.circle = {
    down(x, y) { draft = draft || {}; draft.downXY = [x, y]; if (!draft.c) { draft.c = snapAt(x, y); draft.fresh = true; } else draft.fresh = false; draft.cur = snapAt(x, y); render(); return true; },
    move(x, y) { if (draft) { draft.cur = snapAt(x, y); render(); } },
    hover(x, y) { if (draft && draft.c) { draft.cur = snapAt(x, y); render(); } },
    up(x, y) {
      if (!draft) return;
      const moved = Math.hypot(x - draft.downXY[0], y - draft.downXY[1]) > 10;
      if (draft.fresh && !moved) { hint('Tap a point on the circle'); render(); return; }
      const s = snapAt(x, y);
      const r = Math.hypot(s.u - draft.c.u, s.v - draft.c.v);
      if (r < tolPx() * px() * 0.3) { render(); return; }
      const later = [];
      const c = resolve(draft.c, later);
      const e = { id: nid(), t: 'circle', c: Number(c), r };
      sk.ents.push(e);
      if (s.kind === 'pt') later.push({ id: nid(), t: 'onc', p: s.id, e: e.id });
      applyLater(later);
      draft = null; hint(toolHint()); haptic();
      changed('Circle');
    },
    cancel() { draft = null; render(); },
  };

  // ---- arc (center, start, end)
  T.arc = {
    down(x, y) { draft = draft || {}; draft.downXY = [x, y]; const s = snapAt(x, y); if (!draft.c) { draft.c = s; draft.step = 1; } draft.cur = s; render(); return true; },
    move(x, y) { if (!draft) return; draft.cur = snapAt(x, y); trackSweep(); render(); },
    hover(x, y) { if (draft && draft.c) { draft.cur = snapAt(x, y); trackSweep(); render(); } },
    up(x, y) {
      if (!draft) return;
      const s = snapAt(x, y);
      const moved = Math.hypot(x - draft.downXY[0], y - draft.downXY[1]) > 10;
      if (draft.step === 1) {
        if (!moved) { draft.step = 2; hint('Tap the start of the arc'); render(); return; }
        draft.s = s; draft.step = 3; draft.sweep = 0; draft.lastAng = 0; hint('Tap the end of the arc'); render(); return;
      }
      if (draft.step === 2) { draft.s = s; draft.step = 3; draft.sweep = 0; draft.lastAng = 0; hint('Tap the end of the arc'); render(); return; }
      draft.cur = s; trackSweep();
      const sw = draft.sweep;
      if (Math.abs(sw) < 1e-3) { render(); return; }
      const later = [];
      const c = resolve(draft.c, later);
      const a = resolve(draft.s, later);
      const r = Math.hypot(P(a).x - P(c).x, P(a).y - P(c).y);
      if (r < 1e-6) { draft = null; render(); return; }
      let b;
      if (s.kind === 'pt') b = s.id;
      else {
        const a0 = Math.atan2(P(a).y - P(c).y, P(a).x - P(c).x) + sw;
        b = addPt(P(c).x + r * Math.cos(a0), P(c).y + r * Math.sin(a0));
      }
      const e = sw > 0 ? { id: nid(), t: 'arc', c: Number(c), a: Number(a), b: Number(b) } : { id: nid(), t: 'arc', c: Number(c), a: Number(b), b: Number(a) };
      sk.ents.push(e);
      applyLater(later);
      draft = null; hint(toolHint()); haptic();
      changed('Arc');
    },
    cancel() { draft = null; render(); },
  };
  function trackSweep() {
    if (!draft || draft.step !== 3 || !draft.s || !draft.cur) return;
    const c = draft.c, a0 = Math.atan2(draft.s.v - c.v, draft.s.u - c.u);
    const ang = Math.atan2(draft.cur.v - c.v, draft.cur.u - c.u);
    let rel = ang - a0;
    if (draft.lastAng == null) { draft.lastAng = rel; }
    let d = rel - draft.lastAng;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    draft.sweep = Math.max(-2 * Math.PI + 1e-3, Math.min(2 * Math.PI - 1e-3, (draft.sweep || 0) + d));
    draft.lastAng = rel;
  }

  // ---- trim
  T.trim = {
    down() { return false; },
    tap(x, y) {
      const e = hitEnt(x, y);
      if (!e) { toast('Tap the part of a curve to remove'); return; }
      const [u, v] = toSk(x, y);
      trimAt(e, u, v);
    },
  };

  function trimAt(e, u, v) {
    const { cuts, span } = G.cutParams(sk, e);
    const t = G.paramOn(sk, e, u, v);
    const bounds = e.t === 'circle' ? null : [{ t: 0 }, ...cuts, { t: span }];
    const cutPoint = (c) => {
      if (c.pid != null) return Number(c.pid);
      const id = addPt(c.p[0], c.p[1]);
      const by = E(c.by);
      if (by) sk.cons.push(by.t === 'line' ? { id: nid(), t: 'onl', p: id, e: by.id } : { id: nid(), t: 'onc', p: id, e: by.id });
      return id;
    };
    const dropDims = (id, kinds) => { sk.cons = sk.cons.filter((c) => !(c.t === 'd' && c.e === id && kinds.includes(c.k)) && !(c.t === 'mid' && c.e === id) && !(c.t === 'eq' && e.t === 'line' && (c.e1 === id || c.e2 === id))); };
    if (e.t === 'circle') {
      if (cuts.length < 2) { removeEnts([e.id]); changed('Trim'); return; }
      let lo = null, hi = null;
      for (const c of cuts) { if (c.t < t) lo = c; if (c.t > t && !hi) hi = c; }
      if (!lo) lo = cuts[cuts.length - 1];
      if (!hi) hi = cuts[0];
      const a = cutPoint(hi), b = cutPoint(lo);
      // circle becomes the remaining arc from hi to lo (CCW), keeping its id
      for (const c of sk.cons) if (c.t === 'd' && c.k === 'dia' && c.e === e.id) { c.k = 'rad'; c.v = c.v / 2; }
      delete e.r; e.t = 'arc'; e.a = a; e.b = b;
      changed('Trim');
      return;
    }
    let i = 0;
    while (i < bounds.length - 1 && !(t >= bounds[i].t && t <= bounds[i + 1].t)) i++;
    if (i >= bounds.length - 1) return;
    const lo = bounds[i], hi = bounds[i + 1];
    const atStart = i === 0, atEnd = i + 1 === bounds.length - 1;
    if (atStart && atEnd) { removeEnts([e.id]); changed('Trim'); return; }
    dropDims(e.id, ['len']);
    if (atStart) { e.a = cutPoint(hi); }
    else if (atEnd) { e.b = cutPoint(lo); }
    else {
      const pLo = cutPoint(lo), pHi = cutPoint(hi);
      const e2 = { ...e, id: nid(), a: pHi, b: e.b };
      e.b = pLo;
      sk.ents.push(e2);
      // carry orientation relations to the new piece
      const copies = [];
      for (const c of sk.cons) {
        if (c.t === 'h' || c.t === 'v') { if (c.e === e.id) copies.push({ ...c, id: nid(), e: e2.id }); }
        else if (['par', 'perp'].includes(c.t)) {
          if (c.e1 === e.id) copies.push({ ...c, id: nid(), e1: e2.id });
          else if (c.e2 === e.id) copies.push({ ...c, id: nid(), e2: e2.id });
        }
      }
      sk.cons.push(...copies);
      if (e.t === 'line') sk.cons.push({ id: nid(), t: 'col', e1: e.id, e2: e2.id });
      else sk.cons.push({ id: nid(), t: 'eq', e1: e.id, e2: e2.id });
    }
    changed('Trim');
  }

  function removeEnts(ids) {
    const s = new Set(ids);
    sk.ents = sk.ents.filter((e) => !s.has(e.id));
  }

  // ---- offset
  T.offset = {
    down() { return false; },
    async tap(x, y) {
      const e = hitEnt(x, y);
      if (!e) { toast('Tap a curve to offset'); return; }
      const chain = G.chainOf(sk, e);
      let dist = 5, rev = false;
      const preview = () => {
        const r = offsetGeom(chain, rev ? -dist : dist);
        draft = { offset: r ? r.polys.map((pl) => `<polyline points="${polyStr(pl)}" class="draft" fill="none"/>`).join('') : '' };
        render();
      };
      const inp = el('input', { type: 'text', inputmode: 'decimal', value: U.edit(dist) });
      inp.addEventListener('input', () => { const v = parseLen(inp.value); if (v > 0) { dist = v; preview(); } });
      const content = el('div', {},
        el('div', { class: 'field' }, el('label', {}, `Offset distance (${U.label})`), inp),
        toggle('Reverse side', false, (v) => { rev = v; preview(); }),
        el('div', { class: 'hint' }, `${chain.ents.length} connected curve${chain.ents.length > 1 ? 's' : ''} selected`));
      preview();
      const ok = await dialog({
        title: 'Offset', content, cls: 'low',
        buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', primary: true }],
        onOpen: () => setTimeout(() => { inp.focus(); inp.select(); }, 60),
      });
      draft = null;
      if (ok !== 'ok' || !(dist > 0)) { render(); return; }
      const r = offsetGeom(chain, rev ? -dist : dist, true);
      if (!r) { toast('That offset does not fit (radius would be negative)'); render(); return; }
      changed('Offset');
    },
  };

  /** Offset a chain by d (left of travel positive). commit=true adds the entities. */
  function offsetGeom(chain, d, commit) {
    const items = chain.ents.map((e, i) => {
      const dir = chain.dirs[i];
      if (e.t === 'line') {
        let a = P(e.a), b = P(e.b);
        if (dir < 0) [a, b] = [b, a];
        const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1, n = [-dy / l, dx / l];
        return { e, dir, kind: 'line', p: [a.x + n[0] * d, a.y + n[1] * d], q: [b.x + n[0] * d, b.y + n[1] * d], dvec: [dx, dy] };
      }
      const ci = G.circleInfo(sk, e);
      const r = e.t === 'circle' || dir > 0 ? ci.r - d : ci.r + d;
      if (!(r > 1e-6)) return null;
      const startA = dir > 0 ? ci.a0 : ci.a0 + ci.sweep, endA = dir > 0 ? ci.a0 + ci.sweep : ci.a0;
      return { e, dir, kind: e.t, c: [ci.cx, ci.cy], r, p: [ci.cx + r * Math.cos(startA), ci.cy + r * Math.sin(startA)], q: [ci.cx + r * Math.cos(endA), ci.cy + r * Math.sin(endA)] };
    });
    if (items.some((x) => !x)) return null;
    if (items.length === 1 && items[0].kind === 'circle') {
      const it = items[0];
      const polys = [Array.from({ length: 65 }, (_, i) => [it.c[0] + it.r * Math.cos(i / 64 * 2 * Math.PI), it.c[1] + it.r * Math.sin(i / 64 * 2 * Math.PI)])];
      if (commit) sk.ents.push({ id: nid(), t: 'circle', c: it.e.c, r: it.r });
      return { polys };
    }
    // joints
    const n = items.length;
    const joints = [];
    const jointBetween = (A, B) => {
      const guess = A.q;
      let cand = [];
      if (A.kind === 'line' && B.kind === 'line') { const x = G.lineX(A.p, A.dvec, B.p, B.dvec); return x || guess; }
      const lineOf = (L) => ({ p: L.p, d: L.dvec });
      const circ = (C) => ({ c: C.c, r: C.r });
      if (A.kind === 'line' || B.kind === 'line') {
        const L = lineOf(A.kind === 'line' ? A : B), C = circ(A.kind === 'line' ? B : A);
        const fx = L.p[0] - C.c[0], fy = L.p[1] - C.c[1];
        const a = L.d[0] ** 2 + L.d[1] ** 2, b = 2 * (fx * L.d[0] + fy * L.d[1]), c = fx * fx + fy * fy - C.r * C.r;
        const disc = b * b - 4 * a * c;
        if (disc >= 0) for (const s of [-1, 1]) { const t = (-b + s * Math.sqrt(disc)) / (2 * a); cand.push([L.p[0] + t * L.d[0], L.p[1] + t * L.d[1]]); }
      } else {
        const c1 = circ(A), c2 = circ(B);
        const dx = c2.c[0] - c1.c[0], dy = c2.c[1] - c1.c[1], dd = Math.hypot(dx, dy);
        if (dd < 1e-9) return guess;
        const a = (c1.r * c1.r - c2.r * c2.r + dd * dd) / (2 * dd), h2 = c1.r * c1.r - a * a;
        if (h2 >= 0) { const h = Math.sqrt(h2), mx = c1.c[0] + a * dx / dd, my = c1.c[1] + a * dy / dd; cand.push([mx + h * dy / dd, my - h * dx / dd], [mx - h * dy / dd, my + h * dx / dd]); }
      }
      if (!cand.length) return guess;
      return cand.reduce((m, p) => (Math.hypot(p[0] - guess[0], p[1] - guess[1]) < Math.hypot(m[0] - guess[0], m[1] - guess[1]) ? p : m));
    };
    for (let i = 0; i < n - 1; i++) joints.push(jointBetween(items[i], items[i + 1]));
    let startJ = items[0].p, endJ = items[n - 1].q;
    if (chain.closed) { const j = jointBetween(items[n - 1], items[0]); startJ = j; endJ = j; }
    const ends = items.map((it, i) => [i === 0 ? startJ : joints[i - 1], i === n - 1 ? endJ : joints[i]]);
    const polys = items.map((it, i) => {
      const [s, e] = ends[i];
      if (it.kind === 'line') return [s, e];
      const a0 = Math.atan2(s[1] - it.c[1], s[0] - it.c[0]);
      let a1 = Math.atan2(e[1] - it.c[1], e[0] - it.c[0]);
      let sw = a1 - a0;
      if (it.dir > 0) { while (sw <= 0) sw += 2 * Math.PI; } else { while (sw >= 0) sw -= 2 * Math.PI; }
      return Array.from({ length: 33 }, (_, k) => [it.c[0] + it.r * Math.cos(a0 + sw * k / 32), it.c[1] + it.r * Math.sin(a0 + sw * k / 32)]);
    });
    if (commit) {
      const jid = [];
      const ptAt = (p) => addPt(p[0], p[1]);
      const first = ptAt(ends[0][0]);
      jid.push(first);
      for (let i = 0; i < n - 1; i++) jid.push(ptAt(joints[i]));
      jid.push(chain.closed ? first : ptAt(endJ));
      items.forEach((it, i) => {
        const s = jid[i], e = jid[i + 1];
        if (it.kind === 'line') {
          const ne = { id: nid(), t: 'line', a: s, b: e };
          if (it.e.cons) ne.cons = true;
          sk.ents.push(ne);
          sk.cons.push({ id: nid(), t: 'par', e1: it.e.id, e2: ne.id });
        } else {
          const ne = it.dir > 0 ? { id: nid(), t: 'arc', c: it.e.c, a: s, b: e } : { id: nid(), t: 'arc', c: it.e.c, a: e, b: s };
          if (it.e.cons) ne.cons = true;
          sk.ents.push(ne);
        }
      });
    }
    return { polys };
  }

  // ---- convert entities: copy model edges into the sketch, linked to the model
  T.convert = {
    down() { return false; },
    tap(x, y) {
      draft = draft || { conv: new Set() };
      const ids = [];
      const h = hitModelEdge(x, y);
      if (h != null) ids.push(h);
      else if (ctx.pickFace) {   // a face: all its edges (CAD PRO)
        const f = ctx.pickFace(x, y);
        if (f && f.edges) ids.push(...f.edges.filter((id) => model.all[id]));
      }
      if (!ids.length) { toast('Tap a model edge (or a face) to convert'); return; }
      const all = ids.every((id) => draft.conv.has(id));
      for (const id of ids) { if (all) draft.conv.delete(id); else draft.conv.add(id); }
      haptic();
      hint(draft.conv.size ? `${draft.conv.size} edge${draft.conv.size > 1 ? 's' : ''} selected · tap Convert` : toolHint());
      render();
    },
    cancel() { render(); },
  };

  function hitModelEdge(x, y) {
    const [u, v] = toSk(x, y);
    const tol = tolPx() * px();
    let best = null, bd = tol;
    for (const m of model.all) {
      const q = closestOnPoly(m.pts2, u, v);
      if (!q) continue;
      const d = Math.hypot(q[0] - u, q[1] - v);
      if (d < bd) { bd = d; best = m.id; }
    }
    return best;
  }

  /** Copy the selected model edges into the sketch as linked lines, arcs and circles. */
  function convertSelected() {
    const ids = draft && draft.conv ? [...draft.conv] : [];
    draft = null;
    if (!ids.length) { hint(toolHint()); render(); return; }
    const pl = sk.plane;
    const r4 = (a) => a.map((q) => Math.round(q * 1e4) / 1e4);
    let made = 0, skipped = 0;
    const later = [];
    // reuse a point already linked to the same model spot, so converted loops stay closed
    const linkedPt = (P3, k, e) => {
      const s = ME.toSketch(pl, P3);
      for (const c of sk.cons) if (c.t === 'ext' && Math.abs(c.x - s.u) < 1e-6 && Math.abs(c.y - s.v) < 1e-6) return c.p;
      for (const c of later) if (c.t === 'ext' && Math.abs(c.x - s.u) < 1e-6 && Math.abs(c.y - s.v) < 1e-6) return c.p;
      const id = addPt(s.u, s.v);
      later.push({ id: nid(), t: 'ext', p: Number(id), x: s.u, y: s.v, ref: { k, e: ME.edgeRef(e), at: k === 'v' ? r4(P3) : undefined } });
      return Number(id);
    };
    for (const id of ids) {
      const m = model.all[id];
      if (!m) continue;
      const e = m.e;
      if (e.kind === 'line') {
        if (Math.hypot(m.a2[0] - m.b2[0], m.a2[1] - m.b2[1]) < 1e-6) { skipped++; continue; }
        const a = linkedPt(e.a, 'v', e), b = linkedPt(e.b, 'v', e);
        if (a === b) { skipped++; continue; }
        sk.ents.push({ id: nid(), t: 'line', a, b, conv: true });
        made++;
      } else if (e.kind === 'circle' && e.circ && Math.abs(M3.dot(e.circ.n, pl.n)) > 0.999) {
        const c = linkedPt(e.circ.c, 'c', e);
        if (e.closed) {
          const ent = { id: nid(), t: 'circle', c, r: e.circ.r, conv: true };
          sk.ents.push(ent);
          later.push({ id: nid(), t: 'extr', e: ent.id, r: e.circ.r, ref: { k: 'r', e: ME.edgeRef(e) } });
        } else {
          const A = linkedPt(e.a, 'v', e), B = linkedPt(e.b, 'v', e);
          const C = sk.pts[c], ang = (q) => Math.atan2(q[1] - C.y, q[0] - C.x);
          const a0 = ang(m.a2), a1 = ang(m.b2), am = ang(m.mid2);
          const ccw = (from, to, x) => { const n = (t) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); return n(x - from) <= n(to - from); };
          sk.ents.push(ccw(a0, a1, am) ? { id: nid(), t: 'arc', c, a: A, b: B, conv: true } : { id: nid(), t: 'arc', c, a: B, b: A, conv: true });
        }
        made++;
      } else skipped++;
    }
    sk.cons.push(...later);
    hint(toolHint());
    if (skipped) toast(skipped + ' edge' + (skipped > 1 ? 's' : '') + ' skipped: only straight edges' + (ctx.pro ? ', and circles parallel to the sketch,' : '') + ' can be converted');
    if (made) { haptic(); changed('Convert Entities'); } else render();
  }

  // ---- smart dimension
  T.dim = {
    down() { return false; },
    tap(x, y) {
      const hb = hitBox(x, y);
      if (hb && hb.kind === 'dim' && !draft) { editDim(hb.con); return; }
      const it = hitItem(x, y);
      if (!draft || !draft.first) {
        if (!it) { toast('Tap a line, circle, arc or point'); return; }
        const e = it.k === 'e' ? E(it.id) : null;
        draft = { first: it };
        if (e && e.t === 'line') hint('Tap empty space to place the length, or tap a second item');
        else if (e) hint('Tap empty space to place the ' + (e.t === 'circle' ? 'diameter' : 'radius') + ', or tap a second item');
        else hint('Tap a second point or line');
        render();
        return;
      }
      const first = draft.first;
      draft = null;
      hint(toolHint());
      const same = it && it.k === first.k && String(it.id) === String(first.id);
      createDim(first, same ? null : it, toSk(x, y));
    },
    cancel() { draft = null; render(); },
  };

  async function createDim(a, b, at) {
    const ent = (it) => (it && it.k === 'e' ? E(it.id) : null);
    const ea = ent(a), eb = ent(b);
    const isC = (e) => e && (e.t === 'circle' || e.t === 'arc');
    let con = null;
    if (!b) {
      if (ea && ea.t === 'line') con = { k: 'len', e: ea.id };
      else if (ea && ea.t === 'circle') con = { k: 'dia', e: ea.id };
      else if (ea && ea.t === 'arc') con = { k: 'rad', e: ea.id };
      else { toast('Pick a second item to measure from a point'); render(); return; }
    } else {
      const ptOf = (it, e) => (it.k === 'p' ? it.id : isC(e) ? e.c : null);
      if (ea && eb && ea.t === 'line' && eb.t === 'line') {
        const d1 = [P(ea.b).x - P(ea.a).x, P(ea.b).y - P(ea.a).y], d2 = [P(eb.b).x - P(eb.a).x, P(eb.b).y - P(eb.a).y];
        const cr = Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) / ((Math.hypot(...d1) * Math.hypot(...d2)) || 1);
        con = cr < 1e-4 ? { k: 'll', e1: ea.id, e2: eb.id } : { k: 'ang', e1: ea.id, e2: eb.id };
      } else if ((ea && ea.t === 'line') || (eb && eb.t === 'line')) {
        const L = ea && ea.t === 'line' ? ea : eb, other = L === ea ? b : a, oe = L === ea ? eb : ea;
        const p = ptOf(other, oe);
        if (p == null) { toast('Cannot dimension those two items'); return; }
        if (String(p) === String(L.a) || String(p) === String(L.b)) con = { k: 'len', e: L.id };
        else con = { k: 'pl', p: Number(p), e: L.id };
      } else {
        const p1 = ptOf(a, ea), p2 = ptOf(b, eb);
        if (p1 == null || p2 == null || String(p1) === String(p2)) { toast('Cannot dimension those two items'); return; }
        con = { k: 'pp', a: Number(p1), b: Number(p2) };
        // horizontal / vertical / aligned from where the label was placed
        const A = P(p1), B = P(p2);
        const minx = Math.min(A.x, B.x), maxx = Math.max(A.x, B.x), miny = Math.min(A.y, B.y), maxy = Math.max(A.y, B.y);
        if (at[1] > maxy || at[1] < miny) { if (at[0] >= minx && at[0] <= maxx) con.dir = 'h'; }
        if (at[0] > maxx || at[0] < minx) { if (at[1] >= miny && at[1] <= maxy) con.dir = 'v'; }
      }
    }
    con.t = 'd';
    await finishDim(con, at);
  }

  async function finishDim(con, at) {
    // sign of the current geometry so the solver keeps the same side / direction
    if (['pl', 'll', 'ang'].includes(con.k) || con.dir) {
      const sv = S.measureSigned(sk, con);
      con.s = sv < 0 ? -1 : 1;
    }
    const cur = S.measure(sk, con);
    if (con.k !== 'ang' && cur < 1e-9 && con.k !== 'pl') { toast('That distance is zero'); render(); return; }
    // label offset from the anchor
    con.v = cur;
    con.id = nid();
    const b = dimBase(con);
    const anc = dimAnchor({ ...con, off: [0, 0] }, b);
    con.off = [at[0] - anc[0], at[1] - anc[1]];
    const val = await askDimValue(con, cur, true);
    if (val == null) { render(); return; }
    if (val.dir !== undefined && val.dir !== con.dir) {
      con.dir = val.dir || undefined;
      if (con.dir) { const sv = S.measureSigned(sk, con); con.s = sv < 0 ? -1 : 1; }
      else delete con.s;
    }
    con.v = val.v;
    const r = S.tryAdd(sk, [con]);
    if (r === 'ok') { changed('Dimension'); return; }
    if (r === 'redundant') {
      const ok = await confirmBox('Over defining', 'This dimension would over-define the sketch. Add it as a driven (reference) dimension instead?', 'Add as driven');
      if (ok) { con.drv = true; con.v = S.measure(sk, con); sk.cons.push(con); changed('Driven dimension'); }
      else render();
      return;
    }
    toast('That value cannot be solved with the other relations', { kind: 'err' });
    render();
  }

  /** Ask for a dimension value. Returns {v, dir} or null. */
  async function askDimValue(con, cur, isNew) {
    const ang = con.k === 'ang';
    const inp = el('input', { type: 'text', inputmode: 'decimal', value: ang ? String(+cur.toFixed(4)) : U.edit(cur) });
    let dir = con.dir || '';
    const content = el('div', {},
      el('div', { class: 'field' }, el('label', {}, ang ? 'Angle (°)' : con.k === 'dia' ? `Diameter (${U.label})` : con.k === 'rad' ? `Radius (${U.label})` : `Distance (${U.label})`), inp,
        el('div', { class: 'hint' }, 'Maths is fine: 20+5, 3/8in, 2*15'), el('div', { class: 'err' })));
    if (con.k === 'pp') content.prepend(segmented([['', 'Aligned'], ['h', 'Horizontal'], ['v', 'Vertical']], dir, (v) => { dir = v; }));
    const res = await dialog({
      title: isNew ? 'Dimension' : 'Edit dimension', content, cls: 'low',
      buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', primary: true }],
      onOpen: () => setTimeout(() => { inp.focus(); inp.select(); }, 60),
      validate: () => {
        const v = ang ? parseAng(inp.value) : parseLen(inp.value);
        const ok = Number.isFinite(v) && (ang ? v > 0 && v < 360 : v > 0);
        if (!ok) content.querySelector('.err').textContent = 'Enter a value above 0';
        return ok;
      },
    });
    if (res !== 'ok') return null;
    return { v: ang ? parseAng(inp.value) : parseLen(inp.value), dir: con.k === 'pp' ? dir : undefined };
  }

  async function editDim(con) {
    if (con.drv) {
      const r = await sheet('Driven dimension ' + dimText(con), [
        { label: 'Make it driving', value: 'drive', icon: 'dim' },
        { label: 'Delete', value: 'del', icon: 'trash', danger: true },
      ]);
      if (r === 'del') { sk.cons = sk.cons.filter((c) => c !== con); changed('Delete dimension'); }
      if (r === 'drive') {
        sk.cons = sk.cons.filter((c) => c !== con);
        const c2 = { ...con, drv: false, v: S.measure(sk, con) };
        const r2 = S.tryAdd(sk, [c2]);
        if (r2 !== 'ok') { sk.cons.push(con); toast('It would over-define the sketch'); render(); }
        else changed('Driving dimension');
      }
      return;
    }
    const inp = el('input', { type: 'text', inputmode: 'decimal', value: con.k === 'ang' ? String(+con.v.toFixed(4)) : U.edit(con.v) });
    const content = el('div', { class: 'field' }, el('label', {}, con.k === 'ang' ? 'Angle (°)' : `Value (${U.label})`), inp, el('div', { class: 'err' }));
    const res = await dialog({
      title: 'Edit dimension', content, cls: 'low',
      buttons: [{ label: 'Delete', value: 'del', danger: true }, { label: 'Cancel', value: null }, { label: 'OK', value: 'ok', primary: true }],
      onOpen: () => setTimeout(() => { inp.focus(); inp.select(); }, 60),
      validate: (v) => {
        if (v !== 'ok') return true;
        const x = con.k === 'ang' ? parseAng(inp.value) : parseLen(inp.value);
        const ok = Number.isFinite(x) && x > 0;
        if (!ok) content.querySelector('.err').textContent = 'Enter a value above 0';
        return ok;
      },
    });
    if (res === 'del') { sk.cons = sk.cons.filter((c) => c !== con); changed('Delete dimension'); return; }
    if (res !== 'ok') return;
    const nv = con.k === 'ang' ? parseAng(inp.value) : parseLen(inp.value);
    const old = con.v;
    const snap = S.snapshot(sk);
    con.v = nv;
    // big changes can jump to a far solution; walk there in steps
    let ok = S.solve(sk);
    if (!ok) {
      S.restore(sk, snap);
      ok = true;
      for (let k = 1; k <= 10 && ok; k++) { con.v = old + (nv - old) * k / 10; ok = S.solve(sk); }
    }
    if (!ok) { con.v = old; S.restore(sk, snap); S.solve(sk); toast('That value cannot be solved', { kind: 'err' }); render(); return; }
    changed('Edit dimension');
  }

  async function relMenu(con) {
    sel.clear(); sel.add('c:' + con.id); render();
    const r = await sheet(REL_NAME[con.t] + ' relation', [{ label: 'Delete relation', value: 'del', icon: 'trash', danger: true }]);
    sel.delete('c:' + con.id);
    if (r === 'del') { sk.cons = sk.cons.filter((c) => c !== con); changed('Delete relation'); }
    else render();
  }

  // ------------------------------------------------------------ selection actions (chips)
  function selItems() {
    const pts = [], lines = [], circs = [];
    for (const k of sel) {
      const [t, id] = k.split(':');
      if (t === 'p') pts.push(id);
      else if (t === 'e') { const e = E(Number(id)); if (e) (e.t === 'line' ? lines : circs).push(e); }
    }
    return { pts, lines, circs };
  }

  function chips() {
    if (!ctx.setChips) return;
    if (tool !== 'select' || !sel.size) { ctx.setChips([]); return; }
    const { pts, lines, circs } = selItems();
    const L = [];
    const rel = (icon, label, make) => L.push({ icon, label, fn: () => applyRel(label, make()) });
    const np = pts.length, nl = lines.length, nc = circs.length;
    if (nl >= 1 && !np && !nc) {
      rel('rel_h', 'Horizontal', () => lines.map((l) => ({ t: 'h', e: l.id })));
      rel('rel_v', 'Vertical', () => lines.map((l) => ({ t: 'v', e: l.id })));
    }
    if (nl === 2 && !np && !nc) {
      rel('rel_par', 'Parallel', () => [{ t: 'par', e1: lines[0].id, e2: lines[1].id }]);
      rel('rel_perp', 'Perpendicular', () => [{ t: 'perp', e1: lines[0].id, e2: lines[1].id }]);
      rel('rel_col', 'Collinear', () => [{ t: 'col', e1: lines[0].id, e2: lines[1].id }]);
    }
    if (nl >= 2 && !np && !nc) rel('rel_eq', 'Equal', () => lines.slice(1).map((l) => ({ t: 'eq', e1: lines[0].id, e2: l.id })));
    if (nc >= 2 && !np && !nl) {
      rel('rel_eq', 'Equal', () => circs.slice(1).map((c) => ({ t: 'eq', e1: circs[0].id, e2: c.id })));
      if (nc === 2) {
        rel('rel_conc', 'Concentric', () => [{ t: 'conc', e1: circs[0].id, e2: circs[1].id }]);
        rel('rel_tan', 'Tangent', () => [tanCon(circs[0], circs[1])]);
      }
    }
    if (nl === 1 && nc === 1 && !np) rel('rel_tan', 'Tangent', () => [tanCon(lines[0], circs[0])]);
    if (np === 2 && !nl && !nc) {
      rel('rel_co', 'Coincident', () => [{ t: 'co', a: Number(pts[0]), b: Number(pts[1]) }]);
      rel('rel_h', 'Horizontal', () => [{ t: 'hp', a: Number(pts[0]), b: Number(pts[1]) }]);
      rel('rel_v', 'Vertical', () => [{ t: 'vp', a: Number(pts[0]), b: Number(pts[1]) }]);
    }
    if (np === 1 && nl === 1 && !nc) {
      rel('rel_on', 'Coincident', () => [{ t: 'onl', p: Number(pts[0]), e: lines[0].id }]);
      rel('rel_mid', 'Midpoint', () => [{ t: 'mid', p: Number(pts[0]), e: lines[0].id }]);
    }
    if (np === 1 && nc === 1 && !nl) {
      if (String(circs[0].c) === pts[0]) { /* own centre */ } else rel('rel_on', 'Coincident', () => [{ t: 'onc', p: Number(pts[0]), e: circs[0].id }]);
    }
    if (np >= 1 && !nl && !nc) {
      const fixed = pts.filter((id) => sk.cons.some((c) => c.t === 'fix' && String(c.p) === id));
      if (fixed.length === pts.length) L.push({ icon: 'rel_fix', label: 'Unfix', fn: () => { sk.cons = sk.cons.filter((c) => !(c.t === 'fix' && pts.includes(String(c.p)))); changed('Unfix'); } });
      else if (!pts.includes('0')) rel('rel_fix', 'Fix', () => pts.map((id) => ({ t: 'fix', p: Number(id), x: P(id).x, y: P(id).y })));
    }
    if (nl + nc > 0) {
      const allC = [...lines, ...circs].every((e) => e.cons);
      L.push({ icon: 'construction', label: allC ? 'Solid' : 'Construction', fn: () => { for (const e of [...lines, ...circs]) { if (allC) delete e.cons; else e.cons = true; } changed('Construction'); } });
    }
    L.push({ icon: 'trash', label: 'Delete', danger: true, fn: deleteSel });
    ctx.setChips(L);
  }

  function tanCon(e1, e2) {
    if (e1.t === 'line' || e2.t === 'line') {
      const l = e1.t === 'line' ? e1 : e2, c = l === e1 ? e2 : e1;
      const a = P(l.a), b = P(l.b), cc = P(c.c);
      const dx = b.x - a.x, dy = b.y - a.y;
      const sd = (dx * (cc.y - a.y) - dy * (cc.x - a.x)) / (Math.hypot(dx, dy) || 1);
      return { t: 'tan', e1: l.id, e2: c.id, s: sd < 0 ? -1 : 1 };
    }
    const c1 = G.circleInfo(sk, e1), c2 = G.circleInfo(sk, e2);
    const d = Math.hypot(c2.cx - c1.cx, c2.cy - c1.cy);
    const opts = [Math.abs(d - (c1.r + c2.r)), Math.abs(d - (c1.r - c2.r)), Math.abs(d - (c2.r - c1.r))];
    const k = opts.indexOf(Math.min(...opts));
    return { t: 'tan', e1: e1.id, e2: e2.id, k };
  }

  function applyRel(label, cons) {
    cons.forEach((c) => (c.id = nid()));
    const r = S.tryAdd(sk, cons);
    if (r === 'ok') { haptic(); changed(label); return; }
    if (r === 'redundant') toast('Already defined: this relation would over-define the sketch');
    else toast('That relation conflicts with the others', { kind: 'err' });
  }

  function deleteSel() {
    const { pts, lines, circs } = selItems();
    const dead = new Set([...lines, ...circs].map((e) => e.id));
    for (const id of pts) {
      if (id === '0') continue;
      for (const e of sk.ents) if ([e.a, e.b, e.c].map(String).includes(id)) dead.add(e.id);
    }
    removeEnts([...dead]);
    changed('Delete');
  }

  // ------------------------------------------------------------ public
  function toolHint() {
    return {
      select: 'Tap to select · drag to move · tap a dimension to edit it',
      line: 'Tap two points, or drag, to draw lines',
      cline: 'Tap two points to draw a centerline',
      rect: 'Tap two opposite corners',
      circle: 'Tap the centre, then a point on the circle',
      arc: 'Tap the centre, the start, then the end',
      dim: 'Tap a line, circle, arc or point to dimension',
      trim: 'Tap the piece of a curve to remove',
      offset: 'Tap a curve to offset its connected chain',
      convert: 'Tap model edges (or a face) to copy them into the sketch',
    }[tool];
  }

  function setTool(t) {
    tool = t;
    draft = null; cursorSnap = null;
    if (t !== 'select') sel.clear();
    const impl = T[t];
    view.tool = {
      down: (x, y, ev) => { isTouch = ev.pointerType !== 'mouse'; return impl.down ? impl.down(x, y, ev) : false; },
      move: (x, y, ev) => impl.move && impl.move(x, y, ev),
      up: (x, y, ev) => impl.up && impl.up(x, y, ev),
      cancel: () => impl.cancel && impl.cancel(),
      hover: (x, y, ev) => {
        isTouch = ev.pointerType !== 'mouse';
        if (FIRST_PT_TOOLS.includes(tool) && !hasFirstPoint()) {
          const s = snapAt(x, y);
          cursorSnap = s.kind === 'free' ? null : s;
          if (impl.hover && draft) impl.hover(x, y, ev); else render();
          return;
        }
        cursorSnap = null;
        impl.hover && impl.hover(x, y, ev);
      },
    };
    view.onTap = (x, y, ev) => { isTouch = ev.pointerType !== 'mouse'; if (impl.tap) impl.tap(x, y); else if (tool !== 'select') { /* drawing tools capture their own taps */ } };
    hint(toolHint());
    render(); chips();
  }

  view.onChange(() => { if (sk) render(); });

  return {
    TOOLS,
    settings,
    get tool() { return tool; },
    get sketch() { return sk; },
    open(sketch) {
      sk = sketch; sel.clear(); draft = null; model = { all: [], plane: [] };
      S.solve(sk);
      an = S.analyze(sk);
      setTool('select');
      status();
    },
    close() { sk = null; draft = null; sel.clear(); svg.innerHTML = ''; view.tool = null; view.onTap = null; ctx.setChips && ctx.setChips([]); },
    reload(sketch) { sk = sketch; sel.clear(); draft = null; an = S.analyze(sk); render(); status(); chips(); },
    setTool,
    /** Finish the current chain / cancel the current tool step. Returns true if something was pending. */
    finishDraft() {
      if (tool === 'convert' && draft && draft.conv && draft.conv.size) { convertSelected(); return true; }
      if (draft) { draft = null; hint(toolHint()); render(); return true; }
      return false;
    },
    setModelEdges(edges) { if (sk) { setModelEdges(edges); render(); } },
    setSuspended(v) { if (suspended !== v) { suspended = v; cursorSnap = null; render(); if (ctx.onSuspend) ctx.onSuspend(v); } },
    get suspended() { return suspended; },
    hasDraft: () => !!draft,
    hasSelection: () => sel.size > 0,
    clearSelection() { sel.clear(); render(); chips(); },
    deleteSelection: deleteSel,
    render,
    analysis: () => an,
    bounds() {
      if (!sk) return null;
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      for (const e of sk.ents) for (const [u, v] of G.tess(sk, e, 0.5)) { mnx = Math.min(mnx, u); mxx = Math.max(mxx, u); mny = Math.min(mny, v); mxy = Math.max(mxy, v); }
      return Number.isFinite(mnx) ? { mnx, mny, mxx, mxy } : null;
    },
  };
}
