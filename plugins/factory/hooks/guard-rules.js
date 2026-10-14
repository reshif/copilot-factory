'use strict';
// Rules for the PreToolUse guard (guard.js runs them). Denies, for every agent and the main session:
//   - edits to factory state, recipes, floors, policy and plugin code
//   - edits outside a task's allowed paths inside its worktree
//   - writes to protected paths (policy.protected_paths) and reads of secrets (real path checked),
//     through Read, Grep (path and its glob filter), Glob (where it searches) and NotebookRead
//   - force-push in any spelling, --no-verify / commit -n, hook-path redirects, .git/hooks and .git/config edits
//   - moving a job branch by hand, secret reads through git objects
//   - human-only factory commands (approve, deny, resume, cancel, abandon, waive, merged, confirm, lessons accept|reject|promote, ci install)
// Prose inside --reason/--text/--question/--answer/-m and quoted heredocs is data, not a command.

const path = require('path');
const { emit, findRoot, realpath } = require('./lib');

const JOB_DOCS = /^(contract\.md|threat-model\.md|no-adr\.md|recommendation\.md|adr-\d+[^/]*\.md|contracts\.md|contracts\.json|plan\.json|slices\.json)$/;

function deny(reason) {
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[factory guard] ${reason}` } });
}

function loadPolicy(root) {
  try {
    return require('../cli/core/policy').load(root);
  } catch {
    return require('../cli/core/policy').defaults();
  }
}

function rel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

function taskScope(root, worktreeName) {
  const m = worktreeName.match(/^(J-\d+)(?:-(T\d+))?$/);
  if (!m) return null;
  const { readJson } = require('../cli/lib/util');
  const plan = readJson(path.join(root, '.factory', 'jobs', m[1], 'plan.json'), null);
  if (!plan || !plan.tasks) return { paths: [], job: m[1], task: m[2] || null };
  if (m[2]) {
    const t = plan.tasks.find((x) => x.id === m[2]);
    return { paths: t ? t.allowed_paths : [], job: m[1], task: m[2] };
  }
  return { paths: plan.tasks.flatMap((t) => t.allowed_paths || []), job: m[1], task: null };
}

// Returns a deny reason or null.
function checkWrite(root, absIn, policy) {
  const { matchesAny } = require('../cli/lib/glob');
  const { PLUGIN_ROOT } = require('../cli/lib/paths');
  const abs = realpath(absIn);
  const pluginRoot = realpath(PLUGIN_ROOT);
  if (abs.startsWith(pluginRoot + path.sep) && /[\\/](recipes|policy|cli|hooks|config|schemas|workflows|agents|skills|bin)[\\/]/.test(abs.slice(pluginRoot.length))) {
    return 'The factory plugin itself (recipes, floors, policy, CLI, hooks, workflows, agents, skills) is edited by you, not by agents.';
  }
  if (!root) return null;
  const r = rel(root, abs);
  if (r.startsWith('..')) return null;
  if (matchesAny(r, policy.secret_paths)) return `${r} looks like a secret; agents may not write it.`;
  if (r.startsWith('.factory/')) {
    const parts = r.split('/');
    if (parts[1] === 'scratch') return null;
    if (parts[1] === 'jobs' && parts.length === 4 && JOB_DOCS.test(parts[3])) return null;
    if (parts[1] === 'worktrees' && parts.length >= 4) {
      const scope = taskScope(root, parts[2]);
      const inner = parts.slice(3).join('/');
      if (!scope) return `Unknown worktree ${parts[2]}.`;
      if (inner.startsWith('.git/') || inner === '.git') return 'Editing git internals in a worktree is not allowed.';
      if (matchesAny(inner, policy.protected_paths)) return `${inner} is a protected path.`;
      if (!matchesAny(inner, scope.paths)) return `${inner} is outside ${scope.task ? `${scope.task}'s` : `${scope.job}'s`} allowed paths (${scope.paths.join(', ') || 'none'}). Return status "blocked" with needs_paths instead.`;
      return null;
    }
    return `${r} is factory state. Only the factory CLI writes it.`;
  }
  if (r.startsWith('.git/') || r === '.git') return 'Editing git internals is not allowed.';
  if (matchesAny(r, policy.protected_paths)) return `${r} is a protected path (policy.protected_paths).`;
  return null;
}

function checkRead(root, absIn, policy) {
  const { matchesAny } = require('../cli/lib/glob');
  const abs = realpath(absIn);
  if (abs === realpath(require('../cli/lib/seal').secretFile())) return 'The factory seal secret is off limits.';
  const base = root || path.dirname(abs);
  const r = rel(base, abs);
  const name = path.basename(abs);
  if (matchesAny(r, policy.secret_paths) || matchesAny(name, policy.secret_paths.map((g) => g.replace(/^\*\*\//, '')))) {
    if (/\.example$|\.sample$|\.template$/.test(name)) return null;
    return `${name} looks like a secret; reading it is blocked.`;
  }
  return null;
}

// Tools that read or list files. Glob only lists names, so its pattern is free; where it
// searches (path) gets the same checks as a Read. WebFetch/WebSearch reach URLs, not files.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);

function checkReadTool(root, tool, ti, absFile, cwd, policy) {
  const { secretFile } = require('../cli/lib/seal');
  const secret = realpath(secretFile());
  const target = absFile || (tool !== 'Read' ? path.resolve(cwd || process.cwd()) : null);
  if (!target) return null;
  const real = realpath(target);
  // The secret itself, or the folder that holds it (a recursive Grep there prints it).
  if (real === secret || (tool !== 'Read' && tool !== 'NotebookRead' && real === path.dirname(secret))) return 'The factory seal secret is off limits.';
  if (!root) return null;
  if (absFile) {
    const why = checkRead(root, absFile, policy);
    if (why) return why;
  }
  // Grep's glob filter picks the files whose contents it prints.
  if (tool === 'Grep' && typeof ti.glob === 'string' && ti.glob) {
    const { matches } = require('../cli/lib/glob');
    // A filter aimed at secret-looking names (".env", "*.pem"), not a catch-all like "*".
    const samples = policy.secret_paths.map((x) => x.replace(/^\*\*\//, '').replace(/\*/g, 'x'));
    for (const g of ti.glob.replace(/^\{|\}$/g, '').split(',')) {
      const name = path.basename(g.trim());
      if (!name || !/[^*.?]/.test(name) || /\.example$|\.sample$|\.template$/.test(name)) continue;
      if (samples.some((x) => matches(x, name))) return `Grep over ${name} files would print secrets; blocked.`;
    }
  }
  return null;
}

function stripData(cmd) {
  let s = String(cmd || '');
  // Quoted heredocs are data.
  s = s.replace(/<<-?\s*(['"])(\w+)\1[\s\S]*?\n\s*\2\b/g, '<<DATA');
  // Prose arguments are data in a plain factory/git command.
  s = s.replace(/(--(?:reason|text|question|answer|title|note|by)|\s-m)\s+("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g, '$1 _');
  return s;
}

function normalise(cmd) {
  // Read commands the way the shell would: drop quotes and backslash escapes around words.
  return stripData(cmd).replace(/\\(.)/g, '$1').replace(/["']/g, '');
}

const HUMAN_ONLY = new Set(['approve', 'deny', 'resume', 'cancel', 'abandon', 'waive', 'merged', 'confirm', 'reseal']);
const VALUE_FLAGS = new Set(['--root', '--job', '--reason', '--text', '--scope', '--question', '--answer', '--title', '--note', '--by', '--type', '--risk', '--config', '--mode', '--scope', '--lanes', '--out', '--file', '--since', '--format', '--commit', '--manifest-dir', '--path', '--check', '--base', '--step', '--findings-file']);
const TTY_FAKERS = /^(script|unbuffer|expect|socat|faketty|ptyexec|zpty|empty)$/;
const INTERPRETER = /(^|[\s;&|(])(node|nodejs|python[0-9.]*|ruby|perl|php|deno|bun|osascript|tclsh)\b/;
const INTERNALS = /\.factory\/(jobs|log|lessons|project\.json|policy\.json|current)|cli\/core\/|cli\/lib\/(seal|util)|software-factory\/secret|\.config\/software-factory/;

// Find a factory invocation in a token list and return its subcommand words, parsing
// options the way the CLI does (--k=v, --k v for value flags, and --).
function factorySubcommand(tokens) {
  const at = tokens.findIndex((t) => t === 'factory' || /\/factory$/.test(t));
  if (at === -1) return null;
  const words = [];
  for (let i = at + 1; i < tokens.length && words.length < 2; i++) {
    const t = tokens[i];
    if (t === '--') continue;
    if (t.startsWith('--')) {
      if (!t.includes('=') && VALUE_FLAGS.has(t)) i += 1;
      continue;
    }
    words.push(t);
  }
  return words;
}

function checkBash(root, cmd, policy) {
  const original = String(cmd || '');
  // Code fed to an interpreter is not data: check the raw text, heredocs included.
  if (INTERPRETER.test(original) && INTERNALS.test(original)) {
    return 'Inline scripts may not reach into factory state or internals. To read a job file use the Read tool; to change one you are allowed to change (an ADR, the plan, a threat model) use Write or Edit; for job state use the factory CLI (factory job show, contract show, why).';
  }
  if (/software-factory\/secret|\.config\/software-factory/.test(original)) return 'The factory seal secret is off limits.';
  const s = normalise(cmd);
  const seg = s.split(/[|;&\n]+|\$\(|`/);
  for (const raw of seg) {
    const c = raw.trim();
    if (!c) continue;
    const tokens = c.split(/\s+/).filter(Boolean);
    if (/^\$/.test(tokens[0])) return 'Run commands by name, not through a variable or expansion.';
    if (TTY_FAKERS.test(tokens[0]) || (tokens[0] === 'sudo' && TTY_FAKERS.test(tokens[1] || ''))) return `${tokens[0]} (terminal emulation) is not allowed here.`;
    if (/\bgit\b/.test(c)) {
      if (/\bpush\b/.test(c) && (/(^|\s)--force(-with-lease)?\b/.test(c) || /(^|\s)-[a-zA-Z]*f[a-zA-Z]*\b/.test(c) || /\s\+[^\s]+/.test(c))) return 'Force-push is not allowed, in any spelling.';
      if (/--no-verify\b/.test(c)) return '--no-verify is not allowed; hooks always run.';
      if (/\bcommit\b/.test(c) && /(^|\s)-[a-zA-Z]*n[a-zA-Z]*\b/.test(c.replace(/\s-m\s+_/, ''))) return 'git commit -n skips hooks; not allowed.';
      if (/core\.hookspath/i.test(c)) return 'Redirecting git hooks is not allowed.';
      if (/\b(show|cat-file)\b/.test(c) && policy.secret_paths.some((g) => c.includes(g.replace(/^\*\*\//, '').replace(/\*/g, '')))) return 'Reading secrets through git objects is blocked.';
      const jobRef = c.match(/\bfactory\/J-\d+\b(?!-T)/);
      if (jobRef && /\b(push|reset|update-ref|rebase|merge|checkout|switch|branch\s+-[fFdD]|branch\s+--force)\b/.test(c)) {
        return `Only the factory CLI moves the job branch (${jobRef[0]}). Builders commit on their task branch; reconcile merges.`;
      }
    }
    if (/\.git\/(hooks|config)\b/.test(c)) return '.git/hooks and .git/config are off limits.';
    const sub = factorySubcommand(tokens);
    if (sub && sub.length) {
      const [a, b] = sub;
      if (HUMAN_ONLY.has(a) || (a === 'lessons' && ['accept', 'reject', 'promote'].includes(b)) || (a === 'ci' && b === 'install')) {
        return `"factory ${a}${b && a !== 'approve' ? ` ${b}` : ''}" is a human-only action. Ask the human to reply in chat (e.g. "approve", "resume") or run it in their own terminal.`;
      }
    }
    // Shell writes into factory state.
    const targets = [];
    for (const mm of c.matchAll(/(?:^|\s)\d?>>?\s*([^\s<>|&;]+)/g)) targets.push(mm[1]);
    for (const mm of c.matchAll(/\btee\s+(?:-a\s+)?([^\s|&;]+)/g)) targets.push(mm[1]);
    const verb = c.match(/^\s*(?:sudo\s+)?(rm|mv|cp|truncate|ln|install|sed\s+-i|perl\s+-pi)\b(.*)$/);
    if (verb) {
      const args = verb[2].trim().split(/\s+/).filter((x) => x && !x.startsWith('-'));
      // cp/install/ln only write their destination; mv and rm also remove their sources.
      if (['cp', 'install', 'ln'].includes(verb[1])) targets.push(args[args.length - 1]);
      else targets.push(...args);
    }
    for (const t of targets) {
      if (!t || t === '/dev/null' || t === '_') continue;
      const abs = path.isAbsolute(t) ? t : path.resolve(root || process.cwd(), t);
      const why = checkWrite(root, abs, policy);
      if (why) return why;
    }
    // Secret reads via shell.
    const readVerb = /^\s*(cat|less|more|head|tail|bat|xxd|od|strings|base64|grep|rg|awk|sed|cp|scp|curl\s+-F|tar|zip)\b/.test(c);
    if (readVerb) {
      for (const tok of tokens.slice(1)) {
        if (!tok || tok.startsWith('-')) continue;
        const abs = path.isAbsolute(tok) ? tok : path.resolve(root || process.cwd(), tok);
        const why = checkRead(root, abs, policy);
        if (why) return why;
      }
    }
  }
  return null;
}

// Files an agent writes may not carry code that reaches into factory internals.
function checkContent(text, file) {
  if (file && !/\.(c?m?js|ts|py|rb|pl|php|sh|bash|zsh)$/.test(file)) return null;
  return INTERNALS.test(String(text || '')) && /require\(|import |from |open\(|readFile|writeFile/.test(String(text || ''))
    ? 'This file would reach into factory state or internals. Use the factory CLI instead.'
    : null;
}

module.exports = { checkWrite, checkRead, checkReadTool, READ_TOOLS, checkBash, checkContent, normalise, deny, loadPolicy, factorySubcommand };
