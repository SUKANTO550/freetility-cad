// FreeTility CAD - snap settings controls (used in sketches and on the Settings tab).

import { el, toggle, segmented } from './ui.js';
import { prefs, IS_WIN } from './store.js';
import { U } from './units.js';

/** master: optional { on: bool, set(v) } for the "Snapping on" switch inside a sketch. */
export function snapControls(onChange = () => {}, master = null) {
  const sn = prefs.snap;
  const set = (k) => (v) => { sn[k] = v; prefs.save(); onChange(); };
  const box = el('div', { class: 'snapset' });
  if (master) box.append(toggle('Snapping on', master.on, (v) => { master.set(v); onChange(); }), el('div', { class: 'sep' }));
  box.append(
    toggle('Endpoints and points', sn.points, set('points')),
    toggle('Midpoints', sn.mid, set('mid')),
    toggle('Centres', sn.center, set('center')),
    toggle('On curves', sn.curve, set('curve')),
    toggle('Model edges, corners and centres', sn.model, set('model')),
    toggle('Horizontal / vertical inference', sn.hv, set('hv')),
    toggle('Grid', sn.grid, set('grid')));
  box.append(el('div', { class: 'p-row' }, el('label', {}, 'Snap strength'), segmented([['low', 'Low'], ['normal', 'Normal'], ['high', 'High']], sn.strength || 'normal', (v) => { sn.strength = v; prefs.save(); onChange(); })));
  const inch = U.units === 'in';
  const steps = inch ? [['auto', 'Auto'], ['0.0625', '1/16"'], ['0.125', '1/8"'], ['0.25', '1/4"']]
    : [['auto', 'Auto'], ['1', '1 mm'], ['2', '2 mm'], ['5', '5 mm'], ['10', '10 mm']];
  const cur = sn.gridAuto ? 'auto' : String(inch ? sn.gridStepIn : sn.gridStep);
  box.append(el('div', { class: 'p-row' }, el('label', {}, 'Grid spacing'), segmented(steps, cur, (v) => {
    if (v === 'auto') sn.gridAuto = true;
    else { sn.gridAuto = false; if (inch) sn.gridStepIn = +v; else sn.gridStep = +v; }
    prefs.save(); onChange();
  })));
  box.append(el('div', { class: 'hint' }, IS_WIN
    ? 'Hold Ctrl or Alt while drawing or dragging to place a point without snapping. Auto grid spacing follows the zoom.'
    : 'Long-press the magnet in a sketch to turn all snapping off for a moment. Auto grid spacing follows the zoom.'));
  return box;
}
