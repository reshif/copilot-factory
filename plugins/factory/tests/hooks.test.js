'use strict';
// The hooks under the GitHub Copilot CLI: payloads in both casings (camelCase toolName/
// toolArgs as a JSON string or object; PascalCase tool_name/tool_input), runtime tool names
// (bash, view, create, edit, str_replace_editor, apply_patch, grep, glob), path vs
// file_path, the flat output shapes and exit codes (a deny is JSON on stdout, exit 0), the
// stop gate (at most one block per routing decision) and the last-reply file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const lib = require('../hooks/lib');

const hook = (name, input, event) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', name), ...(event ? [event] : [])], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
const events = (root) => fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const guard = (input) => hook('guard.js', input, 'preToolUse');
const isDeny = (r) => r.status === 0 && r.stdout !== '' && JSON.parse(r.stdout).permissionDecision === 'deny' && /^\[factory guard\]/.test(JSON.parse(r.stdout).permissionDecisionReason) && r.stderr === '';
const isAllow = (r) => r.status === 0 && r.stdout === '';

test('normaliser: both casings, runtime tool names, path fields, apply_patch bodies', () => {
  const camel = lib.normalise({ toolName: 'bash', toolArgs: '{"command":"ls"}', cwd: '/r', sessionId: 's', timestamp: 1 }, 'preToolUse');
  assert.equal(camel.event, 'PreToolUse');
  assert.equal(camel.tool, 'Bash');
  assert.equal(camel.command, 'ls');
  const snake = lib.normalise({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/r' });
  assert.deepEqual([snake.event, snake.tool, snake.command], ['PreToolUse', 'Bash', 'ls']);
  for (const [n, want] of [['view', 'Read'], ['create', 'Write'], ['edit', 'Edit'], ['apply_patch', 'Edit'], ['grep', 'Grep'], ['rg', 'Grep'], ['glob', 'Glob'], ['powershell', 'Bash'], ['web_fetch', 'WebFetch'], ['task', 'Task'], ['some_mcp_tool', 'some_mcp_tool']]) assert.equal(lib.toolName(n, {}), want, n);
  assert.equal(lib.toolName('str_replace_editor', { command: 'view' }), 'Read');
  assert.equal(lib.toolName('str_replace_editor', { command: 'create' }), 'Write');
  assert.equal(lib.toolName('str_replace_editor', { command: 'str_replace' }), 'Edit');
  assert.equal(lib.normalise({ toolName: 'edit', toolArgs: { path: 'a.js', new_str: 'x' } }).file, 'a.js');
  assert.equal(lib.normalise({ tool_name: 'Write', tool_input: { file_path: 'b.js', content: 'y' } }).file, 'b.js');
  assert.equal(lib.normalise({ toolName: 'create', toolArgs: { filePath: 'c.js', file_text: 'z' } }).content, 'z');
  const patch = '*** Begin Patch\n*** Update File: src/a.js\n@@\n-old\n+new line\n*** Add File: src/b.js\n+hello\n*** Delete File: src/c.js\n*** End Patch';
  const p = lib.normalise({ toolName: 'apply_patch', toolArgs: patch }, 'preToolUse');
  assert.equal(p.tool, 'Edit');
  assert.ok(p.isPatch);
  assert.deepEqual(p.files.map((f) => [f.path, f.op]), [['src/a.js', 'update'], ['src/b.js', 'add'], ['src/c.js', 'delete']]);
  assert.equal(p.files[0].content, 'new line');
  assert.deepEqual(lib.normalise({ toolName: 'apply_patch', toolArgs: { input: patch } }).files.length, 3);
  assert.deepEqual(lib.patchFiles('diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@\n+y\ndiff --git a/z b/z\n--- a/z\n+++ /dev/null\n').map((f) => [f.path, f.op, f.content]), [['x.js', 'update', 'y'], ['z', 'delete', '']]);
  const sub = lib.normalise({ agentName: 'factory:builder', agentDisplayName: 'Builder', transcriptPath: '/t' }, 'subagentStart');
  assert.deepEqual([sub.event, sub.agent, sub.agentId, sub.transcriptPath], ['SubagentStart', 'factory:builder', null, '/t']);
  const stop = lib.normalise({ transcriptPath: '/t', stopReason: 'end_turn', stop_hook_active: true }, 'agentStop');
  assert.deepEqual([stop.event, stop.stopHookActive], ['Stop', true]);
  assert.equal(lib.normalise({}, 'agentStop').stopHookActive, undefined);
});

test('guard: Copilot deny = the documented flat JSON on stdout, exit 0, nothing on stderr; both casings', () => {
  const root = F.makeRepo();
  assert.ok(isDeny(guard({ toolName: 'bash', toolArgs: JSON.stringify({ command: 'git push --force' }), cwd: root })));
  assert.ok(isDeny(guard({ toolName: 'bash', toolArgs: { command: 'git push --force' }, cwd: root })));
  assert.ok(isDeny(guard({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force' }, cwd: root })));
  const out = JSON.parse(guard({ toolName: 'bash', toolArgs: { command: 'git push --force' }, cwd: root }).stdout);
  assert.deepEqual(Object.keys(out).sort(), ['hookSpecificOutput', 'permissionDecision', 'permissionDecisionReason']);
  assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: out.permissionDecisionReason }, 'the VS Code Local shape in the same object');
  assert.ok(isAllow(guard({ toolName: 'bash', toolArgs: { command: 'git status' }, cwd: root })));
  assert.ok(isAllow(guard({ toolName: 'view', toolArgs: { path: 'src/add.js' }, cwd: root })));
  assert.equal(hook('guard.js', 'not json', 'preToolUse').status, 0, 'a broken input never blocks');
  const denies = events(root).filter((e) => e.event === 'guard_deny');
  assert.equal(denies.length, 4);
  assert.equal(denies[0].tool, 'Bash');
});

test('guard: writes through create / edit / str_replace_editor / apply_patch, path or file_path', () => {
  const root = F.makeRepo();
  const P = '*** Begin Patch\n*** Update File: src/add.js\n@@\n-x\n+module.exports = (a, b) => a + b;\n*** Add File: .factory/jobs/J-0001/state.json\n+{}\n*** End Patch';
  assert.ok(isDeny(guard({ toolName: 'create', toolArgs: { path: '.factory/policy.json', file_text: '{}' }, cwd: root })));
  assert.ok(isDeny(guard({ toolName: 'edit', toolArgs: { path: path.join(root, '.factory', 'project.json'), old_str: 'a', new_str: 'b' }, cwd: root })));
  assert.ok(isDeny(guard({ tool_name: 'Edit', tool_input: { file_path: '.factory/current', old_string: 'a', new_string: 'b' }, cwd: root })));
  assert.ok(isDeny(guard({ toolName: 'str_replace_editor', toolArgs: { command: 'create', path: '.git/hooks/pre-commit', file_text: 'x' }, cwd: root })));
  assert.ok(isDeny(guard({ toolName: 'apply_patch', toolArgs: P, cwd: root })), 'a patch touching factory state');
  assert.ok(isDeny(guard({ toolName: 'apply_patch', toolArgs: { input: P }, cwd: root })));
  assert.ok(isDeny(guard({ toolName: 'apply_patch', toolArgs: '*** Begin Patch\n*** Add File: src/tool.js\n+const h = require(\'../plugin/cli/core/human\');\n*** End Patch', cwd: root })), 'content reaching into internals');
  assert.ok(isDeny(guard({ toolName: 'apply_patch', toolArgs: 'gibberish', cwd: root })), 'a patch whose files cannot be found');
  assert.ok(isDeny(guard({ toolName: 'create', toolArgs: { path: path.join(F.PLUGIN, 'hooks', 'x.js'), file_text: '' }, cwd: root })), 'the plugin itself');
  assert.ok(isAllow(guard({ toolName: 'apply_patch', toolArgs: '*** Begin Patch\n*** Update File: src/add.js\n@@\n-x\n+module.exports = (a, b) => a + b;\n*** End Patch', cwd: root })));
  assert.ok(isAllow(guard({ toolName: 'create', toolArgs: { path: 'src/new.js', file_text: 'module.exports = 1;' }, cwd: root })));
  assert.ok(isAllow(guard({ toolName: 'edit', toolArgs: { path: '.factory/scratch/notes.md', new_str: 'x' }, cwd: root })));
});

test('guard: reads through view / str_replace_editor view / grep / glob get the read rules', () => {
  const root = F.makeRepo();
  const secretDir = path.dirname(require('../cli/lib/seal').secretFile());
  assert.ok(isDeny(guard({ toolName: 'view', toolArgs: { path: '.env' }, cwd: root })));
  assert.ok(isDeny(guard({ toolName: 'str_replace_editor', toolArgs: { command: 'view', path: 'config/prod.pem' }, cwd: root })));
  assert.ok(isDeny(guard({ toolName: 'glob', toolArgs: { pattern: '*', path: secretDir }, cwd: root })));
  assert.ok(isDeny(guard({ toolName: 'grep', toolArgs: JSON.stringify({ pattern: '.', path: secretDir }), cwd: root })));
  assert.ok(isDeny(guard({ toolName: 'rg', toolArgs: { pattern: 'KEY', glob: '.env*' }, cwd: root })));
  assert.ok(isDeny(guard({ tool_name: 'Grep', tool_input: { pattern: 'x', glob: '*.pem' }, cwd: root })));
  assert.ok(isAllow(guard({ toolName: 'glob', toolArgs: { pattern: '**/*.js', path: root }, cwd: root })));
  assert.ok(isAllow(guard({ toolName: 'grep', toolArgs: { pattern: 'add', glob: '*.js' }, cwd: root })));
  assert.ok(isAllow(guard({ toolName: 'view', toolArgs: { path: '.env.example' }, cwd: root })));
});

test('hooks.json: at the plugin root, native Copilot format, named launchers that always exit 0', () => {
  assert.ok(!fs.existsSync(path.join(F.PLUGIN, 'hooks', 'hooks.json')), 'one hooks file only: the plugin root one (VS Code reads only that for Copilot-format plugins)');
  const H = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'hooks.json'), 'utf8'));
  assert.equal(H.version, 1);
  assert.deepEqual(Object.keys(H.hooks).sort(), ['agentStop', 'postToolUse', 'preToolUse', 'sessionStart', 'subagentStart', 'subagentStop', 'userPromptSubmitted']);
  const ids = new Set();
  for (const [ev, list] of Object.entries(H.hooks)) {
    for (const h of list) {
      assert.equal(h.type, 'command');
      assert.equal(h.matcher, undefined, ev);
      assert.ok(h.timeoutSec > 0 && h.timeoutSec <= 30, ev);
      // a short, distinct name first: Copilot's timeout warning shows only the first 80 characters
      const id = h.bash.match(/^H=(factory:[\w-]+); /)[1];
      assert.ok(!ids.has(id), id);
      ids.add(id);
      assert.ok(h.powershell.startsWith(`$h='${id}'; `), ev);
      // VS Code's Local harness: `command` is its cross-platform field; the same POSIX launcher
      // (the Copilot runtime prefers bash/powershell when they are present).
      assert.equal(h.command, h.bash, ev);
      // flat root lookup: no nested ${…:-${…}} and no ${PLUGIN_ROOT} / ${CLAUDE_PLUGIN_ROOT} token VS Code would rewrite
      assert.match(h.bash, /R=\$PLUGIN_ROOT; \[ -n "\$R" \] \|\| R=\$COPILOT_PLUGIN_ROOT; \[ -n "\$R" \] \|\| R=\$CLAUDE_PLUGIN_ROOT;/);
      assert.doesNotMatch(h.bash + h.powershell, /\$\{(PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT)\}|\$\{[^}]*\$\{/);
      assert.match(h.bash, new RegExp(`\\.js" ${ev} \\|\\| echo "\\[\\$H\\] hook failed \\(exit \\$\\?\\); allowed" >&2; exit 0$`), 'node, then exit 0 whatever happened');
      assert.match(h.powershell, /; exit 0$/);
      assert.doesNotMatch(h.bash, /\bexec node\b/);
      const script = h.bash.match(/hooks\/([\w-]+\.js)/)[1];
      assert.ok(fs.existsSync(path.join(F.PLUGIN, 'hooks', script)), script);
    }
  }
  assert.equal(H.hooks.preToolUse[0].timeoutSec, 10, 'timeouts fail open: keep the guard short');
  // the bash command really runs the hook through the env var (and exits quietly without it)
  const root = F.makeRepo();
  const run = (env, bash = H.hooks.preToolUse[0].bash) => spawnSync('bash', ['-c', bash], { input: JSON.stringify({ toolName: 'bash', toolArgs: { command: 'git push --force' }, cwd: root }), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
  for (const env of [{ COPILOT_PLUGIN_ROOT: F.PLUGIN }, { PLUGIN_ROOT: F.PLUGIN }, { CLAUDE_PLUGIN_ROOT: F.PLUGIN }]) {
    const r = run(env);
    assert.equal(r.status, 0, JSON.stringify(env));
    assert.equal(JSON.parse(r.stdout).permissionDecision, 'deny', JSON.stringify(env));
  }
  // a plugin root with a space in it
  const spaced = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'plug ')), 'my plugin');
  fs.symlinkSync(F.PLUGIN, spaced);
  assert.equal(JSON.parse(run({ PLUGIN_ROOT: spaced }).stdout).permissionDecision, 'deny');
  assert.deepEqual([run({}).status, run({}).stdout], [0, '']);
  // node crashing, killed or too old fails OPEN: exit 0, a warning, no deny
  const fakeNodeDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'badnode-'));
  for (const code of [1, 3, 137]) {
    fs.writeFileSync(path.join(fakeNodeDir, 'node'), `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 });
    const r = run({ PLUGIN_ROOT: F.PLUGIN, PATH: `${fakeNodeDir}:${process.env.PATH}` });
    assert.deepEqual([r.status, r.stdout], [0, ''], `node exit ${code}`);
    assert.match(r.stderr, new RegExp(`\\[factory:guard\\] hook failed \\(exit ${code}\\); allowed`));
  }
  // no node on PATH: every hook exits 0 with a warning (a non-zero preToolUse exit would deny every tool)
  const noNode = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nonode-'));
  for (const b of ['bash', 'dirname', 'cat']) {
    const p = spawnSync('bash', ['-c', `command -v ${b}`], { encoding: 'utf8' }).stdout.trim();
    if (p) fs.symlinkSync(p, path.join(noNode, b));
  }
  for (const [ev, list] of Object.entries(H.hooks)) {
    const r = spawnSync(path.join(noNode, 'bash'), ['-c', list[0].bash], { input: '{}', encoding: 'utf8', env: { PATH: noNode, PLUGIN_ROOT: F.PLUGIN } });
    assert.equal(r.status, 0, ev);
    assert.match(r.stderr, /^\[factory:[\w-]+\] node is not on PATH/, ev);
    assert.ok(list[0].powershell.includes('if (-not (Get-Command node -ErrorAction SilentlyContinue)) { [Console]::Error.WriteLine("[$h] node is not on PATH'), ev);
  }
  const missing = spawnSync('bash', ['-c', H.hooks.preToolUse[0].bash], { input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, PLUGIN_ROOT: '/nonexistent' } });
  assert.deepEqual([missing.status, /^\[factory:guard\] hook script .* not found; hook skipped/.test(missing.stderr)], [0, true]);
  // postToolUse filters in-script what the Claude matcher used to
  const { shouldLog } = require('../hooks/activity');
  for (const t of ['bash', 'create', 'edit', 'apply_patch', 'task', 'web_fetch']) assert.ok(shouldLog(lib.normalise({ toolName: t, toolArgs: {} }, 'postToolUse')), t);
  for (const t of ['view', 'grep', 'glob', 'update_todo']) assert.ok(!shouldLog(lib.normalise({ toolName: t, toolArgs: {} }, 'postToolUse')), t);
  assert.ok(shouldLog(lib.normalise({ agentName: 'factory:builder' }, 'subagentStart')));
});

test('activity: postToolUse and subagent events land in the log with normalised names', () => {
  const root = F.makeRepo();
  F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']);
  assert.equal(hook('activity.js', { toolName: 'bash', toolArgs: '{"command":"npm test --job J-0001"}', toolResult: { resultType: 'success', textResultForLlm: 'ok' }, cwd: root }, 'postToolUse').status, 0);
  hook('activity.js', { toolName: 'view', toolArgs: { path: 'src/add.js' }, cwd: root }, 'postToolUse');
  hook('activity.js', { toolName: 'apply_patch', toolArgs: '*** Begin Patch\n*** Update File: src/add.js\n+x\n*** End Patch', cwd: root }, 'postToolUse');
  hook('activity.js', { agentName: 'factory:builder', transcriptPath: '/t', cwd: root }, 'subagentStart');
  hook('subagent-stop.js', { agentName: 'factory:builder', agentType: 'custom', agentId: 'a1', response: 'done', cwd: root }, 'subagentStop');
  hook('subagent-stop.js', { hook_event_name: 'SubagentStop', agent_name: 'factory:tester', agent_type: 'factory:tester', agent_id: 'a2', last_assistant_message: 'ok', cwd: root });
  const ev = events(root).filter((e) => e.event !== 'cli');
  assert.deepEqual(ev.map((e) => [e.event, e.tool || e.agent_type]), [['PostToolUse', 'Bash'], ['PostToolUse', 'Edit'], ['SubagentStart', 'factory:builder'], ['SubagentStop', 'factory:builder'], ['SubagentStop', 'factory:tester']]);
  assert.equal(ev[0].how, 'explicit');
  assert.equal(ev[1].target, 'src/add.js', 'apply_patch target from the patch body');
  assert.equal(ev[3].role, 'builder');
  assert.equal(ev[3].agent_id, 'a1');
});

test('sessionStart: the absolute CLI command always, the current job when there is one', () => {
  const root = F.makeRepo();
  const bare = JSON.parse(hook('session-start.js', { source: 'startup', cwd: root }, 'sessionStart').stdout);
  assert.deepEqual(Object.keys(bare), ['additionalContext', 'hookSpecificOutput']);
  assert.deepEqual(bare.hookSpecificOutput, { hookEventName: 'SessionStart', additionalContext: bare.additionalContext });
  assert.ok(bare.additionalContext.includes(`node "${path.join(F.PLUGIN, 'bin', 'factory')}"`));
  assert.match(bare.additionalContext, /not on PATH/);
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  assert.match(JSON.parse(hook('session-start.js', { source: 'resume', cwd: root }, 'sessionStart').stdout).additionalContext, new RegExp(`Current job ${J}: x · bug@low`));
  // outside any factory repo it still says how to run the CLI
  assert.match(JSON.parse(hook('session-start.js', { cwd: path.dirname(root) }, 'sessionStart').stdout).additionalContext, /bin\/factory/);
});

test('hook failures leave a sealed hook_error trace and never block', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  const st = path.join(F.jobDir(root, J), 'state.json');
  fs.writeFileSync(st, JSON.stringify({ ...JSON.parse(fs.readFileSync(st, 'utf8')), risk: 'high' }));
  const r = hook('session-start.js', { cwd: root, source: 'startup' }, 'sessionStart');
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).additionalContext, /could not be read/);
  const err = events(root).find((e) => e.event === 'hook_error');
  assert.ok(err, 'hook_error logged');
  assert.equal(err.hook, 'session-start');
  assert.equal(err.hook_event, 'SessionStart');
  assert.equal(err.job, J);
  assert.ok(err.message && err.seal);
  // a crash in the guard fails open (exit 0) and is traced too
  const g = hook('guard.js', { toolName: 'bash', toolArgs: { command: 'git status' }, cwd: root }, 'preToolUse');
  assert.equal(g.status, 0);
});

test('userPromptSubmitted: applies an exact reply, reports a refused one, writes last-reply.json, factory next shows it', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  const run = (prompt, casing = 'camel') => hook('prompt.js', casing === 'camel' ? { prompt, cwd: root, sessionId: 's', timestamp: 1 } : { hook_event_name: 'UserPromptSubmit', prompt, cwd: root, session_id: 's' }, casing === 'camel' ? 'userPromptSubmitted' : undefined);
  const ctx = (r) => JSON.parse(r.stdout).additionalContext;
  const lastReply = () => JSON.parse(fs.readFileSync(path.join(root, '.factory', 'last-reply.json'), 'utf8'));
  assert.match(ctx(run('approve')), /NOT applied/);
  assert.equal(lastReply().status, 'refused');
  assert.equal(lastReply().code, 'no_gate');
  let n = F.cli(root, ['next']);
  assert.equal(n.last_reply.status, 'refused', 'factory next shows the refused reply');
  assert.equal(F.cli(root, ['next']).last_reply, undefined, 'only until the next routing decision');
  assert.equal(run('please continue').stdout, '');
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  F.clarify(root);
  assert.equal(F.cli(root, ['next']).step, 'H1');
  const miss = ctx(run('aprove'));
  assert.match(miss, /NOTHING was applied/);
  assert.match(miss, /`approve \[J-0001\] \[H1\]`/);
  assert.equal(lastReply().status, 'unparsed');
  assert.match(ctx(run('approve the contract please', 'snake')), /NOTHING was applied/);
  n = F.cli(root, ['next']);
  assert.equal(n.step, 'H1', 'still waiting at H1');
  assert.equal(n.last_reply.status, 'unparsed', 'a repeated gate wait is no new decision: still shown');
  assert.match(ctx(run('Approve! 👍')), /Applied your reply: Approved H1/);
  assert.equal(lastReply().status, 'applied');
  assert.equal(lastReply().job, J);
  n = F.cli(root, ['next']);
  assert.notEqual(n.step, 'H1');
  assert.equal(n.last_reply.status, 'applied');
  assert.match(n.last_reply.message, /Approved H1/);
  assert.equal(events(root).filter((e) => e.event === 'reply_unparsed').length, 2);
});

// --- agentStop ---------------------------------------------------------------------------

const stop = (root, extra = {}) => hook('stop.js', { cwd: root, transcriptPath: path.join(root, 'no-such-transcript.jsonl'), stopReason: 'end_turn', stop_hook_active: false, ...extra }, 'agentStop');
const blocked = (r) => r.status === 0 && r.stdout !== '' && JSON.parse(r.stdout).decision === 'block';
const prompt = (root, text) => hook('prompt.js', { prompt: text, cwd: root, sessionId: 's', timestamp: 1 }, 'userPromptSubmitted');
const transcript = (root, ...entries) => {
  const t = path.join(root, '.factory', 'scratch', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.writeFileSync(t, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return t;
};
const said = (text) => ({ type: 'assistant.message', data: { content: text } });
const asked = (text) => ({ type: 'user.message', data: { content: text } });

test('agentStop: blocks at most once per routing decision, across continuations and turns', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  prompt(root, '/factory:start fix add');
  const d = F.cli(root, ['next']); // clarify: the agent's move, and it ends its turn without it
  const r = stop(root);
  assert.ok(blocked(r));
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['decision', 'hookSpecificOutput', 'reason']);
  assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'Stop', decision: 'block', reason: out.reason });
  assert.match(out.reason, /^\[factory stop gate\] Not finished — /);
  assert.match(out.reason, new RegExp(`${J}: factory next asked for`));
  assert.match(out.reason, /shown once/);
  // the continuation, a fresh stop, a new human prompt: never again for this decision
  assert.equal(stop(root, { stop_hook_active: true }).stdout, '');
  assert.equal(stop(root, { stop_hook_active: false }).stdout, '');
  prompt(root, '/factory:start');
  assert.equal(stop(root).stdout, '', 'a new turn does not re-arm the same decision');
  const ev = events(root).filter((e) => e.event === 'stop_block');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].decision_id, d.decision_id);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.factory', 'stop-blocks.json'), 'utf8')).blocked, [d.decision_id]);
  // snake-case (PascalCase-registered) payloads work the same; nothing to block here
  assert.equal(hook('stop.js', { hook_event_name: 'Stop', cwd: root, transcript_path: '/nope', stop_reason: 'end_turn', stop_hook_active: false }).stdout, '');
});

test('agentStop: a turn that only answered the user is never blocked', () => {
  const root = F.makeRepo();
  F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']);
  F.cli(root, ['next']);
  // "what does src/add.js do?" — not a factory prompt, and no factory command ran this turn
  prompt(root, 'what does src/add.js do?');
  assert.equal(stop(root).stdout, '');
  assert.equal(stop(root, { stop_hook_active: true }).stdout, '');
  // no prompt stamp at all (unknown turn): allowed
  fs.rmSync(path.join(root, '.factory', 'turn.json'));
  assert.equal(stop(root).stdout, '');
  // the same question, but the agent ran a factory command during the turn: factory work
  prompt(root, 'what does src/add.js do?');
  F.cli(root, ['next']);
  assert.ok(blocked(stop(root)));
  assert.equal(events(root).filter((e) => e.event === 'stop_block').length, 1);
});

test('agentStop: never blocks once the assigned step was attempted, or while a factory run is in progress', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  prompt(root, '/factory:start');
  F.cli(root, ['next']);
  // any non-looking factory command under the decision counts as an attempt (here: wfargs)
  F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.equal(stop(root).stdout, '', 'wfargs ran under the decision');
  // a live run.lock: `factory run` is still working (e.g. backgrounded by the shell tool)
  const root2 = F.makeRepo();
  const J2 = F.cli(root2, ['job', 'new', '--title', 'y', '--type', 'bug', '--risk', 'low']).job;
  prompt(root2, '/factory:start');
  F.cli(root2, ['next']);
  const lock = path.join(F.jobDir(root2, J2), 'run.lock');
  const sleeper = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: sleeper.pid, host: require('os').hostname(), started_at: new Date().toISOString(), workflow: 'fanout-judge' }));
    assert.equal(stop(root2).stdout, '', 'a factory run is in progress');
  } finally {
    sleeper.kill();
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, host: require('os').hostname(), started_at: new Date().toISOString() }));
  assert.ok(blocked(stop(root2)), 'a stale lock is no run');
});

test('agentStop: never blocks while the human is the one to act', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  prompt(root, '/factory:start');
  // no routing decision yet (fresh job): nothing was assigned
  assert.equal(stop(root).stdout, '', 'fresh job');
  // clarify's read-back waits for the user: waiting
  F.cli(root, ['next']);
  const b = F.cli(root, ['wfargs', 'clarify']);
  assert.equal(F.record(root, F.envelope(b, 'ok', { stage: 'readback', rev: b.rev, outputs: { 'read-back': { intent: { problem: 'p', who: 'w', outcome: 'o', success: 's' }, scope: { in: [], out: [] }, took: [], pins: [], plan: [], questions: [{ item: 'new', question: 'Floats too?', why: 'scope' }] } } })).status, 'needs_user');
  assert.equal(stop(root).stdout, '', 'the read-back waits for the user');
  assert.match(require('../cli/core/clarify').waitingForUser(root, require('../cli/core/job').load(root, J)), /read-back waits/);
  F.cli(root, ['next']);
  assert.equal(stop(root).stdout, '', 'still the read-back after factory next');
  F.cli(root, ['clarify', 'reply', 'ok']);
  assert.equal(stop(root).stdout, '', 'the reply was recorded and no factory next since');
  F.cli(root, ['next']);
  // a closing question or hand-off to the user is waiting too (payload- or transcript-borne)
  for (const m of ['I updated the contract. Should floats be supported too?', '1. Which database?\n2. Which env?\n\nLet me know and I will continue.', 'Please answer the questions above.', 'Should I go ahead? 🙂', 'Shall I continue? [y/n]', 'Want me to proceed? Let me know.', 'Q1…?\nQ2…?\n\nReply with your answers.', 'Dry run looks good: 1 integrator agent would run. Reply and I will start it.', 'Would you like me to start the clarify round now?', 'Waiting for your go-ahead.']) {
    assert.equal(stop(root, { last_assistant_message: m }).stdout, '', m);
    assert.equal(stop(root, { transcriptPath: transcript(root, asked('go'), said(m)) }).stdout, '', `transcript: ${m}`);
  }
  // the H1 gate: waiting on the human
  F.cli(root, ['clarify', 'reply', '1: no, integers only']);
  F.clarify(root);
  assert.equal(F.cli(root, ['next']).action, 'gate');
  assert.equal(stop(root).stdout, '', 'pending gate');
  assert.equal(stop(root, { last_assistant_message: 'All done! The fix is complete.' }).stdout, '', 'at a gate, even a "done" claim is not blocked');
  // parked: waiting on the human
  F.cli(root, ['park', '--reason', 'later']);
  assert.equal(stop(root).stdout, '');
  // no factory here at all
  assert.equal(stop(path.dirname(root)).stdout, '');
  assert.equal(events(root).filter((e) => e.event === 'stop_block').length, 0);
});

test('agentStop: reads only the current turn\'s message from the transcript; a stale one is unknown', () => {
  const { lastAssistantText } = require('../hooks/stop');
  const root = F.makeRepo();
  assert.equal(lastAssistantText(transcript(root, asked('a'), said('old answer?'), asked('b'))), null, 'the user spoke last: this turn is not written yet');
  assert.equal(lastAssistantText(transcript(root, asked('a'), said('first'), { type: 'tool.execution_complete', data: {} }, said('second'), 'not json')), 'second');
  assert.equal(lastAssistantText(transcript(root, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'claude-shaped' }] } })), 'claude-shaped');
  // a stale question from the previous turn does not excuse this one, and a "done" claim sharpens the reason
  F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']);
  prompt(root, '/factory:start');
  F.cli(root, ['next']);
  const r = stop(root, { transcriptPath: transcript(root, asked('a'), said('Should I continue?'), asked('/factory:start'), said('All done! The fix is complete.')) });
  assert.match(JSON.parse(r.stdout).reason, /^\[factory stop gate\] Not done — /);
});

test('stop: done-claim and question heuristics', () => {
  const { claims, asksUser } = require('../hooks/stop');
  for (const m of ['The fix is now complete and ready to merge.', "I've completed the task.", 'Everything is done.', "That's done!", 'Shipped.', 'All done 🎉']) assert.ok(claims(m), m);
  for (const m of ['I drafted the contract; waiting for your answers.', 'Is the fix complete?', 'The fix is not done yet.', 'Once the job is done, I will open the PR.', "The task isn't finished: tests fail."]) assert.ok(!claims(m), m);
  assert.ok(asksUser('Done with step one.\n\nWhich database should I use?'));
  for (const m of ['Let me know which one.', 'Approve or deny the contract.', 'Should I run it', 'Waiting for you.', '**Do you want me to continue?**', 'Reply `approve` to go on.']) assert.ok(asksUser(m), m);
  for (const m of ['I fixed the parser.\n\nNext I will run the tests.', 'Is it fast? Yes.\n\nI ran the benchmark and moved on.', '', null]) assert.ok(!asksUser(m), String(m));
});

test('agentStop: never gates an agent session started by factory run', () => {
  const root = F.makeRepo();
  F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']);
  F.cli(root, ['next']);
  const r = spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'stop.js'), 'agentStop'], { input: JSON.stringify({ cwd: root }), encoding: 'utf8', env: { ...process.env, FACTORY_RUNNER: '1' } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'a runner agent ends its turn freely; its result goes through factory record');
});

// --- agents started by `factory run` (FACTORY_RUNNER=1) -----------------------------------

const AGENT_ENV = { FACTORY_RUNNER: '1', FACTORY_JOB: 'J-0001', FACTORY_AGENT_ROLE: 'tester', FACTORY_AGENT_LABEL: 'test T1' };
const agentHook = (name, input, event, extra = {}) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', name), ...(event ? [event] : [])], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...AGENT_ENV, ...extra } });
const CLI = `node "${path.join(F.PLUGIN, 'bin', 'factory')}"`;

test('agent sessions: a short role note at session start, no reply parsing, no counter reset', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  const note = JSON.parse(agentHook('session-start.js', { source: 'startup', cwd: root }, 'sessionStart', { FACTORY_ROOT: root }).stdout).additionalContext;
  assert.match(note, new RegExp(`factory agent "tester" for job ${J}`));
  assert.match(note, /never run factory next, run, record, wfargs, ship, close/i);
  assert.match(note, /approve/);
  assert.doesNotMatch(note, /one JSON object/, 'the strict reply block of the runner owns the JSON-only rule');
  assert.doesNotMatch(note, /Current job|factory:start/, 'never told to drive the job');
  // the prompt hook does nothing in an agent: no reply applied, the main session's counter kept
  fs.writeFileSync(path.join(root, '.factory', 'stop-blocks.json'), JSON.stringify({ blocked: ['J-0001-D0001'], at: new Date().toISOString() }));
  const r = agentHook('prompt.js', { prompt: 'cancel job', cwd: root }, 'userPromptSubmitted');
  assert.deepEqual([r.status, r.stdout], [0, '']);
  assert.ok(fs.existsSync(path.join(root, '.factory', 'stop-blocks.json')), 'the main session\'s stop record survives an agent spawn');
  assert.ok(!fs.existsSync(path.join(root, '.factory', 'turn.json')), 'an agent prompt is no turn of the main session');
  assert.equal(F.cli(root, ['job', 'show']).status, 'active', 'a prompt in an agent is never a human reply');
  // activity lines carry the agent's role, not "main session"
  agentHook('activity.js', { toolName: 'bash', toolArgs: { command: 'npm test' }, cwd: root }, 'postToolUse');
  const line = events(root).filter((e) => e.event === 'PostToolUse').pop();
  assert.equal(line.agent_type, 'factory:tester');
  assert.equal(line.job, J);
  assert.equal(line.runner, true);
});

test('agent sessions: the guard denies driving the job and human commands, allows what briefs ask for', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  const g = (command) => agentHook('guard.js', { toolName: 'bash', toolArgs: { command }, cwd: root }, 'preToolUse', { FACTORY_ROOT: root });
  const R = `${CLI} --root "${root}"`;
  for (const c of ['next', 'run realize --scope all', 'record --file x.json', 'wfargs ground', 'ship', 'close', 'init', 'job new --title y', 'amend start', 'park --reason later', 'followup', 'epic spawn', 'distill done', 'use J-0002', 'answer --id Q-1 --answer no', 'evidence add AC1 --type doc', 'verify run', 'approve', 'lessons accept L1']) {
    const r = g(`${R} ${c}`);
    assert.ok(isDeny(r), `agent may not run factory ${c}`);
  }
  assert.match(JSON.parse(g(`${R} next`).stdout).permissionDecisionReason, /not for a factory agent/);
  assert.ok(isDeny(g(`F=${path.join(F.PLUGIN, 'bin', 'factory')}; node $F next`)), 'through a variable');
  for (const c of [`task verify T1 --job ${J}`, `task start T1 --job ${J}`, `task show T1 --job ${J}`, `plan validate --job ${J}`, `reconcile run --job ${J}`, `reconcile continue --job ${J}`, `reconcile abort --job ${J}`, `doc check "${path.join(root, '.factory', 'jobs', J, 'adr-0001.md')}" --job ${J}`, 'doc template threat-model', 'contract show', 'contract check', 'lessons list', `lessons add --job ${J} --text x --scope src --why y`, 'why', 'job show', 'help']) {
    assert.ok(isAllow(g(`${R} ${c}`)), `agent may run factory ${c}`);
  }
  assert.ok(isAllow(g('npm test && git -C . log --oneline -3')));
  // the same commands are fine for the main session
  assert.ok(isAllow(guard({ toolName: 'bash', toolArgs: { command: `${R} next` }, cwd: root })));
  // the denial names the agent
  const deny = events(root).filter((e) => e.event === 'guard_deny').pop();
  assert.equal(deny.agent_type, 'factory:tester');
  // the stop gate never blocks an agent (see also below), and the brief's doc check is not an "inline script"
  assert.ok(isAllow(guard({ toolName: 'bash', toolArgs: { command: `${R} doc check "${path.join(root, '.factory', 'jobs', J, 'adr-0001.md')}" --job ${J}` }, cwd: root })));
});

test('factory next: a notice when chat replies are not reaching the factory (dead prompt hook), once per wait', () => {
  const toH1 = (root, J) => {
    fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
    F.clarify(root);
    return F.cli(root, ['next']);
  };
  const job = (root) => F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  // the prompt hook never ran in this repo: said at the first wait, once
  let root = F.makeRepo();
  let J = job(root);
  F.cli(root, ['next']);
  let n = toH1(root, J);
  assert.equal(n.step, 'H1');
  assert.match(n.notice, /Chat replies aren't reaching the factory: no chat prompt has ever reached/);
  for (const re of [/Chat: Configure Hooks/, /GitHub Copilot Chat Hooks/, /chat\.useHooks/, /Workspace Trust/, /\/plugin list/, /Session Target/, new RegExp(`factory approve H1 --job ${J}`), /shows a short code on that terminal/]) assert.match(n.notice, re);
  assert.equal(F.cli(root, ['next']).notice, undefined, 'once per wait');
  // hooks ran before the gate, then nothing since it opened: said on the next look
  root = F.makeRepo();
  J = job(root);
  prompt(root, '/factory:start fix add');
  F.cli(root, ['next']);
  n = toH1(root, J);
  assert.equal(n.notice, undefined, 'the first presentation of a gate is not a symptom');
  n = F.cli(root, ['next']);
  assert.match(n.notice, /since it started waiting on H1/);
  assert.equal(F.cli(root, ['next']).notice, undefined);
  // a prompt arrived after the gate opened: the hook works, no notice
  root = F.makeRepo();
  J = job(root);
  prompt(root, '/factory:start fix add');
  F.cli(root, ['next']);
  toH1(root, J);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  prompt(root, 'what does the contract say about negatives?');
  assert.equal(F.cli(root, ['next']).notice, undefined);
  assert.equal(F.cli(root, ['next']).notice, undefined);
  // not a wait on the human: never
  assert.equal(require('../cli/core/reply-watch').humanWait({ job: J, action: 'skill', skill: 'clarify' }), null);
  assert.ok(require('../cli/core/reply-watch').humanWait({ job: J, action: 'parked', reason: 'r' }));
});

// --- VS Code Local harness ------------------------------------------------------------------

// Local payloads: snake_case, hook_event_name, VS Code tool names (no argv event: Local maps
// the camelCase registration but sends its own event name).
const local = (name, event, extra) => hook(name, { timestamp: '2026-10-14T00:00:00Z', hook_event_name: event, session_id: 'vs1', ...extra });

test('VS Code Local: tool names map to the rules\' names, with their path and command fields', () => {
  const n = (tool_name, tool_input) => lib.normalise({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't1' });
  const t = n('run_in_terminal', { command: 'npm test', explanation: 'run tests', isBackground: false });
  assert.deepEqual([t.event, t.tool, t.command, t.toolUseId], ['PreToolUse', 'Bash', 'npm test', 't1']);
  for (const name of ['runInTerminal', 'execute/runInTerminal', 'run_in_terminal']) assert.equal(n(name, { command: 'ls' }).tool, 'Bash', name);
  for (const [name, input, tool, file] of [
    ['editFiles', { filePath: 'src/a.js', newString: 'x' }, 'Edit', 'src/a.js'],
    ['replace_string_in_file', { filePath: 'src/a.js', oldString: 'a', newString: 'b' }, 'Edit', 'src/a.js'],
    ['insert_edit_into_file', { filePath: 'src/b.js', code: 'y', explanation: 'e' }, 'Edit', 'src/b.js'],
    ['createFile', { filePath: 'src/c.js', content: 'z' }, 'Write', 'src/c.js'],
    ['create_file', { filePath: 'src/c.js', content: 'z' }, 'Write', 'src/c.js'],
    ['readFile', { filePath: 'src/a.js', startLine: 1, endLine: 9 }, 'Read', 'src/a.js'],
    ['read_file', { filePath: 'src/a.js' }, 'Read', 'src/a.js'],
    ['textSearch', { query: 'x' }, 'Grep', null],
    ['grep_search', { query: 'x', includePattern: '*.pem' }, 'Grep', null],
    ['fileSearch', { query: '**/*.js' }, 'Glob', null],
    ['file_search', { query: '**/*.js' }, 'Glob', null],
    ['runSubagent', { prompt: 'p', description: 'd' }, 'Task', null],
  ]) {
    const r = n(name, input);
    assert.deepEqual([r.tool, r.file], [tool, file], name);
  }
  assert.equal(n('insert_edit_into_file', { filePath: 'b.js', code: 'y' }).content, 'y');
  assert.equal(n('grep_search', { query: 'x', includePattern: '*.pem' }).args.glob, '*.pem', 'includePattern is the Grep glob filter');
  const multi = n('multi_replace_string_in_file', { explanation: 'e', replacements: [{ filePath: 'a.js', oldString: 'a', newString: 'b' }, { filePath: '.factory/current', oldString: 'c', newString: 'd' }] });
  assert.deepEqual([multi.tool, multi.files.map((f) => f.path)], ['MultiEdit', ['a.js', '.factory/current']]);
});

test('VS Code Local: every output carries both shapes in one object', () => {
  const root = F.makeRepo();
  // PreToolUse deny: flat Copilot fields + hookSpecificOutput
  const d = JSON.parse(local('guard.js', 'PreToolUse', { cwd: root, tool_name: 'run_in_terminal', tool_input: { command: 'factory approve', explanation: 'x', isBackground: false }, tool_use_id: 't1' }).stdout);
  assert.equal(d.permissionDecision, 'deny');
  assert.deepEqual(d.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.permissionDecisionReason });
  assert.match(d.permissionDecisionReason, /human-only/);
  // writes and reads through VS Code's tools get the same rules
  assert.ok(isDeny(local('guard.js', 'PreToolUse', { cwd: root, tool_name: 'replace_string_in_file', tool_input: { filePath: '.factory/policy.json', oldString: 'a', newString: 'b' } })));
  assert.ok(isDeny(local('guard.js', 'PreToolUse', { cwd: root, tool_name: 'multi_replace_string_in_file', tool_input: { replacements: [{ filePath: 'src/add.js', oldString: 'a', newString: 'b' }, { filePath: '.factory/current', oldString: 'a', newString: 'b' }] } })));
  assert.ok(isDeny(local('guard.js', 'PreToolUse', { cwd: root, tool_name: 'createFile', tool_input: { filePath: '.git/hooks/pre-commit', content: 'x' } })));
  assert.ok(isAllow(local('guard.js', 'PreToolUse', { cwd: root, tool_name: 'createFile', tool_input: { filePath: 'src/new.js', content: 'module.exports = 1;' } })));
  assert.ok(isAllow(local('guard.js', 'PreToolUse', { cwd: root, tool_name: 'run_in_terminal', tool_input: { command: 'npm test', explanation: 'x', isBackground: false } })));
  // SessionStart: additionalContext both ways
  const s = JSON.parse(local('session-start.js', 'SessionStart', { cwd: root, source: 'new' }).stdout);
  assert.deepEqual(s.hookSpecificOutput, { hookEventName: 'SessionStart', additionalContext: s.additionalContext });
  // UserPromptSubmit: Local shows only systemMessage to the user; the reply is applied either way
  const p = JSON.parse(local('prompt.js', 'UserPromptSubmit', { cwd: root, prompt: 'approve' }).stdout);
  assert.match(p.additionalContext, /NOT applied/);
  assert.match(p.systemMessage, /^\[factory\] Your reply was NOT applied: /);
  assert.equal(p.hookSpecificOutput, undefined);
  assert.ok(fs.existsSync(path.join(root, '.factory', 'turn.json')), 'the prompt stamp is written in Local too');
  // Stop: block both ways; a custom agent's stop reported as SubagentStop is not gated
  F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']);
  local('prompt.js', 'UserPromptSubmit', { cwd: root, prompt: '/factory:start fix add' });
  F.cli(root, ['next']);
  assert.equal(local('stop.js', 'SubagentStop', { cwd: root, agent_id: 'a1', agent_type: 'builder', stop_hook_active: false }).stdout, '');
  const b = JSON.parse(local('stop.js', 'Stop', { stop_hook_active: false, cwd: root }).stdout);
  assert.equal(b.decision, 'block');
  assert.deepEqual(b.hookSpecificOutput, { hookEventName: 'Stop', decision: 'block', reason: b.reason });
  assert.deepEqual(Object.keys(lib.blockOutput('r', 'SubagentStop')).sort(), ['decision', 'reason'], 'SubagentStop reads the top-level fields');
});

test('VS Code Local: human-only verbs through a command runner the guard does not know', () => {
  const root = F.makeRepo();
  const g = (tool_name, tool_input) => local('guard.js', 'PreToolUse', { cwd: root, tool_name, tool_input });
  const B = path.join(F.PLUGIN, 'bin', 'factory');
  // runners we don't know: their command-like arguments are read as commands
  assert.ok(isDeny(g('mcp_terminal_execute', { command: 'factory approve H2' })));
  assert.ok(isDeny(g('run_task', { script: `node "${B}" resume` })));
  assert.ok(isDeny(g('mcp__shell__run', { command: 'factory', args: ['lessons', 'accept', 'L1'] })));
  assert.ok(isDeny(g('some_ext_runner', { input: { commandLine: 'cd x && factory waive F1' } })));
  assert.ok(isDeny(g('create_and_run_task', { task: { label: 'x', command: 'factory cancel' } })));
  assert.ok(isDeny(g('some_mcp_tool', { cmd: 'factory deny H1 "no"' })), 'a command field on any unknown tool');
  // mentions are data: command position only, and content / prose fields are not commands
  assert.ok(isAllow(g('mcp_terminal_execute', { command: 'echo "reply factory approve in chat"' })));
  assert.ok(isAllow(g('mcp_terminal_execute', { command: 'npm test', explanation: 'then the user runs factory approve' })));
  assert.ok(isAllow(g('some_mcp_tool', { content: 'factory approve', text: 'factory approve' })), 'not a runner: only command-named fields');
  assert.ok(isAllow(g('replace_string_in_file', { filePath: 'README.md', oldString: 'a', newString: 'factory approve' })), 'edit content that mentions a verb');
  assert.ok(isAllow(g('mcp_terminal_execute', { command: 'git push --force' })), 'for an unknown runner, only the factory-CLI rules apply');
  assert.ok(isAllow(g('runSubagent', { prompt: 'run factory approve', description: 'x' })));
});

// --- guard bypasses -------------------------------------------------------------------------

test('guard: Copilot shell-session tools, interactive shells, and human commands through indirection', () => {
  const root = F.makeRepo();
  const bash = (command) => guard({ toolName: 'bash', toolArgs: { command }, cwd: root });
  const B = path.join(F.PLUGIN, 'bin', 'factory');
  // write_bash input is a command; read/stop/list_bash are not guarded
  assert.ok(isDeny(guard({ toolName: 'write_bash', toolArgs: { shellId: 's1', input: `node ${B} approve\n` }, cwd: root })));
  assert.ok(isDeny(guard({ toolName: 'write_powershell', toolArgs: { shellId: 's1', input: 'git push --force\n' }, cwd: root })));
  assert.ok(isAllow(guard({ toolName: 'write_bash', toolArgs: { shellId: 's1', input: 'y\n' }, cwd: root })));
  for (const t of ['read_bash', 'stop_bash', 'list_bash']) assert.ok(isAllow(guard({ toolName: t, toolArgs: { shellId: 's1' }, cwd: root })), t);
  assert.equal(lib.toolName('write_bash', {}), 'Bash');
  assert.equal(lib.toolName('read_bash', {}), 'BashOutput');
  // interactive shells
  for (const c of ['bash', 'sh', 'zsh -l', 'bash -i', 'exec bash', 'sudo bash']) assert.ok(isDeny(bash(c)), c);
  for (const c of ['bash -c "npm test"', 'bash scripts/build.sh', 'echo ls | sh', 'sh < script.sh']) assert.ok(isAllow(bash(c)), c);
  // human-only verbs through variables, $(…), xargs, eval, aliases, functions, heredocs to a shell
  for (const c of [
    `F=${B}; node $F approve`,
    `F="${B}"; node "$F" resume`,
    '$(which factory) resume',
    'node "$(command -v factory)" approve H1',
    `echo approve | xargs node ${B}`,
    `eval "node ${B} app""rove"`,
    `alias f=${B}; f merged abc123`,
    `f() { node ${B} "$@"; }; f cancel`,
    `bash <<'EOF'\nnode ${B} approve\nEOF`,
    `cat <<'EOF' | sh\nnode ${B} waive AC1\nEOF`,
    `node ${B} lessons accept L1`,
  ]) assert.ok(isDeny(bash(c)), c);
  for (const c of [`node ${B} job show | grep -i approve`, 'git commit -m "approve flow"', `git commit -F - <<'EOF'\nnode ${B} approve\nEOF`, 'grep -rn approve src/', `node ${B} park --reason "waiting to approve"`]) assert.ok(isAllow(bash(c)), c);
});

test('guard: rg and glob `paths` (string or array) get the read rules', () => {
  const root = F.makeRepo();
  const secretDir = path.dirname(require('../cli/lib/seal').secretFile());
  assert.ok(isDeny(guard({ toolName: 'rg', toolArgs: { pattern: '.', paths: secretDir }, cwd: root })));
  assert.ok(isDeny(guard({ toolName: 'rg', toolArgs: { pattern: '.', paths: ['src', secretDir] }, cwd: root })));
  assert.ok(isDeny(guard({ toolName: 'glob', toolArgs: { pattern: '*', paths: [secretDir] }, cwd: root })));
  assert.ok(isAllow(guard({ toolName: 'rg', toolArgs: { pattern: 'add', paths: ['src'] }, cwd: root })));
});

// --- stop gate: continuation prompts ----------------------------------------------------------

test('agentStop: block reasons and Autopilot continuations fed back as prompts are not a new turn', () => {
  const root = F.makeRepo();
  F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']);
  prompt(root, '/factory:start');
  const turn = fs.readFileSync(path.join(root, '.factory', 'turn.json'), 'utf8');
  assert.equal(JSON.parse(turn).factory, true);
  F.cli(root, ['next']);
  const r = stop(root);
  assert.ok(blocked(r));
  const reason = JSON.parse(r.stdout).reason;
  // what Copilot does with a block: the reason becomes the next prompt — not the human, no new turn
  assert.equal(prompt(root, reason).stdout, '');
  prompt(root, 'You have not yet marked the task as complete using the task_complete tool. Continue.');
  assert.equal(fs.readFileSync(path.join(root, '.factory', 'turn.json'), 'utf8'), turn, 'continuations keep the turn stamp');
  assert.equal(stop(root, { stop_hook_active: true }).stdout, '');
  assert.ok(lib.isContinuation(reason) && !lib.isContinuation('please continue'));
  // a human prompt stamps a new turn; a factory reply counts as factory work, other text does not
  prompt(root, 'please continue');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.factory', 'turn.json'), 'utf8')).factory, false);
  prompt(root, 'resume');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.factory', 'turn.json'), 'utf8')).factory, true);
  assert.ok(fs.existsSync(path.join(root, '.factory', 'stop-blocks.json')), 'prompts never reset the blocked-decisions record');
});

test('Autopilot: its continuation prompt is recorded; factory next and doctor warn while it is recent', () => {
  const root = F.makeRepo();
  F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']);
  assert.equal(F.cli(root, ['next']).autopilot, undefined, 'nothing seen, no warning');
  assert.ok(!F.cli(root, ['doctor']).checks.some((c) => c.name === 'copilot autopilot'));
  const r = prompt(root, 'You have not yet marked the task as complete using the task_complete tool. Continue.');
  assert.match(r.stdout, /Autopilot was detected/, 'the agent is told at once');
  prompt(root, 'You have not yet marked the task as complete using the task_complete tool. Continue.');
  const rec = JSON.parse(fs.readFileSync(path.join(root, '.factory', 'autopilot.json'), 'utf8'));
  assert.equal(rec.count, 2);
  const ev = fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.event === 'autopilot_seen');
  assert.equal(ev.length, 1, 'one event per session');
  const n = F.cli(root, ['next']);
  assert.match(n.autopilot.warning, /switch back to interactive mode/);
  assert.equal(F.cli(root, ['doctor']).checks.find((c) => c.name === 'copilot autopilot').level, 'warning');
  // an old sighting no longer warns
  rec.last_at = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
  fs.writeFileSync(path.join(root, '.factory', 'autopilot.json'), JSON.stringify(rec));
  assert.equal(F.cli(root, ['next']).autopilot, undefined);
  assert.ok(!lib.isAutopilot('please continue') && lib.isAutopilot('You have not yet marked the task as complete using the task_complete tool'));
});

// --- guard: every false positive from the real-CLI reproduction is allowed ---------------------

test('guard regressions: prose, patterns, messages, expansions and templates are not violations', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  const { checkBash, checkContent, checkReadTool } = require('../hooks/guard-rules');
  const pol = require('../cli/core/policy').load(root);
  const B = path.join(F.PLUGIN, 'bin', 'factory');
  const main = [
    // the word "factory" next to a human-only verb, in data
    'grep -rn "factory approve" docs/',
    "grep -rn 'factory approve' docs/",
    'git grep -n "factory approve"',
    'grep -rn -e "factory approve" -e "factory deny" .',
    'rg "factory resume" .',
    'rg factory resume .',
    'grep -rn factory\\ approve docs/',
    "echo 'Next: reply resume, or run factory resume'",
    'printf "%s\\n" "factory approve"',
    "git log --oneline --grep 'factory merged'",
    'gh pr create --title x --body "After CI, run factory approve to ship"',
    'gh pr comment 3 --body "factory deny <reason> if it looks wrong"',
    'git commit -F - <<EOF\nfeat: factory confirm wording\nEOF',
    'cat > PR.md <<EOF\nAfter review run factory approve\nEOF',
    'echo "$HOME" && grep -n "factory" README.md | grep cancel',
    `node "${B}" record --file - <<EOF\n{"summary":"the factory deny path"}\nEOF`,
    'git commit -m "docs: explain factory approve" && git push origin main',
    `node "${B}" park --reason "factory resume later, after legal"`,
    // commands that start with an expansion
    '$HOME/.local/bin/ruff check .',
    '"$VIRTUAL_ENV/bin/python" -m pytest',
    '$PWD/scripts/x.sh',
    "$env:PATH -split ';'",
    '& "$env:ProgramFiles\\nodejs\\node.exe" --version',
    '$env:NODE_ENV="test"; npm test',
    // interpreters and factory paths in other commands, prose or read-only code
    'npm run lint && node ./scripts/check.js .factory/project.json',
    'git add -A && git commit -m "chore: ignore .factory/log" && python3 -V',
    "python3 -c \"import os;print(os.listdir('.factory/jobs'))\"",
    "python3 -c \"import json;[print(json.loads(l)['event']) for l in open('.factory/log/events.jsonl')]\"",
    // git objects that are not secrets
    'git show HEAD:.env.example',
    'git show HEAD~1 -- .env.example',
    'git show HEAD:docs/credentials-setup.md',
    'git show HEAD:.env.sample && git show HEAD:config/.env.dist',
    // flags that only look like -n / interactive shells
    "git show --stat HEAD -n 1 --format='commit %H'",
    'git commit -m wip; npm test -- -n 5',
    'git log -n 3 --format=%s | grep commit',
    'bash --version',
    'sh --help',
    // redirects and templates
    'ls .factory/ 2>/dev/null; echo done >&2',
    'cp .env.example .env.sample',
    'cat .env.example .env.template',
  ];
  for (const c of main) assert.equal(checkBash(root, c, pol), null, `main session should allow: ${c}`);
  // runner agents: the same data rules, plus a briefed doc check from a plugin path with a space
  const spaced = `node "/c/Users/John Smith/.copilot/installed-plugins/copilot-factory/factory/bin/factory" --root "${root}"`;
  const agent = [
    `grep -rn "factory resume" ${path.join(root, '.factory', 'jobs', J, 'contract.md')}`,
    `${spaced} doc check "${path.join(root, '.factory', 'jobs', J, 'adr-0001 with space.md')}" --job ${J}`,
    `${spaced} doc check ${path.join(root, '.factory', 'jobs', J, 'adr-0001.md')} --job ${J}`,
    `node "${B}" lessons add --job ${J} --text "x" --scope src --why "the deny path crashed when $HOME was unset"`,
    `git -C .factory/worktrees/${J}-T1 commit -m "approve flow; resume after deny"`,
  ];
  for (const c of agent) assert.equal(checkBash(root, c, pol, { agent: true }), null, `agent should allow: ${c}`);
  // writes and reads through the tools
  assert.ok(isAllow(guard({ toolName: 'create', toolArgs: { path: '.env.example', file_text: 'A=' }, cwd: root })), 'create .env.example');
  assert.ok(isAllow(guard({ toolName: 'create', toolArgs: { path: 'config/app.env.dist', file_text: 'A=' }, cwd: root })));
  assert.equal(checkReadTool(root, 'Grep', { pattern: 'x', glob: '*.key*' }, null, root, pol), null, '*.key* also matches keyboard.js');
  // source that merely mentions factory paths in comments or prose
  assert.equal(checkContent('from os import path\n# see cli/core/ for details\n', '/r/src/importer.py'), null);
  assert.equal(checkContent("const {readFileSync}=require('fs');// parses .factory/log/events.jsonl format\n", '/r/test/log.test.js'), null);
  assert.equal(checkContent("// reads .factory/current\nconst x = require('./x');\nconst note = 'see .factory/jobs';\n", '/r/src/a.js'), null);
  assert.ok(isAllow(guard({ toolName: 'create', toolArgs: { path: 'src/importer.py', file_text: 'from os import path\n# see cli/core/ for details\n' }, cwd: root })));
});

test('guard regressions: the real violations still deny, however they are typed', () => {
  const root = F.makeRepo();
  const { checkBash, checkContent, checkReadTool } = require('../hooks/guard-rules');
  const pol = require('../cli/core/policy').load(root);
  const B = path.join(F.PLUGIN, 'bin', 'factory');
  const denied = [
    `node "${B}" approve`,
    `NODE_OPTIONS= node "${B}" --root . resume`,
    `env FOO=1 node ${B} cancel`,
    `sudo -u me factory abandon`,
    `nice -n 5 factory waive AC1`,
    `timeout 30 factory merged abc123`,
    `exec factory confirm AC-1`,
    `echo x; factory approve && echo y`,
    `bash -c "factory approve"`,
    `sh -lc 'node ${B} deny "no"'`,
    `echo "$(factory approve)"`,
    'echo `factory resume`',
    `X=$(command -v factory); $X approve`,
    `F=${B}; node "$F" approve`,
    `echo approve | xargs node ${B}`,
    `printf 'node ${B} approve' | bash`,
    `find . -name x -exec node ${B} approve \;`,
    `factory ci install`,
    'git push --force-with-lease origin main',
    'git commit -anm "x"',
    'git config core.hooksPath /tmp/h',
    'ln -sf ../../x .git/hooks/pre-commit',
    'sed -i s/a/b/ .factory/jobs/J-0001/state.json',
    'cp x.json .factory/policy.json',
    'git show HEAD:.env.local',
    'git show HEAD -- config/.npmrc',
    'cat .env.production',
    "node -e \"require('fs').writeFileSync('.factory/jobs/J-0001/state.json','{}')\"",
    'cat ~/.config/software-factory/secret',
    'bash -i',
    'cp .env.example .env',
  ];
  for (const c of denied) assert.ok(checkBash(root, c, pol), `should deny: ${c}`);
  assert.ok(checkReadTool(root, 'Grep', { pattern: 'x', glob: '.env*' }, null, root, pol));
  assert.ok(checkReadTool(root, 'Grep', { pattern: 'x', glob: '**/*.pem' }, null, root, pol));
  assert.ok(checkContent("const fs=require('fs');console.log(fs.readFileSync('.factory/current','utf8'))", '/r/scripts/status.js'));
  // runner agents: driving the job, and scripts on job files
  for (const c of [`node "${B}" next`, `node "${B}" plan from-contract`, `python3 -m json.tool .factory/jobs/J-0001/plan.json`, `ls | xargs node ${B} job show`]) assert.ok(checkBash(root, c, pol, { agent: true }), `agent should be denied: ${c}`);
});

test('guard: terminal emulators are allowed unless they wrap the factory CLI; the deny names the command', () => {
  const root = F.makeRepo();
  const run = (command, env = {}) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'guard.js'), 'preToolUse'], { input: JSON.stringify({ cwd: root, toolName: 'bash', toolArgs: { command } }), encoding: 'utf8', env: { ...process.env, ...env } });
  const agentEnv = { FACTORY_RUNNER: '1', FACTORY_JOB: 'J-0001', FACTORY_AGENT_ROLE: 'test-reviewer', FACTORY_ROOT: root };
  // seen in a real run: "Guard Blocked Bash: empty (terminal emulation) is not allowed here, by factory:test-reviewer"
  for (const c of ['empty', 'empty -f -i in -o out npm test', 'unbuffer npm test', 'script -q -c "npm test" log.txt', 'script -q /dev/null npm test']) {
    assert.ok(isAllow(run(c)), `main session: ${c}`);
    assert.ok(isAllow(run(c, agentEnv)), `agent: ${c}`);
  }
  for (const c of ['unbuffer factory approve', 'script -c "factory approve" /dev/null', 'expect -c "spawn factory approve; interact"', 'empty -f node /x/bin/factory resume']) {
    const r = run(c);
    assert.ok(isDeny(r), `denied: ${c}`);
    assert.match(JSON.parse(r.stdout).permissionDecisionReason, /\(command: ".+"\)$/, 'the reason quotes the command it saw');
  }
});
