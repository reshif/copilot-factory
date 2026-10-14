'use strict';
// Builds the brief a workflow runs from. Workflow scripts can't read files or run
// commands, so everything they need — which factory agent runs each item, the run
// context, schemas, limits, the input hash — arrives here, assembled by the CLI.

const path = require('path');
const { readText, readJson, writeText, sha256, stableStringify, fail } = require('../lib/util');
const { pluginPath, jobPaths, taskWorktree, PLUGIN_ROOT } = require('../lib/paths');
const git = require('../lib/git');
const job = require('./job');
const steps = require('./steps');
const ledger = require('./ledger');
const contractMod = require('./contract');
const lessons = require('./lessons');
const review = require('./review');
const budgets = require('./budgets');
const invalidation = require('./invalidation');
const questions = require('./questions');
const docs = require('./doc');

// The self-check an agent runs on a doc it wrote before returning.
function docCheck(root, state, file) {
  return `Before returning, run \`${cli(root)} doc check ${file} --job ${state.id}\` and fix every problem it lists (missing or out-of-order sections, front matter, placeholders, tables, uncovered criteria, malformed or missing Mermaid). \`factory record\` runs the same check and rejects the design otherwise.`;
}

function roleBody(role) {
  const t = readText(pluginPath('agents', `${role}.md`), null);
  if (t === null) fail(`Agent definition agents/${role}.md is missing`, 'plugin_broken');
  return t.replace(/^---[\s\S]*?\n---\n/, '').trim();
}

function schema(name) {
  return readJson(pluginPath('schemas', 'agent-outputs', `${name}.json`));
}

function cli(root) {
  return `node "${path.join(PLUGIN_ROOT, 'bin', 'factory')}" --root "${root}"`;
}

// Full instructions go to a file under .factory/scratch/briefs/; the brief carries a short
// pointer to it, so the workflow args stay small. `tail` holds the per-call parts the
// workflow fills in ({{attempt}}, {{failures}}, {{swept}}, {{finding}}) or appends (INPUTS).
let RUN = null;

// The role's instructions are not repeated here: workflows start each agent as its
// factory agent type (factory:<role>), so agents/<role>.md is already its system prompt
// and its tool limits and model apply. Inline briefs (no files) still carry the role text.
function fullText(role, context, schemaName, withRole = false) {
  return [
    ...(withRole ? [roleBody(role), '', '---'] : [`# Factory ${role} — this run`, '']),
    '## This run',
    context.trim(),
    '',
    '## Working with files',
    '- Read files (including anything in the job folder) with the Read, Grep and Glob tools. Change files with Write and Edit, and only the ones this run tells you to.',
    '- Never run python, node or other interpreter scripts against the job folder or the factory\'s own files, not even to pretty-print JSON or replace a section: the guard blocks it and the attempt is logged. If Edit cannot match a long passage, rewrite the whole file with Write.',
    '- Use Bash for the project\'s own commands and the factory CLI shown above.',
    '',
    '## Your output',
    'Return only one JSON object that matches this schema — no prose before or after it:',
    '```json',
    JSON.stringify(schema(schemaName)),
    '```',
  ].join('\n');
}

function prompt(role, context, schemaName, tail = '') {
  if (!RUN) {
    const text = fullText(role, context, schemaName, true);
    return tail ? `${text}\n\n${tail}` : text;
  }
  const text = fullText(role, context, schemaName);
  RUN.n += 1;
  const file = path.join(RUN.dir, `${String(RUN.n).padStart(2, '0')}-${role}.md`);
  writeText(file, text);
  return [
    `You are running as the Software Factory's ${role} (your role instructions are your system prompt). Before doing anything else, read this run's context and the exact JSON output schema from this file:`,
    `  ${file}`,
    'Follow your role and that context exactly, and finish by returning only that JSON object.',
    tail ? `\n${tail}` : '',
  ].join('\n').trim();
}

// Your "deny <reason>" at a gate reaches the agents who redo that work.
function denialNotes(state, gates) {
  const notes = [];
  for (const g of gates) {
    const approvedAt = state.approvals && state.approvals[g] ? state.approvals[g].at : '';
    for (const d of state.denials || []) if (d.gate === g && d.at > approvedAt) notes.push(`  - At ${g} the human said: ${d.reason || '(no reason given)'}`);
  }
  return notes.length ? `- The human denied the previous version. Address every point:\n${notes.join('\n')}` : '';
}

function jobContext(root, state, gates = []) {
  const jp = jobPaths(root, state.id);
  const parsed = contractMod.parse(contractMod.read(root, state.id));
  return [
    `- Project root: ${root}`,
    `- Job: ${state.id} — ${state.title}`,
    `- Work type: ${state.work_type} · Risk: ${state.risk} · Recipe: ${state.recipe.id}`,
    `- Job folder: ${jp.dir}`,
    `- Contract: ${jp.contract}`,
    `- Factory CLI: \`${cli(root)}\``,
    parsed.intent && parsed.intent.present
      ? `- Intent:\n${contractMod.INTENT_FIELDS.map((f) => `  - ${f.label}: ${parsed.intent[f.key] && !contractMod.isPlaceholder(parsed.intent[f.key]) ? parsed.intent[f.key] : '(not settled yet)'}`).join('\n')}`
      : '- Intent: (no Intent section yet)',
    `- Goal: ${parsed.goal || '(not written yet)'}`,
    parsed.acs.length ? `- Acceptance criteria:\n${parsed.acs.map((a) => `  - ${a.id}: ${a.text} (evidence: ${a.evidence.join(', ')})`).join('\n')}` : '- Acceptance criteria: (none yet)',
    denialNotes(state, gates),
  ]
    .filter(Boolean)
    .join('\n');
}

// Which factory agent runs an item, and on which model (policy.agents.models, optional).
function agentSpec(state, role) {
  const a = (state.policy && state.policy.agents) || {};
  const model = (a.models || {})[role] || null;
  return { role, agent_type: `factory:${role}`, ...(model ? { model } : {}) };
}

function inputHash(parts) {
  return sha256(stableStringify(parts));
}

function base(root, state, workflow, extra = {}) {
  return {
    workflow,
    job: state.id,
    root,
    plugin_root: PLUGIN_ROOT,
    cli: cli(root),
    budgets: budgets.snapshot(root, state),
    ...extra,
  };
}

// ---------------------------------------------------------------- fanout-judge: clarify
function clarify(root, state, ctx, acceptDegraded) {
  const cfg = readJson(pluginPath('config', 'workflows', 'clarify.json'));
  const round = state.counters.clarify_rounds + 1;
  const L = state.policy.limits;
  const maxQ = questions.budget(cfg, round, L);
  const answers = readJson(jobPaths(root, state.id).answers, []);
  const asked = questions.askedList(state, answers);
  const jc = jobContext(root, state, ['H1', 'EH1']);
  const askedText = asked.map((q) => `  - ${q}`).join('\n') || '  - (none)';
  const answersText = answers.map((a) => `  - Q: ${a.question}\n    A: ${a.answer}`).join('\n') || '  - (none)';
  const protocol = [
    `- Question protocol: categories in priority order ${cfg.priority.join(' > ')}. While any intent question is open, only intent questions are asked; the rest wait.`,
    '- Every question: one line, answerable in one line (multiple choice with 2-4 options when possible), with why it matters and the default the factory will use if unanswered.',
  ].join('\n');
  const fanout = cfg.fanout.map((f) => ({
    id: `${f.role}:${f.focus}`,
    ...agentSpec(state, f.role),
    category: f.category || questions.FOCUS_CATEGORY[f.focus] || 'scope',
    gate: Boolean(f.gate),
    label: `analyst · ${f.focus}`,
    prompt: prompt(f.role, `${jc}\n- Your focus: **${f.focus}** (category: ${f.category || 'scope'}) — ${f.brief}${f.gate ? '\n- You are the intent gate: you run first and alone. Mark a question blocking only if the problem, who, outcome or success signal is genuinely unclear; the other angles wait until you have none. Fill restatement with your one-line readings.' : ''}\n${protocol}\n- Round ${round}. Questions already asked (never repeat them):\n${askedText}\n- Answers given earlier:\n${answersText}`, 'analyst'),
    schema: schema('analyst'),
  }));
  const judge = {
    ...agentSpec(state, 'judge'),
    prompt: prompt(
      'judge',
      `${jc}\n- Mode: clarify, round ${round} of at most ${L.max_intent_rounds}.\n- Ask at most ${maxQ} questions this round${maxQ === 0 ? ' (question budget spent: return none, record assumptions instead)' : ''}.\n${protocol}\n- Never re-ask any of these:\n${askedText}\n- Answers given earlier:\n${answersText}\n- The analysts' outputs follow under INPUTS.`,
      'judge',
    ),
    schema: schema('judge'),
  };
  const critique = {
    ...agentSpec(state, 'god-eye'),
    prompt: prompt('god-eye', `${jc}\n- Focus: **intent**. Read ${jobPaths(root, state.id).contract} cold, as someone who has never seen this conversation.\n- First restate, in one line each, the problem, who has it, the outcome and the success signal, from the contract alone. Set intent_confirmed true only if your restatement matches the Intent and Goal sections and they agree with each other.\n- Approve only if intent_confirmed, a builder could start from it without asking anything, and every criterion is provable by its evidence type.`, cfg.critique.schema || 'critique'),
    schema: schema(cfg.critique.schema || 'critique'),
    max_rounds: 1,
    when: 'no_questions',
  };
  return base(root, state, 'fanout-judge', {
    config: 'clarify',
    mode: state.epic ? 'epic' : null,
    input_hash: inputHash({ contract: ctx.b.contract, round }),
    accept_degraded: Boolean(acceptDegraded),
    round,
    limits: { max_questions: maxQ, priority: cfg.priority },
    asked,
    fanout,
    judge,
    critique,
    verifier: null,
  });
}

// ---------------------------------------------------------------- fanout-judge: decide
function decide(root, state, ctx, action) {
  const cfg = readJson(pluginPath('config', 'workflows', 'decide.json'));
  const jp = jobPaths(root, state.id);
  const mode = action.mode || (state.epic ? 'contracts' : null);
  const threat = action.threat_model === true || (action.threat_model === undefined && state.risk === 'high');
  const lastCritique = readJson(path.join(jp.critiquesDir, 'design.json'), null);
  const priorDesign = invalidation.designFiles(root, state.id);
  const docProblems = priorDesign.length ? docs.designProblems(root, state) : [];
  const history = [
    priorDesign.length ? `- This is not the first design round. Current design files (read them with the Read tool): ${priorDesign.join(', ')}` : '',
    docProblems.length ? `- The current design record breaks the doc templates; \`factory record\` rejects it until these are fixed:\n${docProblems.slice(0, 20).map((p) => `  - ${p}`).join('\n')}` : '',
    lastCritique && Array.isArray(lastCritique.items) && lastCritique.items.length
      ? `- God Eye's last design critique (${lastCritique.verdict}):\n${lastCritique.items.slice(0, 12).map((it) => `  - ${typeof it === 'string' ? it : [it.severity, it.issue || it.summary || JSON.stringify(it)].filter(Boolean).join(': ')}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n');
  const jc = `${jobContext(root, state, ['H2', 'EH2', 'HF'])}\n- Findings (cited): ${jp.findings}${history ? `\n${history}` : ''}`;
  const existingAdrs = priorDesign.filter((f) => /adr-\d+/.test(f));
  const nextAdr = existingAdrs.length
    ? `${existingAdrs[existingAdrs.length - 1]} (revise it in place — keep this path — unless the decision itself is new)`
    : path.join(jp.dir, 'adr-001-<short-title>.md');
  const fanout = cfg.fanout
    .filter((f) => !(f.when === 'threat_model' && !threat))
    .filter((f) => !(mode === 'recommendation' && f.role === 'threat-modeler'))
    .map((f, i) => {
      if (f.role === 'threat-modeler') {
        return { id: 'threat-modeler', ...agentSpec(state, 'threat-modeler'), label: 'threat model', prompt: prompt('threat-modeler', `${jc}\n- Write the threat model to ${jp.threatModel}, following ${docs.templatePath('threat-model')} exactly: its front matter, its sections in order, a Mermaid data-flow diagram with every trust boundary as a subgraph, and a STRIDE table with ids TH-1, TH-2…\n- ${docCheck(root, state, jp.threatModel)}\n- Then return its path and the threats.`, 'threat'), schema: schema('threat') };
      }
      return {
        id: `option-${i + 1}`,
        ...agentSpec(state, 'option-generator'),
        label: `option · ${f.prior}`,
        prompt: prompt('option-generator', `${jc}\n- Your prior: optimise for **${f.prior}**. Other generators optimise for other things; do not hedge toward them.${mode === 'contracts' ? '\n- This is an epic: the option must say which interfaces/contracts get frozen first.' : ''}${mode === 'recommendation' ? '\n- This is a spike: the option is a candidate answer to the research question.' : ''}`, 'option'),
        schema: schema('option'),
      };
    });
  const tpl = (t) => docs.templatePath(t);
  const what =
    mode === 'recommendation'
      ? `Write the recommendation to ${jp.recommendation} following ${tpl('recommendation')} (question, options weighed, recommendation, confidence, what would change it, evidence). kind = "recommendation".`
      : mode === 'contracts'
        ? `Write the decision as an ADR (${nextAdr}) following ${tpl('adr')}, the human-readable contracts to ${jp.contractsMd} following ${tpl('contracts')}, and the machine-readable interface list to ${jp.contractsJson}. kind = "contracts".`
        : `If there is a real decision (two or more viable options with different consequences), write an ADR to ${nextAdr} following ${tpl('adr')} (kind "adr"). Otherwise write ${jp.noAdr} following ${tpl('no-adr')} (kind "no-adr").`;
  const rules = [
    '- Every design doc keeps its template\'s front matter (doc, template, job, title, status, date, contract, related) and its "##" sections in the template\'s order. Every acceptance criterion gets a row in "How each acceptance criterion is met".',
    mode === 'recommendation' ? '' : `- An ADR needs a Mermaid architecture diagram (a C4-style flowchart: actors and external systems, the system boundary as a subgraph, the modules inside, every edge labelled) that shows how things will look after the change; add a sequenceDiagram under "### Key flow" when ordering matters.${threat ? ' Map every threat id (TH-n) from the threat model in "Threat mitigations".' : ''}`,
    `- ${docCheck(root, state, '<file>')}`,
  ].filter(Boolean).join('\n');
  const judge = {
    ...agentSpec(state, 'architect'),
    prompt: prompt('architect', `${jc}\n- ${what}\n${rules}\n- The option generators' outputs${threat ? ' and the threat model' : ''} follow under INPUTS. Record the options you rejected and why.`, 'architect'),
    schema: schema('architect'),
  };
  const maxRounds = state.policy.limits.max_design_critique_rounds;
  const critique = {
    ...agentSpec(state, 'god-eye'),
    prompt: prompt('god-eye', `${jc}\n- Focus: **design**. Read the design record (paths under INPUTS) cold. Approve only if it follows from the findings, meets every criterion, and a planner could split it into tasks.${mode === 'recommendation' ? '' : ' The architecture diagram must match the Decision (same modules, same flows) and be specific to this change, not generic boxes.'}${threat ? ` Check the threat model at ${jp.threatModel} is addressed.` : ''}`, 'critique'),
    schema: schema('critique'),
    max_rounds: maxRounds,
    revise: { ...agentSpec(state, 'architect'), prompt: prompt('architect', `${jc}\n- Revise the design record you wrote to address the critique under INPUTS. Keep the same file paths and keep following the templates.\n${rules}`, 'architect'), schema: schema('architect') },
  };
  return base(root, state, 'fanout-judge', { config: 'decide', mode, input_hash: inputHash({ contract: ctx.b.contract, findings: ctx.b.findings }), fanout, judge, critique, verifier: null, threat_model: threat });
}

// ---------------------------------------------------------------- fanout-judge: challenge
function challenge(root, state, ctx, action) {
  const cfg = readJson(pluginPath('config', 'workflows', 'challenge.json'));
  const mode = action.mode || null;
  const jp = jobPaths(root, state.id);
  let lanes;
  let diffCmd;
  let extra = '';
  if (mode === 'conformance') {
    lanes = ['conformance'];
    const kids = (state.children || []).map((c) => job.load(root, c));
    diffCmd = `git -C "${root}" log --oneline ${state.base_commit}..${state.base_branch}`;
    extra = `- Contracts: ${jp.contractsMd} and ${jp.contractsJson}\n- Slice jobs and merge commits:\n${kids.map((k) => `  - ${k.id} (${k.slice_id}): ${(k.pr && k.pr.merge_commit) || 'not merged'}`).join('\n')}`;
  } else if (mode === 'post_merge') {
    lanes = action.lanes || ['code', 'security'];
    const m = state.pr && state.pr.merge_commit;
    if (!m) fail('Post-merge review needs the merge commit.', 'not_merged');
    diffCmd = `git -C "${root}" diff ${m}^1 ${m} -- . ':(exclude).factory-ship'`;
    extra = '- This is a post-merge review: a fresh round 1 on what actually landed.';
  } else {
    lanes = review.requiredLanes(ctx, action.lanes);
    diffCmd = `git -C "${root}" diff ${state.base_commit} ${state.branch} -- . ':(exclude).factory-ship'`;
    const prev = ledger.lastStep(root, state.id, 'challenge');
    const round = prev && prev.bound && prev.bound.fingerprint !== ctx.b.fingerprint ? (prev.detail.round || 1) + 1 : (prev && prev.detail.round) || 1;
    const changedSince = prev && prev.detail && prev.detail.commit ? git.changedFiles(root, prev.detail.commit, state.branch) : null;
    extra = [
      `- Review round ${round} of ${state.policy.limits.max_review_rounds}.`,
      prev ? `- Previous serious findings:\n${(prev.detail.findings || []).filter((f) => f.severity !== 'minor').map((f) => `  - ${f.id} [${f.severity}/${f.status}] ${f.file || ''} ${f.summary}`).join('\n') || '  - (none)'}` : '',
      changedSince ? `- Files changed since the last round: ${changedSince.join(', ') || '(none)'}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const changed = mode === 'conformance' ? [] : (() => {
    try {
      return git.changedFiles(root, state.base_commit, state.branch).filter((f) => !f.startsWith('.factory-ship/'));
    } catch {
      return [];
    }
  })();
  const ls = lessons.inScope(root, changed);
  const jc = jobContext(root, state);
  const fanout = lanes.map((lane) => {
    const role = cfg.lanes[lane];
    if (!role) fail(`No reviewer configured for lane "${lane}"`, 'plugin_broken');
    return {
      id: lane,
      ...agentSpec(state, role),
      label: `review · ${lane}`,
      prompt: prompt(
        role,
        `${jc}\n- Lane: **${lane}**\n- See the change with: \`${diffCmd}\`\n- Changed files: ${changed.join(', ') || '(see diff)'}\n${extra}\n- Accepted lessons to check (a broken lesson is a finding with rule "lesson:<id>"):\n${ls.map((l) => `  - ${l.id}: ${l.text}`).join('\n') || '  - (none)'}\n- Give every finding a unique id starting with "${lane}-". Use severity blocker/major only for real defects you can point to.`,
        'reviewer',
      ),
      schema: schema('reviewer'),
    };
  });
  const verifier = {
    ...agentSpec(state, 'finding-verifier'),
    prompt_template: prompt('finding-verifier', `${jc}\n- See the change with: \`${diffCmd}\`\n- The finding to verify is given below your pointer to this file.\n- Try to reproduce or disprove it from the code and, where cheap, by running something. Be sceptical in both directions.`, 'verifier', 'The finding to verify:\n{{finding}}'),
    schema: schema('verifier'),
    severities: cfg.verifier.severities,
  };
  return base(root, state, 'fanout-judge', {
    config: 'challenge',
    mode,
    lanes_requested: action.lanes || null,
    fingerprint: ctx.b.fingerprint,
    input_hash: inputHash({ fingerprint: ctx.b.fingerprint, children: ctx.b.children, mode }),
    fanout,
    judge: null,
    critique: null,
    verifier,
  });
}

// ---------------------------------------------------------------- ground
function ground(root, state, ctx, action) {
  const jp = jobPaths(root, state.id);
  const answers = readJson(jp.answers, []);
  const hotfix = action.mode === 'hotfix';
  const topics = hotfix
    ? [
        ['failing path', 'Reproduce or locate the failure: the code path, the inputs, the recent commits that touched it.'],
        ['blast radius', 'Who calls this path, which tests cover it, and what else would break with a fix.'],
      ]
    : [
        ['codebase', 'Where the change lands: the files, existing patterns to follow, the tests that cover it.'],
        ['interfaces', 'Libraries, APIs, data shapes and versions involved; what callers depend on.'],
        ['history', `Prior decisions and lessons: ADRs in the repo, ${path.join(root, '.factory', 'lessons', 'lessons.json')}, recent commits in these areas.`],
        ['external', 'Only if the contract depends on something outside the repo: official docs, cited by URL. Otherwise return no claims.'],
      ];
  const cap = state.policy.limits.max_parallel_research;
  const jc = jobContext(root, state);
  const probes = topics.slice(0, Math.max(1, cap)).map(([t, brief]) => ({
    id: t,
    ...agentSpec(state, 'researcher'),
    label: `ground · ${t}`,
    prompt: prompt('researcher', `${jc}\n- Topic: **${t}** — ${brief}\n- Every claim needs a source: file:line, a command and its output, or a URL. If you can't source it, set source to "UNVERIFIED".\n- Answers you already gave:\n${answers.map((a) => `  - Q: ${a.question}\n    A: ${a.answer}`).join('\n') || '  - (none)'}\n- Mark an unknown as blocking only if the design genuinely cannot proceed without your answer.`, 'researcher'),
    schema: schema('researcher'),
  }));
  return base(root, state, 'ground', { mode: action.mode || null, input_hash: inputHash({ contract: ctx.b.contract, answers: answers.length }), probes });
}

// ---------------------------------------------------------------- decompose
function decompose(root, state, ctx, action) {
  const jp = jobPaths(root, state.id);
  const slices = action.mode === 'slices' || state.epic;
  const rounds = Math.max(1, state.policy.limits.max_plan_validate_rounds - state.counters.decompose_rounds);
  const jc = `${jobContext(root, state, ['H3', 'EH3'])}\n- Findings: ${jp.findings}\n- Design record: ${invalidation.designFiles(root, state.id).join(', ') || '(none)'} (templated docs: the ADR's "Decision", "Architecture diagram", "How each acceptance criterion is met" and "Rollback and migration" sections are what tasks implement)`;
  const ls = lessons.inScope(root, []);
  const what = slices
    ? `Write ${jp.slices}: {"slices":[{"id":"S00","goal":"…","criteria_ids":["E-AC-1"],"depends_on":[],"work_type":"feature","risk":"${state.risk}","allowed_paths":["…"]}], "epic_verify_commands":["…"]}. S00 freezes the contracts and adds the feature flag; later slices are vertical and safe to stop after. Every E-AC must be owned by a slice.`
    : `Write ${jp.plan}: {"tasks":[{"id":"T1","objective":"…","allowed_paths":["src/x/**"],"depends_on":[],"criteria_ids":["AC-1"],"verify_commands":[{"cmd":"…","covers":["AC-1"]}],"retry_limit":3,"rollback":"…"}]}. Tasks that can run in parallel must not share allowed paths.`;
  const planner = {
    ...agentSpec(state, slices ? 'slicer' : 'planner'),
    prompt: prompt(
      slices ? 'slicer' : 'planner',
      `${jc}\n- ${what}\n- Then run \`${cli(root)} plan validate --job ${state.id}\` and fix every error before returning. Return valid=true only if that command says valid.\n- Accepted lessons each relevant task must carry:\n${ls.map((l) => `  - ${l.id} (${l.scope.join(', ')}): ${l.text}`).join('\n') || '  - (none)'}`,
      'planner',
    ),
    schema: schema('planner'),
    max_rounds: rounds,
  };
  const critique = action.plan_critique
    ? { ...agentSpec(state, 'god-eye'), prompt: prompt('god-eye', `${jc}\n- Focus: **plan**. Read ${jp.plan} cold. Approve only if the tasks cover every criterion, are independently buildable, and their verify commands would really prove them.`, 'critique'), schema: schema('critique'), max_rounds: 2 }
    : null;
  return base(root, state, 'decompose', { mode: slices ? 'slices' : 'plan', input_hash: inputHash({ contract: ctx.b.contract, design: ctx.b.design }), planner, critique });
}

// ---------------------------------------------------------------- realize
function realize(root, state, ctx, action) {
  const plan = readJson(jobPaths(root, state.id).plan, null);
  if (!plan) fail(`${state.id} has no plan to build`, 'no_plan');
  const pending = plan.tasks.filter((t) => !steps.taskDone(ctx, t.id));
  const pendingIds = new Set(pending.map((t) => t.id));
  const waves = (plan.waves || [plan.tasks.map((t) => t.id)]).map((w) => w.filter((id) => pendingIds.has(id))).filter((w) => w.length);
  const jc = jobContext(root, state);
  const tasks = {};
  for (const t of pending) {
    const wt = taskWorktree(root, state.id, t.id);
    const fixNote = state.fix && (state.fix.tasks || []).includes(t.id)
      ? state.fix.kind === 'fix'
        ? '- This is a FIX round for confirmed review findings (they are in `task show` under fix_findings). Fix the class of bug, not just the instance; list every place you swept in "swept".'
        : '- This is a VERIFY-FIX round: commands failed on the integrated build (see verify_failures in `task show`). Fix the cause; list swept places.'
      : t.id && state.tasks[t.id] && state.tasks[t.id].needs_work === 'amendment'
        ? '- The contract or plan was amended; rebuild this task against the amended version.'
        : '';
    tasks[t.id] = {
      id: t.id,
      depends_on: t.depends_on || [],
      retry_limit: t.retry_limit || state.policy.limits.retry_limit,
      // Builders may move to a stronger model on retries (policy.agents.builder_escalation).
      builder: { ...agentSpec(state, 'builder'), escalate: ((state.policy.agents || {}).builder_escalation || []).slice() },
      tester: agentSpec(state, 'tester'),
      builder_prompt: prompt(
        'builder',
        `${jc}\n- Task: **${t.id}** — ${t.objective}\n- 1. Run \`${cli(root)} task start ${t.id} --job ${state.id}\` (creates or reuses your worktree at ${wt} and merges your dependencies).\n- 2. Run \`${cli(root)} task show ${t.id} --job ${state.id}\` for your full contract, lessons, and any findings or failures to fix.\n- 3. Work only inside ${wt}, only on: ${t.allowed_paths.join(', ')}.\n- 4. Commit on the task branch (git -C "${wt}" commit). Never push, never touch other branches.\n${fixNote}\n- If you need paths outside your allowed paths, stop and return status "blocked" with needs_paths.`,
        'builder',
        'Attempt {{attempt}}. Previous tester failures, if any:\n{{failures}}',
      ),
      tester_prompt: prompt(
        'tester',
        `${jc}\n- Task: **${t.id}** — ${t.objective}\n- Run \`${cli(root)} task verify ${t.id} --job ${state.id}\`. It runs the verify commands in ${wt} and records evidence; its output is the truth. Do not edit any files.\n- Also check the places the builder says it swept (listed below).\n- Return pass exactly as the command reported it, with its evidence_id, and the failures in your own words.`,
        'tester',
        'Places the builder says it swept: {{swept}}',
      ),
    };
  }
  return base(root, state, 'realize', {
    scope: action.scope || 'all',
    input_hash: inputHash({ plan: ctx.b.plan, scope: action.scope || 'all', pending: [...pendingIds].sort() }),
    waves,
    tasks,
    max_parallel_tasks: state.policy.limits.max_parallel_tasks,
    builder_schema: schema('builder'),
    tester_schema: schema('tester'),
  });
}

// ---------------------------------------------------------------- reconcile
function reconcile(root, state, ctx) {
  const jc = jobContext(root, state);
  return base(root, state, 'reconcile', {
    input_hash: inputHash({ plan: ctx.b.plan }),
    integrator: {
      ...agentSpec(state, 'integrator'),
      prompt: prompt(
        'integrator',
        `${jc}\n- Run \`${cli(root)} reconcile run --job ${state.id}\`.\n- If it reports textual_conflict: resolve the markers in the listed files inside ${jobPaths(root, state.id).worktree}, keep both tasks' intent, git add them, then run \`${cli(root)} reconcile continue --job ${state.id}\`. Repeat until merged.\n- If the conflict is behavioural (the tasks' logic disagrees, not just their text), run \`${cli(root)} reconcile abort --job ${state.id}\` and return behavioural_conflict.`,
        'integrator',
      ),
      schema: schema('integrator'),
    },
  });
}

function build(root, { jobId, workflow, config, mode, scope, lanes, threatModel, planCritique, acceptDegraded, inline = false }) {
  const state = job.resolve(root, jobId);
  RUN = inline ? null : { n: 0, dir: path.join(root, '.factory', 'scratch', 'briefs', state.id, `${workflow}${config ? `-${config}` : ''}-${Date.now()}`) };
  const ctx = steps.context(root, state, job.load);
  const action = { mode, scope, lanes: lanes ? String(lanes).split(',') : null, threat_model: threatModel, plan_critique: planCritique };
  if (!lanes || !action.lanes) {
    const s = ctx.recipe.steps.find((x) => (config === 'challenge' ? x.config === 'challenge' && (x.mode || null) === (mode || null) : false));
    if (s) action.lanes = s.lanes;
  }
  if (config === 'decide' && threatModel === undefined) {
    const s = ctx.recipe.steps.find((x) => x.step === 'decide');
    if (s) action.threat_model = s.threat_model === 'policy' ? state.risk === 'high' : Boolean(s.threat_model);
    if (s && !mode) action.mode = s.mode;
  }
  if (workflow === 'decompose' && planCritique === undefined) {
    const s = ctx.recipe.steps.find((x) => x.step === 'decompose');
    action.plan_critique = Boolean(s && s.plan_critique);
    if (s && !mode) action.mode = s.mode;
  }
  if (workflow === 'ground' && !mode) {
    const s = ctx.recipe.steps.find((x) => x.step === 'ground');
    if (s) action.mode = s.mode;
  }
  switch (workflow) {
    case 'fanout-judge':
      if (config === 'clarify') return clarify(root, state, ctx, acceptDegraded);
      if (config === 'decide') return decide(root, state, ctx, action);
      if (config === 'challenge') return challenge(root, state, ctx, action);
      return fail('fanout-judge needs --config clarify|decide|challenge', 'bad_input');
    case 'ground':
      return ground(root, state, ctx, action);
    case 'decompose':
      return decompose(root, state, ctx, action);
    case 'realize':
      return realize(root, state, ctx, action);
    case 'reconcile':
      return reconcile(root, state, ctx);
    default:
      return fail(`Unknown workflow ${workflow}`, 'bad_input');
  }
}

// Recompute the input hash a brief would have now (used by record to catch stale results).
function currentInputHash(root, state, envelope) {
  const ctx = steps.context(root, state, job.load);
  const answers = readJson(jobPaths(root, state.id).answers, []);
  switch (envelope.workflow) {
    case 'fanout-judge':
      if (envelope.config === 'clarify') return inputHash({ contract: ctx.b.contract, round: state.counters.clarify_rounds + 1 });
      if (envelope.config === 'decide') return inputHash({ contract: ctx.b.contract, findings: ctx.b.findings });
      return inputHash({ fingerprint: ctx.b.fingerprint, children: ctx.b.children, mode: envelope.mode || null });
    case 'ground':
      return inputHash({ contract: ctx.b.contract, answers: answers.length });
    case 'decompose':
      return inputHash({ contract: ctx.b.contract, design: ctx.b.design });
    default:
      return null; // realize and reconcile change the build themselves; the CLI re-checks evidence instead
  }
}

module.exports = { build, currentInputHash, prompt, roleBody, cli, agentSpec };
