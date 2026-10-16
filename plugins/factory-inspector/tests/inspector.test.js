'use strict';
// The inspector against real factory jobs (built with the factory's own test fixture)
// and against synthetic records for the deviations a working factory can't produce.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('../../factory/tests/helpers/fixture');
const I = require('../inspector/main');
const rules = require('../inspector/rules');
const { check: guardCheck } = require('../hooks/guard-rules');

const PLUGIN = path.resolve(__dirname, '..');
const BIN = path.join(PLUGIN, 'bin', 'factory-inspect');
const next = (root) => F.cli(root, ['next']);
// Waits (up to 20 s) for a background catch-up inspection to finish.
function waitFor(cond) {
  const until = Date.now() + 20000;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting for the background inspection');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}
const inspect = (root, args) => JSON.parse(spawnSync('node', [BIN, ...args], { cwd: root, encoding: 'utf8' }).stdout);

// A complete, well-behaved bug@low job: what Claude should do, step by step.
function cleanJob(root) {
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  F.clarify(root); // clarify v3, stage by stage: next, wfargs clarify + record, or clarify reply when it waits
  next(root);
  F.reply(root, 'approve');
  next(root);
  let b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 't', claims: [], unknowns: [] }], degraded: [] }));
  next(root);
  F.cli(root, ['plan', 'from-contract']);
  next(root);
  b = F.cli(root, ['wfargs', 'realize']);
  const s = F.cli(root, ['task', 'start', 'T1']);
  F.write(s.worktree, 'src/add.js', `module.exports = (a, b) => a + b; // ${J}\n`);
  F.sh(s.worktree, 'git commit -qam fix');
  F.built(root, 'T1'); // the builder replied done (the runner records it)
  F.cli(root, ['task', 'verify', 'T1']);
  F.record(root, F.envelope(b, 'ok', { tasks: [{ id: 'T1', outcome: 'done', attempts: 1 }] }));
  next(root);
  b = F.cli(root, ['wfargs', 'reconcile']);
  F.cli(root, ['reconcile', 'run']);
  F.record(root, F.envelope(b, 'ok', { integrator: { status: 'merged', summary: '' } }));
  next(root);
  F.cli(root, ['verify', 'run']);
  next(root);
  b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  F.record(root, F.envelope(b, 'ok', { lanes: [{ lane: 'code', findings: [] }], degraded: [], verifications: [] }, { fingerprint: b.fingerprint }));
  next(root);
  F.cli(root, ['ship', '--local']);
  next(root);
  F.sh(root, `git merge -q --no-ff -m m factory/${J}`);
  F.reply(root, `merged ${F.sh(root, 'git rev-parse HEAD')}`);
  next(root); // a local merge: factory next asks for factory ci verify first
  F.cli(root, ['ci', 'verify']);
  next(root);
  F.cli(root, ['distill', 'done']);
  next(root);
  assert.equal(F.cli(root, ['close']).status, 'closed');
  return J;
}

test('a well-behaved job has no findings; streaks count once per job', () => {
  const root = F.makeRepo();
  const J = cleanJob(root);
  const r = inspect(root, ['run']);
  assert.deepEqual(r.inspected.map((x) => x.job), [J]);
  assert.equal(r.added.length, 0, JSON.stringify(I.report(root, { status: 'all' }).findings, null, 1));
  const again = inspect(root, ['run']);
  assert.equal(again.inspected.length, 0, 'an inspected closed job is not re-counted');
  const st = inspect(root, ['status']);
  assert.equal(st.recipes.find((x) => x.recipe === 'bug@low').clean_streak, 1);
  assert.match(spawnSync('node', [BIN, 'trace', '--job', J], { cwd: root, encoding: 'utf8' }).stdout, /D0001.*clarify/);
});

test('forged records are caught (R1)', () => {
  const root = F.makeRepo();
  const J = cleanJob(root);
  fs.appendFileSync(path.join(F.jobDir(root, J), 'ledger.jsonl'), JSON.stringify({ at: 'x', job: J, kind: 'step', step: 'challenge', ok: true, bound: {} }) + '\n');
  fs.appendFileSync(path.join(root, '.factory', 'log', 'decisions.jsonl'), JSON.stringify({ ts: 'x', job: J, action: 'human.approve', gate: 'HS' }) + '\n');
  const r = inspect(root, ['run', '--job', J]);
  const fds = I.report(root).findings;
  const seal = fds.find((x) => x.rule === 'R1.seals');
  assert.ok(seal, JSON.stringify(fds));
  assert.match(seal.summary, /ledger\.jsonl lines .*decisions\.jsonl lines/);
  assert.ok(r.added.length >= 1);
});

test('driver fidelity (R7): acting at a gate, and skipping what the router asked for', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  F.clarify(root);
  assert.equal(next(root).step, 'H1');
  F.cli(root, ['plan', 'from-contract']); // acting while the human hasn't approved
  F.reply(root, 'approve');
  assert.equal(next(root).workflow, 'ground');
  next(root); // asked again with nothing tried: the same decision (factory next is a query)
  F.cli(root, ['answer', '--question', 'Which Node versions?', '--answer', '18+']); // did something else instead of ground
  next(root); // …and asked again: a new decision, so the ground decision was skipped
  inspect(root, ['run', '--job', J]);
  const fds = I.report(root).findings;
  const waiting = fds.find((x) => x.rule === 'R7.acted_while_waiting');
  assert.ok(waiting, JSON.stringify(fds.map((x) => x.rule)));
  assert.equal(waiting.severity, 'high');
  assert.match(waiting.summary, /plan from-contract.*gate "H1"/);
  const skipped = fds.find((x) => x.rule === 'R7.not_done');
  assert.ok(skipped);
  assert.match(skipped.summary, /wfargs ground/);
});

test('synthetic deviations: wrong recipe, skipped step, unpresented gate, unproven review, over-cap rounds', () => {
  const recipe = { id: 'bug@low', version: 1, steps: ['clarify', 'H1', 'ground', 'decompose', 'realize', 'reconcile', 'prove', 'challenge', 'ship', 'H4', 'distill', 'close'].map((step) => ({ step })) };
  const selection = { rules: [{ when: { risk: ['low'], work_type: ['bug'] }, recipe: 'bug@low' }, { when: { risk: ['high'] }, recipe: 'full@high' }] };
  const M = require('../inspector/model');
  const lock = { id: 'bug@low', version: 1, inputs: { work_type: 'bug', risk: 'low', risk_proposed: 'low', epic: false }, recipe, recipe_hash: M.recipeHash(recipe), selection, risk_floor: { hotfix: 'high' }, limits: { max_review_rounds: 1, max_verify_fix_rounds: 3, max_intent_rounds: 4 } };
  const d = (n, extra) => ({ id: `J-0001-D${n}`, job: 'J-0001', ts: `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`, recipe: 'bug@low', recipe_version: 1, ...extra });
  const job = {
    id: 'J-0001',
    state: { status: 'active', work_type: 'bug', risk: 'low', epic: false, recipe: { id: 'bug@low' }, approvals: { H1: { via: 'policy' } } },
    lock,
    stateSealed: true,
    lockSealed: true,
    ledgerLines: [],
    decisionLines: [],
    eventLines: [],
    events: [],
    ledger: [
      { kind: 'step', step: 'clarify', ok: true, at: '2026-01-01T00:00:01Z', bound: {} },
      { kind: 'step', step: 'challenge', ok: true, at: '2026-01-01T00:00:09Z', bound: { fingerprint: 'fp1' } },
    ],
    decisions: [
      d(2, { action: 'skill', step: 'clarify', rule: 'order.next_step' }),
      d(3, { action: 'workflow', step: 'ground', rule: 'order.next_step' }),
      { job: 'J-0001', ts: '2026-01-01T00:00:04Z', action: 'human.approve', gate: 'H1', hash: 'h' },
      d(5, { action: 'workflow', step: 'realize', rule: 'row4.confirmed_serious' }),
      d(6, { action: 'workflow', step: 'realize', rule: 'row4.confirmed_serious' }),
      d(7, { action: 'workflow', step: 'teleport', rule: 'order.next_step' }),
    ],
  };
  const found = rules.inspectJob(job).map((x) => x.rule);
  for (const r of ['R3.skipped_step', 'R4.unpresented_gate', 'R4.policy_approval', 'R5.review_unproven_build', 'R6.rounds_over_cap', 'R3.step_not_in_recipe']) assert.ok(found.includes(r), `${r} in ${found}`);
  const wrong = { ...job, lock: { ...lock, id: 'full@high' }, state: { ...job.state, recipe: { id: 'full@high' } } };
  assert.ok(rules.intendedRecipe(wrong).some((x) => x.rule === 'R2.recipe_selection'));
  const lowered = { ...job, lock: { ...lock, inputs: { work_type: 'hotfix', risk: 'low', risk_proposed: 'low' } } };
  assert.ok(rules.intendedRecipe(lowered).some((x) => x.rule === 'R2.risk_floor'));
});

test('cross-job ambiguity: the same failing check routed by different rules', () => {
  const mk = (id, rule) => ({ id, lock: { id: 'bug@low', recipe_hash: 'r', floors_hash: 'f', selection_hash: 's', plugin: { behaviour_hash: 'b' }, inputs: { work_type: 'bug', risk: 'low' } }, decisions: [{ id: `${id}-D1`, action: 'workflow', step: 'realize', first_failing: 'acs_proven', rule }] });
  const obs = { jobs: { a: mk('J-1', 'row5.acs_unproven'), b: mk('J-2', 'row9.something_else') }, events: [], decisions: [], unsealed: { decisions: [], events: [] } };
  assert.ok(rules.consistency(obs).some((x) => x.rule === 'R8.divergent_routing'));
});

test('friction patterns from real hook events (R9)', () => {
  const root = F.makeRepo();
  F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']);
  const guard = path.join(F.PLUGIN, 'hooks', 'guard.js');
  for (let i = 0; i < 3; i++) spawnSync('node', [guard], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --force' }, cwd: root, agent_type: 'factory:builder' }), encoding: 'utf8' });
  inspect(root, ['run', '--all']);
  const fr = I.report(root).findings.find((x) => x.rule === 'R9.guard_friction');
  assert.ok(fr);
  assert.match(fr.summary, /factory:builder hit the same guard denial 3 times/);
});

test('marks, regressions, modes, sampling and re-arming', () => {
  const root = F.makeRepo();
  const J = cleanJob(root);
  fs.appendFileSync(path.join(F.jobDir(root, J), 'ledger.jsonl'), '{"forged":true}\n');
  inspect(root, ['run', '--job', J]);
  const id = I.report(root).findings[0].id;
  // human-only from an agent's shell
  assert.equal(inspect(root, ['mark', id, 'fixed']).code, 'human_only');
  assert.ok(guardCheck(`factory-inspect --root /x mark ${id} fixed`));
  assert.ok(guardCheck('factory-inspect mode all off'));
  assert.equal(guardCheck('factory-inspect run --all'), null);
  // your chat reply
  assert.match(I.applyReply(root, I.parseReply(`fixed finding ${id}`)).message, /fixed/);
  inspect(root, ['run', '--job', J]);
  const back = I.report(root).findings.find((x) => x.id === id);
  assert.equal(back.status, 'open');
  assert.equal(back.regressed, true);
  assert.throws(() => I.applyReply(root, I.parseReply(`wontfix finding ${id}`)), /needs a reason/);
  I.applyReply(root, I.parseReply(`wontfix finding ${id} old test data`));
  assert.equal(I.report(root, { status: 'wont_fix' }).findings.length, 1);
  // modes
  I.applyReply(root, I.parseReply('inspect mode bug@low off'));
  const J2 = cleanJob(root);
  const r = inspect(root, ['run']);
  assert.ok(r.skipped.some((s) => s.job === J2 && /off/.test(s.why)));
  I.applyReply(root, I.parseReply('inspect mode bug@low sample 2'));
  assert.equal(inspect(root, ['status']).recipes.find((x) => x.recipe === 'bug@low').mode, 'sample');
  // the rules change → re-armed, back to inspecting everything
  const cfgFile = path.join(root, '.factory', 'inspect', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.recipes['bug@low'].rulebook = 'an-older-rulebook';
  cfg.recipes['bug@low'].streak = 25;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  cleanJob(root);
  const rr = inspect(root, ['run']);
  assert.deepEqual(rr.rearmed.map((x) => x.recipe), ['bug@low']);
  const st = inspect(root, ['status']).recipes.find((x) => x.recipe === 'bug@low');
  assert.equal(st.mode, 'on');
  assert.ok(st.clean_streak <= 1);
});

test('settled recipes get a suggestion, never an automatic change', () => {
  const root = F.makeRepo();
  fs.mkdirSync(path.join(root, '.factory', 'inspect'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory', 'inspect', 'config.json'), JSON.stringify({ settle_after: 1, recipes: {} }));
  cleanJob(root);
  const r = inspect(root, ['run']);
  assert.equal(r.suggestions[0].suggest, 'inspect mode bug@low sample 10');
  assert.equal(inspect(root, ['status']).recipes[0].mode, 'on');
});

test('hooks: after-close reports, session start mentions open findings, replies apply (Copilot payloads)', () => {
  const root = F.makeRepo();
  const J = cleanJob(root);
  const run = (hook, input, event) => spawnSync('node', [path.join(PLUGIN, 'hooks', hook), ...(event ? [event] : [])], { input: JSON.stringify({ cwd: root, ...input }), encoding: 'utf8' });
  const ctx = (r) => JSON.parse(r.stdout).additionalContext;
  const after = run('after-close.js', { toolName: 'bash', toolArgs: JSON.stringify({ command: `factory close --job ${J}` }), toolResult: { resultType: 'success', textResultForLlm: '{}' } }, 'postToolUse');
  assert.deepEqual(Object.keys(JSON.parse(after.stdout)), ['additionalContext', 'hookSpecificOutput']);
  assert.deepEqual(JSON.parse(after.stdout).hookSpecificOutput, { hookEventName: 'PostToolUse', additionalContext: ctx(after) }, 'VS Code Local shape in the same object');
  assert.match(ctx(after), /inspected J-0001; no new findings/);
  assert.equal(run('after-close.js', { toolName: 'bash', toolArgs: { command: 'git status' } }, 'postToolUse').stdout, '');
  assert.equal(run('after-close.js', { toolName: 'view', toolArgs: { path: 'factory close' } }, 'postToolUse').stdout, '', 'only shell calls');
  const quiet = ctx(run('session-start.js', { source: 'startup' }, 'sessionStart'));
  assert.ok(quiet.includes(`node "${path.join(PLUGIN, 'bin', 'factory-inspect')}"`), 'the absolute inspector command');
  assert.doesNotMatch(quiet, /open factory finding/);
  fs.appendFileSync(path.join(F.jobDir(root, J), 'ledger.jsonl'), '{"forged":true}\n');
  inspect(root, ['run', '--all']);
  assert.match(ctx(run('session-start.js', {}, 'sessionStart')), /1 open factory finding/);
  assert.match(ctx(run('prompt.js', { prompt: 'ack finding F1' }, 'userPromptSubmitted')), /Applied: Finding F1 marked acknowledged/);
  for (const input of [{ toolName: 'bash', toolArgs: { command: 'factory-inspect mark F1 fixed' } }, { toolName: 'bash', toolArgs: '{"command":"factory-inspect mark F1 fixed"}' }, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'factory-inspect mark F1 fixed' } }]) {
    const denied = run('guard.js', input, 'preToolUse');
    assert.equal(denied.status, 0, 'a deny is the documented JSON on stdout, exit 0');
    assert.equal(JSON.parse(denied.stdout).permissionDecision, 'deny');
    assert.match(JSON.parse(denied.stdout).permissionDecisionReason, /^\[inspector guard\]/);
    assert.equal(denied.stderr, '');
  }
  const ok = run('guard.js', { toolName: 'bash', toolArgs: { command: 'factory-inspect report' } }, 'preToolUse');
  assert.deepEqual([ok.status, ok.stdout], [0, '']);
  assert.equal(spawnSync('node', [path.join(PLUGIN, 'hooks', 'guard.js'), 'preToolUse'], { input: 'garbage', encoding: 'utf8' }).status, 0);
  // the inspector's hooks.json: at the plugin root, native Copilot format, no matchers,
  // a named launcher (timeout warnings show 80 characters) that always exits 0
  assert.ok(!fs.existsSync(path.join(PLUGIN, 'hooks', 'hooks.json')));
  const H = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks.json'), 'utf8'));
  assert.equal(H.version, 1);
  assert.deepEqual(Object.keys(H.hooks).sort(), ['agentStop', 'postToolUse', 'preToolUse', 'sessionStart', 'userPromptSubmitted']);
  for (const [ev, list] of Object.entries(H.hooks)) for (const h of list) {
    assert.equal(h.type, 'command');
    assert.equal(h.matcher, undefined);
    assert.match(h.bash, /^H=inspector:[\w-]+; R=\$PLUGIN_ROOT; \[ -n "\$R" \] \|\| R=\$COPILOT_PLUGIN_ROOT; \[ -n "\$R" \] \|\| R=\$CLAUDE_PLUGIN_ROOT;/);
    assert.doesNotMatch(h.bash + h.powershell, /\$\{(PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT)\}|\$\{[^}]*\$\{/);
    assert.match(h.bash, new RegExp(` ${ev} \\|\\| echo "\\[\\$H\\] hook failed \\(exit \\$\\?\\); allowed" >&2; exit 0$`));
    assert.match(h.powershell, /^\$h='inspector:[\w-]+'; .*; exit 0$/);
    assert.equal(h.command, h.bash, 'VS Code Local\'s cross-platform field: the same launcher');
    assert.ok(h.timeoutSec > 0);
  }
  assert.ok(H.hooks.agentStop[0].timeoutSec <= 15, 'the end-of-turn catch-up is cheap: no inspection in the hook itself');
  const viaLauncher = spawnSync('bash', ['-c', H.hooks.preToolUse[0].bash], { input: JSON.stringify({ toolName: 'bash', toolArgs: { command: 'factory-inspect mark F1 fixed' }, cwd: root }), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, PLUGIN_ROOT: PLUGIN } });
  assert.deepEqual([viaLauncher.status, JSON.parse(viaLauncher.stdout).permissionDecision], [0, 'deny']);
});

test('hooks under VS Code\'s Local harness: snake_case payloads, VS Code tool names, both output shapes', () => {
  const root = F.makeRepo();
  const J = cleanJob(root);
  const run = (hook, input) => spawnSync('node', [path.join(PLUGIN, 'hooks', hook)], { input: JSON.stringify({ cwd: root, session_id: 'vs1', timestamp: 't', ...input }), encoding: 'utf8' });
  const after = JSON.parse(run('after-close.js', { hook_event_name: 'PostToolUse', tool_name: 'run_in_terminal', tool_input: { command: `factory close --job ${J}`, explanation: 'x', isBackground: false }, tool_response: '{}' }).stdout);
  assert.match(after.additionalContext, /inspected J-0001/);
  assert.equal(after.hookSpecificOutput.hookEventName, 'PostToolUse');
  const s = JSON.parse(run('session-start.js', { hook_event_name: 'SessionStart', source: 'new' }).stdout);
  assert.deepEqual(s.hookSpecificOutput, { hookEventName: 'SessionStart', additionalContext: s.additionalContext });
  fs.appendFileSync(path.join(F.jobDir(root, J), 'ledger.jsonl'), '{"forged":true}\n');
  inspect(root, ['run', '--all']);
  const p = JSON.parse(run('prompt.js', { hook_event_name: 'UserPromptSubmit', prompt: 'ack finding F1' }).stdout);
  assert.match(p.systemMessage, /Applied: Finding F1 marked acknowledged/, 'Local shows the user a systemMessage');
  const d = JSON.parse(run('guard.js', { hook_event_name: 'PreToolUse', tool_name: 'run_in_terminal', tool_input: { command: 'factory-inspect mark F1 fixed' } }).stdout);
  assert.deepEqual(d.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.permissionDecisionReason });
  assert.equal(d.permissionDecision, 'deny');
  // a command runner the guard doesn't know: its command arguments, command position only
  assert.equal(JSON.parse(run('guard.js', { hook_event_name: 'PreToolUse', tool_name: 'mcp_shell_exec', tool_input: { command: 'factory-inspect mode bug@low off' } }).stdout).permissionDecision, 'deny');
  for (const [tool_name, tool_input] of [['mcp_shell_exec', { command: 'factory-inspect report' }], ['mcp_shell_exec', { command: 'echo factory-inspect mark F1 fixed' }], ['replace_string_in_file', { filePath: 'notes.md', oldString: 'a', newString: 'factory-inspect mark F1 fixed' }]]) {
    assert.equal(run('guard.js', { hook_event_name: 'PreToolUse', tool_name, tool_input }).stdout, '', JSON.stringify(tool_input));
  }
});

test('observe reads camelCase hook events and Copilot tool names; agents pair by type when starts carry no id', () => {
  const { normEvent, openAgents } = require('../inspector/observe');
  assert.deepEqual(['subagentStart', 'postToolUse', 'agentStop', 'PostToolUse', 'cli', 'guard_deny'].map((e) => normEvent({ event: e }).event), ['SubagentStart', 'PostToolUse', 'Stop', 'PostToolUse', 'cli', 'guard_deny']);
  assert.deepEqual(['bash', 'edit', 'create', 'view', 'apply_patch', 'Bash', 'mcp_x'].map((t) => normEvent({ event: 'PostToolUse', tool: t }).tool), ['Bash', 'Edit', 'Write', 'Read', 'Edit', 'Bash', 'mcp_x']);
  assert.equal(normEvent({ event: 'SubagentStart', agent_name: 'factory:builder' }).agent_type, 'factory:builder');
  assert.equal(normEvent({ event: 'SubagentStop', agentId: 'a1', agentName: 'factory:builder' }).agent_id, 'a1');
  const ev = [
    { event: 'SubagentStart', ts: '1', agent_type: 'factory:builder' },
    { event: 'SubagentStart', ts: '2', agent_type: 'factory:builder' },
    { event: 'SubagentStart', ts: '3', agent_type: 'factory:tester' },
    { event: 'SubagentStop', ts: '4', agent_type: 'factory:builder', agent_id: 'x9' },
    { event: 'SubagentStart', ts: '5', agent_id: 'a1', agent_type: 'factory:reviewer' },
    { event: 'SubagentStop', ts: '6', agent_id: 'a1', agent_type: 'factory:reviewer' },
  ].map(normEvent);
  assert.deepEqual(openAgents(ev).map((e) => `${e.agent_type}@${e.ts}`), ['factory:builder@2', 'factory:tester@3']);
  // end to end: a factory log written from Copilot camelCase payloads
  const root = F.makeRepo();
  F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']);
  const fh = (name, input, event) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', name), event], { input: JSON.stringify({ cwd: root, ...input }), encoding: 'utf8' });
  fh('activity.js', { agentName: 'factory:builder' }, 'subagentStart');
  fh('activity.js', { agentName: 'factory:tester' }, 'subagentStart');
  fh('subagent-stop.js', { agentName: 'factory:builder', agentType: 'custom', agentId: 'b1', response: 'ok' }, 'subagentStop');
  fh('activity.js', { toolName: 'bash', toolArgs: '{"command":"ls"}' }, 'postToolUse');
  const obs = require('../inspector/observe').observe(root);
  assert.deepEqual(openAgents(obs.events).map((e) => e.agent_type), ['factory:tester']);
  assert.ok(obs.events.some((e) => e.event === 'PostToolUse' && e.tool === 'Bash'));
  assert.equal(I.health(root).agents.not_stopped, 1);
});

test('job health from synthetic records (R12–R19)', () => {
  const { LIMITS } = require('../inspector/config');
  const at = (h) => new Date(Date.UTC(2026, 0, 1) + h * 36e5).toISOString();
  const ev = (event, h, extra) => ({ event, ts: at(h), job: 'J-0001', decision_id: 'J-0001-D0003', ...extra });
  const job = {
    id: 'J-0001',
    state: { status: 'active', updated_at: at(0) },
    lock: null,
    events: [
      ...Array.from({ length: 5 }, (_, i) => ev('guard_deny', i, { reason: `src/x${i}.js is outside T1's allowed paths` })),
      ev('stop_block', 1, { missing: ['acs_proven'] }), ev('stop_block', 2, { missing: ['review_clean'] }),
      ev('reply_refused', 1, { code: 'stale_gate' }), ev('reply_refused', 2, { code: 'stale_gate' }),
      ev('reply_unparsed', 1, { word: 'aprove', verb: 'approve' }), ev('reply_unparsed', 2, { word: 'aprove', verb: 'approve' }),
      ...[1, 2, 3].map((h) => ev('cli', h, { cmd: 'task', sub: 'verify', ok: false, code: 'verify_failed' })),
      ev('cli', 3, { cmd: 'record', ok: true, status: 'stale', workflow: 'realize' }), ev('cli', 4, { cmd: 'record', ok: true, status: 'stale', workflow: 'realize' }),
      ev('cli', 5, { cmd: 'park', ok: true }),
      ev('SubagentStart', 1, { agent_id: 'a1', agent_type: 'factory:builder' }), ev('SubagentStop', 2, { agent_id: 'a1' }),
      ev('SubagentStart', 2, { agent_id: 'a2', agent_type: 'factory:tester' }),
    ],
    ledger: [
      { kind: 'error', workflow: 'ground', summary: 'boom', at: at(1) }, { kind: 'error', workflow: 'ground', summary: 'boom', at: at(2) },
      { kind: 'step', step: 'clarify', ok: true, at: at(1), detail: { degraded: ['security analyst'] } },
      { kind: 'step', step: 'clarify', ok: true, at: at(1), detail: { round: 1, dropped: 2 } }, { kind: 'step', step: 'clarify', ok: false, at: at(2), detail: { round: 2, intent_open: true, intent_rounds: 2, dropped: 1 } },
      ...[1, 2, 3].map((h) => ({ kind: 'step', step: 'decompose', ok: false, at: at(h) })),
      { kind: 'agents', workflow: 'realize', at: at(3), agents: [
        { label: 'build T1 #1', agent_type: 'builder', model: null, outcome: 'done' }, { label: 'build T1 #2', agent_type: 'builder', model: 'opus', outcome: 'done' }, { label: 'build T1 #3', agent_type: 'builder', model: 'opus', outcome: 'exhausted' },
        { label: 'test T1', agent_type: 'tester', outcome: 'fail' }, { label: 'scan (retry)', agent_type: 'analyst', retry: true, outcome: 'no_result' }, { label: 'scan2 (retry)', agent_type: 'analyst', retry: true, outcome: 'ok' },
      ] },
    ],
    decisions: [
      { id: 'J-0001-D0001', ts: at(0), action: 'gate', step: 'H1', recipe: 'bug@low' },
      { ts: at(60), action: 'human.approve', gate: 'H1' },
      { id: 'J-0001-D0002', ts: at(61), action: 'parked', rule: 'cap.review_rounds' }, { id: 'J-0001-D0003', ts: at(62), action: 'parked', rule: 'cap.review_rounds' },
      ...[63, 64, 65].map((h) => ({ ts: at(h), action: 'human.resume', from: 'review' })),
    ],
  };
  const found = rules.jobHealth(job, LIMITS, at(200));
  const ids = found.map((x) => x.rule);
  for (const r of ['R12.guard_denials', 'R12.stop_blocks', 'R12.replies_refused', 'R12.replies_unparsed', 'R13.cli_failures', 'R13.stale_results', 'R14.workflow_errors', 'R14.degraded', 'R14.agent_retries', 'R14.agent_failures', 'R14.escalations', 'R14.step_failures', 'R15.orphaned_agents', 'R16.park_loop', 'R16.resumed_past_caps', 'R17.idle_job', 'R18.slow_reply', 'R19.intent_parked', 'R19.question_overrun']) assert.ok(ids.includes(r), `${r} in ${ids}`);
  assert.match(found.find((x) => x.rule === 'R13.cli_failures').summary, /factory task verify" failed 3 times .* verify_failed/);
  assert.match(found.find((x) => x.rule === 'R15.orphaned_agents').summary, /factory:tester/);
  for (const x of found) assert.ok(['deviation', 'ambiguity', 'gap'].includes(x.class) && ['high', 'medium', 'low'].includes(x.severity), x.rule);
  // under the limits: nothing
  const quiet = rules.jobHealth({ ...job, events: job.events.slice(0, 2), ledger: [], decisions: [], state: { status: 'active', updated_at: at(199) } }, LIMITS, at(200));
  assert.deepEqual(quiet, []);
});

test('factory-wide health (R10 hook errors, R11 torn lines, R13 crashes) and the health report', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  // a factory hook fails: tampered state makes session-start throw → sealed hook_error
  const st = path.join(F.jobDir(root, J), 'state.json');
  const good = fs.readFileSync(st, 'utf8');
  fs.writeFileSync(st, JSON.stringify({ ...JSON.parse(good), risk: 'high' }));
  spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'session-start.js')], { input: JSON.stringify({ cwd: root, hook_event_name: 'SessionStart' }), encoding: 'utf8' });
  fs.writeFileSync(st, good);
  // the inspector's own hook fails: its register can't be written
  fs.mkdirSync(path.join(root, '.factory', 'inspect', 'register.json'), { recursive: true });
  const after = spawnSync('node', [path.join(PLUGIN, 'hooks', 'after-close.js')], { input: JSON.stringify({ cwd: root, tool_name: 'Bash', tool_input: { command: `factory close --job ${J}` } }), encoding: 'utf8' });
  assert.equal(after.status, 0);
  fs.rmSync(path.join(root, '.factory', 'inspect', 'register.json'), { recursive: true });
  assert.match(fs.readFileSync(path.join(root, '.factory', 'inspect', 'hook-errors.jsonl'), 'utf8'), /"hook":"after-close"/);
  // a torn line
  fs.appendFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), '{"ts":"2026-01-01T00:00:00Z","event":"cl\n');
  // the job is still active: --active inspects it now
  const r = inspect(root, ['run', '--active']);
  assert.deepEqual(r.inspected.map((x) => x.job), [J]);
  const fds = I.report(root).findings;
  const he = fds.find((x) => x.rule === 'R10.hook_errors');
  assert.ok(he, JSON.stringify(fds.map((x) => x.rule)));
  assert.match(he.summary, /session-start hook failed 1 time/);
  assert.ok(fds.some((x) => x.rule === 'R10.inspector_hook_errors'));
  assert.ok(fds.some((x) => x.rule === 'R11.torn_lines'));
  assert.ok(!fds.some((x) => x.rule === 'R1.unattributed_lines'), 'a torn line is R11, not a forgery');
  const md = spawnSync('node', [BIN, 'report', '--format', 'md'], { cwd: root, encoding: 'utf8' }).stdout;
  assert.match(md, /## Factory health/);
  assert.match(md, /Hook errors: session-start ×1 · inspector hooks 1/);
  assert.match(md, /torn lines 1/);
  assert.equal(inspect(root, ['health']).hook_errors[0].key, 'session-start');
  // crashes are factory-wide
  const obs = { jobs: {}, events: [{ event: 'cli', cmd: 'verify', sub: 'run', ok: false, code: 'internal', ts: 'x', job: J }], decisions: [], unsealed: { decisions: [], events: [] }, torn: { events: [], decisions: [] } };
  assert.equal(rules.factoryHealth(obs, require('../inspector/config').LIMITS)[0].rule, 'R13.cli_crash');
});

test('limits and rules_off come from config; a fixed health finding reopens only on new evidence', () => {
  const root = F.makeRepo();
  F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']);
  fs.mkdirSync(path.join(root, '.factory', 'inspect'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory', 'inspect', 'config.json'), JSON.stringify({ limits: { guard_denials_per_job: 2 }, rules_off: ['R9'] }));
  const guard = path.join(F.PLUGIN, 'hooks', 'guard.js');
  const deny = () => spawnSync('node', [guard], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --force' }, cwd: root }), encoding: 'utf8' });
  for (let i = 0; i < 3; i++) deny();
  inspect(root, ['run', '--active']);
  let fds = I.report(root).findings;
  const g = fds.find((x) => x.rule === 'R12.guard_denials');
  assert.ok(g && /3 guard denials \(limit 2\)/.test(g.summary), JSON.stringify(fds.map((x) => x.rule)));
  assert.ok(!fds.some((x) => x.rule.startsWith('R9.')), 'R9 switched off');
  assert.equal(inspect(root, ['status']).limits.guard_denials_per_job, 2);
  I.applyReply(root, I.parseReply(`fixed finding ${g.id}`));
  inspect(root, ['run', '--active']);
  assert.equal(I.report(root, { status: 'all' }).findings.find((x) => x.id === g.id).status, 'fixed', 'old denials do not reopen it');
  deny();
  inspect(root, ['run', '--active']);
  fds = I.report(root, { status: 'all' }).findings;
  assert.equal(fds.find((x) => x.id === g.id).status, 'open', 'a new denial does');
});

test('hooks: a job that ends outside the agent\'s shell is caught at the end of the turn (silently) and reported at session start', () => {
  const root = F.makeRepo();
  const run = (hook, input, event) => spawnSync('node', [path.join(PLUGIN, 'hooks', hook), event], { input: JSON.stringify({ cwd: root, ...input }), encoding: 'utf8' });
  const stop = () => run('catch-up.js', { transcriptPath: '/nope', stopReason: 'end_turn', stop_hook_active: false }, 'agentStop');
  const J = F.cli(root, ['job', 'new', '--title', 'Never mind', '--type', 'bug', '--risk', 'low']).job;
  assert.equal(stop().stdout, '', 'an active job is not inspected');
  F.reply(root, 'cancel job'); // applied by the factory's prompt hook: no shell call, no postToolUse
  assert.deepEqual(I.pending(root), [J]);
  const t0 = Date.now();
  const r = stop();
  assert.deepEqual([r.status, r.stdout], [0, ''], 'agentStop never blocks and shows nothing (only decision/reason are honoured there)');
  assert.ok(Date.now() - t0 < 5000, 'the hook itself only checks what is pending');
  waitFor(() => I.pending(root).length === 0 && !fs.existsSync(path.join(root, '.factory', 'inspect', 'catch-up.lock')));
  assert.deepEqual(I.pending(root), [], 'but the job was inspected (in the background)');
  assert.equal(stop().stdout, '', 'nothing pending: silent');
  // the catch-up line is shown at the next session start, once
  assert.match(JSON.parse(run('session-start.js', {}, 'sessionStart').stdout).additionalContext, new RegExp(`inspected ${J}`));
  assert.doesNotMatch(JSON.parse(run('session-start.js', {}, 'sessionStart').stdout).additionalContext, new RegExp(`inspected ${J}`));

  const J2 = F.cli(root, ['job', 'new', '--title', 'Also not', '--type', 'bug', '--risk', 'low']).job;
  F.reply(root, `abandon job ${J2}`);
  assert.match(JSON.parse(run('session-start.js', {}, 'sessionStart').stdout).additionalContext, new RegExp(`inspected ${J2}`));
});

test('independence: the inspector imports nothing from the factory', () => {
  for (const dir of ['inspector', 'hooks', 'bin']) {
    for (const f of fs.readdirSync(path.join(PLUGIN, dir))) {
      const src = fs.readFileSync(path.join(PLUGIN, dir, f), 'utf8');
      assert.ok(!/require\([^)]*factory\/cli/.test(src) && !/require\(['"]\.\.\/\.\.\/factory/.test(src), `${dir}/${f} must not import factory code`);
    }
  }
});

test('R7 ignores factory run failure lines and shim/console/doc/help; R14 reads agent_run; R19 only fires on a real park', () => {
  const { LIMITS } = require('../inspector/config');
  const at = (h) => new Date(Date.UTC(2026, 0, 1) + h * 36e5).toISOString();
  const cli = (h, d, extra) => ({ event: 'cli', ts: at(h), job: 'J-0001', decision_id: d, ok: true, ...extra });
  const job = {
    id: 'J-0001',
    state: { status: 'active', updated_at: at(9) },
    lock: null,
    ledger: [{ kind: 'step', step: 'clarify', ok: false, at: at(1), detail: { round: 1, questions: 1, question_ids: ['Q-1'], intent_open: true, held: 2, dropped: 0 } }],
    decisions: [
      { id: 'J-0001-D0001', ts: at(1), action: 'gate', step: 'H1' },
      { id: 'J-0001-D0002', ts: at(2), action: 'workflow', workflow: 'ground' },
      { id: 'J-0001-D0003', ts: at(3), action: 'workflow', workflow: 'ground' },
    ],
    events: [
      cli(1.1, 'J-0001-D0001', { cmd: 'shim' }), cli(1.2, 'J-0001-D0001', { cmd: 'console' }), cli(1.3, 'J-0001-D0001', { cmd: 'help' }), cli(1.4, 'J-0001-D0001', { cmd: 'doc', sub: 'list' }),
      cli(1.5, 'J-0001-D0001', { cmd: 'run', sub: 'ground', ok: false, code: 'gate_pending' }),
      cli(2.1, 'J-0001-D0002', { cmd: 'run', sub: 'ground', ok: false, code: 'copilot_unavailable' }),
      cli(2.2, 'J-0001-D0002', { cmd: 'wfargs', sub: 'ground', workflow: 'ground' }), cli(2.3, 'J-0001-D0002', { cmd: 'record', workflow: 'ground', status: 'ok' }),
      { event: 'agent_run', ts: at(2.25), job: 'J-0001', agent_type: 'factory:researcher', label: 'research a', outcome: 'timeout', exit: null, errors: ['timed out after 1800s'] },
      { event: 'agent_run', ts: at(2.26), job: 'J-0001', agent_type: 'factory:researcher', label: 'research b', outcome: 'failed', exit: 1, errors: ['exit 1: rate limited'] },
      { event: 'agent_run', ts: at(2.27), job: 'J-0001', agent_type: 'factory:judge', label: 'judge', outcome: 'failed', exit: 1, errors: ['exit 1: model error'] },
      { event: 'agent_run', ts: at(2.28), job: 'J-0001', agent_type: 'factory:judge', label: 'judge', outcome: 'failed', exit: -1, errors: ['exit -1: spawn copilot ENOENT'] },
    ],
  };
  const r7 = rules.driverFidelity(job).map((x) => x.rule);
  assert.deepEqual(r7, [], `no R7 for shim/console/help/doc or a failed factory run: ${r7}`);
  const health = rules.jobHealth(job, LIMITS, at(10));
  const ids = health.map((x) => x.rule);
  assert.ok(!ids.includes('R19.intent_parked'), 'a needs_user intent round is not a park');
  for (const r of ['R14.agent_timeouts', 'R14.agent_crashes', 'R14.copilot_unavailable']) assert.ok(ids.includes(r), `${r} in ${ids}`);
  assert.match(health.find((x) => x.rule === 'R14.agent_timeouts').summary, /1 agent run\(s\) in J-0001 timed out: factory:researcher ×1/);
  assert.match(health.find((x) => x.rule === 'R14.agent_crashes').summary, /2 agent process\(es\)/);
  assert.equal(health.find((x) => x.rule === 'R14.copilot_unavailable').severity, 'high');
  // the real park entry still fires
  job.ledger.push({ kind: 'step', step: 'clarify', ok: false, at: at(4), detail: { round: 2, intent_open: true, intent_rounds: 2, questions: 0, contract_problems: [] } });
  assert.ok(rules.jobHealth(job, LIMITS, at(10)).some((x) => x.rule === 'R19.intent_parked'));
});

test('hooks in an agent `factory run` started do nothing; the guard keeps agents out of inspections; indirection is caught', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  F.reply(root, 'cancel job');
  const env = { ...process.env, FACTORY_RUNNER: '1', FACTORY_JOB: J, FACTORY_AGENT_ROLE: 'tester', FACTORY_ROOT: root };
  const run = (hook, input, event) => spawnSync('node', [path.join(PLUGIN, 'hooks', hook), event], { input: JSON.stringify({ cwd: root, ...input }), encoding: 'utf8', env });
  for (const [hook, input, event] of [['session-start.js', {}, 'sessionStart'], ['prompt.js', { prompt: 'ack finding F1' }, 'userPromptSubmitted'], ['catch-up.js', { stop_hook_active: false }, 'agentStop'], ['after-close.js', { toolName: 'bash', toolArgs: { command: 'factory close' } }, 'postToolUse']]) {
    const r = run(hook, input, event);
    assert.deepEqual([r.status, r.stdout], [0, ''], hook);
  }
  assert.deepEqual(I.pending(root), [J], 'no inspection ran inside the agent');
  const g = (command) => run('guard.js', { toolName: 'bash', toolArgs: { command } }, 'preToolUse');
  const denies = (r) => r.status === 0 && r.stdout !== '' && JSON.parse(r.stdout).permissionDecision === 'deny';
  for (const c of ['factory-inspect run', 'factory-inspect health', `node ${BIN} run --job ${J}`]) assert.ok(denies(g(c)), c);
  assert.deepEqual([g('factory-inspect report').status, g('factory-inspect report').stdout], [0, '']);
  // indirection, for everyone
  for (const c of [`I=${BIN}; node $I mark F1 --to fixed`, `echo mode | xargs node ${BIN}`, 'eval "factory-inspect ma""rk F1"']) assert.ok(guardCheck(c), c);
  assert.equal(guardCheck('factory-inspect report --status open'), null);
  assert.ok(guardCheck('factory-inspect run', { agent: true }));
  assert.equal(guardCheck('factory-inspect run'), null);
});

test('hooks: a catch-up line reaches the model on the next prompt, not a session later', () => {
  const root = F.makeRepo();
  const run = (hook, input, event) => spawnSync('node', [path.join(PLUGIN, 'hooks', hook), event], { input: JSON.stringify({ cwd: root, ...input }), encoding: 'utf8' });
  const J = F.cli(root, ['job', 'new', '--title', 'Never mind', '--type', 'bug', '--risk', 'low']).job;
  F.reply(root, 'cancel job');
  assert.equal(run('catch-up.js', { stop_hook_active: false }, 'agentStop').stdout, '');
  waitFor(() => I.pending(root).length === 0 && !fs.existsSync(path.join(root, '.factory', 'inspect', 'catch-up.lock')));
  const ctx = JSON.parse(run('prompt.js', { prompt: 'what now?' }, 'userPromptSubmitted').stdout).additionalContext;
  assert.match(ctx, new RegExp(`inspected ${J}`));
  assert.match(ctx, /Tell the user in one line/);
  assert.equal(run('prompt.js', { prompt: 'and now?' }, 'userPromptSubmitted').stdout, '', 'reported once');
  assert.doesNotMatch(JSON.parse(run('session-start.js', {}, 'sessionStart').stdout).additionalContext, new RegExp(`inspected ${J}`));
});

test('guard regressions: redirects to /dev/null, prose and patterns are not inspector writes or calls', () => {
  for (const c of [
    'ls .factory/inspect/ 2>/dev/null',
    "jq '.findings | length' .factory/inspect/register.json > /tmp/n.txt",
    'grep -c open .factory/inspect/register.json 2>&1',
    'cat .factory/inspect/register.json >&2',
    'grep -n "factory-inspect mark" $(git ls-files \'*.md\')',
    'git commit -m "docs: factory-inspect mode examples"',
    "echo 'Run factory-inspect mark F3 --status fixed when done'",
    'gh pr create --body "then run factory-inspect mode all off"',
    'factory-inspect report --status open 2>/dev/null | head',
  ]) assert.equal(guardCheck(c), null, c);
  for (const c of [
    'factory-inspect mark F1 fixed',
    'echo x > .factory/inspect/register.json',
    'jq . x.json | tee .factory/inspect/config.json',
    'rm -f .factory/inspect/register.json',
    'sed -i s/open/fixed/ .factory/inspect/register.json',
    `bash -c "factory-inspect mode all off"`,
    `env X=1 node ${BIN} mark F2 fixed`,
    'X=$(which factory-inspect); $X mark F1 fixed',
    'echo "$(factory-inspect mode all off)"',
  ]) assert.ok(guardCheck(c), c);
  assert.equal(require('../hooks/shell.js').parse.toString(), require('../../factory/hooks/shell.js').parse.toString(), 'the shell reader is an identical copy of the factory\'s');
});

// ---------------------------------------------------------------- R20 grounded intent
// A clarify round with research (the scout phase's data, as fanout-judge returns it).
function scoutData(world) {
  return {
    ran: true, round: 1, web: { enabled: true, reason: null, available: true }, map: { ran: true, ok: true },
    unknowns: [
      { id: 'U-1', text: 'Where is add?', kind: 'repo', impact: 'high', draft: 'add is in src/add.js', research: 'repo', resolution: 'assumption', evidence: ['E-1'], researched: true },
      { id: 'U-2', text: 'Is + numeric addition per ECMAScript?', kind: 'world', impact: 'medium', draft: 'ECMAScript + adds numbers', research: 'web', resolution: world === 'confirmed' ? 'assumption' : 'question', evidence: ['E-2'], researched: true },
    ],
    evidence: [
      { id: 'E-1', unknown: 'U-1', claim: 'add is in src/add.js and subtracts', source: 'src/add.js:1', source_tier: 'repo', quote: 'module.exports = (a, b) => a - b;', confidence: 'high', scout: 'repo', verdict: 'confirmed' },
      { id: 'E-2', unknown: 'U-2', claim: 'ECMAScript + adds two numbers', source: 'https://tc39.es/ecma262/', source_tier: 'standard', retrieved_at: '2026-10-14', quote: 'Return ? operation(lnum, rnum).', confidence: 'high', scout: 'web', verdict: world },
    ],
    assumptions: [], scouts: [{ label: 'scout · repo #1', mode: 'repo', unknowns: ['U-1'], outcome: 'ok' }, { label: 'scout · web #1', mode: 'web', unknowns: ['U-2'], outcome: 'ok' }], verifiers: 1, degraded: [],
  };
}

test('clarify v3 from the real CLI: a clean run has no clarify findings; replies while it waits are expected; a hand-edited clarify.json is forged (R1)', () => {
  const root = F.makeRepo();
  // a read-back that waits for the user (factory 0.9.0 shows it without waiting by default)
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ clarify: { readback: 'wait' } }));
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'feature', '--risk', 'medium']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText({ verify: '`node tests/add.test.js` (AC-1)' }));
  F.clarify(root, { until: 'readback_wait' });
  assert.equal(next(root).clarify.stage, 'readback_wait');
  F.cli(root, ['clarify', 'status']); // read-only
  F.cli(root, ['clarify', 'reply', 'ok']); // the user's words, recorded by the main session
  F.clarify(root);
  assert.equal(next(root).step, 'H1');
  inspect(root, ['run', '--job', J]);
  let fds = I.report(root).findings.filter((x) => x.job === J);
  assert.ok(!fds.some((x) => /^R(6|7|19|20)\./.test(x.rule)), JSON.stringify(fds.map((x) => `${x.rule}: ${x.summary}`)));
  assert.ok(!fds.some((x) => x.rule === 'R1.seals'), 'clarify.json is sealed by the CLI');
  // the decision records say which clarify stage ran agents and which waited on the user
  const ds = fs.readFileSync(path.join(root, '.factory', 'log', 'decisions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((d) => d.job === J && d.skill === 'clarify');
  assert.ok(ds.some((d) => d.clarify && d.clarify.waiting_for_user) && ds.some((d) => d.clarify && d.clarify.run), JSON.stringify(ds.map((d) => d.clarify)));
  // a hand-edited clarify record is a forged record (R1)
  const file = path.join(F.jobDir(root, J), 'clarify.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.items[0].text = 'edited';
  fs.writeFileSync(file, JSON.stringify(data));
  inspect(root, ['run', '--job', J]);
  fds = I.report(root).findings.filter((x) => x.job === J);
  assert.match(fds.find((x) => x.rule === 'R1.seals').summary, /clarify\.json/);
});

test('clarify v3 synthetic: over its caps (R6), parked (R19), proceeded past God Eye (R19), research gaps (R20), skipped a stage it was asked to run (R7)', () => {
  const at = (h) => new Date(Date.UTC(2026, 0, 1) + h * 36e5).toISOString();
  const cl = (h, outcome, detail) => ({ kind: 'clarify', at: at(h), job: 'J-0004', stage: outcome, outcome, detail });
  const job = {
    id: 'J-0004', state: { status: 'active' }, lock: { limits: {} },
    ledger: [
      cl(1, 'sheet_wait', { counters: { research_passes: 3, writer_attempts: 0 }, caps: { research_passes: 2, writer_attempts: 2 }, failures: 2 }),
      cl(2, 'park', { reason: 'The contract writer returned nothing twice.' }),
      { kind: 'step', step: 'clarify', at: at(3), job: 'J-0004', ok: true, detail: { version: 3, failures: 2, approved: false, god_eye_objects: 1, proceeded: { at: at(3) } } },
    ],
    decisions: [
      { id: 'J-0004-D0001', ts: at(0.5), action: 'skill', skill: 'clarify', step: 'clarify', clarify: { stage: 'research', run: true, waiting_for_user: false } },
      { id: 'J-0004-D0002', ts: at(0.9), action: 'skill', skill: 'clarify', step: 'clarify', clarify: { stage: 'sheet_wait', run: false, waiting_for_user: true } },
      { id: 'J-0004-D0003', ts: at(1.5), action: 'skill', skill: 'clarify', step: 'clarify', clarify: { stage: 'interpret', run: true, waiting_for_user: false } },
    ],
    events: [
      { event: 'cli', ts: at(0.95), job: 'J-0004', decision_id: 'J-0004-D0002', ok: true, cmd: 'clarify', sub: 'reply' },
      { event: 'cli', ts: at(1.6), job: 'J-0004', decision_id: 'J-0004-D0003', ok: true, cmd: 'wfargs', workflow: 'clarify' },
      { event: 'cli', ts: at(1.7), job: 'J-0004', decision_id: 'J-0004-D0003', ok: true, cmd: 'record', workflow: 'clarify' },
    ],
  };
  const r6 = rules.loops(job);
  assert.deepEqual(r6.map((x) => x.rule), ['R6.clarify_over_cap']);
  assert.match(r6[0].summary, /3 research pass\(es\).*caps were 2 and 2/);
  const r7 = rules.driverFidelity(job);
  assert.deepEqual(r7.map((x) => x.rule), ['R7.not_done'], JSON.stringify(r7.map((x) => x.summary)));
  assert.match(r7[0].summary, /factory wfargs clarify and factory record/, 'the research stage was skipped; the reply while the sheet waited is expected');
  const health = rules.jobHealth(job, require('../inspector/config').LIMITS, at(10)).filter((x) => /^R(19|20)\./.test(x.rule));
  assert.deepEqual(health.map((x) => x.rule).sort(), ['R19.clarify_parked', 'R19.proceeded_past_objections', 'R20.research_gaps']);
  assert.match(health.find((x) => x.rule === 'R19.clarify_parked').summary, /writer returned nothing twice/);
  assert.match(health.find((x) => x.rule === 'R19.proceeded_past_objections').summary, /1 God Eye objection\(s\) still open.*not approval/);
  assert.match(health.find((x) => x.rule === 'R20.research_gaps').summary, /2 research gap\(s\)/);
});

test('R7: human verbs from the user\'s own terminal are not driver deviations; one low note per job instead', () => {
  const at = (h) => new Date(Date.UTC(2026, 0, 1) + h * 36e5).toISOString();
  const cli = (h, d, extra) => ({ event: 'cli', ts: at(h), job: 'J-0003', decision_id: d, ok: true, ...extra });
  const decisions = [{ id: 'J-0003-D0001', ts: at(1), action: 'gate', step: 'H1' }, { id: 'J-0003-D0002', ts: at(3), action: 'workflow', workflow: 'ground', step: 'ground' }, { id: 'J-0003-D0003', ts: at(5), action: 'parked', step: 'P' }, { id: 'J-0003-D0004', ts: at(7), action: 'workflow', workflow: 'ground', step: 'ground' }];
  const job = {
    id: 'J-0003', state: { status: 'active' }, lock: null, ledger: [],
    decisions: [...decisions, { ts: at(1.5), job: 'J-0003', action: 'human.approve', gate: 'H1', channel: 'tty' }, { ts: at(5.5), job: 'J-0003', action: 'human.resume', channel: 'tty' }],
    events: [
      cli(1.5, 'J-0003-D0001', { cmd: 'approve', sub: 'H1', channel: 'tty' }),
      cli(2, 'J-0003-D0002', { cmd: 'wfargs', workflow: 'ground' }), cli(2.1, 'J-0003-D0002', { cmd: 'record', workflow: 'ground' }),
      cli(5.5, 'J-0003-D0003', { cmd: 'resume', channel: 'tty' }),
      cli(5.6, 'J-0003-D0003', { cmd: 'lessons', sub: 'accept', arg: 'L1', channel: 'tty' }),
      cli(6, 'J-0003-D0004', { cmd: 'wfargs', workflow: 'ground' }), cli(6.1, 'J-0003-D0004', { cmd: 'record', workflow: 'ground' }),
    ],
  };
  let found = rules.driverFidelity(job);
  assert.deepEqual(found.map((x) => x.rule), ['R7.terminal_approvals'], JSON.stringify(found.map((x) => x.summary)));
  assert.equal(found[0].severity, 'low');
  assert.match(found[0].summary, /came from the terminal \(approve H1, resume, lessons accept/);
  assert.match(found[0].question, /Chat: Configure Hooks/);
  // a refused attempt (an agent trying) is still a deviation
  job.events.push(cli(1.6, 'J-0003-D0001', { cmd: 'approve', ok: false, code: 'human_only' }));
  found = rules.driverFidelity(job);
  assert.ok(found.some((x) => x.rule === 'R7.acted_while_waiting' && /approve/.test(x.summary)));
  job.events.pop();
  // chat replies reached the factory too: no note
  job.decisions.push({ ts: at(6.5), job: 'J-0003', action: 'human.approve', gate: 'H3', channel: 'chat' });
  assert.deepEqual(rules.driverFidelity(job), []);
});

test('R20 from synthetic records: web off is low severity; limits and quiet jobs; R7 skips human assumption commands; R3 accepts an override as a rewind cause', () => {
  const { LIMITS } = require('../inspector/config');
  const at = (h) => new Date(Date.UTC(2026, 0, 1) + h * 36e5).toISOString();
  const job = {
    id: 'J-0002', state: { status: 'active', updated_at: at(1) }, lock: null, events: [],
    ledger: [{ kind: 'intent', round: 1, at: at(1), questions: [{ id: 'Q-1', unknown: 'U-2', researchable: true }, { id: 'Q-2', unknown: 'U-3', researchable: false, preference: true }] }],
    intent: { unknowns: [{ id: 'U-2', kind: 'world', note: 'not researched (web off: policy (intent_research.web is false))' }], assumptions: [{ id: 'A-1', statement: 's', overridden: false }] },
    intentSealed: true,
    decisions: [],
  };
  let found = rules.groundedIntent(job, LIMITS);
  assert.deepEqual(found.map((x) => [x.rule, x.severity]), [['R20.researchable_asked', 'low']]);
  assert.match(found[0].question, /intent_research\.web/);
  // overrides from decisions (also after the last clarify round)
  job.decisions.push({ ts: at(2), action: 'human.drop_assumption', assumption: 'A-1', was: 's' });
  found = rules.groundedIntent(job, LIMITS);
  assert.match(found.find((x) => x.rule === 'R20.assumption_overridden').summary, /A-1 dropped \(research said: s\)/);
  // under the limits, or no research at all: nothing
  assert.deepEqual(rules.groundedIntent(job, { ...LIMITS, researchable_asked_per_job: 2, assumptions_overridden_per_job: 2 }), []);
  assert.deepEqual(rules.groundedIntent({ ...job, ledger: [], intent: null, decisions: [] }, LIMITS), []);
  // R7: factory intent show (read-only) and factory assumption change (a human action) at a gate
  const cli = (h, d, extra) => ({ event: 'cli', ts: at(h), job: 'J-0002', decision_id: d, ok: true, ...extra });
  const g = { ...job, decisions: [{ id: 'J-0002-D0001', ts: at(1), action: 'gate', step: 'H1' }, { id: 'J-0002-D0002', ts: at(3), action: 'skill', skill: 'clarify', step: 'clarify' }], events: [cli(1.1, 'J-0002-D0001', { cmd: 'intent', sub: 'show' }), cli(1.2, 'J-0002-D0001', { cmd: 'assumption', sub: 'change', arg: 'A-1' })] };
  assert.deepEqual(rules.driverFidelity(g).filter((x) => !['R7.not_done', 'R7.terminal_approvals'].includes(x.rule)), []);
  // R7: factory env show / env check (read-only) and env set / finding dismiss (the human's) at a gate,
  // and the steps factory run runs itself (via "run") during a realize decision, are no deviation
  const g2 = { ...job, decisions: [{ id: 'J-0002-D0001', ts: at(1), action: 'gate', step: 'H1' }, { id: 'J-0002-D0002', ts: at(3), action: 'workflow', workflow: 'realize', step: 'realize' }, { id: 'J-0002-D0003', ts: at(5), action: 'gate', step: 'H3' }], events: [
    cli(1.1, 'J-0002-D0001', { cmd: 'env', sub: 'show' }), cli(1.2, 'J-0002-D0001', { cmd: 'env', sub: 'check' }), cli(1.3, 'J-0002-D0001', { cmd: 'env', sub: 'set', channel: 'tty' }), cli(1.4, 'J-0002-D0001', { cmd: 'finding', sub: 'dismiss', arg: 'code-1', channel: 'tty' }),
    cli(3.1, 'J-0002-D0002', { cmd: 'wfargs', workflow: 'realize' }), cli(3.2, 'J-0002-D0002', { cmd: 'env', sub: 'prepare', arg: 'T1', via: 'run' }), cli(3.3, 'J-0002-D0002', { cmd: 'task', sub: 'verify', arg: 'T1', via: 'run' }), cli(3.4, 'J-0002-D0002', { cmd: 'reconcile', sub: 'wave', via: 'run' }), cli(3.5, 'J-0002-D0002', { cmd: 'record', workflow: 'realize' }),
  ] };
  assert.deepEqual(rules.driverFidelity(g2).filter((x) => !['R7.not_done', 'R7.terminal_approvals'].includes(x.rule)), []);
  // …but the driver preparing an environment by hand at a gate is
  const g3 = { ...g2, events: [...g2.events, cli(5.1, 'J-0002-D0003', { cmd: 'env', sub: 'prepare', arg: 'T1' })] };
  assert.ok(rules.driverFidelity(g3).some((x) => x.rule === 'R7.acted_while_waiting' && /env prepare/.test(x.summary)));
  // R3: H1 → clarify after "change A-n" is explained
  const recipe = { id: 'standard@medium', steps: [{ step: 'clarify', run: 'skill:clarify' }, { step: 'H1', run: 'gate' }, { step: 'ground', run: 'workflow:ground' }] };
  const rw = { ...job, lock: { recipe }, decisions: [{ id: 'D1', ts: at(1), action: 'skill', step: 'clarify' }, { id: 'D2', ts: at(2), action: 'gate', step: 'H1' }, { ts: at(2.5), action: 'human.change_assumption', assumption: 'A-1' }, { id: 'D3', ts: at(3), action: 'skill', step: 'clarify', rule: 'recipe.next' }] };
  rw.ledger = [{ kind: 'step', step: 'clarify', ok: true, at: at(1.5) }];
  assert.ok(!rules.conformance(rw).some((x) => x.rule === 'R3.unexplained_rewind'));
  rw.decisions.splice(2, 1);
  assert.ok(rules.conformance(rw).some((x) => x.rule === 'R3.unexplained_rewind'), 'without the override the rewind is unexplained');
});

test('clarify v2: R6 reads the ceiling each round recorded, R19 flags stalled rounds and re-raised issues, R7 lets clarify status and notes through', () => {
  const { LIMITS } = require('../inspector/config');
  const at = (h) => new Date(Date.UTC(2026, 0, 1) + h * 36e5).toISOString();
  const step = (h, round, lg) => ({ kind: 'step', step: 'clarify', ok: false, at: at(h), detail: { round, questions: 0, question_ids: [], ledger: { opened: 0, settled: 0, deferred: 0, asked: 0, progress: false, degraded: false, ceiling: 10, counted: round, reraised: 0, ...lg } } });
  const job = { id: 'J-0002', state: { status: 'active', updated_at: at(9) }, lock: { limits: { max_intent_rounds: 4 } }, decisions: [], events: [],
    ledger: [step(1, 1, { progress: true, asked: 3, reraised: 2 }), step(2, 2, { degraded: true }), step(3, 3, { reraised: 1 }), step(4, 4, {}), step(5, 5, { progress: true, settled: 2 }), step(6, 6), step(7, 7), step(8, 8)] };
  // 8 clarify entries is over the v1 cap (4 + 2), but each v2 round was within the ceiling it recorded
  assert.ok(!rules.loops(job).some((x) => x.rule === 'R6.clarify_over_cap'));
  job.ledger.push(step(9, 11, { ceiling: 10, counted: 11 }));
  assert.match(rules.loops(job).find((x) => x.rule === 'R6.clarify_over_cap').summary, /11 counted rounds; the ceiling it recorded was 10/);
  const ids = rules.jobHealth(job, LIMITS, at(10)).map((x) => x.rule);
  assert.ok(ids.includes('R19.clarify_stalled'), ids.join());
  assert.match(rules.jobHealth(job, LIMITS, at(10)).find((x) => x.rule === 'R19.clarify_stalled').summary, /4 round\(s\) in a row/, 'the degraded round is not counted; the longest streak');
  assert.ok(ids.includes('R19.issues_reraised'));
  // R7: clarify status is read-only, clarify note belongs to the clarify step
  const exp = rules.expectationsFor({ action: 'skill', skill: 'clarify' });
  assert.ok(exp.allowed.has('clarify:note') && exp.allowed.has('answer'));
  const cli = (h, d, extra) => ({ event: 'cli', ts: at(h), job: 'J-0002', decision_id: d, ok: true, ...extra });
  const j2 = { id: 'J-0002', state: {}, lock: null, ledger: [], decisions: [{ id: 'D1', ts: at(1), action: 'gate', step: 'H1' }], events: [cli(1.1, 'D1', { cmd: 'clarify', sub: 'status' })] };
  assert.deepEqual(rules.driverFidelity(j2), [], 'clarify status while waiting at a gate is a look, not an action');
});

test('outcome integrity: a serious finding left unverified and never settled, and a task counted done after its builder failed (e2e audit)', () => {
  const base = { id: 'J-0001', state: { status: 'active', tasks: {} }, lock: null, ledgerLines: [], decisionLines: [], eventLines: [], events: [], decisions: [] };
  const code1 = { id: 'code-1', lane: 'code', severity: 'major', file: 'src/alerts.js', line: 3, summary: 'an item without reorder_at is never alerted', status: 'unverified' };
  // the e2e run: round 1 unverified, round 2 the reviewer did not raise it, the round passed, the job shipped
  const lostJob = { ...base, ledger: [
    { kind: 'step', step: 'challenge', ok: false, at: '2026-01-01T00:00:01Z', bound: { fingerprint: 'fp' }, detail: { round: 1, findings: [code1] } },
    { kind: 'step', step: 'challenge', ok: true, at: '2026-01-01T00:00:02Z', bound: { fingerprint: 'fp' }, detail: { round: 1, findings: [] } },
    { kind: 'step', step: 'ship', ok: true, at: '2026-01-01T00:00:03Z', bound: { fingerprint: 'fp' }, detail: {} },
  ] };
  const lost = rules.evidenceChain(lostJob).find((x) => x.rule === 'R5.unverified_finding_lost');
  assert.ok(lost, 'flagged');
  assert.match(lost.summary, /the job shipped: code-1 \[major\] src\/alerts.js:3/);
  // carried (the factory since this fix) or settled later: not flagged
  const carried = { ...lostJob, ledger: [lostJob.ledger[0], { ...lostJob.ledger[1], ok: false, detail: { round: 1, findings: [{ ...code1, carried: { from_round: 1, times: 1 } }] } }] };
  assert.ok(!rules.evidenceChain(carried).some((x) => x.rule === 'R5.unverified_finding_lost'));
  const settled = { ...lostJob, ledger: [lostJob.ledger[0], { ...lostJob.ledger[1], detail: { round: 1, findings: [{ ...code1, status: 'refuted' }] } }, lostJob.ledger[2]] };
  assert.ok(!rules.evidenceChain(settled).some((x) => x.rule === 'R5.unverified_finding_lost'));
  // settled by the human (factory finding dismiss|accept): not lost either
  for (const status of ['dismissed', 'accepted']) {
    const byYou = { ...lostJob, ledger: [lostJob.ledger[0], { ...lostJob.ledger[1], detail: { round: 1, findings: [{ ...code1, status, settled: { by: 'human', reason: 'known' } }] } }, lostJob.ledger[2]] };
    assert.ok(!rules.evidenceChain(byYou).some((x) => x.rule === 'R5.unverified_finding_lost'), status);
  }
  // T2's builder crashed, its tester passed the stale branch
  const roster = { kind: 'agents', workflow: 'realize', at: '2026-01-01T00:00:05Z', agents: [
    { label: 'build T1 #1', outcome: 'done' }, { label: 'build T2 #1', outcome: 'no_result' }, { label: 'test T1', outcome: 'pass' }, { label: 'test T2', outcome: 'pass' },
  ] };
  const done = rules.evidenceChain({ ...base, ledger: [roster], state: { tasks: { T3: { outcome: 'done', outcome_at: '2026-01-01T00:00:06Z', builder: { outcome: 'blocked' } } } } }).find((x) => x.rule === 'R5.done_without_builder');
  assert.ok(done, 'flagged');
  assert.deepEqual(done.evidence, ['T2', 'T3']);
  assert.ok(!rules.evidenceChain({ ...base, ledger: [{ ...roster, agents: roster.agents.filter((a) => !/T2/.test(a.label)) }] }).some((x) => x.rule === 'R5.done_without_builder'));
});

test('R5.unverified_finding_lost matches a finding by what it is, not by its id: ids restart each round, and a carried one may be renamed', () => {
  const base = { id: 'J-0001', state: { status: 'active', tasks: {} }, lock: null, ledgerLines: [], decisionLines: [], eventLines: [], events: [], decisions: [] };
  const at = (s) => `2026-01-01T00:00:0${s}Z`;
  const lostOne = { id: 'code-1', lane: 'code', severity: 'major', file: 'src/a.js', line: 3, summary: 'a.js drops the last row', status: 'unverified' };
  // round 2's code-1 is another finding (another file), confirmed and fixed; round 3 passes; a.js's was never settled
  const other = { id: 'code-1', lane: 'code', severity: 'major', file: 'src/b.js', line: 40, summary: 'b.js leaks a handle', status: 'confirmed' };
  const job = { ...base, ledger: [
    { kind: 'step', step: 'challenge', ok: false, at: at(1), detail: { round: 1, findings: [lostOne] } },
    { kind: 'step', step: 'challenge', ok: false, at: at(2), detail: { round: 2, findings: [other] } },
    { kind: 'step', step: 'challenge', ok: true, at: at(3), detail: { round: 3, findings: [] } },
  ] };
  assert.ok(rules.evidenceChain(job).some((x) => x.rule === 'R5.unverified_finding_lost'), 'another finding that reuses the id does not settle it');
  // a carried finding renamed because a new one took its id (code-1@r1), still open: not lost
  const noFile = { id: 'code-1', lane: 'code', severity: 'major', file: null, line: null, summary: 'no input validation anywhere', status: 'unverified' };
  const carried = { ...base, ledger: [
    { kind: 'step', step: 'challenge', ok: false, at: at(1), detail: { round: 1, findings: [noFile] } },
    { kind: 'step', step: 'challenge', ok: false, at: at(2), detail: { round: 2, findings: [{ ...other, status: 'refuted' }, { ...noFile, id: 'code-1@r1', carried: { from_round: 1, times: 1 } }] } },
  ] };
  assert.ok(!rules.evidenceChain(carried).some((x) => x.rule === 'R5.unverified_finding_lost'), 'carried under a new id');
});

test('0.9.0 loops: R6 checks the caps a clarify line names (writer_rounds), and a loop ceiling per segment; R19 breaks parks down by rule, flags a loop park without a specific question, and says why H1 had objections', () => {
  const at = (h) => new Date(Date.UTC(2026, 0, 1) + h * 36e5).toISOString();
  const cl = (h, outcome, detail) => ({ kind: 'clarify', at: at(h), job: 'J-0009', stage: outcome, outcome, detail });
  const LIM = require('../inspector/config').LIMITS;
  // a line from 0.9.0 names writer_rounds, not writer_attempts: only what it names is checked
  const ok = { id: 'J-0009', state: { status: 'active' }, lock: { limits: {} }, decisions: [], events: [], ledger: [cl(1, 'check', { counters: { research_passes: 1, writer_rounds: 5, writer_attempts: 9 }, caps: { research_passes: 2, writer_rounds: 5 } })] };
  assert.deepEqual(rules.loops(ok), [], 'writer_attempts is not a cap any more; 5 of 5 rounds is within it');
  const over = { ...ok, ledger: [cl(1, 'check', { counters: { research_passes: 1, writer_rounds: 6 }, caps: { research_passes: 2, writer_rounds: 5 } })] };
  assert.match(rules.loops(over)[0].summary, /6 automatic writer round\(s\).*caps were 2 and 5/);
  // the loop engine's review rounds: the ceiling holds per segment, a resume starts a new one
  const fixRound = (h, rule) => ({ id: `J-0009-D${h}`, ts: at(h), action: 'workflow', workflow: 'realize', step: 'realize', scope: 'fix', rule });
  const seg = { ...ok, ledger: [], lock: { limits: { max_review_rounds: 3 } }, decisions: [fixRound(1, 'row4.confirmed_serious'), fixRound(2, 'row4.confirmed_serious'), fixRound(3, 'loop.review.escalate'), { id: 'r', ts: at(4), action: 'human.resume', from: 'review' }, fixRound(5, 'row4.confirmed_serious'), fixRound(6, 'row4.confirmed_serious')] };
  assert.deepEqual(rules.loops(seg), [], '5 rounds in 2 segments of at most 3');
  seg.decisions.push(fixRound(7, 'row4.confirmed_serious'), fixRound(8, 'loop.review.escalate'));
  assert.match(rules.loops(seg)[0].summary, /7 review rounds, but the cap allows 6 \(a ceiling of 3 per loop segment, 2 segment\(s\)\)/);
  // parks: by rule; an old cap park is called out; a loop park without a question is flagged
  const job = {
    id: 'J-0009', state: { status: 'parked' }, lock: { limits: {} }, events: [],
    ledger: [
      cl(1, 'park', { kind: 'agent', reason: 'The God Eye readiness check failed twice at the check stage (timed out after 900s).' }),
      cl(2, 'park', { kind: 'writer', reason: 'The contract still fails its readiness check after 2 writer attempt(s)' }),
      { kind: 'step', step: 'clarify', at: at(3), job: 'J-0009', ok: true, detail: { version: 3, approved: false, god_eye_objects: 2, loop_end: { rule: 'no_progress', rounds: 4, diagnosed: true } } },
    ],
    decisions: [
      { id: 'J-0009-D0010', ts: at(5), action: 'parked', rule: 'cap.review_rounds', park: { kind: 'review_rounds', from: 'review' }, reason: 'Review rounds used up (3)' },
      { id: 'J-0009-D0011', ts: at(6), action: 'parked', rule: 'loop.verify.no_progress', park: { kind: 'verify_fix_rounds', from: 'verify', question: 'Who creates POLICY_OK?', options: 2, diagnosed: true } },
    ],
  };
  const h = rules.jobHealth(job, LIM, at(10));
  const cp = h.find((x) => x.rule === 'R19.clarify_parked');
  assert.match(cp.summary, /parked 2 time\(s\) \(agent ×1, writer cap ×1\)/);
  assert.match(cp.summary, /1 of them on a cap \(factory before 0\.9\.0\)/);
  assert.equal(cp.severity, 'medium');
  const bare = h.find((x) => x.rule === 'R19.park_without_question');
  assert.ok(bare, h.map((x) => x.rule).join());
  assert.deepEqual(bare.evidence, ['J-0009-D0010'], 'the diagnosed park with its question is fine');
  assert.match(h.find((x) => x.rule === 'R19.proceeded_past_objections').summary, /2 God Eye objection\(s\) still open \(the readiness loop ended: no_progress, after a diagnosis\)/);
});

test('factory 0.11: the router\'s env_check and env_repair (between the seal and realize) are router steps, not steps outside the recipe; an unknown step still is', () => {
  const M = require('../inspector/model');
  assert.ok(M.SPECIAL_STEPS.has('env_check') && M.SPECIAL_STEPS.has('env_repair'));
  const at = (h) => new Date(Date.UTC(2026, 0, 1) + h * 36e5).toISOString();
  const recipe = { id: 'standard@medium', steps: [{ step: 'decompose', run: 'workflow:decompose' }, { step: 'H3', run: 'gate' }, { step: 'realize', run: 'workflow:realize' }] };
  const job = {
    id: 'J-0003', state: { status: 'active' }, lock: { recipe }, events: [],
    ledger: [{ kind: 'step', step: 'decompose', ok: true, at: at(1.5) }],
    decisions: [
      { id: 'D1', ts: at(1), action: 'workflow', workflow: 'decompose', step: 'decompose', rule: 'recipe.next' },
      { id: 'D2', ts: at(2), action: 'gate', step: 'H3' },
      { ts: at(2.5), action: 'human.approve', gate: 'H3' },
      { id: 'D3', ts: at(3), action: 'cli', step: 'env_check', command: 'factory env check --job J-0003', rule: 'env.check' },
      { id: 'D4', ts: at(4), action: 'workflow', workflow: 'fanout-judge', config: 'env_repair', step: 'env_repair', rule: 'env.repair' },
      { id: 'D5', ts: at(5), action: 'parked', park: { kind: 'environment_repair' } },
      { ts: at(5.5), action: 'human.resume' },
      { id: 'D6', ts: at(6), action: 'cli', step: 'env_check', command: 'factory env check --job J-0003', rule: 'env.check' },
      { id: 'D7', ts: at(7), action: 'workflow', workflow: 'realize', step: 'realize', rule: 'recipe.next' },
    ],
  };
  const found = rules.conformance(job).filter((x) => x.rule.startsWith('R3.'));
  assert.deepEqual(found.map((x) => `${x.rule} ${x.subject}`), []);
  job.decisions.push({ id: 'D8', ts: at(8), action: 'cli', step: 'env_probe', command: 'factory env probe' });
  assert.deepEqual(rules.conformance(job).filter((x) => x.rule === 'R3.step_not_in_recipe').map((x) => x.subject), ['J-0003:env_probe']);
});
