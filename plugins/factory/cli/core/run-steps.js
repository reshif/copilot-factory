// ===================================================================== workflow runs, step by step
// One file, read by two sides: the CLI (`factory console`, require()) and the page itself
// (console/build.js puts it into console.html, before the Blueprint), so the step list the page
// shows while replaying is folded by the same code, from the same templates, as the data.
//
// A run is one `factory run <workflow>` (or `factory distill write`). The runner logs:
//   workflow_start  { wf_run, job, decision_id, workflow, config, mode, round }
//   workflow_phase  { wf_run, job, decision_id, workflow, config, text, index }   each phase(...) call
//   workflow_end    { wf_run, job, decision_id, workflow, config, outcome: ok|failed, status, ms, error }
//   agent_start / agent_run carry { wf_run, step } (step = the phase index in force when agent() was called)
// fromEvents() turns those lines into runs; view(run, t) is the step list as it stood at time t.
//
// TEMPLATES: the steps each workflow config can take, in the order its source runs them
// (plugins/factory/workflows/*.js). `match` is tested against the phase text; a step the run
// passes without its phase is "skipped", one it has not reached yet "pending". Keep them honest
// to the workflow code: a phase text that no template step matches is still shown, as it ran.
var RUN_STEPS = (function () {
  var TEMPLATES = {
    // clarify.js (v3): one stage per run: the read-back, a research pass (researchers, then the
    // brief writer), reading a sheet reply or a redirect, the contract writer, the readiness check
    clarify: {
      next: 'the next clarify stage, your reply, or H1',
      steps: [
        { key: 'readback', label: 'read your words back', match: /^clarify: read your words back/, roles: ['interviewer'], optional: true, only_when_run: true },
        { key: 'research', label: 'research (pinned versions)', match: /^clarify: research \(/, roles: ['researcher'], optional: true, only_when_run: true },
        { key: 'brief', label: 'research brief', match: /^clarify: research brief/, roles: ['brief-writer'], optional: true, only_when_run: true },
        { key: 'interpret', label: 'read your sheet answer', match: /^clarify: read your sheet answer/, roles: ['interviewer'], optional: true, only_when_run: true },
        { key: 'redirect', label: 'read your redirect back', match: /^clarify: read your redirect back/, roles: ['interviewer'], optional: true, only_when_run: true },
        { key: 'write', label: 'write the contract', match: /^clarify: write the contract/, roles: ['contract-writer'], optional: true, only_when_run: true },
        { key: 'check', label: 'readiness check', match: /^clarify: readiness check/, roles: ['god-eye'], optional: true, only_when_run: true },
        // 0.9.0: the readiness loop's tie-break on a disputed objection, and its diagnosis
        { key: 'dispute', label: 'check disputed objections', match: /^clarify: check disputed objections/, roles: ['finding-verifier'], optional: true, only_when_run: true },
        { key: 'diagnose', label: 'diagnose the readiness loop', match: /^clarify: diagnose the readiness loop/, roles: ['god-eye'], optional: true, only_when_run: true },
      ],
    },
    // fanout-judge.js, decide: options (and the threat model) → architect → critic rounds (God Eye,
    // and the API-conformance critic against the dependency source), a verifier per serious item,
    // the architect revising after each round (0.10.0). A deny that names a defect starts at the
    // revise (no options).
    'fanout-judge:decide': {
      next: 'the design gate (H2, or the combined design + plan gate)',
      steps: [
        { key: 'fanout', label: 'options', match: /^decide: fan-out/, roles: ['option-generator', 'threat-modeler'] },
        { key: 'architect', label: 'architect decides', match: /^decide: architect$/, roles: ['architect'] },
        { key: 'god-eye', label: 'design critics', match: /^decide: (God Eye|critics)/, roles: ['god-eye', 'api-conformance'] },
        { key: 'verify', label: 'verify serious items', match: /^decide: verify/, roles: ['finding-verifier'], optional: true },
        { key: 'revise', label: 'architect revises', match: /^decide: architect revises/, roles: ['architect'], optional: true },
        { key: 'diagnosis', label: 'diagnosis (loop engine)', match: /^decide: diagnosis/, roles: ['god-eye'], optional: true, only_when_run: true },
      ],
    },
    // fanout-judge.js, challenge: one reviewer per lane → a verifier per serious finding
    'fanout-judge:challenge': {
      next: 'the verdict per lane',
      steps: [
        { key: 'fanout', label: 'review lanes', match: /^challenge: fan-out/, roles: ['code-reviewer', 'test-reviewer', 'security-reviewer', 'ux-reviewer', 'epic-reviewer'] },
        { key: 'verify', label: 'verify findings', match: /^challenge: verify/, roles: ['finding-verifier'] },
      ],
    },
    // fanout-judge.js, diagnose (0.9.0): God Eye diagnoses a review-fix or verify-fix loop that stopped making progress
    'fanout-judge:diagnose': {
      next: 'a different approach, or one question for you',
      steps: [{ key: 'diagnose', label: 'diagnose the loop', match: /^diagnose: God Eye/, roles: ['god-eye'] }],
    },
    // ground.js: the probes in parallel
    ground: { next: 'decide', steps: [{ key: 'probes', label: 'research probes', match: /^ground:/, roles: ['researcher'] }] },
    // decompose.js: planner rounds until valid → the plan probe (the CLI dry-runs every verify
    // command in the proposed environment; the planner fixes what cannot run) → God Eye (plan)
    // rounds with the probe's output, the planner revising between them
    decompose: {
      next: 'plan validate, then H3',
      steps: [
        { key: 'planner', label: 'planner', match: /^decompose: (?!God Eye|plan probe)/, roles: ['planner', 'slicer'] },
        { key: 'probe', label: 'plan probe', match: /^decompose: plan probe/, roles: ['planner'], optional: true },
        { key: 'god-eye', label: 'God Eye (plan)', match: /^decompose: God Eye/, roles: ['god-eye', 'planner'], optional: true },
      ],
    },
    // realize.js (0.8): by dependency — each task's build as it starts, each integration of the
    // done tasks as it runs. Logs from before it ran wave by wave (a wave whose tasks were all
    // skipped has no phase). Only the steps a run took are shown.
    realize: {
      next: 'reconcile',
      steps: [
        { key: 'wave', label: 'wave', match: /^realize: wave/, roles: ['builder', 'tester'], series: /wave (\d+)\/(\d+)/, optional: true, only_when_run: true },
        { key: 'schedule', label: 'build by dependency', match: /^realize: \d+ task/, roles: ['builder'], optional: true, only_when_run: true },
        { key: 'build', label: 'build', match: /^realize: build /, roles: ['builder'], optional: true, only_when_run: true },
        { key: 'integrate', label: 'integrate', match: /^realize: (integrating|rebuilding)/, roles: ['builder'], optional: true, only_when_run: true },
      ],
    },
    // reconcile.js: the integrator
    reconcile: { next: 'prove', steps: [{ key: 'integrate', label: 'integrate task branches', match: /^reconcile:/, roles: ['integrator'] }] },
    // runner.js distillWrite: the lesson-writer
    distill: { next: 'distill done, then close', steps: [{ key: 'write', label: 'write lessons', match: /^distill:/, roles: ['lesson-writer'] }] },
  };
  var BAD = { fail: 1, no_result: 1, blocked: 1, failed: 1, exhausted: 1, error: 1, timeout: 1, invalid: 1, copilot_unavailable: 1 };
  var ms = function (s) { var v = Date.parse(s); return isNaN(v) ? null : v; };

  function templateKey(workflow, config) {
    if (TEMPLATES[workflow + ':' + config]) return workflow + ':' + config;
    return TEMPLATES[workflow] ? workflow : null;
  }
  function templateOf(run) { var k = run && (run.template || templateKey(run.workflow, run.config)); return k ? TEMPLATES[k] : null; }
  function matchStep(tpl, text) {
    if (!tpl) return -1;
    for (var i = 0; i < tpl.steps.length; i++) if (tpl.steps[i].match.test(String(text || ''))) return i;
    return -1;
  }
  // the phase text in plain words: "decide: fan-out (3)" → "fan-out (3)"; "N thing(s)" → "N things"
  function cleanText(text) {
    return String(text || '').replace(/^[a-z-]+: /, '').replace(/^scout · /, '').replace(/ with \d+ scout\(s\)/, '')
      .replace(/(\d+) ([A-Za-z-]+)\(s\)/g, function (_, n, w) { return n + ' ' + w + (n === '1' ? '' : 's'); })
      .replace(/\(s\)/g, 's')
      .replace(/^wave (\d+)\/(\d+) \((.+)\)$/, 'wave $1 of $2: $3');
  }

  // ------------------------------------------------------------ the log → runs (CLI side)
  // events: the job's lines in log order. Lines from before workflow_* existed make no run: the
  // console then shows the agents as it always did. opts.alive(): is this job's run lock live.
  function fromEvents(events, opts) {
    opts = opts || {};
    var runs = [], by = {}, open = {};
    var stepOf = opts.stepOfDecision || {};
    (events || []).forEach(function (e) {
      if (!e || !e.event) return;
      if (e.event === 'workflow_start' && e.wf_run) {
        var r = {
          id: e.wf_run, workflow: e.workflow || null, config: e.config || null, mode: e.mode || null, template: templateKey(e.workflow, e.config),
          decision_id: e.decision_id || null, step: stepOf[e.decision_id] || null, round: typeof e.round === 'number' ? e.round : null, visit: 1,
          started_at: e.ts, ended_at: null, status: 'running', result: null, error: null, pid: e.pid || null, phases: [], agents: [],
        };
        r.visit = runs.filter(function (x) { return x.workflow === r.workflow && x.config === r.config && x.mode === r.mode; }).length + 1;
        runs.push(r); by[r.id] = r;
        return;
      }
      var run = e.wf_run ? by[e.wf_run] : null;
      if (!run) return;
      if (e.event === 'workflow_phase') {
        var tpl = templateOf(run), k = matchStep(tpl, e.text);
        run.phases.push({ i: typeof e.index === 'number' ? e.index : run.phases.length, text: String(e.text || ''), at: e.ts, key: k >= 0 ? tpl.steps[k].key : null });
      } else if (e.event === 'agent_start' && e.run_id) {
        var a = { role: String(e.role || String(e.agent_type || '').replace(/^factory:/, '')), label: String(e.label || ''), step: typeof e.step === 'number' ? e.step : null, at: e.ts, end: null, outcome: null, retry: /\(retry\)$/.test(String(e.label || '')) };
        if (a.step === null) a.step = run.phases.length ? run.phases[run.phases.length - 1].i : -1;   // by time: the step in force when it started
        run.agents.push(a); open[e.run_id] = a;
      } else if (e.event === 'agent_run') {
        var b = e.run_id ? open[e.run_id] : null;
        if (!b) {   // never started (no worktree, its time budget spent while queued): a run that ended at once
          b = { role: String(e.role || String(e.agent_type || '').replace(/^factory:/, '')), label: String(e.label || ''), step: typeof e.step === 'number' ? e.step : run.phases.length ? run.phases[run.phases.length - 1].i : -1, at: e.ts, end: null, outcome: null, retry: /\(retry\)$/.test(String(e.label || '')) };
          run.agents.push(b);
        }
        b.end = e.ts; b.outcome = String(e.outcome || 'ok');
        if (e.run_id) delete open[e.run_id];
      } else if (e.event === 'workflow_end') {
        run.ended_at = e.ts; run.status = e.outcome === 'ok' ? 'done' : 'failed'; run.result = e.status || null; run.error = e.error ? String(e.error).slice(0, 200) : null;
      }
    });
    // a run with no end: still running while its `factory run` holds the lock, else it was cut off
    runs.forEach(function (r) {
      if (r.status !== 'running') return;
      if (opts.alive && opts.alive(r)) return;
      var last = r.started_at;
      r.phases.forEach(function (p) { if (p.at > last) last = p.at; });
      r.agents.forEach(function (a) { if (a.at > last) last = a.at; if (a.end && a.end > last) last = a.end; });
      r.ended_at = last; r.status = 'failed'; r.error = 'interrupted: the run stopped without finishing';
    });
    return runs;
  }

  // ------------------------------------------------------------ one run at time t (both sides)
  // Steps in order: the phases that had started by t, plus the template steps the run did not
  // take (skipped once a later step started, or the run ended) or has yet to take (pending).
  function view(run, t) {
    if (!run) return null;
    var t0 = ms(run.started_at);
    if (t === undefined || t === null) t = Infinity;
    if (t0 !== null && t < t0) return null;
    var end = ms(run.ended_at), ended = end !== null && end <= t;
    var tpl = templateOf(run), keys = tpl ? tpl.steps.map(function (s) { return s.key; }) : [];
    var phases = (run.phases || []).filter(function (p) { var a = ms(p.at); return a === null || a <= t; });
    var agents = (run.agents || []).filter(function (a) { var x = ms(a.at); return x === null || x <= t; });
    var steps = [];
    // agents that started before any phase (none in today's workflows): their own first step
    if (agents.some(function (a) { return a.step === -1 || a.step === null; })) steps.push({ i: -1, key: null, label: 'starting', text: 'starting', started_at: run.started_at, ended_at: phases.length ? phases[0].at : null });
    phases.forEach(function (p, n) {
      var tk = p.key ? keys.indexOf(p.key) : -1;
      steps.push({ i: p.i, key: p.key, tk: tk, label: cleanText(p.text), text: p.text, started_at: p.at, ended_at: phases[n + 1] ? phases[n + 1].at : ended ? run.ended_at : null });
    });
    // a step is done once the next one started; the last one ends with the run (failed with it), or is at work
    var current = null;
    steps.forEach(function (s, n) {
      s.state = n < steps.length - 1 ? 'done' : ended ? (run.status === 'failed' ? 'failed' : 'done') : 'running';
      if (s.state === 'running') current = s;
    });
    // the template steps the run has not taken: each goes before the first step that comes later in the template
    if (tpl) {
      var hit = {};
      phases.forEach(function (p) { if (p.key) hit[p.key] = 1; });
      tpl.steps.forEach(function (ts, k) {
        if (hit[ts.key]) return;
        var at = steps.length;
        for (var q = 0; q < steps.length; q++) if (steps[q].tk > k) { at = q; break; }
        var later = at < steps.length;
        var state = later || ended ? 'skipped' : 'pending';
        if (ts.optional && (state === 'skipped' || ts.only_when_run)) return;   // an optional step that did not run is not news
        steps.splice(at, 0, { i: null, key: ts.key, tk: k, label: ts.label, text: null, started_at: null, ended_at: null, state: state, roles_planned: ts.roles.slice() });
      });
      // a series (realize's waves): the numbers it jumped are skipped, the ones still ahead pending
      tpl.steps.forEach(function (ts) {
        if (!ts.series) return;
        var mine = steps.filter(function (s) { return s.key === ts.key && s.text; }), last = null;
        mine.forEach(function (s) {
          var m = ts.series.exec(s.text); if (!m) return;
          var n = +m[1], N = +m[2];
          if (last !== null) for (var k = last + 1; k < n; k++) steps.splice(steps.indexOf(s), 0, { i: null, key: ts.key, label: ts.label + ' ' + k + ' of ' + N, text: null, started_at: null, ended_at: null, state: 'skipped', roles_planned: ts.roles.slice() });
          last = n; s.series_of = N;
        });
        var tail = mine[mine.length - 1];
        if (tail && last !== null && tail.series_of > last) {
          var pos = steps.indexOf(tail) + 1;
          for (var k2 = tail.series_of; k2 > last; k2--) steps.splice(pos, 0, { i: null, key: ts.key, label: ts.label + ' ' + k2 + ' of ' + tail.series_of, text: null, started_at: null, ended_at: null, state: ended ? 'skipped' : 'pending', roles_planned: ts.roles.slice() });
        }
      });
    }
    // who ran in each step, per role: total, at work, came back ok, failed, retries
    steps.forEach(function (s) {
      var order = (s.roles_planned || (tpl && s.tk >= 0 && tpl.steps[s.tk] ? tpl.steps[s.tk].roles : [])).slice(), by = {};
      agents.forEach(function (a) {
        var mine = s.i === -1 ? (a.step === -1 || a.step === null) : s.i !== null && a.step === s.i;
        if (!mine) return;
        var r = by[a.role] = by[a.role] || { role: a.role, total: 0, running: 0, ok: 0, failed: 0, retries: 0 };
        var e = ms(a.end), done = a.end && (e === null || e <= t);
        r.total += 1;
        if (a.retry) r.retries += 1;
        if (!done) r.running += 1; else if (BAD[a.outcome]) r.failed += 1; else r.ok += 1;
      });
      Object.keys(by).forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
      s.roles = order.filter(function (k) { return by[k]; }).map(function (k) { return by[k]; });
      if (!s.roles.length && s.state !== 'done' && s.state !== 'running' && s.state !== 'failed') s.planned = (s.roles_planned || []).slice(0, 2);
      delete s.roles_planned; delete s.tk;
    });
    var counted = steps.filter(function (s) { return s.state !== 'skipped'; });
    return {
      id: run.id, workflow: run.workflow, config: run.config, mode: run.mode, step: run.step, round: run.round, visit: run.visit,
      started_at: run.started_at, ended_at: ended ? run.ended_at : null,
      status: ended ? run.status : 'running', result: ended ? run.result : null, error: ended ? run.error : null,
      steps: steps, at: current ? counted.indexOf(current) + 1 : null, of: counted.length,
      next: tpl ? tpl.next : null,
    };
  }

  return { TEMPLATES: TEMPLATES, BAD: BAD, templateKey: templateKey, matchStep: matchStep, cleanText: cleanText, fromEvents: fromEvents, view: view };
})();
if (typeof module === 'object' && module && module.exports) module.exports = RUN_STEPS;
