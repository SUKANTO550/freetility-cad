// FreeTility CAD - small UI helpers: elements, toasts, dialogs, sheets, back stack.

import { icon } from './icons.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ back stack (Android back button)

const backStack = [];
export function pushBack(fn) { backStack.push(fn); return () => { const i = backStack.lastIndexOf(fn); if (i >= 0) backStack.splice(i, 1); }; }
export function handleBack() {
  const fn = backStack[backStack.length - 1];
  if (!fn) return false;
  fn();
  return true;
}

// ------------------------------------------------------------------ toast

let toastTimer = null;
export function toast(msg, opts = {}) {
  let t = $('#toast');
  if (!t) { t = el('div', { id: 'toast', role: 'status' }); document.body.append(t); }
  t.className = 'toast show' + (opts.kind ? ' ' + opts.kind : '');
  t.innerHTML = '';
  t.append(el('span', {}, msg));
  if (opts.action) {
    t.append(el('button', { class: 'tbtn', onclick: () => { t.classList.remove('show'); opts.action.fn(); } }, opts.action.label));
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), opts.ms || (opts.action ? 5000 : 2600));
}

export function haptic() { try { window.Native && window.Native.haptic(); } catch (e) { /* ignore */ } }

// ------------------------------------------------------------------ modal dialogs

/**
 * Generic dialog. content: Node or HTML string. buttons: [{label, value, primary, danger}].
 * Resolves with the clicked button value (or null when dismissed).
 */
export function dialog({ title, content, buttons = [{ label: 'OK', value: true, primary: true }], cls = '', onOpen, validate }) {
  return new Promise((resolve) => {
    const body = el('div', { class: 'dlg-body' });
    if (typeof content === 'string') body.innerHTML = content; else if (content) body.append(content);
    const foot = el('div', { class: 'dlg-foot' });
    const box = el('div', { class: 'dlg ' + cls, role: 'dialog', 'aria-modal': 'true' },
      title ? el('div', { class: 'dlg-title' }, title) : null, body, foot);
    const scrim = el('div', { class: 'scrim' }, box);
    let done = false;
    const close = (v) => {
      if (done) return;
      if (v != null && v !== false && validate && !validate(v, body)) return;
      done = true; popBack();
      scrim.classList.remove('show');
      setTimeout(() => scrim.remove(), 180);
      resolve(v);
    };
    for (const b of buttons) {
      foot.append(el('button', {
        class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''),
        onclick: () => close(b.value),
      }, b.label));
    }
    scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close(null); });
    const popBack = pushBack(() => close(null));
    document.body.append(scrim);
    requestAnimationFrame(() => scrim.classList.add('show'));
    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        const p = buttons.find((b) => b.primary); if (p) { e.preventDefault(); close(p.value); }
      }
      if (e.key === 'Escape') close(null);
    });
    if (onOpen) onOpen(body, close);
  });
}

export function confirmBox(title, msg, okLabel = 'OK', danger = false) {
  return dialog({
    title, content: el('p', {}, msg),
    buttons: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: !danger, danger }],
  }).then((v) => !!v);
}

/** Text / number prompt. parse(str) returns a value or NaN/null for invalid input. */
export function promptBox({ title, label, value = '', parse, hint, okLabel = 'OK', inputmode = 'decimal', extra }) {
  let input;
  const wrap = el('div', { class: 'field' },
    label ? el('label', {}, label) : null,
    input = el('input', { type: 'text', value, inputmode, autocomplete: 'off', spellcheck: 'false' }),
    hint ? el('div', { class: 'hint' }, hint) : null,
    el('div', { class: 'err' }));
  if (extra) wrap.append(extra);
  return dialog({
    title, content: wrap,
    buttons: [{ label: 'Cancel', value: null }, { label: okLabel, value: 'ok', primary: true }],
    onOpen: () => { setTimeout(() => { input.focus(); input.select(); }, 60); },
    validate: () => {
      if (!parse) return true;
      const v = parse(input.value);
      if (v == null || Number.isNaN(v)) { wrap.querySelector('.err').textContent = 'Enter a valid value'; return false; }
      return true;
    },
  }).then((r) => (r === 'ok' ? (parse ? parse(input.value) : input.value) : null));
}

/** Bottom action sheet. items: [{label, value, icon, danger, sub}] */
export function sheet(title, items) {
  return new Promise((resolve) => {
    const list = el('div', { class: 'sheet-list' });
    const box = el('div', { class: 'sheet' }, el('div', { class: 'grab' }), title ? el('div', { class: 'sheet-title' }, title) : null, list);
    const scrim = el('div', { class: 'scrim bottom' }, box);
    let done = false;
    const close = (v) => {
      if (done) return; done = true; popBack();
      scrim.classList.remove('show');
      setTimeout(() => scrim.remove(), 200);
      resolve(v);
    };
    for (const it of items) {
      if (it.sep) { list.append(el('div', { class: 'sep' })); continue; }
      list.append(el('button', {
        class: 'sheet-item' + (it.danger ? ' danger' : '') + (it.on ? ' on' : ''), disabled: it.disabled,
        onclick: () => close(it.value),
        html: (it.icon ? icon(it.icon) : '') + `<span class="si-t">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>` + (it.on ? icon('check', 'tick') : ''),
      }));
    }
    scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close(null); });
    const popBack = pushBack(() => close(null));
    document.body.append(scrim);
    requestAnimationFrame(() => scrim.classList.add('show'));
  });
}

/** Segmented control. options: [[value, label]] */
export function segmented(options, value, onChange) {
  const box = el('div', { class: 'seg' });
  for (const [v, label] of options) {
    box.append(el('button', {
      class: v === value ? 'on' : '', type: 'button',
      onclick: (e) => {
        for (const b of box.children) b.classList.remove('on');
        e.currentTarget.classList.add('on');
        onChange(v);
      },
    }, label));
  }
  return box;
}

export function toggle(label, value, onChange) {
  const inp = el('input', { type: 'checkbox' });
  inp.checked = !!value;
  inp.addEventListener('change', () => onChange(inp.checked));
  return el('label', { class: 'tog' }, inp, el('span', { class: 'knob' }), el('span', { class: 'tl' }, label));
}
