'use strict';
// Recipes and floors, the guard, schemas, globs, plan waves.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./helpers/fixture');
const recipes = require('../cli/core/recipes');
const { validate } = require('../cli/lib/schema');
const glob = require('../cli/lib/glob');
const planMod = require('../cli/core/plan');
const contract = require('../cli/core/contract');
const { checkBash, checkWrite, checkRead } = require('../hooks/guard-rules');
const policyMod = require('../cli/core/policy');

test('every shipped recipe is valid and covers its floors', () => {
  const rep = recipes.checkAll();
  for (const [id, errs] of Object.entries(rep)) assert.deepEqual(errs, [], id);
  assert.equal(recipes.listIds().length, 7);
});

test('a recipe that drops a floor step is refused', () => {
  const r = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'recipes', 'standard@medium.json'), 'utf8'));
  const noSecurity = { ...r, steps: r.steps.map((s) => (s.step === 'challenge' ? { ...s, lanes: ['code', 'tests'] } : s)) };
  assert.ok(recipes.check(noSecurity).some((e) => /challenge:security/.test(e)));
  const noGround = { ...r, steps: r.steps.filter((s) => s.step !== 'ground') };
  assert.ok(recipes.check(noGround).some((e) => /"ground"/.test(e)));
  const high = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'recipes', 'full@high.json'), 'utf8'));
  const autoH3 = { ...high, steps: high.steps.map((s) => (s.step === 'H3' ? { ...s, auto: 'plan_critique' } : s)) };
  assert.ok(recipes.check(autoH3).some((e) => /"H3"/.test(e)));
  const shipBeforeReview = { ...high, steps: [...high.steps.filter((s) => s.step !== 'challenge').slice(0, -3), high.steps.find((s) => s.step === 'challenge'), ...high.steps.slice(-3)] };
  assert.ok(recipes.check(shipBeforeReview).length > 0);
});

test('selection rules', () => {
  assert.equal(recipes.select({ workType: 'bug', risk: 'low' }), 'bug@low');
  assert.equal(recipes.select({ workType: 'feature', risk: 'low' }), 'feature@low');
  assert.equal(recipes.select({ workType: 'refactor', risk: 'medium' }), 'standard@medium');
  assert.equal(recipes.select({ workType: 'migration', risk: 'high' }), 'full@high');
  assert.equal(recipes.select({ workType: 'hotfix', risk: 'high' }), 'hotfix@high');
  assert.equal(recipes.select({ workType: 'spike', risk: 'medium' }), 'spike');
  assert.equal(recipes.select({ workType: 'feature', risk: 'medium', epic: true }), 'epic');
  const pol = policyMod.defaults();
  assert.equal(policyMod.effectiveRisk(pol, 'hotfix', 'low'), 'high');
  assert.equal(policyMod.effectiveRisk(pol, 'migration', 'medium'), 'high');
  assert.equal(policyMod.effectiveRisk(pol, 'bug', 'low'), 'low');
});

test('floors expand by level', () => {
  const low = recipes.expandFloors('low');
  const high = recipes.expandFloors('high');
  assert.ok(low.includes('challenge:code') && !low.includes('ground'));
  for (const f of low) assert.ok(high.includes(f));
  assert.ok(high.includes('threat_model') && high.includes('irreversible_signoff'));
});

test('guard: bash', () => {
  const root = F.makeRepo();
  const pol = policyMod.load(root);
  const denied = [
    'git push --force origin main',
    'git push -f',
    'git push origin +main',
    'git push -uf origin x',
    'git "push" "--force"',
    'g\\it push --for\\ce',
    'git commit --no-verify -m x',
    'git commit -nm "x"',
    'git -c core.hooksPath=/dev/null commit -m x',
    'echo x > .git/hooks/pre-commit',
    'factory approve',
    'node /x/bin/factory --root /r approve H1',
    'cd x && factory resume',
    'factory lessons accept L1',
    'factory ci install',
    'echo {} > .factory/jobs/J-0001/state.json',
    'cat x | tee .factory/log/decisions.jsonl',
    'rm .factory/jobs/J-0001/ledger.jsonl',
    'cat .env',
    'git show HEAD:.env',
    'git reset --hard factory/J-0001',
    'git push origin factory/J-0001',
  ];
  for (const c of denied) assert.ok(checkBash(root, c, pol), `should deny: ${c}`);
  const allowed = [
    'git push -u origin factory/J-0001-T1',
    'git commit -m "mention --no-verify in prose is fine? no"'.replace('--no-verify', 'no-verify'),
    'factory next',
    'factory amend start --reason "please approve the new scope"',
    'factory park --reason "waiting for approve from legal"',
    'npm test -- --force',
    'cat > .factory/scratch/envelope.json <<\'EOF\'\n{"text": "git push --force"}\nEOF',
    'cat .env.example',
    'git -C .factory/worktrees/J-0001-T1 commit -m fix',
    'factory lessons add --text "Never approve without tests" --scope "src/**"',
  ];
  for (const c of allowed) assert.equal(checkBash(root, c, pol), null, `should allow: ${c}`);
});

test('guard: writes and reads', () => {
  const root = F.makeRepo();
  const pol = policyMod.load(root);
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify({ tasks: [{ id: 'T1', objective: 'x', allowed_paths: ['src/**'], criteria_ids: ['AC-1'], verify_commands: ['true'] }] }));
  const p = (r) => path.join(root, r);
  assert.equal(checkWrite(root, p(`.factory/jobs/${J}/contract.md`), pol), null);
  assert.equal(checkWrite(root, p(`.factory/jobs/${J}/adr-001-x.md`), pol), null);
  assert.equal(checkWrite(root, p('.factory/scratch/envelope.json'), pol), null);
  assert.ok(checkWrite(root, p(`.factory/jobs/${J}/state.json`), pol));
  assert.ok(checkWrite(root, p(`.factory/jobs/${J}/critiques/design.json`), pol));
  assert.ok(checkWrite(root, p('.factory/policy.json'), pol));
  assert.equal(checkWrite(root, p(`.factory/worktrees/${J}-T1/src/a.js`), pol), null);
  assert.match(checkWrite(root, p(`.factory/worktrees/${J}-T1/README.md`), pol), /outside T1's allowed paths/);
  assert.ok(checkWrite(root, p('.github/workflows/ci.yml'), pol));
  assert.ok(checkWrite(root, p('.env'), pol));
  assert.ok(checkWrite(root, path.join(F.PLUGIN, 'recipes', 'bug@low.json'), pol));
  assert.equal(checkWrite(root, p('src/new.js'), pol), null);
  assert.ok(checkRead(root, p('.env'), pol));
  assert.ok(checkRead(root, p('config/prod.pem'), pol));
  assert.equal(checkRead(root, p('.env.example'), pol), null);
  // a symlink to a secret is caught by its real path
  fs.writeFileSync(p('id_rsa'), 'secret');
  fs.symlinkSync(p('id_rsa'), p('innocent.txt'));
  assert.ok(checkRead(root, p('innocent.txt'), pol));
});

test('guard hook end to end emits a deny decision', () => {
  const root = F.makeRepo();
  const { spawnSync } = require('child_process');
  const run = (input) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'guard.js')], { input: JSON.stringify(input), encoding: 'utf8' });
  const denied = run({ tool_name: 'Bash', tool_input: { command: 'git push --force' }, cwd: root });
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const allowed = run({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: root });
  assert.equal(allowed.stdout, '');
  const garbage = spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'guard.js')], { input: 'not json', encoding: 'utf8' });
  assert.equal(garbage.status, 0, 'a broken input never blocks Claude');
});

test('prompt hook applies an exact reply and reports a refused one', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  const { spawnSync } = require('child_process');
  const run = (prompt) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'prompt.js')], { input: JSON.stringify({ prompt, cwd: root }), encoding: 'utf8' });
  const notGate = JSON.parse(run('approve').stdout).hookSpecificOutput.additionalContext;
  assert.match(notGate, /NOT applied/);
  assert.equal(run('please continue').stdout, '');
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  assert.equal(F.cli(root, ['next']).step, 'H1');
  // a near miss is never applied, and says so with the exact forms
  const miss = JSON.parse(run('aprove').stdout).hookSpecificOutput.additionalContext;
  assert.match(miss, /NOTHING was applied/);
  assert.match(miss, /`approve \[J-0001\] \[H1\]`/);
  assert.match(JSON.parse(run('approve the contract please').stdout).hookSpecificOutput.additionalContext, /NOTHING was applied/);
  assert.equal(F.cli(root, ['next']).step, 'H1', 'still waiting at H1');
  assert.match(JSON.parse(run('Approve! 👍').stdout).hookSpecificOutput.additionalContext, /Applied your reply: Approved H1/);
  const evs = fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(evs.filter((e) => e.event === 'reply_unparsed').length, 2);
});

test('hook failures leave a sealed hook_error trace and never block', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  const st = path.join(F.jobDir(root, J), 'state.json');
  fs.writeFileSync(st, JSON.stringify({ ...JSON.parse(fs.readFileSync(st, 'utf8')), risk: 'high' }));
  const { spawnSync } = require('child_process');
  const r = spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'session-start.js')], { input: JSON.stringify({ cwd: root, hook_event_name: 'SessionStart' }), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const evs = fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const err = evs.find((e) => e.event === 'hook_error');
  assert.ok(err, 'hook_error logged');
  assert.equal(err.hook, 'session-start');
  assert.equal(err.hook_event, 'SessionStart');
  assert.equal(err.job, J);
  assert.ok(err.message && err.seal);
});

test('hooks.json: PostToolUse skips read-only tools; the guard covers Glob', () => {
  const H = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const post = new RegExp(`^(${H.PostToolUse[0].matcher})$`);
  for (const t of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Task', 'Agent', 'WebFetch']) assert.ok(post.test(t), t);
  for (const t of ['Read', 'Grep', 'Glob', 'TodoWrite']) assert.ok(!post.test(t), t);
  const pre = new RegExp(`^(${H.PreToolUse[0].matcher})$`);
  for (const t of ['Read', 'Grep', 'Glob', 'Write', 'Bash']) assert.ok(pre.test(t), t);
});

test('guard: Glob and Grep get the read rules (secret folder, glob filters)', () => {
  const root = F.makeRepo();
  const { spawnSync } = require('child_process');
  const secretDir = path.dirname(require('../cli/lib/seal').secretFile());
  const run = (tool_name, tool_input) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'guard.js')], { input: JSON.stringify({ tool_name, tool_input, cwd: root }), encoding: 'utf8' }).stdout;
  const denied = (out) => out && JSON.parse(out).hookSpecificOutput.permissionDecision === 'deny';
  assert.ok(denied(run('Glob', { pattern: '*', path: secretDir })));
  assert.ok(denied(run('Grep', { pattern: '.', path: secretDir })));
  assert.ok(denied(run('Grep', { pattern: 'KEY', glob: '.env*' })));
  assert.ok(denied(run('Grep', { pattern: 'x', glob: '*.pem' })));
  assert.ok(denied(run('Glob', { pattern: '*', path: path.join(root, '.env') })));
  assert.equal(run('Glob', { pattern: '**/*.js', path: root }), '');
  assert.equal(run('Grep', { pattern: 'add', glob: '*.js' }), '');
  assert.equal(run('Grep', { pattern: 'add', glob: '*' }), '');
});

test('stop hook blocks a "done" claim while floors fail', () => {
  const root = F.makeRepo();
  F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']);
  const { spawnSync } = require('child_process');
  const run = (msg) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'stop.js')], { input: JSON.stringify({ cwd: root, last_assistant_message: msg }), encoding: 'utf8' });
  assert.equal(JSON.parse(run('The fix is now complete and ready to merge.').stdout).decision, 'block');
  assert.equal(run('I drafted the contract; waiting for your answers.').stdout, '');
  for (const m of ["I've completed the task.", 'Everything is done.', "That's done!", 'Shipped.', 'All done 🎉']) assert.equal(JSON.parse(run(m).stdout || '{}').decision, 'block', m);
  for (const m of ['Is the fix complete?', 'The fix is not done yet.', 'Once the job is done, I will open the PR.', "The task isn't finished: tests fail."]) assert.equal(run(m).stdout, '', m);
});

test('stop hook checks every job the message names, not only the current one', () => {
  const root = F.makeRepo();
  const J1 = F.cli(root, ['job', 'new', '--title', 'one', '--type', 'bug', '--risk', 'low']).job;
  F.cli(root, ['park', '--reason', 'later']);
  const J2 = F.cli(root, ['job', 'new', '--title', 'two', '--type', 'bug', '--risk', 'low']).job;
  F.cli(root, ['use', J1]);
  F.cli(root, ['resume']); // human-only: refused, J1 stays parked
  const { spawnSync } = require('child_process');
  const run = (msg) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'stop.js')], { input: JSON.stringify({ cwd: root, last_assistant_message: msg }), encoding: 'utf8' }).stdout;
  assert.equal(run('The work is complete.'), '', 'the current job is parked: nothing owed');
  const out = JSON.parse(run(`I have finished the work on ${J2}.`));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, new RegExp(J2));
  assert.doesNotMatch(out.reason, new RegExp(`${J1} \\(`));
});

test('schemas: agent outputs and envelope are valid JSON Schema the validator accepts', () => {
  const dir = path.join(F.PLUGIN, 'schemas', 'agent-outputs');
  for (const f of fs.readdirSync(dir)) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.equal(s.type, 'object', f);
    assert.ok(Array.isArray(s.required), f);
  }
  const env = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'schemas', 'envelope.json'), 'utf8'));
  assert.deepEqual(validate(env, { workflow: 'ground', job: 'J-0001', status: 'ok', input_hash: 'x', budgets: { used: {} }, summary: '', data: {} }), []);
  assert.ok(validate(env, { workflow: 'nope', job: 'J-1', status: 'ok', input_hash: 'x', budgets: { used: {} }, summary: '', data: {} }).length);
  const reviewer = JSON.parse(fs.readFileSync(path.join(dir, 'reviewer.json'), 'utf8'));
  assert.deepEqual(validate(reviewer, { lane: 'code', findings: [{ id: 'code-1', severity: 'major', file: 'a.js', line: 3, summary: 's', rule: null }] }), []);
  assert.ok(validate(reviewer, { lane: 'code', findings: [{ id: 'x', severity: 'critical', summary: 's' }] }).length);
});

test('globs', () => {
  assert.ok(glob.matches('src/a/b.js', 'src/**'));
  assert.ok(glob.matches('src/a.js', 'src/*.js'));
  assert.ok(!glob.matches('src/a/b.js', 'src/*.js'));
  assert.ok(glob.matches('a/.env', '**/.env'));
  assert.ok(glob.matches('.env', '**/.env'));
  assert.ok(glob.matches('src/x.ts', 'src'));
  assert.ok(glob.globsOverlap(['src/**'], ['src/a/**']));
  assert.ok(!glob.globsOverlap(['src/a/**'], ['src/b/**']));
});

test('plan waves split dependency layers by overlapping paths; cycles are reported', () => {
  const tasks = [
    { id: 'T1', allowed_paths: ['src/a/**'], depends_on: [] },
    { id: 'T2', allowed_paths: ['src/a/x.js'], depends_on: [] },
    { id: 'T3', allowed_paths: ['src/b/**'], depends_on: [] },
    { id: 'T4', allowed_paths: ['src/c/**'], depends_on: ['T1'] },
  ];
  assert.deepEqual(planMod.waves(tasks).waves, [['T1', 'T3'], ['T2'], ['T4']]);
  assert.deepEqual(planMod.waves([{ id: 'T1', allowed_paths: ['a'], depends_on: ['T2'] }, { id: 'T2', allowed_paths: ['b'], depends_on: ['T1'] }]).cycle, ['T1', 'T2']);
});

test('contract parsing and placeholders', () => {
  const t = contract.template({ title: 'x', workType: 'bug', risk: 'low' });
  const p = contract.parse(t);
  assert.ok(contract.problems(p).length >= 2, 'the template itself is not a valid contract');
  const ok = contract.parse(F.contractText({ ac: '- AC-1: renders <Button> label (evidence: test, human)' }));
  assert.deepEqual(contract.problems(ok, { requirePlanFields: true }), []);
  assert.deepEqual(ok.acs[0].evidence, ['test', 'human']);
  assert.deepEqual(ok.verifyCommands, [{ cmd: 'node tests/add.test.js', covers: ['AC-1'] }]);
  assert.deepEqual(ok.allowedPaths, ['src/**', 'tests/**']);
});

test('contract Intent: parsed, placeholders fail the check, legacy contracts only where allowed', () => {
  const t = contract.parse(contract.template({ title: 'x', workType: 'bug', risk: 'low' }));
  assert.equal(t.intent.present, true);
  const probs = contract.problems(t);
  for (const f of ['Problem', 'Who', 'Outcome', 'Why now', 'Success signal']) assert.ok(probs.includes(`Intent: ${f} is missing or still a placeholder`), f);
  const ok = contract.parse(F.contractText());
  assert.equal(ok.intent.outcome, 'add returns the arithmetic sum');
  assert.equal(ok.intent.success, 'tests/add.test.js passes');
  assert.deepEqual(contract.problems(ok), []);
  const legacy = contract.parse(F.contractText({ intent: null }));
  assert.match(contract.problems(legacy)[0], /No "## Intent" section/);
  assert.deepEqual(contract.problems(legacy, { requireIntent: false }), [], 'approved legacy contracts still amend and plan');
  const noWhyNow = contract.parse(F.contractText({ intent: '- Problem: p is broken\n- Who is affected: ops\n- Desired outcome: p works\n- Success: alert clears' }));
  assert.deepEqual(contract.problems(noWhyNow), [], 'Why now is optional; label variants parse');
});

test('question protocol: intent first and alone, priority order, budget, never re-ask, ids and defaults', () => {
  const Q = require('../cli/core/questions');
  const cfg = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'config', 'workflows', 'clarify.json'), 'utf8'));
  const L = { max_intent_rounds: 4 };
  assert.deepEqual([1, 2, 3, 4].map((r) => Q.budget(cfg, r, L)), [5, 3, 3, 0], 'round 1 ≤ 5, later ≤ 3, last round none');
  assert.equal(cfg.fanout[0].category, 'intent');
  const list = [
    { question: 'Which DB?', category: 'constraint', why: 'w', default: 'postgres' },
    { question: 'Who is this for?', category: 'intent', why: 'w' },
    { question: 'Mobile too?', category: 'scope', why: 'w', default: 'no', options: ['yes', 'no'] },
  ];
  let s = Q.shape(list, { budget: 5, startId: 2 });
  assert.equal(s.intent_open, true);
  assert.deepEqual(s.questions.map((q) => [q.id, q.question]), [['Q-3', 'Who is this for?']]);
  assert.match(s.questions[0].default, /will not guess/);
  assert.equal(s.held.length, 2, 'scope and constraint wait for intent');
  s = Q.shape(list.slice(0, 1).concat(list.slice(2)), { budget: 1, asked: ['which db'] });
  assert.deepEqual(s.questions.map((q) => q.question), ['Mobile too?']);
  assert.deepEqual(s.questions[0].options, ['yes', 'no']);
  assert.deepEqual(s.dropped.map((d) => d.reason), ['already asked']);
  s = Q.shape([{ question: 'b', category: 'acceptance' }, { question: 'a', category: 'scope' }, { question: 'c', focus: 'constraints' }], { budget: 2 });
  assert.deepEqual(s.questions.map((q) => q.category), ['scope', 'constraint'], 'sorted by priority, over-budget dropped');
  assert.deepEqual(s.dropped, [{ question: 'b', reason: 'over budget' }]);
});

test('workflows: clarify runs the intent gate first and holds the other angles while intent is open', async () => {
  const H = require('./helpers/workflow-harness');
  const env = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'schemas', 'envelope.json'), 'utf8'));
  const item = (id, category, gate = false) => ({ id, label: id, category, gate, prompt: `p-${id}`, schema: {}, agent_type: 'factory:intent-analyst' });
  const brief = { workflow: 'fanout-judge', job: 'J-0001', input_hash: 'h', budgets: { limit: {} }, config: 'clarify', limits: { max_questions: 2 }, asked: ['Old question?'], fanout: [item('intent', 'intent', true), item('scope', 'scope'), item('tests', 'acceptance')], judge: { prompt: 'J', schema: {}, agent_type: 'factory:judge' }, critique: { prompt: 'C', schema: {}, agent_type: 'factory:god-eye' } };
  // intent unclear: only the gate runs; the judge is told; only intent questions come back
  let r = await H.run(path.join(F.PLUGIN, 'workflows', 'fanout-judge.js'), brief, (prompt) => {
    if (prompt.startsWith('J')) {
      assert.match(prompt, /INTENT GATE/);
      return { questions: [{ question: 'Old question?', category: 'intent', why: 'w', default: 'd' }, { question: 'Who uses it?', category: 'intent', why: 'w', default: 'd' }, { question: 'Edge?', category: 'acceptance', why: 'w', default: 'd' }], dismissed: [] };
    }
    if (prompt === 'p-intent') return { focus: 'intent', questions: [{ question: 'Who uses it?', why: 'w', blocking: true }] };
    throw new Error(`held angle ran: ${prompt}`);
  });
  assert.equal(r.result.status, 'needs_user');
  assert.deepEqual(r.result.questions.map((q) => q.question), ['Who uses it?'], 'never re-asks; intent alone');
  assert.deepEqual(r.result.data.held_back, ['scope', 'tests']);
  assert.deepEqual(r.result.data.degraded, [], 'held angles are not missing angles');
  assert.equal(r.result.data.intent_open, true);
  assert.deepEqual(validate(env, r.result), []);
  // intent clear: gate then the rest; the judge's list is cut to the budget in priority order; God Eye must confirm the intent
  r = await H.run(path.join(F.PLUGIN, 'workflows', 'fanout-judge.js'), brief, (prompt) => {
    if (prompt.startsWith('J')) return { questions: [{ question: 'a', category: 'acceptance', why: 'w', default: 'd' }, { question: 'b', category: 'scope', why: 'w', default: 'd' }, { question: 'c', category: 'constraint', why: 'w', default: 'd' }], dismissed: [] };
    return { focus: 'x', questions: [] };
  });
  assert.equal(r.calls.filter((c) => c.opts.agentType === 'factory:intent-analyst').length, 3);
  assert.deepEqual(r.result.questions.map((q) => q.question), ['b', 'c']);
  r = await H.run(path.join(F.PLUGIN, 'workflows', 'fanout-judge.js'), brief, (prompt) => {
    if (prompt.startsWith('J')) return { questions: [], dismissed: [] };
    if (prompt.startsWith('C')) return { verdict: 'approve', intent_confirmed: false, restatement: { problem: 'p', outcome: 'o' }, items: [] };
    return { focus: 'x', questions: [] };
  });
  assert.equal(r.result.status, 'needs_user', 'approve without a confirmed intent is not ok');
});

test('plan validate: coverage, unknown criteria, protected paths, locks held by another job', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'feature', '--risk', 'medium']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText({ ac: '- AC-1: a (evidence: test)\n- AC-2: b (evidence: test)' }));
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify({ tasks: [{ id: 'T1', objective: 'one', allowed_paths: ['.factory/**'], criteria_ids: ['AC-1', 'AC-9'], verify_commands: ['true'] }] }));
  const v = F.cli(root, ['plan', 'validate']);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => /AC-9/.test(e)));
  assert.ok(v.errors.some((e) => /AC-2 is not covered/.test(e)));
  assert.ok(v.errors.some((e) => /protected path/.test(e)));
});

test('epic: slices spawn child jobs in order; depth is capped at 2; the epic gate needs end-to-end commands', () => {
  const root = F.makeRepo();
  const E = F.cli(root, ['job', 'new', '--title', 'Big', '--type', 'feature', '--risk', 'medium', '--epic']).job;
  assert.equal(F.cli(root, ['job', 'show']).recipe.id, 'epic');
  fs.writeFileSync(path.join(F.jobDir(root, E), 'contract.md'), F.contractText({ ac: '- E-AC-1: a works (evidence: test)\n- E-AC-2: b works (evidence: test)' }));
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  let n = F.cli(root, ['next']);
  assert.equal(n.step, 'EH1');
  F.reply(root, 'approve');
  b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 't', claims: [], unknowns: [] }], degraded: [] }));
  n = F.cli(root, ['next']);
  assert.equal(n.config, 'decide');
  assert.equal(n.mode, 'contracts');
  b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'decide']);
  F.write(F.jobDir(root, E), 'adr-001-big.md', F.adrText({ job: E, acs: ['E-AC-1', 'E-AC-2'] }));
  F.write(F.jobDir(root, E), 'contracts.md', F.contractsDocText({ job: E }));
  F.write(F.jobDir(root, E), 'contracts.json', '{"interfaces":[]}\n');
  F.record(root, F.envelope(b, 'ok', { options: [], degraded: [], judge: { kind: 'contracts', paths: [path.join(F.jobDir(root, E), 'adr-001-big.md')], summary: 's' }, critiques: [{ verdict: 'approve', items: [] }] }));
  assert.equal(F.cli(root, ['next']).step, 'EH2');
  F.reply(root, 'approve');
  n = F.cli(root, ['next']);
  assert.equal(n.workflow, 'decompose');
  b = F.cli(root, ['wfargs', 'decompose']);
  assert.equal(b.mode, 'slices');
  fs.writeFileSync(path.join(F.jobDir(root, E), 'slices.json'), JSON.stringify({ slices: [{ id: 'S00', goal: 'contracts and flag', criteria_ids: ['E-AC-1'], depends_on: [] }, { id: 'S01', goal: 'b behind flag', criteria_ids: ['E-AC-2'], depends_on: ['S00'] }] }));
  F.record(root, F.envelope(b, 'ok', { planner: { valid: true, errors: [], path: 'slices.json' }, critique: null }));
  assert.equal(F.cli(root, ['next']).step, 'EH3');
  F.reply(root, 'approve');
  n = F.cli(root, ['next']);
  assert.match(n.command, /epic spawn/);
  const sp = F.cli(root, ['epic', 'spawn']);
  assert.equal(sp.created.length, 2);
  n = F.cli(root, ['next']);
  assert.equal(n.action, 'wait');
  assert.deepEqual(n.ready, [sp.created[0]], 'only S00 is ready; S01 depends on it');
  // a child of a child is refused
  F.cli(root, ['use', sp.created[0]]);
  const child = F.cli(root, ['job', 'show']);
  assert.equal(child.parent, E);
  const job = require('../cli/core/job');
  assert.throws(() => job.create(root, { title: 'deep', workType: 'bug', risk: 'low', parent: child.id }), /depth/);
  // the slice contract is seeded from the epic's criteria
  const childText = fs.readFileSync(path.join(F.jobDir(root, child.id), 'contract.md'), 'utf8');
  assert.match(childText, /\[E-AC-1\]/);
  const ci = contract.parse(childText).intent;
  assert.equal(ci.problem, contract.parse(F.contractText()).intent.problem, 'the slice inherits the epic intent');
  assert.equal(ci.outcome, 'contracts and flag');
  assert.match(ci.success, /E-AC-1/);
});

test('workflows: fanout-judge clarify / decide / challenge produce valid envelopes', async () => {
  const H = require('./helpers/workflow-harness');
  const env = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'schemas', 'envelope.json'), 'utf8'));
  const base = { workflow: 'fanout-judge', job: 'J-0001', input_hash: 'h', budgets: { limit: {} } };
  const item = (id, role = 'intent-analyst') => ({ id, label: id, prompt: `p-${id}`, schema: {}, agent_type: `factory:${role}` });

  // clarify: one analyst fails twice → degraded, judge still runs, no critique
  let r = await H.run(path.join(F.PLUGIN, 'workflows', 'fanout-judge.js'), { ...base, config: 'clarify', fanout: [item('a'), item('b'), item('c')], judge: { prompt: 'J', schema: {}, agent_type: 'factory:judge' }, critique: { prompt: 'C', schema: {}, agent_type: 'factory:god-eye' } }, (prompt) => {
    if (prompt === 'p-b') return null;
    if (prompt.startsWith('J')) return { questions: [], dismissed: [] };
    return { focus: 'x', questions: [] };
  });
  assert.equal(r.result.status, 'degraded');
  assert.deepEqual(r.result.data.degraded, ['b']);
  assert.deepEqual(validate(env, r.result), []);
  assert.equal(r.calls.filter((c) => c.prompt === 'p-b').length, 2, 'retried once');

  // decide: revise then approve
  let rounds = 0;
  r = await H.run(path.join(F.PLUGIN, 'workflows', 'fanout-judge.js'), { ...base, config: 'decide', fanout: [item('o1', 'option-generator'), item('o2', 'option-generator')], judge: { prompt: 'ARCH', schema: {}, agent_type: 'factory:architect' }, critique: { prompt: 'GOD', schema: {}, agent_type: 'factory:god-eye', max_rounds: 2, revise: { prompt: 'REV', schema: {}, agent_type: 'factory:architect' } } }, (prompt) => {
    if (prompt.startsWith('ARCH') || prompt.startsWith('REV')) return { kind: 'adr', paths: ['adr-001.md'], summary: 's' };
    if (prompt.startsWith('GOD')) return (rounds += 1) === 1 ? { verdict: 'revise', items: [{ issue: 'i', severity: 'major' }] } : { verdict: 'approve', items: [] };
    return { title: 't', summary: 's', pros: [], cons: [] };
  });
  assert.equal(r.result.status, 'ok');
  assert.equal(r.result.data.critiques.length, 2);
  assert.deepEqual(validate(env, r.result), []);

  // challenge: one verifier per serious finding
  r = await H.run(path.join(F.PLUGIN, 'workflows', 'fanout-judge.js'), { ...base, config: 'challenge', fingerprint: 'fp', fanout: [item('code', 'code-reviewer'), item('tests', 'test-reviewer')], judge: null, critique: null, verifier: { prompt_template: 'V {{finding}}', schema: {}, agent_type: 'factory:finding-verifier', severities: ['blocker', 'major'] } }, (prompt) => {
    if (prompt === 'p-code') return { lane: 'code', findings: [{ id: 'code-1', severity: 'major', summary: 's' }, { id: 'code-2', severity: 'minor', summary: 'm' }] };
    if (prompt === 'p-tests') return { lane: 'tests', findings: [] };
    if (prompt.startsWith('V')) return { finding_id: 'ignored', status: 'confirmed', reason: 'r' };
    return null;
  });
  assert.equal(r.result.data.verifications.length, 1);
  assert.equal(r.result.data.verifications[0].finding_id, 'code-1');
  assert.equal(r.result.fingerprint, 'fp');
  assert.deepEqual(validate(env, r.result), []);
});

test('workflows: realize retries, exhausts, blocks, and skips only dependents', async () => {
  const H = require('./helpers/workflow-harness');
  const env = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'schemas', 'envelope.json'), 'utf8'));
  const task = (id, deps = [], limit = 2) => ({ id, depends_on: deps, retry_limit: limit, builder: { role: 'builder', agent_type: 'factory:builder', escalate: ['opus'] }, tester: { role: 'tester', agent_type: 'factory:tester' }, builder_prompt: `B ${id} {{attempt}} {{failures}}`, tester_prompt: `T ${id} {{swept}}` });
  const brief = { workflow: 'realize', job: 'J-0001', input_hash: 'h', budgets: {}, waves: [['T1', 'T2', 'T3'], ['T4', 'T5']], tasks: { T1: task('T1'), T2: task('T2'), T3: task('T3'), T4: task('T4', ['T1']), T5: task('T5', ['T3']) }, max_parallel_tasks: 2, builder_schema: {}, tester_schema: {} };
  let t1 = 0;
  const r = await H.run(path.join(F.PLUGIN, 'workflows', 'realize.js'), brief, (prompt) => {
    if (prompt.startsWith('B T2')) return { status: 'blocked', summary: 'needs config', needs_paths: ['config/x'] };
    if (prompt.startsWith('B')) return { status: 'done', summary: 'ok', swept: [] };
    if (prompt.startsWith('T T1')) return (t1 += 1) === 1 ? { pass: false, failures: ['flaky assert'] } : { pass: true, failures: [] };
    if (prompt.startsWith('T T3')) return { pass: false, failures: ['always fails'] };
    return { pass: true, failures: [] };
  });
  const by = Object.fromEntries(r.result.data.tasks.map((t) => [t.id, t]));
  assert.equal(by.T1.outcome, 'done');
  assert.equal(by.T1.attempts, 2);
  assert.equal(by.T2.outcome, 'blocked');
  assert.equal(by.T3.outcome, 'exhausted');
  assert.equal(by.T4.outcome, 'done', 'T4 depends only on T1, which succeeded');
  assert.equal(by.T5.outcome, 'skipped_dependency');
  assert.equal(r.result.status, 'park');
  assert.deepEqual(validate(env, r.result), []);
  assert.ok(r.calls.some((c) => c.prompt.includes('flaky assert')), 'the retry sees the previous failures');
  const t1Builds = r.calls.filter((c) => c.prompt.startsWith('B T1'));
  assert.equal(t1Builds[0].opts.model, undefined, 'attempt 1 uses the agent\'s own model');
  assert.equal(t1Builds[1].opts.model, 'opus', 'attempt 2 escalates');
  assert.ok(r.calls.filter((c) => c.prompt.startsWith('T ')).every((c) => c.opts.agentType === 'factory:tester'));
  assert.ok(r.calls.filter((c) => c.prompt.startsWith('B ')).every((c) => c.opts.agentType === 'factory:builder'));
});

test('workflows: ground, decompose and reconcile', async () => {
  const H = require('./helpers/workflow-harness');
  const env = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'schemas', 'envelope.json'), 'utf8'));
  let r = await H.run(path.join(F.PLUGIN, 'workflows', 'ground.js'), { workflow: 'ground', job: 'J-0001', input_hash: 'h', budgets: {}, probes: [{ id: 'a', label: 'a', prompt: 'a', schema: {}, agent_type: 'factory:researcher' }] }, () => ({ topic: 'a', claims: [], unknowns: [{ question: 'Which DB?', blocking: true }] }));
  assert.equal(r.result.status, 'needs_user');
  assert.deepEqual(validate(env, r.result), []);
  let n = 0;
  r = await H.run(path.join(F.PLUGIN, 'workflows', 'decompose.js'), { workflow: 'decompose', mode: 'plan', job: 'J-0001', input_hash: 'h', budgets: {}, planner: { prompt: 'P', schema: {}, agent_type: 'factory:planner', max_rounds: 3 }, critique: null }, (prompt) => ((n += 1) < 3 ? { valid: false, errors: [`e${n}`], path: 'plan.json' } : { valid: true, errors: [], path: 'plan.json' }));
  assert.equal(r.result.status, 'ok');
  assert.ok(r.calls[2].prompt.includes('e2'), 'each round sees the last errors');
  assert.deepEqual(validate(env, r.result), []);
  r = await H.run(path.join(F.PLUGIN, 'workflows', 'reconcile.js'), { workflow: 'reconcile', job: 'J-0001', input_hash: 'h', budgets: {}, integrator: { prompt: 'I', schema: {}, agent_type: 'factory:integrator' } }, () => ({ status: 'behavioural_conflict', summary: 'T1 and T2 disagree', files: ['a.js'] }));
  assert.equal(r.result.status, 'park');
  assert.deepEqual(validate(env, r.result), []);
});

test('doctor reports readiness', () => {
  const root = F.makeRepo();
  const d = F.cli(root, ['doctor']);
  assert.equal(d.ready, true, JSON.stringify(d.checks.filter((c) => !c.ok)));
  assert.ok(d.checks.some((c) => c.name === 'remote' && c.level === 'warning'));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-'));
  assert.equal(F.cli(bare, ['init']).code, 'no_git');
});

test('spike: grounded recommendation, HF gate, close without shipping code', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Which queue?', '--type', 'spike', '--risk', 'medium']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText({ goal: 'Decide which queue library fits our retry needs.', ac: '- AC-1: a recommendation with evidence is written (evidence: doc)' }));
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 'external', claims: [{ claim: 'lib A supports retries', source: 'https://example.com/a' }], unknowns: [] }], degraded: [] }));
  const n = F.cli(root, ['next']);
  assert.equal(n.mode, 'recommendation');
  b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'decide']);
  assert.ok(!b.fanout.some((f) => f.id === 'threat-modeler'));
  F.write(F.jobDir(root, J), 'recommendation.md', F.recommendationText({ job: J }));
  F.record(root, F.envelope(b, 'ok', { options: [], degraded: [], judge: { kind: 'recommendation', paths: [path.join(F.jobDir(root, J), 'recommendation.md')], summary: 'A' }, critiques: [{ verdict: 'approve', items: [] }] }));
  const g = F.cli(root, ['next']);
  assert.equal(g.step, 'HF');
  assert.ok(g.gate.docs.some((d) => d.endsWith('findings.md')));
  F.reply(root, 'approve');
  assert.match(F.cli(root, ['next']).command, /close/);
  assert.equal(F.cli(root, ['close']).status, 'closed');
  assert.equal(F.cli(root, ['next']).action, 'done');
});

test('guard: agents cannot reach human-only actions or factory internals', () => {
  const root = F.makeRepo();
  const pol = policyMod.load(root);
  const denied = [
    'factory --job=J-0001 approve',
    'factory -- approve',
    'factory --root /r --job J-0001 resume',
    'F=factory; $F approve',
    '${F} approve',
    'script -qc "factory approve" /dev/null',
    'unbuffer factory approve',
    "node -e \"require('/p/cli/core/human').approve('/r',{channel:'chat'})\"",
    "python3 -c \"open('.factory/jobs/J-0001/state.json','w').write('{}')\"",
    "node <<'EOF'\nrequire('/p/cli/core/job')\nEOF",
    'cat ~/.config/software-factory/secret',
    'factory reseal --job J-0001',
    'factory review record --file x.json',
  ];
  for (const c of denied.slice(0, 12)) assert.ok(checkBash(root, c, pol), `should deny: ${c}`);
  // review record no longer exists at all
  assert.equal(F.cli(root, ['review', 'record', '--file', 'x']).code, 'bad_input');
  // the documented restore path works: cp writes only its destination
  assert.equal(checkBash(root, 'cp .factory/jobs/J-0001/approved/H1-abc.md .factory/jobs/J-0001/contract.md', pol), null);
  assert.ok(checkBash(root, 'mv .factory/jobs/J-0001/state.json /tmp/x', pol));
  const { checkContent } = require('../hooks/guard-rules');
  assert.ok(checkContent("const h = require('../plugin/cli/core/human')", '/r/tool.js'));
  assert.equal(checkContent('See .factory/jobs for details, from the ADR.', '/r/.factory/jobs/J-0001/adr-001.md'), null);
});

test('seals: hand-edited state, ledger lines and critiques are not trusted', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  // a forged ledger line is ignored
  fs.appendFileSync(path.join(F.jobDir(root, J), 'ledger.jsonl'), JSON.stringify({ at: 'x', job: J, kind: 'step', step: 'clarify', ok: true, bound: {} }) + '\n');
  assert.equal(require('../cli/core/ledger').all(root, J).length, 0);
  // a hand-edited state.json is refused until a human reseals it
  const sf = path.join(F.jobDir(root, J), 'state.json');
  const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
  st.approvals.H1 = { hash: 'forged', at: 'now', via: 'chat' };
  fs.writeFileSync(sf, JSON.stringify(st));
  const n = F.cli(root, ['next']);
  assert.equal(n.code, 'tampered');
  assert.equal(F.cli(root, ['reseal']).code, 'human_only');
});

test('workflows refuse a brief item without a factory agent type', async () => {
  const H = require('./helpers/workflow-harness');
  await assert.rejects(
    H.run(path.join(F.PLUGIN, 'workflows', 'ground.js'), { workflow: 'ground', job: 'J-0001', input_hash: 'h', budgets: {}, probes: [{ id: 'a', label: 'a', prompt: 'a', schema: {} }] }, () => ({ topic: 'a', claims: [], unknowns: [] })),
    /no factory agent_type/,
  );
});

test('briefs name a real factory agent for every item, and carry only the run context', () => {
  const root = F.makeRepo();
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ agents: { models: { researcher: 'haiku' }, builder_escalation: ['opus'] } }));
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'feature', '--risk', 'medium']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  const g = F.cli(root, ['wfargs', 'ground']);
  for (const p of g.probes) {
    assert.equal(p.agent_type, 'factory:researcher');
    assert.equal(p.model, 'haiku');
    assert.ok(fs.existsSync(path.join(F.PLUGIN, 'agents', 'researcher.md')));
    const file = fs.readFileSync(p.prompt.split('\n')[1].trim(), 'utf8');
    assert.ok(!file.includes('You are a researcher grounding one topic'), 'the role text is the agent\'s system prompt, not repeated in the brief');
    assert.match(file, /## This run/);
  }
  const c = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  const specs = [...c.fanout, c.judge, c.critique];
  for (const sp of specs) assert.match(sp.agent_type, /^factory:(intent-analyst|judge|god-eye)$/);
  assert.equal(c.judge.model, undefined, 'no model unless policy names one');
});
