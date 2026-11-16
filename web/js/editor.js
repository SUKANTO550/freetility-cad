// FreeTility CAD - part editor: model mode (features), sketch mode, feature
// tree, property panels with live preview, undo / redo, save and export.

import * as K from './kernel.js';
import * as M from './model.js';
import * as G from './geom2d.js';
import * as S from './solver.js';
import * as ME from './edges.js';
import { snapControls } from './snapset.js';
import { createView } from './view.js';
import { createSketcher } from './sketcher.js';
import { U, fmtAng, parseLen, parseAng, parseNum } from './units.js';
import { icon } from './icons.js';
import { $, el, esc, toast, dialog, confirmBox, promptBox, sheet, segmented, toggle, pushBack, haptic } from './ui.js';
import { store, prefs, exportFile, pickFile, IS_WIN } from './store.js';

const PRO = K.KERNEL.pro;

export function createEditor(root, { onClose, viewOnly = false }) {
  // ------------------------------------------------------------ DOM
  root.innerHTML = '';
  const topbar = el('header', { class: 'ed-top' });
  const vp = el('div', { class: 'vp' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'sk-layer');
  const statusPill = el('div', { class: 'sk-status' });
  const hintBar = el('div', { class: 'hint-bar' });
  const chipsRow = el('div', { class: 'chips' });
  const toolbar = el('nav', { class: 'toolbar' });
  const panel = el('aside', { class: 'panel' });
  const tree = el('aside', { class: 'tree' });
  const treeScrim = el('div', { class: 'tree-scrim', onclick: () => showTree(false) });
  const vpBtns = el('div', { class: 'vp-btns' });
  root.append(topbar, vp, toolbar, panel, treeScrim, tree);
  vp.append(svg, statusPill, chipsRow, hintBar, vpBtns);

  const view = createView(vp);
  if (!window.Native) window.__ftview = view;   // browser preview / automated tests only
  vp.insertBefore(view.canvas, svg);
  const sketcher = createSketcher({
    view, svg,
    onCommit: (label) => push(label),
    onStatus: (s) => { statusPill.textContent = s.text; statusPill.className = 'sk-status show ' + s.kind; },
    onHint: (t) => setHint(t),
    setChips: (list) => renderChips(list),
    snap: () => prefs.snap,
    pro: PRO,
    pickFace: (x, y) => {
      const h = view.pick(x, y, { body: true, planes: false, sketches: false });
      if (!h || h.kind !== 'face') return null;
      if (!h.edges && h.flat && sketchBody) h.edges = faceEdgeIds(h);
      return h;
    },
    onSuspend: () => updateTop(),
  });

  let sketchBody = null;   // body shown while sketching (model edges come from it)

  /** Model edges on the boundary of a flat face (mesh kernel: faces don't list their edges). */
  function faceEdgeIds(face) {
    const m = K.mesh(sketchBody), edges = M.bodyEdges(sketchBody);
    const n = face.normal, d = face.d, P = m.pos, I = m.idx;
    const tol = 1e-3 * Math.max(1, ME.sizeOf(edges));
    const onFace = (p) => {
      for (const t of face.tris) {
        const A = [P[I[t * 3] * 3], P[I[t * 3] * 3 + 1], P[I[t * 3] * 3 + 2]];
        const B = [P[I[t * 3 + 1] * 3], P[I[t * 3 + 1] * 3 + 1], P[I[t * 3 + 1] * 3 + 2]];
        const C = [P[I[t * 3 + 2] * 3], P[I[t * 3 + 2] * 3 + 1], P[I[t * 3 + 2] * 3 + 2]];
        const s1 = M.v3.dot(M.v3.cross(M.v3.sub(B, A), M.v3.sub(p, A)), n);
        const s2 = M.v3.dot(M.v3.cross(M.v3.sub(C, B), M.v3.sub(p, B)), n);
        const s3 = M.v3.dot(M.v3.cross(M.v3.sub(A, C), M.v3.sub(p, C)), n);
        const e2 = tol * Math.max(M.v3.len(M.v3.sub(B, A)), M.v3.len(M.v3.sub(C, B)), M.v3.len(M.v3.sub(A, C)));
        if (s1 >= -e2 && s2 >= -e2 && s3 >= -e2) return true;
      }
      return false;
    };
    const ids = [];
    edges.forEach((e, i) => {
      if (Math.abs(M.v3.dot(n, e.a) - d) > tol || Math.abs(M.v3.dot(n, e.b) - d) > tol || Math.abs(M.v3.dot(n, e.mid) - d) > tol) return;
      if (onFace(e.mid)) ids.push(i);
    });
    return ids;
  }

  // ------------------------------------------------------------ state
  let doc = null, name = '';
  let mode = 'model';
  let editSketchId = null;
  let msel = null;              // model selection
  let hist = [], hi = -1;
  let built = null;             // last rebuild result
  let panelState = null;        // open property panel
  let saveTimer = null, dirty = false;
  let pendingAfterSketch = null;
  const unbackers = [];

  // ------------------------------------------------------------ history
  function snap() { return JSON.stringify({ units: doc.units, nid: doc.nid, features: doc.features, material: doc.material || null, planeVis: doc.planeVis || null }); }
  function push(label) {
    hist = hist.slice(0, hi + 1);
    hist.push({ s: snap(), label });
    if (hist.length > 80) hist.shift();
    hi = hist.length - 1;
    dirty = true;
    scheduleSave();
    updateTop();
    if (mode === 'model') refresh();
    else treeRender();
  }
  function restoreState(s) {
    const o = JSON.parse(s);
    doc.units = o.units; doc.nid = o.nid; doc.features = o.features;
    if (o.material) doc.material = o.material; else delete doc.material;
    if (o.planeVis) doc.planeVis = o.planeVis; else delete doc.planeVis;
    U.set(doc.units);
    dirty = true; scheduleSave();
    if (mode === 'sketch') {
      const f = doc.features.find((x) => x.id === editSketchId);
      if (!f) { exitSketch(true); return; }
      sketcher.reload(f.sketch);
      treeRender();
    } else refresh();
    updateTop();
  }
  function undo() {
    if (panelState) return;
    if (mode === 'sketch' && sketcher.finishDraft()) return;
    if (hi <= 0) { toast('Nothing to undo'); return; }
    const label = hist[hi].label;
    hi--; restoreState(hist[hi].s);
    toast('Undo: ' + label);
  }
  function redo() {
    if (panelState) return;
    if (hi >= hist.length - 1) { toast('Nothing to redo'); return; }
    hi++; restoreState(hist[hi].s);
    toast('Redo: ' + hist[hi].label);
  }

  // ------------------------------------------------------------ save
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => save(false), 1500); }
  function save(withThumb) {
    clearTimeout(saveTimer);
    if (!doc || viewOnly) return;
    if (dirty) {
      doc.modified = Date.now();
      // PRO parts carry a mesh so FreeTility CAD can still show them (view only)
      if (PRO && M.usesPro(doc) && built && built.body) { try { doc.mesh = M.packMesh(K.mesh(built.body)); } catch (e) { delete doc.mesh; } }
      else delete doc.mesh;
      store.save(name, doc); dirty = false;
    }
    if (withThumb && mode === 'model' && !panelState) {
      try { store.saveThumb(name, view.snapshot(360, 270)); } catch (e) { /* ignore */ }
    }
  }

  // ------------------------------------------------------------ top bar
  function updateTop() {
    topbar.innerHTML = '';
    if (mode === 'sketch') {
      const f = doc.features.find((x) => x.id === editSketchId);
      topbar.append(
        el('button', { class: 'ib', title: 'Undo', onclick: undo, html: icon('undo') }),
        el('button', { class: 'ib', title: 'Redo', onclick: redo, html: icon('redo') }),
        el('div', { class: 'ttl' }, el('div', { class: 't1' }, f ? f.name : 'Sketch'), el('div', { class: 't2' }, name)),
        magnetButton(),
        el('button', { class: 'ib', title: 'Normal to', onclick: () => lookAtSketch(), html: icon('plane') }),
        el('button', { class: 'ib', title: 'Sketch options', onclick: sketchMenu, html: icon('more') }),
        el('button', { class: 'ok-btn', title: 'Exit sketch', onclick: () => exitSketch(), html: icon('check') + '<span>Exit</span>' }));
      return;
    }
    topbar.append(
      el('button', { class: 'ib', title: 'Back', onclick: close, html: icon('back') }),
      el('div', { class: 'ttl', onclick: renamePart }, el('div', { class: 't1' }, name), el('div', { class: 't2' }, (PRO ? 'FreeTility CAD PRO' : 'FreeTility CAD') + ' · ' + U.label)),
      el('button', { class: 'ib', title: 'Undo', onclick: undo, disabled: hi <= 0, html: icon('undo') }),
      el('button', { class: 'ib', title: 'Redo', onclick: redo, disabled: hi >= hist.length - 1, html: icon('redo') }),
      el('button', { class: 'ib', title: 'Feature tree', onclick: () => showTree(true), html: icon('tree') }),
      el('button', { class: 'ib', title: 'More', onclick: moreMenu, html: icon('more') }));
  }

  /** Snap settings: tap opens them, long-press turns all snapping off / on. */
  function magnetButton() {
    const b = el('button', { class: 'ib magnet' + (sketcher.suspended ? ' off' : ''), title: 'Snapping (long-press: on / off)', html: icon('magnet') });
    let t = null, long = false;
    b.addEventListener('pointerdown', () => { long = false; t = setTimeout(() => { long = true; sketcher.setSuspended(!sketcher.suspended); haptic(); toast(sketcher.suspended ? 'Snapping off' : 'Snapping on'); }, 500); });
    const clear = () => clearTimeout(t);
    b.addEventListener('pointerup', clear); b.addEventListener('pointercancel', clear); b.addEventListener('pointerleave', clear);
    b.addEventListener('click', () => { if (!long) snapDialog(); });
    return b;
  }

  async function snapDialog() {
    await dialog({ title: 'Snapping', content: snapControls(() => sketcher.render(), { on: !sketcher.suspended, set: (v) => sketcher.setSuspended(!v) }), buttons: [{ label: 'Done', value: true, primary: true }] });
    sketcher.render();
  }

  // ------------------------------------------------------------ toolbar
  function tb(ic, label, fn, opts = {}) {
    return el('button', { class: 'tb' + (opts.on ? ' on' : '') + (opts.cls ? ' ' + opts.cls : ''), title: label, onclick: fn, html: icon(ic) + `<span>${esc(label)}</span>` });
  }
  function renderToolbar() {
    toolbar.innerHTML = '';
    toolbar.scrollLeft = 0;
    requestAnimationFrame(() => toolbar.classList.toggle('over', toolbar.scrollWidth > toolbar.clientWidth + 4));
    if (panelState) { toolbar.classList.add('hide'); return; }
    toolbar.classList.remove('hide');
    if (mode === 'sketch') {
      const cur = sketcher.tool;
      for (const [t, label] of sketcher.TOOLS) {
        const ic = { select: 'select', line: 'line', rect: 'rect', circle: 'circle', arc: 'arc', cline: 'cline', dim: 'dim', trim: 'trim', offset: 'offset', convert: 'convert' }[t];
        toolbar.append(tb(ic, label, () => { if (t === sketcher.tool && sketcher.finishDraft()) return; sketcher.setTool(t); renderToolbar(); }, { on: t === cur }));
      }
      return;
    }
    toolbar.append(
      tb('sketch', 'Sketch', () => startSketch()),
      tb('extrude', 'Extrude', () => newFeature('extrude', 'add')),
      tb('cut', 'Cut', () => newFeature('extrude', 'cut')),
      tb('revolve', 'Revolve', () => newFeature('revolve', 'add')),
      tb('cutrevolve', 'Cut-Revolve', () => newFeature('revolve', 'cut')),
      tb('lpattern', 'Pattern', patternMenu));
    if (K.KERNEL.can.fillet) toolbar.append(tb('fillet', 'Fillet', () => newFeature('fillet')));
    if (K.KERNEL.can.chamfer) toolbar.append(tb('chamfer', 'Chamfer', () => newFeature('chamfer')));
    if (K.KERNEL.can.hole) toolbar.append(tb('hole', 'Hole', () => newFeature('hole')));
    if (K.KERNEL.can.shell) toolbar.append(tb('shell', 'Shell', () => newFeature('shell')));
    if (viewOnly) {
      toolbar.innerHTML = '';
      toolbar.append(el('div', { class: 'vo-note', html: icon('info') + '<span>View only: this part uses FreeTility CAD PRO features (fillet, chamfer, hole, shell or STEP). Open it in CAD PRO to edit it.</span>' }));
    }
  }

  async function patternMenu() {
    const r = await sheet('Pattern / Mirror', [
      { label: 'Linear pattern', value: 'lpattern', icon: 'lpattern', sub: 'Copies in a row or grid' },
      { label: 'Circular pattern', value: 'cpattern', icon: 'cpattern', sub: 'Copies around an axis' },
      { label: 'Mirror', value: 'mirror', icon: 'mirror', sub: 'Reflect features or the whole body' },
    ]);
    if (r) newFeature(r);
  }

  function renderChips(list) {
    chipsRow.innerHTML = '';
    chipsRow.classList.toggle('show', !!(list && list.length));
    for (const c of list || []) {
      chipsRow.append(el('button', { class: 'chip' + (c.danger ? ' danger' : ''), onclick: c.fn, html: icon(c.icon) + `<span>${esc(c.label)}</span>` }));
    }
  }

  function setHint(t) {
    hintBar.innerHTML = '';
    if (!t) { hintBar.classList.remove('show'); return; }
    hintBar.classList.add('show');
    hintBar.append(el('span', {}, t));
    if (mode === 'sketch' && ['line', 'cline', 'rect', 'circle', 'arc', 'dim', 'convert'].includes(sketcher.tool)) {
      const label = sketcher.tool === 'convert' && sketcher.hasDraft() ? 'Convert' : sketcher.hasDraft() ? 'Finish' : 'Done';
      hintBar.append(el('button', { class: 'hb', onclick: () => { if (!sketcher.finishDraft()) { sketcher.setTool('select'); renderToolbar(); } } }, label));
    }
  }

  // ------------------------------------------------------------ view buttons
  function renderVpBtns() {
    vpBtns.innerHTML = '';
    vpBtns.append(
      el('button', { class: 'fab', title: 'Views', onclick: viewMenu, html: icon('cube') }),
      el('button', { class: 'fab', title: 'Zoom to fit', onclick: () => (mode === 'sketch' ? lookAtSketch() : view.fit()), html: icon('fit') }));
  }

  async function viewMenu() {
    const items = [
      { label: 'Isometric', value: 'v:iso', icon: 'cube' },
      { label: 'Front', value: 'v:front' }, { label: 'Back', value: 'v:back' },
      { label: 'Top', value: 'v:top' }, { label: 'Bottom', value: 'v:bottom' },
      { label: 'Right', value: 'v:right' }, { label: 'Left', value: 'v:left' },
      { sep: true },
      { label: 'Shaded with edges', value: 'd:edges', on: prefs.display === 'edges' },
      { label: 'Shaded', value: 'd:shaded', on: prefs.display === 'shaded' },
      { label: 'Wireframe', value: 'd:wire', on: prefs.display === 'wire' },
      { sep: true },
      { label: Object.values(planeVis()).some(Boolean) ? 'Hide planes' : 'Show planes', value: 'planes', icon: 'plane' },
    ];
    if (mode === 'sketch') items.splice(0, 7);
    const r = await sheet('View', items);
    if (!r) return;
    if (r.startsWith('v:')) view.setView(r.slice(2));
    else if (r.startsWith('d:')) { prefs.display = r.slice(2); prefs.save(); view.setDisplay(prefs.display); }
    else if (r === 'planes') { const on = !Object.values(planeVis()).some(Boolean); showPlanes = on; doc.planeVis = { front: on, top: on, right: on }; dirty = true; scheduleSave(); applyPlanes(); treeRender(); }
  }
  let showPlanes = null;   // null = automatic: shown until there is a body
  const planesOn = () => (showPlanes == null ? !(built && built.body) : showPlanes);

  // ------------------------------------------------------------ rebuild + display
  function sketchPolys(sk, tol = 0.05) {
    return sk.ents.map((e) => ({ pts: G.tess(sk, e, tol), closed: e.t === 'circle', cons: !!e.cons }));
  }
  function usedSketches() {
    const s = new Set();
    for (const f of doc.features) if (f.type !== 'sketch' && f.sketch != null && !f.sup) s.add(f.sketch);
    return s;
  }
  function visibleSketches(extraFill) {
    const used = usedSketches();
    const out = [];
    for (const f of doc.features) {
      if (f.type !== 'sketch' || f.sup) continue;
      const selected = msel && msel.kind === 'sketch' && msel.id === f.id;
      const show = f.show === true || (f.show !== false && !used.has(f.id)) || selected;
      if (!show && !(extraFill && extraFill.id === f.id)) continue;
      const o = { id: f.id, plane: f.sketch.plane, polys: sketchPolys(f.sketch), color: selected ? 0x0d9488 : 0x2b4fc2, onTop: selected };
      if (extraFill && extraFill.id === f.id) { o.fill = extraFill.fill; o.onTop = true; if (extraFill.axis) o.polys.push(extraFill.axis); }
      out.push(o);
    }
    return out;
  }

  function refresh(fitAfter) {
    if (mode !== 'model') return;
    if (viewOnly) {
      built = { body: null, status: {}, frozen: doc.mesh ? M.unpackMesh(doc.mesh) : null };
      view.setBody(built.frozen);
      view.setSketches([]); view.showPlanes(false);
      treeRender(); updateTop();
      if (fitAfter) view.fit(false);
      return;
    }
    built = M.rebuild(doc);
    if (built.relinked) { dirty = true; scheduleSave(); }
    view.setBody(built.body ? K.mesh(built.body) : null);
    view.setPreview(null);
    view.setSketches(visibleSketches());
    view.sizePlanes(planeSize());
    if (msel && (msel.kind === 'feature' || msel.kind === 'sketch') && !doc.features.some((x) => x.id === msel.id)) msel = null;
    applyPlanes();
    if (msel && msel.kind === 'plane') view.highlightPlane(msel.name); else view.highlightPlane(null);
    if (msel && msel.kind === 'feature' && !panelState) { const f = doc.features.find((x) => x.id === msel.id); if (f) showGhost(f); }
    modelChips();
    treeRender();
    updateTop();
    if (fitAfter) view.fit(false);
  }

  function planeSize() {
    const b = view.bodyBox();
    if (!b || b.isEmpty()) return 100;
    const s = b.getSize(new view.THREE.Vector3());
    return Math.max(40, Math.max(s.x, s.y, s.z) * 1.3);
  }

  // ------------------------------------------------------------ model selection
  function onModelTap(x, y) {
    if (viewOnly) return;
    if (panelState && panelState.tap) { panelState.tap(x, y); return; }
    const h = view.pick(x, y);
    setMsel(h ? (h.kind === 'face' ? { kind: 'face', face: h } : h.kind === 'plane' ? { kind: 'plane', name: h.name } : { kind: 'sketch', id: h.id }) : null);
  }
  function setMsel(s) {
    msel = s;
    view.highlightFace(s && s.kind === 'face' ? s.face : null);
    view.highlightPlane(s && s.kind === 'plane' ? s.name : null);
    applyPlanes();
    view.setSketches(visibleSketches());
    if (mode === 'model' && !panelState) {
      clearGhost();
      if (s && s.kind === 'feature') { const f = doc.features.find((x) => x.id === s.id); if (f) showGhost(f); }
    }
    modelChips();
    treeRender();
  }
  function modelChips() {
    if (mode !== 'model' || panelState || !msel) { renderChips([]); return; }
    const L = [];
    if (msel.kind === 'plane' || (msel.kind === 'face' && msel.face.flat)) {
      L.push({ icon: 'sketch', label: 'Sketch', fn: () => startSketch() });
    }
    if (msel.kind === 'face' && !msel.face.flat) L.push({ icon: 'info', label: 'Curved face', fn: () => toast('Pick a flat face to sketch on') });
    if (msel.kind === 'feature') {
      const f = doc.features.find((x) => x.id === msel.id);
      if (f) {
        const st = built && built.status[f.id];
        if (st && st.ok === false) L.push({ icon: 'info', label: st.err, fn: () => toast(st.err, { kind: 'err' }) });
        L.push({ icon: 'edit', label: 'Edit', fn: () => editFeature(f.id) });
        if (f.sketch != null) L.push({ icon: 'sketch', label: 'Edit sketch', fn: () => enterSketch(f.sketch) });
        L.push({ icon: f.sup ? 'eye' : 'eyeoff', label: f.sup ? 'Unsuppress' : 'Suppress', fn: () => { f.sup = !f.sup; push((f.sup ? 'Suppress ' : 'Unsuppress ') + f.name); } });
        L.push({ icon: 'more', label: 'More', fn: () => featMenu(f) });
      }
    }
    if (msel.kind === 'sketch') {
      L.push({ icon: 'extrude', label: 'Extrude', fn: () => newFeature('extrude', 'add') },
        { icon: 'cut', label: 'Cut', fn: () => newFeature('extrude', 'cut') },
        { icon: 'revolve', label: 'Revolve', fn: () => newFeature('revolve', 'add') },
        { icon: 'edit', label: 'Edit sketch', fn: () => enterSketch(msel.id) });
    }
    L.push({ icon: 'close', label: 'Clear', fn: () => setMsel(null) });
    renderChips(L);
  }

  /** Sketch plane from the model selection. */
  function planeFromSel() {
    if (!msel) return null;
    if (msel.kind === 'plane') return { plane: M.PLANES[msel.name], ref: msel.name };
    if (msel.kind === 'face' && msel.face.flat) {
      const n = msel.face.normal, d = msel.face.d;
      const Y = [0, 1, 0];
      let y;
      if (Math.abs(M.v3.dot(n, Y)) > 0.9) y = n[1] > 0 ? [0, 0, -1] : [0, 0, 1];
      else y = M.v3.norm(M.v3.sub(Y, M.v3.mul(n, M.v3.dot(n, Y))));
      const x = M.v3.norm(M.v3.cross(y, n));
      y = M.v3.cross(n, x);
      return { plane: { o: M.v3.mul(n, d), x, y, n }, ref: 'face' };
    }
    return null;
  }

  // ------------------------------------------------------------ sketch mode
  async function startSketch(after) {
    let p = planeFromSel();
    if (!p) {
      const r = await sheet('Sketch on…', [
        { label: 'Front Plane', value: 'front', icon: 'plane' },
        { label: 'Top Plane', value: 'top', icon: 'plane' },
        { label: 'Right Plane', value: 'right', icon: 'plane' },
        { sep: true },
        { label: 'A flat face: close this and tap a face first', value: null, icon: 'info', disabled: true },
      ]);
      if (!r) return;
      p = { plane: M.PLANES[r], ref: r };
    }
    const f = { id: doc.nid++, type: 'sketch', name: M.nextName(doc, 'Sketch'), sketch: M.newSketch(p.plane, p.ref) };
    doc.features.push(f);
    pendingAfterSketch = after || null;
    push('New sketch');
    enterSketch(f.id, true);
  }

  function enterSketch(id, fresh) {
    const f = doc.features.find((x) => x.id === id);
    if (!f) return;
    if (panelState) closePanel(false);
    mode = 'sketch';
    editSketchId = id;
    msel = null;
    view.highlightFace(null);
    root.classList.add('sketching');
    // show the model as it was before this sketch
    const idx = doc.features.indexOf(f);
    const r = M.rebuild(doc, { upto: idx, keepCache: true });
    view.setBody(r.body ? K.mesh(r.body) : null);
    view.setPreview(null);
    view.setSketches([]);
    view.showPlanes(false);
    view.lockRotate(true);
    sketcher.settings.relations = prefs.relations;
    sketcher.settings.grid = prefs.grid;
    sketchBody = r.body || null;
    const medges = r.body ? M.bodyEdges(r.body) : [];
    if (f.sketch.cons.some((c) => c.t === 'ext' || c.t === 'exton' || c.t === 'extr')) {
      if (ME.relink(f.sketch, medges).changed) S.solve(f.sketch);
    }
    sketcher.open(f.sketch);
    sketcher.setModelEdges(medges);
    enterIndex = hi;
    if (!fresh) f._fresh = false; else f._fresh = true;
    lookAtSketch(true);
    updateTop(); renderToolbar(); renderVpBtns(); treeRender();
    if (fresh) { sketcher.setTool('line'); renderToolbar(); }
  }

  function lookAtSketch(initial) {
    const sk = sketcher.sketch;
    if (!sk) return;
    const b = sketcher.bounds();
    const pl = sk.plane;
    let center, scale;
    const r = vp.getBoundingClientRect();
    if (b) {
      const cu = (b.mnx + b.mxx) / 2, cv = (b.mny + b.mxy) / 2;
      center = M.toWorld(pl, cu, cv);
      scale = Math.max((b.mxx - b.mnx) / (r.width * 0.7), (b.mxy - b.mny) / (r.height * 0.6), 0.02);
    } else {
      const bb = view.bodyBox();
      if (bb && !bb.isEmpty() && pl.o) {
        // the part's centre, dropped onto the sketch plane
        const c3 = bb.getCenter(new view.THREE.Vector3()).toArray();
        center = M.v3.sub(c3, M.v3.mul(pl.n, M.v3.dot(M.v3.sub(c3, pl.o), pl.n)));
        const s = bb.getSize(new view.THREE.Vector3());
        scale = Math.max(s.x, s.y, s.z) * 1.6 / Math.min(r.width, r.height);
      } else { center = pl.o; scale = initial ? 0.2 : view.st.scale; }
    }
    view.normalTo(pl, center, scale);
  }

  async function exitSketch(silent) {
    const f = doc.features.find((x) => x.id === editSketchId);
    sketcher.close();
    mode = 'model';
    root.classList.remove('sketching');
    statusPill.className = 'sk-status';
    setHint(null);
    view.lockRotate(false);
    view.tool = null;
    view.onTap = modelTap;
    editSketchId = null;
    if (f && !f.sketch.ents.length && f._fresh) {
      doc.features = doc.features.filter((x) => x !== f);
      push('Empty sketch removed');
    }
    if (f) delete f._fresh;
    renderToolbar(); renderVpBtns(); updateTop();
    refresh();
    view.setView('iso');
    if (!silent && f && doc.features.includes(f)) {
      setMsel({ kind: 'sketch', id: f.id });
      if (pendingAfterSketch) { const p = pendingAfterSketch; pendingAfterSketch = null; newFeature(p.type, p.op, f.id); }
    }
    pendingAfterSketch = null;
  }

  async function sketchMenu() {
    const r = await sheet('Sketch', [
      { label: prefs.relations ? 'Hide relations' : 'Show relations', value: 'rel', icon: 'rel_par' },
      { label: prefs.grid ? 'Hide grid' : 'Show grid', value: 'grid', icon: 'fit' },
      { label: 'Snapping…', value: 'snap', icon: 'magnet' },
      { label: 'Units: ' + U.label, value: 'units', icon: 'ruler' },
      { label: 'View', value: 'view', icon: 'cube' },
      { sep: true },
      { label: 'Discard changes in this sketch', value: 'discard', icon: 'close', danger: true },
    ]);
    if (r === 'rel') { prefs.relations = !prefs.relations; prefs.save(); sketcher.settings.relations = prefs.relations; sketcher.render(); }
    if (r === 'grid') { prefs.grid = !prefs.grid; prefs.save(); sketcher.settings.grid = prefs.grid; sketcher.render(); }
    if (r === 'units') switchUnits();
    if (r === 'snap') snapDialog();
    if (r === 'view') viewMenu();
    if (r === 'discard') {
      // walk back the history to the state before this sketch was opened
      const ok = await confirmBox('Discard changes', 'Undo every change made since you opened this sketch?', 'Discard', true);
      if (!ok) return;
      while (hi > enterIndex && hi > 0) { hi--; }
      restoreState(hist[hi].s);
      if (mode === 'sketch') exitSketch(true);
    }
  }
  let enterIndex = 0;

  // ------------------------------------------------------------ feature panels
  function sketchesAvail(beforeIdx) {
    const list = doc.features.slice(0, beforeIdx == null ? doc.features.length : beforeIdx).filter((f) => f.type === 'sketch' && !f.sup && f.sketch.ents.length);
    return list;
  }

  function defaultSketch() {
    if (msel && msel.kind === 'sketch') return msel.id;
    const used = usedSketches();
    const free = sketchesAvail().filter((f) => !used.has(f.id));
    if (free.length) return free[free.length - 1].id;
    return null;
  }

  async function newFeature(type, op, sketchId) {
    if (panelState) return;
    let f;
    if (type === 'extrude' || type === 'revolve') {
      const sid = sketchId != null ? sketchId : defaultSketch();
      if (sid == null) {
        toast('Draw a sketch first. Pick a plane or face for it.');
        startSketch({ type, op });
        return;
      }
      if (type === 'extrude') f = { type, op, sketch: sid, end: 'blind', depth: 10, rev: false, regions: null };
      else {
        const sk = doc.features.find((x) => x.id === sid).sketch;
        const cl = sk.ents.filter((e) => e.t === 'line' && e.cons);
        f = { type, op, sketch: sid, axis: cl.length ? cl[0].id : null, angle: 360, mid: false, rev: false, regions: null };
      }
      if (type === 'extrude' && op === 'cut') {
        // a sketch on a model face cuts into the material; one on a reference plane cuts both ways
        const sk = doc.features.find((x) => x.id === sid).sketch;
        if (sk.ref === 'face') { f.end = 'through'; f.rev = true; } else f.end = 'through2';
      }
    } else if (['fillet', 'chamfer', 'shell', 'hole'].includes(type)) {
      if (!built || !built.body) { toast('Make a solid body first'); return; }
      if (type === 'fillet') f = { type, r: 2, edges: [] };
      if (type === 'chamfer') f = { type, d: 1, edges: [] };
      if (type === 'shell') f = { type, t: 1, faces: [], out: false };
      if (type === 'hole') {
        f = { type, op: 'cut', kind: 'simple', dia: 5, end: 'blind', depth: 10, tip: true, cbDia: 9, cbDepth: 4, csDia: 10, csAng: 90, plane: null, pts: [] };
        if (msel && msel.kind === 'face' && msel.face.flat) { f.plane = planeOfFace(msel.face); f.pts.push(planeUV(f.plane, msel.face.point)); }
      }
      if ((type === 'fillet' || type === 'chamfer') && msel && msel.kind === 'face' && msel.face.edges) {
        f.edges = msel.face.edges.map((id) => edgeRef(id)).filter(Boolean);
      }
    } else {
      const src = doc.features.filter((x) => (x.type === 'extrude' || x.type === 'revolve' || x.type === 'hole') && !x.sup);
      if (!src.length && type !== 'mirror') { toast('Make an extrude or revolve first'); return; }
      if (!src.length && !built?.body) { toast('Nothing to mirror yet'); return; }
      const last = src.length ? [src[src.length - 1].id] : [];
      if (type === 'lpattern') f = { type, feats: last, dir: 'x', rev: false, d: 20, n: 3, dir2: null, d2: 20, n2: 2, rev2: false };
      if (type === 'cpattern') f = { type, feats: last, axis: 'y', n: 4, angle: 360, equal: true, rev: false };
      if (type === 'mirror') f = { type, feats: last, whole: !src.length, plane: 'right' };
    }
    f.id = doc.nid++;
    f.name = M.nextName(doc, M.labelOf(f));
    openPanel(f, true);
  }

  function editFeature(id) {
    const f = doc.features.find((x) => x.id === id);
    if (!f) return;
    if (f.type === 'sketch') { enterSketch(id); return; }
    openPanel(JSON.parse(JSON.stringify(f)), false);
  }

  function openPanel(f, isNew) {
    setMsel(null);
    showTree(false);
    const idx = isNew ? doc.features.length : doc.features.findIndex((x) => x.id === f.id);
    panelState = { f, isNew, idx, pick: false, showResult: false };
    if (f.type === 'fillet' || f.type === 'chamfer') panelState.tap = edgeTap;
    if (f.type === 'shell') panelState.tap = shellTap;
    if (f.type === 'hole') panelState.tap = holeTap;
    root.classList.add('paneling');
    renderToolbar(); renderChips([]);
    panelState.unback = pushBack(() => closePanel(false));
    buildPanel();
    preview();
  }

  function closePanel(commit) {
    const ps = panelState;
    if (!ps) return;
    if (commit) {
      const err = ps.lastErr;
      if (err) { toast(err, { kind: 'err' }); return; }
      if (ps.isNew) doc.features.push(ps.f);
      else doc.features[ps.idx] = ps.f;
    }
    ps.unback();
    panelState = null;
    root.classList.remove('paneling');
    panel.innerHTML = '';
    view.setGhost(false);
    view.highlightEdges(null); view.highlightFaces(null);
    renderToolbar();
    if (commit) { push((ps.isNew ? '' : 'Edit ') + ps.f.name); haptic(); }
    else refresh();
  }

  let pvTimer = null;
  function preview() {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(previewNow, 90);
  }
  function previewNow() {
    const ps = panelState;
    if (!ps) return;
    const f = ps.f;
    const r = M.rebuild(doc, { extra: f, replace: ps.isNew ? null : f.id });
    const st = r.status[f.id] || {};
    ps.lastErr = st.ok === false ? st.err : null;
    const picking = (f.type === 'fillet' || f.type === 'chamfer' || f.type === 'shell') && !ps.showResult;
    const shown = picking ? r.before : r.body;
    const sm = shown ? K.mesh(shown) : null;
    view.setBody(sm);
    view.setPreview(r.previewTool && f.type !== 'hole' ? K.mesh(r.previewTool) : null, f.op);
    if (picking && sm) {
      if (f.type === 'shell') view.highlightFaces(faceIdsFor(sm, f.faces));
      else view.highlightEdges(edgeIdsFor(sm, f.edges));
    }
    if (f.type === 'hole') {
      if (f.plane) {
        const R0 = (+f.dia || 1) / 2;
        const circ = (u, v, r) => ({ pts: Array.from({ length: 33 }, (_, i) => [u + r * Math.cos(i / 32 * 2 * Math.PI), v + r * Math.sin(i / 32 * 2 * Math.PI)]) });
        const polys = [];
        for (const [u, v] of f.pts) {
          polys.push(circ(u, v, R0));
          polys.push({ pts: [[u - R0 * 0.4, v], [u + R0 * 0.4, v]] }, { pts: [[u, v - R0 * 0.4], [u, v + R0 * 0.4]] });
        }
        view.setSketches([...visibleSketches(), { id: -1, plane: f.plane, polys, color: 0xe8820c, onTop: true }]);
      } else view.setSketches(visibleSketches());
      const errBox = panel.querySelector('.p-err');
      if (errBox) { errBox.textContent = ps.lastErr || st.warn || ''; errBox.className = 'p-err' + (ps.lastErr ? ' bad' : st.warn ? ' warn' : ''); }
      return;
    }
    // sketch region display
    let fill = null;
    if (f.sketch != null) {
      const sf = doc.features.find((x) => x.id === f.sketch);
      if (sf) {
        let faces = [];
        try { faces = G.findFaces(sf.sketch).faces; } catch (e) { faces = []; }
        const picked = f.regions ? G.pickRegions(faces, f.regions) || [] : null;
        const pickedKeys = new Set((picked || []).map((x) => x.key));
        fill = [];
        if (ps.pick) {
          for (const r of G.faceRegions(faces)) {
            const on = picked ? pickedKeys.has(r.key) : true;
            fill.push({ outer: r.outer, holes: r.holes, color: on ? 0x14b8a6 : 0x5d7f8a, opacity: on ? 0.5 : 0.22 });
          }
        }
        let axis = null;
        if (f.type === 'revolve' && f.axis != null) {
          const e = sf.sketch.ents.find((x) => x.id === f.axis);
          if (e) axis = { pts: G.tess(sf.sketch, e), cons: false };
        }
        view.setSketches(visibleSketches({ id: f.sketch, fill, axis }));
      }
    } else view.setSketches(visibleSketches());
    const errBox = panel.querySelector('.p-err');
    if (errBox) {
      errBox.textContent = ps.lastErr || st.warn || '';
      errBox.className = 'p-err' + (ps.lastErr ? ' bad' : st.warn ? ' warn' : '');
    }
  }

  // ---- panel builder
  function buildPanel() {
    const ps = panelState, f = ps.f;
    panel.innerHTML = '';
    const head = el('div', { class: 'p-head' },
      el('button', { class: 'ib', title: 'Cancel', onclick: () => closePanel(false), html: icon('close') }),
      el('div', { class: 'p-title' }, el('div', { class: 't1' }, f.name), el('div', { class: 't2' }, ps.isNew ? 'New feature' : 'Edit feature')),
      el('button', { class: 'ok-btn', title: 'OK', onclick: () => closePanel(true), html: icon('check') + '<span>OK</span>' }));
    const body = el('div', { class: 'p-body' });
    panel.append(head, body);
    const upd = (rebuildPanel) => { if (rebuildPanel) buildPanel(); preview(); };
    const row = (label, ctl) => el('div', { class: 'p-row' }, el('label', {}, label), ctl);
    const lenInput = (key, label, min = 0) => {
      const inp = el('input', { type: 'text', inputmode: 'decimal', value: U.edit(+f[key]) });
      inp.addEventListener('change', () => { const v = parseLen(inp.value); if (v > min) { f[key] = v; inp.value = U.edit(v); upd(); } else { inp.value = U.edit(+f[key]); toast('Enter a value above ' + min); } });
      return row(`${label} (${U.label})`, stepper(inp, (d) => { const step = U.units === 'in' ? 0.0625 * 25.4 : 1; f[key] = Math.max(step, +f[key] + d * step); inp.value = U.edit(f[key]); upd(); }));
    };
    const numInput = (key, label, min, max, isAng) => {
      const inp = el('input', { type: 'text', inputmode: 'decimal', value: isAng ? String(+(+f[key]).toFixed(3)) : String(f[key]) });
      inp.addEventListener('change', () => {
        let v = isAng ? parseAng(inp.value) : Math.round(parseNum(inp.value));
        if (!(v >= min && v <= max)) { inp.value = String(f[key]); toast(`Enter ${min} to ${max}`); return; }
        f[key] = v; inp.value = String(v); upd();
      });
      return row(label, stepper(inp, (d) => { const v = Math.min(max, Math.max(min, +f[key] + d * (isAng ? 5 : 1))); f[key] = v; inp.value = String(v); upd(); }));
    };
    const tog = (key, label, onChange) => toggle(label, !!f[key], (v) => { f[key] = v; if (onChange) onChange(v); upd(!!onChange); });
    const seg = (key, opts, label, rebuild) => row(label, segmented(opts, f[key], (v) => { f[key] = v; upd(rebuild); }));
    const sketchSel = () => {
      const s = el('select', {});
      for (const sf of sketchesAvail(ps.isNew ? null : ps.idx)) s.append(el('option', { value: sf.id, selected: sf.id === f.sketch }, sf.name));
      s.addEventListener('change', () => { f.sketch = +s.value; f.regions = null; if (f.type === 'revolve') { const sk = doc.features.find((x) => x.id === f.sketch).sketch; const cl = sk.ents.filter((e) => e.t === 'line' && e.cons); f.axis = cl.length ? cl[0].id : null; } upd(true); });
      return row('Sketch', s);
    };
    const opSeg = () => row('Type', segmented([['add', 'Boss'], ['cut', 'Cut']], f.op, (v) => {
      f.op = v;
      if (ps.isNew) f.name = M.nextName(doc, M.labelOf(f));
      if (f.type === 'extrude' && v === 'cut' && f.end === 'blind') { /* keep */ }
      upd(true);
    }));
    const regionsUI = () => {
      const box = el('div', { class: 'p-reg' });
      box.append(segmented([['all', 'All regions'], ['pick', 'Pick regions']], f.regions ? 'pick' : 'all', (v) => {
        if (v === 'all') { f.regions = null; ps.pick = false; ps.tap = null; } else { f.regions = f.regions || []; ps.pick = true; ps.tap = regionTap; }
        upd(true);
      }));
      if (f.regions) {
        ps.pick = true; ps.tap = regionTap;
        box.append(el('div', { class: 'hint' }, f.regions.length ? `${f.regions.length} region${f.regions.length > 1 ? 's' : ''} picked · tap regions in the view to add or remove` : 'Tap regions of the sketch in the view'));
      }
      return row('Profile', box);
    };
    const featPick = () => {
      const box = el('div', { class: 'p-feats' });
      const candidates = doc.features.slice(0, ps.isNew ? doc.features.length : ps.idx).filter((x) => (x.type === 'extrude' || x.type === 'revolve' || x.type === 'hole') && !x.sup);
      if (!candidates.length) box.append(el('div', { class: 'hint' }, 'No extrude or revolve features yet'));
      for (const c of candidates) {
        const on = f.feats.includes(c.id);
        box.append(el('button', {
          class: 'fchip' + (on ? ' on' : ''), type: 'button',
          onclick: () => { if (on) f.feats = f.feats.filter((x) => x !== c.id); else f.feats = [...f.feats, c.id].sort((a, b) => doc.features.findIndex((x) => x.id === a) - doc.features.findIndex((x) => x.id === b)); upd(true); },
          html: icon(featIcon(c)) + `<span>${esc(c.name)}</span>`,
        }));
      }
      return row('Features to repeat', box);
    };

    if (f.type === 'extrude') {
      body.append(opSeg(), sketchSel());
      const ends = [['blind', 'Blind'], ['mid', 'Mid plane'], ['through', 'Through all']];
      if (f.op === 'cut') ends.push(['through2', 'Through both']);
      body.append(row('End', segmented(ends, f.end, (v) => { f.end = v; upd(true); })));
      if (f.end === 'blind' || f.end === 'mid') body.append(lenInput('depth', 'Depth'));
      if (f.end === 'blind' || f.end === 'through') body.append(tog('rev', 'Reverse direction'));
      body.append(regionsUI());
    } else if (f.type === 'revolve') {
      body.append(opSeg(), sketchSel());
      const sf = doc.features.find((x) => x.id === f.sketch);
      const s = el('select', {});
      s.append(el('option', { value: '' }, 'Choose a line…'));
      if (sf) {
        const lines = sf.sketch.ents.filter((e) => e.t === 'line').sort((a, b) => (b.cons ? 1 : 0) - (a.cons ? 1 : 0));
        lines.forEach((e, i) => {
          const a = sf.sketch.pts[e.a], b = sf.sketch.pts[e.b];
          const len = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.abs(Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI);
          const dir = ang < 1 || ang > 179 ? 'horizontal' : Math.abs(ang - 90) < 1 ? 'vertical' : 'angled';
          s.append(el('option', { value: e.id, selected: e.id === f.axis }, `${e.cons ? 'Centerline' : 'Line'} ${i + 1} · ${dir} · ${U.fmtU(len)}`));
        });
      }
      s.addEventListener('change', () => { f.axis = s.value ? +s.value : null; upd(); });
      body.append(row('Axis', s));
      body.append(numInput('angle', 'Angle (°)', 0.1, 360, true));
      if (+f.angle < 360) body.append(tog('mid', 'Mid plane', () => {}), tog('rev', 'Reverse direction'));
      body.append(regionsUI());
    } else if (f.type === 'lpattern') {
      body.append(featPick());
      body.append(seg('dir', [['x', 'X'], ['y', 'Y'], ['z', 'Z']], 'Direction'), tog('rev', 'Reverse direction'));
      body.append(lenInput('d', 'Spacing'), numInput('n', 'Instances', 2, 200));
      body.append(toggle('Second direction', !!f.dir2, (v) => { f.dir2 = v ? (f.dir === 'y' ? 'x' : 'y') : null; upd(true); }));
      if (f.dir2) {
        body.append(seg('dir2', [['x', 'X'], ['y', 'Y'], ['z', 'Z']], 'Direction 2'), tog('rev2', 'Reverse direction 2'));
        body.append(lenInput('d2', 'Spacing 2'), numInput('n2', 'Instances 2', 2, 200));
      }
    } else if (f.type === 'cpattern') {
      body.append(featPick());
      body.append(seg('axis', [['x', 'X axis'], ['y', 'Y axis'], ['z', 'Z axis']], 'Axis'));
      body.append(numInput('n', 'Instances', 2, 360), numInput('angle', 'Total angle (°)', 0.1, 360, true));
      body.append(tog('equal', 'Equal spacing'), tog('rev', 'Reverse direction'));
    } else if (f.type === 'mirror') {
      body.append(row('Mirror', segmented([['feats', 'Features'], ['body', 'Whole body']], f.whole ? 'body' : 'feats', (v) => { f.whole = v === 'body'; upd(true); })));
      if (!f.whole) body.append(featPick());
      const pv = typeof f.plane === 'string' ? f.plane : 'face';
      body.append(row('Mirror plane', segmented([['front', 'Front'], ['top', 'Top'], ['right', 'Right'], ['face', 'Face…']], pv, (v) => {
        if (v === 'face') { ps.tap = faceTapForMirror; toast('Tap a flat face in the view'); }
        else { f.plane = v; ps.tap = null; view.highlightFace(null); }
        upd(v !== 'face');
      })));
      if (pv === 'face') body.append(el('div', { class: 'hint' }, 'Mirroring about a picked face'));
    }
    else if (f.type === 'fillet' || f.type === 'chamfer') {
      body.append(f.type === 'fillet' ? lenInput('r', 'Radius') : lenInput('d', 'Distance'));
      body.append(row('Edges', el('div', { class: 'p-reg' },
        el('div', { class: 'hint' }, f.edges.length ? `${f.edges.length} edge${f.edges.length > 1 ? 's' : ''} · tap edges (or a face for all its edges)` : 'Tap edges, or a face for all its edges'),
        f.edges.length ? el('button', { class: 'btn', type: 'button', onclick: () => { f.edges = []; upd(true); } }, 'Clear') : null)));
      body.append(toggle('Show result', ps.showResult, (v) => { ps.showResult = v; ps.tap = v ? null : edgeTap; preview(); }));
    } else if (f.type === 'shell') {
      body.append(lenInput('t', 'Thickness'));
      body.append(tog('out', 'Thicken outward'));
      body.append(row('Open faces', el('div', { class: 'p-reg' },
        el('div', { class: 'hint' }, f.faces.length ? `${f.faces.length} face${f.faces.length > 1 ? 's' : ''} removed · tap flat faces to add or remove` : 'Tap the flat faces to remove'),
        f.faces.length ? el('button', { class: 'btn', type: 'button', onclick: () => { f.faces = []; upd(true); } }, 'Clear') : null)));
      body.append(toggle('Show result', ps.showResult, (v) => { ps.showResult = v; ps.tap = v ? null : shellTap; preview(); }));
    } else if (f.type === 'hole') {
      body.append(row('Type', segmented([['simple', 'Simple'], ['cbore', 'Counterbore'], ['csink', 'Countersink']], f.kind, (v) => { f.kind = v; upd(true); })));
      body.append(lenInput('dia', 'Diameter'));
      body.append(row('End', segmented([['blind', 'Blind'], ['through', 'Through all']], f.end, (v) => { f.end = v; upd(true); })));
      if (f.end === 'blind') body.append(lenInput('depth', 'Depth'), tog('tip', 'Drill point (118°)'));
      if (f.kind === 'cbore') body.append(lenInput('cbDia', 'Counterbore ⌀'), lenInput('cbDepth', 'Counterbore depth'));
      if (f.kind === 'csink') body.append(lenInput('csDia', 'Countersink ⌀'), numInput('csAng', 'Countersink angle (°)', 30, 150, true));
      const list = el('div', { class: 'p-pts' });
      if (!f.plane) list.append(el('div', { class: 'hint' }, 'Tap a flat face to place the first hole'));
      else {
        f.pts.forEach((p, i) => {
          const ix = el('input', { type: 'text', inputmode: 'decimal', value: U.edit(p[0]) });
          const iy = el('input', { type: 'text', inputmode: 'decimal', value: U.edit(p[1]) });
          const setv = (k, inp) => inp.addEventListener('change', () => { const v = parseLen(inp.value); if (Number.isFinite(v)) { p[k] = v; inp.value = U.edit(v); upd(); } else inp.value = U.edit(p[k]); });
          setv(0, ix); setv(1, iy);
          list.append(el('div', { class: 'pt-row' }, el('span', {}, (i + 1) + '.'), el('label', {}, 'X'), ix, el('label', {}, 'Y'), iy,
            el('button', { class: 'ib', type: 'button', title: 'Remove', onclick: () => { f.pts.splice(i, 1); upd(true); }, html: icon('close') })));
        });
        list.append(el('div', { class: 'hint' }, 'Tap the face to add holes. X and Y are measured on the face from the model origin.'));
        list.append(el('button', { class: 'btn', type: 'button', onclick: () => { f.plane = null; f.pts = []; upd(true); } }, 'Pick another face'));
      }
      body.append(row(`Positions (${U.label})`, list));
    }
    body.append(el('div', { class: 'p-err' }));
  }

  // ---- PRO picking helpers
  const r4 = (a) => a.map((v) => Math.round(v * 1e4) / 1e4);
  function edgeRef(id) {
    const e = view.edgeAt(id);
    return e ? { p: r4(e.mid), d: r4(e.dir) } : null;
  }
  function polyDist(p, pts) {
    let best = Infinity;
    if (pts.length === 3) return M.v3.len(M.v3.sub(p, [pts[0], pts[1], pts[2]]));
    for (let i = 0; i + 3 < pts.length; i += 3) {
      const a = [pts[i], pts[i + 1], pts[i + 2]], b = [pts[i + 3], pts[i + 4], pts[i + 5]];
      const d = M.v3.sub(b, a), l2 = M.v3.dot(d, d) || 1;
      const t = Math.max(0, Math.min(1, M.v3.dot(M.v3.sub(p, a), d) / l2));
      best = Math.min(best, M.v3.len(M.v3.sub(p, M.v3.add(a, M.v3.mul(d, t)))));
    }
    return best;
  }
  function diagOf(m) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], m.pos[i + k]); mx[k] = Math.max(mx[k], m.pos[i + k]); }
    return Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
  }
  /** Edge ids of mesh m that match the stored refs. */
  function edgeIdsFor(m, refs, tolOverride) {
    if (!m.edges) return [];
    const tol = tolOverride || Math.max(0.05, diagOf(m) * 0.01);
    const ids = [];
    for (const r of refs || []) {
      let best = -1, bs = Infinity;
      m.edges.forEach((e, i) => {
        const d = polyDist(r.p, e.pts);
        const sc = d + (1 - Math.abs(M.v3.dot(r.d || e.dir, e.dir))) * tol;
        if (d <= tol && sc < bs) { bs = sc; best = i; }
      });
      if (best >= 0) ids.push(best);
    }
    return ids;
  }
  function faceIdsFor(m, refs) {
    if (!m.faceInfo) return [];
    const tol = Math.max(0.05, diagOf(m) * 0.005);
    const ids = [];
    for (const r of refs || []) {
      const i = m.faceInfo.findIndex((fi) => fi.flat && M.v3.dot(fi.n, r.n) > 0.995 && Math.abs(M.v3.dot(fi.n, r.p) - fi.d) <= tol);
      if (i >= 0) ids.push(i);
    }
    return ids;
  }
  function edgeTap(x, y) {
    const f = panelState.f;
    const h = view.pick(x, y, { body: true, edges: true });
    if (!h || (h.kind !== 'edge' && h.kind !== 'face')) return;
    const ids = h.kind === 'edge' ? [h.id] : (h.edges || []);
    // which stored refs point at each of these edges (tight tolerance: same edge only)
    const refsOn = (id) => f.edges.filter((r) => edgeIdsFor({ edges: [view.edgeAt(id)], pos: new Float32Array(0) }, [r], 1e-3).length);
    const allSel = ids.every((id) => refsOn(id).length);
    if (allSel) { const dead = new Set(ids.flatMap(refsOn)); f.edges = f.edges.filter((r) => !dead.has(r)); }
    else for (const id of ids) if (!refsOn(id).length) f.edges.push(edgeRef(id));
    haptic();
    buildPanel(); preview();
  }
  function shellTap(x, y) {
    const f = panelState.f;
    const h = view.pick(x, y, { body: true });
    if (!h || h.kind !== 'face') return;
    if (!h.flat) { toast('Pick flat faces to open'); return; }
    const i = f.faces.findIndex((r) => M.v3.dot(r.n, h.normal) > 0.995 && Math.abs(M.v3.dot(h.normal, r.p) - h.d) < 1e-3);
    if (i >= 0) f.faces.splice(i, 1); else f.faces.push({ p: r4(h.point), n: r4(h.normal) });
    haptic();
    buildPanel(); preview();
  }
  function planeOfFace(face) {
    const n = face.normal, Y = [0, 1, 0];
    let y;
    if (Math.abs(M.v3.dot(n, Y)) > 0.9) y = n[1] > 0 ? [0, 0, -1] : [0, 0, 1];
    else y = M.v3.norm(M.v3.sub(Y, M.v3.mul(n, M.v3.dot(n, Y))));
    const x = M.v3.norm(M.v3.cross(y, n));
    y = M.v3.cross(n, x);
    return { o: M.v3.mul(n, face.d), x, y, n };
  }
  function planeUV(pl, p) { const d = M.v3.sub(p, pl.o); return r4([M.v3.dot(d, pl.x), M.v3.dot(d, pl.y)]); }
  function holeTap(x, y) {
    const f = panelState.f;
    if (!f.plane) {
      const h = view.pick(x, y, { body: true });
      if (!h || h.kind !== 'face' || !h.flat) { toast('Tap a flat face'); return; }
      f.plane = planeOfFace(h);
      f.pts.push(planeUV(f.plane, h.point));
    } else {
      const uv = view.toPlane(x, y, f.plane);
      if (!uv) return;
      f.pts.push(r4(holeSnap(x, y, f.plane) || uv));
    }
    haptic();
    buildPanel(); preview();
  }

  /** Nearest model corner / edge midpoint / circle centre on the hole's face, within reach of the finger. */
  function holeSnap(x, y, pl) {
    if (!prefs.snap.model || !built || !built.body) return null;
    const idx = panelState && !panelState.isNew ? panelState.idx : doc.features.length;
    const r = M.rebuild(doc, { upto: idx, keepCache: true });
    if (!r.body) return null;
    const edges = ME.inPlane(M.bodyEdges(r.body), pl, 1e-3);
    let best = null, bd = 22;
    const cand = (P) => { const s = view.toScreen(P); const d = Math.hypot(s[0] - x, s[1] - y); if (d < bd) { bd = d; best = P; } };
    for (const e of edges) {
      if (prefs.snap.center && e.circ) cand(e.circ.c);
      if (!e.closed) { if (prefs.snap.points) { cand(e.a); cand(e.b); } if (prefs.snap.mid) cand(e.mid); }
    }
    return best ? planeUV(pl, best) : null;
  }

  function stepper(inp, onStep) {
    return el('div', { class: 'stepper' },
      el('button', { type: 'button', class: 'sbtn', onclick: () => onStep(-1) }, '−'), inp,
      el('button', { type: 'button', class: 'sbtn', onclick: () => onStep(1) }, '+'));
  }

  function regionTap(x, y) {
    const ps = panelState, f = ps.f;
    const sf = doc.features.find((s) => s.id === f.sketch);
    if (!sf) return;
    const p = view.toPlane(x, y, sf.sketch.plane);
    if (!p) return;
    const { faces } = G.findFaces(sf.sketch);
    const hit = G.pickRegions(faces, [p]);
    if (!hit || !hit.length) { toast('Tap inside a closed region of the sketch'); return; }
    const key = hit[0].key;
    // remove an existing pick that lands in the same region, else add
    const keep = (f.regions || []).filter((q) => { const r = G.pickRegions(faces, [q]); return !(r && r.length && r[0].key === key); });
    if (keep.length === (f.regions || []).length) keep.push(p);
    f.regions = keep;
    haptic();
    buildPanel();
    preview();
  }

  function faceTapForMirror(x, y) {
    const h = view.pick(x, y, { body: true });
    if (!h || h.kind !== 'face' || !h.flat) { toast('Tap a flat face'); return; }
    panelState.f.plane = { o: M.v3.mul(h.normal, h.d), n: h.normal };
    view.highlightFace(h);
    buildPanel();
    preview();
  }

  // ------------------------------------------------------------ feature tree
  function featIcon(f) {
    if (f.type === 'extrude') return f.op === 'cut' ? 'cut' : 'extrude';
    if (f.type === 'revolve') return f.op === 'cut' ? 'cutrevolve' : 'revolve';
    return { sketch: 'sketch', lpattern: 'lpattern', cpattern: 'cpattern', mirror: 'mirror', fillet: 'fillet', chamfer: 'chamfer', shell: 'shell', hole: 'hole', import: 'import' }[f.type] || 'info';
  }

  // ---- materials (density in g/cm³)
  const MATERIALS = [
    ['Plain carbon steel', 7.85], ['Stainless steel (304)', 8.0], ['Cast iron', 7.2], ['Aluminium 6061', 2.7],
    ['Brass', 8.5], ['Copper', 8.96], ['Titanium Ti-6Al-4V', 4.43], ['PLA', 1.24], ['ABS', 1.04], ['PETG', 1.27],
    ['Nylon (PA12)', 1.01], ['Acrylic (PMMA)', 1.18], ['Polycarbonate', 1.2], ['Oak', 0.75], ['Pine', 0.5],
  ];
  async function pickMaterial() {
    if (viewOnly) return;
    const cur = doc.material && doc.material.name;
    const r = await sheet('Material', [
      ...MATERIALS.map(([n, rho]) => ({ label: n, sub: rho + ' g/cm³', value: n, on: n === cur })),
      { label: 'Custom density…', value: '__custom', icon: 'edit' },
      ...(doc.material ? [{ sep: true }, { label: 'Remove material', value: '__none', icon: 'close', danger: true }] : []),
    ]);
    if (!r) return;
    if (r === '__none') { delete doc.material; push('Remove material'); return; }
    if (r === '__custom') {
      const rho = await promptBox({ title: 'Custom material', label: 'Density (g/cm³)', value: doc.material ? String(doc.material.rho) : '1', parse: (v) => { const x = parseNum(v); return x > 0 ? x : NaN; } });
      if (rho == null) return;
      doc.material = { name: 'Custom (' + rho + ' g/cm³)', rho };
    } else doc.material = { name: r, rho: MATERIALS.find((m) => m[0] === r)[1] };
    push('Material ' + doc.material.name);
  }

  // ---- reference planes: automatic (shown until there is a body) unless set per plane
  function planeVis() {
    const auto = planesOn();
    const pv = doc.planeVis || {};
    const v = {};
    for (const n of ['front', 'top', 'right']) v[n] = pv[n] != null ? pv[n] : auto;
    if (msel && msel.kind === 'plane') v[msel.name] = true;
    return v;
  }
  function applyPlanes() {
    if (mode !== 'model') { view.showPlanes(false); return; }
    const v = planeVis();
    view.showPlanes(v.front || v.top || v.right);
    view.planeVisibility(v);
  }
  function togglePlane(n) {
    const v = planeVis();
    doc.planeVis = { ...(doc.planeVis || {}), [n]: !v[n] };
    dirty = true; scheduleSave();
    applyPlanes(); treeRender();
  }

  // ---- sketch definition prefix, as in SolidWorks: (-) under defined, (+) over defined
  const skStatusCache = new Map();
  function sketchPrefix(f) {
    const key = JSON.stringify(f.sketch);
    let p = skStatusCache.get(key);
    if (p == null) {
      try {
        const sk = JSON.parse(key);
        const a = S.analyze(sk);
        p = !a.ok || a.redundant ? '(+) ' : a.dof > 0 ? '(-) ' : '';
      } catch (e) { p = ''; }
      if (skStatusCache.size > 200) skStatusCache.clear();
      skStatusCache.set(key, p);
    }
    return p;
  }

  // ---- ghost of the selected feature
  function clearGhost() {
    view.setPreview(null);
    view.highlightEdges(null);
    view.highlightFaces(null);
  }
  function showGhost(f) {
    clearGhost();
    if (!built || f.sup) return;
    const st = built.status[f.id] || {};
    if (st.ok === false) return;
    if (f.type === 'fillet' || f.type === 'chamfer' || f.type === 'shell') {
      // picked edges / faces live on the body before this feature
      const idx = doc.features.indexOf(f);
      const r = M.rebuild(doc, { upto: idx, keepCache: true });
      if (!r.body) return;
      const m = K.mesh(r.body);
      if (f.type === 'shell') view.highlightFaces(faceIdsFor(m, f.faces), 0xe8820c, m);
      else view.highlightEdges(edgeIdsFor(m, f.edges), 0xe8820c, m);
      return;
    }
    const t = built.tools && built.tools[f.id];
    if (!t) return;
    const cut = f.op === 'cut' || f.type === 'hole' || st.gop === 'cut';
    view.setPreview(K.mesh(t), cut ? 'cut' : 'add');
  }

  // ---- tree
  let docked = false;
  const openSet = new Set();
  let lastTap = { id: null, t: 0 };

  /** Which feature absorbs each sketch (the first feature that uses it). */
  function nesting() {
    const parentOf = new Map();
    for (const f of doc.features) if (f.type !== 'sketch' && f.sketch != null && !parentOf.has(f.sketch)) parentOf.set(f.sketch, f.id);
    return parentOf;
  }
  /** Top-level units: each feature with its absorbed sketch (in document order). */
  function units() {
    const parentOf = nesting();
    const out = [];
    for (const f of doc.features) {
      if (f.type === 'sketch' && parentOf.has(f.id)) continue;
      const ids = [f.id];
      if (f.type !== 'sketch' && f.sketch != null && parentOf.get(f.sketch) === f.id && doc.features.some((x) => x.id === f.sketch)) ids.unshift(f.sketch);
      out.push({ f, ids });
    }
    return out;
  }

  function treeRender() {
    const scrollTop = tree.querySelector('.tr-list') ? tree.querySelector('.tr-list').scrollTop : 0;
    tree.innerHTML = '';
    tree.append(el('div', { class: 'tr-head' }, el('span', {}, name),
      docked ? null : el('button', { class: 'ib', onclick: () => showTree(false), html: icon('close') })));
    const list = el('div', { class: 'tr-list' });
    tree.append(list);
    const sel = msel && (msel.kind === 'feature' || msel.kind === 'sketch') ? msel.id : null;

    // material
    list.append(el('div', {
      class: 'tr-row fixed', onclick: pickMaterial,
      html: `<span class="tw"></span>${icon('material')}<span class="nm">${doc.material ? esc(doc.material.name) : 'Material &lt;not specified&gt;'}</span>`,
    }));
    // planes
    const pv = planeVis();
    for (const p of ['front', 'top', 'right']) {
      const row = el('div', {
        class: 'tr-row fixed plane' + (msel && msel.kind === 'plane' && msel.name === p ? ' on' : ''),
        html: `<span class="tw"></span>${icon('plane')}<span class="nm">${M.PLANE_NAMES[p]}</span>`,
        onclick: () => { if (mode !== 'model' || viewOnly) return; setMsel({ kind: 'plane', name: p }); if (!docked) showTree(false); },
      });
      row.append(el('button', {
        class: 'eye' + (pv[p] ? ' on' : ''), title: pv[p] ? 'Hide' : 'Show',
        onclick: (e) => { e.stopPropagation(); togglePlane(p); },
        html: icon(pv[p] ? 'eye' : 'eyeoff'),
      }));
      list.append(row);
    }
    list.append(el('div', { class: 'tr-row fixed', html: `<span class="tw"></span>${icon('origin')}<span class="nm">Origin</span>` }));
    list.append(el('div', { class: 'tr-sep' }));

    const st = built ? built.status : {};
    const parentOf = nesting();
    const rowOf = (f, depth, unit) => {
      const s = st[f.id] || {};
      const err = s.ok === false, warn = !!s.warn;
      const editing = mode === 'sketch' && f.id === editSketchId;
      const kids = f.type !== 'sketch' && f.sketch != null && parentOf.get(f.sketch) === f.id ? [doc.features.find((x) => x.id === f.sketch)].filter(Boolean) : [];
      const open = openSet.has(f.id);
      const prefix = f.type === 'sketch' ? sketchPrefix(f) : '';
      const row = el('div', {
        class: 'tr-row' + (depth ? ' kid' : '') + (f.sup ? ' sup' : '') + (err ? ' err' : '') + (editing || sel === f.id ? ' on' : ''),
        'data-id': f.id, title: err ? s.err : warn ? s.warn : '',
      });
      const tw = el('button', { class: 'tw' + (kids.length ? '' : ' none'), html: kids.length ? icon(open ? 'down' : 'right') : '' });
      if (kids.length) tw.addEventListener('click', (e) => { e.stopPropagation(); if (open) openSet.delete(f.id); else openSet.add(f.id); treeRender(); });
      const nm = el('span', { class: 'nm' }, (prefix ? el('i', { class: 'pre' + (prefix.includes('+') ? ' bad' : '') }, prefix) : null), f.name);
      row.append(tw, el('span', { class: 'fi', html: icon(featIcon(f)) }), nm);
      if (err) row.append(el('b', { class: 'bad' }, '!'));
      else if (warn) row.append(el('b', { class: 'warn' }, '!'));
      if (!depth && !viewOnly) {
        const h = el('span', { class: 'drag', title: 'Drag to reorder', html: icon('grip') });
        h.addEventListener('pointerdown', (e) => startDrag(e, unit, row, list));
        row.append(h);
      }
      wireRow(row, f, nm);
      list.append(row);
      if (open) for (const k of kids) rowOf(k, 1, null);
    };
    for (const u of units()) rowOf(u.f, 0, u);
    if (!doc.features.length) list.append(el('div', { class: 'tr-empty' }, 'No features yet. Tap Sketch to start.'));

    if (mode === 'model' && built && built.body) {
      const mp = M.massProps(built.body);
      const sz = mp.bbox.max.map((v, i) => v - mp.bbox.min[i]);
      const vol = U.units === 'in' ? mp.volume / 16387.064 : mp.volume;
      list.append(el('div', { class: 'tr-props' },
        el('div', {}, 'Volume: ' + (vol < 100 ? vol.toFixed(3) : vol.toFixed(1)) + ' ' + U.label + '³'),
        doc.material ? el('div', {}, 'Mass: ' + fmtMass(mp.volume * doc.material.rho / 1000)) : null,
        el('div', {}, 'Size: ' + sz.map((v) => U.fmt(v)).join(' × ') + ' ' + U.label)));
    }
    list.scrollTop = scrollTop;
  }
  const fmtMass = (g) => (g >= 1000 ? (g / 1000).toFixed(3) + ' kg' : g.toFixed(2) + ' g');

  /** Tap = select + ghost, double-tap = edit, tap on the selected name = rename, long-press = menu. */
  function wireRow(row, f, nm) {
    let timer = null, start = null, longDone = false;
    row.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.drag') || e.target.closest('.tw')) return;
      start = [e.clientX, e.clientY]; longDone = false;
      timer = setTimeout(() => { longDone = true; haptic(); featMenu(f); }, 520);
    });
    const cancel = () => { clearTimeout(timer); timer = null; };
    row.addEventListener('pointermove', (e) => { if (start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 8) cancel(); });
    row.addEventListener('pointercancel', cancel);
    row.addEventListener('pointerup', cancel);
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); if (!viewOnly && mode === 'model') { treeSelect(f); featMenu(f); } });
    row.addEventListener('click', (e) => {
      if (longDone || e.target.closest('.drag') || e.target.closest('.tw')) return;
      if (viewOnly) { toast('View only: open this part in FreeTility CAD PRO to edit it'); return; }
      if (mode === 'sketch') { if (f.id !== editSketchId) toast('Exit the sketch first'); return; }
      const now = performance.now();
      const dbl = lastTap.id === f.id && now - lastTap.t < 330;
      lastTap = { id: f.id, t: now };
      const selected = msel && (msel.kind === 'feature' || msel.kind === 'sketch') && msel.id === f.id;
      if (dbl) { lastTap = { id: null, t: 0 }; clearTimeout(row._renameT); showTree(false); editFeature(f.id); return; }
      if (selected && e.target.closest('.nm')) {
        // wait a moment: a second tap means "edit", not "rename"
        row._renameT = setTimeout(() => inlineRename(f, nm), 340);
        return;
      }
      treeSelect(f, true);
    });
  }

  function treeSelect(f, deferClose) {
    setMsel(f.type === 'sketch' ? { kind: 'sketch', id: f.id } : { kind: 'feature', id: f.id });
    if (docked) return;
    if (!deferClose) { showTree(false); return; }
    // wait out the double-tap window, then show the model
    const t0 = lastTap.t;
    setTimeout(() => { if (lastTap.t === t0 && !panelState && mode === 'model') showTree(false); }, 360);
  }

  function inlineRename(f, nm) {
    const inp = el('input', { class: 'rn', type: 'text', value: f.name, spellcheck: 'false' });
    nm.replaceWith(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = (ok) => {
      if (done) return; done = true;
      const v = inp.value.trim().slice(0, 60);
      if (ok && v && v !== f.name) { f.name = v; push('Rename'); } else treeRender();
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('click', (e) => e.stopPropagation());
  }

  // ---- drag to reorder (by the grip handle)
  function startDrag(e, unit, row, list) {
    if (mode !== 'model' || viewOnly || !unit) return;
    e.preventDefault(); e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const tops = [...list.querySelectorAll('.tr-row[data-id]:not(.kid)')];
    const rects = tops.map((r) => r.getBoundingClientRect());
    const y0 = e.clientY;
    const line = el('div', { class: 'drop-line' });
    list.append(line);
    row.classList.add('dragging');
    let target = tops.indexOf(row);
    const lr = list.getBoundingClientRect();
    const move = (ev) => {
      const dy = ev.clientY - y0;
      row.style.transform = `translateY(${dy}px)`;
      // auto scroll near the edges
      if (ev.clientY < lr.top + 30) list.scrollTop -= 8; else if (ev.clientY > lr.bottom - 30) list.scrollTop += 8;
      const y = ev.clientY;
      let k = rects.length;
      for (let i = 0; i < rects.length; i++) if (y < rects[i].top + rects[i].height / 2) { k = i; break; }
      target = k;
      const ref = k < rects.length ? rects[k].top : rects[rects.length - 1].bottom;
      line.style.top = (ref - lr.top + list.scrollTop - 1) + 'px';
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      line.remove();
      row.classList.remove('dragging'); row.style.transform = '';
      dropUnit(unit, target);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    haptic();
  }

  /** Move a unit (feature + its absorbed sketch) before top-level position k, if parents stay above children. */
  function dropUnit(unit, k) {
    const us = units();
    const from = us.findIndex((u) => u.f.id === unit.f.id);
    if (from < 0 || k === from || k === from + 1) { treeRender(); return; }
    const order = us.map((u) => u.ids);
    const [moved] = order.splice(from, 1);
    order.splice(k > from ? k - 1 : k, 0, moved);
    const byId = new Map(doc.features.map((f) => [f.id, f]));
    const ids = order.flat().filter((id) => byId.has(id));
    if (ids.length !== order.flat().length) console.warn('tree drop: unknown ids', JSON.stringify(order), JSON.stringify(doc.features.map((f) => f.id)));
    const pos = new Map(ids.map((id, i) => [id, i]));
    for (const id of ids) {
      const f = byId.get(id);
      for (const r of refsOf(f)) {
        if (pos.has(r) && pos.get(r) > pos.get(id)) {
          toast(`${f.name} uses ${byId.get(r).name}, so it must stay below it`);
          treeRender();
          return;
        }
      }
    }
    doc.features = ids.map((id) => byId.get(id));
    push('Reorder ' + unit.f.name);
    haptic();
  }

  function showTree(v) {
    if (docked) { treeRender(); return; }
    if (v === tree.classList.contains('show')) return;
    tree.classList.toggle('show', v);
    treeScrim.classList.toggle('show', v);
    if (v) { treeRender(); tree._unback = pushBack(() => showTree(false)); }
    else if (tree._unback) { tree._unback(); tree._unback = null; }
  }

  function setDocked(v) {
    if (v === docked) return;
    docked = v;
    if (docked && tree._unback) { tree._unback(); tree._unback = null; }
    tree.classList.toggle('show', docked);
    treeScrim.classList.remove('show');
    root.classList.toggle('docked', docked);
    treeRender();
  }
  const mq = window.matchMedia('(min-width: 900px)');
  mq.addEventListener('change', () => setDocked(mq.matches));

  async function parentChild(f) {
    const byId = new Map(doc.features.map((x) => [x.id, x]));
    const parents = refsOf(f).map((id) => byId.get(id)).filter(Boolean);
    const kids = doc.features.filter((x) => refsOf(x).includes(f.id));
    const items = [];
    items.push({ label: 'Parents', value: null, disabled: true });
    if (!parents.length) items.push({ label: f.sketch == null && !f.feats ? 'None (uses the body or a face)' : 'None', value: null, disabled: true });
    for (const p of parents) items.push({ label: p.name, value: p.id, icon: featIcon(p) });
    items.push({ sep: true }, { label: 'Children', value: null, disabled: true });
    if (!kids.length) items.push({ label: 'None', value: null, disabled: true });
    for (const c of kids) items.push({ label: c.name, value: c.id, icon: featIcon(c) });
    const r = await sheet('Parent / Child: ' + f.name, items);
    if (r != null) { const t = byId.get(r); if (t) treeSelect(t); }
  }

  async function featMenu(f) {
    if (viewOnly) { toast('View only: open this part in FreeTility CAD PRO to edit it'); return; }
    if (mode === 'sketch') { if (f.id !== editSketchId) toast('Exit the sketch first'); return; }
    const err = built && built.status[f.id] && built.status[f.id].err;
    const items = [];
    if (err) items.push({ label: err, value: null, icon: 'info', disabled: true }, { sep: true });
    if (f.type === 'sketch') {
      items.push({ label: 'Edit sketch', value: 'edit', icon: 'edit' });
      const used = usedSketches().has(f.id);
      const shown = f.show === true || (f.show !== false && !used);
      items.push({ label: shown ? 'Hide sketch' : 'Show sketch', value: 'vis', icon: shown ? 'eyeoff' : 'eye' });
      items.push({ label: 'Extrude this sketch', value: 'ext', icon: 'extrude' });
      items.push({ label: 'Revolve this sketch', value: 'rev', icon: 'revolve' });
    } else {
      items.push({ label: 'Edit feature', value: 'edit', icon: 'edit' });
      if (f.sketch != null) items.push({ label: 'Edit sketch', value: 'editsk', icon: 'sketch' });
    }
    items.push({ label: f.sup ? 'Unsuppress' : 'Suppress', value: 'sup', icon: f.sup ? 'eye' : 'eyeoff' });
    items.push({ label: 'Rename', value: 'ren', icon: 'rename' });
    items.push({ label: 'Parent / Child…', value: 'pc', icon: 'tree' });
    items.push({ label: 'Move up', value: 'up', icon: 'up' }, { label: 'Move down', value: 'down', icon: 'down' });
    items.push({ sep: true }, { label: 'Delete', value: 'del', icon: 'trash', danger: true });
    const r = await sheet(f.name, items);
    if (!r) return;
    if (r === 'pc') { parentChild(f); return; }
    showTree(false);
    if (r === 'edit') editFeature(f.id);
    if (r === 'editsk') enterSketch(f.sketch);
    if (r === 'ext') newFeature('extrude', 'add', f.id);
    if (r === 'rev') newFeature('revolve', 'add', f.id);
    if (r === 'vis') {
      const used = usedSketches().has(f.id);
      const shown = f.show === true || (f.show !== false && !used);
      f.show = !shown;
      push(shown ? 'Hide sketch' : 'Show sketch');
    }
    if (r === 'sup') { f.sup = !f.sup; push((f.sup ? 'Suppress ' : 'Unsuppress ') + f.name); }
    if (r === 'ren') {
      const n = await promptBox({ title: 'Rename feature', value: f.name, inputmode: 'text' });
      if (n && n.trim()) { f.name = n.trim().slice(0, 60); push('Rename'); }
    }
    if (r === 'up' || r === 'down') moveFeature(f, r === 'up' ? -1 : 1);
    if (r === 'del') deleteFeature(f);
  }

  function refsOf(f) {
    const r = [];
    if (f.type !== 'sketch' && f.sketch != null) r.push(f.sketch);
    if (f.feats && !f.whole) r.push(...f.feats);
    return r;
  }
  function moveFeature(f, d) {
    const i = doc.features.indexOf(f), j = i + d;
    if (j < 0 || j >= doc.features.length) return;
    const other = doc.features[j];
    // moving up past something it depends on, or down past something that depends on it
    if (d < 0 && refsOf(f).includes(other.id)) { toast(`${f.name} uses ${other.name}, so it must stay below it`); return; }
    if (d > 0 && refsOf(other).includes(f.id)) { toast(`${other.name} uses ${f.name}, so it must stay below it`); return; }
    doc.features[i] = other; doc.features[j] = f;
    push('Reorder');
  }
  async function deleteFeature(f) {
    const dead = new Set([f.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of doc.features) if (!dead.has(x.id) && refsOf(x).some((id) => dead.has(id))) {
        if (x.feats && x.feats.some((id) => dead.has(id)) && x.feats.some((id) => !dead.has(id)) && x.sketch == null) continue;
        dead.add(x.id); grew = true;
      }
    }
    const extra = doc.features.filter((x) => dead.has(x.id) && x !== f);
    if (extra.length) {
      const ok = await confirmBox('Delete ' + f.name, `These also use it and will be deleted: ${extra.map((x) => x.name).join(', ')}.`, 'Delete all', true);
      if (!ok) return;
    }
    doc.features = doc.features.filter((x) => !dead.has(x.id));
    for (const x of doc.features) if (x.feats) x.feats = x.feats.filter((id) => !dead.has(id));
    if (msel && msel.kind === 'sketch' && dead.has(msel.id)) msel = null;
    push('Delete ' + f.name);
    toast(f.name + ' deleted', { action: { label: 'Undo', fn: undo } });
  }

  // ------------------------------------------------------------ menus
  async function moreMenu() {
    if (viewOnly) {
      const r0 = await sheet(name, [
        { label: 'Export STL (3D printing)', value: 'stl', icon: 'download' },
        { label: 'Share STL', value: 'stlshare', icon: 'share' },
        { label: 'Share project file (.ftcad)', value: 'share', icon: 'share' },
      ]);
      if (r0 === 'stl' || r0 === 'stlshare') exportSTL(r0 === 'stl' ? 'save' : 'share');
      if (r0 === 'share') exportFile(store.clean(name) + '.ftcad', 'application/x-ftcad', new TextEncoder().encode(JSON.stringify(doc)), 'share');
      return;
    }
    const r = await sheet(name, IS_WIN ? [
      { label: 'Export STL… (3D printing)', value: 'stl', icon: 'download' },
      ...(K.KERNEL.can.step ? [
        { label: 'Export STEP… (for other CAD)', value: 'step', icon: 'download' },
        { label: 'Import STEP…', value: 'stepin', icon: 'import', sub: 'Adds the solid from a .step / .stp file' },
      ] : []),
      { label: 'Save a copy of the part file…', value: 'saveftcad', icon: 'save' },
      { label: 'Show in folder', value: 'folder', icon: 'folder' },
      { sep: true },
      { label: 'Units: ' + (U.units === 'mm' ? 'Millimetres' : 'Inches'), value: 'units', icon: 'ruler', sub: 'Tap to switch' },
      { label: 'Mass properties', value: 'mass', icon: 'info' },
      { label: 'Rename part', value: 'ren', icon: 'rename' },
      { label: 'Save a copy', value: 'copy', icon: 'copy' },
    ] : [
      { label: 'Export STL (3D printing)', value: 'stl', icon: 'download' },
      { label: 'Share STL', value: 'stlshare', icon: 'share' },
      ...(K.KERNEL.can.step ? [
        { label: 'Export STEP (for other CAD)', value: 'step', icon: 'download' },
        { label: 'Share STEP', value: 'stepshare', icon: 'share' },
        { label: 'Import STEP…', value: 'stepin', icon: 'import', sub: 'Adds the solid from a .step / .stp file' },
      ] : []),
      { label: 'Share project file (.ftcad)', value: 'share', icon: 'share' },
      { sep: true },
      { label: 'Units: ' + (U.units === 'mm' ? 'Millimetres' : 'Inches'), value: 'units', icon: 'ruler', sub: 'Tap to switch' },
      { label: 'Mass properties', value: 'mass', icon: 'info' },
      { label: 'Rename part', value: 'ren', icon: 'rename' },
      { label: 'Save a copy', value: 'copy', icon: 'copy' },
      ...(PRO ? [] : [{ sep: true }, { label: 'Fillet, chamfer, hole, shell and STEP are in FreeTility CAD PRO', value: null, icon: 'info', disabled: true }]),
    ]);
    if (r === 'step' || r === 'stepshare') exportSTEP(r === 'step' ? 'save' : 'share');
    if (r === 'stepin') importSTEP();
    if (r === 'saveftcad') { save(true); exportFile(store.clean(name) + '.ftcad', 'application/x-ftcad', new TextEncoder().encode(JSON.stringify(doc)), 'save'); }
    if (r === 'folder') { save(true); window.Native.showInFolder(name); }
    if (r === 'stl' || r === 'stlshare') exportSTL(r === 'stl' ? 'save' : 'share');
    if (r === 'share') { save(true); exportFile(store.clean(name) + '.ftcad', 'application/x-ftcad', new TextEncoder().encode(JSON.stringify(doc)), 'share'); }
    if (r === 'units') switchUnits();
    if (r === 'mass') massDialog();
    if (r === 'ren') renamePart();
    if (r === 'copy') {
      save(true);
      const n = store.freeName(name + ' copy');
      store.save(n, doc);
      toast('Saved as ' + n);
    }
  }

  function switchUnits() {
    doc.units = doc.units === 'mm' ? 'in' : 'mm';
    U.set(doc.units);
    push('Units ' + U.label);
    if (mode === 'sketch') sketcher.render();
    toast('Units: ' + (U.units === 'mm' ? 'millimetres' : 'inches'));
  }

  function massDialog() {
    if (!built || !built.body) { toast('There is no body yet'); return; }
    const mp = M.massProps(built.body);
    const L = U.units === 'in' ? 25.4 : 1;
    const sz = mp.bbox.max.map((v, i) => (v - mp.bbox.min[i]));
    dialog({
      title: 'Mass properties',
      content: `<table class="mp">
        <tr><td>Volume</td><td>${(mp.volume / L ** 3).toFixed(3)} ${U.label}³</td></tr>
        <tr><td>Surface area</td><td>${(mp.area / L ** 2).toFixed(3)} ${U.label}²</td></tr>
        ${doc.material ? `<tr><td>Material</td><td>${esc(doc.material.name)}</td></tr>
        <tr><td>Density</td><td>${doc.material.rho} g/cm³</td></tr>
        <tr><td><b>Mass</b></td><td><b>${fmtMass(mp.volume * doc.material.rho / 1000)}</b></td></tr>` : `
        <tr><td>Mass</td><td>set a material in the feature tree</td></tr>`}
        <tr><td>Bounding box</td><td>${sz.map((v) => U.fmt(v)).join(' × ')} ${U.label}</td></tr>
      </table>${PRO ? '' : '<p class="hint">The body is a fine triangle mesh, so curved volumes are very slightly under the exact value.</p>'}`,
    });
  }

  async function exportSTL(mode2) {
    if (mode !== 'model') return;
    if (viewOnly && built && built.frozen) { await exportFile(store.clean(name) + '.stl', 'model/stl', M.meshToSTL(built.frozen, name), mode2); return; }
    if (!built || !built.body) { toast('There is nothing to export yet'); return; }
    const bytes = M.toSTL(built.body, name);
    save(true);
    const ok = await exportFile(store.clean(name) + '.stl', 'model/stl', bytes, mode2);
    if (!ok) toast('Export failed', { kind: 'err' });
  }

  async function exportSTEP(mode2) {
    if (mode !== 'model') return;
    if (!built || !built.body) { toast('There is nothing to export yet'); return; }
    let bytes;
    try { bytes = K.exportSTEP(built.body); } catch (e) { toast(e.message, { kind: 'err' }); return; }
    save(true);
    const ok = await exportFile(store.clean(name) + '.step', 'model/step', bytes, mode2);
    if (!ok) toast('Export failed', { kind: 'err' });
  }

  async function importSTEP() {
    const file = await pickFile('.step,.stp');
    if (!file) return;
    if (!/^ISO-10303-21/i.test(file.text.trimStart())) { toast('That is not a STEP file', { kind: 'err' }); return; }
    const f = { id: doc.nid++, type: 'import', name: M.nextName(doc, 'Imported'), file: file.name, data: file.text };
    doc.features.push(f);
    push('Import ' + file.name);
    const st = built && built.status[f.id];
    if (st && st.ok === false) toast(st.err, { kind: 'err' });
    else { toast('Imported ' + file.name); view.fit(); }
  }

  async function renamePart() {
    if (mode !== 'model' || viewOnly) return;
    const n = await promptBox({ title: 'Rename part', value: name, inputmode: 'text' });
    if (!n || !n.trim() || n.trim() === name) return;
    save(false);
    const nn = store.rename(name, store.clean(n));
    if (!nn) { toast('A part with that name already exists'); return; }
    name = nn;
    updateTop(); treeRender();
  }

  // ------------------------------------------------------------ keyboard (desktop / external keyboards)
  function onAlt(e) {
    if ((e.key !== 'Alt' && e.key !== 'Control') || mode !== 'sketch') return;
    if (e.key === 'Alt') e.preventDefault();
    sketcher.setSuspended(e.type === 'keydown');
  }
  function onKey(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || document.querySelector('.scrim')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if ((e.ctrlKey || e.metaKey) && /^[1-8]$/.test(e.key)) {
      e.preventDefault();
      const v = { 1: 'front', 2: 'back', 3: 'left', 4: 'right', 5: 'top', 6: 'bottom', 7: 'iso' }[e.key];
      if (v && mode === 'model') view.setView(v);
      else if (e.key === '8' || mode === 'sketch') lookAtSketch();
    }
    else if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && mode === 'model') { view.fit(); }
    else if (e.key === 'Delete' && mode === 'model' && msel && msel.kind === 'feature' && !viewOnly) { const f = doc.features.find((x) => x.id === msel.id); if (f) deleteFeature(f); }
    else if (e.key === 'Escape') { if (mode === 'sketch') { if (!sketcher.finishDraft()) sketcher.clearSelection(); } else setMsel(null); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && mode === 'sketch' && sketcher.hasSelection()) sketcher.deleteSelection();
    else if (mode === 'sketch' && !e.ctrlKey && !e.metaKey) {
      const map = { s: 'select', l: 'line', r: 'rect', c: 'circle', a: 'arc', d: 'dim', t: 'trim', o: 'offset' };
      const t = map[e.key.toLowerCase()];
      if (t) { sketcher.setTool(t); renderToolbar(); }
    }
  }
  document.addEventListener('keydown', onKey);
  document.addEventListener('keydown', onAlt);
  document.addEventListener('keyup', onAlt);
  const onBlur = () => { if (mode === 'sketch' && sketcher.suspended) sketcher.setSuspended(false); };
  window.addEventListener('blur', onBlur);

  // ------------------------------------------------------------ open / close
  function backHandler() {
    if (mode === 'sketch') {
      if (sketcher.finishDraft()) return;
      if (sketcher.hasSelection()) { sketcher.clearSelection(); return; }
      exitSketch();
      return;
    }
    if (msel) { setMsel(null); return; }
    close();
  }

  function close() {
    if (mode === 'sketch') exitSketch(true);
    if (panelState) closePanel(false);
    save(true);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('keydown', onAlt);
    document.removeEventListener('keyup', onAlt);
    window.removeEventListener('blur', onBlur);
    unbackers.forEach((u) => u());
    M.clearCache();
    root.innerHTML = '';
    onClose && onClose();
  }

  const modelTap = (x, y) => { if (mode === 'model') onModelTap(x, y); };
  view.onTap = modelTap;
  view.setDisplay(prefs.display);
  vp.classList.toggle('dark', prefs.viewport === 'dark');

  return {
    async open(n, d) {
      name = n; doc = d;
      if (viewOnly) root.classList.add('view-only');
      U.set(doc.units || prefs.units);
      M.setQuality(prefs.quality);
      hist = [{ s: snap(), label: 'Open' }]; hi = 0;
      mode = 'model'; msel = null;
      unbackers.push(pushBack(backHandler));
      setDocked(mq.matches);
      updateTop(); renderToolbar(); renderVpBtns();
      view.setView('iso', false);
      refresh(true);
      if (!doc.features.length) { setHint(null); toast('Tap Sketch, pick a plane, and start drawing'); }
    },
    save: () => save(true),
    get name() { return name; },
    close,
  };
}
