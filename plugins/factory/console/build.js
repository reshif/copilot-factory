#!/usr/bin/env node
'use strict';
// Builds console/console.html, the one self-contained page `factory console` fills with data,
// from the modules in console/src/. The page stays a single file: one <style>, one <script>,
// no external scripts, exactly one data slot.
//
//   node console/build.js           write console.html
//   node console/build.js --check   fail if console.html is not what the sources build
//
// src/manifest.json lists the order: styles are joined into the <style> tag, scripts into the
// <script> tag. Scripts share one scope (classic script, no modules), so order matters: a file
// may use what an earlier file declares. Add a file to the manifest, not to index.html.
// The agents' tool lists are read from agents/*.agent.md at build time (AGENT_TOOLS), so an
// agent file change makes console.html stale too.

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const SRC = path.join(HERE, 'src');
const OUT = path.join(HERE, 'console.html');
const AGENTS_DIR = path.join(HERE, '..', 'agents');

// Each agent's Copilot tools, from the `tools:` line of its agents/<name>.agent.md frontmatter
// (the same line runner.js reads). The Crew and the recipe map show these, never a copy.
function agentTools(dir = AGENTS_DIR) {
  const out = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.agent.md')).sort()) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const line = fm && /^tools:\s*(.+)$/m.exec(fm[1]);
    if (!line) throw new Error(`${f} has no tools: line in its frontmatter`);
    let tools;
    try { tools = JSON.parse(line[1].trim()); } catch { tools = line[1].replace(/[[\]"']/g, '').split(',').map((t) => t.trim()).filter(Boolean); }
    if (!Array.isArray(tools)) throw new Error(`${f}: tools must be a list`);
    out[f.replace(/\.agent\.md$/, '')] = tools.map(String);
  }
  return out;
}

function build() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  const read = (f) => {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    if (!text.endsWith('\n')) throw new Error(`${f} must end with a newline`);
    return text;
  };
  const shell = read('index.html');
  for (const slot of ['/*@styles*/', '/*@scripts*/']) {
    if (shell.split(slot).length !== 2) throw new Error(`index.html needs exactly one ${slot}`);
  }
  const css = manifest.styles.map(read).join('');
  let js = manifest.scripts.map(read).join('');
  if (js.split('/*@agent-tools*/{}').length !== 2) throw new Error('the scripts need exactly one /*@agent-tools*/{} slot');
  js = js.replace('/*@agent-tools*/{}', () => JSON.stringify(agentTools()));
  if (/<\/style/i.test(css)) throw new Error('a stylesheet contains </style');
  if (/<\/script/i.test(js)) throw new Error('a script contains </script');
  const html = shell.replace('/*@styles*/', () => css).replace('/*@scripts*/', () => js);
  if (html.split('/*__FACTORY_DATA__*/null').length !== 2) throw new Error('the page needs exactly one data slot');
  return html;
}

if (require.main === module) {
  const html = build();
  if (process.argv.includes('--check')) {
    const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (now !== html) {
      process.stderr.write('console/console.html is stale: run node console/build.js\n');
      process.exit(1);
    }
    process.stdout.write('console/console.html is current\n');
  } else {
    fs.writeFileSync(OUT, html);
    process.stdout.write(`wrote ${path.relative(process.cwd(), OUT)} (${Buffer.byteLength(html)} bytes)\n`);
  }
}

module.exports = { build, agentTools };
