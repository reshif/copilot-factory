'use strict';
// Plans (job: plan.json of task contracts) and slices (epic: slices.json).
// Validation is deterministic; waves are computed, never hand-written.

const { readJson, writeJson, stableStringify, fail } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const { validate: validateSchema } = require('../lib/schema');
const { globsOverlap, matchesAny } = require('../lib/glob');
const contractMod = require('./contract');
const job = require('./job');
const ledger = require('./ledger');

const TASK_SCHEMA = {
  type: 'object',
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'objective', 'allowed_paths', 'criteria_ids', 'verify_commands'],
        properties: {
          id: { type: 'string', pattern: '^T\\d+$' },
          objective: { type: 'string', minLength: 3 },
          allowed_paths: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          depends_on: { type: 'array', items: { type: 'string' } },
          criteria_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
          verify_commands: { type: 'array', minItems: 1, items: { type: ['string', 'object'] } },
          retry_limit: { type: 'integer', minimum: 1, maximum: 10 },
          rollback: { type: 'string' },
          notes: { type: 'string' },
          // the interfaces (by name) this task calls or imports from another task's work
          consumes: { type: 'array', items: { type: 'string', minLength: 1 } },
          // greenfield (0.10.0): the task that creates the manifests the build environment's
          // setup needs; every other task depends on it, and realize prepares its worktree bare
          bootstrap: { type: 'boolean' },
        },
      },
    },
    // What tasks build for each other: a function, class, module, CLI command, schema, endpoint,
    // config key… named once, with the file it lives in and the task that owns (produces) it.
    interfaces: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'file', 'owner'],
        properties: {
          name: { type: 'string', minLength: 1 },
          kind: { type: 'string' },
          file: { type: 'string', minLength: 1 },
          owner: { type: 'string', pattern: '^T\\d+$' },
          signature: { type: 'string' },
        },
      },
    },
    waves: { type: 'array' },
  },
};

// A consumer depends on the owner of every interface it consumes: it must start from the
// owner's change. { T3: [{ on: 'T1', via: 'toCsv(items)' }] }.
function impliedDeps(tasks, interfaces) {
  const owner = Object.fromEntries((interfaces || []).filter((i) => i && i.name).map((i) => [i.name, i.owner]));
  const ids = new Set(tasks.map((t) => t.id));
  const out = {};
  for (const t of tasks) {
    for (const name of t.consumes || []) {
      const on = owner[name];
      if (!on || on === t.id || !ids.has(on) || (t.depends_on || []).includes(on)) continue;
      (out[t.id] = out[t.id] || []).push({ on, via: name });
    }
  }
  return out;
}

// The tasks with depends_on widened by the interfaces they consume.
function withInterfaceDeps(tasks, interfaces) {
  if (!interfaces || !interfaces.length) return tasks;
  const imp = impliedDeps(tasks, interfaces);
  return tasks.map((t) => (imp[t.id] ? { ...t, depends_on: [...new Set([...(t.depends_on || []), ...imp[t.id].map((x) => x.on)])] } : t));
}

const SLICE_SCHEMA = {
  type: 'object',
  required: ['slices'],
  properties: {
    slices: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'goal', 'criteria_ids'],
        properties: {
          id: { type: 'string', pattern: '^S\\d+$' },
          goal: { type: 'string', minLength: 3 },
          criteria_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
          depends_on: { type: 'array', items: { type: 'string' } },
          work_type: { type: 'string' },
          risk: { enum: ['low', 'medium', 'high'] },
          allowed_paths: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    epic_verify_commands: { type: 'array', items: { type: 'string' } },
  },
};

function cmdOf(c) {
  return typeof c === 'string' ? c : c && c.cmd;
}

// Kahn layering over depends_on. Returns { layers, cycle }.
function layers(items) {
  const ids = items.map((t) => t.id);
  const deps = Object.fromEntries(items.map((t) => [t.id, (t.depends_on || []).filter((d) => ids.includes(d))]));
  const done = new Set();
  const out = [];
  while (done.size < ids.length) {
    const layer = ids.filter((id) => !done.has(id) && deps[id].every((d) => done.has(d)));
    if (!layer.length) return { layers: out, cycle: ids.filter((id) => !done.has(id)) };
    layer.forEach((id) => done.add(id));
    out.push(layer);
  }
  return { layers: out, cycle: null };
}

// Split each dependency layer so that no two tasks in a wave can touch the same files.
function waves(tasksIn, interfaces) {
  const tasks = withInterfaceDeps(tasksIn, interfaces);
  const { layers: ls, cycle } = layers(tasks);
  if (cycle) return { waves: null, cycle };
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
  const out = [];
  for (const layer of ls) {
    const pending = [...layer];
    while (pending.length) {
      const wave = [];
      for (const id of [...pending]) {
        if (wave.every((w) => !globsOverlap(byId[w].allowed_paths, byId[id].allowed_paths))) {
          wave.push(id);
          pending.splice(pending.indexOf(id), 1);
        }
      }
      out.push(wave);
    }
  }
  return { waves: out, cycle: null };
}

// A task's dependencies: its depends_on plus every task in an earlier wave whose allowed
// paths overlap its own. waves() only separates overlapping tasks; without the implicit
// dependency the later one would start from a base without the earlier one's change and
// reconcile would have to choose between them.
function effectiveDeps(tasksIn, id, interfaces) {
  const tasks = withInterfaceDeps(tasksIn, interfaces);
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
  const me = byId[id];
  if (!me) return [];
  const deps = new Set((me.depends_on || []).filter((d) => byId[d]));
  const w = waves(tasks).waves;
  if (w) {
    const mine = w.findIndex((x) => x.includes(id));
    for (let i = 0; i < mine; i++) {
      for (const other of w[i]) if (globsOverlap(byId[other].allowed_paths || [], me.allowed_paths || [])) deps.add(other);
    }
  }
  return [...deps];
}

// Every task in build order (waves flattened): what reconcile merges, in that order.
function buildOrder(tasks, interfaces) {
  const w = waves(tasks, interfaces).waves;
  return w ? w.flat() : tasks.map((t) => t.id);
}

function otherJobLocks(root, state) {
  const locks = [];
  for (const id of job.listJobIds(root)) {
    if (id === state.id) continue;
    let s;
    try {
      s = job.load(root, id);
    } catch {
      continue;
    }
    if (s.status !== 'active' || !s.approvals || !s.approvals.H3 || (s.pr && s.pr.merged)) continue;
    const p = readJson(jobPaths(root, id).plan, null);
    if (p && p.tasks) locks.push({ job: id, paths: p.tasks.flatMap((t) => t.allowed_paths || []) });
  }
  return locks;
}

function validatePlan(root, state, { write = true } = {}) {
  const jp = jobPaths(root, state.id);
  const plan = readJson(jp.plan, null);
  const errors = [];
  if (!plan) return { valid: false, errors: [`No plan.json at ${jp.plan}`] };
  errors.push(...validateSchema(TASK_SCHEMA, plan));
  if (errors.length) return { valid: false, errors };

  const parsed = contractMod.parse(contractMod.read(root, state.id));
  const acIds = parsed.acs.map((a) => a.id);
  const ids = plan.tasks.map((t) => t.id);
  if (new Set(ids).size !== ids.length) errors.push('Task ids must be unique');
  for (const t of plan.tasks) {
    for (const d of t.depends_on || []) if (!ids.includes(d)) errors.push(`${t.id} depends on unknown task ${d}`);
    for (const c of t.criteria_ids) if (!acIds.includes(c)) errors.push(`${t.id} cites ${c}, which is not in the contract`);
    for (const p of t.allowed_paths) {
      if (matchesAny(p.replace(/\*+$/, 'x'), state.policy.protected_paths) || matchesAny(p, state.policy.protected_paths)) {
        errors.push(`${t.id} allows protected path ${p}`);
      }
    }
    if (t.verify_commands.some((c) => !cmdOf(c))) errors.push(`${t.id} has an empty verify command`);
  }
  // Interfaces: named once, owned by a real task, living in a file that task may change; every
  // consumed interface has a producer (a consumer without one would find nothing to call).
  const ifaces = plan.interfaces || [];
  const names = ifaces.map((i) => i.name);
  for (const n of names.filter((n, i) => names.indexOf(n) !== i)) errors.push(`Interface "${n}" is declared twice`);
  for (const i of ifaces) {
    const owner = plan.tasks.find((t) => t.id === i.owner);
    if (!owner) errors.push(`Interface "${i.name}" is owned by unknown task ${i.owner}`);
    else if (!matchesAny(String(i.file).replace(/^\.\//, ''), owner.allowed_paths)) errors.push(`Interface "${i.name}" lives in ${i.file}, outside its owner ${i.owner}'s allowed paths`);
  }
  const boots = plan.tasks.filter((t) => t.bootstrap === true);
  if (boots.length > 1) errors.push(`Only one task may be the bootstrap task (${boots.map((t) => t.id).join(', ')} are)`);
  if (boots.length && (boots[0].depends_on || []).length) errors.push(`The bootstrap task ${boots[0].id} must come first: it depends on nothing`);
  for (const t of plan.tasks) {
    for (const c of t.consumes || []) if (!names.includes(c)) errors.push(`${t.id} consumes "${c}", but no task produces it: declare it in interfaces with its owner (or add the task that builds it)`);
  }
  const needsTask = parsed.acs.filter((a) => a.evidence.some((e) => ['test', 'run', 'diff'].includes(e)));
  for (const ac of needsTask) {
    if (!plan.tasks.some((t) => t.criteria_ids.includes(ac.id))) errors.push(`${ac.id} is not covered by any task`);
  }
  // 0.11 design depth: the plan is derived from the design's Project layout (adr@2 / no-adr@2):
  // every new, changed or deleted file has exactly one owner task, every task path covers one
  const layout = require('./design').jobLayout(root, state.id);
  if (layout) errors.push(...require('./design').planLayoutProblems(layout, plan.tasks, { root, base: state.base_commit || null }));
  if (state.risk === 'low' && plan.tasks.length > 6) errors.push(`${plan.tasks.length} tasks is too large for low risk; raise the risk via amendment or split into an epic`);
  for (const lock of otherJobLocks(root, state)) {
    const mine = plan.tasks.flatMap((t) => t.allowed_paths);
    if (globsOverlap(mine, lock.paths)) errors.push(`Paths overlap with active job ${lock.job}, which holds a plan lock`);
  }
  const w = waves(plan.tasks, ifaces);
  if (w.cycle) errors.push(`Dependency cycle among ${w.cycle.join(', ')}${ifaces.length ? ' (depends_on plus consumed interfaces)' : ''}`);
  if (errors.length) return { valid: false, errors };

  if (write && stableStringify(plan.waves || null) !== stableStringify(w.waves)) {
    plan.waves = w.waves;
    writeJson(jp.plan, plan);
  }
  // For the H3 view: who produces and who consumes what, and the dependencies that implies.
  const implied = impliedDeps(plan.tasks, ifaces);
  return {
    valid: true,
    errors: [],
    waves: w.waves,
    tasks: plan.tasks.length,
    interfaces: ifaces.map((i) => ({ name: i.name, kind: i.kind || null, file: i.file, owner: i.owner, consumers: plan.tasks.filter((t) => (t.consumes || []).includes(i.name)).map((t) => t.id) })),
    implied_dependencies: Object.entries(implied).flatMap(([task, xs]) => xs.map((x) => ({ task, on: x.on, via: x.via }))),
    // the design's Project layout with the task that owns each file (what H3 shows as a tree)
    ...(layout ? { layout: require('./design').ownership(layout, plan.tasks).filter((e) => !e.dir).map((e) => ({ path: e.path, status: e.status, owner: e.owners.join('+') || null, acs: e.acs })), layout_tree: require('./design').treeText(require('./design').ownership(layout, plan.tasks)) } : {}),
  };
}

function validateSlices(root, state) {
  const jp = jobPaths(root, state.id);
  const doc = readJson(jp.slices, null);
  const errors = [];
  if (!doc) return { valid: false, errors: [`No slices.json at ${jp.slices}`] };
  errors.push(...validateSchema(SLICE_SCHEMA, doc));
  if (errors.length) return { valid: false, errors };
  const parsed = contractMod.parse(contractMod.read(root, state.id));
  const acIds = parsed.acs.map((a) => a.id);
  const ids = doc.slices.map((s) => s.id);
  if (new Set(ids).size !== ids.length) errors.push('Slice ids must be unique');
  for (const s of doc.slices) {
    for (const d of s.depends_on || []) if (!ids.includes(d)) errors.push(`${s.id} depends on unknown slice ${d}`);
    for (const c of s.criteria_ids) if (!acIds.includes(c)) errors.push(`${s.id} cites ${c}, which is not in the epic contract`);
    if (s.risk && ['low', 'medium', 'high'].indexOf(s.risk) < ['low', 'medium', 'high'].indexOf(state.risk) && s.id === 'S00') {
      errors.push('S00 (contracts + flag) may not be lower risk than the epic');
    }
  }
  for (const ac of acIds) if (!doc.slices.some((s) => s.criteria_ids.includes(ac))) errors.push(`${ac} is not owned by any slice`);
  const l = layers(doc.slices);
  if (l.cycle) errors.push(`Dependency cycle among ${l.cycle.join(', ')}`);
  return errors.length ? { valid: false, errors } : { valid: true, errors: [], layers: l.layers, slices: doc.slices.length };
}

function validate(root, state) {
  return state.epic ? validateSlices(root, state) : validatePlan(root, state);
}

// bug@low: one task built straight from the contract.
function fromContract(root, state) {
  const parsed = contractMod.parse(contractMod.read(root, state.id));
  const probs = contractMod.problems(parsed, { requirePlanFields: true, requireIntent: false }); // H1 already passed
  if (probs.length) fail(`The contract can't produce a plan:\n- ${probs.join('\n- ')}`, 'contract_incomplete', probs);
  const plan = {
    source: 'contract',
    tasks: [
      {
        id: 'T1',
        objective: parsed.goal,
        allowed_paths: parsed.allowedPaths,
        depends_on: [],
        criteria_ids: parsed.acs.map((a) => a.id),
        verify_commands: parsed.verifyCommands.map((v) => ({ cmd: v.cmd, covers: v.covers.length ? v.covers : parsed.acs.map((a) => a.id) })),
      },
    ],
  };
  writeJson(jobPaths(root, state.id).plan, plan);
  const v = validatePlan(root, state);
  if (!v.valid) fail(`Plan from contract is invalid:\n- ${v.errors.join('\n- ')}`, 'plan_invalid', v.errors);
  const b = require('./invalidation').current(root, state);
  ledger.append(root, state.id, { kind: 'step', step: 'decompose', ok: true, bound: { plan: b.plan, contract: b.contract }, detail: { source: 'contract', tasks: 1 } });
  return { ok: true, plan: jobPaths(root, state.id).plan, waves: v.waves };
}

module.exports = { validate, validatePlan, validateSlices, waves, layers, effectiveDeps, buildOrder, impliedDeps, withInterfaceDeps, fromContract, cmdOf, TASK_SCHEMA, SLICE_SCHEMA };
