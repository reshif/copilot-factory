'use strict';
// Agents may run inspections and read reports, but marking findings and changing
// inspection modes are yours. An agent `factory run` started (opts.agent) runs no
// inspections at all: the inspector is the main session's.
//
// Commands are read with hooks/shell.js (an identical copy of the factory's): factory-inspect
// counts only where it runs — the command word of a simple command, after env assignments
// and wrappers (env, sudo, exec, nice, timeout, xargs, …), or inside code that runs (eval,
// bash/sh -c, $( ), backticks, a heredoc or pipe fed to a shell), or through a variable,
// alias or function set to it. Words in quoted arguments, grep patterns, echo text and
// commit messages are data. Writes to .factory/inspect/ are real redirect / tee / rm / mv /
// cp / sed -i targets (2>/dev/null and >&2 are not writes).

const { parse } = require('./shell');

const AGENT_DENIED = new Set(['run', 'mark', 'mode', 'health']);
const HUMAN = new Set(['mark', 'mode']);
const SHELLS = /^(bash|sh|zsh|dash|ksh|mksh|fish|ash|pwsh|powershell)$/;
const WRAPPERS = { env: ['-u', '-C', '-S'], sudo: ['-u', '-g', '-h', '-p', '-C'], doas: ['-u'], exec: ['-a'], nice: ['-n'], nohup: [], setsid: [], time: ['-f', '-o'], stdbuf: [], timeout: ['-s', '-k'], command: [], builtin: [] };
const XARGS_VALUED = new Set(['-I', '-i', '-L', '-l', '-n', '-P', '-s', '-E', '-e', '-d', '-a', '-j']);
const INSPECT_DIR = /(^|[\\/])\.factory[\\/]inspect([\\/]|$)/;

function isInspectPath(x) {
  const s = String(x || '');
  return s === 'factory-inspect' || /[\\/]factory-inspect(\.cmd)?$/.test(s) || /inspector[\\/]main(\.js)?$/.test(s);
}

const varName = (t) => (String(t || '').match(/^\$\{?([A-Za-z_]\w*)\}?$/) || [])[1] || null;
const isLookup = (src) => /^\s*(which|command\s+-v|type\s+-[pPa])\s+\S*factory-inspect\s*$/.test(String(src || ''));

function inspectNames(src, names) {
  for (const m of src.matchAll(/(?:^|[\s;&|(])(?:export\s+|alias\s+|local\s+|readonly\s+|declare\s+(?:-\w+\s+)?)?([A-Za-z_]\w*)=("[^"]*"|'[^']*'|\$\([^)]*\)|`[^`]*`|[^\s;&|)]*)/g)) {
    const v = m[2].replace(/^["']|["']$/g, '');
    if (isInspectPath(v) || /(^|\s)(node\s+)?\S*factory-inspect(\s|$)/.test(v) || isLookup(v.replace(/^\$\(|\)$|^`|`$/g, ''))) names.add(m[1]);
  }
  for (const m of src.matchAll(/(?:^|[\s;&|(])(?:function\s+)?([A-Za-z_][\w.-]*)\s*\(\s*\)\s*\{([^}]*)\}|function\s+([A-Za-z_][\w.-]*)\s*\{([^}]*)\}/g)) {
    if (/factory-inspect|inspector[\\/]main/.test(m[2] || m[4])) names.add(m[1] || m[3]);
  }
}

function skip(words, i, valued) {
  while (i < words.length) {
    const t = words[i].text;
    if (t === '--') return i + 1;
    if (/^[A-Za-z_]\w*=/.test(t) && !words[i].quoted) {
      i += 1;
      continue;
    }
    if (!t.startsWith('-') || t === '-') return i;
    i += valued.includes(t) ? 2 : 1;
  }
  return i;
}

// The command a simple command runs, past assignments and wrappers.
function head(words) {
  let i = skip(words, 0, []);
  let xargs = -1;
  for (let n = 0; n < 12 && i < words.length; n++) {
    const b = words[i].text.split(/[\\/]/).pop();
    if (b === 'command' && /^-[vV]/.test((words[i + 1] || {}).text || '')) return null;
    if (WRAPPERS[b]) {
      i = skip(words, i + 1, WRAPPERS[b]);
      if (b === 'timeout') i += 1;
      continue;
    }
    if (b === 'xargs' || b === 'parallel') {
      xargs = i;
      i = skip(words, i + 1, [...XARGS_VALUED]);
      continue;
    }
    return { name: b, word: words[i], args: words.slice(i + 1), xargs };
  }
  return null;
}

function inspectCall(h, names) {
  const t = h.word.text;
  const v = varName(t);
  const sub = h.word.subs.length === 1 && /^\$\(|^`/.test(t) ? h.word.subs[0] : null;
  if (isInspectPath(t) || (v && names.has(v)) || names.has(t) || (sub && isLookup(sub))) return h.args;
  if (/^(node|nodejs)(\.exe)?$/.test(h.name)) {
    const a = h.args.find((x) => !x.text.startsWith('-'));
    if (a && (isInspectPath(a.text) || (varName(a.text) && names.has(varName(a.text))))) return h.args.slice(h.args.indexOf(a) + 1);
  }
  return null;
}

function firstWord(args) {
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (t === '--') return args[i + 1] ? args[i + 1].text : null;
    if (t.startsWith('--')) {
      if (!t.includes('=') && ['--root', '--job', '--reason', '--status', '--format', '--to'].includes(t)) i += 1;
      continue;
    }
    return t;
  }
  return null;
}

function upstream(cmd, pipeline) {
  const parts = cmd.heredocs.map((h) => h.body);
  for (let j = pipeline.indexOf(cmd) - 1; j >= 0 && pipeline[j].pipeOut; j--) {
    parts.push(...pipeline[j].heredocs.map((h) => h.body));
    const h = head(pipeline[j].words);
    if (h && ['echo', 'printf', 'cat'].includes(h.name)) parts.push(h.args.map((a) => a.text).join(' '));
  }
  return parts.join('\n');
}

function writes(h, cmd) {
  const out = [];
  for (const r of cmd.redirs) {
    if (!r.target || !['>', '>>', '>|', '&>', '&>>', '<>', '>&'].includes(r.op)) continue;
    if (/^&|^\/dev\//.test(r.target.text)) continue;
    out.push(r.target.text);
  }
  if (!h) return out;
  const plain = h.args.filter((a) => !a.text.startsWith('-')).map((a) => a.text);
  if (h.name === 'tee' || ['rm', 'mv', 'truncate', 'touch', 'unlink', 'shred'].includes(h.name)) out.push(...plain);
  if (['cp', 'install', 'ln', 'rsync'].includes(h.name) && plain.length) out.push(plain[plain.length - 1]);
  if (h.name === 'sed' && h.args.some((a) => /^(-i|--in-place)|^-[a-zA-Z]*i/.test(a.text))) out.push(...plain.slice(1));
  if (h.name === 'perl' && h.args.some((a) => /^-[a-zA-Z]*i/.test(a.text))) out.push(...plain);
  return out;
}

const MSG_HUMAN = (w) => `"factory-inspect ${w}" is yours: reply in chat (e.g. "ack finding F3", "inspect mode bug@low sample 10") or run it in your terminal.`;
const MSG_AGENT = 'Factory agents run no inspections; the inspector belongs to the main session.';

function walk(src, opts, names, depth) {
  if (depth > 6) return null;
  inspectNames(src, names);
  const cmds = parse(src);
  const pipelines = [];
  for (const c of cmds) {
    if (c.pipeIn && pipelines.length) pipelines[pipelines.length - 1].push(c);
    else pipelines.push([c]);
  }
  for (const pipeline of pipelines) {
    for (const cmd of pipeline) {
      for (const s of cmd.subs) {
        const why = walk(s, opts, names, depth + 1);
        if (why) return why;
      }
      const h = head(cmd.words);
      if (h) {
        if (h.name === 'eval') {
          const why = walk(h.args.map((a) => a.text).join(' '), opts, names, depth + 1);
          if (why) return why;
        }
        if (SHELLS.test(h.name) || ['script', 'su', 'watch'].includes(h.name)) {
          const c = h.args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$|^-Command$/i.test(a.text));
          const code = c !== -1 && h.args[c + 1] ? h.args[c + 1].text : !h.args.some((a) => !a.text.startsWith('-')) ? upstream(cmd, pipeline) : '';
          const why = code && walk(code, opts, names, depth + 1);
          if (why) return why;
        }
        const args = inspectCall(h, names);
        if (args) {
          let w = firstWord(args);
          if (!w && h.xargs !== -1) {
            const fed = `${upstream(cmd, pipeline)} ${cmd.words.slice(h.xargs).map((x) => x.text).join(' ')}`.split(/[\s'"]+/);
            w = fed.find((x) => HUMAN.has(x) || (opts.agent && AGENT_DENIED.has(x))) || null;
          }
          if (w && HUMAN.has(w)) return MSG_HUMAN(w);
          if (opts.agent && w && AGENT_DENIED.has(w)) return MSG_AGENT;
        }
      }
      for (const t of writes(h, cmd)) if (INSPECT_DIR.test(t)) return 'The inspection register and config are written only by factory-inspect.';
      // inline scripts writing the register
      if (h && /^(node|nodejs|python[0-9.]*|ruby|perl)$/.test(h.name)) {
        const code = h.args.map((a) => a.text).join(' ') + upstream(cmd, pipeline);
        if (INSPECT_DIR.test(code) && /writeFile|appendFile|open\([^)]*['"][wa]|unlink|rmSync|rename/.test(code)) return 'The inspection register and config are written only by factory-inspect.';
      }
    }
  }
  return null;
}

function check(command, opts = {}) {
  try {
    return walk(String(command || ''), opts, new Set(), 0);
  } catch {
    return null; // a command we can't read is allowed
  }
}

module.exports = { check };
