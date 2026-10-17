'use strict';
// Rules for the preToolUse guard (guard.js runs them). The guard denies only clear
// violations; anything it can't read with confidence is allowed. For every agent and the
// main session it denies:
//   - edits to factory state, recipes, floors, policy and plugin code
//   - edits outside a task's allowed paths inside its worktree
//   - writes to protected paths (policy.protected_paths) and reads/writes of secrets
//     (policy.secret_paths minus policy.secret_exempt, real path checked), through Read,
//     Grep (path and its glob filter), Glob (where it searches) and NotebookRead
//   - force-push in any spelling, --no-verify / commit -n, hook-path redirects, writes to
//     .git/hooks and .git/config, moving a job branch by hand, secret reads through git objects
//   - human-only factory commands (approve, deny, resume, cancel, abandon, waive, merged,
//     confirm, reseal, lessons accept|reject|promote, ci install)
//   - starting an interactive shell (bash/sh/zsh/… with no command, or -i)
// And for an agent `factory run` started (opts.agent): every factory command its role is not
// briefed to run (AGENT_ALLOWED) — driving the job is the main session's work.
//
// Shell commands are read with hooks/shell.js: a factory call is recognised only where a
// command runs — the command word of a simple command, after env assignments and wrappers
// (env, sudo, exec, nice, timeout, nohup, xargs, …), or inside code that runs (eval,
// bash/sh -c, $( ), backticks, a heredoc or pipe fed to a shell). Words inside quoted
// arguments, grep/rg patterns, echo/printf text, commit messages, gh --body and heredocs fed
// to anything but a shell are data. Indirection (a variable, alias or function set to the
// factory CLI, `$(which factory)`) is followed only when it is used in command position.

const path = require('path');
const { realpath, deny: denyOut } = require('./lib');
const { parse } = require('./shell');

const JOB_DOCS = /^(contract\.md|threat-model\.md|no-adr\.md|recommendation\.md|adr-\d+[^/]*\.md|contracts\.md|contracts\.json|plan\.json|slices\.json|environment\.proposed\.json|environment\.repair\.json)$/;

// Copilot preToolUse deny: the documented flat JSON on stdout, exit 0 (lib.deny).
function deny(reason) {
  denyOut(`[factory guard] ${reason}`);
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

// Template / example files (.env.example, config.sample, .env.dist, …) are never secrets.
const EXEMPT_NAME = /\.(example|sample|template|dist)$/i;

// A path matches policy.secret_paths and not policy.secret_exempt.
function isSecret(r, policy) {
  const { matchesAny } = require('../cli/lib/glob');
  const name = path.posix.basename(r);
  const globs = policy.secret_paths || [];
  const exempt = policy.secret_exempt || [];
  if (EXEMPT_NAME.test(name) || matchesAny(r, exempt) || matchesAny(name, exempt.map((g) => g.replace(/^\*\*\//, '')))) return false;
  return matchesAny(r, globs) || matchesAny(name, globs.map((g) => g.replace(/^\*\*\//, '')));
}

function taskScope(root, worktreeName) {
  const m = worktreeName.match(/^(J-\d+)(?:-(T\d+))?$/);
  if (!m) return null;
  const { readJson } = require('../cli/lib/util');
  const plan = readJson(path.join(root, '.factory', 'jobs', m[1], 'plan.json'), null);
  if (!plan || !plan.tasks) return { paths: [], job: m[1], task: m[2] || null };
  // plus the paths realize granted a task inside the contract (cli/core/tasks.js grant), kept in
  // the job's sealed state
  const st = readJson(path.join(root, '.factory', 'jobs', m[1], 'state.json'), null) || {};
  // exact files ("=path"): a granted name never covers a subtree (review MAJ-4)
  const granted = (id) => (((st.tasks || {})[id] || {}).granted_paths || []).filter((x) => typeof x === 'string').map((x) => `=${x.replace(/^=/, '')}`);
  if (m[2]) {
    const t = plan.tasks.find((x) => x.id === m[2]);
    return { paths: t ? [...(t.allowed_paths || []), ...granted(t.id)] : [], job: m[1], task: m[2] };
  }
  return { paths: plan.tasks.flatMap((t) => [...(t.allowed_paths || []), ...granted(t.id)]), job: m[1], task: null };
}

// What a builder may write or remove in its worktree whatever its allowed paths (012C MJ-3): the
// environment's own directories (the factory's exclude block, the sealed environment's ignore
// list, .factory-venv, node_modules, *.egg-info), anything the repository ignores, and untracked
// build output, caches and logs (build/, dist/, .pytest_cache/, *.log, test-output.txt …). None of
// it is committed by the factory (commitWip unstages new build output), and task verify checks
// the diff against the allowed paths.
const { BUILD_OUTPUT } = require('../cli/lib/paths');
function buildArtifact(root, wtName, inner) {
  if (!inner || inner.startsWith('.git')) return false;
  const wt = path.join(root, '.factory', 'worktrees', wtName);
  const git = (args) => {
    try {
      return require('child_process').spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8', timeout: 5000 });
    } catch {
      return { status: 1, stdout: '' };
    }
  };
  // a tracked file is source, whatever its name
  if (git(['ls-files', '--error-unmatch', '--', inner]).status === 0) return false;
  if (BUILD_OUTPUT.test(inner)) return true;
  // the environment's own patterns (the factory's block, the sealed environment's ignore list)
  try {
    const env = require('../cli/lib/util').readJson(path.join(root, '.factory', 'environment.json'), null) || {};
    const { matchesAny } = require('../cli/lib/glob');
    const pats = (env.ignore || []).map((x) => String(x).replace(/^\//, '').replace(/\/$/, ''));
    if (pats.length && (matchesAny(inner, pats) || matchesAny(inner, pats.map((x) => `${x}/**`)))) return true;
  } catch {
    /* no environment */
  }
  return git(['check-ignore', '-q', '--no-index', '--', inner]).status === 0;
}

// Returns a deny reason or null.
// The task worktree a directory is in (.factory/worktrees/<name>/...), or null.
function ownWorktree(root, dir) {
  if (!root || !dir) return null;
  const r = rel(realpath(root), realpath(dir));
  const m = /^\.factory\/worktrees\/([^/]+)(\/|$)/.exec(r);
  return m ? m[1] : null;
}

// opts.own: the worktree the writing agent works in; another worktree is not its to write.
function checkWrite(root, absIn, policy, opts = {}) {
  const { matchesAny } = require('../cli/lib/glob');
  const { PLUGIN_ROOT } = require('../cli/lib/paths');
  const abs = realpath(absIn);
  if (root) root = realpath(root);
  const pluginRoot = realpath(PLUGIN_ROOT);
  if (abs.startsWith(pluginRoot + path.sep)) {
    const inner = abs.slice(pluginRoot.length);
    if (/[\\/](recipes|policy|cli|hooks|config|schemas|workflows|agents|skills|bin)[\\/]/.test(inner) || /^[\\/](hooks\.json|plugin\.json|package\.json)$/.test(inner)) {
      return 'The factory plugin itself (recipes, floors, policy, CLI, hooks, workflows, agents, skills) is edited by you, not by agents.';
    }
  }
  if (/(^|[\\/])\.git[\\/](hooks|config)([\\/]|$)/.test(abs)) return '.git/hooks and .git/config are off limits.';
  // the hook launchers' plugin-root fallback and their log (cli/lib/hook-health.js): a planted
  // plugin-root would run another "guard" where the host gives no plugin root
  if (/(^|[\\/])\.factory[\\/](plugin-root|node-path|hooks\.log)$/.test(abs)) return '~/.factory/plugin-root, node-path and hooks.log belong to the factory CLI and its hooks.';
  if (!root) return null;
  const r = rel(root, abs);
  if (r.startsWith('..')) return null;
  if (isSecret(r, policy)) return `${r} looks like a secret (policy.secret_paths); it is not written from here. Ask the user to create or change it.`;
  if (r.startsWith('.factory/')) {
    const parts = r.split('/');
    if (parts[1] === 'scratch') return null;
    // Clarify v3: the user may edit contract.md at any time; the CLI re-checks it before H1.
    if (parts[1] === 'jobs' && parts.length === 4 && JOB_DOCS.test(parts[3])) return null;
    if (parts[1] === 'worktrees' && parts.length >= 4) {
      const scope = taskScope(root, parts[2]);
      const inner = parts.slice(3).join('/');
      if (!scope) return `Unknown worktree ${parts[2]}.`;
      if (opts.own && opts.own !== parts[2]) return `${parts[2]} is another task's worktree; you work in ${opts.own} only.`;
      if (inner.startsWith('.git/') || inner === '.git') return 'Editing git internals in a worktree is not allowed.';
      if (matchesAny(inner, policy.protected_paths)) return `${inner} is a protected path.`;
      if (!matchesAny(inner, scope.paths) && !buildArtifact(root, parts[2], inner)) return `${inner} is outside ${scope.task ? `${scope.task}'s` : `${scope.job}'s`} allowed paths (${scope.paths.map((x) => String(x).replace(/^=/, '')).join(', ') || 'none'}). Return status "blocked" with needs_paths instead.`;
      return null;
    }
    return `${r} is factory state. Only the factory CLI writes it.`;
  }
  if (r.startsWith('.git/') || r === '.git') return 'Editing git internals is not allowed.';
  if (matchesAny(r, policy.protected_paths)) return `${r} is a protected path (policy.protected_paths).`;
  return null;
}

function checkRead(root, absIn, policy) {
  const abs = realpath(absIn);
  if (abs === realpath(require('../cli/lib/seal').secretFile())) return 'The factory seal secret is off limits.';
  const base = root || path.dirname(abs);
  const r = rel(base, abs);
  const name = path.basename(abs);
  if (isSecret(r.startsWith('..') ? name : r, policy)) return `${name} looks like a secret (policy.secret_paths); reading it is blocked.`;
  return null;
}

// Tools that read or list files. Glob only lists names, so its pattern is free; where it
// searches (path) gets the same checks as a Read. WebFetch/WebSearch reach URLs, not files.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);

// A Grep glob filter aimed at secrets: the files it typically matches are secrets ("*.pem",
// ".env.*"), or it is a secret name plus a trailing * (".env*", "id_rsa*"). A filter that
// merely can match one ("*.key*" — keyboard.js) is not.
function globAimsAtSecrets(g, policy) {
  const name = path.posix.basename(g.trim());
  if (!name || !/[^*.?]/.test(name) || EXEMPT_NAME.test(name)) return false;
  if (isSecret(name.replace(/\*/g, 'x').replace(/\?/g, 'x'), policy)) return true;
  const stem = name.replace(/\*+$/, '');
  return stem !== name && !/[*?[]/.test(stem) && isSecret(stem, policy);
}

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
    for (const g of ti.glob.replace(/^\{|\}$/g, '').split(',')) {
      if (globAimsAtSecrets(g, policy)) return `Grep over ${path.posix.basename(g.trim())} files would print secrets; blocked.`;
    }
  }
  return null;
}

// ---- factory CLI recognition -------------------------------------------------------------

// the human-only verbs, shared with factory drive (cli/lib/human-verbs.js)
const { HUMAN_ONLY, isHumanOnly, agentFlagRefusal, machineStepInText } = require('../cli/lib/human-verbs');
// Mirrors cli/main.js parseArgs: --k=v, --k v (unless the flag is boolean or v starts with --), and --.
// the CLI's own boolean-flag list (cli/lib/args.js): the guard reads a command exactly as the CLI parses it
const CLI_BOOL = require('../cli/lib/args').BOOL;
const TTY_FAKERS = /^(script|unbuffer|expect|socat|faketty|ptyexec|zpty|empty)$/;
const SHELLS = /^(bash|sh|zsh|dash|ksh|mksh|fish|csh|tcsh|ash|busybox)$/;
const PWSH = /^(pwsh|powershell|powershell\.exe|pwsh\.exe)$/i;
const INTERPRETER = /^(node|nodejs|python[0-9.]*|ruby|perl|php|deno|bun|osascript|tclsh)$/;
// Factory state and CLI internals. STRICT: code that loads the CLI's internals or the seal
// secret could forge state, whatever it does. STATE: the job files; reading them is fine.
const INTERNALS_STRICT = /cli\/core\/|cli\/lib\/(seal|util)|software-factory\/secret|\.config\/software-factory/;
const STATE = /\.factory\/(jobs|log|lessons|project\.json|project\.md|project-brief\.proposals\.json|cache\/|envcache|wheelhouse|policy\.json|environment\.json|current|plugin-root|node-path|hooks\.log)/;
const INTERNALS = new RegExp(`${INTERNALS_STRICT.source}|${STATE.source}`);
const WRITE_OPS = /writeFile|appendFile|createWriteStream|\bunlink|\brename|\brmSync|\brmdir|\bcopyFile|truncate|\.write\(|open\([^)]*['"][wax+]|json\.dump\(|os\.remove|os\.replace|shutil\.|Path\([^)]*\)\.write_|File\.write|>>?\s*['"]?\.factory/;
const SECRET_FILE = /software-factory[\\/]secret|\.config[\\/]software-factory/;
// Variables that hold well-known locations, never the factory CLI.
const KNOWN_VARS = /^(HOME|PWD|OLDPWD|PATH|TMPDIR|TMP|TEMP|USER|SHELL|VIRTUAL_ENV|CONDA_PREFIX|PYENV_ROOT|NVM_DIR|GOPATH|GOROOT|CARGO_HOME|JAVA_HOME|ANDROID_HOME|XDG_\w+|CI|GITHUB_\w+|RUNNER_\w+|npm_\w+|env:\w+)$/;

// Factory CLI commands an agent `factory run` started may run: read-only ones, and the ones a
// brief tells a role to run — wfargs.js: plan validate (planner, slicer), task start / show
// (builder), task verify (tester), reconcile run / continue / abort (integrator), doc check
// (architect, threat modeler, slicer, planner); agent bodies: doc template; lesson-writer:
// lessons add. Everything else drives the job (next, run, record, wfargs, ship, close, init,
// use, job new, amend, park, followup, epic, distill, finalize, answer, clarify reply/redirect, verify run, evidence,
// ci, pr, shim, console …) or is the human's (HUMAN_ONLY): the main session's or yours.
const AGENT_ALLOWED = {
  help: '*',
  why: '*',
  report: '*',
  job: ['show', 'list'],
  contract: ['show', 'check'],
  intent: ['show'],
  clarify: ['status'],
  env: ['show', 'check', 'status'],
  deps: ['show', 'check'],
  plan: ['validate'],
  task: ['start', 'show', 'verify'],
  reconcile: ['run', 'continue', 'abort'],
  doc: ['list', 'template', 'check', 'index'],
  lessons: ['list', 'add'],
  recipe: ['list', 'show', 'check', 'select'],
  telemetry: ['report'],
};

// Every top-level factory command (cli/main.js): an agent is refused only a real command.
const CLI_VERBS = new Set(['help', 'init', 'doctor', 'shim', 'run', 'console', 'job', 'use', 'next', 'why', 'finalize', 'contract', 'intent', 'clarify', 'env', 'deps', 'answer', 'wfargs', 'record', 'plan', 'task', 'reconcile', 'verify', 'evidence', 'report', 'ship', 'pr', 'ci', 'close', 'followup', 'doc', 'distill', 'lessons', 'amend', 'park', 'epic', 'telemetry', 'recipe', 'drive', 'inbox', ...HUMAN_ONLY]);

function agentAllowed(a, b) {
  if (!a || !CLI_VERBS.has(a)) return true;
  const ok = AGENT_ALLOWED[a];
  return ok === '*' || (Array.isArray(ok) && ok.includes(b));
}

function humanMessage(a, b) {
  return `"factory ${a}${b && a !== 'approve' && !HUMAN_ONLY.has(a) ? ` ${b}` : ''}" is a human-only action. Ask the human to reply in chat (e.g. "approve", "resume") or run it in their own terminal.`;
}

function agentMessage(a, b) {
  return `"factory ${a}${b ? ` ${b}` : ''}" is not for a factory agent: driving the job (next, run, record, ship, close, …) is the main session's work, and approvals are the human's. Run only the factory commands your brief gives you, and return your result as your final JSON message.`;
}

// A path or word that runs the factory CLI: `factory` (a shim on PATH), …/bin/factory, or the
// CLI entry point itself.
function isFactoryPath(t) {
  const s = String(t || '');
  return s === 'factory' || s === 'factory.cmd' || /[\\/]bin[\\/]factory(\.cmd)?$/.test(s) || /[\\/]factory$/.test(s) || /(^|[\\/])factory[\\/]cli[\\/]main(\.js)?$/.test(s);
}

// A command substitution that only looks the CLI up: $(which factory), $(command -v factory).
function isLookupSub(src) {
  return /^\s*(which|command\s+-v|command\s+-V|type\s+-[pPa]|whence|whereis|readlink\s+-f\s+\$\(which)\s+\S*factory\b[^;&|]*$/.test(String(src || '')) || isFactoryPath(String(src || '').trim().replace(/^echo\s+/, '').replace(/^["']|["']$/g, ''));
}

function basename(t) {
  return String(t || '').split(/[\\/]/).pop();
}

const varName = (t) => {
  const m = String(t || '').match(/^\$\{?([A-Za-z_]\w*|env:\w+)\}?$/);
  return m ? m[1] : null;
};

// ---- analysis ----------------------------------------------------------------------------

// Names (variables, aliases, functions) that hold or wrap the factory CLI, and variable values.
function collectNames(src, ctx) {
  const scan = (text) => {
    // name=value assignments (also export/local/readonly/declare/alias) and PowerShell $x = "…"
    for (const m of text.matchAll(/(?:^|[\s;&|(])(?:export\s+|alias\s+|local\s+|readonly\s+|declare\s+(?:-\w+\s+)?|set\s+)?([A-Za-z_]\w*)=("[^"]*"|'[^']*'|\$\([^)]*\)|`[^`]*`|[^\s;&|)]*)/g)) {
      const raw = m[2];
      const v = raw.replace(/^["']|["']$/g, '');
      ctx.vars.set(m[1], v);
      const sub = (v.match(/^\$\((.*)\)$/) || v.match(/^`(.*)`$/) || [])[1];
      if (isFactoryPath(v) || (sub && isLookupSub(sub)) || /(^|\s)(node(js)?\s+)?\S*[\\/]bin[\\/]factory(\s|$)/.test(v) || /^factory(\s|$)/.test(v) || (varName(v) && ctx.names.has(varName(v)))) ctx.names.add(m[1]);
    }
    for (const m of text.matchAll(/\$([A-Za-z_]\w*)\s*=\s*("[^"]*"|'[^']*'|[^\s;&|)]+)/g)) {
      if (isFactoryPath(m[2].replace(/^["']|["']$/g, ''))) ctx.names.add(m[1]);
    }
    // functions whose body runs the factory CLI
    for (const m of text.matchAll(/(?:^|[\s;&|(])(?:function\s+)?([A-Za-z_][\w.-]*)\s*\(\s*\)\s*\{([^}]*)\}|function\s+([A-Za-z_][\w.-]*)\s*\{([^}]*)\}/g)) {
      const name = m[1] || m[3];
      const body = m[2] || m[4];
      const inner = { ...ctx, names: new Set(ctx.names), vars: new Map(ctx.vars), found: [] };
      walk(body, inner, 1, true);
      if (inner.found.length) ctx.names.add(name);
    }
  };
  scan(src);
}

// Words of a command after a wrapper's options. `valued`: options that take a value.
function skipOptions(words, i, valued, stopAtAssign = false) {
  while (i < words.length) {
    const t = words[i].text;
    if (t === '--') return i + 1;
    if (stopAtAssign && /^[A-Za-z_]\w*=/.test(t)) {
      i += 1;
      continue;
    }
    if (!t.startsWith('-') || t === '-') return i;
    if (valued.has(t)) i += 2;
    else i += 1;
  }
  return i;
}

// The command a simple command really runs, past assignments, reserved words and wrappers.
// Returns { name, word, args, i, xargs, lookup } or null.
function resolveHead(words, ctx) {
  let i = 0;
  let xargs = null;
  for (let guard = 0; guard < 20 && i < words.length; guard++) {
    const w = words[i];
    const t = w.text;
    if (!w.quoted && /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(t)) {
      i += 1;
      continue;
    }
    if (!w.quoted && ['{', '}', '!', 'then', 'else', 'elif', 'do', 'if', 'while', 'until', 'time', 'coproc'].includes(t)) {
      i += 1;
      if (t === 'time') i = skipOptions(words, i, new Set(['-f', '-o']));
      continue;
    }
    const b = basename(t);
    if (b === 'env') {
      i = skipOptions(words, i + 1, new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']), true);
      continue;
    }
    if (b === 'sudo' || b === 'doas') {
      i = skipOptions(words, i + 1, new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--chdir']));
      continue;
    }
    if (b === 'exec') {
      i = skipOptions(words, i + 1, new Set(['-a']));
      continue;
    }
    if (b === 'command' || b === 'builtin') {
      const nx = words[i + 1] && words[i + 1].text;
      if (b === 'command' && /^-[a-zA-Z]*[vV]/.test(nx || '')) return { name: 'command', word: w, args: words.slice(i + 1), i, xargs, lookup: true };
      i = skipOptions(words, i + 1, new Set());
      continue;
    }
    if (b === 'nice') {
      i = skipOptions(words, i + 1, new Set(['-n', '--adjustment']));
      continue;
    }
    if (['nohup', 'setsid', 'stdbuf', 'ionice', 'chronic', 'caffeinate', 'unshare', 'flock', 'npx', 'pnpx', 'bunx'].includes(b)) {
      if (b === 'npx' && words[i + 1] && !isFactoryPath(words[i + 1].text) && !/^-/.test(words[i + 1].text)) return { name: b, word: w, args: words.slice(i + 1), i, xargs };
      i = skipOptions(words, i + 1, new Set(['-c', '-n', '-p', '-i', '-o', '-e', '-w']));
      continue;
    }
    if (b === 'timeout') {
      i = skipOptions(words, i + 1, new Set(['-s', '--signal', '-k', '--kill-after']));
      i += 1; // the duration
      continue;
    }
    if (b === 'xargs' || b === 'parallel') {
      xargs = { name: b, at: i };
      i = skipOptions(words, i + 1, new Set(['-I', '-i', '-L', '-l', '-n', '-P', '-s', '-E', '-e', '-d', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--replace', '-j', '--jobs']));
      continue;
    }
    return { name: b, word: w, args: words.slice(i + 1), i, xargs };
  }
  return null;
}

// Subcommand words after the CLI path, parsed like cli/main.js.
function subcommand(args, ctx) {
  const words = [];
  for (let i = 0; i < args.length && words.length < 2; i++) {
    let t = args[i].text;
    const v = varName(t);
    if (v && ctx.vars.has(v)) t = ctx.vars.get(v);
    if (t === '--') {
      for (const x of args.slice(i + 1)) if (words.length < 2) words.push(x.text);
      break;
    }
    if (t.startsWith('--')) {
      if (!t.includes('=') && !CLI_BOOL.has(t.slice(2)) && args[i + 1] && !args[i + 1].text.startsWith('--')) i += 1;
      continue;
    }
    words.push(t);
  }
  return words;
}

// Is this command a factory CLI call? Returns { args } (the words after the CLI) or null.
function factoryCall(head, ctx) {
  const t = head.word.text;
  const v = varName(t);
  const sub = head.word.subs.length === 1 && /^\$\(|^`/.test(t) ? head.word.subs[0] : null;
  if (isFactoryPath(t) || (v && ctx.names.has(v)) || ctx.names.has(t) || (sub !== null && isLookupSub(sub))) return { args: head.args, how: v || ctx.names.has(t) || sub !== null ? 'indirect' : 'direct' };
  if (/^(node|nodejs)(\.exe)?$/i.test(head.name)) {
    const i = skipOptions(head.args, 0, new Set(['-r', '--require', '--import', '--loader', '--env-file', '--conditions', '-C', '--input-type']));
    const a = head.args[i];
    if (!a) return null;
    const av = varName(a.text);
    const asub = a.subs.length === 1 && /^\$\(|^`/.test(a.text) ? a.subs[0] : null;
    if (isFactoryPath(a.text) || (av && ctx.names.has(av)) || (asub !== null && isLookupSub(asub))) return { args: head.args.slice(i + 1), how: av || asub !== null ? 'indirect' : 'direct' };
  }
  return null;
}

// The first subcommand word, when it is built at run time: 'sub' for a command substitution
// ($(…), `…`), 'var' for a variable the guard can't resolve; null when it is written out.
function hiddenVerb(args, ctx) {
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    const t = w.text;
    if (t === '--') return null;
    if (t.startsWith('--')) {
      if (!t.includes('=') && !CLI_BOOL.has(t.slice(2)) && args[i + 1] && !args[i + 1].text.startsWith('--')) i += 1;
      continue;
    }
    if ((w.subs && w.subs.length) || /\$\(|`/.test(t)) return 'sub';
    const v = varName(t);
    if (v && !ctx.vars.has(v)) return 'var';
    if (/\$\{?[A-Za-z_]/.test(t)) return 'var';
    return null;
  }
  return null;
}

// The script file a command runs: `sh|bash|zsh … <file>` (no -c), `source <file>`, `. <file>`, or
// a path run directly (./x.sh, scripts/x). null when it is none of these.
function scriptFile(head, ctx) {
  const n = head.name;
  const fs = require('fs');
  const at = (t) => (t ? path.resolve(ctx.cwd || ctx.root || '.', t) : null);
  if (SHELLS.test(n) && n !== 'busybox') {
    const args = head.args.map((a) => a.text);
    if (args.some((t) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(t))) return null;
    const f = args.find((t) => !t.startsWith('-') && !t.startsWith('+'));
    return f ? at(f) : null;
  }
  if ((n === 'source' || n === '.') && head.args[0]) return at(head.args[0].text);
  // a path run directly: only a shell script (.sh, or a shell #! line), never a program
  const t = head.word.text;
  if (/[\\/]/.test(t) && !isFactoryPath(t)) {
    try {
      const f = at(t);
      if (!fs.statSync(f).isFile()) return null;
      if (/\.(sh|bash|zsh|ksh)$/.test(f)) return f;
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(64);
      const len = fs.readSync(fd, buf, 0, 64, 0);
      fs.closeSync(fd);
      return /^#!\s*\S*(\/(ba|z|k|da|mk)?sh|env\s+(ba|z|k|da)?sh)\b/.test(buf.slice(0, len).toString('utf8')) ? f : null;
    } catch {
      return null;
    }
  }
  return null;
}

// A script's text for the guard to read (at most 256 KB, at most 8 scripts per command), or null.
function readScript(file, ctx) {
  if (ctx.scripts >= 8) return null;
  try {
    const fs = require('fs');
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 256 * 1024) return null;
    const text = fs.readFileSync(file, 'utf8');
    return text.includes('\0') ? '' : text; // a binary runs no shell commands the guard could read
  } catch {
    return null;
  }
}

// An expansion we can't resolve, right where the CLI would be, followed by a human-only verb.
function unknownExpansionHuman(head, ctx) {
  const tryAt = (w, rest) => {
    if (!w) return null;
    const v = varName(w.text);
    if (!v || KNOWN_VARS.test(v) || ctx.vars.has(v)) return null;
    const [a, b] = subcommand(rest, ctx);
    return a && isHumanOnly(a, b) ? humanMessage(a, b) : null;
  };
  if (/^(node|nodejs)$/.test(head.name)) {
    const i = skipOptions(head.args, 0, new Set(['-r', '--require']));
    return tryAt(head.args[i], head.args.slice(i + 1));
  }
  return tryAt(head.word, head.args);
}

// Text that flows into a command's stdin from the left of a pipe or a heredoc.
function upstreamText(cmd, pipeline) {
  const parts = cmd.heredocs.map((h) => h.body);
  for (const r of cmd.redirs) if (r.op === '<<<' && r.target) parts.push(r.target.text);
  const k = pipeline.indexOf(cmd);
  for (let j = k - 1; j >= 0 && pipeline[j].pipeOut; j--) {
    const up = pipeline[j];
    parts.push(...up.heredocs.map((h) => h.body));
    for (const r of up.redirs) if (r.op === '<<<' && r.target) parts.push(r.target.text);
    const h = resolveHead(up.words, { names: new Set(), vars: new Map() });
    if (h && ['echo', 'printf', 'cat', 'yes'].includes(h.name)) parts.push(h.args.filter((a) => !/^-[a-zA-Z]+$/.test(a.text)).map((a) => a.text).join(' '));
  }
  return parts.join('\n');
}

// Path-like arguments a command reads (patterns, programs and option values excluded).
function readArgs(head) {
  const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'awk', 'sed', 'jq', 'yq']);
  const VALUED = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-g', '--glob', '-t', '--type', '-T', '-j', '-M', '-n', '-c', '--max-count', '--context', '--include', '--exclude', '-F', '-v', '--arg', '--argjson', '-s', '--bytes', '--lines']);
  const out = [];
  let patternSeen = !PATTERN_FIRST.has(head.name);
  if (head.args.some((a) => /^(-e|-f|--regexp|--file|--expression)$/.test(a.text) || /^--(regexp|file|expression)=/.test(a.text))) patternSeen = true;
  for (let i = 0; i < head.args.length; i++) {
    const t = head.args[i].text;
    if (t === '--') continue;
    if (t.startsWith('-') && t.length > 1) {
      if (VALUED.has(t) && head.name !== 'head' && head.name !== 'tail') i += 1;
      else if ((head.name === 'head' || head.name === 'tail') && /^-[nc]$/.test(t)) i += 1;
      continue;
    }
    if (!patternSeen) {
      patternSeen = true;
      continue;
    }
    out.push(t);
  }
  return out;
}

const READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'bat', 'batcat', 'xxd', 'od', 'hexdump', 'strings', 'base64', 'nl', 'tac', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'awk', 'sed', 'jq', 'yq', 'cp', 'scp', 'rsync', 'tar', 'zip', 'gzip', 'source', '.', 'diff', 'cmp', 'sort', 'uniq', 'wc', 'cut', 'type', 'Get-Content', 'gc']);

// Files a command writes: redirect targets, tee, and the write verbs' targets.
function writeTargets(head, cmd) {
  const out = [];
  for (const r of cmd.redirs) {
    if (!r.target || !['>', '>>', '>|', '&>', '&>>', '<>', '>&'].includes(r.op)) continue;
    const t = r.target.text;
    if (/^&/.test(t) || /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(t)) continue;
    out.push(t);
  }
  if (!head) return out;
  const nonOpt = (args, valued = new Set()) => {
    const res = [];
    for (let i = 0; i < args.length; i++) {
      const t = args[i].text;
      if (t.startsWith('-') && t.length > 1) {
        if (valued.has(t)) i += 1;
        continue;
      }
      res.push(t);
    }
    return res;
  };
  const n = head.name;
  if (n === 'tee') out.push(...nonOpt(head.args));
  else if (['cp', 'install', 'ln'].includes(n)) {
    const tIdx = head.args.findIndex((a) => a.text === '-t' || a.text === '--target-directory');
    if (tIdx !== -1 && head.args[tIdx + 1]) out.push(head.args[tIdx + 1].text);
    else {
      const a = nonOpt(head.args, new Set(['-m', '--mode', '-o', '-g', '-S', '--suffix']));
      if (a.length) out.push(a[a.length - 1]);
    }
  } else if (['mv', 'rm', 'truncate', 'touch', 'unlink', 'rmdir', 'shred'].includes(n)) {
    const valued = { truncate: ['-s', '--size', '-r', '--reference'], touch: ['-d', '-t', '-r', '--date', '--reference'], mv: ['-t', '--target-directory', '-S', '--suffix'] }[n] || [];
    out.push(...nonOpt(head.args, new Set(valued)));
  } else if (n === 'sed' && head.args.some((a) => /^(-i|--in-place)/.test(a.text) || /^-[a-zA-Z]*i/.test(a.text))) {
    const a = nonOpt(head.args, new Set(['-e', '-f', '--expression', '--file']));
    const hasE = head.args.some((x) => /^(-e|-f|--expression|--file)$/.test(x.text));
    out.push(...(hasE ? a : a.slice(1)));
  } else if (n === 'perl' && head.args.some((a) => /^-[a-zA-Z]*i/.test(a.text))) {
    out.push(...nonOpt(head.args, new Set(['-e', '-E'])));
  } else if (n === 'dd') {
    for (const a of head.args) if (/^of=/.test(a.text)) out.push(a.text.slice(3));
  } else if (/^(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Copy-Item|Move-Item)$/i.test(n)) {
    out.push(...nonOpt(head.args).slice(0, 1));
  }
  return out;
}

// Interpreter code this command runs inline: -e/-c payloads, heredocs and piped text.
function inlineCode(head, cmd, pipeline) {
  const n = head.name;
  const flags = /^(node|nodejs|bun)$/.test(n) ? /^(-e|-p|--eval|--print|-pe)$/ : /^python/.test(n) ? /^-c$/ : /^(ruby|perl)$/.test(n) ? /^-[a-zA-Z]*[eE]$/ : n === 'php' ? /^-r$/ : n === 'deno' ? /^eval$/ : n === 'osascript' ? /^-e$/ : /^$/;
  const code = [];
  let script = false;
  for (let i = 0; i < head.args.length; i++) {
    const t = head.args[i].text;
    if (flags.test(t) && head.args[i + 1]) {
      code.push(head.args[i + 1].text);
      i += 1;
      continue;
    }
    if (/^(-m)$/.test(t) && /^python/.test(n)) {
      script = true;
      break;
    }
    if (!t.startsWith('-') || t === '-') {
      if (t !== '-') script = true;
      break;
    }
  }
  if (!code.length && !script) code.push(upstreamText(cmd, pipeline));
  else code.push(...cmd.heredocs.map((h) => h.body));
  return code.join('\n');
}

function gitRules(head, root, policy) {
  const a = head.args.map((x) => x.text);
  let j = 0;
  while (j < a.length && a[j].startsWith('-')) {
    if (/core\.hookspath/i.test(a[j]) || (a[j] === '-c' && /core\.hookspath/i.test(a[j + 1] || ''))) return 'Redirecting git hooks is not allowed.';
    j += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'].includes(a[j]) ? 2 : 1;
  }
  const sub = a[j];
  const rest = a.slice(j + 1);
  if (rest.some((x) => /core\.hookspath/i.test(x))) return 'Redirecting git hooks is not allowed.';
  // option values (messages, formats, patterns) never count as flags
  const valueOpts = new Set(['-m', '--message', '-F', '--file', '--author', '--date', '-C', '-c', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--template', '--trailer', '--cleanup', '--grep', '--format', '--pretty', '--body', '--title', '--max-count', '--since', '--until', '-S', '-G', '-L', '-o', '--push-option', '--repo', '--receive-pack', '--exec', '-e']);
  if (!['commit', 'push'].includes(sub)) valueOpts.add('-n');
  const flags = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--') break;
    if (valueOpts.has(t)) {
      i += 1;
      continue;
    }
    if (t.startsWith('-')) flags.push(t);
  }
  if (flags.includes('--no-verify')) return '--no-verify is not allowed; hooks always run.';
  if (sub === 'push') {
    if (flags.some((t) => /^--force(-with-lease|-if-includes)?(=|$)/.test(t) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t)) || rest.some((t) => /^\+[^\s]/.test(t))) return 'Force-push is not allowed, in any spelling.';
  }
  if (sub === 'commit') {
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === '--') break;
      if (t.startsWith('--')) {
        if (['--message', '--file', '--author', '--date', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--template', '--trailer', '--cleanup', '--pathspec-from-file'].includes(t)) i += 1;
        continue;
      }
      if (/^-[a-zA-Z]+$/.test(t)) {
        for (const ch of t.slice(1)) {
          if (ch === 'n') return 'git commit -n skips hooks; not allowed.';
          if ('mFCctS'.includes(ch)) {
            if (t.endsWith(ch) && ch !== 'S') i += 1;
            break;
          }
        }
      }
    }
  }
  if (['show', 'cat-file'].includes(sub)) {
    const paths = [];
    let dd = false;
    for (const t of rest) {
      if (t === '--') {
        dd = true;
        continue;
      }
      if (dd) paths.push(t);
      else if (!t.startsWith('-') && t.includes(':')) paths.push(t.slice(t.indexOf(':') + 1));
    }
    for (const p of paths) if (p && isSecret(p.replace(/^\.\//, ''), policy)) return 'Reading secrets through git objects is blocked.';
  }
  const moving = ['push', 'reset', 'update-ref', 'rebase', 'merge', 'checkout', 'switch'].includes(sub) || (sub === 'branch' && flags.some((t) => /^(-[a-zA-Z]*[fFdDmM][a-zA-Z]*|--force|--delete|--move)$/.test(t)));
  if (moving) {
    const ref = rest.map((t) => t.match(/\bfactory\/J-\d+\b(?!-T)/)).find(Boolean);
    if (ref) return `Only the factory CLI moves the job branch (${ref[0]}). Builders commit on their task branch; reconcile merges.`;
  }
  return null;
}

// Walks a command line (and every piece of code it runs) and returns a deny reason or null.
// ctx: { root, policy, agent, names, vars, found }. `collect`: only record factory calls.
function walk(src, ctx, depth, collect = false) {
  if (depth > 6) return null;
  const commands = parse(src);
  if (!collect) collectNames(src, ctx);
  // pipelines: consecutive commands joined by pipes
  const pipelines = [];
  let cur = [];
  for (const c of commands) {
    if (!c.pipeIn && cur.length) {
      pipelines.push(cur);
      cur = [];
    }
    cur.push(c);
  }
  if (cur.length) pipelines.push(cur);
  // Where the command runs, failing CLOSED (012D MJ-1). The directory is KNOWN only while every
  // cd / pushd / popd in it is a simple `cd <literal path>`: no variable, expansion, ~, -, +N/-N,
  // option or `--`; no CDPATH in play; not inside an if / while / case / for, a { } group or a
  // function body; not in a pipe or after &; and either certain to succeed (an existing directory)
  // or gating everything after it (`cd x && …`). A ( ) subshell's cd ends with it; code a nested
  // shell runs (bash -c, $( )) never moves the caller; eval, source and . may, so they make it
  // unknown. Once it is unknown, every RELATIVE write target is refused (absolute ones are checked
  // as always): "use an absolute path or a simple cd".
  if (ctx.cwdUnknown === undefined) {
    ctx.cwd = ctx.cwd || ctx.root || process.cwd();
    ctx.cwdUnknown = false;
    ctx.dirStack = [];
  }
  const state0 = { cwd: ctx.cwd, unknown: ctx.cwdUnknown, stack: ctx.dirStack.slice() };
  const flat = [];
  for (const pipeline of pipelines) for (const cmd of pipeline) flat.push([cmd, pipeline]);
  const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'case', 'esac', 'for', 'select', 'function', '{', '}', '[[', ']]']);
  const compound = flat.some(([c]) => c.words.length && (KEYWORDS.has(c.words[0].text) || /\)$/.test(c.words[0].text) || /^\w+\(\)$/.test(c.words[0].text))) || /\b\w+\s*\(\s*\)\s*\{/.test(src);
  if (/\bCDPATH\b/.test(src) || process.env.CDPATH) ctx.cdpath = true;
  // a cd anywhere in a compound statement or function (however its words are split) moves the
  // shell where the guard cannot follow
  if (compound && /(^|[^\w.-])(cd|pushd|popd)(?![\w.-])/.test(src)) ctx.cwdUnknown = true;
  const frames = [];
  let level = 0;
  try {
    for (let k = 0; k < flat.length; k++) {
      const [cmd, pipeline] = flat[k];
      const d = cmd.depth || 0;
      while (d > level) {
        frames.push({ cwd: ctx.cwd, unknown: ctx.cwdUnknown, stack: ctx.dirStack.slice() });
        level += 1;
      }
      while (d < level) {
        const f = frames.pop();
        if (f) {
          ctx.cwd = f.cwd;
          ctx.cwdUnknown = f.unknown;
          ctx.dirStack = f.stack;
        }
        level -= 1;
      }
      cmd.nextAfter = flat[k + 1] ? flat[k + 1][0].after : null;
      cmd.compound = compound;
      // does every later command at this level run only if this one succeeded?
      let allAnd = true;
      for (let j = k + 1; j < flat.length; j++) {
        const c = flat[j][0];
        if ((c.depth || 0) < d) break;
        if ((c.depth || 0) === d && c.after !== '&&') {
          allAnd = false;
          break;
        }
      }
      cmd.restAllAnd = allAnd;
      const why = checkCommand(cmd, pipeline, ctx, depth, collect);
      if (why) return why;
    }
  } finally {
    // a nested shell's directory changes are its own
    if (depth > 0 && !ctx.inSameShell) {
      ctx.cwd = state0.cwd;
      ctx.cwdUnknown = state0.unknown;
      ctx.dirStack = state0.stack;
    }
  }
  return null;
}

// The absolute path a relative one names, or null when the directory is unknown (see walk).
function resolveAll(ctx, t) {
  const x = String(t || '').replace(/^["']|["']$/g, '');
  if (!x || /^\$/.test(x)) return [x];
  if (path.isAbsolute(x)) return [x];
  const h = x.replace(/^~(?=\/)/, require('os').homedir());
  if (path.isAbsolute(h)) return [h];
  if (ctx.cwdUnknown) return [null];
  return [path.resolve(ctx.cwd || ctx.root || process.cwd(), h)];
}
const UNKNOWN_CWD = 'This command changes directory in a way the guard cannot follow (a cd with a variable, ~, -, +N, an option, CDPATH, inside if/while/case/a function, in a pipe or after &, or after eval/source), so it cannot tell where a relative path lands: use an absolute path, or a simple cd to a literal directory (cd src && …).';
function trackCd(head, cmd, ctx) {
  if (ctx.cwdUnknown) return;
  const unknown = () => {
    ctx.cwdUnknown = true;
  };
  const n = head.name;
  if (cmd.compound || cmd.pipeIn || cmd.pipeOut || cmd.after === '&' || cmd.nextAfter === '&' || cmd.nextAfter === '||') return unknown();
  if (n === 'popd') {
    if (!head.args.length && ctx.dirStack.length) ctx.cwd = ctx.dirStack.pop();
    else unknown();
    return;
  }
  if (head.args.length !== 1) return unknown();
  const a = head.args[0];
  if (a.expand || !/^[^-+~$`*?[][^$`*?[]*$/.test(a.text)) return unknown();
  if (ctx.cdpath && !path.isAbsolute(a.text)) return unknown();
  const target = path.resolve(ctx.cwd, a.text);
  let exists = false;
  try {
    exists = require('fs').statSync(target).isDirectory();
  } catch {
    exists = false;
  }
  const conditional = cmd.after === '&&' || cmd.after === '||';
  if (conditional ? !cmd.restAllAnd : !exists && !cmd.restAllAnd) return unknown();
  if (n === 'pushd') ctx.dirStack.push(ctx.cwd);
  ctx.cwd = target;
}

// 0.12: the shared package caches and the pip wheelhouse (.factory/envcache, .factory/wheelhouse)
// are installer data every later worktree, ci verify included, reads. A factory agent may not
// touch them in any form the guard can read (review 012B M-1, best effort): a word of the command
// (an argument, an installer's --cache-dir / -d / -w / --cache / -C value, a VAR=… assignment such
// as UV_CACHE_DIR or PIP_CACHE_DIR, a redirect) that names a path there, relative paths resolved
// against the command's directory (cd tracked). Reading them (ls, du, cat …) stays allowed.
const SHARED_CACHE = /(^|[\\/])\.factory[\\/](envcache|wheelhouse)([\\/]|$)/;
const CACHE_READERS = new Set(['ls', 'du', 'stat', 'cat', 'head', 'tail', 'wc', 'file', 'less', 'more', 'tree']);
function sharedCacheTouch(head, cmd, ctx) {
  const words = [...cmd.words.map((w) => w.text), ...cmd.redirs.filter((r) => r.target).map((r) => r.target.text)];
  if (head && CACHE_READERS.has(head.name) && !cmd.redirs.some((r) => r.target && resolveAll(ctx, r.target.text).some((x) => x && SHARED_CACHE.test(x)))) return null;
  if (head && head.name === 'find' && !head.args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint\w*)$/.test(a.text))) return null;
  for (let w of words) {
    if (!w) continue;
    const v = varName(w);
    if (v && ctx.vars.has(v)) w = ctx.vars.get(v);
    for (const part of [w, ...(w.includes('=') ? [w.slice(w.indexOf('=') + 1)] : [])]) {
      if (!part || /^-/.test(part) && !part.includes('=')) continue;
      if (ctx.cwdUnknown && !path.isAbsolute(part.replace(/^["']|["']$/g, '')) && /(^|[\\/])\.\.([\\/]|$)|envcache|wheelhouse/.test(part)) return UNKNOWN_CWD;
      if (resolveAll(ctx, part).some((x) => x && SHARED_CACHE.test(x))) return 'The shared package caches and the wheelhouse (.factory/envcache, .factory/wheelhouse) are factory data every later install reads, ci verify included: a factory agent may not write, install into, point an installer at, or remove them. Install into your worktree\'s own environment with its own tool.';
    }
  }
  return null;
}

function checkCommand(cmd, pipeline, ctx, depth, collect) {
  const { root, policy, agent } = ctx;
  // code that runs: every $( ) and backtick in the command
  for (const s of cmd.subs) {
    const why = walk(s, ctx, depth + 1, collect);
    if (why) return why;
  }
  const head = resolveHead(cmd.words, ctx);
  // cd within the command: later relative paths resolve from there (review 012B M-1)
  const CD = ['cd', 'pushd', 'popd'];
  if (head && !head.lookup && CD.includes(head.name)) trackCd(head, cmd, ctx);
  // a cd reached any other way (builtin cd, command cd, exec cd, a wrapper) is not followed
  else if (cmd.words.some((w) => CD.includes(w.text))) ctx.cwdUnknown = true;
  // eval, source and . run code in THIS shell: what they do to the directory is not followed
  if (head && !head.lookup && ['eval', 'source', '.'].includes(head.name)) ctx.cwdUnknown = true;
  if (agent && !collect) {
    const why = sharedCacheTouch(head && !head.lookup ? head : null, cmd, ctx);
    if (why) return why;
  }
  const piped = cmd.pipeIn || cmd.heredocs.length > 0 || cmd.redirs.some((r) => r.op === '<' || r.op === '<<<' || r.op === '<>');
  if (head && !head.lookup) {
    const n = head.name;
    // code fed to a shell: -c payloads, eval, heredocs and pipes into a bare shell
    if (n === 'eval') {
      const why = walk(head.args.map((a) => a.text).join(' '), ctx, depth + 1, collect);
      if (why) return why;
    }
    if (SHELLS.test(n) || PWSH.test(n) || n === 'cmd' || n === 'cmd.exe' || TTY_FAKERS.test(n) || n === 'su' || n === 'watch') {
      const cIdx = head.args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.text) || /^(-Command|-command|\/c|\/C|--command)$/.test(a.text));
      if (cIdx !== -1 && head.args[cIdx + 1]) {
        const why = walk(head.args[cIdx + 1].text, ctx, depth + 1, collect);
        if (why) return why;
      } else if ((n === 'watch' || (TTY_FAKERS.test(n) && n !== 'expect' && n !== 'socat')) && head.args.length) {
        const why = walk(head.args.filter((a) => !a.text.startsWith('-')).map((a) => a.text).join(' '), ctx, depth + 1, collect);
        if (why) return why;
      } else if (SHELLS.test(n) && !head.args.some((a) => !a.text.startsWith('-') && !a.text.startsWith('+'))) {
        const why = walk(upstreamText(cmd, pipeline), ctx, depth + 1, collect);
        if (why) return why;
      }
    }
    // A factory agent's script file (sh run.sh, bash ./x.sh, source x.sh, ./x.sh): the guard
    // reads the file and checks its commands as if typed here. The CLI refuses a factory agent
    // the driving verbs anyway (cli/main.js, FACTORY_RUNNER and the process ancestry); this is the
    // first layer.
    if (agent && !collect) {
      const file = scriptFile(head, ctx);
      if (file) {
        // one it can't read (missing, too big) is left to the CLI's own check
        const text = readScript(file, ctx);
        if (text) {
          ctx.scripts += 1;
          const why = walk(text, ctx, depth + 1, collect);
          if (why) return `${why} (in ${path.basename(file)})`;
        }
      }
    }
    if (n === 'find' || n === 'fd') {
      for (let i = 0; i < head.args.length; i++) {
        if (!/^(-exec|-execdir|-ok|-okdir|-x|--exec|-X|--exec-batch)$/.test(head.args[i].text)) continue;
        const end = head.args.findIndex((a, k) => k > i && /^(;|\+|\\;)$/.test(a.text));
        const inner = head.args.slice(i + 1, end === -1 ? head.args.length : end);
        const fake = { words: inner, redirs: [], heredocs: [], pipeIn: false, pipeOut: false, subs: [] };
        const why = checkCommand(fake, [fake], ctx, depth + 1, collect);
        if (why) return why;
        if (agent && !collect && inner.length && resolveHead(inner, ctx) && factoryCall(resolveHead(inner, ctx), ctx)) return 'Factory agents run the factory CLI directly, never through xargs, parallel or find -exec.';
      }
    }
    // the factory CLI itself
    const call = factoryCall(head, ctx);
    if (call) {
      ctx.found.push(call);
      if (collect) return null;
      let [a, b] = subcommand(call.args, ctx);
      if (head.xargs) {
        if (agent) return 'Factory agents run the factory CLI directly, never through xargs, parallel or find -exec.';
        // the verb arrives on stdin (or after :::): look at what is fed in
        const fed = `${upstreamText(cmd, pipeline)} ${cmd.words.slice(head.xargs.at).map((w) => w.text).join(' ')}`.split(/[\s'"]+/).filter(Boolean);
        if (!a || a === ':::') {
          const w = fed.find((x) => HUMAN_ONLY.has(x));
          if (w) return humanMessage(w);
          if (fed.includes('lessons') && ['accept', 'reject', 'promote'].some((x) => fed.includes(x))) return humanMessage('lessons', ['accept', 'reject', 'promote'].find((x) => fed.includes(x)));
        }
      }
      if (a && isHumanOnly(a, b)) return humanMessage(a, b);
      if (agent && a) {
        const flags = call.args.map((x) => {
          const v = varName(x.text);
          return v && ctx.vars.has(v) ? ctx.vars.get(v) : x.text;
        });
        // a flag computed at run time cannot be read here: for these commands it is refused (m-2)
        const computed = flags.some((x) => /[$`]/.test(String(x)));
        const byFlag = agentFlagRefusal(a, b, (name) => flags.some((x) => x === `--${name}` || String(x).startsWith(`--${name}=`)), { computed });
        if (byFlag) return byFlag.message;
      }
      if (agent && a && !agentAllowed(a, b)) return agentMessage(a, b);
      // The subcommand built at run time ("$(echo drive)", $(printf approve), `…`, an unknown
      // variable): what it runs can't be read here. A factory agent names its commands literally;
      // anyone else may not hide a verb behind a command substitution.
      const hidden = hiddenVerb(call.args, ctx);
      if (hidden && (agent || hidden === 'sub')) return agent ? 'Factory agents run factory commands with the subcommand written out (factory task show T1), never built at run time ($(…), `…` or a variable).' : 'The factory subcommand may not come from a command substitution ($(…) or `…`): write it out.';
    } else if (!collect) {
      const why = unknownExpansionHuman(head, ctx);
      if (why) return why;
    }
    if (collect) return null;
    // terminal emulation and interactive shells
    // A terminal emulator's payload is already parsed above (it is a wrapper); this catches
    // only what that can't read (e.g. an expect script) when it names the factory CLI.
    if (TTY_FAKERS.test(n) && /(^|[\s/'"])factory(-inspect)?\b|bin\/factory/.test([n, ...head.args.map((a) => a.text)].join(' '))) return `${n} (terminal emulation) around the factory CLI is not allowed here: run the command directly.`;
    if (SHELLS.test(n) || PWSH.test(n)) {
      const args = head.args.map((x) => x.text);
      const info = args.some((t) => /^(--version|--help|-version|-help|-h)$/.test(t));
      if (!info) {
        if (args.some((t) => /^-[a-zA-Z]*i[a-zA-Z]*$/.test(t) && !/c/.test(t))) return 'Starting an interactive shell is not allowed here: run each command directly (bash -c "…" or plain commands).';
        if (!piped && args.every((t) => t.startsWith('-') && !/^-[a-zA-Z]*c[a-zA-Z]*$/.test(t) && !/^-(Command|File|command|file|EncodedCommand)$/.test(t) && t !== '-s')) {
          return 'Starting an interactive shell is not allowed here: run each command directly (bash -c "…" or plain commands).';
        }
      }
    }
    if (n === 'git') {
      const why = gitRules(head, root, policy);
      if (why) return why;
    }
    // interpreters reaching into factory state or internals
    if (INTERPRETER.test(n) && !call) {
      const code = inlineCode(head, cmd, pipeline);
      // the machine scan and the confirmed environment's checks, inside inline code (review m-2)
      if (agent) {
        const arg = head.args.map((x) => x.text).find((t) => t && !t.startsWith('-') && !/[$`]/.test(t));
        const file = arg ? path.resolve(ctx.cwd || ctx.root || '.', arg) : null;
        const text = file ? readScript(file, ctx) || '' : '';
        const why = machineStepInText(code) || (file ? machineStepInText(text) : null);
        if (why) return why;
        // a script file's writes into factory state or the shared caches, as for inline code
        if (text && ((STATE.test(text) || SHARED_CACHE.test(text)) && WRITE_OPS.test(text))) return 'A script that changes factory state or the shared package caches is not allowed for factory agents. Use the factory CLI your brief gives you; install into your worktree\'s own environment.';
      }
      if (INTERNALS_STRICT.test(code) || (STATE.test(code) && WRITE_OPS.test(code))) {
        return 'Inline scripts may not change factory state or load factory internals. To read a job file use the Read tool; to change one you are allowed to change (an ADR, the plan, a threat model) use Write or Edit; for job state use the factory CLI (factory job show, contract show, why).';
      }
      // An agent may read its own job's folder in inline code (the check above still stops
      // writes and code loading); script files handed a job path, and anything else under
      // .factory/, stay off limits.
      const own = ownJobDir(ctx.job || process.env.FACTORY_JOB);
      const strip = (t) => (own ? t.replace(own, 'OWN_JOB_DIR') : t);
      if (agent && (INTERNALS.test(strip(code)) || head.args.some((x) => !x.text.startsWith('-') && INTERNALS.test(code.includes(x.text) ? strip(x.text) : x.text)))) {
        return 'Factory agents may not reach into factory state with scripts. To read a job file use the Read tool; for job state use the factory CLI your brief gives you.';
      }
    }
    // reads of secrets
    if (READERS.has(n) || (n === 'curl' && head.args.some((x) => /^-F$|^--form$/.test(x.text)))) {
      for (const t of n === 'curl' ? head.args.map((x) => x.text).filter((x) => /^@/.test(x) || /=@/.test(x)).map((x) => x.replace(/^.*@/, '')) : readArgs(head)) {
        if (!t || /^\$|^-$/.test(t)) continue;
        if (SECRET_FILE.test(t)) return 'The factory seal secret is off limits.';
        const abs = path.isAbsolute(t) ? t : path.resolve(root || process.cwd(), t.replace(/^~(?=\/)/, require('os').homedir()));
        const why = checkRead(root, abs, policy);
        if (why) return why;
      }
    }
  }
  if (collect) return null;
  // writes: redirects, tee and the write verbs
  for (const t of writeTargets(head && !head.lookup ? head : null, cmd)) {
    if (!t || /^\$/.test(t) || t === '-') continue;
    // find -exec's {} is each file find found under its start paths, not a path here
    if (/^\{\}[;+]?$/.test(t)) continue;
    if (SECRET_FILE.test(t)) return 'The factory seal secret is off limits.';
    for (const abs of resolveAll(ctx, t)) {
      if (abs === null) return UNKNOWN_CWD;
      const why = checkWrite(root, abs, policy, { own: ctx.agent ? ctx.ownWt : null });
      if (why) return why;
    }
  }
  // a symlink is a way in: `ln -s ../.. build` makes build/envcache/… the shared cache. The
  // directory it points to must not be factory state or another task's worktree (012D m-2), and
  // neither may a new directory.
  if (head && !head.lookup && ctx.agent && root) {
    const args = head.args.map((a) => a.text);
    const extra = [];
    if (head.name === 'ln' && args.some((a) => /^-[a-zA-Z]*s|^--symbolic$/.test(a))) {
      const plain = args.filter((a) => !/^-/.test(a));
      const tIdx = args.findIndex((a) => a === '-t' || a === '--target-directory');
      const linkDir = tIdx !== -1 && args[tIdx + 1] ? args[tIdx + 1] : plain.length > 1 ? path.dirname(plain[plain.length - 1]) : '.';
      const sources = tIdx !== -1 ? plain.filter((a) => a !== args[tIdx + 1]) : plain.length > 1 ? plain.slice(0, -1) : plain;
      for (const src of sources) extra.push(path.isAbsolute(src) ? src : path.join(linkDir, src));
    } else if (head.name === 'mkdir') extra.push(...args.filter((a) => !/^-/.test(a)));
    for (const t of extra) {
      if (!t || /^\$/.test(t)) continue;
      for (const abs of resolveAll(ctx, t)) {
        if (abs === null) return UNKNOWN_CWD;
        const r = rel(realpath(root), realpath(abs));
        const m = /^\.factory(\/|$)(worktrees\/([^/]+))?/.exec(r);
        if (!m) continue;
        // inside its own worktree (its allowed paths are checked where it writes files)
        if (m[3] && ctx.ownWt && m[3] === ctx.ownWt) continue;
        const probe = checkWrite(root, path.join(abs, '.factory-probe'), policy, { own: ctx.ownWt });
        const why = probe && probe.replace(/\/?\.factory-probe\b/g, '');
        if (why) return head.name === 'ln' ? `This link points into ${r || '.'}, which you may not write: ${why}` : why;
      }
    }
  }
  return null;
}

// .factory/jobs/<own job> (with or without a trailing slash), never followed by a path that
// climbs out with "..".
function ownJobDir(jobId) {
  if (!/^J-\d+$/.test(String(jobId || ''))) return null;
  return new RegExp(`\\.factory[\\\\/]jobs[\\\\/]${jobId}(?![\\w-])(?![^\\s'"\`;|&)]*\\.\\.)`, 'g');
}

// The CLI's test-only human seam and the seal-secret override are for the test suite: a shell
// command that sets them (bash, env, export, PowerShell $env:) is never an agent's business.
const TEST_SEAM = /\bFACTORY_(TEST_HUMAN\w*|SECRET_FILE|DEPS_FETCH_\w+)\b/;

function checkBash(root, cmd, policy, opts = {}) {
  if (TEST_SEAM.test(String(cmd || ''))) return 'FACTORY_TEST_HUMAN, FACTORY_SECRET_FILE and FACTORY_DEPS_FETCH_* are the test suite\'s seams (into human-only actions, and the dependency fetch), never set from here. Human-only actions are the user\'s: their chat reply, or their own terminal.';
  const ctx = { root, cwd: opts.cwd || root, ownWt: ownWorktree(root, opts.cwd), policy: policy || require('../cli/core/policy').defaults(), agent: Boolean(opts.agent), job: opts.job || null, names: new Set(), vars: new Map(), found: [], scripts: 0 };
  try {
    return walk(String(cmd || ''), ctx, 0);
  } catch {
    return null; // a command we can't read is allowed
  }
}

// A command handed to a tool the guard doesn't know (a VS Code, extension or MCP command
// runner): only the factory-CLI rules apply here, read with the same command-position logic
// as Bash: a human-only verb, and for a factory agent driving the job. Everything else about
// such a tool is its own harness's business.
function checkUnknownCommand(root, cmd, policy, opts = {}) {
  const why = checkBash(root, cmd, policy, opts);
  return why && /is a human-only action|is not for a factory agent|never through xargs|test suite's seam/.test(why) ? why : null;
}

// Files an agent writes may not carry code that reaches into factory internals: a string
// literal naming them on the same line as a require/import/open/read/write call. Comments
// and prose that merely mention a factory path are fine.
function checkContent(text, file) {
  if (file && !/\.(c?m?js|ts|py|rb|pl|php|sh|bash|zsh)$/.test(file)) return null;
  const CALL = /require\s*\(|\bimport\b|\bfrom\s+['"]|open\s*\(|readFile|writeFile|appendFile|createReadStream|createWriteStream|\bsource\s|\bcat\s|Path\s*\(/;
  for (const raw of String(text || '').split('\n')) {
    const line = raw
      .replace(/\/\*.*?\*\//g, '')
      .replace(/(^|[^:'"\\])\/\/.*$/, '$1')
      .replace(/^\s*#.*$/, '')
      .replace(/\s#\s.*$/, '');
    if (!CALL.test(line)) continue;
    for (const m of line.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
      if (INTERNALS.test(m[2])) return 'This file would reach into factory state or internals. Use the factory CLI instead.';
    }
  }
  return null;
}

// Back-compat for callers that normalise a command for display.
function normalise(cmd) {
  return parse(cmd).map((c) => c.words.map((w) => w.text).join(' ')).join('; ');
}

module.exports = { taskScope, CLI_BOOL, BUILD_OUTPUT, ownWorktree, checkWrite, checkRead, checkReadTool, READ_TOOLS, checkBash, checkUnknownCommand, checkContent, normalise, deny, loadPolicy, isSecret, AGENT_ALLOWED, HUMAN_ONLY };
