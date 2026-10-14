'use strict';
// Agents may run inspections and read reports, but marking findings and changing
// inspection modes are yours.

function check(command) {
  const s = String(command || '').replace(/\\(.)/g, '$1').replace(/["']/g, '');
  for (const seg of s.split(/[|;&\n]+|\$\(|`/)) {
    const t = seg.trim().split(/\s+/).filter(Boolean);
    if (/^\$/.test(t[0] || '') && /\b(mark|mode)\b/.test(seg)) return 'Run factory-inspect by name.';
    const at = t.findIndex((x) => x === 'factory-inspect' || /\/factory-inspect$/.test(x) || /inspector\/main(\.js)?$/.test(x));
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
  }
  if (/\.factory\/inspect\//.test(s) && /(>|tee\s|\brm\s|\bmv\s|\bcp\s|sed\s+-i|writeFile|open\()/.test(s)) return 'The inspection register and config are written only by factory-inspect.';
  return null;
}

module.exports = { check };
