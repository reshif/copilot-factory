// A small Mermaid renderer for the design gate (0.11): the page stays one self-contained file, so
// it draws the subset the ADR template asks for itself — flowchart / graph (nodes, labelled edges,
// subgraph boundaries, the "changed" class), stateDiagram (transitions), erDiagram (relations) and
// sequenceDiagram (participants, messages, notes, alt / else / opt / loop / par / break blocks).
// mermaidSvg(source) returns an SVG string, or null for a diagram it does not draw (the page then
// shows the source). Pure: no DOM, so it is the same in the page and in the tests.
const MM_CHAR = 6.4;
const mmEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const mmClean = (s) => String(s || '').replace(/^["'`]|["'`]$/g, '').replace(/<br\s*\/?>/gi, ' ').replace(/&quot;/g, '"').trim();
function mmLines(src) {
  return String(src || '').split('\n').map((l) => l.replace(/%%.*$/, '').trim()).filter(Boolean);
}
// Release review m1/m2: a diagram is drawn only within caps (lines, nodes, subgraph depth): past
// them the page shows the source ("too large"); a line the renderer does not understand marks the
// figure "partly drawn" and the page opens the source next to it.
const MM_MAX_LINES = 400;
const MM_MAX_NODES = 250;
const MM_MAX_DEPTH = 10;
let MM_UNKNOWN = [];
// { svg, partial, unknown: [lines], reason } — svg null when not drawn (reason says why)
function mermaidRender(src) {
  const lines = mmLines(src);
  if (!lines.length) return { svg: null, partial: false, unknown: [], reason: 'empty' };
  if (lines.length > MM_MAX_LINES || String(src).length > 60000) return { svg: null, partial: false, unknown: [], reason: `too large (${lines.length} lines) — showing source` };
  const head = lines[0].split(/\s+/)[0];
  MM_UNKNOWN = [];
  let svg = null;
  try {
    if (head === 'flowchart' || head === 'graph') svg = mmFlow(lines.slice(1), (lines[0].split(/\s+/)[1] || 'TB').replace(';', ''));
    else if (head === 'stateDiagram' || head === 'stateDiagram-v2') svg = mmFlow(mmStateToFlow(lines.slice(1)), 'TB');
    else if (head === 'erDiagram') svg = mmFlow(mmErToFlow(lines.slice(1)), 'LR');
    else if (head === 'sequenceDiagram') svg = mmSeq(lines.slice(1));
    else return { svg: null, partial: false, unknown: [], reason: `${head} is not drawn here — showing source` };
  } catch (e) {
    return { svg: null, partial: false, unknown: [], reason: String((e && e.message) || 'not drawn') };
  }
  const unknown = MM_UNKNOWN.slice(0, 20);
  if (svg === 'TOO_LARGE') return { svg: null, partial: false, unknown: [], reason: 'too large — showing source' };
  return { svg, partial: unknown.length > 0, unknown, reason: svg ? null : 'not drawn — showing source' };
}
function mermaidSvg(src) {
  return mermaidRender(src).svg;
}
// ---------------------------------------------------------------- flowchart
const MM_SHAPES = [[/^\(\[(.*)\]\)$/, 'stadium'], [/^\[\((.*)\)\]$/, 'db'], [/^\(\((.*)\)\)$/, 'circle'], [/^\[\[(.*)\]\]$/, 'rect'], [/^\[\/(.*)\/\]$/, 'rect'], [/^\[(.*)\]$/, 'rect'], [/^\((.*)\)$/, 'round'], [/^\{\{(.*)\}\}$/, 'hex'], [/^\{(.*)\}$/, 'diamond'], [/^>(.*)\]$/, 'rect']];
// Every Mermaid link form (release review m1): any length (--> ---> ---->, --- ----, ==> ===>,
// === ====, -.-> -..->, -.-), circle/cross ends (--o --x), both ends (<-->, <==>), invisible (~~~),
// a label as |text| after the link, or as text inside it (-- text --> / -- text --- / == text ==>
// / -. text .->).
const MM_EDGE = /^\s*(?:(<?-{2,}>|<?={2,}>|-{3,}|={3,}|-\.+-?>|-\.+-|--[ox](?![\w])|~{3,})\s*(?:\|([^|]*)\|)?|--\s+([^-|\s][^|]*?)\s+(-{2,}>|-{3,})|==\s+([^=|\s][^|]*?)\s+(={2,}>|={3,})|-\.\s+(.*?)\s+(\.-+>|\.-+))\s*/;
function mmNodeTok(s) {
  // an id, then an optional shape; returns [id, label|null, shape|null, rest]. A "-" belongs to
  // the id only when no link follows it ("A-->B" is A, -->, B; "my-node" is one id)
  const m = /^([A-Za-z0-9_](?:[\w.]|-(?![-.=>ox]{1,}[\s\w|>]|-))*)/.exec(s);
  if (!m) return null;
  let rest = s.slice(m[0].length);
  let label = null;
  let shape = null;
  const open = rest[0];
  if (open && '([{>'.includes(open)) {
    // find the matching close of the shape, quotes respected
    let depth = 0;
    let q = false;
    let end = -1;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (c === '"') q = !q;
      if (q) continue;
      if ('([{'.includes(c) || (i === 0 && c === '>')) depth++;
      else if (')]}'.includes(c)) { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > 0) {
      const tok = rest.slice(0, end + 1);
      for (const [re, sh] of MM_SHAPES) { const x = re.exec(tok); if (x) { label = mmClean(x[1]); shape = sh; break; } }
      rest = rest.slice(end + 1);
    }
  }
  rest = rest.replace(/^:::[\w-]+/, '');
  return [m[1], label, shape, rest];
}
function mmFlow(lines, dir) {
  const nodes = new Map();
  const edges = [];
  const groups = [];
  const stack = [];
  const changed = new Set();
  const classes = {};
  const node = (id, label, shape) => {
    if (!nodes.has(id)) nodes.set(id, { id, label: label || id, shape: shape || 'rect', group: stack.length ? stack[stack.length - 1] : null, order: nodes.size });
    else if (label) Object.assign(nodes.get(id), { label, shape: shape || nodes.get(id).shape });
    return nodes.get(id);
  };
  for (const l of lines) {
    let m;
    if (stack.length >= MM_MAX_DEPTH && /^subgraph\b/.test(l)) return 'TOO_LARGE';
    if ((m = /^subgraph\s+(.*)$/.exec(l))) {
      const t = m[1].trim();
      const x = /^([\w.-]+)\s*\[(.*)\]$/.exec(t);
      const g = { id: x ? x[1] : t, label: mmClean(x ? x[2] : t), parent: stack.length ? stack[stack.length - 1] : null };
      groups.push(g);
      stack.push(groups.length - 1);
      continue;
    }
    if (/^end\s*;?$/.test(l)) { stack.pop(); continue; }
    if ((m = /^classDef\s+(\S+)\s+(.*)$/.exec(l))) { classes[m[1]] = m[2]; continue; }
    if ((m = /^class\s+(\S+)\s+(\S+)/.exec(l))) { if (m[2] === 'changed' || /fill/.test(classes[m[2]] || '')) for (const id of m[1].split(',')) changed.add(id.trim()); continue; }
    if (/^(style|linkStyle|click|direction|accTitle|accDescr)\b/.test(l)) continue;
    // a chain: node (edge node)*; "&" joins several nodes on one side
    let rest = l.replace(/;$/, '');
    let left = [];
    const side = () => {
      const ids = [];
      for (;;) {
        const t = mmNodeTok(rest.trim());
        if (!t) break;
        node(t[0], t[1], t[2]);
        ids.push(t[0]);
        rest = t[3];
        const amp = /^\s*&\s*/.exec(rest);
        if (!amp) break;
        rest = rest.slice(amp[0].length);
      }
      return ids;
    };
    left = side();
    if (!left.length) {
      MM_UNKNOWN.push(l);
      continue;
    }
    for (;;) {
      const e = MM_EDGE.exec(rest);
      if (!e) break;
      rest = rest.slice(e[0].length);
      const op = e[1] || e[4] || e[6] || e[8] || '';
      const label = mmClean(e[2] || e[3] || e[5] || e[7] || '');
      const dashed = /\.|~/.test(op);
      const right = side();
      if (!right.length) {
        rest = `?${rest}`;
        break;
      }
      for (const a of left) for (const b of right) edges.push({ from: a, to: b, label, dashed, arrow: />$/.test(op) && !/~/.test(op) });
      left = right;
    }
    if (rest.trim()) MM_UNKNOWN.push(l);
    if (nodes.size > MM_MAX_NODES) return 'TOO_LARGE';
  }
  if (!nodes.size) return null;
  for (const id of changed) if (nodes.has(id)) nodes.get(id).changed = true;
  // layers: longest path from the sources; an edge that closes a cycle (found depth-first) is
  // drawn but does not push its target down
  const ids = [...nodes.keys()];
  const seen = {};
  const visit = (id) => {
    seen[id] = 1;
    for (const e of edges.filter((x) => x.from === id)) {
      if (seen[e.to] === 1) e.back = true;
      else if (!seen[e.to]) visit(e.to);
    }
    seen[id] = 2;
  };
  for (const id of ids) if (!seen[id]) visit(id);
  const layer = Object.fromEntries(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const e of edges) {
      if (e.from === e.to || e.back) continue;
      if (layer[e.to] < layer[e.from] + 1 && layer[e.from] + 1 < ids.length) { layer[e.to] = layer[e.from] + 1; moved = true; }
    }
    if (!moved) break;
  }
  const byLayer = [];
  for (const id of ids) (byLayer[layer[id]] = byLayer[layer[id]] || []).push(id);
  // within a layer, keep each subgraph's nodes together
  for (const l of byLayer) if (l) l.sort((a, b) => String(nodes.get(a).group).localeCompare(String(nodes.get(b).group)) || nodes.get(a).order - nodes.get(b).order);
  const horiz = dir === 'LR' || dir === 'RL';
  const W = (n) => Math.min(200, Math.max(70, n.label.length * MM_CHAR + 22));
  const H = 34;
  const gapMain = horiz ? 70 : 54;
  const gapCross = horiz ? 22 : 26;
  const pos = {};
  const layerSize = byLayer.map((l) => (l ? Math.max(...l.map((id) => (horiz ? W(nodes.get(id)) : H))) : 0));
  // two bands: the nodes inside subgraphs first, then the ones outside them (actors, external
  // systems) below or beside, so a boundary box never covers a node that is not in it
  const place = (inGroup, start) => {
    let main = 20;
    let far = start;
    byLayer.forEach((l, i) => {
      if (!l) return;
      let cross = start;
      for (const id of l.filter((x) => (nodes.get(x).group !== null) === inGroup)) {
        const w = W(nodes.get(id));
        if (horiz) { pos[id] = { x: main, y: cross, w, h: H }; cross += H + gapCross; }
        else { pos[id] = { x: cross, y: main, w, h: H }; cross += w + gapCross; }
      }
      far = Math.max(far, cross);
      main += layerSize[i] + gapMain;
    });
    return far;
  };
  const grouped = ids.some((id) => nodes.get(id).group !== null);
  const bandEnd = place(true, grouped ? 34 : 20);
  place(false, grouped ? bandEnd + 26 : 20);
  // subgraph boxes around their members (nested ones included)
  // each node's groups, walked once (nodes × depth), not per group (release review m2)
  const members = groups.map(() => []);
  for (const id of ids) {
    let g = nodes.get(id).group;
    for (let d = 0; g !== null && g !== undefined && d <= MM_MAX_DEPTH; d++) {
      members[g].push(id);
      g = groups[g].parent;
    }
  }
  const memberOf = (gi) => members[gi];
  const boxes = groups.map((g, gi) => {
    const ms = memberOf(gi).map((id) => pos[id]);
    if (!ms.length) return null;
    const x = Math.min(...ms.map((p) => p.x)) - 12;
    const y = Math.min(...ms.map((p) => p.y)) - 24;
    return { label: g.label, x, y, w: Math.max(...ms.map((p) => p.x + p.w)) - x + 12, h: Math.max(...ms.map((p) => p.y + p.h)) - y + 12 };
  }).filter(Boolean);
  const all = [...Object.values(pos), ...boxes];
  const width = Math.max(...all.map((p) => p.x + p.w)) + 20;
  const height = Math.max(...all.map((p) => p.y + p.h)) + 20;
  const out = [`<svg class="mmd" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}" width="${Math.ceil(width)}" height="${Math.ceil(height)}" role="img"><defs><marker id="mmA" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="mm-ah"/></marker></defs>`];
  for (const b of boxes) out.push(`<g class="mm-grp"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6"/><text x="${b.x + 8}" y="${b.y + 15}">${mmEsc(b.label)}</text></g>`);
  for (const e of edges) {
    const a = pos[e.from];
    const b = pos[e.to];
    if (!a || !b) continue;
    const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const clip = (p, c, o) => {
      const dx = o.x - c.x;
      const dy = o.y - c.y;
      if (!dx && !dy) return c;
      const s = Math.min(Math.abs((p.w / 2) / (dx || 1e-9)), Math.abs((p.h / 2) / (dy || 1e-9)));
      return { x: c.x + dx * s, y: c.y + dy * s };
    };
    const p1 = clip(a, ac, bc);
    const p2 = clip(b, bc, ac);
    out.push(`<g class="mm-edge${e.dashed ? ' dashed' : ''}"><line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}"${e.arrow ? ' marker-end="url(#mmA)"' : ''}/>${e.label ? `<text x="${((p1.x + p2.x) / 2).toFixed(1)}" y="${((p1.y + p2.y) / 2 - 4).toFixed(1)}" text-anchor="middle">${mmEsc(e.label.length > 34 ? `${e.label.slice(0, 33)}…` : e.label)}</text>` : ''}</g>`);
  }
  for (const id of ids) {
    const n = nodes.get(id);
    const p = pos[id];
    const cls = `mm-node${n.changed ? ' changed' : ''}`;
    const rx = n.shape === 'stadium' || n.shape === 'circle' ? p.h / 2 : n.shape === 'round' ? 10 : 3;
    const shape = n.shape === 'diamond'
      ? `<polygon points="${p.x + p.w / 2},${p.y - 4} ${p.x + p.w + 4},${p.y + p.h / 2} ${p.x + p.w / 2},${p.y + p.h + 4} ${p.x - 4},${p.y + p.h / 2}"/>`
      : n.shape === 'db'
        ? `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${p.w / 2}" ry="7"/>`
        : `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${rx}"/>`;
    const label = n.label.length > 30 ? `${n.label.slice(0, 29)}…` : n.label;
    out.push(`<g class="${cls}"><title>${mmEsc(n.label)}</title>${shape}<text x="${p.x + p.w / 2}" y="${p.y + p.h / 2 + 4}" text-anchor="middle">${mmEsc(label)}</text></g>`);
  }
  out.push('</svg>');
  return out.join('');
}
function mmStateToFlow(lines) {
  const out = [];
  for (const l of lines) {
    const m = /^(\[\*\]|[\w.-]+)\s*-->\s*(\[\*\]|[\w.-]+)\s*(?::\s*(.*))?$/.exec(l);
    if (!m) continue;
    const id = (x, start) => (x === '[*]' ? `${start ? 'start' : 'stop'}((●))` : x);
    out.push(`${id(m[1], true)} -->${m[3] ? `|${m[3].replace(/\|/g, '/')}|` : ''} ${id(m[2], false)}`);
  }
  return out;
}
function mmErToFlow(lines) {
  const out = [];
  for (const l of lines) {
    const m = /^([\w-]+)\s+([|}o{]{2})(--|\.\.)([|}o{]{2})\s+([\w-]+)\s*(?::\s*(.*))?$/.exec(l);
    if (m) out.push(`${m[1]} ---|${(m[6] || '').replace(/["|]/g, '')} ${m[2]}${m[4]}| ${m[5]}`);
  }
  return out;
}
// ---------------------------------------------------------------- sequence
function mmSeq(lines) {
  const parts = [];
  const pIdx = {};
  const part = (id, label, actor) => {
    if (!(id in pIdx)) { pIdx[id] = parts.length; parts.push({ id, label: label || id, actor: Boolean(actor) }); }
    return pIdx[id];
  };
  const rows = [];
  const blocks = [];
  const open = [];
  for (const l of lines) {
    let m;
    if ((m = /^(participant|actor)\s+([^\s]+)(?:\s+as\s+(.*))?$/.exec(l))) { part(m[2], m[3] && mmClean(m[3]), m[1] === 'actor'); continue; }
    if (/^(autonumber|activate|deactivate|box|title|accTitle|accDescr|create|destroy)\b/.test(l)) continue;
    if ((m = /^(alt|opt|loop|par|critical|break|rect)\b\s*(.*)$/.exec(l))) { const b = { kind: m[1], label: mmClean(m[2]), start: rows.length, splits: [] }; rows.push({ kind: 'gap' }); blocks.push(b); open.push(b); continue; }
    if ((m = /^(else|and|option)\b\s*(.*)$/.exec(l))) { const b = open[open.length - 1]; if (b) { b.splits.push({ at: rows.length, label: mmClean(m[2]) }); rows.push({ kind: 'gap' }); } continue; }
    if (/^end\s*;?$/.test(l)) { const b = open.pop(); if (b) { b.end = rows.length; rows.push({ kind: 'gap' }); } continue; }
    if ((m = /^note\s+(over|left of|right of)\s+([^:]+):\s*(.*)$/i.exec(l))) {
      const who = m[2].split(',').map((x) => part(x.trim()));
      rows.push({ kind: 'note', who, where: m[1].toLowerCase(), text: mmClean(m[3]) });
      continue;
    }
    if ((m = /^([^\s:+-][^:]*?)\s*(-->>|->>|-->|->|--x|-x|--\)|-\))\s*[+-]?\s*([^:]+?)\s*:\s*(.*)$/.exec(l))) {
      rows.push({ kind: 'msg', from: part(m[1].trim()), to: part(m[3].trim()), text: mmClean(m[4]), dashed: m[2].startsWith('--'), lost: /x$/.test(m[2]) });
    } else MM_UNKNOWN.push(l);
  }
  if (!parts.length || !rows.length) return null;
  for (const b of open) b.end = rows.length;
  const colW = Math.max(140, Math.min(220, Math.max(...rows.filter((r) => r.kind === 'msg').map((r) => r.text.length * MM_CHAR / Math.max(1, Math.abs(r.to - r.from) || 1) + 30), 0)));
  const X = (i) => 30 + i * colW + colW / 2;
  const top = 20;
  const headH = 32;
  const rowH = 32;
  const gapH = 14;
  const y0 = top + headH + 22;
  const ys = [];
  let yy = y0;
  rows.forEach((r) => { ys.push(r.kind === 'gap' ? yy - 6 : yy); yy += r.kind === 'gap' ? gapH : rowH; });
  ys.push(yy);
  const Y = (r) => ys[r];
  const width = 60 + parts.length * colW;
  const height = Y(rows.length) + 30;
  const out = [`<svg class="mmd" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}" width="${Math.ceil(width)}" height="${Math.ceil(height)}" role="img"><defs><marker id="mmS" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="mm-ah"/></marker></defs>`];
  // blocks first (behind)
  const depthOf = (b) => blocks.filter((o) => o !== b && o.start <= b.start && (o.end || 0) >= (b.end || 0)).length;
  for (const b of blocks) {
    const d = depthOf(b);
    const x = 8 + d * 8;
    const y = Y(b.start) - 8;
    const h = Y(b.end) - y + 2;
    out.push(`<g class="mm-blk mm-${b.kind}"><rect x="${x}" y="${y}" width="${width - 2 * x}" height="${h}" rx="4"/><text x="${x + 6}" y="${y + 12}"><tspan class="kw">${mmEsc(b.kind)}</tspan> ${mmEsc(b.label)}</text>`);
    for (const s of b.splits) out.push(`<line x1="${x}" x2="${width - x}" y1="${Y(s.at) - 8}" y2="${Y(s.at) - 8}"/><text x="${x + 6}" y="${Y(s.at) + 4}"><tspan class="kw">else</tspan> ${mmEsc(s.label)}</text>`);
    out.push('</g>');
  }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    out.push(`<g class="mm-part${p.actor ? ' actor' : ''}"><line x1="${X(i)}" x2="${X(i)}" y1="${top + headH}" y2="${height - 6}"/><rect x="${X(i) - colW / 2 + 10}" y="${top}" width="${colW - 20}" height="${headH}" rx="${p.actor ? 16 : 4}"/><text x="${X(i)}" y="${top + headH / 2 + 4}" text-anchor="middle">${mmEsc(p.label.length > 26 ? `${p.label.slice(0, 25)}…` : p.label)}</text></g>`);
  }
  let num = 0;
  rows.forEach((r, i) => {
    const y = Y(i) + 8;
    if (r.kind === 'gap') return;
    if (r.kind === 'note') {
      const xs = r.who.map(X);
      const tw = r.text.length * MM_CHAR + 16;
      const span = Math.max(...xs) - Math.min(...xs);
      const pad = Math.max(50, (tw - span) / 2);
      const x1 = r.where === 'left of' ? Math.min(...xs) - tw - 8 : r.where === 'right of' ? Math.max(...xs) + 8 : Math.min(...xs) - pad;
      const x2 = r.where === 'left of' ? Math.min(...xs) - 8 : r.where === 'right of' ? Math.max(...xs) + tw + 8 : Math.max(...xs) + pad;
      out.push(`<g class="mm-note"><rect x="${x1}" y="${y - 16}" width="${x2 - x1}" height="22" rx="3"/><text x="${(x1 + x2) / 2}" y="${y - 1}" text-anchor="middle">${mmEsc(r.text)}</text></g>`);
      return;
    }
    const a = X(r.from);
    const b = X(r.to);
    num += 1;
    const n = `<tspan class="num">${num}</tspan> `;
    if (r.from === r.to) {
      out.push(`<g class="mm-msg${r.dashed ? ' dashed' : ''}"><path d="M${a},${y - 6} h36 v14 h-34" fill="none" marker-end="url(#mmS)"/><text x="${a + 42}" y="${y - 2}">${n}${mmEsc(r.text)}</text></g>`);
      return;
    }
    out.push(`<g class="mm-msg${r.dashed ? ' dashed' : ''}"><line x1="${a}" x2="${b + (b > a ? -3 : 3)}" y1="${y}" y2="${y}" marker-end="url(#mmS)"/><text x="${(a + b) / 2}" y="${y - 6}" text-anchor="middle">${n}${mmEsc(r.text.length > 60 ? `${r.text.slice(0, 59)}…` : r.text)}</text></g>`);
  });
  out.push('</svg>');
  return out.join('');
}
