'use strict';
// A small, dependency-free shell reader for the guards (the inspector keeps an identical
// copy: plugins are independent). It splits a command line the way bash would — quotes,
// escapes, `;` `&&` `||` `|` `&` newlines, `( )`, `$( )` and backticks, redirections and
// heredocs — into simple commands whose words carry their unquoted text. Nothing is
// expanded: `$X` stays `$X`. The guards then look only at what runs (the command word and
// its arguments), never at prose inside quotes, so `grep "factory approve" docs/` is a
// grep, not a factory call.
//
// parse(src) → [Command]
//   Command = { words: [Word], redirs: [{ op, fd, target: Word|null }], heredocs: [{ delim, quoted, body }],
//               pipeIn, pipeOut, subs: [string] }   (subs: the source of every $( ) / `…` in it)
//   Word    = { text, quoted, expand, subs: [string] }   (text: the value with quotes removed)

const OPS = ['&&', '||', '|&', ';;', '|', ';', '&', '\n', '(', ')'];
const REDIR = ['<<<', '<<-', '<<', '<>', '<&', '<', '>>', '>|', '>&', '>', '&>>', '&>'];

// End index (exclusive) of a $( … ) that opens at `start` (pointing just after "$(").
function scanParen(src, start) {
  let depth = 1;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'") {
      const e = src.indexOf("'", i + 1);
      i = e === -1 ? src.length : e + 1;
      continue;
    }
    if (c === '"') {
      i = scanDouble(src, i + 1).end;
      continue;
    }
    if (c === '`') {
      const e = scanBacktick(src, i + 1);
      i = e;
      continue;
    }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      // a heredoc inside the substitution: skip its body
      const m = /^<<-?\s*(['"]?)([A-Za-z_][\w.-]*)\1/.exec(src.slice(i));
      if (m) {
        const nl = src.indexOf('\n', i);
        if (nl !== -1) {
          const strip = m[0].startsWith('<<-');
          let j = nl + 1;
          let found = false;
          while (j <= src.length) {
            const e = src.indexOf('\n', j);
            const line = src.slice(j, e === -1 ? src.length : e);
            if ((strip ? line.replace(/^\t+/, '') : line).trim() === m[2]) {
              i = e === -1 ? src.length : e;
              found = true;
              break;
            }
            if (e === -1) break;
            j = e + 1;
          }
          if (found) continue;
        }
      }
    }
    if (c === '(') depth += 1;
    if (c === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return src.length;
}

function scanBacktick(src, start) {
  let i = start;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === '`') return i + 1;
    i += 1;
  }
  return src.length;
}

// Reads a "…" body starting after the opening quote: its text, its $( ) sources, and its end.
function scanDouble(src, start) {
  let text = '';
  const subs = [];
  let expand = false;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') return { text, subs, expand, end: i + 1 };
    if (c === '\\' && i + 1 < src.length && '$`"\\\n'.includes(src[i + 1])) {
      if (src[i + 1] !== '\n') text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      const arith = src[i + 2] === '(';
      const end = scanParen(src, i + 2);
      if (!arith) subs.push(src.slice(i + 2, end - 1));
      text += src.slice(i, end);
      expand = true;
      i = end;
      continue;
    }
    if (c === '`') {
      const end = scanBacktick(src, i + 1);
      subs.push(src.slice(i + 1, end - 1));
      text += src.slice(i, end);
      expand = true;
      i = end;
      continue;
    }
    if (c === '$') expand = true;
    text += c;
    i += 1;
  }
  return { text, subs, expand, end: src.length };
}

function parse(source) {
  const src = String(source || '');
  const commands = [];
  let cmd = newCommand();
  let word = null; // the word being built
  let pendingRedir = null; // a redirection waiting for its target word
  const pendingHeredocs = [];
  let i = 0;

  function newCommand() {
    return { words: [], redirs: [], heredocs: [], pipeIn: false, pipeOut: false, subs: [] };
  }
  function startWord() {
    if (!word) word = { text: '', quoted: false, expand: false, subs: [] };
  }
  function endWord() {
    if (!word) return;
    const w = word;
    word = null;
    cmd.subs.push(...w.subs);
    if (pendingRedir) {
      pendingRedir.target = w;
      if (pendingRedir.op === '<<' || pendingRedir.op === '<<-') {
        const h = { delim: w.text, quoted: w.quoted, strip: pendingRedir.op === '<<-', body: '', cmd };
        cmd.heredocs.push(h);
        pendingHeredocs.push(h);
      }
      pendingRedir = null;
      return;
    }
    cmd.words.push(w);
  }
  function endCommand(pipe) {
    endWord();
    if (cmd.words.length || cmd.redirs.length || cmd.heredocs.length) {
      if (pipe) cmd.pipeOut = true;
      commands.push(cmd);
      cmd = newCommand();
      if (pipe) cmd.pipeIn = true;
    } else if (pipe) {
      cmd.pipeIn = true;
    }
  }
  function readHeredocBodies() {
    // i points just after a newline
    while (pendingHeredocs.length) {
      const h = pendingHeredocs.shift();
      const lines = [];
      let closed = false;
      while (i <= src.length) {
        const e = src.indexOf('\n', i);
        const line = src.slice(i, e === -1 ? src.length : e);
        i = e === -1 ? src.length : e + 1;
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim || line.trim() === h.delim) {
          closed = true;
          break;
        }
        lines.push(h.strip ? line.replace(/^\t+/, '') : line);
        if (e === -1) break;
      }
      h.body = lines.join('\n');
      h.closed = closed;
      delete h.cmd;
    }
  }

  while (i < src.length) {
    const c = src[i];
    // comments: # at the start of a word
    if (c === '#' && !word) {
      const e = src.indexOf('\n', i);
      i = e === -1 ? src.length : e;
      continue;
    }
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      startWord();
      word.text += src[i + 1] || '';
      i += 2;
      continue;
    }
    if (c === "'") {
      startWord();
      word.quoted = true;
      const e = src.indexOf("'", i + 1);
      word.text += src.slice(i + 1, e === -1 ? src.length : e);
      i = e === -1 ? src.length : e + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === "'") {
      startWord();
      word.quoted = true;
      let j = i + 2;
      while (j < src.length && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < src.length) {
          const n = src[j + 1];
          word.text += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          j += 2;
          continue;
        }
        word.text += src[j];
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (c === '"') {
      startWord();
      word.quoted = true;
      const d = scanDouble(src, i + 1);
      word.text += d.text;
      word.subs.push(...d.subs);
      if (d.expand) word.expand = true;
      i = d.end;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      startWord();
      const arith = src[i + 2] === '(';
      const end = scanParen(src, i + 2);
      if (!arith) word.subs.push(src.slice(i + 2, end - 1));
      word.text += src.slice(i, end);
      word.expand = true;
      i = end;
      continue;
    }
    if (c === '$' && src[i + 1] === '{') {
      startWord();
      const e = src.indexOf('}', i + 2);
      word.text += src.slice(i, e === -1 ? src.length : e + 1);
      word.expand = true;
      i = e === -1 ? src.length : e + 1;
      continue;
    }
    if (c === '`') {
      startWord();
      const end = scanBacktick(src, i + 1);
      word.subs.push(src.slice(i + 1, end - 1));
      word.text += src.slice(i, end);
      word.expand = true;
      i = end;
      continue;
    }
    if (c === '$') {
      startWord();
      word.expand = true;
      word.text += c;
      i += 1;
      continue;
    }
    // redirections (a word made only of digits right before one is its fd)
    const redir = REDIR.find((r) => src.startsWith(r, i));
    if (redir && !(redir.startsWith('&') && word)) {
      let fd = null;
      if (word && !word.quoted && /^\d+$/.test(word.text)) {
        fd = word.text;
        word = null;
      } else {
        endWord();
      }
      i += redir.length;
      const r = { op: redir, fd, target: null };
      cmd.redirs.push(r);
      // >&2, 2>&1, <&0: the target is an fd, not a file
      if ((redir === '>&' || redir === '<&') && /^\s*(\d+|-)\b/.test(src.slice(i))) {
        const m = /^\s*(\d+|-)/.exec(src.slice(i));
        r.target = { text: `&${m[1]}`, quoted: false, expand: false, subs: [] };
        i += m[0].length;
        continue;
      }
      while (src[i] === ' ' || src[i] === '\t') i += 1;
      pendingRedir = r;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      i += op.length;
      if (op === '|' || op === '|&') endCommand(true);
      else endCommand(false);
      if (op === '\n' && pendingHeredocs.length) {
        endWord();
        readHeredocBodies();
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i += 1;
      continue;
    }
    startWord();
    word.text += c;
    i += 1;
  }
  endCommand(false);
  // an unterminated heredoc at the end of the input: its body is whatever follows (nothing)
  for (const h of pendingHeredocs) delete h.cmd;
  return commands;
}

module.exports = { parse };
