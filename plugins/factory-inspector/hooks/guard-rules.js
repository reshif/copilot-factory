'use strict';
// Agents may run inspections and read reports, but marking findings and changing
// inspection modes are yours — also when reached through a variable, alias, `$(…)`, eval
// or xargs (conservative: a command that names factory-inspect, uses any indirection and
// contains mark/mode is denied). An agent `factory run` started (opts.agent) runs no
// inspections at all: the inspector is the main session's.

const INDIRECTION = /\$|`|\beval\b|\bxargs\b|\balias\b|\bsource\b|\bparallel\b|\s-exec(?:dir)?\b|\(\)\s*\{|\bfunction\s+\w|<<<|\bexec\b|\bbash\b|\bsh\b|\bzsh\b/;
const AGENT_DENIED = new Set(['run', 'mark', 'mode', 'health']);

function isInspectPath(x) {
  return x === 'factory-inspect' || /\/factory-inspect$/.test(x) || /inspector\/main(\.js)?$/.test(x);
}

function inspectNames(s) {
  const names = new Set();
  for (const m of s.matchAll(/(?:^|[\s;&|(])(?:export\s+|alias\s+|local\s+|declare\s+(?:-\w+\s+)?)?([A-Za-z_]\w*)=(\S*)/g)) if (/factory-inspect|inspector\/main/.test(m[2])) names.add(m[1]);
  for (const m of s.matchAll(/(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{([^}]*)/g)) if (/factory-inspect|inspector\/main/.test(m[2])) names.add(m[1]);
  return names;
}

function check(command, opts = {}) {
  const s = String(command || '').replace(/\\(.)/g, '$1').replace(/["']/g, '');
  const names = inspectNames(s);
  const mentions = names.size > 0 || /factory-inspect|inspector\/main/.test(s);
  if (mentions && INDIRECTION.test(s)) {
    const words = s.split(/[\s|;&()`$<>{}]+/).filter(Boolean);
    const w = words.find((x) => x === 'mark' || x === 'mode' || (opts.agent && AGENT_DENIED.has(x)));
    if (w) return w === 'mark' || w === 'mode' ? `"factory-inspect ${w}" is yours: reply in chat (e.g. "ack finding F3", "inspect mode bug@low sample 10") or run it in your terminal.` : 'Factory agents run no inspections; the inspector belongs to the main session.';
  }
  for (const seg of s.split(/[|;&\n]+|\$\(|`|\)/)) {
    const t = seg.trim().split(/\s+/).filter(Boolean);
    if (/^\$/.test(t[0] || '') && /\b(mark|mode)\b/.test(seg)) return 'Run factory-inspect by name.';
    const at = t.findIndex((x) => isInspectPath(x) || names.has(x) || ((x.match(/^\$\{?(\w+)\}?$/) || [])[1] && names.has(x.match(/^\$\{?(\w+)\}?$/)[1])));
    if (at === -1) continue;
    const words = [];
    for (let i = at + 1; i < t.length && words.length < 1; i++) {
      if (t[i] === '--') continue;
      if (t[i].startsWith('--')) {
        if (!t[i].includes('=') && ['--root', '--job', '--reason', '--status', '--format'].includes(t[i])) i += 1;
        continue;
      }
      words.push(t[i]);
    }
    if (['mark', 'mode'].includes(words[0])) return `"factory-inspect ${words[0]}" is yours: reply in chat (e.g. "ack finding F3", "inspect mode bug@low sample 10") or run it in your terminal.`;
    if (opts.agent && AGENT_DENIED.has(words[0])) return 'Factory agents run no inspections; the inspector belongs to the main session.';
  }
  if (/\.factory\/inspect\//.test(s) && /(>|tee\s|\brm\s|\bmv\s|\bcp\s|sed\s+-i|writeFile|open\()/.test(s)) return 'The inspection register and config are written only by factory-inspect.';
  return null;
}

module.exports = { check };
