// FreeTility CAD - units. Everything is stored in millimetres and degrees.

export const U = {
  units: 'mm',   // 'mm' | 'in'
  set(u) { this.units = u === 'in' ? 'in' : 'mm'; },
  get label() { return this.units === 'in' ? 'in' : 'mm'; },
  toDisp(mm) { return this.units === 'in' ? mm / 25.4 : mm; },
  fromDisp(v) { return this.units === 'in' ? v * 25.4 : v; },
  /** Length for display, trimmed: 12.5, 0.375 */
  fmt(mm, digits) {
    const d = digits != null ? digits : this.units === 'in' ? 3 : 2;
    const v = this.toDisp(mm);
    return trim(v.toFixed(d));
  },
  fmtU(mm, digits) { return this.fmt(mm, digits) + ' ' + this.label; },
  /** Value for an input box (more digits, no unit). */
  edit(mm) { return trim(this.toDisp(mm).toFixed(this.units === 'in' ? 4 : 3)); },
};

export const fmtAng = (deg) => trim(deg.toFixed(2)) + '°';

function trim(s) {
  if (s.indexOf('.') < 0) return s === '-0' ? '0' : s;
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/**
 * Parse a length typed by the user. Accepts simple maths and unit suffixes:
 * "25", "1/4in", "10mm + 2.5", "2*(3+4) cm", '1.5"'. Returns mm, or NaN.
 */
export function parseLen(str) {
  return parseExpr(str, true);
}

/** Parse an angle in degrees (maths allowed, "deg"/"°" optional). */
export function parseAng(str) {
  return parseExpr(String(str).replace(/°|deg/gi, ''), false);
}

/** Parse a plain number with maths (counts, etc). */
export function parseNum(str) {
  return parseExpr(str, false);
}

function parseExpr(str, isLen) {
  const s = String(str || '').trim().toLowerCase().replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/');
  if (!s) return NaN;
  let i = 0;
  const peek = () => s[i];
  const ws = () => { while (s[i] === ' ') i++; };
  const unitFactor = () => {
    ws();
    const m = /^(mm|cm|m|in|inch|inches|"|ft|')/.exec(s.slice(i));
    if (!m || !isLen) return null;
    i += m[0].length;
    return { mm: 1, cm: 10, m: 1000, in: 25.4, inch: 25.4, inches: 25.4, '"': 25.4, ft: 304.8, "'": 304.8 }[m[1]];
  };
  // values carry a flag: does it have an explicit unit?
  function atom() {
    ws();
    if (peek() === '(') { i++; const v = expr(); ws(); if (peek() !== ')') throw 0; i++; const f = unitFactor(); return f ? { v: v.v * f / (v.u ? 1 : 1), u: true } : v; }
    if (peek() === '-') { i++; const a = atom(); return { v: -a.v, u: a.u }; }
    if (peek() === '+') { i++; return atom(); }
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/.exec(s.slice(i));
    if (!m) throw 0;
    i += m[0].length;
    const v = parseFloat(m[0]);
    const f = unitFactor();
    return f ? { v: v * f, u: true, f } : { v, u: false };
  }
  function term() {
    let a = atom();
    for (;;) {
      ws();
      const c = peek();
      if (c === '*') { i++; const b = atom(); a = { v: a.v * b.v, u: a.u || b.u }; }
      else if (c === '/') { i++; const b = atom(); a = !a.u && b.u && b.f ? { v: a.v / (b.v / b.f) * b.f, u: true, f: b.f } : { v: a.v / b.v, u: a.u && !b.u }; }
      else return a;
    }
  }
  function expr() {
    let a = term();
    for (;;) {
      ws();
      const c = peek();
      if (c === '+' || c === '-') {
        i++;
        const b = term();
        // mixing plain numbers with unit numbers: plain ones are in display units
        const av = a.u || !isLen ? a.v : U.fromDisp(a.v), bv = b.u || !isLen ? b.v : U.fromDisp(b.v);
        if (a.u || b.u) a = { v: c === '+' ? av + bv : av - bv, u: true };
        else a = { v: c === '+' ? a.v + b.v : a.v - b.v, u: false };
      } else return a;
    }
  }
  try {
    const r = expr();
    ws();
    if (i < s.length) return NaN;
    if (!Number.isFinite(r.v)) return NaN;
    return isLen && !r.u ? U.fromDisp(r.v) : r.v;
  } catch (e) {
    return NaN;
  }
}
