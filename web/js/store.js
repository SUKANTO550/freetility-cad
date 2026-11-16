// FreeTility CAD - project storage. Uses the Android bridge (window.Native)
// when present, otherwise localStorage (browser preview / testing).

const N = window.Native || null;
export const IS_NATIVE = !!N;
export const IS_WIN = !!N && N.platform() === 'windows';
const LS = 'ftcad:';

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  keys() { try { return Object.keys(localStorage); } catch (e) { return []; } },
};

const clean = (n) => String(n || '').replace(/[\\/:*?"<>|\x00-\x1F]/g, '').trim().slice(0, 80).trim() || 'Part';

export const store = {
  clean,
  list() {
    if (N) { try { return JSON.parse(N.listProjects()); } catch (e) { return []; } }
    const out = [];
    for (const k of ls.keys()) {
      if (!k.startsWith(LS + 'p:')) continue;
      const name = k.slice(LS.length + 2);
      const meta = JSON.parse(ls.get(LS + 'm:' + name) || '{}');
      out.push({ name, mtime: meta.mtime || 0, size: (ls.get(k) || '').length, thumb: ls.get(LS + 't:' + name) ? 1 : 0 });
    }
    return out;
  },
  load(name) {
    const s = N ? N.loadProject(name) : ls.get(LS + 'p:' + clean(name));
    return s ? JSON.parse(s) : null;
  },
  exists(name) { return N ? N.projectExists(name) : ls.get(LS + 'p:' + clean(name)) != null; },
  freeName(base) {
    if (N) return N.freeProjectName(base);
    let n = clean(base), i = 2;
    while (this.exists(n)) n = clean(base) + ' (' + i++ + ')';
    return n;
  },
  save(name, doc) {
    const json = JSON.stringify(doc);
    if (N) return N.saveProject(name, json);
    ls.set(LS + 'm:' + clean(name), JSON.stringify({ mtime: Date.now() }));
    return ls.set(LS + 'p:' + clean(name), json);
  },
  saveThumb(name, dataUrl) {
    if (N) return N.saveThumb(name, dataUrl);
    return ls.set(LS + 't:' + clean(name), dataUrl);
  },
  thumbUrl(p) {
    if (N) return p.thumb ? '/thumbs/' + encodeURIComponent(clean(p.name)) + '.png?v=' + p.thumb : null;
    return ls.get(LS + 't:' + clean(p.name));
  },
  remove(name) {
    if (N) return N.deleteProject(name);
    for (const k of ['p:', 'm:', 't:']) ls.del(LS + k + clean(name));
    return true;
  },
  rename(from, to) {
    if (N) return N.renameProject(from, to);
    const a = clean(from), b = clean(to);
    if (a === b) return b;
    if (this.exists(b)) return null;
    for (const k of ['p:', 'm:', 't:']) { const v = ls.get(LS + k + a); if (v != null) ls.set(LS + k + b, v); ls.del(LS + k + a); }
    return b;
  },
};

// ------------------------------------------------------------------ settings

const SNAP_DEF = { points: true, mid: true, center: true, curve: true, model: true, hv: true, grid: false, gridAuto: true, gridStep: 5, gridStepIn: 0.125, strength: 'normal' };
const DEF = { units: 'mm', quality: 'normal', relations: true, grid: true, viewport: 'light', display: 'edges', tips: true, snap: SNAP_DEF };
export const prefs = {
  ...DEF,
  load() {
    let saved = {};
    try { saved = JSON.parse(ls.get(LS + 'prefs') || '{}'); } catch (e) { /* defaults */ }
    Object.assign(this, DEF, saved);
    this.snap = { ...SNAP_DEF, ...(saved.snap || {}) };
  },
  save() { const o = {}; for (const k in DEF) o[k] = this[k]; ls.set(LS + 'prefs', JSON.stringify(o)); },
};
prefs.load();

// ------------------------------------------------------------------ export files

function b64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

/** Save or share a file. mode: 'save' | 'share'. Resolves when handed over. */
export function exportFile(fileName, mime, bytes, mode = 'save') {
  if (N) {
    N.writeBegin();
    const CH = 3 * 256 * 1024;   // multiple of 3 so chunks encode cleanly
    for (let i = 0; i < bytes.length; i += CH) if (!N.writeChunk(b64(bytes.subarray(i, i + CH)))) return Promise.resolve(false);
    return Promise.resolve(N.writeEnd(fileName, mime, mode));
  }
  const blob = new Blob([bytes], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return Promise.resolve(true);
}

export function importProject() {
  if (N) { N.importProject(); return true; }
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.ftcad,application/json';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try {
      const doc = JSON.parse(await f.text());
      if (doc.format !== 'ftcad') throw new Error('Not a FreeTility CAD project');
      const name = store.freeName(f.name.replace(/\.ftcad$/i, ''));
      store.save(name, doc);
      window.onNative && window.onNative('imported', { ok: true, name });
    } catch (e) { window.onNative && window.onNative('imported', { ok: false, message: e.message }); }
  };
  inp.click();
  return true;
}

export const platform = () => (N ? N.platform() : 'web');
export const appVersion = () => (N ? N.version() : 'preview');

// ------------------------------------------------------------------ pick a file (STEP import)

let pendingPick = null;

/** Let the user pick a text file. Resolves {name, text} or null. */
export function pickFile(accept) {
  if (N) {
    return new Promise((resolve) => {
      pendingPick = resolve;
      N.pickFile(accept || '*/*');
    });
  }
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept || '';
    inp.onchange = async () => { const f = inp.files[0]; resolve(f ? { name: f.name, text: await f.text() } : null); };
    inp.click();
  });
}

/** Called from window.onNative('filePicked', data). The file is served at data.url. */
export async function filePicked(data) {
  const done = pendingPick; pendingPick = null;
  if (!done) return;
  if (!data || !data.ok) { done(null); return; }
  try { done({ name: data.name, text: await (await fetch(data.url)).text() }); } catch (e) { done(null); }
}
