'use strict';
// Minimal glob matcher for allowed_paths / protected_paths / ui_paths.
// Supports: ** (any depth), * (within a segment), ? (one char), and a
// trailing "/" meaning "everything under this directory".

const cache = new Map();

function toRegex(glob) {
  if (cache.has(glob)) return cache.get(glob);
  let g = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // "**/" matches zero or more directories; "**" at end matches anything.
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  const rx = new RegExp(`^${re}$`);
  cache.set(glob, rx);
  return rx;
}

function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

function matches(file, glob) {
  const f = normalize(file);
  const g = normalize(glob);
  // A bare directory name (no glob chars, no extension match) also covers its contents.
  if (!/[*?]/.test(g) && (f === g || f.startsWith(g.endsWith('/') ? g : g + '/'))) return true;
  return toRegex(g).test(f);
}

function matchesAny(file, globs) {
  return (globs || []).some((g) => matches(file, g));
}

// Rough overlap test between two glob lists (used for "no shared files in a wave").
// Conservative: treats globs as overlapping if either could match the other's literal prefix.
function globsOverlap(a, b) {
  for (const x of a || []) {
    for (const y of b || []) {
      const px = literalPrefix(x);
      const py = literalPrefix(y);
      if (matches(px || '', y) || matches(py || '', x)) return true;
      if (px && py && (px.startsWith(py) || py.startsWith(px))) return true;
    }
  }
  return false;
}

function literalPrefix(glob) {
  const g = normalize(glob);
  const idx = g.search(/[*?]/);
  return idx === -1 ? g : g.slice(0, idx);
}

module.exports = { matches, matchesAny, globsOverlap, normalize };
