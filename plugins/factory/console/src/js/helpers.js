const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
const meas = document.createElement('canvas').getContext('2d');
function textW(t, font) { meas.font = font; return meas.measureText(t).width; }
function wrap(t, font, max) {
  const words = String(t).split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const tryL = line ? `${line} ${w}` : w;
    if (textW(tryL, font) > max && line) { lines.push(line); line = w; } else line = tryL;
  }
  if (line) lines.push(line);
  return lines;
}
function fit(t, font, max) {
  if (textW(t, font) <= max) return t;
  let s = t;
  while (s.length > 1 && textW(`${s}…`, font) > max) s = s.slice(0, -1);
  return `${s}…`;
}
const FONT_T = '600 13px "IBM Plex Sans", system-ui, sans-serif';
const FONT_S = '400 11.5px "IBM Plex Sans", system-ui, sans-serif';
const FONT_P = '500 10.5px "IBM Plex Mono", ui-monospace, monospace';

let recipe = 'standard@medium';
try { recipe = localStorage.getItem('fc-recipe') || recipe; } catch (e) { /* storage unavailable */ }
if (!RECIPES[recipe]) recipe = 'standard@medium';

function nodeActive(n) {
  const r = RECIPES[recipe];
  if (n.only && !n.only.includes(recipe)) return false;
  if (n.except && n.except.includes(recipe)) return false;
  if (!n.step) return true;
  return r.steps.includes(n.step) || (n.alt && r.steps.includes(n.alt)) || (n.also || []).some((s) => r.steps.includes(s));
}
function pillActive(p) {
  const r = RECIPES[recipe];
  if (!p.gate) return true;
  if (p.gate === 'threat') return Boolean(r.threat);
  if (p.gate.startsWith('lane:')) return r.lanes.includes(p.gate.slice(5));
  return true;
}

// ===================================================================== layout
