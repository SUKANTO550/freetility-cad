// FreeTility CAD - app shell: parts list, settings, about, editor routing.

import * as K from './kernel.js';
import { newDoc } from './model.js';
import { createEditor } from './editor.js';
import { icon } from './icons.js';
import { $, $$, el, esc, toast, dialog, confirmBox, promptBox, sheet, segmented, toggle, pushBack, handleBack } from './ui.js';
import { store, prefs, exportFile, importProject, appVersion, IS_NATIVE, IS_WIN, filePicked } from './store.js';
import { usesPro } from './model.js';
import { snapControls } from './snapset.js';
import { U } from './units.js';

const APP_NAME = K.KERNEL.pro ? 'FreeTility CAD PRO' : 'FreeTility CAD';
const YEAR = new Date().getFullYear();
let editor = null;
let tab = 'parts';

// ------------------------------------------------------------------ native events
window.__androidBack = () => handleBack();
window.onNative = (ev, data) => {
  if (ev === 'pause') { if (editor) editor.save(); }
  if (ev === 'imported') {
    if (data.ok) { toast('Imported ' + data.name); if (!editor) renderParts(); }
    else toast(data.message || 'Import failed', { kind: 'err' });
  }
  if (ev === 'filePicked') filePicked(data);
  if (ev === 'openPart') openFromOutside(() => openPart(data.name));
  if (ev === 'openStep') openFromOutside(() => openStepAsPart(data));
  if (ev === 'exported') {
    if (data.ok && !data.shared) toast('Saved');
    else if (!data.ok && !data.cancelled) toast(data.message || 'Export failed', { kind: 'err' });
  }
};

// ------------------------------------------------------------------ shell
function shell() {
  document.title = APP_NAME;
  document.body.innerHTML = '';
  document.body.append(
    el('div', { id: 'home' },
      el('main', { id: 'tabs' },
        el('section', { class: 'tab', id: 'tab-parts' }),
        el('section', { class: 'tab', id: 'tab-settings' }),
        el('section', { class: 'tab', id: 'tab-about' })),
      el('nav', { class: 'bottom-nav' },
        navBtn('parts', 'folder', 'Parts'), navBtn('settings', 'settings', 'Settings'), navBtn('about', 'info', 'About'))),
    el('div', { id: 'editor' }));
  showTab('parts');
}
function navBtn(t, ic, label) {
  return el('button', { class: 'nav-btn', 'data-tab': t, onclick: () => showTab(t), html: icon(ic) + `<span>${label}</span>` });
}
function showTab(t) {
  tab = t;
  for (const s of $$('.tab')) s.classList.toggle('show', s.id === 'tab-' + t);
  for (const b of $$('.nav-btn')) b.classList.toggle('on', b.dataset.tab === t);
  if (t === 'parts') renderParts();
  if (t === 'settings') renderSettings();
  if (t === 'about') renderAbout();
}

// ------------------------------------------------------------------ parts
function renderParts() {
  const box = $('#tab-parts');
  box.innerHTML = '';
  const list = store.list().sort((a, b) => b.mtime - a.mtime);
  box.append(el('header', { class: 'page-head' },
    el('div', { class: 'brand' }, el('span', { class: 'logo', html: icon('cube') }), el('div', {}, el('h1', {}, APP_NAME), el('div', { class: 'sub' }, K.KERNEL.pro ? 'Parametric solid modeller · B-rep' : 'Parametric part modeller'))),
    el('button', { class: 'ib', title: IS_WIN ? 'Open a part or STEP file' : 'Import project', onclick: () => importProject(), html: icon('upload') })));
  if (!list.length) {
    box.append(el('div', { class: 'empty' },
      el('div', { class: 'empty-art', html: icon('cube') }),
      el('h2', {}, 'No parts yet'),
      el('p', {}, 'Create a part, sketch on a plane, add dimensions, then extrude or revolve it.'),
      el('button', { class: 'btn primary big', onclick: newPart, html: icon('plus') + '<span>New part</span>' })));
  } else {
    const grid = el('div', { class: 'grid' });
    for (const p of list) {
      const th = store.thumbUrl(p);
      const card = el('div', { class: 'card', tabindex: 0 },
        el('div', { class: 'thumb' }, th ? el('img', { src: th, alt: '', loading: 'lazy' }) : el('span', { html: icon('cube') })),
        el('div', { class: 'meta' },
          el('div', { class: 'nm' }, p.name),
          el('div', { class: 'dt' }, p.mtime ? new Date(p.mtime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '')),
        el('button', { class: 'ib more', title: 'Options', onclick: (e) => { e.stopPropagation(); partMenu(p.name); }, html: icon('more') }));
      card.addEventListener('click', () => openPart(p.name));
      card.addEventListener('contextmenu', (e) => { e.preventDefault(); partMenu(p.name); });
      let lp = null;
      card.addEventListener('pointerdown', () => { lp = setTimeout(() => { lp = 'done'; partMenu(p.name); }, 550); });
      const clr = () => { if (lp && lp !== 'done') clearTimeout(lp); };
      card.addEventListener('pointerup', (e) => { if (lp === 'done') { e.preventDefault(); e.stopPropagation(); } clr(); });
      card.addEventListener('pointermove', clr); card.addEventListener('pointercancel', clr);
      card.addEventListener('click', (e) => { if (lp === 'done') { e.stopImmediatePropagation(); lp = null; } }, true);
      grid.append(card);
    }
    box.append(grid);
    box.append(el('button', { class: 'fab-new', onclick: newPart, html: icon('plus') + '<span>New part</span>' }));
  }
}

/** A file opened from Explorer / drag and drop: close the open part first (it saves). */
function openFromOutside(fn) {
  if (editor) editor.close();
  showTab('parts');
  fn();
}

/** A STEP file opened from outside becomes a new part with one Imported feature. */
async function openStepAsPart(data) {
  if (!K.KERNEL.can.step) { toast('STEP files need FreeTility CAD PRO', { kind: 'err' }); return; }
  let text;
  try { text = await (await fetch(data.url)).text(); } catch (e) { toast('Could not read ' + data.name, { kind: 'err' }); return; }
  if (!/^ISO-10303-21/i.test(text.trimStart())) { toast('That is not a STEP file', { kind: 'err' }); return; }
  const name = store.freeName(store.clean(data.name));
  const doc = newDoc('cadpro');
  doc.units = prefs.units;
  doc.features.push({ id: doc.nid++, type: 'import', name: 'Imported1', file: data.name, data: text });
  store.save(name, doc);
  openPart(name);
}

async function newPart() {
  const n = await promptBox({ title: 'New part', label: 'Name', value: nextPartName(), inputmode: 'text', okLabel: 'Create' });
  if (n == null) return;
  const name = store.freeName(store.clean(n));
  const doc = newDoc(K.KERNEL.pro ? 'cadpro' : 'cad');
  doc.units = prefs.units;
  store.save(name, doc);
  openPart(name);
}
function nextPartName() {
  let i = 1;
  while (store.exists('Part' + i)) i++;
  return 'Part' + i;
}

async function partMenu(name) {
  const r = await sheet(name, [
    { label: 'Open', value: 'open', icon: 'edit' },
    { label: 'Rename', value: 'ren', icon: 'rename' },
    { label: 'Duplicate', value: 'dup', icon: 'copy' },
    IS_WIN ? { label: 'Show in folder', value: 'folder', icon: 'folder' } : { label: 'Share project file', value: 'share', icon: 'share' },
    { sep: true },
    { label: 'Delete', value: 'del', icon: 'trash', danger: true },
  ]);
  if (r === 'open') openPart(name);
  if (r === 'folder') window.Native.showInFolder(name);
  if (r === 'ren') {
    const n = await promptBox({ title: 'Rename part', value: name, inputmode: 'text' });
    if (n && n.trim() && n.trim() !== name) { if (!store.rename(name, store.clean(n))) toast('A part with that name already exists'); renderParts(); }
  }
  if (r === 'dup') { const doc = store.load(name); if (doc) { const n = store.freeName(name + ' copy'); store.save(n, doc); renderParts(); toast('Duplicated as ' + n); } }
  if (r === 'share') { const doc = store.load(name); if (doc) exportFile(store.clean(name) + '.ftcad', 'application/x-ftcad', new TextEncoder().encode(JSON.stringify(doc)), 'share'); }
  if (r === 'del') {
    const ok = await confirmBox('Delete part', `Delete "${name}"? This cannot be undone.`, 'Delete', true);
    if (ok) { store.remove(name); renderParts(); toast('Deleted ' + name); }
  }
}

async function openPart(name) {
  const doc = store.load(name);
  if (!doc) { toast('Could not open ' + name, { kind: 'err' }); renderParts(); return; }
  let viewOnly = false;
  if (!K.KERNEL.pro && usesPro(doc)) {
    const ok = await confirmBox('Made with CAD PRO', `"${name}" uses FreeTility CAD PRO features (fillet, chamfer, hole, shell or STEP import). FreeTility CAD can show it and export STL, but not edit it.`, 'View');
    if (!ok) return;
    if (!doc.mesh) { toast('Open and save it once in CAD PRO to make it viewable here', { kind: 'err' }); return; }
    viewOnly = true;
  }
  document.body.classList.add('editing');
  editor = createEditor($('#editor'), { viewOnly, onClose: () => { editor = null; document.body.classList.remove('editing'); renderParts(); } });
  try { await editor.open(name, doc); } catch (e) { console.error(e); toast('Error opening: ' + e.message, { kind: 'err' }); }
}

// ------------------------------------------------------------------ settings
function renderSettings() {
  const box = $('#tab-settings');
  box.innerHTML = '';
  box.append(el('header', { class: 'page-head' }, el('h1', {}, 'Settings')));
  const sec = (title, ...rows) => el('section', { class: 'set-sec' }, el('h3', {}, title), ...rows);
  const row = (label, sub, ctl) => el('div', { class: 'set-row' }, el('div', {}, el('div', { class: 'sl' }, label), sub ? el('div', { class: 'ss' }, sub) : null), ctl);
  box.append(
    sec('Units',
      row('Units for new parts', 'Each part can switch later from its ⋯ menu', segmented([['mm', 'Millimetres'], ['in', 'Inches']], prefs.units, (v) => { prefs.units = v; prefs.save(); })))
    ,
    sec('Display',
      row('Model display', null, segmented([['edges', 'Edges'], ['shaded', 'Shaded'], ['wire', 'Wire']], prefs.display, (v) => { prefs.display = v; prefs.save(); })),
      row('Viewport background', null, segmented([['light', 'Light'], ['dark', 'Dark']], prefs.viewport, (v) => { prefs.viewport = v; prefs.save(); })),
      row('Curve quality', 'Higher is smoother but slower on big parts', segmented([['low', 'Low'], ['normal', 'Normal'], ['high', 'High']], prefs.quality, (v) => { prefs.quality = v; prefs.save(); }))),
    sec('Snapping', snapControls()),
    sec('Sketch',
      el('div', { class: 'set-row' }, toggle('Show relations (H, V, ∥, ⊥ …)', prefs.relations, (v) => { prefs.relations = v; prefs.save(); })),
      el('div', { class: 'set-row' }, toggle('Show grid', prefs.grid, (v) => { prefs.grid = v; prefs.save(); }))),
    sec('Help',
      el('div', { class: 'help' },
        el('p', {}, el('b', {}, 'Sketch: '), 'tap Sketch, pick a plane or tap a flat face first. Draw with Line, Rectangle, Circle or Arc.'),
        el('p', {}, el('b', {}, 'Define: '), 'use Dimension (tap a line, circle, or two items) and relations (select items in Select mode). Blue = under defined, black = fully defined, red = over defined.'),
        el('p', {}, el('b', {}, 'Features: '), 'Extrude or Revolve a closed sketch (Revolve needs a centerline). Cut removes material. Patterns and Mirror repeat features.'),
        el('p', {}, el('b', {}, 'Gestures: '), 'one finger rotates, two fingers pan and zoom. In a sketch, one finger on empty space pans.'),
        el('p', {}, el('b', {}, 'Edit later: '), 'open the feature tree and tap a feature to edit, suppress, reorder or delete it.'))));
}

// ------------------------------------------------------------------ about
function renderAbout() {
  const box = $('#tab-about');
  box.innerHTML = '';
  box.append(el('header', { class: 'page-head' }, el('h1', {}, 'About')));
  box.append(el('div', { class: 'about-card' },
    el('div', { class: 'about-logo', html: icon('cube') }),
    el('div', { class: 'about-name' }, APP_NAME),
    el('div', { class: 'about-ver' }, 'Version ' + appVersion()),
    el('div', { class: 'about-line' }),
    el('div', { class: 'about-s' }, 'Created by'),
    el('div', { class: 'about-n' }, 'Sukanto Biswas'),
    el('div', { class: 'about-s' }, 'Mechanical Engineer'),
    el('div', { class: 'about-c' }, '© ' + YEAR + ' FreeTility')));
  box.append(el('p', { class: 'credits' }, 'Geometry kernel: ', K.KERNEL.license, '. 3D view: three.js (MIT).'));
}

// ------------------------------------------------------------------ start
async function start() {
  shell();
  const loading = el('div', { class: 'k-loading' }, el('div', { class: 'spin' }), el('div', {}, 'Starting the geometry kernel…'));
  document.body.append(loading);
  try {
    await K.init();
  } catch (e) {
    console.error(e);
    toast('Could not start the geometry kernel: ' + e.message, { kind: 'err', ms: 8000 });
  }
  loading.remove();
  if (window.Native) window.Native.ready();
  document.body.classList.add('ready');
}

start();
