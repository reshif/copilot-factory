'use strict';
// The hooks under the GitHub Copilot CLI: payloads in both casings (camelCase toolName/
// toolArgs as a JSON string or object; PascalCase tool_name/tool_input), runtime tool names
// (bash, view, create, edit, str_replace_editor, apply_patch, grep, glob), path vs
// file_path, the flat output shapes and exit codes, the stop gate and the last-reply file.

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
const isDeny = (r) => r.status === 2 && JSON.parse(r.stdout).permissionDecision === 'deny' && /\[factory guard\]/.test(r.stderr);
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

test('guard: Copilot deny = flat JSON on stdout + exit 2 + reason on stderr, both casings', () => {
  const root = F.makeRepo();
  assert.ok(isDeny(guard({ toolName: 'bash', toolArgs: JSON.stringify({ command: 'git push --force' }), cwd: root })));
  assert.ok(isDeny(guard({ toolName: 'bash', toolArgs: { command: 'git push --force' }, cwd: root })));
  assert.ok(isDeny(guard({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force' }, cwd: root })));
  const out = JSON.parse(guard({ toolName: 'bash', toolArgs: { command: 'git push --force' }, cwd: root }).stdout);
  assert.deepEqual(Object.keys(out).sort(), ['permissionDecision', 'permissionDecisionReason']);
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

test('hooks.json: native Copilot format, every event, plugin-root env var, no matchers', () => {
  const H = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(H.version, 1);
  assert.deepEqual(Object.keys(H.hooks).sort(), ['agentStop', 'postToolUse', 'preToolUse', 'sessionStart', 'subagentStart', 'subagentStop', 'userPromptSubmitted']);
  for (const [ev, list] of Object.entries(H.hooks)) {
    for (const h of list) {
      assert.equal(h.type, 'command');
      assert.equal(h.matcher, undefined, ev);
      assert.ok(h.timeoutSec > 0 && h.timeoutSec <= 30, ev);
      assert.match(h.bash, /\$\{PLUGIN_ROOT:-\$\{COPILOT_PLUGIN_ROOT:-\$CLAUDE_PLUGIN_ROOT\}\}/);
      assert.match(h.bash, new RegExp(`\\.js" ${ev}$`), 'passes the event name: camelCase payloads carry none');
      assert.match(h.powershell, /\$env:PLUGIN_ROOT/);
      const script = h.bash.match(/hooks\/([\w-]+\.js)/)[1];
      assert.ok(fs.existsSync(path.join(F.PLUGIN, 'hooks', script)), script);
    }
  }
  assert.equal(H.hooks.preToolUse[0].timeoutSec, 10, 'timeouts fail open: keep the guard short');
  // the bash command really runs the hook through the env var (and exits quietly without it)
  const root = F.makeRepo();
  const run = (env) => spawnSync('bash', ['-c', H.hooks.preToolUse[0].bash], { input: JSON.stringify({ toolName: 'bash', toolArgs: { command: 'git push --force' }, cwd: root }), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
  assert.equal(run({ COPILOT_PLUGIN_ROOT: F.PLUGIN }).status, 2);
  assert.equal(run({ PLUGIN_ROOT: F.PLUGIN }).status, 2);
  assert.equal(run({}).status, 0);
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
  assert.deepEqual(Object.keys(bare), ['additionalContext']);
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
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
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

// --- agentStop -------------------------------------------------------------------------

const stop = (root, extra = {}) => hook('stop.js', { cwd: root, transcriptPath: path.join(root, 'no-such-transcript.jsonl'), stopReason: 'end_turn', stop_hook_active: false, ...extra }, 'agentStop');
const blocked = (r) => r.status === 0 && r.stdout !== '' && JSON.parse(r.stdout).decision === 'block';

test('agentStop: blocks an active job with unmet floors and nothing waiting; capped at 3 in a row', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  F.cli(root, ['next']); // clarify: the agent's move
  const r = stop(root);
  assert.ok(blocked(r));
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['decision', 'reason']);
  assert.match(out.reason, new RegExp(`floors not met for ${J}`));
  assert.ok(blocked(stop(root, { stop_hook_active: true })));
  assert.ok(blocked(stop(root, { stop_hook_active: true })));
  assert.equal(stop(root, { stop_hook_active: true }).stdout, '', 'cap: the fourth stop in a row ends the turn');
  const ev = events(root);
  assert.equal(ev.filter((e) => e.event === 'stop_block').length, 3);
  assert.equal(ev.filter((e) => e.event === 'stop_block_cap').length, 1);
  // a fresh stop (not a continuation) starts counting again
  assert.ok(blocked(stop(root, { stop_hook_active: false })));
  // and so does a new user prompt
  assert.ok(blocked(stop(root, { stop_hook_active: true })));
  assert.ok(blocked(stop(root, { stop_hook_active: true })));
  hook('prompt.js', { prompt: 'keep going', cwd: root }, 'userPromptSubmitted');
  assert.ok(!fs.existsSync(path.join(root, '.factory', 'stop-blocks.json')));
  assert.ok(blocked(stop(root, { stop_hook_active: true })));
  // snake-case (PascalCase-registered) payloads work the same
  assert.ok(blocked(hook('stop.js', { hook_event_name: 'Stop', cwd: root, transcript_path: '/nope', stop_reason: 'end_turn', stop_hook_active: false })));
});

test('agentStop: never blocks while the human is the one to act', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  // clarify asked the user a question: waiting
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.equal(F.record(root, F.envelope(b, 'needs_user', { analysts: [], degraded: [], judge: { questions: [{ question: 'Floats too?', why: 'scope' }], dismissed: [] }, critique: null })).status, 'needs_user');
  assert.equal(stop(root).stdout, '', 'open clarify question');
  F.cli(root, ['answer', '--id', 'Q-1', '--answer', 'no']);
  assert.equal(stop(root).stdout, '', 'the record asked for the user and no factory next since');
  F.cli(root, ['next']);
  assert.ok(blocked(stop(root)), 'answered and routed on: the agent owes the next step');
  // a closing question to the user (from a message-bearing payload) is waiting too
  assert.equal(stop(root, { last_assistant_message: 'I updated the contract. Should floats be supported too?' }).stdout, '');
  // the H1 gate: waiting on the human
  b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  assert.equal(F.cli(root, ['next']).action, 'gate');
  assert.equal(stop(root).stdout, '', 'pending gate');
  // parked: waiting on the human
  F.cli(root, ['park', '--reason', 'later']);
  assert.equal(stop(root).stdout, '');
  // no factory here at all
  assert.equal(stop(path.dirname(root)).stdout, '');
});

test('agentStop: a done claim in a readable transcript names other jobs (best effort)', () => {
  const root = F.makeRepo();
  const J1 = F.cli(root, ['job', 'new', '--title', 'one', '--type', 'bug', '--risk', 'low']).job;
  F.cli(root, ['park', '--reason', 'later']);
  const J2 = F.cli(root, ['job', 'new', '--title', 'two', '--type', 'bug', '--risk', 'low']).job;
  F.cli(root, ['use', J2]);
  F.cli(root, ['next']);
  F.cli(root, ['use', J1]);
  const t = path.join(root, '.factory', 'scratch', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.writeFileSync(t, [
    JSON.stringify({ type: 'user.message', data: { content: 'finish it' } }),
    JSON.stringify({ type: 'assistant.message', data: { content: `I have finished the work on ${J2}.` } }),
    'not json',
    JSON.stringify({ type: 'tool.execution_complete', data: {} }),
  ].join('\n') + '\n');
  assert.equal(stop(root).stdout, '', 'the current job is parked, and no transcript: nothing owed');
  const out = JSON.parse(stop(root, { transcriptPath: t }).stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /Not done/);
  assert.match(out.reason, new RegExp(J2));
  assert.doesNotMatch(out.reason, new RegExp(`${J1} \\(`));
  // Claude-shaped transcript lines read too
  fs.writeFileSync(t, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `The work on ${J2} is done.` }] } }) + '\n');
  assert.ok(blocked(stop(root, { transcriptPath: t })));
});

test('stop: done-claim and question heuristics', () => {
  const { claims, asksUser } = require('../hooks/stop');
  for (const m of ['The fix is now complete and ready to merge.', "I've completed the task.", 'Everything is done.', "That's done!", 'Shipped.', 'All done 🎉']) assert.ok(claims(m), m);
  for (const m of ['I drafted the contract; waiting for your answers.', 'Is the fix complete?', 'The fix is not done yet.', 'Once the job is done, I will open the PR.', "The task isn't finished: tests fail."]) assert.ok(!claims(m), m);
  assert.ok(asksUser('Done with step one.\n\nWhich database should I use?'));
  assert.ok(!asksUser('Is this right? I went ahead anyway.'));
});

test('agentStop: never gates an agent session started by factory run', () => {
  const root = F.makeRepo();
  F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']);
  F.cli(root, ['next']);
  const r = spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'stop.js'), 'agentStop'], { input: JSON.stringify({ cwd: root }), encoding: 'utf8', env: { ...process.env, FACTORY_RUNNER: '1' } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'a runner agent ends its turn freely; its result goes through factory record');
});
