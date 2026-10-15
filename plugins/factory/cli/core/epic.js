'use strict';
// Epic = an outcome whose decomposition produced child jobs (slices). Depth is capped at 2.

const path = require('path');
const { readJson, nowIso, fail, exists } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const git = require('../lib/git');
const { runCommand } = require('../lib/run');
const job = require('./job');
const ledger = require('./ledger');
const contractMod = require('./contract');
const invalidation = require('./invalidation');
const planMod = require('./plan');

function childContract(epicState, epicParsed, slice) {
  const acs = epicParsed.acs.filter((a) => slice.criteria_ids.includes(a.id));
  const lines = [
    `# ${slice.id}: ${slice.goal}`,
    '',
    `<!-- factory contract · slice ${slice.id} of ${epicState.id} -->`,
    '',
    '## Intent',
    '<!-- Inherited from the epic; the outcome is this slice\'s share of it. -->',
    ...contractMod.intentLines({
      ...(epicParsed.intent || {}),
      outcome: slice.goal,
      why_now: `Slice ${slice.id} of ${epicState.id}${epicParsed.intent && epicParsed.intent.why_now && !contractMod.isPlaceholder(epicParsed.intent.why_now) ? ` — ${epicParsed.intent.why_now}` : ''}`,
      success: acs.length ? `${acs.map((a) => a.id).join(', ')} of the epic hold` : null,
    }),
    '',
    '## Goal',
    slice.goal,
    '',
    '## Non-goals',
    `- Anything owned by other slices of ${epicState.id}`,
    '',
    '## Acceptance criteria',
    '<!-- Seeded from the epic. Refine during clarify; keep the E-AC reference in the text. -->',
    ...acs.map((a, i) => `- AC-${i + 1}: ${a.text} [${a.id}] (evidence: ${a.evidence.join(', ')})`),
    '',
    '## Constraints',
    `- Conform to the contracts frozen at EH2 for ${epicState.id} (contracts.md / contracts.json)`,
    ...epicParsed.constraints.map((c) => `- ${c}`),
    '',
    '## Allowed paths',
    ...(slice.allowed_paths && slice.allowed_paths.length ? slice.allowed_paths.map((p) => `- ${p}`) : ['- <path/glob/**>']),
    '',
    '## Verify commands',
    '- `<command>` (AC-1)',
    '',
    '## Assumptions',
    '- <anything assumed rather than confirmed>',
    '',
  ];
  return lines.join('\n');
}

function spawn(root, { jobId }) {
  const epic = job.resolve(root, jobId);
  if (!epic.epic) fail(`${epic.id} is not an epic.`, 'bad_input');
  const v = planMod.validateSlices(root, epic);
  if (!v.valid) fail(`slices.json is invalid:\n- ${v.errors.join('\n- ')}`, 'plan_invalid');
  const doc = readJson(jobPaths(root, epic.id).slices);
  const parsed = contractMod.parse(contractMod.read(root, epic.id));
  const bySlice = {};
  for (const c of epic.children || []) bySlice[job.load(root, c).slice_id] = c;
  const created = [];
  for (const layer of planMod.layers(doc.slices).layers) {
    for (const sid of layer) {
      if (bySlice[sid]) continue;
      const s = doc.slices.find((x) => x.id === sid);
      const child = job.create(root, {
        title: `${epic.title} — ${s.id}: ${s.goal}`,
        workType: s.work_type || 'feature',
        risk: s.risk || epic.risk,
        parent: epic.id,
        sliceId: s.id,
        contractText: childContract(epic, parsed, s),
      });
      child.depends_on = (s.depends_on || []).map((d) => bySlice[d]).filter(Boolean);
      job.save(root, child);
      bySlice[sid] = child.id;
      created.push(child.id);
    }
  }
  job.setCurrent(root, epic.id);
  const fresh = job.load(root, epic.id);
  return { job: epic.id, created, children: fresh.children, next: 'Run each slice job in dependency order; factory next on the epic names the next ready one.' };
}

function gate(root, { jobId }) {
  const epic = job.resolve(root, jobId);
  const kids = (epic.children || []).map((c) => job.load(root, c));
  const open = kids.filter((k) => k.status !== 'closed');
  if (open.length) fail(`Slices not finished: ${open.map((k) => `${k.id}(${k.status})`).join(', ')}`, 'not_ready');
  const doc = readJson(jobPaths(root, epic.id).slices, {});
  const base = epic.base_branch;
  const at = git.revParse(root, base);
  const wt = path.join(root, '.factory', 'worktrees', `${epic.id}-gate`);
  if (exists(wt)) git.run(root, ['worktree', 'remove', '--force', wt], { allowFail: true });
  git.run(root, ['worktree', 'add', '--detach', wt, at]);
  const cmds = doc.epic_verify_commands || [];
  // inside the build environment, as each slice's verify ran them
  const envMod = require('./environment');
  let results;
  try {
    const E = envMod.ensure(root, epic, { taskId: 'gate', wt });
    if (!E.ok) fail(`${E.broken.reason}\nThe environment is broken, not the slices: fix it (factory env check, factory env set), then run the epic gate again.`, 'environment_broken', E.broken);
    results = cmds.map((c) => ({ ...runCommand(envMod.wrap(E.env, E.vars, c), wt, { timeoutSec: epic.policy.limits.command_timeout_seconds, reruns: epic.policy.limits.flaky_reruns }), cmd: c }));
  } finally {
    envMod.teardown(root, epic, { taskId: 'gate', wt });
    git.run(root, ['worktree', 'remove', '--force', wt], { allowFail: true });
  }
  const merged = kids.every((k) => k.pr && k.pr.merged && git.isAncestor(root, k.pr.merge_commit, at));
  const ok = merged && results.every((r) => r.pass) && cmds.length > 0;
  const childrenHash = invalidation.childrenHash(root, epic, job.load);
  ledger.append(root, epic.id, { kind: 'step', step: 'epic_gate', ok, bound: { children: childrenHash }, detail: { base, commit: at, merged, commands: results.map(({ output, ...r }) => ({ ...r, output: r.pass ? '' : output })) } });
  if (!ok) {
    const reason = !cmds.length
      ? 'slices.json has no epic_verify_commands, so the epic outcome cannot be proven end to end'
      : !merged
        ? 'not every slice is merged into the base branch'
        : `end-to-end checks failed: ${results.filter((r) => !r.pass).map((r) => r.cmd).join(', ')}`;
    require('./decision-table').park(root, job.load(root, epic.id), `Epic gate failed: ${reason}. Decide: a new slice (amend the epic) or a fix job for a merged slice.`, 'epic_gate');
  }
  return { job: epic.id, ok, commit: at, failed: results.filter((r) => !r.pass).map((r) => ({ cmd: r.cmd, output: r.output })), at: nowIso() };
}

module.exports = { spawn, gate };
