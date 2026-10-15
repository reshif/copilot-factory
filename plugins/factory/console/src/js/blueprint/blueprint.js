// blueprint.js: the "Blueprint" display. The factory drawn as an engineering drawing set: sheet 1 the line (stations,
// banks, return lines, side tracks, callouts, revision clouds, details A/B/C, the epic chain), sheet 2 a projection
// globe, 3 a matrix, 4 schedule & dimensions, 5 parts list (agents), 6 general notes (lessons and standards); a title
// block with the revision history (replay), section views per job, find and a snapshot mode.
// Data: the display document, made from the console's own data by blueprint/adapter.js (toDisplay) on every update.
// Ported from claude-software-factory's console (displays/blueprint.js) for Copilot Factory: the agent banks and steps
// are Copilot's, HS (ship sign-off) is a gate, replies come from the data, and the epic sheets are left out.
// The user's place survives every refresh.
(function () {
  var NS = "http://www.w3.org/2000/svg";
  var MIN = 60e3, HOUR = 36e5, DAY = 864e5;

  // ------------------------------------------------------------------ DOM builders (no markup strings anywhere)
  function setA(n, a) {
    if (!a) return;
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "text") { n.textContent = String(v); return; }
      if (k === "class") { n.setAttribute("class", cx(v)); return; }
      if (k === "style") { Object.keys(v).forEach(function (p) { n.style.setProperty(p, v[p]); }); return; }
      if (/^on/i.test(k)) throw new Error("blueprint: refused attribute " + k);
      n.setAttribute(k, v === true ? "" : String(v));
    });
  }
  // every class this display sets carries the bp- prefix, so no console-wide rule (.chip, .card, .find, .mode…) reaches in
  function cx(v) { return String(v).split(/\s+/).filter(Boolean).map(function (c) { return c.indexOf("bp-") === 0 ? c : "bp-" + c; }).join(" "); }
  function kids(n, list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c === null || c === undefined || c === false || c === "") continue;
      if (Array.isArray(c)) { kids(n, c); continue; }
      n.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
    }
    return n;
  }
  function H(tag, a) { var n = document.createElement(tag); setA(n, a); return kids(n, [].slice.call(arguments, 2)); }
  function Z(tag, a) { var n = document.createElementNS(NS, tag); setA(n, a); return kids(n, [].slice.call(arguments, 2)); }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function fill(n) { clear(n); return kids(n, [].slice.call(arguments, 1)); }

  // ------------------------------------------------------------------ fixed vocabulary
  // Q is not a recipe gate: clarify asked you questions and waits on your answers. It is your turn all the same (the Board's
  // "Your turn · Clarify"), so it counts, calls out and waits like a gate; it has no step ring on the track.
  var GATE = { awaiting_answers: "Q", awaiting_intent_approval: "H1", awaiting_design_approval: "H2", awaiting_findings_approval: "HF", awaiting_plan_approval: "H3", awaiting_ship_approval: "HS", awaiting_amendment_approval: "A", parked: "P" };
  var DONE_STATES = { closed: 1, findings_delivered: 1, cancelled: 1, abandoned: 1 };
  var STOPPED_STATES = { cancelled: 1, abandoned: 1 };   // finished, but not done: red and ■, as the Board's Stopped
  var TYPE_NAME = { feature: "feature", bug: "bug fix", hotfix: "hotfix", spike: "spike", refactor: "refactor", migration: "migration", upgrade: "upgrade", investigate: "investigation" };
  // under each station: the agents it can call on (a "bank" in the drawing), each a lamp that lights while it works.
  // Prove is a CLI step (factory verify run): no agent. Challenge's lamps are the lanes the jobs must pass and Ship's are
  // the post-merge reviewers, only when a recipe here runs that review: both are filled per render (bankMembers).
  var BANKS = {
    intake: { name: "No agents", members: [] },
    intent: { name: "Clarify agents", members: [["intent-mapper", "intent mapper"], ["researcher", "scouts · repo, web"], ["verifier", "evidence verifier"], ["intent-analyst", "analysts ×4"], ["judge", "judge"], ["contract-editor", "contract editor"], ["god-eye", "God Eye"]] },
    design: { name: "Design agents", members: [["researcher", "researcher"], ["option-generator", "option generator"], ["threat-modeler", "threat-modeler"], ["architect", "architect"], ["god-eye", "God Eye"]] },
    plan: { name: "Plan agents", members: [["planner", "planner"], ["god-eye", "God Eye"]] },
    build: { name: "Build agents", members: [["builder", "builder"], ["builder", "builder"], ["builder", "builder"], ["integrator", "integrator"]] },
    verify: { name: "CLI check", members: [] },
    review: { name: "Reviewers", members: [] },
    ship: { name: "CI and you", members: [] },
    done: { name: "Lessons", members: [["lesson-writer", "lesson writer"]] }
  };
  var STEPS = {
    intake: [["c", "factory job new"]], intent: [["a", "intent map · scouts · verifier"], ["a", "analysts ×4 + judge"], ["a", "God Eye cold review"], ["h", "H1"]],
    design: [["a", "ground: researchers"], ["a", "decide: options · architect"], ["h", "H2"], ["h", "HF"]], plan: [["a", "decompose: planner"], ["c", "plan validate"], ["h", "H3"]],
    build: [["a", "realize: builders per task"], ["c", "task verify per task"], ["a", "reconcile: integrator"]], verify: [["c", "prove: every check"]],
    review: [["a", "challenge: review lanes"], ["a", "finding verifier"]], ship: [["c", "ship: report · PR"], ["h", "HS"], ["h", "H4"]], done: [["a", "distill: lesson writer"], ["c", "close"]]
  };
  var LOOPS = { intent: "questions", design: "revise", plan: "revise" };   // "revise" is said in words: wd("revise")
  // the return rails: work sent back to Build, each on its own level above the row (up = px above the row's top)
  var RAILS = [{ from: "verify", name: "Checks failed: sent back", up: 38, land: 18 }, { from: "review", name: "Changes asked: sent back", up: 68, land: 0 }, { from: "ship", name: "CI failed: sent back", up: 98, land: -18 }];
  var NEXT = { received: "intake next", intent: "intent loop running", awaiting_answers: "clarify's next round, once you answer", designing: "design in progress", planning: "planner writing the plan", building: "builders at work", integrating: "combining the task branches", verifying: "re-running every check", reviewing: "reviewers at work", ready_to_ship: "pull request next", awaiting_ship_approval: "your ship sign-off", pr_open: "you merge: on GitHub, or locally and reply merged <commit>", merged: "the merge result is verified again", post_merge_review: "review after merge due", learning: "distill proposes lessons, then close checks every floor", closed: "closed", findings_delivered: "findings delivered", amending: "changing the contract and plan", needs_replan: "needs a new plan", cancelled: "cancelled", abandoned: "abandoned" };
  var STAGE_TONE = { intake: .10, intent: .18, design: .26, plan: .34, build: .48, verify: .56, review: .64, ship: .74, done: .10, change: .3, parked: .2, stopped: .1 };
  var VIEWS = ["line", "globe", "board", "sched", "agents", "learn"];
  var VIEW_NAME = { line: "The line", globe: "Projection", board: "Matrix", sched: "Schedule", agents: "Parts list", learn: "General notes", epics: "Epic register", eflow: "Epic assembly", ebreak: "Epic breakdown" };
  var VIEW_TAB = { line: "The line", globe: "Projection", board: "Matrix", sched: "Schedule", agents: "Parts list", learn: "General notes", epics: "Register", eflow: "Assembly", ebreak: "Breakdown" };
  // what each sheet shows, in plain words (the tab's tooltip and its accessible name)
  var VIEW_HINT = { line: "every job at its station: what waits on you, what is moving, what is done", globe: "a turning map of the repository, its jobs, files and agents",
    board: "jobs by station and by whose turn it is", sched: "each job over time, lead times and waits", agents: "every agent role and what it did",
    learn: "lessons the factory learned and the standards in force", epics: "every epic and who acts next", eflow: "one epic's own process, stage by stage",
    ebreak: "one epic's slices, what each proves, and their order onto the line" };
  var EPIC_VIEWS = { epics: 1, eflow: 1, ebreak: 1 };
  // epics: their own drawing series (sheets 7-9). An epic's process: seven stages, three human gates and an amendment gate.
  var EP_STAGES = [
    { key: "intent", label: "Intent", gate: "EH1", bank: "Intent agents", loop: "questions", members: [["intent-analyst", "analyst"], ["intent-analyst", "analyst"], ["intent-analyst", "analyst"], ["judge", "judge"], ["god-eye", "God Eye"]],
      steps: [["a", "analysts ×3 + judge"], ["a", "God Eye cold review"], ["c", "epic intent check"], ["h", "EH1"]] },
    { key: "architecture", label: "Architecture", gate: "EH2", bank: "Design agents", loop: "revise", members: [["researcher", "researcher"], ["threat-modeler", "threat model"], ["architect", "architect"], ["god-eye", "God Eye"]],
      steps: [["a", "researcher · threat model · architect"], ["a", "God Eye cold review"], ["c", "contracts check"], ["h", "EH2"]] },
    { key: "slicing", label: "Slicing", gate: "EH3", bank: "Slicer", loop: "revise", members: [["slicer", "slicer"], ["god-eye", "God Eye"]],
      steps: [["a", "slicer writes slices.json"], ["c", "slices validate"], ["h", "EH3"]] },
    { key: "delivery", label: "Delivery", bank: "On the line", members: [], steps: [["a", "each slice runs as a job on the line"]] },
    { key: "epic_gate", label: "Final checks", bank: "CLI check", members: [], steps: [["c", "every epic criterion proven"]] },
    { key: "review", label: "Final review", bank: "Epic reviewer", members: [["epic-reviewer", "epic reviewer"]], steps: [["a", "epic reviewer"]] },
    { key: "complete", label: "Done", bank: "Closed", members: [], steps: [["c", "flag ready to retire"]] }
  ];
  var EP_SIDES = [{ key: "changing", label: "Changing", sub: "changing the epic", gate: "EA" }, { key: "parked", label: "Parked", sub: "nothing proceeds", gate: "P" }, { key: "stopped", label: "Stopped", sub: "cancelled · abandoned" }];
  var EP_LABEL = { intent: "Intent", architecture: "Architecture", slicing: "Slicing", delivery: "Delivery", epic_gate: "Final checks", review: "Final review", complete: "Done", parked: "Parked", changing: "Changing", stopped: "Stopped" };
  var EP_STATE_STAGE = { epic_intent: "intent", awaiting_epic_intent_approval: "intent", epic_architecture: "architecture", awaiting_architecture_approval: "architecture",
    slicing: "slicing", awaiting_slices_approval: "slicing", in_delivery: "delivery", epic_gate: "epic_gate", epic_review: "review", complete: "complete",
    parked: "parked", amending: "changing", awaiting_epic_amendment_approval: "changing", cancelled: "stopped", abandoned: "stopped" };
  var EP_GATE_FROM = { EH1: "awaiting_epic_intent_approval", EH2: "awaiting_architecture_approval", EH3: "awaiting_slices_approval" };
  var ROUND_STAGE = { intent: "intent", architecture: "architecture", design: "architecture", slices: "slicing", slicing: "slicing", plan: "slicing" };
  function epStageOf(state) { return EP_STATE_STAGE[state] || (/gate/.test(state || "") ? "epic_gate" : /review/.test(state || "") ? "review" : null); }
  // drawing geometry (sheet 1): the stations sit in up to two rows, the line wraps from one to the next with a return
  // line, and every height is laid out from what is on the line (L, per render). Nothing is squeezed: the drawing grows
  // and the sheet scrolls inside its frame. MG = side margin (room for the inlet and the return line), SG = gap.
  var W = 1076, MIN_W = 1280, SG = 40, MG = 34, SY0 = 152, MK_GAP = 8;
  var ETAG_H = 17, SIDE_KEYS = ["change", "parked", "stopped"], SIDE_SUB = { change: "changing the contract and plan", parked: "nothing moves until you decide", stopped: "cancelled or abandoned" };

  // ------------------------------------------------------------------ small pure helpers
  var P = function (s) { var v = Date.parse(s); return isNaN(v) ? 0 : v; };
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var p2 = function (n) { return String(n).padStart(2, "0"); };
  function fT(ms) { var d = new Date(ms); return d.getUTCDate() + " " + MON[d.getUTCMonth()] + " " + p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()); }
  function fHM(ms) { var d = new Date(ms); return p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()); }
  function fD(ms) {
    ms = Math.max(0, ms); if (ms < MIN) return "<1 m"; var m = Math.round(ms / MIN); if (m < 60) return m + " m";
    var h = Math.floor(m / 60), mm = m % 60; if (h < 24) return mm ? h + " h " + mm + " m" : h + " h";
    var d = Math.floor(h / 24), hh = h % 24; return hh ? d + " d " + hh + " h" : d + " d";
  }
  var short = function (id) { return id ? String(id).replace(/^\d{8}-\d{6}-/, "") : ""; };
  var agentLabel = function (a) { return String(a || "").replace("factory:", "").replace(/-/g, " "); };
  var words = function (s) { return String(s || "").replace(/_/g, " "); };
  var cut = function (s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  var plural = function (n, w) { return n + " " + w + (n === 1 ? "" : "s"); };
  var cap = function (s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); };
  function arr(x) { return Array.isArray(x) ? x : []; }
  function uniq(a) { var seen = {}, out = []; a.forEach(function (x) { if (!seen[x]) { seen[x] = 1; out.push(x); } }); return out; }

  // the data, made safe to read: every list a list, every job with the fields the drawing uses
  function norm(d) {
    d = d || {};
    var gen = d.generated_at || new Date().toISOString();
    var jobs = arr(d.jobs).filter(function (j) { return j && j.id; }).map(function (j) {
      var hist = arr(j.history).filter(function (h) { return h && h.at && h.to; }).slice().sort(function (a, b) { return P(a.at) - P(b.at); });
      var g = j.gate ? Object.assign({}, j.gate, { problems: arr(j.gate.problems), warnings: arr(j.gate.warnings) }) : null;
      return Object.assign({}, j, {
        slug: j.slug || short(j.id), type: j.type || "feature", risk: j.risk || "low", state: j.state || (hist.length ? hist[hist.length - 1].to : "received"),
        created_at: j.created_at || (hist[0] && hist[0].at) || gen, updated_at: j.updated_at || j.created_at || gen,
        history: hist, gate: g,
        tasks: arr(j.tasks).filter(Boolean).map(function (t) {
          return Object.assign({}, t, { id: t.id || "T?", objective: t.objective || "", depends_on: arr(t.depends_on), criteria: arr(t.criteria),
            allowed_paths: arr(t.allowed_paths), verify_commands: arr(t.verify_commands), status: t.status || "todo", runs: t.runs || 0 });
        }),
        criteria: arr(j.criteria).filter(Boolean).map(function (c) { return Object.assign({}, c, { tasks: arr(c.tasks) }); }),
        reviews: arr(j.reviews).filter(Boolean).map(function (r) { return Object.assign({}, r, { lane: r.lane || "?", verdict: r.verdict || "?", findings: arr(r.findings), dismissed: r.dismissed || 0, at: r.at || gen }); }),
        required_lanes: arr(j.required_lanes), docs: arr(j.docs).filter(Boolean), evidence_count: j.evidence_count || 0
      });
    });
    var lessons = arr(d.lessons).filter(Boolean).map(function (l) {
      return Object.assign({}, l, { id: l.id || "L?", rule: l.rule || "", why: l.why || "", scope: arr(l.scope), lanes: arr(l.lanes), evidence: arr(l.evidence), created_at: l.created_at || gen });
    });
    var st = d.standards || {};
    var standards = { adopted: arr(st.adopted), checks: arr(st.checks),
      rules: arr(st.rules).map(function (r) { return Object.assign({}, r, { lanes: arr(r.lanes) }); }) };
    var epics = arr(d.epics).filter(function (e) { return e && (e.id || e.slug); }).map(function (e) {
      var hist = arr(e.history).filter(function (h) { return h && h.at && h.to; }).slice().sort(function (a, b) { return P(a.at) - P(b.at); });
      var state = e.state || (hist.length ? hist[hist.length - 1].to : "");
      var wo = e.waiting_on && typeof e.waiting_on === "object" ? e.waiting_on : {};
      var crit = arr(e.e_criteria).filter(Boolean).map(function (c, i) { return Object.assign({}, c, { id: c.id || "E-AC-" + (i + 1), text: c.text || "", status: c.status || "not_started", slices: arr(c.slices) }); });
      var slices = arr(e.slices).filter(Boolean).map(function (s, i) {
        return Object.assign({}, s, { slice: s.slice || "S" + p2(i), title: s.title || "", depends_on: arr(s.depends_on), waiting_on: arr(s.waiting_on), e_criteria: arr(s.e_criteria), next_to_start: !!s.next_to_start });
      });
      var dl = e.delivery && typeof e.delivery === "object" ? e.delivery : {};
      var num = function (v, f) { return typeof v === "number" && isFinite(v) ? v : f; };
      var rounds = {};
      if (e.rounds && typeof e.rounds === "object") Object.keys(e.rounds).forEach(function (k) {
        var r = e.rounds[k]; if (!r || typeof r !== "object") return;
        rounds[k] = { round: num(r.round, 0), max: num(r.max, 0), asked: num(r.asked, 0), deferred: num(r.deferred, 0), judge_skipped: !!r.judge_skipped,
          god_eye: r.god_eye && typeof r.god_eye === "object" ? { verdict: r.god_eye.verdict || null, round: num(r.god_eye.round, 0), blocking: num(r.god_eye.blocking, 0), important: num(r.god_eye.important, 0) } : null };
      });
      return Object.assign({}, e, { id: e.id || e.slug, slug: e.slug || String(e.id).replace(/^E?\d{8}-\d{6}-/, ""), state: state, stage: e.stage || epStageOf(state) || "intent",
        meaning: e.meaning || words(state), risk: e.risk || "low", flag: e.flag || null, mode: e.mode || "sequential",
        created_at: e.created_at || (hist[0] && hist[0].at) || gen, updated_at: e.updated_at || e.created_at || gen, history: hist,
        waiting_on: { who: wo.who || "nobody", gate: wo.gate || null, what: wo.what || "", reply: wo.reply || null, command: wo.command || null },
        rounds: rounds, critiques: arr(e.critiques).filter(Boolean), docs: arr(e.docs).filter(Boolean), e_criteria: crit, slices: slices,
        delivery: { e_criteria_delivered: num(dl.e_criteria_delivered, crit.filter(function (c) { return c.status === "delivered"; }).length), e_criteria_total: num(dl.e_criteria_total, crit.length),
          slices_merged: num(dl.slices_merged, 0), slices_total: num(dl.slices_total, slices.length) },
        contracts: arr(e.contracts).filter(Boolean).map(function (c) { return Object.assign({}, c, { path: c.path || "?", frozen: !!c.frozen, touched_by: arr(c.touched_by) }); }),
        amendment_requests: arr(e.amendment_requests).filter(Boolean),
        agents_at_work: arr(e.agents_at_work).filter(function (a) { return a && a.agent; }).map(function (a) { return Object.assign({}, a, { agent: String(a.agent).replace("factory:", "") }); }),
        activity_count: e.activity_count || 0 });
    });
    return { generated_at: gen, repo: d.repo || "", stages: arr(d.stages), side_lanes: arr(d.side_lanes), meaning: d.meaning || {},
      jobs: jobs, activity: arr(d.activity).filter(function (a) { return a && a.at; }), lessons: lessons, standards: standards, epics: epics,
      epic_jobs: arr(d.epic_jobs).filter(function (e) { return e && e.id; }) };
  }

  // ------------------------------------------------------------------ one mounted Blueprint
  function create(root, data, api) {
    var D, STAGES, SIDES, ALLST, S2STAGE, SIDX, JOBS, JBY, ACT, TN, T0, EVENTS, REPO;
    var T, live = true, playing = false, sel = null, view = "line", filter = "", boardMode = "jobs";
    var S, mk = {}, lastTargets = {}, raf = null, rafP = null, lastF = 0, pending = false, lastSig = "";
    var snapshotOn = false, heldData = null, docIdx = {}, keyOpen = false;
    var RM = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
    var C = {};
  // ------------------------------------------------------------------ plain words
  // The console's shared glossary (core/words.js, given to displays as api.words) when it exists; until then, and for
  // any word it lacks, this local copy with the same mapping. Internal ids (H1, AC-2, states) stay as small tags.
  var LOCAL_WORDS = {
    gate: { Q: "Answer clarify's questions", H1: "Approve the contract", H2: "Approve the design", H3: "Approve the plan", H4: "Merge", HF: "Approve the findings",
            HS: "Sign off the ship", A: "Approve a change to the criteria", P: "Parked: your call",
            EH1: "Approve the epic's goal", EH2: "Approve the epic's architecture", EH3: "Approve the slices", EA: "Approve a change to the epic" },
    lane: { code: "Code review", tests: "Test review", security: "Security review", ux: "Usability review", conformance: "Conformance review" },
    state: {
      received: "Just in", intent: "Writing the contract", awaiting_answers: "Waiting for you: questions", awaiting_intent_approval: "Waiting for you: contract", designing: "Designing",
      awaiting_design_approval: "Waiting for you: design", awaiting_findings_approval: "Waiting for you: findings", planning: "Planning",
      awaiting_plan_approval: "Waiting for you: plan", building: "Building", integrating: "Combining the work", verifying: "Checking",
      reviewing: "Reviewing", ready_to_ship: "Ready to ship", awaiting_ship_approval: "Waiting for you: ship", pr_open: "Waiting for you: merge", merged: "Merged",
      post_merge_review: "Reviewing after merge", learning: "Learning", closed: "Done", amending: "Changing the criteria",
      awaiting_amendment_approval: "Waiting for you: change", needs_replan: "Needs a new plan", findings_delivered: "Done: findings delivered",
      parked: "Parked", cancelled: "Cancelled", abandoned: "Abandoned",
      epic_intent: "Writing the epic's goal", awaiting_epic_intent_approval: "Waiting for you: epic goal", epic_architecture: "Designing the architecture",
      awaiting_architecture_approval: "Waiting for you: architecture", slicing: "Cutting slices", awaiting_slices_approval: "Waiting for you: slices",
      awaiting_slice_plan_approval: "Waiting for you: slices", in_delivery: "Delivering slices", epic_gate: "Final checks", epic_review: "Final review",
      complete: "Done"
    },
    godEye: "God Eye", godEyeSub: "independent reviewer", revise: "sent back"
  };
  function crit(id) {   // "AC-3" -> "Criterion 3", "E-AC-2" -> "Epic criterion 2"
    var s = String(id || ""), m = /^E-AC-(\d+)$/.exec(s);
    if (m) return "Epic criterion " + m[1];
    m = /^AC-(\d+)$/.exec(s);
    return m ? "Criterion " + m[1] : s;
  }
  // wd("gate", "H1") -> "Approve the contract"; wd("godEye") -> "God Eye"; wd("crit", "AC-2") -> "Criterion 2"
  function wd(kind, key) {
    var g = api.words ? api.words[kind] : undefined, v;
    if (key === undefined) v = typeof g === "function" ? g() : g;
    else v = typeof g === "function" ? g(key) : (g && typeof g === "object" ? g[key] : undefined);
    if (v !== undefined && v !== null && v !== "" && typeof v !== "object") return String(v);
    if (kind === "crit" || kind === "criterion") return crit(key);
    var l = LOCAL_WORDS[kind];
    if (key === undefined) return l;
    return (l && l[key]) || String(key || "").replace(/_/g, " ");
  }
    var gv = function (g) { return wd("gate", g); };   // "H1" -> "Approve the contract"
    // "E-AC-1","E-AC-3" -> "epic criteria 1, 3" (the ids stay in tooltips and tags)
    function critList(ids) {
      var n = ids.map(function (x) { var m = /(\d+)$/.exec(String(x)); return m ? m[1] : String(x); });
      var ep = ids.some(function (x) { return /^E-AC/.test(String(x)); });
      return (ep ? "epic " : "") + (n.length === 1 ? "criterion " : "criteria ") + n.join(", ");
    }
    var AP = null;   // Copilot's Autopilot, if the prompt hook saw it (last_at, count, recent): it could answer gates for the user
    var alive = function () { return root.isConnected; };
    var epSel = null, epDocIdx = {}, EPSIG = "";
    try { var sv = window.localStorage.getItem("dx-blueprint-view"); if (VIEWS.indexOf(sv) >= 0) view = sv; epSel = window.localStorage.getItem("dx-blueprint-epic") || null; } catch (e) { /* storage blocked: start on sheet 1 */ }

    function setData(d) {
      D = norm(d);
      AP = d && d.autopilot && typeof d.autopilot === "object" ? d.autopilot : null;
      STAGES = D.stages; SIDES = D.side_lanes; ALLST = STAGES.concat(SIDES);
      S2STAGE = {}; ALLST.forEach(function (s) { arr(s.states).forEach(function (x) { S2STAGE[x] = s.key; }); });
      SIDX = {}; STAGES.forEach(function (s, i) { SIDX[s.key] = i; });
      JOBS = D.jobs.slice().sort(function (a, b) { return P(a.created_at) - P(b.created_at); });
      JBY = {}; JOBS.forEach(function (j) { JBY[j.id] = j; });
      ACT = D.activity.slice().sort(function (a, b) { return P(a.at) - P(b.at); });
      TN = P(D.generated_at) || Date.now();
      T0 = JOBS.length ? Math.min.apply(null, JOBS.map(function (j) { return P(j.created_at); })) - 10 * MIN : TN - DAY;
      if (TN - T0 < MIN) T0 = TN - HOUR;
      EVENTS = [];
      JOBS.forEach(function (j) {
        EVENTS.push({ at: P(j.created_at), job: j, from: null, to: "received", by: null, reason: "job received" });
        j.history.forEach(function (h) { EVENTS.push({ at: P(h.at), job: j, from: h.from, to: h.to, by: h.by || null, reason: h.reason || "" }); });
      });
      EVENTS.sort(function (a, b) { return a.at - b.at; });
      REPO = D.repo || "repository";
      EPSIG = D.epics.map(function (e) { return [e.id, e.state, e.updated_at, e.activity_count, e.agents_at_work.length, e.waiting_on.who, e.slices.map(function (s) { return s.job_state; }).join(",")].join(":"); }).join("|");
    }

    // ---------------------------------------------------------------- model
    function stateAt(j, t) { if (t < P(j.created_at)) return null; var s = "received"; for (var i = 0; i < j.history.length; i++) { if (P(j.history[i].at) <= t) s = j.history[i].to; else break; } return s; }
    function enteredAt(j, t) { var e = P(j.created_at); for (var i = 0; i < j.history.length; i++) { if (P(j.history[i].at) <= t) e = P(j.history[i].at); else break; } return e; }
    function intervals(j, t) {
      var out = [], s = "received", a = P(j.created_at); if (t < a) return out;
      for (var i = 0; i < j.history.length; i++) { var h = j.history[i], at = P(h.at); if (at > t) break; out.push({ state: s, a: a, b: at }); s = h.to; a = at; }
      out.push({ state: s, a: a, b: t, open: true }); return out.filter(function (x) { return x.b >= x.a; });
    }
    function isRework(f, to) { return SIDX[S2STAGE[f]] != null && SIDX[S2STAGE[to]] != null && SIDX[S2STAGE[f]] > SIDX[S2STAGE[to]]; }
    function reworksIn(j, a, b) { return j.history.filter(function (h) { return isRework(h.from, h.to) && P(h.at) > a && P(h.at) <= b; }); }
    function wavesOf(tasks) {
      var lv = {}, by = {}; tasks.forEach(function (t) { by[t.id] = t; });
      var L = function (id) { if (lv[id] != null) return lv[id]; var t = by[id]; lv[id] = 0; if (t && t.depends_on.length) lv[id] = 1 + Math.max.apply(null, t.depends_on.map(L)); return lv[id]; };
      tasks.forEach(function (t) { L(t.id); }); var w = []; tasks.forEach(function (t) { (w[lv[t.id]] = w[lv[t.id]] || []).push(t); }); return w.filter(Boolean);
    }
    function leftBuildAt(j) { var last = null; j.history.forEach(function (h) { if (S2STAGE[h.from] === "build" && S2STAGE[h.to] !== "build") last = P(h.at); }); return last; }
    function taskStatusAt(j, task, t) {
      var s = stateAt(j, t); if (!s) return "planned"; var st = S2STAGE[s], si = SIDX[st];
      if (t >= TN - 1) return task.status;
      if (s === j.state) return task.status;
      var lb = leftBuildAt(j);
      if (lb != null && t >= lb && (si == null || si > 4)) return task.status === "todo" ? "todo" : task.status;
      if (st === "build") return "building";
      if (si != null && si < 4) return "planned";
      return task.status;
    }
    function activeAgents(j, t) {
      var s = stateAt(j, t); if (!s || GATE[s] || DONE_STATES[s] || s === "pr_open") return [];
      var ea = enteredAt(j, t), cnt = {}, since = {};
      for (var i = 0; i < ACT.length; i++) {
        var a = ACT[i], at = P(a.at); if (at > t) break; if (a.job !== j.id || !a.agent || a.state !== s || at < ea) continue;
        if (a.phase === "start") { cnt[a.agent] = (cnt[a.agent] || 0) + 1; if (cnt[a.agent] === 1) since[a.agent] = at; }
        else if (a.phase === "stop") cnt[a.agent] = Math.max(0, (cnt[a.agent] || 0) - 1);
      }
      var out = []; Object.keys(cnt).forEach(function (k) { for (var n = 0; n < cnt[k]; n++) out.push({ agent: k.replace("factory:", ""), since: since[k], job: j }); }); return out;
    }
    function gateOf(j, t) { var s = stateAt(j, t); if (!s) return null; if (GATE[s]) return GATE[s]; if (s === "pr_open") return "H4"; return null; }
    function chatReply(j, g) {
      var wo = j.waiting_on;   // Copilot Factory: the reply the CLI parses, from the data ("approve J-0004 H3 · deny J-0004 …")
      if (wo && wo.reply && wo.gate === g) { var parts = String(wo.reply).split(/\s+·\s+/); return { main: parts[0], alt: parts.length > 1 ? (wo.plain ? QALT : "or: ") + parts.slice(1).join(" · ") : "", plain: !!wo.plain }; }
      // clarify's questions are answered in your own words, not a command: nothing to copy for the main reply
      if (g === "Q") return { main: "answer the questions in chat", alt: QALT + "change A-n <value> · drop A-n", plain: true };
      if (g === "P") return { main: "resume " + j.id, alt: "or: cancel job · abandon job" };
      if (g === "H4") return { main: "merged " + j.id + " <commit>", alt: "after you merge it on GitHub or locally" };
      return { main: "approve", alt: "or: deny <what must change>" };
    }
    var QALT = "a question you skip takes its default · to override an assumption: ";
    function termCmd(j, g, t) {
      if (j.waiting_on && j.waiting_on.command && stateAt(j, t) === j.state) return j.waiting_on.command;
      return null;   // Copilot Factory: terminal approvals need a typed confirmation, so the drawing only offers the chat reply
    }
    function gateFailing(j, t) { return j.gate && j.gate.evaluated && j.gate.pass === false && stateAt(j, t) === j.state; }
    function deniedFor(j, a, b) { return ACT.filter(function (x) { return x.phase === "denied" && x.job === j.id && P(x.at) > a && P(x.at) <= b; }); }
    function stageLabel(k) { var s = ALLST.filter(function (z) { return z.key === k; })[0]; return s ? s.label : (k || "?"); }

    function snap(t) {
      var R = { t: t, jobs: [], byStage: {}, gates: [], agents: [], alerts: [] };
      ALLST.forEach(function (s) { R.byStage[s.key] = []; });
      JOBS.forEach(function (j) {
        var s = stateAt(j, t); if (!s) return; var st = S2STAGE[s];
        var g = gateOf(j, t), ag = activeAgents(j, t);
        var failing = j.tasks.some(function (tk) { return taskStatusAt(j, tk, t) === "failing"; });
        var rec = { j: j, s: s, st: st, g: g, ag: ag, failing: failing, gf: gateFailing(j, t), den: deniedFor(j, enteredAt(j, t) - 1, t), since: enteredAt(j, t), done: !!DONE_STATES[s] };
        R.jobs.push(rec); if (R.byStage[st]) R.byStage[st].push(rec); ag.forEach(function (a) { R.agents.push(a); });
        if (g && g !== "H4") R.gates.push(rec);
      });
      var order = { intent: 1, design: 2, plan: 3, change: 4, parked: 5 };
      R.gates.sort(function (a, b) { return (order[a.st] || 9) - (order[b.st] || 9) || a.since - b.since; });
      R.gates.forEach(function (r, i) { r.n = i + 1; });
      R.jobs.forEach(function (r) {
        if (r.done) return;   // a finished job is history, not an alert
        if (r.gf) R.alerts.push({ r: r, kind: "gate", text: "gate failing — " + r.j.gate.problems.join("; ") });
        if (r.failing) r.j.tasks.filter(function (tk) { return taskStatusAt(r.j, tk, t) === "failing"; }).forEach(function (tk) {
          R.alerts.push({ r: r, kind: "task", text: tk.id + " “" + tk.objective + "” failing after " + plural(tk.runs, "run") });
        });
      });
      var den24 = ACT.filter(function (a) { return a.phase === "denied" && P(a.at) > t - DAY && P(a.at) <= t; });
      if (den24.length) R.alerts.push({ kind: "denied", text: plural(den24.length, "unsafe action") + " refused by the guard in the last 24 h" });
      R.alerts.forEach(function (a, i) { a.n = i + 1; });
      R.den24 = den24.length;
      R.sentBack7 = JOBS.reduce(function (n, j) { return n + reworksIn(j, t - 7 * DAY, t).length; }, 0);
      R.open = R.jobs.filter(function (r) { return !r.done; }).length;
      // jobs that wait on your reply (a gate, clarify's questions, a merge), as the Board's "Your turn" counts them: parked jobs and lessons apart
      R.yourTurn = R.jobs.filter(function (r) { return !r.done && r.g && r.g !== "P"; }).length;
      R.parked = R.jobs.filter(function (r) { return r.g === "P"; }).length;
      R.rev = EVENTS.filter(function (e) { return e.at <= t; }).length;
      R.lessonsWaiting = (t >= TN - 1) ? D.lessons.filter(function (l) { return l.status === "proposed" && P(l.created_at) <= t; })
        : D.lessons.filter(function (l) { return P(l.created_at) <= t && (!l.decided || P(l.decided.at) > t); });
      return R;
    }

    // ---------------------------------------------------------------- shell (built once; filled on every render)
    var defs = Z("svg", { "class": "bp-defs", width: 0, height: 0, "aria-hidden": "true", focusable: "false" }, globalDefs());
    var tabs = H("nav", { "class": "sheets", role: "tablist", "aria-label": "Sheets" }, VIEWS.map(function (v, i) {
      return [v === "epics" ? H("span", { "class": "tabgrp", "aria-hidden": "true", text: "Epics" }) : null,
        H("button", { type: "button", role: "tab", "data-v": v, "aria-selected": "false", "class": EPIC_VIEWS[v] ? "etab" : null, title: VIEW_NAME[v] + ": " + VIEW_HINT[v], "aria-label": "Sheet " + (i + 1) + ": " + VIEW_NAME[v] + ", " + VIEW_HINT[v] }, H("small", { text: String(i + 1) }), VIEW_TAB[v])];
    }));
    var findIn = H("input", { type: "search", placeholder: "find job", "aria-label": "Find a job (press /)", autocomplete: "off" });
    var findList = H("ul", { role: "listbox", hidden: true });
    var snapBtn = H("button", { type: "button", "class": "btn", "aria-pressed": "false", title: "Snapshot mode: freeze and issue the sheet" }, "Snapshot");
    var notesBtn = H("button", { type: "button", "class": "btn notes-btn", "aria-expanded": "false", "aria-controls": "bp-notes" }, "Notes");
    var header = H("header", { "class": "top" }, tabs, H("div", { "class": "tools" }, notesBtn, H("div", { "class": "find" }, findIn, findList), snapBtn));
    var draw = Z("svg", { "class": "bp-draw", viewBox: "0 0 1076 694", preserveAspectRatio: "xMidYMin meet", role: "img", "aria-label": "Schematic of the factory line" });
    var gCallouts, gMarkers, gClouds, gTrails;
    var globe = H("canvas", { "class": "bp-globe", "aria-label": "Orthographic projection of repository, jobs, documents, tasks and agents. Drag to turn, scroll to zoom." });
    var glLayers = H("div", { "class": "gl-layers" });
    var glPause = H("button", { type: "button", "class": "btn", "aria-pressed": "false" }, "Pause");
    var glReset = H("button", { type: "button", "class": "btn" }, "Reset view");
    var glWords = H("div", { "class": "gl-words" });
    var ringRow = function (c, t) { return [H("span", { "class": "ring " + c }), H("span", { text: t })]; };
    var views = {
      line: H("section", { "class": "view v-line", "aria-label": "The line, drawing" }, H("p", { "class": "swipehint", text: "Drawing at full scale: swipe sideways to read the whole line." }), H("div", { "class": "scroll", "data-keep": "line" }, draw)),
      globe: H("section", { "class": "view", "aria-label": "Projection of the repository" }, H("div", { "class": "globe-wrap" }, globe, glLayers, H("div", { "class": "gl-ctl" }, glPause, glReset),
        H("div", { "class": "gl-rings", "aria-label": "Signal rings" }, ringRow("hl", "decision waits on you"), ringRow("ag", "agent at work"), ringRow("ok", "touched in last 24 h"), ringRow("fail", "stale 14 d"), ringRow("unc", "uncommitted work"), ringRow("done", "finished")),
        glWords)),
      board: H("section", { "class": "view", "aria-label": "Matrix of jobs" }),
      sched: H("section", { "class": "view", "aria-label": "Schedule and dimensions" }),
      agents: H("section", { "class": "view", "aria-label": "Parts list of agents" }),
      learn: H("section", { "class": "view", "aria-label": "General notes: lessons and standards" }),
      epics: H("section", { "class": "view", "aria-label": "Epic register: every epic by stage and by who acts next" }),
      eflow: H("section", { "class": "view", "aria-label": "Epic assembly drawing: one epic's own process" }),
      ebreak: H("section", { "class": "view", "aria-label": "Epic breakdown: exploded view of an epic's slices" })
    };
    var stamp = H("div", { "class": "stamp" });
    var sheet = H("main", { "class": "sheet" }, H("div", { "class": "frame" }), stamp, VIEWS.map(function (v) { return views[v]; }));
    // notes: a drawer over the sheet, opened from the badge (it says what waits on you) or from the drawing's callouts
    var notesBody = H("div", { "class": "nbody" });
    var notesClose = H("button", { type: "button", "class": "btn" }, "Close · Esc");
    var notes = H("aside", { "class": "notes", id: "bp-notes", "aria-label": "Notes: decisions and live status", "aria-hidden": "true" },
      H("div", { "class": "nhead" }, H("h2", { text: "Notes" }), H("span", { "class": "grow" }), notesClose), notesBody);
    var notesOpen = false, lessonOpen = {};
    var modeTag = H("span", { "class": "mode live" }, "Live");
    var playBtn = H("button", { type: "button", "class": "btn", "aria-label": "Play replay" }, "▶");
    // replay speed: how much history plays per second (1 min/s by default, remembered per browser)
    var SPEEDS = [["1", "1 s/s"], ["60", "1 min/s"], ["120", "2 min/s"], ["300", "5 min/s"], ["600", "10 min/s"], ["3600", "1 h/s"], ["14400", "4 h/s"]], spd0 = "60";
    try { var spdSaved = localStorage.getItem("bp-replay-speed2"); if (SPEEDS.some(function (o) { return o[0] === spdSaved; })) spd0 = spdSaved; } catch (e) { /* no storage: default */ }
    var speed = H("select", { "aria-label": "Replay speed", title: "Replay speed: history played per second" });
    SPEEDS.forEach(function (o) { var op = H("option", { value: o[0] }, o[1]); if (o[0] === spd0) op.selected = true; speed.appendChild(op); });
    speed.value = spd0;
    speed.addEventListener("change", function () { try { localStorage.setItem("bp-replay-speed2", speed.value); } catch (e) { /* not remembered */ } });
    var liveBtn = H("button", { type: "button", "class": "btn" }, "Now");
    var scrub = H("input", { type: "range", min: 0, max: 1000, step: 1, value: 1000, "aria-label": "Replay position" });
    var ticks = Z("svg", { preserveAspectRatio: "none", viewBox: "0 0 1000 24" });
    var tbProj = H("div", { "class": "v" }), tbDraw = H("div", { "class": "v" }), tbAsof = H("div", { "class": "v" }), tbRev = H("div", { "class": "v" }), tbSheetK = H("div", { "class": "k" }, "Sheet");
    var tbQ = H("div", { "class": "qs" });
    var cell = function (k, v, c) { return H("div", { "class": "cell" + (c ? " " + c : "") }, typeof k === "string" ? H("div", { "class": "k", text: k }) : k, v); };
    // the title block: one row; the replay controls and the revision history share the first cell
    // the Autopilot note (filled by renderAP): shown when the prompt hook saw Copilot's Autopilot in this project
    var apCell = H("div", { "class": "cell apnote", hidden: true, role: "note" });
    var footer = H("footer", { "class": "tb" },
      H("div", { "class": "cell rcell" }, H("div", { "class": "k", text: "Revision history · replay" }), H("div", { "class": "ctl" }, modeTag, playBtn, speed, liveBtn, H("div", { "class": "scrub" }, scrub, ticks))),
      apCell,
      H("div", { "class": "tbinfo" }, cell("Project", tbProj, "proj"), cell(tbSheetK, tbDraw), cell("As of · UTC", tbAsof), cell("Revision", tbRev), tbQ));
    var app = H("div", { "class": "app" }, header, sheet, footer);
    var secTitle = H("h2", { id: "bp-sec-title" });
    var secClose = H("button", { type: "button", "class": "btn" }, "Close · Esc");
    var secBody = H("div", { "class": "sbody" });
    var section = H("div", { "class": "section", role: "dialog", "aria-modal": "false", "aria-labelledby": "bp-sec-title", "aria-hidden": "true" },
      H("div", { "class": "sh" }, secTitle, H("span", { "class": "grow" }), secClose), secBody);
    var toastEl = H("div", { "class": "toast", role: "status", "aria-live": "polite" });
    kids(root, [defs, app, notes, section, toastEl]);

    function placeTop() {
      if (!alive()) return;
      var top = root.getBoundingClientRect().top + (window.scrollY || 0);
      root.style.setProperty("--bp-top", Math.max(0, Math.round(top)) + "px");
      root.style.setProperty("--bp-sec-top", Math.max(0, Math.round(header.getBoundingClientRect().bottom)) + "px");
    }

    // ---------------------------------------------------------------- svg pieces
    function globalDefs() {
      var hatch = function (id, w, rot, body) { return Z("pattern", { id: id, width: w, height: w, patternUnits: "userSpaceOnUse", patternTransform: "rotate(" + rot + ")" }, body); };
      var marker = function (id, vb, rx, ry, mw, mh, path, a) { return Z("marker", { id: id, viewBox: vb, refX: rx, refY: ry, markerWidth: mw, markerHeight: mh, orient: "auto-start-reverse" }, Z("path", Object.assign({ d: path }, a))); };
      return Z("defs", null,
        hatch("bp-h-med", 6, 45, Z("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: "var(--ink)", "stroke-width": 1.3 })),
        hatch("bp-h-high", 6, 45, Z("path", { d: "M0 0V6M0 0H6", stroke: "var(--ink)", "stroke-width": 1.2 })),
        hatch("bp-h-wait", 7, 45, [Z("rect", { width: 7, height: 7, fill: "var(--hl-soft)" }), Z("line", { x1: 0, y1: 0, x2: 0, y2: 7, stroke: "var(--hl)", "stroke-width": 3 })]),
        hatch("bp-h-fail", 6, -45, [Z("rect", { width: 6, height: 6, fill: "var(--fail-soft)" }), Z("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: "var(--fail)", "stroke-width": 1.2 })]),
        marker("bp-arw", "0 0 10 10", 9, 5, 7, 7, "M0 1L10 5L0 9z", { fill: "var(--ink)" }),
        marker("bp-arw2", "0 0 10 10", 9, 5, 6, 6, "M0 1L10 5L0 9z", { fill: "var(--ink-2)" }),
        marker("bp-arw-run", "0 0 10 10", 9, 5, 7, 7, "M0 1L10 5L0 9z", { fill: "var(--agent)" }),
        marker("bp-arw-rw", "0 0 10 10", 9, 5, 7, 7, "M0 1L10 5L0 9z", { fill: "var(--fail)" }),
        marker("bp-arw-rw0", "0 0 10 10", 9, 5, 6, 6, "M0 1L10 5L0 9z", { fill: "var(--ink-3)" }),
        marker("bp-arw-pk", "0 0 10 10", 9, 5, 7, 7, "M0 1L10 5L0 9z", { fill: "var(--ink-2)" }),
        marker("bp-dimA", "0 0 12 8", 12, 4, 9, 6, "M0 0L12 4L0 8", { fill: "none", stroke: "var(--ink-2)", "stroke-width": 1.4 }),
        Z("marker", { id: "bp-dot", viewBox: "0 0 8 8", refX: 4, refY: 4, markerWidth: 6, markerHeight: 6 }, Z("circle", { cx: 4, cy: 4, r: 3, fill: "var(--ink)" })));
    }
    function tx(x, y, text, a) { return Z("text", Object.assign({ x: x, y: y }, a || {}), text); }
    function ts(text, a) { return Z("tspan", a || {}, text); }
    function typeSym(type, x, y, s) {
      var r = s / 2, c = { "class": "ln", "stroke-width": 1.5 };
      switch (type) {
        case "feature": return Z("circle", Object.assign({ cx: x, cy: y, r: r - 1 }, c));
        case "bug": return Z("path", Object.assign({ d: "M" + (x - r + 1) + " " + (y - r + 1) + "L" + (x + r - 1) + " " + (y + r - 1) + "M" + (x + r - 1) + " " + (y - r + 1) + "L" + (x - r + 1) + " " + (y + r - 1) }, c));
        case "hotfix": return Z("path", Object.assign({ d: "M" + x + " " + (y - r) + "L" + (x + r) + " " + (y + r - 1) + "L" + (x - r) + " " + (y + r - 1) + "Z" }, c));
        case "spike": return Z("path", Object.assign({ d: "M" + x + " " + (y - r) + "L" + (x + r) + " " + y + "L" + x + " " + (y + r) + "L" + (x - r) + " " + y + "Z" }, c));
        default: return Z("rect", Object.assign({ x: x - r + 1, y: y - r + 1, width: s - 2, height: s - 2 }, c));
      }
    }
    var riskFill = function (r) { return r === "high" ? "url(#bp-h-high)" : r === "medium" ? "url(#bp-h-med)" : "none"; };
    function cloudPath(x, y, w, h, b) {
      b = b || 9; var d = "M" + x + " " + y;
      var seg = function (x1, y1, x2, y2) { var L = Math.hypot(x2 - x1, y2 - y1), n = Math.max(2, Math.round(L / b)), s = ""; for (var i = 1; i <= n; i++) { var px = x1 + (x2 - x1) * i / n, py = y1 + (y2 - y1) * i / n; s += " A" + (L / n / 2) + " " + (L / n / 2) + " 0 0 1 " + px.toFixed(1) + " " + py.toFixed(1); } return s; };
      return d + seg(x, y, x + w, y) + seg(x + w, y, x + w, y + h) + seg(x + w, y + h, x, y + h) + seg(x, y + h, x, y) + "Z";
    }
    function delta(x, y, n) { return Z("g", null, Z("path", { "class": "delta", d: "M" + x + " " + (y - 10) + "L" + (x + 11) + " " + (y + 8) + "L" + (x - 11) + " " + (y + 8) + "Z" }), tx(x, y + 5.5, String(n), { "text-anchor": "middle", "class": "t-disp t-fail", "font-size": 13, "font-weight": 700 })); }
    function railPath(sx, ex, top, lvl) {
      var r = 9, d = sx > ex ? -1 : 1;
      return "M" + sx + " " + top + " V" + (lvl + r) + " Q" + sx + " " + lvl + " " + (sx + d * r) + " " + lvl + " H" + (ex - d * r) + " Q" + ex + " " + lvl + " " + ex + " " + (lvl + r) + " V" + (top - 2);
    }
    // one row under the title: what each line colour and each state colour means
    function lineKey(x, y) {
      var items = [
        ["the line", function (x0) { return Z("line", { x1: x0, y1: y, x2: x0 + 24, y2: y, "class": "flow", "marker-end": "url(#bp-arw)" }); }, 30],
        ["moving", function (x0) { return Z("line", { x1: x0, y1: y, x2: x0 + 24, y2: y, "class": "flow hot", "marker-end": "url(#bp-arw-run)" }); }, 30],
        ["sent back", function (x0) { return Z("path", { d: "M" + (x0 + 24) + " " + (y + 6) + " V" + (y - 4) + " H" + x0 + " V" + (y + 4), "class": "rail hot", "marker-end": "url(#bp-arw-rw)" }); }, 30],
        ["side track", function (x0) { return Z("line", { x1: x0, y1: y, x2: x0 + 24, y2: y, "class": "side-ln", "marker-end": "url(#bp-arw-pk)" }); }, 30],
        ["idle", function (x0) { return Z("circle", { cx: x0 + 6, cy: y, r: 5.5, "class": "lamp" }); }, 16],
        ["at work", function (x0) { return Z("circle", { cx: x0 + 6, cy: y, r: 5.5, "class": "lamp on" }); }, 16],
        ["waits on you", function (x0) { return boxText(x0, y - 6, 14, 12, { "class": "hl-fill", stroke: "var(--ink)", "stroke-width": 1, rx: 2 }); }, 20],
        ["failing", function (x0) { return boxText(x0, y - 6, 14, 12, { fill: "none", stroke: "var(--fail)", "stroke-width": 2, rx: 2 }); }, 20],
        ["done", function (x0) { return tx(x0 + 6, y + 4.5, "✓", { "text-anchor": "middle", "font-size": 14, "class": "t-ok", "font-weight": 700 }); }, 16]];
      var g = Z("g", { "class": "legend" });
      items.forEach(function (it) { kids(g, [it[1](x), tx(x + it[2], y + 4.5, it[0], { "font-size": 13, "class": "t2" })]); x += it[2] + measure(it[0], "t2", 13) + 20; });
      return g;
    }
    function boxText(x, y, w, h, a) { return Z("rect", Object.assign({ x: x, y: y, width: w, height: h }, a)); }

    // ---------------------------------------------------------------- measuring: labels are wrapped or given room, never cut by accident
    var L = null, mCache = {}, mText = null;
    function measure(text, cls, size, weight) {
      var key = cls + "|" + size + "|" + (weight || 400) + "|" + text;
      if (mCache[key] != null) return mCache[key];
      var w = 0;
      try {
        // measured in the always-rendered defs svg, so the epic sheets can measure while sheet 1 is hidden
        if (!mText || mText.parentNode !== defs) { mText = Z("text", { x: -999, y: -999, "aria-hidden": "true", visibility: "hidden" }); defs.appendChild(mText); }
        mText.setAttribute("class", cx(cls)); mText.setAttribute("font-size", size); mText.setAttribute("font-weight", weight || 400);
        mText.textContent = String(text); w = mText.getComputedTextLength();
      } catch (e) { w = 0; }
      if (w > 0) { mCache[key] = w; return w; }
      return String(text).length * size * .55;   // not laid out (hidden sheet): a generous estimate
    }
    function wrapN(s, max, cls, size, wt, n) {
      s = String(s || "").trim(); n = n || 3;
      if (n <= 1 || measure(s, cls, size, wt) <= max) return [s];
      var best = -1;
      for (var i = 2; i < s.length - 1; i++) if (/[-_.\/\s]/.test(s.charAt(i - 1)) && measure(s.slice(0, i).trim(), cls, size, wt) <= max) best = i;
      if (best < 0) { best = 1; while (best < s.length - 1 && measure(s.slice(0, best + 1), cls, size, wt) <= max) best++; }
      return [s.slice(0, best).trim()].concat(wrapN(s.slice(best), max, cls, size, wt, n - 1));
    }

    // ---------------------------------------------------------------- layout of sheet 1 (from the canvas size and what is on the line)
    function sortedRecs(key) {
      var recs = (S.byStage[key] || []).slice();
      if (key === "done") return recs.sort(function (a, b) { return b.since - a.since; });
      return recs.sort(function (a, b) { return (b.g ? 1 : 0) - (a.g ? 1 : 0) || a.since - b.since; });
    }
    function stackOf(key, recs, w) {
      var cap = SIDX[key] != null ? 3 : 2, shown = recs.length > cap ? cap - 1 : cap, list = [], y = 0;
      recs.slice(0, shown).forEach(function (r) {
        var lines = wrapN(r.j.slug, w - 10, "t-cond", 15, 600, 3), h = 18 + lines.length * 15 + (r.j.epic ? ETAG_H : 0);
        list.push({ r: r, lines: lines, h: h, dy: y }); y += h + MK_GAP;
      });
      var more = Math.max(0, recs.length - shown), moreDy = y;
      if (more) y += 30 + MK_GAP;
      return { list: list, more: more, moreDy: moreDy, h: y ? y - MK_GAP : 0, w: w };
    }
    // the geometry: L.cell[i] = one station's column (x, w, row), L.row[r] = one row of stations (top, line, bank),
    // L.L / L.R = the foot's two columns (details on the left, side tracks on the right)
    function computeLayout(width, extra) {
      W = Math.max(MIN_W, Math.round(width));
      var n = STAGES.length, o = { st: {}, side: {}, sideOrder: [], sideEmpty: [], marks: {}, det: {}, cell: [], row: [] };
      // two rows when the line is long: the second starts at Build, so the return rails stay within one row
      var K = n > 5 ? (SIDX.build >= 2 && SIDX.build <= n - 2 ? SIDX.build : Math.ceil(n / 2)) : n, i0 = 0;
      (K < n ? [K, n - K] : [n]).forEach(function (cnt, r) {
        var w = Math.floor((W - 2 * MG - (cnt - 1) * SG) / Math.max(1, cnt));
        for (var k = 0; k < cnt; k++) o.cell[i0 + k] = { x: MG + k * (w + SG), w: w, r: r };
        o.row.push({ a: i0, b: i0 + cnt - 1, w: w }); i0 += cnt;
      });
      // the foot: details under the first stations of the last row, side tracks under the rest
      var lr = o.row[o.row.length - 1], split = lr.a + Math.max(0, Math.ceil((lr.b - lr.a + 1) * .6) - 1);
      if (split >= lr.b) split = lr.b - 1;
      if (split < lr.a) { o.L = { x: MG, w: Math.round((W - 2 * MG - SG) * .6) }; o.R = { x: o.L.x + o.L.w + SG, w: W - MG - (o.L.x + o.L.w + SG) }; }
      else { o.L = { x: MG, w: o.cell[split].x + o.cell[split].w - MG }; o.R = { x: o.cell[split + 1].x, w: W - MG - o.cell[split + 1].x }; }
      o.sideX = o.R.x + 26; o.sideW = o.R.w - 26;
      o.sideMW = Math.max(150, Math.min(300, Math.floor((o.sideW - 16) * .5)));   // a job marker on a side track
      ALLST.forEach(function (s) {
        var i = SIDX[s.key];
        o.st[s.key] = stackOf(s.key, sortedRecs(s.key), i != null ? o.cell[i].w - 10 : o.sideMW);
      });
      // the callout band above the first row is drawn only when a decision waits there
      var y = S.gates.some(function (r) { return SIDX[r.st] != null && o.cell[SIDX[r.st]].r === 0; }) ? SY0 : 104;
      o.row.forEach(function (rw, r) {
        // between two rows: the return line, then room for the rails that send work back within the next row
        if (r) { rw.ret = y + 30; y = rw.ret + 130; }
        var mx = 0, rows = 2;
        for (var i = rw.a; i <= rw.b; i++) {
          var key = STAGES[i].key;
          mx = Math.max(mx, o.st[key].h);
          rows = Math.max(rows, bankRows(key, o.cell[i].w) + (key === "done" && S.lessonsWaiting.length ? 1 : 0));
        }
        rw.SY = y; rw.SH = mx ? 62 + mx + 12 : 72; rw.PY = y + 38;
        rw.BY = y + rw.SH + 32; rw.BH = 30 + rows * 21 + 4;
        y = rw.BY + rw.BH;
      });
      o.F0 = y + 48 + extra;
      // side tracks: one wide box per track that holds work, stacked; the empty ones a thin outline each
      var sy = o.F0 + 16;
      SIDE_KEYS.forEach(function (k) {
        if (!SIDES.some(function (s) { return s.key === k; })) return;
        if (!(S.byStage[k] || []).length) { o.sideEmpty.push(k); return; }
        var gate = S.byStage[k].some(function (r) { return r.g; }), h = 48 + Math.max(o.st[k].h, gate ? 58 : 0) + 12;
        o.sideOrder.push(k); o.side[k] = { x: o.sideX, y: sy, w: o.sideW, h: h }; sy += h + 12;
      });
      o.sideEmpty.forEach(function (k) { o.side["~" + k] = { x: o.sideX, y: sy, w: o.sideW, h: 32 }; sy += 32 + 10; });
      o.sideBottom = sy - 10;
      return o;
    }
    function slotPos(key, dy) {
      var i = SIDX[key];
      if (i != null) { var c = L.cell[i]; return { x: c.x + 5, y: L.row[c.r].SY + 62 + dy }; }
      var b = L.side[key]; return b ? { x: b.x + 8, y: b.y + 48 + dy } : { x: L.sideX + 8, y: L.F0 + 48 + dy };
    }
    // the canvas: lay the drawing out to the sheet's width, then zoom so it fills the height as well (within limits)
    function canvasSize() {
      var v = views.line.querySelector(".bp-scroll") || views.line, cw = v.clientWidth || 1076, ch = v.clientHeight || 694;
      var narrow = window.matchMedia ? window.matchMedia("(max-width: 860px)").matches : false;
      return { w: cw, h: ch, narrow: narrow };
    }

    // ---------------------------------------------------------------- sheet 1: the drawing
    function renderDrawing() {
      // never squeeze: the drawing is laid out at full scale (at least MIN_W wide). When it is bigger than the sheet it
      // keeps that size and the sheet scrolls inside itself; when there is room left it zooms in to fill it.
      var cs = canvasSize(), s = 1, o, lw = Math.max(MIN_W, cs.w);
      o = drawingAt(lw);
      if (cs.narrow || lw > cs.w || o.H > cs.h) { finishDrawing(o, W, o.H, true); return; }
      s = Math.max(1, Math.min(cs.w > 1700 ? 1.3 : 1.15, cs.h / o.H, cs.w / MIN_W));
      if (Math.abs(s - 1) > .01) o = drawingAt(cs.w / s);
      var slack = cs.h / s - o.H;   // what is still free goes to the breathing room above the foot, not to empty boxes
      if (slack > 16) o = drawingAt(cs.w / s, Math.min(44, slack * .5));
      finishDrawing(o, W, Math.max(o.H, cs.h / s), false);
    }
    function finishDrawing(o, vw, vh, narrow) {
      draw.setAttribute("viewBox", "0 0 " + Math.round(vw) + " " + Math.round(vh));
      if (narrow) { draw.style.setProperty("width", Math.round(vw) + "px"); draw.style.setProperty("height", Math.round(vh) + "px"); }
      else { draw.style.removeProperty("width"); draw.style.removeProperty("height"); }
      gCallouts = Z("g"); gTrails = Z("g"); gMarkers = Z("g"); gClouds = Z("g");
      fill(draw, o.nodes, gTrails, gCallouts, gMarkers, gClouds);
      [].forEach.call(draw.querySelectorAll("[data-fit]"), function (t) { fitText(t, +t.getAttribute("data-fit")); });
      renderMarkers();
    }
    function sentBackFrom(key, t) { return JOBS.reduce(function (a, j) { return a + reworksIn(j, t - 7 * DAY, t).filter(function (h) { return S2STAGE[h.from] === key; }).length; }, 0); }
    function drawingAt(width, extra) {
      var t = S.t, o = [];
      L = computeLayout(width, extra || 0);
      var R0 = L.row[0], last = L.row[L.row.length - 1];
      zoneNums(o, W);
      o.push(tx(10, 36, "Drawing 1 · the line", { "class": "t-disp", "font-size": 18, "font-weight": 700 }));
      o.push(lineKey(10 + measure("Drawing 1 · the line", "t-disp", 18, 700) + 36, 31));
      // epics are not drawn on these sheets: say so, rather than leave them silently missing
      if (D.epic_jobs.length) o.push(Z("g", { "class": "mk", "data-notes": "epics", tabindex: 0, role: "button", "aria-label": plural(D.epic_jobs.length, "epic") + " not drawn here: shown on the Board. Open the notes." },
        tx(10, 60, "◇ " + plural(D.epic_jobs.length, "epic") + " (" + D.epic_jobs.map(function (e) { return e.id; }).join(", ") + ") shown on the Board, not on these sheets · notes", { "font-size": 13, "class": "t2", "data-fit": W - 20 })));
      // return rails: what was sent back to Build, one level each above Build's row; red while it happened this week
      var bi = SIDX.build != null ? SIDX.build : Math.min(4, STAGES.length - 1), bc = L.cell[bi], brow = L.row[bc.r], bx = bc.x + bc.w / 2;
      RAILS.forEach(function (r) {
        var fi = SIDX[r.from]; if (fi == null || L.cell[fi].r !== bc.r || fi <= bi) return;
        var fc = L.cell[fi], fx = fc.x + fc.w / 2, ex = bx + r.land, ry = brow.SY - r.up, n = sentBackFrom(r.from, t);
        o.push(Z("path", { d: railPath(fx, ex, brow.SY, ry), "class": "rail" + (n ? " hot" : ""), "marker-end": "url(#bp-arw-" + (n ? "rw" : "rw0") + ")" }, Z("title", null, r.name + " to Build: " + plural(n, "time") + " in the last 7 days")));
        var lab = r.name + " · " + (n ? n + " this week" : "none this week"), lw = measure(lab, "rail-t", 13, 600) + 18, mx = (ex + fx) / 2;
        o.push(boxText(mx - lw / 2, ry - 10, lw, 20, { "class": "paperfill" }), tx(mx, ry + 4.5, lab, { "text-anchor": "middle", "font-size": 13, "class": "rail-t" + (n ? " hot" : ""), "font-weight": 600 }));
      });
      // the process line: one continuous line through every station's steps, arrows in the gaps, live where work flows;
      // where a row ends it turns down the right margin, runs back under the row, and enters the next row from the left
      var stBusy = STAGES.map(function (s) { var r = S.byStage[s.key] || []; return { open: r.some(function (x) { return !x.done && !x.g; }), ag: r.reduce(function (a, x) { return a + x.ag.length; }, 0) }; });
      o.push(Z("line", { x1: 8, y1: R0.PY, x2: MG - 2, y2: R0.PY, "class": "flow", "marker-end": "url(#bp-arw)" }, Z("title", null, "requests come in here")));
      var onTop = [];   // labels that sit on the line, drawn after it
      for (var f = 0; f < STAGES.length - 1; f++) {
        var c1 = L.cell[f], c2 = L.cell[f + 1], hot = stBusy[f].open || stBusy[f + 1].ag, d;
        if (c1.r === c2.r) d = "M" + (c1.x + c1.w) + " " + L.row[c1.r].PY + " H" + (c2.x - 2);
        else {
          var r1 = L.row[c1.r], r2 = L.row[c2.r], xr = W - 14, xl = 14, yr = r2.ret, q = 10;
          d = "M" + (c1.x + c1.w) + " " + r1.PY + " H" + (xr - q) + " Q" + xr + " " + r1.PY + " " + xr + " " + (r1.PY + q) + " V" + (yr - q) + " Q" + xr + " " + yr + " " + (xr - q) + " " + yr +
            " H" + (xl + q) + " Q" + xl + " " + yr + " " + xl + " " + (yr + q) + " V" + (r2.PY - q) + " Q" + xl + " " + r2.PY + " " + (xl + q) + " " + r2.PY + " H" + (c2.x - 2);
          var cl = "the line continues: " + STAGES[f].label + " → " + STAGES[f + 1].label, cw = measure(cl, "t2", 13) + 20;
          onTop.push(boxText(W / 2 - cw / 2, yr - 10, cw, 20, { "class": "paperfill" }), tx(W / 2, yr + 4.5, cl, { "text-anchor": "middle", "font-size": 13, "class": "t2" }));
        }
        o.push(Z("path", { d: d, "class": "flow" + (hot ? " hot" : ""), "marker-end": "url(#bp-arw" + (hot ? "-run" : "") + ")" }));
        if (hot) o.push(Z("path", { d: d, "class": "flow-live" }));
      }
      onTop.forEach(function (n) { o.push(n); });
      // stations
      STAGES.forEach(function (s, i) {
        var c = L.cell[i], rw = L.row[c.r], x = c.x, SW = c.w, SY = rw.SY, SH = rw.SH, PY = rw.PY;
        var recs = S.byStage[s.key], g = Z("g", { "class": "station" + (stBusy[i].ag ? " active" : "") });
        var ag = stBusy[i].ag;
        var hasGate = recs.some(function (r) { return r.g && r.g !== "H4"; }), failing = recs.some(function (r) { return !r.done && (r.failing || r.gf); });
        var stc = failing ? "var(--fail)" : hasGate ? "var(--hl-line)" : ag ? "var(--agent)" : recs.length ? "var(--ink)" : "var(--ink-3)";
        kids(g, [boxText(x, SY, SW, SH, { "class": "paperfill st-box", stroke: stc, "stroke-width": failing || hasGate || ag ? 2.4 : recs.length ? 1.6 : 1.2 }),
          ag ? boxText(x + 1, SY + 1, SW - 2, 25, { "class": "st-live" }) : null,
          Z("path", { d: "M" + (x + 4) + " " + (SY + 4) + "h6M" + (x + 4) + " " + (SY + 4) + "v6M" + (x + SW - 4) + " " + (SY + SH - 4) + "h-6M" + (x + SW - 4) + " " + (SY + SH - 4) + "v-6", "class": "ln3" }),
          tx(x + 8, SY + 18, p2(i + 1), { "font-size": 13, "class": "t-mono t2" }), tx(x + 30, SY + 18, s.label, { "font-size": 16, "class": "t-disp tight", "font-weight": 700, "data-fit": SW - 30 - 30 }),
          Z("circle", { cx: x + SW - 14, cy: SY + 13, r: 10, "class": ag ? "lamp on" : "paperfill", stroke: ag ? null : "var(--ink)", "stroke-width": 1.2 }, Z("title", null, plural(recs.length, "job") + " here")),
          tx(x + SW - 14, SY + 17.5, String(recs.length), { "text-anchor": "middle", "font-size": 13, "class": "t-mono" + (ag ? " on-agent" : ""), "font-weight": 700 }),
          // the line runs through the station; the steps sit on it
          Z("line", { x1: x, y1: PY, x2: x + SW, y2: PY, "class": "flow inner" + (stBusy[i].open || ag ? " hot" : "") }),
          stBusy[i].open || ag ? Z("line", { x1: x + 2, y1: PY, x2: x + SW - 2, y2: PY, "class": "flow-live" }) : null]);
        var steps = STEPS[s.key] || [], pitch = Math.min(56, (SW - 40) / Math.max(1, steps.length - 1));
        steps.forEach(function (st, k) {
          var cx = x + 16 + k * pitch, cy = PY, sym;
          if (st[0] === "a") sym = boxText(cx - 7, cy - 7, 14, 14, { "class": "paperfill", stroke: "var(--ink)", "stroke-width": 1.3 });
          else if (st[0] === "c") sym = Z("path", { d: "M" + cx + " " + (cy - 8) + "L" + (cx + 8) + " " + cy + "L" + cx + " " + (cy + 8) + "L" + (cx - 8) + " " + cy + "Z", "class": "paperfill", stroke: "var(--ink)", "stroke-width": 1.3 });
          else {
            var on = recs.some(function (r) { return r.g === st[1]; });
            sym = [on ? Z("circle", { cx: cx, cy: cy, r: 11, "class": "balloon-glow pulse" }) : null,
              Z("circle", { cx: cx, cy: cy, r: 11, "class": on ? "gate-on" : "paperfill", stroke: "var(--ink)", "stroke-width": 1.3, "stroke-dasharray": st[1] === "H4" ? "3 2" : null }),
              tx(cx, cy + 4.5, st[1], { "text-anchor": "middle", "font-size": 13, "class": "t-mono" + (on ? " on-hl" : ""), "font-weight": 600 })];
          }
          kids(g, [Z("g", null, Z("title", null, st[0] === "a" ? "agent step: " + st[1] : st[0] === "c" ? "CLI check: " + st[1] : "your decision " + st[1] + ": " + gv(st[1])), sym)]);
        });
        if (LOOPS[s.key]) {
          var lx = x + SW - 40, lw0 = LOOPS[s.key] === "revise" ? wd("revise") : LOOPS[s.key];
          kids(g, [Z("path", { d: "M" + lx + " " + SY + " c0 -17 24 -17 24 0", "class": "rail loop", "marker-end": "url(#bp-arw-rw0)" }, Z("title", null, LOOPS[s.key] === "revise" ? "God Eye, the independent reviewer, can send the draft back for another round" : "the analysts can come back to you with questions")),
            tx(lx - 6, SY - 7, lw0, { "text-anchor": "end", "font-size": 13, "class": "rail-t" })]);
        }
        var stk = L.st[s.key];
        if (stk && stk.more) { var p = slotPos(s.key, stk.moreDy); kids(g, [Z("g", { "class": "mk", "data-more": s.key, tabindex: 0, role: "button", "aria-label": stk.more + " more jobs at " + s.label + ": open the matrix" }, boxText(p.x, p.y, stk.w, 30, { "class": "paperfill", stroke: "var(--ink)", "stroke-dasharray": "3 2" }), tx(p.x + stk.w / 2, p.y + 19.5, "+" + stk.more + " more", { "text-anchor": "middle", "font-size": 13, "class": "t-mono" }))]); }
        kids(g, [bankNode(s, i, recs, ag)]);
        o.push(g);
      });
      // section marks A B C under Build, Review, Verify: each points to its detail below
      [["A", "build"], ["B", "review"], ["C", "verify"]].forEach(function (q) {
        var i = SIDX[q[1]]; if (i == null) return; var c = L.cell[i], rw = L.row[c.r], x = c.x + c.w - 16, y = rw.BY + rw.BH + 16; L.marks[q[0]] = { x: x, y: y };
        o.push(Z("g", null, Z("title", null, "detail " + q[0] + " below shows this station up close"), Z("circle", { cx: x, cy: y, r: 10, "class": "paperfill", stroke: "var(--ink)", "stroke-width": 1.3 }), tx(x, y + 4.5, q[0], { "text-anchor": "middle", "font-size": 13, "class": "t-disp", "font-weight": 700 })));
      });

      // ------------- the foot: details on the left, side tracks on the right; only what exists is drawn at size
      var buildOn = (S.byStage.build || []).some(function (r) { return !r.done; }), reviewOn = (S.byStage.review || []).some(function (r) { return !r.done; });
      var verOn = (S.byStage.verify || []).length > 0, rounds = S.jobs.filter(function (r) { return ["intent", "design", "plan"].indexOf(r.st) >= 0; });
      // epics have their own sheets (7-9): on the line a slice is an ordinary job marker tagged with its epic
      var cOn = verOn || rounds.length > 0, ly = L.F0, ry = L.F0, CL = L.L, CR = L.R, DH = 196;
      if (L.sideOrder.length) { o.push(sideTracks()); ry = L.sideBottom + 24; }
      else { o.push(strip(CR.x, ry, CR.w)); ry += 32 + 24; }
      var half = Math.floor((CL.w - 24) / 2);
      if (buildOn && reviewOn && half >= 440) { o.push(detailA(t, CL.x, ly, half, DH), detailB(t, CL.x + half + 24, ly, CL.w - half - 24, DH)); L.det.A = { x: CL.x, y: ly, w: half }; L.det.B = { x: CL.x + half + 24, y: ly, w: CL.w - half - 24 }; ly += DH + 24; }
      else {
        if (buildOn) { o.push(detailA(t, CL.x, ly, CL.w, DH)); L.det.A = { x: CL.x, y: ly, w: CL.w }; ly += DH + 24; }
        if (reviewOn) { o.push(detailB(t, CL.x, ly, CL.w, DH)); L.det.B = { x: CL.x, y: ly, w: CL.w }; ly += DH + 24; }
      }
      if (cOn) { var dc = detailC(t, CL.x, ly, CL.w, rounds); o.push(dc.g); L.det.C = { x: CL.x, y: ly, w: CL.w }; ly += dc.h + 24; }
      var idle = []; if (!buildOn) idle.push("A"); if (!reviewOn) idle.push("B"); if (!cOn) idle.push("C");
      if (idle.length) { var ib = idleDetails(t, CL.x, ly, CL.w, idle); o.push(ib.g); idle.forEach(function (k) { L.det[k] = { x: CL.x, y: ly, w: CL.w, idle: true }; }); ly += ib.h + 24; }
      // section lines: each mark points straight down to its detail when nothing stands between them
      ["A", "B", "C"].forEach(function (k) {
        var m = L.marks[k], dt = L.det[k]; if (!m || !dt || dt.y !== L.F0 || m.x < dt.x + 8 || m.x > dt.x + dt.w - 8) return;
        o.push(Z("line", { x1: m.x, y1: m.y + 10, x2: m.x, y2: dt.y - 1, "class": dt.idle ? "ln3" : "ln-agent", "stroke-dasharray": "3 3", "marker-end": dt.idle ? null : "url(#bp-arw2)" }));
      });
      // finished work: a readable list in whichever column has room (always on a quiet line)
      var fin = sortedRecs("done");
      if (fin.length) {
        var quiet = !buildOn && !reviewOn && !cOn && !L.sideOrder.length && !S.gates.length;
        var useL = ly < ry, col = useL ? CL : CR, cy = useL ? ly : ry, other = useL ? ry : ly;
        var room = quiet ? 8 : Math.max(3, Math.floor((other - 24 - cy - 38) / 42));
        var rows = Math.min(fin.length, room, 8);
        if (rows > 0) { o.push(finishedPanel(t, col.x, cy, col.w, fin, rows)); if (useL) ly = cy + 38 + rows * 42 + 24; else ry = cy + 38 + rows * 42 + 24; }
      }
      return { nodes: o, H: Math.max(ly, ry) - 10 };
    }

    // an agent bank: every member a named lamp; lit (and naming its job) while that agent is at work
    var ROLE_NAME = { "intent-mapper": "intent mapper", verifier: "evidence verifier", "option-generator": "option generator", "intent-analyst": "analyst", judge: "judge", "contract-editor": "contract editor", "god-eye": "God Eye", researcher: "researcher", "threat-modeler": "threat model", architect: "architect",
      planner: "planner", slicer: "slicer", builder: "builder", tester: "tester", integrator: "integrator", "finding-verifier": "finding verifier", "lesson-writer": "lesson writer" };
    var ROLE_LANE = { "code-reviewer": "code", "test-reviewer": "tests", "security-reviewer": "security", "ux-reviewer": "ux", "epic-reviewer": "conformance" };
    var LANE_ROLE = { code: "code-reviewer", tests: "test-reviewer", security: "security-reviewer", ux: "ux-reviewer", conformance: "epic-reviewer" };
    function roleName(role, key) {
      if (role === "researcher" && key === "intent") return "scouts · repo, web";
      if (ROLE_LANE[role]) return wd("lane", ROLE_LANE[role]);
      if (role === "god-eye") return wd("godEye");
      return ROLE_NAME[role] || agentLabel(role);
    }
    // a bank's members now: Challenge has one reviewer per lane the jobs there must pass (else the lanes any job here
    // requires) and the finding verifier; Ship has the post-merge reviewers only when a job's recipe runs that review
    function bankMembers(key) {
      var lanesOf = function (list) { return uniq([].concat.apply([], list.map(function (j) { return arr(j.required_lanes); }))); };
      if (key === "review") {
        var ln = lanesOf((S.byStage.review || []).filter(function (r) { return !r.done; }).map(function (r) { return r.j; }));
        if (!ln.length) ln = lanesOf(JOBS);
        ln = ln.filter(function (l) { return LANE_ROLE[l]; });
        return ln.length ? ln.map(function (l) { return [LANE_ROLE[l], l + " lane"]; }).concat([["finding-verifier", "finding verifier"]]) : [];
      }
      if (key === "ship") {
        var pm = uniq([].concat.apply([], JOBS.map(function (j) { return arr(j.post_merge_lanes); }))).filter(function (l) { return LANE_ROLE[l]; });
        return pm.length ? pm.map(function (l) { return [LANE_ROLE[l], l + " lane after merge"]; }).concat([["finding-verifier", "finding verifier"]]) : [];
      }
      return (BANKS[key] || {}).members || [];
    }
    function bankGroups(key) {
      var out = [], by = {};
      bankMembers(key).forEach(function (m) { if (by[m[0]]) { by[m[0]].n++; return; } by[m[0]] = { role: m[0], n: 1, name: roleName(m[0], key) }; out.push(by[m[0]]); });
      return out;
    }
    function bankRows(key, w) {
      var lr = bankRun(key);
      if (lr.live) return Math.max(2, runRows(lr, w).length);
      var work = {}; (S.byStage[key] || []).forEach(function (r) { r.ag.forEach(function (a) { work[a.agent] = 1; }); });
      return Math.max(2, bankGroups(key).reduce(function (n, gr) { return n + (work[gr.role] ? 2 : 1); }, 0));
    }
    // ------------- the workflow run in a bank: its steps, as they stood at the replay time (RUN_STEPS.view, cli/core/run-steps.js)
    var HAS_RUNS = typeof RUN_STEPS !== "undefined";
    function runView(run, t) { if (!HAS_RUNS) return null; try { return RUN_STEPS.view(run, t); } catch (e) { return null; } }
    // the run at work at this station at S.t (the most urgent: one with a failed agent, else the latest started), how many
    // other jobs run here too, and the last run that finished here (for an idle bank's footnote)
    function bankRun(key) {
      S.runAt = S.runAt || {};
      if (S.runAt[key]) return S.runAt[key];
      var live = [], last = null;
      JOBS.forEach(function (j) {
        arr(j.runs).forEach(function (run) {
          if (run.station !== key) return;
          var v = runView(run, S.t); if (!v) return;
          if (v.status === "running") { if ((S.byStage[key] || []).some(function (r) { return r.j === j; })) live.push({ j: j, v: v }); }
          else if (!last || P(v.ended_at) > P(last.v.ended_at)) last = { j: j, v: v };
        });
      });
      var bad = function (x) { return x.v.steps.some(function (st) { return st.roles.some(function (r) { return r.failed; }); }) ? 1 : 0; };
      live.sort(function (a, b) { return bad(b) - bad(a) || P(b.v.started_at) - P(a.v.started_at); });
      return (S.runAt[key] = { key: key, live: live[0] || null, more: live.slice(1), last: last });
    }
    var STEP_ROLE = { "intent-mapper": ["mapper", "mappers"], researcher: ["researcher", "researchers"], verifier: ["verifier", "verifiers"], "intent-analyst": ["analyst", "analysts"], judge: ["judge", "judges"],
      "god-eye": ["God Eye", "God Eye"], "contract-editor": ["contract editor", "contract editor"], "option-generator": ["option", "options"], "threat-modeler": ["threat model", "threat models"], architect: ["architect", "architect"], planner: ["planner", "planner"],
      slicer: ["slicer", "slicer"], builder: ["builder", "builders"], tester: ["tester", "testers"], integrator: ["integrator", "integrator"], "finding-verifier": ["verifier", "verifiers"], "lesson-writer": ["lesson writer", "lesson writer"] };
    function stepRole(role, n, key) {
      if (role === "researcher" && key === "intent") return n === 1 ? "scout" : "scouts";
      if (ROLE_LANE[role]) return ROLE_LANE[role] + " lane";
      var w = STEP_ROLE[role]; return w ? w[n === 1 ? 0 : 1] : agentLabel(role);
    }
    // who ran in a step: "analysts ×4 · 1 failed" (the bank), "analysts ×4 · 1 at work · 1 failed · 1 retry" (the section view),
    // "×4 ✕1" when even the short form does not fit a bank
    function rolesText(st, key, mode) {
      if (!st.roles.length) return st.planned && st.planned.length && st.state === "pending" ? st.planned.map(function (r) { return stepRole(r, 1, key); }).join(", ") : "";
      return st.roles.map(function (r) {
        if (mode === "terse") return "×" + r.total + (r.failed ? " ✕" + r.failed : "");
        var bits = [stepRole(r.role, r.total, key) + (r.total > 1 ? " ×" + r.total : "")];
        if (mode === "full" && r.running && r.total > 1) bits.push(r.running + " at work");
        if (r.failed) bits.push(r.failed + " failed");
        if (mode === "full" && r.retries) bits.push(plural(r.retries, "retry").replace("retrys", "retries"));
        return bits.join(" · ");
      }).join(mode === "terse" ? " " : ", ");
    }
    function stepLabel(st) { return st.label + (st.state === "running" ? " · " + fD(S.t - P(st.started_at)) : ""); }
    var STEP_GLYPH = { done: "✓", running: "●", pending: "○", skipped: "–", failed: "✕" };
    function runHead(v, j) {
      var bits = [];
      if (v.round) bits.push("round " + v.round); else if (v.visit > 1) bits.push("run " + v.visit);
      if (v.at) bits.push("step " + v.at + " of " + v.of);
      bits.push(fD(S.t - P(v.started_at)));
      return bits.join(" · ");
    }
    // the rows a bank draws for its run: the job line, the steps (the earliest done ones folded when there are many), what comes next
    var MAX_STEP_ROWS = 8;
    function runRows(lr, SW) {
      var v = lr.live.v, steps = v.steps.slice(), out = [], key = lr.key;
      out.push({ kind: "job" });
      var fold = 0;
      while (steps.length > MAX_STEP_ROWS && (steps[0].state === "done" || steps[0].state === "skipped")) { steps.shift(); fold++; }
      if (fold) out.push({ kind: "fold", n: fold });
      steps.forEach(function (st) {
        out.push({ kind: "step", st: st });
        // the step at work names who is at work on a line of its own when the two do not fit on one
        if (st.state === "running" && st.roles.length && measure(stepLabel(st), "t-agent", 13, 700) + measure(rolesText(st, key, "bank"), "t2", 13) + 40 > SW) st.roles.forEach(function (r) { out.push({ kind: "who", st: st, r: r }); }); // one line per role, so none is cut short
      });
      out.push({ kind: lr.more.length ? "more" : "next" });
      return out;
    }
    function drawRun(g, s, x, SW, BY, lr) {
      var v = lr.live.v, j = lr.live.j, rows = runRows(lr, SW), key = s.key, split = {};
      rows.forEach(function (row) { if (row.kind === "who") split[row.st.i] = 1; });
      rows.forEach(function (row, k) {
        var y = BY + 40 + k * 21 + 4.5;
        if (row.kind === "job") {
          var head = runHead(v, j), hw = Math.min(measure(head, "t-agent", 13, 600), SW * .62);
          kids(g, [Z("g", { "class": "mk", "data-open": j.id, tabindex: 0, role: "button", "aria-label": "Open " + j.slug + ": " + head },
            Z("title", null, j.slug + " — " + (v.workflow || "") + (v.config ? " " + v.config : "") + " · " + head),
            tx(x + 8, y, "▸ " + j.slug, { "font-size": 13, "class": "t-agent", "font-weight": 700, "data-fit": SW - 24 - hw }),
            tx(x + SW - 8, y, head, { "text-anchor": "end", "font-size": 13, "class": "t-agent", "font-weight": 600, "data-fit": SW * .62 }))]);
          return;
        }
        if (row.kind === "who") {
          var r = row.r, who = stepRole(r.role, r.total, key) + ": " + [r.running ? r.running + " at work" : "", r.ok ? r.ok + " done" : "", r.failed ? r.failed + " failed" : ""].filter(Boolean).join(" · ");
          kids(g, [tx(x + 24, y, "▸ " + who, { "font-size": 13, "class": r.failed ? "t-fail" : "t-agent", "font-weight": 600, "data-fit": SW - 32 })]);
          return;
        }
        if (row.kind === "fold") { kids(g, [tx(x + 8, y, "✓ " + plural(row.n, "earlier step"), { "font-size": 13, "class": "t3" })]); return; }
        if (row.kind === "next") {
          var nx = v.next ? "○ → " + v.next : "";
          if (nx) kids(g, [tx(x + 8, y, nx, { "font-size": 13, "class": "t3", "data-fit": SW - 16 })]);
          return;
        }
        if (row.kind === "more") {
          var others = lr.more.map(function (m) { return m.j.slug + (m.v.at ? " (step " + m.v.at + "/" + m.v.of + ")" : ""); }).join(", ");
          kids(g, [Z("g", { "class": "mk", "data-more": key, tabindex: 0, role: "button", "aria-label": plural(lr.more.length, "more job") + " at work here: " + others },
            Z("title", null, "also at work here: " + others), tx(x + 8, y, "+" + plural(lr.more.length, "more job") + " at work · " + others, { "font-size": 13, "class": "t-agent", "font-weight": 600, "data-fit": SW - 16 }))]);
          return;
        }
        var st = row.st, gl = STEP_GLYPH[st.state] || "·", failed = st.roles.some(function (r) { return r.failed; });
        var cls = st.state === "running" ? "t-agent" : st.state === "failed" ? "t-fail" : st.state === "done" ? "t2" : "t3";
        var label = stepLabel(st);
        var rt = split[st.i] && st.state === "running" ? "" : rolesText(st, key, "bank"), rw = rt ? measure(rt, "t2", 13) : 0;
        if (rt && rw > SW * .55) { rt = rolesText(st, key, "terse"); rw = measure(rt, "t2", 13); }
        var tip = gl + " " + st.label + " — " + (st.state === "running" ? "at work for " + fD(S.t - P(st.started_at)) : st.state === "pending" ? "not yet" : st.state) + (st.roles.length ? " · " + st.roles.map(function (r) { return stepRole(r.role, r.total, key) + ": " + r.total + " run" + (r.total === 1 ? "" : "s") + (r.running ? ", " + r.running + " at work" : "") + (r.ok ? ", " + r.ok + " ok" : "") + (r.failed ? ", " + r.failed + " failed" : "") + (r.retries ? ", " + r.retries + " retr" + (r.retries === 1 ? "y" : "ies") : ""); }).join("; ") : "") + (st.text ? " · “" + st.text + "”" : "");
        var rowG = Z("g", { "class": "steprow st-" + st.state }, Z("title", null, tip),
          st.state === "running" ? Z("circle", { cx: x + 12.5, cy: y - 4.5, r: 5.5, "class": "lamp-ring pulse" }) : null,
          tx(x + 8, y, gl, { "font-size": 13, "class": failed && st.state === "done" ? "t-fail" : st.state === "done" ? "t-ok" : cls, "font-weight": 700 }),
          tx(x + 24, y, label, { "font-size": 13, "class": cls, "font-weight": st.state === "running" ? 700 : 400, "data-fit": SW - 24 - 8 - (rt ? rw + 10 : 0) }),
          rt ? tx(x + SW - 8, y, rt, { "text-anchor": "end", "font-size": 13, "class": failed ? "t-fail" : st.state === "running" ? "t-agent" : st.state === "pending" || st.state === "skipped" ? "t3" : "t2", "font-weight": failed || st.state === "running" ? 600 : 400 }) : null);
        kids(g, [rowG]);
      });
    }
    // an idle bank's footnote, only where its row already leaves a line free: how the last run here ended, and when
    function lastRunLine(lr) {
      var v = lr.last.v, ok = v.status === "done", bad = v.steps.reduce(function (n, st) { return n + st.roles.reduce(function (m, r) { return m + r.failed; }, 0); }, 0);
      return "last run " + (ok ? "✓" : "✕ " + (v.error ? "stopped" : "failed")) + (bad ? " (" + plural(bad, "agent") + " failed)" : "") + " · " + fD(S.t - P(v.ended_at)) + " ago · " + lr.last.j.slug;
    }
    // what one agent is doing, in plain words: job, task (builders and testers), how long
    function doing(role, j, since) {
      var bits = [j.slug];
      if (role === "builder" || role === "tester") {
        var tk = j.tasks.filter(function (k) { var st = taskStatusAt(j, k, S.t); return st !== "passing" && st !== "merged"; })[0];
        if (tk) bits.push(tk.id);
      }
      bits.push(fD(S.t - since));
      return bits.join(" · ");
    }
    function bankNode(s, i, recs, ag) {
      var c = L.cell[i], rw = L.row[c.r], x = c.x, SW = c.w, BY = rw.BY, BH = rw.BH;
      // a run at work here counts its own agents too (a replay between the agent lines still reads "at work")
      var lr = bankRun(s.key);
      if (lr.live) ag = Math.max(ag, lr.live.v.steps.reduce(function (n, st) { return n + st.roles.reduce(function (m, r) { return m + r.running; }, 0); }, 0));
      var bk0 = BANKS[s.key] || { name: s.label, members: [] }, g = Z("g", { "class": "bank" + (ag ? " active" : "") });
      var bk = { name: s.key === "ship" && bankMembers("ship").length ? "Post-merge review" : bk0.name, members: bankMembers(s.key) };
      var groups = bankGroups(s.key), work = {};
      recs.forEach(function (r) { r.ag.forEach(function (a) { (work[a.agent] = work[a.agent] || []).push({ slug: r.j.slug, j: r.j, since: a.since }); }); });
      kids(g, [Z("line", { x1: x + SW / 2, y1: rw.SY + rw.SH, x2: x + SW / 2, y2: BY, "class": ag ? "ln-agent" : "ln2", "stroke-dasharray": "2 2" }), Z("circle", { cx: x + SW / 2, cy: rw.SY + rw.SH, r: 2.5, fill: ag ? "var(--agent)" : "var(--ink)" }),
        boxText(x, BY, SW, BH, { "class": "paper2", stroke: ag ? "var(--agent)" : "var(--ink-2)", "stroke-width": ag ? 1.6 : 1.1 })]);
      // the bank's name, and how many of its agents are at work
      // idle, but not forgotten: a job here waits on your answers (Q), so the bank waits on you
      var waitsOnYou = !ag && recs.some(function (r) { return r.g === "Q"; });
      var cnt = bk.members.length ? (ag ? Math.min(ag, bk.members.length) + " of " + bk.members.length + " at work" : waitsOnYou ? "waiting on you" : "idle") : lr.live ? (ag ? ag + " at work" : "running") : "", cw = cnt ? measure(cnt, "t2", 13, 600) + 18 : 0;
      if (ag && measure(bk.name, "t-disp tight", 13, 700) + cw + 16 > SW) { cnt = Math.min(ag, bk.members.length) + " of " + bk.members.length; cw = measure(cnt, "t2", 13, 600) + 18; }
      kids(g, [tx(x + 8, BY + 19, bk.name, { "font-size": 13, "class": "t-disp tight", "font-weight": 700, "data-fit": SW - 14 - cw })]);
      if (cnt) kids(g, [tx(x + SW - 8, BY + 19, cnt, { "text-anchor": "end", "font-size": 13, "class": ag ? "t-agent" : waitsOnYou ? "t-hl" : "t3", "font-weight": 600 })]);
      if (lr.live) { drawRun(g, s, x, SW, BY, lr); groups = []; }
      var ry = 0;
      groups.forEach(function (gr) {
        var cy = BY + 40 + ry * 21, jobs = work[gr.role] || [], lit = Math.min(gr.n, jobs.length), lx = x + 13;
        var row = Z("g", { "class": "lamprow" + (lit ? " on" : "") }, Z("title", null, gr.name + (gr.n > 1 ? " ×" + gr.n : "") + (gr.role === "god-eye" ? " (" + wd("godEyeSub") + ")" : "") + (jobs.length ? " — at work on " + uniq(jobs.map(function (j) { return j.slug + " (" + fD(S.t - j.since) + ")"; })).join(", ") : " — idle")));
        for (var n = 0; n < gr.n; n++) kids(row, [n < lit ? Z("circle", { cx: lx + n * 14, cy: cy, r: 5.5, "class": "lamp-ring pulse" }) : null, Z("circle", { cx: lx + n * 14, cy: cy, r: 5.5, "class": "lamp" + (n < lit ? " on" : "") })]);
        var tx0 = lx + gr.n * 14 + 4;
        var nmx = gr.name + (gr.n > 1 && !lit ? " ×" + gr.n : "");
        if (measure(nmx, "t2", 13) > x + SW - 8 - tx0) nmx = gr.name;   // the lamps already show how many
        kids(row, [tx(tx0, cy + 4.5, nmx, { "font-size": 13, "class": lit ? "t-agent" : "t2", "font-weight": lit ? 700 : 400, "data-fit": x + SW - 8 - tx0 })]);
        // a lit lamp names its job on the line below it
        if (jobs.length) { ry++; kids(row, [tx(x + 13, cy + 25.5, "▸ " + doing(gr.role, jobs[0].j, jobs[0].since) + (jobs.length > 1 ? " +" + (jobs.length - 1) : ""), { "font-size": 13, "class": "t-agent", "font-weight": 600, "data-fit": SW - 20 })]); }
        kids(g, [row]);
        ry++;
      });
      if (!bk.members.length && !lr.live) {
        var bl = s.key === "ship" ? ["CI re-verifies the merge;", "only you merge it (H4)"] : s.key === "review" ? ["No review lanes", "in these recipes"] : ["A CLI check:", "no agent is needed"];
        kids(g, [tx(x + 8, BY + 42, bl[0], { "font-size": 13, "class": "t2", "data-fit": SW - 14 }), tx(x + 8, BY + 61, bl[1], { "font-size": 13, "class": "t2", "data-fit": SW - 14 })]);
      }
      if (!lr.live && lr.last && bk.members.length && BY + 40 + ry * 21 + 4.5 <= BY + BH - 8 - (s.key === "done" && S.lessonsWaiting.length ? 24 : 0)) {
        var ll = lastRunLine(lr);
        kids(g, [Z("g", { "class": "mk lastrun", "data-open": lr.last.j.id, tabindex: 0, role: "button", "aria-label": ll + ": open the job" }, Z("title", null, ll + " — open the job for its steps"),
          tx(x + 8, BY + 40 + ry * 21 + 4.5, ll, { "font-size": 13, "class": lr.last.v.status === "done" ? "t3" : "t-fail", "data-fit": SW - 16 }))]);
      }
      var lw = s.key === "done" ? S.lessonsWaiting.length : 0;
      if (lw) kids(g, [Z("g", { "class": "mk lesson-tag", "data-notes": "lessons", tabindex: 0, role: "button", "aria-label": plural(lw, "lesson") + " wait on you: open the notes" },
        Z("title", null, plural(lw, "lesson") + " to accept or reject"), boxText(x + 4, BY + BH - 24, SW - 8, 20, { "class": "hl-fill", stroke: "var(--ink)", "stroke-width": 1 }),
        tx(x + 10, BY + BH - 9.5, plural(lw, "lesson") + " to accept →", { "font-size": 13, "class": "on-hl", "font-weight": 700, "data-fit": SW - 20 }))]);
      return g;
    }

    function sideTracks() {
      var g = Z("g"), bx = L.R.x + 8, lastB = L.side[L.sideOrder[L.sideOrder.length - 1]];
      var ends = L.sideOrder.map(function (k) { return L.side[k].y + 18; }).concat(L.sideEmpty.map(function (k) { return L.side["~" + k].y + 16; }));
      kids(g, [tx(bx - 4, L.F0 + 2, "Side tracks: work can leave the line from any station", { "font-size": 13, "class": "t-disp side-t", "font-weight": 600, "data-fit": L.R.w })]);
      kids(g, [Z("path", { d: "M" + bx + " " + (L.F0 + 8) + " V" + Math.max.apply(null, ends.concat([lastB.y + 18])), "class": "side-ln" })]);
      ends.forEach(function (y) { kids(g, [Z("line", { x1: bx, y1: y, x2: L.sideX - 2, y2: y, "class": "side-ln", "marker-end": "url(#bp-arw-pk)" })]); });
      L.sideOrder.forEach(function (k) {
        var b = L.side[k], sd = SIDES.filter(function (s) { return s.key === k; })[0], recs = S.byStage[k], gt = recs.some(function (r) { return r.g; }), stk = L.st[k];
        kids(g, [boxText(b.x, b.y, b.w, b.h, { "class": "paperfill", stroke: gt ? "var(--hl-line)" : "var(--ink)", "stroke-width": gt ? 2.2 : 1.3 }),
          tx(b.x + 10, b.y + 21, sd.label, { "font-size": 16, "class": "t-disp tight", "font-weight": 700 }),
          tx(b.x + 18 + measure(sd.label, "t-disp tight", 16, 700), b.y + 21, SIDE_SUB[k] || "", { "font-size": 13, "class": "t2", "data-fit": b.w - 60 - measure(sd.label, "t-disp tight", 16, 700) }),
          Z("circle", { cx: b.x + b.w - 16, cy: b.y + 16, r: 10, "class": "paperfill", stroke: "var(--ink)", "stroke-width": 1.2 }, Z("title", null, plural(recs.length, "job") + " here")),
          tx(b.x + b.w - 16, b.y + 20.5, String(recs.length), { "text-anchor": "middle", "font-size": 13, "class": "t-mono", "font-weight": 600 })]);
        if (stk.more) { var p = slotPos(k, stk.moreDy); kids(g, [Z("g", { "class": "mk", "data-more": k, tabindex: 0, role: "button", "aria-label": stk.more + " more jobs at " + sd.label + ": open the matrix" }, boxText(p.x, p.y, stk.w, 30, { "class": "paperfill", stroke: "var(--ink)", "stroke-dasharray": "3 2" }), tx(p.x + stk.w / 2, p.y + 19, "+" + stk.more + " more", { "text-anchor": "middle", "font-size": 13, "class": "t-mono" }))]); }
      });
      // the empty side tracks: a light outline with their name, not a box of nothing
      L.sideEmpty.forEach(function (k) {
        var b = L.side["~" + k], sd = SIDES.filter(function (s) { return s.key === k; })[0];
        kids(g, [boxText(b.x, b.y, b.w, b.h, { fill: "none", "class": "ln3", "stroke-dasharray": "4 3" }),
          Z("text", { x: b.x + 10, y: b.y + 21, "font-size": 13 }, ts(sd.label, { "class": "t-disp t2", "font-weight": 700 }), ts("   none", { "class": "t3" }))]);
      });
      return g;
    }
    function strip(x, y, w) {
      var g = Z("g", null, boxText(x, y, w, 32, { "class": "paperfill", stroke: "var(--ink-3)", "stroke-width": 1, "stroke-dasharray": "4 3" }));
      kids(g, [Z("text", { x: x + 10, y: y + 21, "font-size": 13, "data-fit": w - 20 }, ts("Side tracks", { "class": "t-disp", "font-weight": 700 }), ts("   none: nothing changing, parked or stopped", { "class": "t2" }))]);
      return g;
    }

    function detailBox(x, y, w, h, letter, title, sub, live, on) {
      var lw = live ? measure(live, "t-disp", 13, 700) + 30 : 0;
      return [boxText(x, y, w, h, { "class": "paperfill", stroke: on ? "var(--agent)" : "var(--ink)", "stroke-width": on ? 1.8 : 1.3 }),
        live ? boxText(x + 1, y + 1, w - 2, 32, { "class": on ? "st-live" : "paper2" }) : null,
        live ? Z("g", null, on ? Z("circle", { cx: x + w - lw + 6, cy: y + 17, r: 4, "class": "lamp-ring pulse" }) : null, Z("circle", { cx: x + w - lw + 6, cy: y + 17, r: 4, "class": "lamp" + (on ? " on" : "") }),
          tx(x + w - 10, y + 21.5, live, { "text-anchor": "end", "font-size": 13, "class": "t-disp " + (on ? "t-agent" : "t2"), "font-weight": 700 })) : null,
        Z("circle", { cx: x + 17, cy: y + 17, r: 10, "class": "paperfill", stroke: "var(--ink)", "stroke-width": 1.3 }),
        tx(x + 17, y + 21.5, letter, { "text-anchor": "middle", "font-size": 13, "class": "t-disp", "font-weight": 700 }),
        tx(x + 34, y + 22.5, "Detail " + letter + " · " + title, { "font-size": 16, "class": "t-disp", "font-weight": 700, "data-fit": w - 46 - lw }),
        sub ? tx(x + 12, y + 52, sub, { "font-size": 13, "class": "t2", "data-fit": w - 24 }) : null];
    }
    // one review lane of a job at time t, the same in detail B and the section view: the latest result, and whether its
    // reviewer is at work now (a new round runs while the last result still stands). A serious finding left unverified
    // (no verifier result, or "unverifiable") blocks its lane.
    function laneState(j, ln, t, ag) {
      var rv = j.reviews.filter(function (v) { return v.lane === ln && !v.post_merge && P(v.at) <= t; }).pop() || null;
      var inReview = S2STAGE[stateAt(j, t)] === "review";
      var working = inReview && (ag || activeAgents(j, t)).some(function (a) { return a.agent === LANE_ROLE[ln]; });
      var running = working && (!rv || P(rv.at) < enteredAt(j, t));
      return { rv: running ? null : rv, prev: rv, running: running, req: j.required_lanes.indexOf(ln) >= 0, unverified: rv ? rv.unverified || 0 : 0 };
    }
    function laneWords(x) {
      var rv = x.rv;
      if (x.running) return "reviewer at work" + (x.prev ? " · last round " + verdictWord(x.prev) : "");
      if (!rv) return x.req ? "required · not run yet" : "optional";
      var fs = rv.findings;
      return verdictWord(rv) + " · " + plural(fs.length, "finding") + (fs.length ? " (" + fs.map(function (f) { return f.severity; }).join(", ") + ")" : "") + (x.unverified ? " · " + x.unverified + " unverified, blocking" : "");
    }
    function verdictWord(rv) { return rv.verdict === "pass" ? "pass" : rv.verdict === "missing" ? "did not report" : rv.unverified && !rv.findings.some(function (f) { return f.status === "confirmed"; }) ? "blocked: unverified" : "changes asked"; }
    // "round 2 of 3", from the job's last review result and its policy's max_review_rounds
    function roundText(j, n) {
      var max = j.max_review_rounds;
      if (!max) return "round " + n;
      return n > max ? "round " + n + " · past the limit of " + max : "round " + n + " of " + max;
    }
    function lastBuild(t) { return S.jobs.filter(function (r) { var lb = leftBuildAt(r.j); return lb && lb <= t; }).sort(function (a, b) { return leftBuildAt(b.j) - leftBuildAt(a.j); })[0]; }
    function lastVerify(t) { var last = null; JOBS.forEach(function (j) { j.history.forEach(function (hh) { if (hh.from === "verifying" && P(hh.at) <= t && (!last || P(hh.at) > last.at)) last = { at: P(hh.at), j: j, ok: !isRework(hh.from, hh.to) }; }); }); return last; }
    function detailA(t, x, y, w, h) {
      var g = Z("g"), recs = (S.byStage.build || []).filter(function (r) { return !r.done; });
      var r = recs[0], j = r.j, waves = wavesOf(j.tasks);
      var passing = j.tasks.filter(function (tk) { return taskStatusAt(j, tk, t) === "passing"; }).length;
      var cw = -1; waves.some(function (wv, i) { if (wv.some(function (tk) { return taskStatusAt(j, tk, t) !== "passing"; })) { cw = i; return true; } return false; }); if (cw < 0) cw = waves.length - 1;
      kids(g, [detailBox(x, y, w, h, "A", "Build", j.slug + " · wave " + (cw + 1) + " of " + Math.max(1, waves.length) + (recs.length > 1 ? " · " + (recs.length - 1) + " more job" + (recs.length > 2 ? "s" : "") + " in Build" : ""), r.ag.length ? "building now" : "in build", r.ag.length > 0)]);
      var TX = x + 82, perRow = Math.max(2, Math.min(10, Math.floor((w - 82 - 190) / 48)));
      // two rows fit: the wave at work and the next one (the last two once the last wave is at work)
      var w0 = Math.max(0, Math.min(cw, waves.length - 2));
      waves.slice(w0, w0 + 2).forEach(function (wv, k0) {
        var wi = w0 + k0, yy = y + 76 + k0 * 44;
        kids(g, [tx(x + 12, yy + 20, "Wave " + (wi + 1), { "font-size": 13, "class": "t-disp" + (wi === cw ? "" : " t2"), "font-weight": 700 })]);
        var shownT = wv.slice(0, perRow);
        shownT.forEach(function (tk, k) {
          var s = taskStatusAt(j, tk, t), cls = s === "passing" || s === "merged" ? "sq-pass" : s === "failing" ? "sq-fail" : s === "building" ? "sq-run" : "sq-todo", sx = TX + k * 48;
          kids(g, [Z("g", null, Z("title", null, tk.id + " " + tk.objective + " — " + s + ", run " + tk.runs), s === "building" ? boxText(sx, yy, 36, 30, { "class": "lamp-ring breathe" }) : null,
            boxText(sx, yy, 36, 30, { "class": cls }), tx(sx + 18, yy + 19.5, tk.id, { "text-anchor": "middle", "font-size": 13, "class": "t-mono" + (s === "failing" ? " t-fail" : s === "passing" ? " t-ok" : ""), "font-weight": 600 }))]);
        });
        var fl = wv.filter(function (tk) { return taskStatusAt(j, tk, t) === "failing"; })[0], lx = TX + shownT.length * 48 + 8;
        if (fl && lx < x + w - 90) kids(g, [tx(lx, yy + 12, "✗ failing · run " + fl.runs, { "font-size": 13, "class": "t-fail", "font-weight": 600 }), tx(lx, yy + 29, fl.objective, { "font-size": 13, "class": "t2", "data-fit": x + w - 14 - lx })]);
        else if (wv.length > shownT.length) kids(g, [tx(lx, yy + 20, "+" + (wv.length - shownT.length) + " more", { "font-size": 13, "class": "t-mono t2" })]);
      });
      if (!j.tasks.length) kids(g, [tx(x + w / 2, y + 104, "no plan yet", { "text-anchor": "middle", "font-size": 13, "class": "t2" })]);
      var pt = passing + " / " + j.tasks.length;
      kids(g, [tx(x + 12, y + h - 15, pt, { "font-size": 22, "class": "t-disp", "font-weight": 700 }),
        tx(x + 24 + measure(pt, "t-disp", 22, 700), y + h - 16, "tasks passing · " + plural(r.ag.length, "agent") + " at work" + (w0 > 0 ? " · " + (w0 === 1 ? "wave 1" : "waves 1–" + w0) + " done" : "") + (waves.length > w0 + 2 ? " · " + (waves.length - w0 - 2 === 1 ? "wave " + waves.length : "waves " + (w0 + 3) + "–" + waves.length) + " still to come" : ""), { "font-size": 13, "class": "t2", "data-fit": w - 90 })]);
      if (r.failing) kids(g, [Z("path", { d: cloudPath(TX - 8, y + 68, Math.min(w - (TX - x) - 4, 16 + perRow * 48 + 190), 46), "class": "cloud" })]);
      return g;
    }
    function detailB(t, x, y, w, h) {
      var g = Z("g"), recs = (S.byStage.review || []).filter(function (r) { return !r.done; });
      // the round: the last one recorded, plus the one running now if its result is not in yet
      var r = recs[0], j = r.j, recorded = j.reviews.filter(function (v) { return !v.post_merge && v.round && P(v.at) <= t; }).reduce(function (m, v) { return Math.max(m, v.round); }, 0);
      var runningNew = r.ag.length > 0 && !j.reviews.some(function (v) { return P(v.at) >= enteredAt(j, t) && P(v.at) <= t; });
      var rounds = Math.max(1, recorded + (runningNew ? 1 : 0));
      kids(g, [detailBox(x, y, w, h, "B", "Review", j.slug + " · " + roundText(j, rounds), r.ag.length ? "reviewing now" : "in review", r.ag.length > 0)]);
      var lanes = uniq(j.required_lanes.concat(j.reviews.map(function (v) { return v.lane; }))).slice(0, 4);
      var LX = x + 12 + Math.max.apply(null, [90].concat(lanes.map(function (ln) { return measure(wd("lane", ln), "t-disp", 13, 700); }))) + 14;
      lanes.forEach(function (ln, k) {
        var yy = y + 64 + k * 30, ls = laneState(j, ln, t, r.ag), rv = ls.rv, w8 = ls.running;
        var cls = rv ? (rv.verdict === "pass" ? "sq-pass" : "sq-fail") : w8 ? "sq-run" : "sq-todo";
        kids(g, [tx(x + 12, yy + 16, wd("lane", ln), { "font-size": 13, "class": "t-disp", "font-weight": 700 }),
          w8 ? boxText(LX, yy, 22, 22, { "class": "lamp-ring breathe" }) : null, boxText(LX, yy, 22, 22, { "class": cls }),
          tx(LX + 11, yy + 16, rv ? (rv.verdict === "pass" ? "✓" : "✗") : w8 ? "…" : "", { "text-anchor": "middle", "font-size": 13, "class": "t-mono" + (rv ? (rv.verdict === "pass" ? " t-ok" : " t-fail") : ""), "font-weight": 700 }),
          tx(LX + 32, yy + 16, laneWords(ls), { "font-size": 13, "class": rv ? (ls.unverified ? "t-fail" : null) : w8 ? "t-agent" : "t2", "data-fit": x + w - LX - 44 })]);
      });
      var gy = y + h - 24;
      if (r.gf) kids(g, [Z("path", { d: cloudPath(x + 6, gy - 16, w - 12, 30), "class": "cloud" }), tx(x + 16, gy + 4, "✗ Failing check: " + String(j.gate.problems[0] || "failing").replace(" (required for medium risk)", ""), { "font-size": 13, "class": "t-fail", "font-weight": 600, "data-fit": w - 32 })]);
      else kids(g, [tx(x + 12, gy + 4, "The review gate decides once every required review reports", { "font-size": 13, "class": "t2", "data-fit": w - 24 })]);
      return g;
    }
    function detailC(t, x, y, w, rd) {
      var nr = Math.max(1, Math.min(3, rd.length)), h = 92 + 24 * nr + 26, g = Z("g"), ver = S.byStage.verify || [], vl;
      var vAg = ver.some(function (r) { return r.ag.length; }) || rd.some(function (r) { return r.ag.length; });
      kids(g, [detailBox(x, y, w, h, "C", "Checks and rounds", "", ver.length ? "checking now" : "rounds open", vAg)]);
      if (ver.length) vl = ver[0].j.slug + ": every check re-runs on the combined code · " + fD(t - ver[0].since);
      else { var last = lastVerify(t); vl = last ? "last: " + last.j.slug + " " + (last.ok ? "passed" : "failed, " + wd("revise")) + " · " + fT(last.at) : "no check run yet"; }
      var LX = x + 100;
      kids(g, [tx(x + 12, y + 56, "Checks", { "font-size": 13, "class": "t-disp", "font-weight": 700 }), tx(LX, y + 56, vl, { "font-size": 13, "data-fit": w - (LX - x) - 12 })]);
      kids(g, [tx(x + 12, y + 84, "Rounds", { "font-size": 13, "class": "t-disp", "font-weight": 700 })]);
      if (!rd.length) kids(g, [tx(LX, y + 84, "no contract, design or plan rounds open", { "font-size": 13, "class": "t2" })]);
      rd.slice(0, 3).forEach(function (r, i) {
        var n = r.j.history.filter(function (hh) { return S2STAGE[hh.to] === r.st && !GATE[hh.to] && P(hh.at) <= t; }).length || 1;
        var more = i === 2 && rd.length > 3 ? " · " + (rd.length - 3) + " more" : "";
        kids(g, [Z("text", { x: LX, y: y + 84 + i * 24, "font-size": 13, "data-fit": w - (LX - x) - 12 }, ts(r.j.slug, { "class": "t-cond", "font-weight": 700 }), ts(" · " + stageLabel(r.st).toLowerCase() + " round " + n, { "class": "t2" }),
          r.g ? ts(" · waiting for you: " + gv(r.g).toLowerCase(), { "class": "cl-on", "font-weight": 600 }) : null, more ? ts(more, { "class": "t2" }) : null)]);
      });
      kids(g, [tx(x + 12, y + h - 12, "Proof is tied to the exact code: stale proof is run again before Ship", { "font-size": 13, "class": "t3", "data-fit": w - 24 })]);
      return { g: g, h: h };
    }
    // the details with nothing in progress: one line each, in one quiet box
    function idleDetails(t, x, y, w, letters) {
      var rows = [];
      if (letters.indexOf("A") >= 0) { var lb = lastBuild(t); rows.push(["A", "Build", "idle", lb ? "last build: " + lb.j.slug + ", left " + fT(leftBuildAt(lb.j)) : "nothing built yet"]); }
      if (letters.indexOf("B") >= 0) rows.push(["B", "Review", "idle", "reviewers start when a job reaches Review"]);
      if (letters.indexOf("C") >= 0) {
        var lv = lastVerify(t);
        rows.push(["C", "Checks", "idle", lv ? "last: " + lv.j.slug + " " + (lv.ok ? "passed" : "failed, " + wd("revise")) + " · " + fT(lv.at) : "no check run yet"]);
        rows.push(["", "Rounds", "none", "no contract, design or plan rounds open"]);
      }
      var h = 36 + rows.length * 28 + 6, g = Z("g", null, boxText(x, y, w, h, { "class": "paperfill", stroke: "var(--ink-2)", "stroke-width": 1.1 }),
        tx(x + 12, y + 22, "Details " + letters.join(" · "), { "font-size": 15, "class": "t-disp", "font-weight": 700 }),
        tx(x + w - 12, y + 22, "nothing in progress", { "text-anchor": "end", "font-size": 13, "class": "t2" }),
        Z("line", { x1: x, y1: y + 32, x2: x + w, y2: y + 32, "class": "ln3" }));
      var lab = Math.max.apply(null, rows.map(function (r) { return measure(r[1], "t-disp", 13, 700); })) + 52;
      rows.forEach(function (r, i) {
        var yy = y + 36 + i * 28 + 19;
        if (r[0]) kids(g, [Z("circle", { cx: x + 20, cy: yy - 4.5, r: 9, "class": "paperfill", stroke: "var(--ink)", "stroke-width": 1.2 }), tx(x + 20, yy, r[0], { "text-anchor": "middle", "font-size": 13, "class": "t-disp", "font-weight": 700 })]);
        kids(g, [tx(x + 38, yy, r[1], { "font-size": 13, "class": "t-disp", "font-weight": 700 }),
          Z("text", { x: x + lab, y: yy, "font-size": 13, "data-fit": w - lab - 12 }, ts(r[2] + " · ", { "class": "t3" }), ts(r[3], { "class": "t2" }))]);
      });
      return { g: g, h: h };
    }
    function finishedPanel(t, x, y, w, fin, rows) {
      var h = 38 + rows * 42, g = Z("g", null, boxText(x, y, w, h, { "class": "paperfill", stroke: "var(--ink)", "stroke-width": 1.3 }),
        tx(x + 12, y + 23, "Recently finished", { "font-size": 16, "class": "t-disp", "font-weight": 700 }),
        tx(x + w - 12, y + 23, (rows < fin.length ? rows + " of " + fin.length : plural(fin.length, "job")) + " · newest first", { "text-anchor": "end", "font-size": 13, "class": "t2" }),
        Z("line", { x1: x, y1: y + 34, x2: x + w, y2: y + 34, "class": "ln3" }));
      fin.slice(0, rows).forEach(function (r, i) {
        var j = r.j, yy = y + 36 + i * 42, n = j.tasks.length, pass = j.tasks.filter(function (tk) { return taskStatusAt(j, tk, t) === "passing" || taskStatusAt(j, tk, t) === "merged"; }).length;
        var outcome = wd("state", r.s), when = fT(r.since);
        kids(g, [Z("g", { "class": "mk fin", "data-job": j.id, tabindex: 0, role: "button", "aria-label": j.slug + ", " + outcome + " " + when + ". Open section view." },
          boxText(x + 1, yy + 1, w - 2, 40, { "class": "finhit" }),
          i ? Z("line", { x1: x + 8, y1: yy, x2: x + w - 8, y2: yy, "class": "ln3", "stroke-dasharray": "1 3" }) : null,
          Z("g", { transform: "translate(" + (x + 19) + " " + (yy + 15) + ")" }, typeSym(j.type, 0, 0, 11)),
          tx(x + 33, yy + 20, j.slug, { "font-size": 15, "class": "t-cond", "font-weight": 700, "data-fit": w - 45 - measure(when, "t-mono", 13) - 12 }),
          tx(x + w - 12, yy + 20, when, { "text-anchor": "end", "font-size": 13, "class": "t-mono t2" }),
          Z("text", { x: x + 33, y: yy + 36, "font-size": 13, "data-fit": w - 45 }, STOPPED_STATES[r.s] ? ts("■ " + outcome, { "class": "t-fail" }) : ts("✓ " + outcome, { "class": "t-ok" }),
            ts(" · " + (TYPE_NAME[j.type] || j.type) + " · took " + fD(r.since - P(j.created_at)), { "class": "t2" }),
            n ? ts(" · " + pass + " of " + n + " tasks passing", { "class": pass < n ? "t-fail" : "t2" }) : null))]);
      });
      return g;
    }

    function markerNode(r, w, lines, h) {
      var j = r.j, cls = ["mk"];
      if (r.g && r.g !== "H4") cls.push("wait"); else if (!r.done && (r.failing || r.gf)) cls.push("fail"); else if (r.ag.length) cls.push("run");
      if (r.done || r.s === "merged") cls.push("done"); if (STOPPED_STATES[r.s]) cls.push("stop"); if (sel === j.id) cls.push("sel");
      var tag = epTag(j), ep = tag ? epOfJob(j) : null, off = tag ? ETAG_H : 0;
      if (filter && (j.slug + " " + j.id + " " + j.type + " " + r.s + " " + (tag || "")).toLowerCase().indexOf(filter) < 0) cls.push("dim");
      return Z("g", { "class": cls.join(" "), "data-job": j.id, tabindex: 0, role: "button", "aria-label": j.slug + ", " + (TYPE_NAME[j.type] || j.type) + ", " + j.risk + " risk, " + wd("state", r.s) + (tag ? ", slice " + tag : "") + ". Open section view." },
        Z("title", null, j.slug + " · " + (TYPE_NAME[j.type] || j.type) + " · " + j.risk + " risk · " + wd("state", r.s) + (D.meaning[r.s] ? " · " + D.meaning[r.s] : "")),
        Z("rect", { "class": "body", x: 0, y: 0, width: w, height: h, rx: 1.5 }),
        // a slice: tagged "S01 · epic", the tag opens that epic's assembly drawing (sheet 8)
        tag ? Z("g", ep ? { "class": "etag", "data-epic": ep.id, "data-epic-view": "eflow", tabindex: 0, role: "button", "aria-label": "Slice " + tag + ": open the epic assembly drawing" } : { "class": "etag" },
          Z("title", null, "slice " + tag + (ep ? " · open the epic assembly drawing (sheet 8)" : "")),
          Z("rect", { x: 2, y: 2, width: w - 4, height: ETAG_H - 3, rx: 1 }),
          tx(6, 13.5, tag, { "font-size": 12.5, "class": "t-mono etag-t", "font-weight": 600 })) : null,
        lines.map(function (ln, i) { return tx(5, off + 15 + i * 15, ln, { "font-size": 15, "class": "t-cond lbl" }); }),
        Z("rect", { x: 4, y: h - 12, width: 14, height: 9, fill: riskFill(j.risk), stroke: "var(--ink)", "stroke-width": .8, opacity: .9 }),
        Z("g", { transform: "translate(26 " + (h - 7.5) + ")" }, typeSym(j.type, 0, 0, 9)),
        Z("text", { x: 35, y: h - 3.5, "font-size": 13, "class": "t-cond meta2", "font-weight": 500 }, r.done ? (STOPPED_STATES[r.s] ? ts("■ ", { "class": "t-fail", "font-weight": 700 }) : ts("✓ ", { "class": "t-ok", "font-weight": 700 })) : null, fD(S.t - r.since) + (r.g && r.g !== "H4" ? " · " + r.g : "")),
        r.ag.length ? [Z("circle", { cx: w - 9, cy: h - 8, r: 4, fill: "var(--agent)", "class": "lampdot" }), Z("circle", { cx: w - 9, cy: h - 8, r: 4, "class": "lamp-ring pulse" })] : null);
    }
    function fitText(t, max) {
      if (!(max > 0)) return; var s = t.textContent, full = s, guard = 0, w0 = t.getComputedTextLength();
      if (w0 > max * 1.3 && s.length > 8) { s = s.slice(0, Math.max(4, Math.floor(s.length * max / w0))); t.textContent = s + "…"; }
      while (t.getComputedTextLength() > max && s.length > 3 && guard++ < 400) { s = s.slice(0, -1); t.textContent = s + "…"; } if (s !== full) { t.textContent = s.replace(/[-\s·]+$/, "") + "…"; if (!t.querySelector("title")) t.appendChild(Z("title", null, full)); } }
    function fitLabels() {
      [].forEach.call(gMarkers.querySelectorAll(".bp-mk"), function (g) {
        var w = +g.querySelector(".bp-body").getAttribute("width"), m = g.querySelector(".bp-meta2");
        [].forEach.call(g.querySelectorAll(".bp-lbl"), function (t) { fitText(t, w - 8); });
        [].forEach.call(g.querySelectorAll(".bp-etag-t"), function (t) { fitText(t, w - 10); });
        if (m) fitText(m, w - 35 - (g.querySelector(".bp-lampdot") ? 16 : 5));
      });
    }
    function renderMarkers() {
      if (!gMarkers || !L) return; var targets = {};
      ALLST.forEach(function (s) { var st = L.st[s.key]; if (!st) return; st.list.forEach(function (it) { targets[it.r.j.id] = { r: it.r, p: slotPos(s.key, it.dy), w: st.w, h: it.h, lines: it.lines, st: s.key }; }); });
      fill(gMarkers, Object.keys(targets).map(function (id) { var v = targets[id]; return markerNode(v.r, v.w, v.lines, v.h); }));
      var reduce = RM.matches || snapshotOn;
      [].forEach.call(gMarkers.querySelectorAll(".bp-mk"), function (el) {
        var id = el.getAttribute("data-job"), v = targets[id], prev = mk[id];
        if (!prev || reduce) { mk[id] = { x: v.p.x, y: v.p.y, tx: v.p.x, ty: v.p.y, st: v.st }; el.setAttribute("transform", "translate(" + v.p.x + " " + v.p.y + ")"); return; }
        if (prev.st === v.st || (Math.abs(prev.tx - v.p.x) < .5 && Math.abs(prev.ty - v.p.y) < .5)) { mk[id] = { x: v.p.x, y: v.p.y, tx: v.p.x, ty: v.p.y, st: v.st }; el.setAttribute("transform", "translate(" + v.p.x + " " + v.p.y + ")"); return; }
        var from = { x: prev.x, y: prev.y }, pts = route(prev.st, v.st, from, v.p);
        mk[id] = { x: from.x, y: from.y, tx: v.p.x, ty: v.p.y, st: v.st, anim: { pts: pts, t0: performance.now(), dur: Math.min(1600, 700 + pts.length * 160) } };
        // the path it travels, drawn as a fading trail along the line
        var tr = Z("path", { "class": "trail" + (SIDX[v.st] != null && SIDX[prev.st] != null && SIDX[v.st] < SIDX[prev.st] ? " back" : SIDX[v.st] == null ? " side" : ""), d: pts.map(function (q, n) { return (n ? "L" : "M") + (q.x + v.w / 2).toFixed(1) + " " + (q.y + 15).toFixed(1); }).join(" ") });
        gTrails.appendChild(tr); setTimeout(function () { if (tr.parentNode) tr.parentNode.removeChild(tr); }, 2600);
        el.setAttribute("transform", "translate(" + from.x + " " + from.y + ")");
      });
      Object.keys(mk).forEach(function (id) { if (!targets[id]) delete mk[id]; });
      fitLabels(); drawCallouts(targets); drawClouds(targets); tick();
    }
    // the way a marker travels: along its row's line, back along a return rail, down the return line to the next row,
    // or out to the side tracks
    function route(a, b, from, to) {
      var ia = SIDX[a], ib = SIDX[b];
      if (ia != null && ib != null) {
        var ra = L.cell[ia].r, rb = L.cell[ib].r, ly = function (r) { return L.row[r].PY - 15; };
        if (ra !== rb) { var rt = L.row[Math.max(ra, rb)].ret - 15; return [from, { x: from.x, y: rt }, { x: to.x, y: rt }, to]; }
        if (ib >= ia) return [from, { x: from.x, y: ly(ra) }, { x: to.x, y: ly(ra) }, to];
        var rail = RAILS.filter(function (r) { return r.from === a; })[0], ry = L.row[ra].SY - (rail ? rail.up : 20) - 15;
        return [from, { x: from.x, y: ry }, { x: to.x, y: ry }, to];
      }
      var sy = L.F0 - 18;
      return [from, { x: from.x, y: sy }, { x: to.x, y: sy }, to];
    }
    function tick() { if (raf) return; raf = requestAnimationFrame(step); }
    function step(now) {
      raf = null; if (!alive() || !gMarkers) return; var any = false;
      Object.keys(mk).forEach(function (id) {
        var m = mk[id]; if (!m.anim) return; var el = gMarkers.querySelector('.bp-mk[data-job="' + id.replace(/"/g, "") + '"]'), A = m.anim;
        var u = Math.min(1, (now - A.t0) / A.dur); u = u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
        var segs = [], Ln = 0; for (var i = 1; i < A.pts.length; i++) { var d = Math.hypot(A.pts[i].x - A.pts[i - 1].x, A.pts[i].y - A.pts[i - 1].y); segs.push(d); Ln += d; }
        var target = u * Ln, k = 0; while (k < segs.length - 1 && target > segs[k]) { target -= segs[k]; k++; }
        var f = segs[k] ? Math.min(1, target / segs[k]) : 1, p = { x: A.pts[k].x + (A.pts[k + 1].x - A.pts[k].x) * f, y: A.pts[k].y + (A.pts[k + 1].y - A.pts[k].y) * f };
        m.x = p.x; m.y = p.y; if (el) el.setAttribute("transform", "translate(" + p.x.toFixed(1) + " " + p.y.toFixed(1) + ")");
        if (u >= 1) m.anim = null; else any = true;
      });
      if (any) { drawCallouts(); tick(); }
    }
    // a small mono tag for an internal id (H1, P, …): the CLI uses these, so they stay visible, but second
    function idTag(x, y, id, on) {
      var w = measure(id, "t-mono", 12, 700) + 10;
      return { w: w, n: Z("g", null, boxText(x, y - 12, w, 16, { rx: 2, "class": on ? "idtag on" : "idtag" }), tx(x + 5, y, id, { "font-size": 12, "class": "t-mono idtag-t", "font-weight": 700 })) };
    }
    // the decisions that wait on you: a numbered balloon in the callout row above the station, a leader down to the job,
    // "Approve the contract" in words with its id as a tag, and the job's name under it
    function drawCallouts(targets) {
      if (targets) lastTargets = targets; if (!gCallouts || !L) return; var o = [];
      var main = S.gates.filter(function (r) { return SIDX[r.st] != null; }), side = S.gates.filter(function (r) { return SIDX[r.st] == null && L.side[r.st]; });
      var bs = main.map(function (r) { var m = mk[r.j.id] || {}; return { r: r, mx: (m.x || 0) + 10, my: (m.y || 0) }; }).sort(function (a, b) { return SIDX[a.r.st] - SIDX[b.r.st] || a.my - b.my; });
      var cur = {};
      bs.forEach(function (b) {
        var c = L.cell[SIDX[b.r.st]], gx = Math.max(16, c.x - SG / 2), tg = measure(b.r.g, "t-mono", 12, 700) + 16;
        b.c = c; b.gx = gx; b.by = L.row[c.r].SY - 54; b.l1 = gv(b.r.g);
        b.tw = Math.max(tg + measure(b.l1, "cl-txt", 14, 700), measure(b.r.j.slug, "t-cond", 14, 600));
        b.bx = cur[c.r] != null ? Math.max(gx, cur[c.r]) : gx;
        cur[c.r] = b.bx + 20 + b.tw + 30;
      });
      bs.forEach(function (b, i) {
        var nx = bs.slice(i + 1).filter(function (q) { return q.c.r === b.c.r; })[0], room = (nx ? nx.bx - 16 : W - 12) - b.bx - 20;
        var tgt = lastTargets[b.r.j.id], ly2 = b.my + (tgt ? Math.min(14, tgt.h / 2) : 14), mx0 = b.mx - 10, SY = L.row[b.c.r].SY;
        o.push(Z("path", { d: "M" + b.bx + " " + (b.by + 13) + " V" + (SY - 26) + " H" + b.gx + " V" + ly2 + " H" + (mx0 + 1), "class": "ln", "stroke-width": 1, "marker-end": "url(#bp-dot)" }),
          Z("circle", { cx: b.bx, cy: b.by, r: 13, "class": "balloon-glow pulse" }), Z("circle", { cx: b.bx, cy: b.by, r: 13, "class": "balloon" }),
          tx(b.bx, b.by + 5.5, String(b.r.n), { "text-anchor": "middle", "font-size": 16, "class": "t-disp on-hl", "font-weight": 700 }));
        if (room > 70) {
          var it = idTag(b.bx + 20, b.by - 2, b.r.g, true);
          o.push(it.n, tx(b.bx + 26 + it.w, b.by - 2, b.l1, { "font-size": 14, "font-weight": 700, "class": "cl-txt", "data-max": room - it.w - 6 }),
            tx(b.bx + 20, b.by + 16, b.r.j.slug, { "font-size": 14, "font-weight": 600, "class": "t-cond cl-sub", "data-max": room }));
        }
      });
      side.forEach(function (r) {
        var m = mk[r.j.id] || {}, b = L.side[r.st], v = lastTargets[r.j.id], mw = v ? v.w : L.sideMW, bx = b.x + 8 + mw + 34, by = (m.y || b.y + 48) + 15;
        var room = b.x + b.w - 12 - (bx + 20), it = idTag(bx + 20, by - 2, r.g, true);
        o.push(Z("path", { d: "M" + (bx - 13) + " " + by + " H" + ((m.x || 0) + mw + 1), "class": "ln", "stroke-width": 1, "marker-end": "url(#bp-dot)" }),
          Z("circle", { cx: bx, cy: by, r: 13, "class": "balloon-glow pulse" }), Z("circle", { cx: bx, cy: by, r: 13, "class": "balloon" }),
          tx(bx, by + 5.5, String(r.n), { "text-anchor": "middle", "font-size": 16, "class": "t-disp on-hl", "font-weight": 700 }));
        if (room > 70) {
          // the words wrap onto a second line rather than being cut
          var wl = wrapN(gv(r.g), room - it.w - 6, "cl-txt", 14, 700, 2);
          o.push(it.n, tx(bx + 26 + it.w, by - 2, wl[0], { "font-size": 14, "class": "cl-txt", "font-weight": 700, "data-max": room - it.w - 6 }),
            wl[1] ? tx(bx + 20, by + 16, wl[1], { "font-size": 14, "class": "cl-txt", "font-weight": 700, "data-max": room }) : null,
            tx(bx + 20, by + (wl[1] ? 34 : 16), "waiting " + fD(S.t - r.since), { "font-size": 13, "class": "t2", "data-max": room }));
        }
      });
      S.jobs.filter(function (r) { return r.g === "H4"; }).forEach(function (r) {
        var m = mk[r.j.id], i = SIDX[r.st]; if (!m || i == null) return; var c = L.cell[i], bx = c.x + c.w - 18, by = L.row[c.r].SY - 14;
        o.push(Z("path", { d: "M" + bx + " " + (by + 12) + " L" + (m.x + c.w - 22) + " " + m.y, "class": "ln2", "stroke-width": 1 }), Z("g", null, Z("title", null, "H4: CI runs, then you merge the pull request on GitHub"), Z("circle", { cx: bx, cy: by, r: 12, "class": "balloon-ext" }), tx(bx, by + 4.5, "H4", { "text-anchor": "middle", "font-size": 13, "class": "t-mono", "font-weight": 600 })));
      });
      fill(gCallouts, o);
      [].forEach.call(gCallouts.querySelectorAll("[data-max]"), function (t) { fitText(t, +t.getAttribute("data-max")); });
    }
    function drawClouds(targets) {
      if (!gClouds) return; var o = [];
      S.alerts.forEach(function (a) {
        if (!a.r) return; var v = targets[a.r.j.id]; if (!v) return;
        var right = v.p.x + v.w + 13 < W;
        o.push(Z("path", { d: cloudPath(v.p.x - 4, v.p.y - 3, v.w + 8, v.h + 6, 8), "class": "cloud" }), delta(right ? v.p.x + v.w + 1 : v.p.x - 1, v.p.y - 4, a.n));
      });
      fill(gClouds, o);
    }

    // ---------------------------------------------------------------- notes panel
    function copyBtn(text) { return H("button", { type: "button", "class": "copy", "data-copy": text, "aria-label": "Copy: " + text }, "Copy"); }
    function openBtn(j, label, sm) { return H("button", { type: "button", "class": "linkbtn" + (sm ? " sm" : ""), "data-open": j.id }, label || j.slug); }
    function replyBox(rep, cmd, flush) {
      return H("div", { "class": "reply" + (flush ? " flush" : "") }, H("div", { "class": "lbl", text: "Reply in chat" }), H("div", { "class": "row" }, rep.plain ? H("span", { "class": "plain", text: cap(rep.main) }) : [H("code", { text: rep.main }), copyBtn(rep.main)]), H("div", { "class": "alt", text: rep.alt }),
        cmd ? H("div", { "class": "term" }, H("div", { "class": "lbl", text: "Or from your terminal" }), H("div", { "class": "row" }, H("code", { text: cmd }), copyBtn(cmd))) : null);
    }
    function renderNotes() {
      var t = S.t, o = [];
      var EG = epGates(), ng = S.gates.length, ne = EG.length, nl = S.lessonsWaiting.length, nd = ng + ne;
      var heroTxt = [ng ? plural(ng, "decision") + " hold the line" : "", ne ? plural(ne, "epic gate") + " wait" + (ne === 1 ? "s" : "") : "", nl ? plural(nl, "lesson") + " to accept or reject" : ""].filter(Boolean).join(" · ") || "nothing waits on you";
      var sec = H("section", { "class": "nsec" }, H("h3", null, "Waiting on you ", H("em", { text: live ? "now" : "at " + fT(t) })),
        H("div", { "class": "hero-n" + (nd + nl ? "" : " zero") }, H("b", { text: String(nd + nl) }), H("span", { text: heroTxt })));
      if (!nd && !nl) kids(sec, [H("p", { "class": "meta", text: "Nothing waits on you at this revision. The line runs on its own." })]);
      S.gates.forEach(function (r) {
        var j = r.j, rep = chatReply(j, r.g), cmd = termCmd(j, r.g, t);
        var why = r.g === "P" || r.g === "Q" ? (j.history.filter(function (h) { return h.to === r.s && P(h.at) <= t; }).pop() || {}).reason || D.meaning[r.s] : r.g === "A" ? (j.amendment && j.amendment.reason) : D.meaning[r.s];
        kids(sec, [H("div", { "class": "note" }, H("span", { "class": "num", text: String(r.n) }),
          H("div", { "class": "what" }, gv(r.g), " ", H("span", { "class": "chip tag", text: r.g })),
          H("div", { "class": "head" }, openBtn(j), H("span", { "class": "chip mute", text: (TYPE_NAME[j.type] || j.type) + " · " + j.risk + " risk" })),
          H("div", { "class": "meta", text: "waiting " + fD(t - r.since) + " · since " + fT(r.since) }),
          H("div", { "class": "meta", text: (r.g === "P" || r.g === "A" ? "Why it stopped: " : r.g === "Q" ? "Why: " : "") + (why || "") }),
          replyBox(rep, cmd))]);
      });
      // epic gates: an epic waiting on you (EH1 · EH2 · EH3 · EA · P), with the exact reply
      EG.forEach(function (e, i) {
        var g = e.waiting_on.gate || "?", since = epSince(e);
        kids(sec, [H("div", { "class": "note" }, H("span", { "class": "num", text: String(ng + i + 1) }),
          H("div", { "class": "what" }, epWhat(e), " ", H("span", { "class": "chip tag", text: g })),
          H("div", { "class": "head" }, H("button", { type: "button", "class": "linkbtn", "data-epic": e.id, "data-epic-view": "eflow" }, e.slug), H("span", { "class": "chip mute", text: "epic · " + e.risk + " risk" })),
          H("div", { "class": "meta", text: "waiting " + fD(TN - since) + " · since " + fT(since) + " · " + (EP_LABEL[e.stage] || e.stage) }),
          replyBox(epReply(e), e.waiting_on.command))]);
      });
      S.lessonsWaiting.forEach(function (l, i) {
        var rep = "accept lesson " + l.id;
        var open = !!lessonOpen[l.id];
        kids(sec, [H("div", { "class": "note" + (open ? " open" : "") }, H("span", { "class": "num ext", text: String(nd + i + 1) }),
          H("div", { "class": "head" }, H("span", { "class": "chip", text: l.id }), H("button", { type: "button", "class": "linkbtn", "data-view": "learn" }, "lesson · general note")),
          H("div", { "class": "what" }, "Accept or reject:"),
          H("div", { "class": "rulex" + (open ? "" : " clamp"), text: "“" + l.rule + "”" }),
          H("button", { type: "button", "class": "linkbtn sm more", "data-lesson": l.id, "aria-expanded": String(open) }, open ? "less" : "more"),
          H("div", { "class": "meta", text: "from " + short(l.evidence[0] && l.evidence[0].job) + " · proposed " + fT(P(l.created_at)) }),
          H("div", { "class": "reply" }, H("div", { "class": "lbl", text: "Reply in chat" }), H("div", { "class": "row" }, H("code", { text: rep }), copyBtn(rep)), H("div", { "class": "alt", text: "or: reject lesson " + l.id + " <why>" })))]);
      });
      o.push(sec);
      // epics: this port draws no epic sheets. Each epic is listed here and shown on the Board; its slices run on the line.
      var EJ = D.epic_jobs;
      o.push(H("section", { "class": "nsec" }, H("h3", null, "Epics ", H("em", { text: EJ.length ? plural(EJ.length, "epic") + " · shown on the Board" : "none" })),
        EJ.length ? [H("p", { "class": "meta", text: "Epics are not drawn on these sheets: open the Board to see each epic and its slices. A slice is an ordinary job on the line." }),
          H("ul", { "class": "lst" }, EJ.map(function (e) { return H("li", null, H("span", { "class": "chip mute", text: e.status || "?" }), H("span", null, H("b", { text: e.id }), " " + e.title + (e.children ? " · " + plural(e.children, "slice") : ""))); })),
          H("button", { type: "button", "class": "btn", "data-classic": "board" }, "Open the Board")]
          : H("p", { "class": "meta", text: "No epics in this repository. An epic would be listed here and shown on the Board." })));
      // alerts
      o.push(H("section", { "class": "nsec" }, H("h3", null, "Problems ", H("em", { text: S.alerts.length + " · drawn as revision clouds" })),
        S.alerts.length ? H("ul", { "class": "lst" }, S.alerts.map(function (a) {
          return H("li", null, H("span", { "class": "delta-i", text: "△" + a.n }), H("span", { "class": a.r ? "clamp" : null, title: a.text }, a.r ? [openBtn(a.r.j, null, true), ": " + a.text] : H("button", { type: "button", "class": "linkbtn sm", "data-view": "agents" }, a.text)));
        })) : H("p", { "class": "meta", text: "No alerts." })));
      // at work
      o.push(H("section", { "class": "nsec" }, H("h3", null, "At work now ", H("em", { text: plural(S.agents.length, "agent") })),
        S.agents.length ? H("ul", { "class": "lst" }, S.agents.map(function (a) {
          return H("li", null, H("span", { "class": "dotl" }), H("span", null, H("b", { text: agentLabel(a.agent) }), " on ", openBtn(a.job, null, true), " ", H("span", { "class": "meta", text: "· " + wd("state", stateAt(a.job, t)) + " · " + fD(t - a.since) })));
        })) : H("p", { "class": "meta", text: "No agent is running at this revision." })));
      // landed 24 h
      var lj = {}; JOBS.forEach(function (j) { j.history.forEach(function (h) { if (["merged", "closed", "findings_delivered"].indexOf(h.to) >= 0 && P(h.at) > t - DAY && P(h.at) <= t) lj[j.id] = { j: j, h: h }; }); });
      var L = Object.keys(lj).map(function (k) { return lj[k]; }).sort(function (a, b) { return P(b.h.at) - P(a.h.at); });
      o.push(H("section", { "class": "nsec" }, H("h3", null, "Landed today ", H("em", { text: L.length + " in the last 24 hours" })),
        L.length ? H("ul", { "class": "lst" }, L.map(function (x) { return H("li", null, H("span", { "class": "when", text: fT(P(x.h.at)) }), H("span", null, openBtn(x.j, null, true), " ", H("span", { "class": "meta", text: wd("state", x.h.to) }))); }))
          : H("p", { "class": "meta", text: "Nothing landed." })));
      // revision table
      var upto = EVENTS.filter(function (e) { return e.at <= t; }), evs = upto.slice(-8).reverse();
      o.push(H("section", { "class": "nsec" }, H("h3", null, "Latest changes ", H("em", { text: "revision " + S.rev + " of " + EVENTS.length + " · click one to replay to it" })),
        H("table", { "class": "rev" }, H("thead", null, H("tr", null, H("th", { text: "No." }), H("th", { text: "Time" }), H("th", { text: "Change" }))),
          H("tbody", null, evs.map(function (e) {
            var idx = EVENTS.indexOf(e) + 1;
            return H("tr", { "data-at": e.at, tabindex: 0, title: "Replay to this revision" }, H("td", { "class": "mono", text: String(idx) }), H("td", { "class": "mono", text: fT(e.at) }),
              H("td", null, H("b", { text: e.job.slug }), " → " + wd("state", e.to), e.by ? [" ", H("span", { "class": "chip hl", text: "by " + e.by })] : null,
                e.reason && !e.by && e.reason !== "job received" ? [" ", H("span", { "class": "meta", text: "— " + e.reason })] : null));
          })))));
      var det = H("details", { "class": "k" }, H("summary", null, "Key"), H("div", { "class": "key" }, keyRows()));
      if (keyOpen) det.open = true;
      det.addEventListener("toggle", function () { keyOpen = det.open; });
      o.push(H("section", { "class": "nsec" }, det));
      fill(notesBody, o);
      // the badge in the sheet bar: what waits on you, or just "Notes" when nothing does
      // the badge says jobs and lessons apart, so its job count is the Board's "Your turn" (parked jobs are their own)
      var yt = S.yourTurn + ne, np = S.parked;
      fill(notesBtn, yt + np + nl ? [yt ? [H("b", { text: String(yt) }), " your turn"] : null, np > 0 ? [yt ? " · " : "", H("b", { text: String(np) }), " parked"] : null,
        nl ? [yt || np > 0 ? " · " : "", H("b", { text: String(nl) }), nl === 1 ? " lesson" : " lessons"] : null] : "Notes");
      notesBtn.classList.toggle("bp-hl", nd + nl > 0);
      notesBtn.setAttribute("aria-label", "Notes: " + heroTxt);
    }
    function setNotes(on, focusLessons) {
      notesOpen = !!on; notes.classList.toggle("bp-on", notesOpen); notes.setAttribute("aria-hidden", String(!notesOpen)); notesBtn.setAttribute("aria-expanded", String(notesOpen));
      if (notesOpen) setTimeout(function () { if (!alive()) return; var f = focusLessons && notesBody.querySelector(".bp-num.bp-ext"); if (f) f.parentNode.scrollIntoView({ block: "start" }); notesClose.focus({ preventScroll: true }); }, 30);
      else if (notes.contains(document.activeElement)) notesBtn.focus({ preventScroll: true });
    }
    notesBtn.addEventListener("click", function () { setNotes(!notesOpen); });
    notesClose.addEventListener("click", function () { setNotes(false); });
    function keyRows() {
      var r = function (svgKids, txt) { return [Z("svg", { viewBox: "0 0 30 20" }, svgKids), H("span", { text: txt })]; };
      return [
        r([boxText(1, 1, 28, 18, { fill: "var(--paper)", stroke: "var(--ink)" }), typeSym("feature", 10, 10, 11)], "job marker · symbol = work type: ○ feature"),
        r(typeSym("bug", 15, 10, 12), "✕ bug fix"), r(typeSym("hotfix", 15, 10, 12), "△ hotfix"), r(typeSym("spike", 15, 10, 12), "◇ spike"), r(typeSym("refactor", 15, 10, 12), "□ refactor · migration · other"),
        r(boxText(4, 2, 22, 16, { fill: "url(#bp-h-med)", stroke: "var(--ink)" }), "risk = hatch: none low · single medium · cross high"),
        r(boxText(4, 2, 22, 16, { fill: "url(#bp-h-high)", stroke: "var(--ink)" }), "cross-hatch: high risk"),
        r(Z("circle", { cx: 15, cy: 10, r: 8, fill: "var(--hl)", stroke: "var(--ink)" }), "amber = waits on you (your decision, numbered callout)"),
        r(Z("circle", { cx: 15, cy: 10, r: 5, fill: "var(--agent)" }), "lit lamp = an agent at work, moving line = work flowing"),
        r(boxText(8, 3, 14, 14, { fill: "var(--paper)", stroke: "var(--ink)" }), "agent step"),
        r(Z("path", { d: "M15 2L23 10L15 18L7 10Z", fill: "var(--paper)", stroke: "var(--ink)" }), "CLI check (deterministic)"),
        r(Z("path", { d: cloudPath(3, 4, 24, 12, 6), "class": "cloud" }), "red revision cloud = a problem: failing or refused"),
        r(Z("path", { d: "M2 10H28", "class": "side-ln" }), "dash-dot line = side track (changing, parked, stopped)"),
        r(Z("path", { d: "M28 16V5H2V16", "class": "rail hot" }), "red line = sent back, with how often this week (grey dashed: not this week)")
      ];
    }

    // ---------------------------------------------------------------- title block
    function renderTB() {
      var t = S.t;
      tbAsof.textContent = fT(t); tbRev.textContent = S.rev + " / " + EVENTS.length; tbProj.textContent = REPO;
      modeTag.textContent = snapshotOn ? "Issued" : live ? "Live" : "Replay"; modeTag.setAttribute("class", cx("mode " + (live && !snapshotOn ? "live" : "replay")));
      if (document.activeElement !== scrub) scrub.value = Math.round((t - T0) / (TN - T0) * 1000);
      // "Your turn" counts jobs as the Board does (a gate, clarify's questions or a merge waiting on your reply); lessons and parked jobs apart
      var neg = epGates().length, nw = S.yourTurn + neg, nl = S.lessonsWaiting.length;
      var nf = S.jobs.filter(function (r) { return r.gf; }).length;
      var q = [[nw ? "hl" : "", "Your turn", nw, "jobs waiting on your reply at a gate, clarify's questions or a merge, as the Board's Your turn" + (neg ? " (" + plural(neg, "epic decision") + ")" : "") + (S.parked ? "; " + plural(S.parked, "parked job") + " not counted" : "")],
        [nl ? "hl" : "", "Lessons to decide", nl, "proposed lessons waiting for accept lesson Ln or reject lesson Ln <why>; not jobs, so not in Your turn"], ["", "In flight", S.open, "jobs not finished"],
        [S.agents.length ? "ag" : "", "Agents at work", S.agents.length, "agents at work now"],
        [nf ? "fail" : "", "Failing checks", nf, "jobs whose gate check is failing"],
        [S.den24 ? "fail" : "", "Refused today", S.den24, "unsafe actions the guard refused in the last 24 hours"], [S.sentBack7 ? "back" : "", "Sent back this week", S.sentBack7, "times work was sent back in the last 7 days"]];
      fill(tbQ, q.map(function (c) {
        var inner = [H("div", { "class": "k", text: c[1] }), H("div", { "class": "v" }, / ?hl$/.test(c[0]) || c[0] === "hl" ? H("span", { text: String(c[2]) }) : String(c[2]))];
        // the epics counter is a way in: it opens the epic register
        return c[1] === "Epics" ? H("button", { type: "button", "class": "cell q " + c[0], title: c[3], "aria-label": c[3], "data-v": "epics" }, inner) : H("div", { "class": "cell q " + c[0], title: c[3] }, inner);
      }));
      renderAP();
      stamp.textContent = "Issued · snapshot " + fT(t) + " · rev " + S.rev + (heldData ? " · newer data held" : "");
    }
    // Copilot's Autopilot: a gate-safety note in the title block. The prompt hook saw Autopilot's own continuation
    // prompt (.factory/autopilot.json): Autopilot answers prompts by itself and keeps going past the factory's stops,
    // so it could answer a gate for you. It describes now: during replay it says so.
    function renderAP() {
      var a = AP;
      if (!a || !a.last_at) { apCell.hidden = true; clear(apCell); return; }
      var last = fT(P(a.last_at));
      var txt = a.recent ? "Autopilot seen " + last + ": it may answer gates for you" : "Autopilot last seen " + last;
      var tip = "Copilot's Autopilot was seen in this project (last continuation " + last + " UTC" + (a.count > 1 ? ", " + a.count + " times this session" : "") + "). " +
        "It answers prompts by itself and keeps going past the factory's stops, so it could answer a gate for you. Switch Copilot back to interactive mode (Shift+Tab, or /autopilot off) for factory work; factory next and factory doctor warn while the sighting is recent (" + (a.window_hours || 6) + " h).";
      apCell.hidden = false; apCell.setAttribute("title", tip); apCell.setAttribute("aria-label", (live ? "" : "Now: ") + txt + ". " + tip);
      apCell.setAttribute("class", cx("cell apnote" + (a.recent ? " warn" : " old")));
      fill(apCell, H("div", { "class": "k" }, "Gate safety", live ? null : H("span", { "class": "apnow", text: " · now, not at this revision" })),
        H("div", { "class": "v" }, H("span", { "class": "aplamp", "aria-hidden": "true" }), txt));
    }
    function renderTicks() {
      var w = 1000, o = [Z("line", { x1: 0, y1: 12, x2: w, y2: 12, stroke: "var(--ink)", "stroke-width": 1 })];
      EVENTS.forEach(function (e) { var x = (e.at - T0) / (TN - T0) * w, human = !!e.by; o.push(Z("line", { x1: x, y1: human ? 3 : 7, x2: x, y2: human ? 21 : 17, stroke: human ? "var(--ink)" : "var(--ink-3)", "stroke-width": human ? 2 : 1 })); });
      var x = (S.t - T0) / (TN - T0) * w; o.push(boxText(x - 4, 0, 8, 24, { fill: "var(--hl)", stroke: "var(--ink)", "stroke-width": 1.2 }));
      fill(ticks, o);
    }

    // ---------------------------------------------------------------- section view
    function openSection(id) {
      if (!JBY[id]) return; sel = id; placeTop(); renderSection();
      section.classList.add("bp-on"); section.setAttribute("aria-hidden", "false");
      setTimeout(function () { if (alive()) secClose.focus({ preventScroll: true }); }, 30);
      if (view === "line") renderMarkers();
    }
    function closeSection() {
      section.classList.remove("bp-on"); section.setAttribute("aria-hidden", "true"); var id = sel; sel = null;
      if (view === "line") { renderMarkers(); var el = gMarkers && gMarkers.querySelector('.bp-mk[data-job="' + String(id).replace(/"/g, "") + '"]'); if (el) el.focus(); }
    }
    // long text is clamped with a "more" toggle; what is open stays open across refreshes
    var secOpen = {};
    function clampText(key, text, limit, cls) {
      text = String(text || ""); var long = text.length > limit, open = !!secOpen[key];
      return H("div", { "class": "xp" + (long && !open ? " clamped" : "") + (cls ? " " + cls : "") }, H("div", { "class": "xpt", text: text }),
        long ? H("button", { type: "button", "class": "linkbtn sm xpb", "data-xp": key, "aria-expanded": String(open) }, open ? "less" : "more") : null);
    }
    function fileRef(f) { return f.file ? H("span", { "class": "fref", text: f.file + (f.line != null ? ":" + f.line : "") }) : null; }
    function statusChip(st) { return H("span", { "class": "chip st-" + st, text: st === "passing" ? "✓ passing" : st === "failing" ? "✗ failing" : st === "building" ? "● building" : st }); }
    function renderSection() {
      if (!sel) return; var j = JBY[sel], t = S.t; if (!j) { closeSection(); return; }
      var s = stateAt(j, t);
      fill(secTitle, j.slug, H("small", { text: j.id + " · " + (TYPE_NAME[j.type] || j.type) + " · " + j.risk + " risk" + (j.epic ? " · slice " + epTag(j) : "") }));
      if (!s) { fill(secBody, H("div", { "class": "sec-wrap" }, H("p", { text: "This job had not been received yet at " + fT(t) + ". It arrives " + fT(P(j.created_at)) + "." }))); return; }
      var g = gateOf(j, t), out = [];
      // 1. now: where it stands, what is next, what blocks it
      var failingT = j.tasks.filter(function (tk) { return taskStatusAt(j, tk, t) === "failing"; }), gt = j.gate, done = !!DONE_STATES[s];
      var blockers = [];
      if (!done && gt && gt.evaluated && gt.pass === false) blockers.push("failing check: " + gt.problems.join("; "));
      if (!done && failingT.length) blockers.push(plural(failingT.length, "task") + " failing: " + failingT.map(function (k) { return k.id; }).join(", "));
      out.push(H("section", { "class": "sec-now" + (g && g !== "H4" ? " wait" : blockers.length ? " fail" : "") },
        H("div", { "class": "now-row" }, H("span", { "class": "chip big " + (g && g !== "H4" ? "hl" : STOPPED_STATES[s] ? "fail" : done ? "ok" : blockers.length ? "fail" : ""), text: (STOPPED_STATES[s] ? "■ " : "") + wd("state", s), title: s }),
          H("span", { "class": "now-txt", text: D.meaning[s] || "" }), H("span", { "class": "meta", text: "since " + fT(enteredAt(j, t)) + " · " + fD(t - enteredAt(j, t)) })),
        !done && NEXT[s] ? H("div", { "class": "now-next" }, H("b", { text: "Next " }), NEXT[s]) : null,
        j.epic ? (function () {
          var ep = epOfJob(j);
          return H("div", { "class": "now-epic" }, H("span", { "class": "chip", text: (j.slice || "slice") }), " a slice of epic ",
            ep ? [H("button", { type: "button", "class": "linkbtn", "data-epic": ep.id, "data-epic-view": "eflow" }, ep.slug), H("span", { "class": "meta", text: " · " + (EP_LABEL[ep.stage] || ep.stage) + " · " }),
              H("button", { type: "button", "class": "linkbtn sm", "data-epic": ep.id, "data-epic-view": "eflow" }, "assembly drawing"), H("span", { "class": "meta", text: " · " }),
              H("button", { type: "button", "class": "linkbtn sm", "data-epic": ep.id, "data-epic-view": "ebreak" }, "exploded view")] : H("b", { text: epTag(j) }));
        })() : null,
        blockers.map(function (b) { return H("div", { "class": "now-block", text: "✗ " + b }); }),
        done && failingT.length ? H("div", { "class": "meta", text: "closed with " + plural(failingT.length, "task") + " still marked failing (" + failingT.map(function (k) { return k.id; }).join(", ") + ")" }) : null,
        j.parked_from && s === "parked" ? H("div", { "class": "meta" }, "parked from ", H("b", { text: j.parked_from })) : null,
        g && g !== "H4" ? H("div", { "class": "now-gate" }, H("h4", null, gv(g), H("span", { "class": "chip tag", text: g }), H("em", { text: "waiting " + fD(t - enteredAt(j, t)) })), replyBox(chatReply(j, g), termCmd(j, g, t), true),
          j.amendment && j.amendment.reason ? H("p", { "class": "meta" }, "Amendment from ", H("b", { text: j.amendment.from || "?" }), ": " + j.amendment.reason) : null) : null,
        gt && gt.warnings.length ? H("div", { "class": "meta", text: "check warnings: " + gt.warnings.join("; ") }) : null));
      // the latest exchange about this job: your prompt, the reply, God Eye's last revise (B-48)
      if (api.conversation) out.push(H("section", { "class": "sec-blk cvblk", "aria-label": "Latest exchange about this job, as of " + fT(t) }, api.conversation(j.id, t)));
      // 2. path
      out.push(H("section", { "class": "sec-blk" }, H("h3", null, "Path", H("em", { text: "each stop is a stay at a station · amber stripe = waiting on you · ↺ = " + wd("revise") })), pathHTML(j, t)));
      // 2a. clarify v2: the issue ledger (status, owner, next action), the per-round trend, what went to design
      if (j.clarify && j.clarify.issues && j.clarify.issues.length) out.push(clarifyBlock(j));
      // 2b. workflow runs: each run's steps, as they stood at the replay time, the latest first
      out.push(runsBlock(j, t));
      // 3. tasks by wave
      var waves = wavesOf(j.tasks), npass = j.tasks.filter(function (tk) { return taskStatusAt(j, tk, t) === "passing"; }).length;
      out.push(H("section", { "class": "sec-blk" }, H("h3", null, "Tasks", H("em", { text: npass + " / " + j.tasks.length + " passing" + (waves.length > 1 ? " · " + plural(waves.length, "wave") : "") })),
        !j.tasks.length ? H("p", { "class": "meta", text: "No plan yet: tasks appear after Plan." }) : null,
        waves.map(function (w, i) {
          return H("div", { "class": "wave2" }, waves.length > 1 ? H("div", { "class": "wh", text: "Wave " + (i + 1) + " · " + plural(w.length, "task") }) : null,
            H("div", { "class": "tgrid" }, w.map(function (tk) {
              var st = taskStatusAt(j, tk, t);
              return H("article", { "class": "tk st-" + st },
                H("header", null, H("b", { "class": "tid", text: tk.id }), statusChip(st), H("span", { "class": "meta", text: plural(tk.runs, "run") })),
                clampText("t:" + j.id + ":" + tk.id, tk.objective, 190, "obj"),
                H("dl", null,
                  tk.criteria.length ? [H("dt", { text: "proves" }), H("dd", null, tk.criteria.map(function (c) { return H("span", { "class": "fref", title: c, text: wd("crit", c) }); }))] : null,
                  tk.depends_on.length ? [H("dt", { text: "after" }), H("dd", null, tk.depends_on.map(function (c) { return H("span", { "class": "fref", text: c }); }))] : null,
                  tk.allowed_paths.length ? [H("dt", { text: "files" }), H("dd", null, (secOpen["p:" + j.id + tk.id] ? tk.allowed_paths : tk.allowed_paths.slice(0, 4)).map(function (p) { return H("span", { "class": "fref", text: p }); }),
                    tk.allowed_paths.length > 4 ? H("button", { type: "button", "class": "linkbtn sm", "data-xp": "p:" + j.id + tk.id }, secOpen["p:" + j.id + tk.id] ? "fewer" : "+" + (tk.allowed_paths.length - 4) + " more") : null)] : null,
                  tk.verify_commands.length ? [H("dt", { text: "verify" }), H("dd", null, clampText("v:" + j.id + ":" + tk.id, tk.verify_commands.join("\n"), 120, "cmd"))] : null));
            })));
        })));
      // 4. proof per criterion
      out.push(H("section", { "class": "sec-blk" }, H("h3", null, "Proof per criterion", H("em", { text: plural(j.evidence_count, "evidence record") })),
        j.criteria.length ? H("div", { "class": "crits" }, j.criteria.map(function (c) {
          var ok = c.status === "proven" || c.status === "proven-stale";
          return H("div", { "class": "crit2" }, H("div", { "class": "cid" }, H("b", { text: wd("crit", c.id || "?") }), H("span", { "class": "chip tag", text: c.id || "?" })), clampText("c:" + j.id + ":" + c.id, c.text || "", 200),
            H("span", { "class": "chip " + (ok ? "ok" : "mute"), text: (ok ? "✓ proven" : "unproven") + (c.status === "proven-stale" ? " · stale fingerprint" : "") + (c.tasks.length ? " · " + c.tasks.join(", ") : "") }));
        })) : H("p", { "class": "meta", text: "No criteria." })));
      // 5. reviews
      var lanes = uniq(j.required_lanes.concat(j.reviews.map(function (v) { return v.lane; })));
      out.push(H("section", { "class": "sec-blk" }, H("h3", null, "Reviews", H("em", { text: "required: " + (j.required_lanes.map(function (x) { return wd("lane", x).toLowerCase(); }).join(", ") || "none") })),
        lanes.length ? lanes.map(function (ln) {
          var ls = laneState(j, ln, t), rv = ls.rv, shown = rv || ls.prev;
          var chip = ls.running ? ["ag", "● reviewer at work"] : rv ? (rv.verdict === "pass" ? ["ok", "✓ pass"] : ["fail", "✗ " + verdictWord(rv)]) : ["mute", "not run"];
          return H("div", { "class": "rv" }, H("header", null, H("b", { "class": "disp", text: wd("lane", ln) }), H("span", { "class": "chip " + chip[0], text: chip[1] }),
              H("span", { "class": "meta", text: shown ? (ls.running ? "last round: " + verdictWord(shown) + " · " : "") + (shown.round ? roundText(j, shown.round) + " · " : "") + (shown.model ? shown.model + " · " : "") + fT(P(shown.at)) + " · " + plural(shown.findings.length, "finding") + (shown.unverified ? " · " + shown.unverified + " unverified, blocking" : "") + (shown.dismissed ? " · " + shown.dismissed + " refuted" : "") : ls.req ? "required · waiting for this lane" : "optional" })),
            shown && shown.findings.length ? H("ol", { "class": "finds" }, shown.findings.map(function (f, k) {
              var unv = f.status === "unverified";
              return H("li", null, H("div", { "class": "fh" }, H("span", { "class": "chip sev-" + (f.severity || "x"), text: f.severity || "?" }), f.status && f.status !== "minor" ? H("span", { "class": "chip " + (unv ? "fail" : f.status === "confirmed" ? "fail" : "mute"), text: unv ? "unverified · blocking" : f.status }) : null, fileRef(f)),
                clampText("f:" + j.id + ":" + ln + ":" + k, f.summary || "", 260),
                f.verifier || f.verification || f.evidence ? H("div", { "class": "meta", text: "Verifier: " + (f.verifier || "no verdict") + (f.verification ? " — " + f.verification : "") + (f.evidence ? " · evidence: " + f.evidence : "") }) : null);
            })) : null);
        }) : H("p", { "class": "meta", text: "No review lanes yet." })));
      // 6. documents
      var di = Math.min(docIdx[j.id] || 0, Math.max(0, j.docs.length - 1)), docHolder = H("div");
      out.push(H("section", { "class": "sec-blk" }, H("h3", null, "Documents", H("em", { text: String(j.docs.length) })),
        j.docs.length ? [H("div", { "class": "doc-tabs", role: "tablist" }, j.docs.map(function (d, i) { return H("button", { type: "button", role: "tab", "data-doc": i, "aria-selected": String(i === di) }, d.name || "document"); })), docHolder]
          : H("p", { "class": "meta", text: "No documents." })));
      if (j.docs.length) fill(docHolder, docBody(j.docs[di]));
      // 7. history
      out.push(H("section", { "class": "sec-blk hist" }, H("h3", null, "History by station", H("em", { text: plural(j.history.filter(function (h) { return P(h.at) <= t; }).length, "move") })), historyNodes(j, t)));
      fill(secBody, H("div", { "class": "sec-wrap" }, out));
    }
    // The Clarify block: the ledger as factory clarify status prints it (the latest state, not replayed)
    var CL_STATUS = { open: "open", researching: "researching", proposed: "with you", settled: "settled", deferred_to_design: "to design", dropped: "dropped" };
    var CL_BY = { evidence: "by evidence", user: "by you", assumption_accepted: "default accepted", design_deferral: "deferred" };
    function clarifyBlock(j) {
      var c = j.clarify, tt = c.totals || {}, o = c.open_by_owner || {};
      var mx = Math.max.apply(null, [1].concat(c.rounds.map(function (r) { return Math.max(r.opened, r.settled); })));
      var bar = function (n, cls) { return H("i", { "class": "clb " + cls, style: { height: (Math.round((n / mx) * 28) + (n ? 2 : 0)) + "px" }, title: String(n) }); };
      var trend = c.rounds.length ? H("div", { "class": "cltrend", role: "img", "aria-label": "Per round: issues opened and settled" },
        c.rounds.map(function (r) {
          return H("span", { "class": "clr" + (r.degraded ? " deg" : r.progress ? "" : " np"), title: "round " + r.round + ": " + r.opened + " opened, " + r.settled + " settled, " + r.deferred + " deferred, " + r.asked + " asked" + (r.degraded ? " · degraded, not counted" : r.progress ? "" : " · no progress") },
            bar(r.opened, "op"), bar(r.settled, "st"), H("b", { text: "R" + r.round }));
        }), H("span", { "class": "cllg" }, H("i", { "class": "clb op" }), "opened ", H("i", { "class": "clb st" }), "settled · " + c.trend)) : H("p", { "class": "meta", text: c.trend });
      var rows = c.issues.map(function (r) {
        return H("tr", { "class": "cl-" + r.status },
          H("td", { "class": "t-mono" }, r.id, r.aliases && r.aliases.length ? H("div", { "class": "meta", title: "folded duplicates", text: "= " + r.aliases.join(", ") }) : null),
          H("td", null, H("code", { text: r.subject || "—" }), H("div", { "class": "meta", text: r.title })),
          H("td", null, H("span", { "class": "chip " + (r.status === "settled" ? "ok" : r.status === "proposed" ? "hl" : r.status === "deferred_to_design" ? "tag" : "mute"), text: CL_STATUS[r.status] || r.status }), r.settled_by ? H("div", { "class": "meta", text: CL_BY[r.settled_by] || r.settled_by }) : null),
          H("td", { "class": "t-mono", text: r.owner }),
          H("td", { text: r.next }));
      });
      var qs = (c.questions || []).length ? H("div", { "class": "clq" }, H("h4", null, "Waiting on you", H("em", { text: plural(c.questions.length, "question") })),
        c.questions.map(function (q) { return H("div", { "class": "clqi" }, H("b", { text: q.id }), " " + q.question + (q.default ? " (default: " + q.default + ")" : ""), H("div", null, H("code", { text: "factory answer " + q.id + " \"…\"" }), q.default ? H("code", { text: "factory answer " + q.id + " --default" }) : null)); })) : null;
      var def = (c.deferred || []).length ? H("div", { "class": "cld" }, H("h4", null, "Handed to design", H("em", { text: "ground and decide settle these; they do not block H1" })),
        H("ul", null, c.deferred.map(function (d) { return H("li", null, H("b", { text: d.id }), " ", H("code", { text: d.subject }), " " + d.title); }))) : null;
      return H("section", { "class": "sec-blk clarify" }, H("h3", null, "Clarify", H("em", { text: tt.issues + " issues · " + tt.closed + " closed · open: you " + (o.user || 0) + ", research " + (o.research || 0) + ", design " + (o.design || 0) + (c.migrated ? " · migrated from v1" : "") })),
        trend, qs, H("div", { "class": "cltblw" }, H("table", { "class": "cltbl" }, H("tr", null, H("th", { text: "Issue" }), H("th", { text: "Subject" }), H("th", { text: "Status" }), H("th", { text: "Owner" }), H("th", { text: "Next" })), rows)), def);
    }
    var RUN_NAME = { "fanout-judge:clarify": "Clarify", "fanout-judge:decide": "Decide", "fanout-judge:challenge": "Challenge", ground: "Ground", decompose: "Decompose", realize: "Realize", reconcile: "Reconcile", distill: "Distill" };
    function runName(v) { return RUN_NAME[v.workflow + ":" + v.config] || RUN_NAME[v.workflow] || (v.workflow + (v.config ? " " + v.config : "")); }
    function runsBlock(j, t) {
      var vs = arr(j.runs).map(function (r) { var v = runView(r, t); return v ? { r: r, v: v } : null; }).filter(Boolean).reverse();
      var em = vs.length ? plural(vs.length, "run") + (vs[0].v.status === "running" ? " · one at work" : "") : "";
      if (!HAS_RUNS || !vs.length) return H("section", { "class": "sec-blk wfruns" }, H("h3", null, "Workflow runs", H("em", { text: em })),
        H("p", { "class": "meta", text: arr(j.runs).length ? "No run had started by " + fT(t) + "." : "No step-by-step record: this job's runs were logged before workflow steps were." }));
      return H("section", { "class": "sec-blk wfruns" }, H("h3", null, "Workflow runs", H("em", { text: em + " · latest first" })),
        vs.map(function (x) {
          var v = x.v, run = v.status === "running", end = run ? t : P(v.ended_at);
          var chip = run ? ["ag", "● at work"] : v.status === "failed" ? ["fail", "✕ failed"] : ["ok", "✓ " + (v.result || "done")];
          var head = [v.round ? "round " + v.round : v.visit > 1 ? "run " + v.visit : null, v.mode, run && v.at ? "step " + v.at + " of " + v.of : plural(v.of, "step"), fT(P(v.started_at)) + " · " + fD(end - P(v.started_at))].filter(Boolean).join(" · ");
          return H("article", { "class": "wfrun" + (run ? " live" : "") },
            H("header", null, H("b", { "class": "disp", text: runName(v) }), H("span", { "class": "chip " + chip[0], text: chip[1] }), H("span", { "class": "meta", text: head })),
            v.error ? H("div", { "class": "meta now-block", text: "✕ " + v.error }) : null,
            H("ol", { "class": "wfsteps" }, v.steps.map(function (st) {
              var dur = st.started_at ? fD((st.ended_at ? Math.min(P(st.ended_at), t) : t) - P(st.started_at)) : "";
              var failed = st.roles.some(function (r) { return r.failed; });
              return H("li", { "class": "wfs st-" + st.state + (failed ? " bad" : "") },
                H("span", { "class": "g", "aria-hidden": "true", text: STEP_GLYPH[st.state] || "·" }),
                H("span", { "class": "lbl", text: st.label, title: st.text || st.label }),
                H("span", { "class": "who", text: rolesText(st, x.r.station, "full") || (st.state === "skipped" ? "skipped" : "") }),
                H("span", { "class": "meta tm", text: st.state === "pending" ? "not yet" : st.state === "skipped" ? "" : (st.started_at ? fHM(P(st.started_at)) + " · " + dur : "") }));
            }), run && v.next ? H("li", { "class": "wfs st-pending" }, H("span", { "class": "g", "aria-hidden": "true", text: "○" }), H("span", { "class": "lbl", text: "→ " + v.next }), H("span", { "class": "who" }), H("span", { "class": "meta tm", text: "then" })) : null));
        }));
    }
    function docBody(d) {
      var key = "d:" + sel + ":" + (d.name || ""), txt = d.excerpt || "", long = txt.split("\n").length > 16 || txt.length > 1400, open = !!secOpen[key];
      return [H("p", { "class": "meta docmeta" }, d.binding ? ["binding: ", H("b", { text: d.binding }), d.gate ? " at " + d.gate : ""] : "not bound to a gate"),
        H("pre", { "class": "doc" + (long && !open ? " clamped" : ""), "data-keep": "doc", text: txt }),
        long ? H("button", { type: "button", "class": "linkbtn sm xpb", "data-xp": key }, open ? "less" : "more") : null];
    }
    // the path as stops that wrap onto as many rows as they need; names are never cut
    function pathHTML(j, t) {
      var segs = segmentsOf(j, t).filter(function (s) { return s.b - s.a > 0 || s.open || s.g; });
      return H("ol", { "class": "path" }, segs.map(function (s, i) {
        var prev = segs[i - 1], back = prev && SIDX[s.st] != null && SIDX[prev.st] != null && SIDX[s.st] < SIDX[prev.st], side = SIDX[s.st] == null;
        var appr = s.g ? j.history.filter(function (h) { return h.by === "you" && P(h.at) === s.b && P(h.at) <= t; })[0] : null;
        return H("li", { "class": "stop" + (s.g ? " wait" : "") + (s.open ? " now" : "") + (back ? " back" : "") + (side ? " side" : "") },
          H("div", { "class": "sn" }, s.g ? H("span", { "class": "chip hl", text: s.g }) : null, H("span", { text: stageLabel(s.st) })),
          H("div", { "class": "sm" }, H("span", { "class": "mono", text: fHM(s.a) }), H("b", { text: fD(s.b - s.a) + (s.open ? " so far" : "") })),
          back ? H("div", { "class": "sx back", text: "↺ sent back" }) : null,
          appr ? (function () {
            // what your reply did there: approved (✓), asked for changes (✋), parked (‖), resumed (▶) or stopped (■) the job
            var stop = !!STOPPED_STATES[appr.to], deny = /asked for changes/.test(appr.reason || ""), park = appr.to === "parked", res = appr.from === "parked";
            return H("div", { "class": "sx " + (stop || deny ? "back" : "ok"), text: (stop ? "■ " : deny ? "✋ " : park ? "‖ " : res ? "▶ " : "✓ ") + appr.by + " " + fHM(P(appr.at)) });
          })() : null);
      }));
    }
    function segmentsOf(j, t) {
      var segs = [];
      intervals(j, t).forEach(function (x) {
        var st = S2STAGE[x.state], g = GATE[x.state] || (x.state === "pr_open" ? "H4" : null), last = segs[segs.length - 1];
        if (last && last.st === st && !g && !last.g && !x.open === !last.open) { last.b = x.b; last.states.push(x.state); if (x.open) last.open = true; }
        else segs.push({ st: st, g: g, a: x.a, b: x.b, states: [x.state], open: !!x.open });
      });
      return segs;
    }
    function historyNodes(j, t) {
      return segmentsOf(j, t).map(function (s) {
        var items = [];
        j.history.forEach(function (h) { var at = P(h.at); if (at >= s.a && at <= s.b && at <= t && s.states.indexOf(h.from) >= 0) items.push({ cls: h.by === "you" ? "human" : isRework(h.from, h.to) || h.to === "parked" ? "bad" : "ev", txt: fHM(at) + " " + wd("state", h.from) + " → " + wd("state", h.to) + (h.by ? " · by " + h.by : "") + (h.reason ? " — " + h.reason : "") }); });
        var runs = {};
        ACT.forEach(function (a) { var at = P(a.at); if (a.job !== j.id || at < s.a || at > s.b || at > t || s.states.indexOf(a.state) < 0) return; var k = a.agent ? agentLabel(a.agent) : "(agent not recorded)"; var r = runs[k] = runs[k] || { runs: 0, den: [] }; if (a.phase === "start") r.runs++; if (a.phase === "denied") r.den.push(a); });
        Object.keys(runs).forEach(function (k) { var r = runs[k]; if (r.runs) items.push({ cls: "", txt: k + ": " + plural(r.runs, "run") }); r.den.forEach(function (d) { items.push({ cls: "bad", txt: fHM(P(d.at)) + " ⊘ refused " + k + " " + (d.command || d.tool || "") + ": " + (d.reason || "") }); }); });
        if (s.st === "intake") items.unshift({ cls: "ev", txt: fHM(s.a) + " job received · " + j.type + ", " + j.risk + " risk" });
        return H("div", { "class": "vis" }, H("div", { "class": "vh" }, (s.g ? s.g + " · " : "") + stageLabel(s.st), H("span", { text: fT(s.a) + " · " + fD(s.b - s.a) + (s.open ? " (current)" : "") })),
          H("ul", null, items.length ? items.map(function (i) { return H("li", { "class": i.cls || null, text: i.txt }); }) : H("li", { text: "no recorded activity" })));
      });
    }

    // ---------------------------------------------------------------- sheet 3: matrix
    function renderBoard() {
      var t = S.t, cols = STAGES.map(function (s) { return s.key; }).concat(SIDES.filter(function (s) { return s.key !== "stopped"; }).map(function (s) { return s.key; }));
      var head = H("div", { "class": "viewhead" }, H("h2", { text: "Matrix" }), H("p", { text: "stations × whose turn · " + (live ? "now" : "at " + fT(t)) }), H("span", { "class": "grow" }),
        H("div", { "class": "seg", role: "group", "aria-label": "Mode" }, H("button", { type: "button", "data-bm": "jobs", "aria-pressed": String(boardMode === "jobs") }, "Jobs"), H("button", { type: "button", "data-bm": "tasks", "aria-pressed": String(boardMode === "tasks") }, "Tasks")));
      var board;
      if (boardMode === "jobs") {
        var rows = [["you", "Waiting on you"], ["agent", "Agents' turn"], ["stuck", "Stuck"], ["fin", "Finished"]];
        var rowOf = function (r) { return r.done || r.s === "merged" ? "fin" : (r.g && r.g !== "H4") ? "you" : (r.failing || r.gf || r.den.length) ? "stuck" : "agent"; };
        board = H("div", { "class": "board", style: { "grid-template-columns": "34px repeat(" + cols.length + ",minmax(0,1fr))" } }, H("div", { "class": "bh" }), cols.map(function (c) { return H("div", { "class": "bh", text: stageLabel(c) }); }),
          rows.map(function (rw) { return [H("div", { "class": "rh" + (rw[0] === "you" ? " hl" : ""), text: rw[1] }), cols.map(function (c) { return H("div", { "class": "bc" }, (S.byStage[c] || []).filter(function (r) { return rowOf(r) === rw[0]; }).map(function (r) { return cardNode(r, t); })); })]; }));
      } else {
        var tc = ["planned", "waiting", "ready", "building", "retrying", "passing", "merged"], items = {}; tc.forEach(function (c) { items[c] = []; });
        S.jobs.forEach(function (r) {
          r.j.tasks.forEach(function (tk) {
            var st = taskStatusAt(r.j, tk, t);
            if (["merged", "closed", "post_merge_review"].indexOf(r.s) >= 0) st = "merged";
            else if (st === "todo" || st === "planned") { if (r.st === "build") st = tk.depends_on.every(function (d) { var dt = r.j.tasks.filter(function (x) { return x.id === d; })[0]; return dt && taskStatusAt(r.j, dt, t) === "passing"; }) ? "ready" : "waiting"; else st = "planned"; }
            else if (st === "failing") st = "retrying";
            if (items[st]) items[st].push({ r: r, tk: tk });
          });
        });
        board = H("div", { "class": "board", style: { "grid-template-columns": "repeat(" + tc.length + ",minmax(0,1fr))" } }, tc.map(function (c) { return H("div", { "class": "bh", text: c + " · " + items[c].length }); }),
          tc.map(function (c) {
            return H("div", { "class": "bc tall" }, items[c].map(function (x) {
              return H("button", { type: "button", "class": "card" + (c === "merged" ? " done" : ""), "data-open": x.r.j.id }, H("b", { text: x.tk.id + " · " + x.r.j.slug }), x.tk.objective,
                H("div", { "class": "chips" }, H("span", { "class": "chip " + (c === "passing" || c === "merged" ? "ok" : c === "retrying" ? "fail" : c === "building" ? "ag" : "mute"), text: c === "retrying" ? "✗ failing" : c }), H("span", { "class": "chip mute", text: "runs " + x.tk.runs })));
            }));
          }));
      }
      fill(views.board, head, H("div", { "class": "ox", "data-keep": "board" }, board));
    }
    function cardNode(r, t) {
      var j = r.j, tasks = j.tasks.map(function (tk) { return taskStatusAt(j, tk, t); });
      var pass = tasks.filter(function (s) { return s === "passing"; }).length, fail = tasks.filter(function (s) { return s === "failing"; }).length;
      var loops = j.history.filter(function (h) { return isRework(h.from, h.to) && P(h.at) <= t; }).length;
      var den = ACT.filter(function (a) { return a.job === j.id && a.phase === "denied" && P(a.at) <= t; }).length;
      var w = r.g && r.g !== "H4";
      return H("button", { type: "button", "class": "card" + (w ? " wait" : "") + (r.done ? " done" : ""), "data-open": j.id }, H("b", { text: j.slug }), w ? gv(r.g) + " (" + r.g + ")" : (NEXT[r.s] || wd("state", r.s)),
        H("div", { "class": "chips" }, j.epic ? H("span", { "class": "chip epic", text: epTag(j) }) : null, loops ? H("span", { "class": "chip", text: "↺ " + loops }) : null, fail ? H("span", { "class": "chip fail", text: "✗ " + fail }) : null,
          tasks.length ? H("span", { "class": "chip " + (pass === tasks.length ? "ok" : "mute"), text: pass + "/" + tasks.length }) : null, den ? H("span", { "class": "chip fail", text: "⊘ " + den }) : null,
          j.gate && j.gate.evaluated && stateAt(j, t) === j.state ? H("span", { "class": "chip " + (j.gate.pass ? "ok" : "fail"), text: "gate " + (j.gate.pass ? "✓" : "✗") }) : null,
          r.ag.length ? H("span", { "class": "chip ag", text: "● " + r.ag.length }) : null));
    }

    // ---------------------------------------------------------------- sheet 4: schedule & dimensions
    function renderSched() {
      var t = S.t, jobs = JOBS.filter(function (j) { return P(j.created_at) <= t; });
      var w = 1000, lx = 150, rowH = 30, top = 40, X = function (ms) { return lx + (ms - T0) / (TN - T0) * (w - lx - 10); };
      var hgt = top + jobs.length * rowH + 40, o = [];
      var stepH = (TN - T0) > 3 * DAY ? 24 * HOUR : (TN - T0) > DAY ? 6 * HOUR : 2 * HOUR;
      for (var h = Math.ceil(T0 / stepH) * stepH; h <= TN; h += stepH) { var xx = X(h); o.push(Z("line", { x1: xx, y1: top - 8, x2: xx, y2: top + jobs.length * rowH, "class": "ln3", "stroke-dasharray": "1 4" }), tx(xx, top - 14, stepH >= DAY ? fT(h).replace(/ \d\d:\d\d$/, "") : fHM(h), { "text-anchor": "middle", "font-size": 13, "class": "t-mono t2" })); }
      jobs.forEach(function (j, i) {
        var y = top + i * rowH;
        o.push(tx(10, y + 19, cut(j.slug, 18), { "font-size": 13, "class": "t-mono clickable", "data-open": j.id }));
        intervals(j, t).forEach(function (iv) {
          var st = S2STAGE[iv.state], g = GATE[iv.state] || iv.state === "pr_open", x1 = X(iv.a), x2 = Math.max(X(iv.b), x1 + 1.5);
          if (DONE_STATES[iv.state]) { o.push(Z("line", { x1: x1, y1: y + 15, x2: x2, y2: y + 15, "class": "ln3", "stroke-dasharray": "1 3" }), tx(x1 + 4, y + 19, (STOPPED_STATES[iv.state] ? "■ " : "✓ ") + (iv.state === "closed" ? "closed" : iv.state === "findings_delivered" ? "delivered" : words(iv.state)), { "font-size": 13, "class": "t-cond " + (STOPPED_STATES[iv.state] ? "t-fail" : "t-ok") })); return; }
          o.push(boxText(x1, y + 6, x2 - x1, 18, { fill: g ? "url(#bp-h-wait)" : "var(--ink)", "fill-opacity": g ? null : Math.min(.34, (STAGE_TONE[st] || .2) * .5 + .08), stroke: "var(--ink)", "stroke-width": .6 }));
          o[o.length - 1].appendChild(Z("title", null, j.slug + " · " + wd("state", iv.state) + " · " + fT(iv.a) + " for " + fD(iv.b - iv.a)));
          if (x2 - x1 > 30) o.push(tx(x1 + 3, y + 19, g ? (GATE[iv.state] || "H4") : stageLabel(st), { "font-size": 13, "class": "t-disp nopoint" + (g ? " on-hl" : ""), "font-weight": 700 }));
        });
        j.history.filter(function (hh) { return isRework(hh.from, hh.to) && P(hh.at) <= t; }).forEach(function (hh) { o.push(tx(X(P(hh.at)), y + 4, "↺", { "text-anchor": "middle", "font-size": 13, "class": "t-fail", "font-weight": 700 })); });
      });
      var nx = X(t);
      o.push(Z("line", { x1: nx, y1: top - 24, x2: nx, y2: top + jobs.length * rowH + 8, stroke: "var(--fail)", "stroke-width": 1.4, "stroke-dasharray": "16 3 3 3" }),
        tx(nx, top + jobs.length * rowH + 24, (live ? "now " : "rev ") + fHM(t), { "text-anchor": "middle", "font-size": 13, "class": "t-mono t-fail", "font-weight": 600 }));
      var chart = Z("svg", { viewBox: "0 0 " + w + " " + hgt, width: "100%", "class": "chart w900" }, o);
      // metrics
      var fin = jobs.map(function (j) { var hh = j.history.filter(function (x) { return DONE_STATES[x.to] && P(x.at) <= t; })[0]; return hh ? { j: j, lead: P(hh.at) - P(j.created_at), at: P(hh.at) } : null; }).filter(Boolean);
      var leads = fin.map(function (f) { return f.lead; }).sort(function (a, b) { return a - b; });
      var q = function (p) { return leads.length ? leads[Math.min(leads.length - 1, Math.floor(p * (leads.length - 1) + .5))] : 0; };
      var firstPass = fin.filter(function (f) { return !f.j.history.some(function (hh) { return isRework(hh.from, hh.to); }); }).length;
      var reached = jobs.filter(function (j) { return intervals(j, t).some(function (iv) { return S2STAGE[iv.state] === "build"; }); });
      var rew = reached.filter(function (j) { return reworksIn(j, 0, t).length; }).length;
      var hw = function (j) { return intervals(j, t).filter(function (iv) { return GATE[iv.state]; }).reduce(function (a, iv) { return a + iv.b - iv.a; }, 0); };
      var hws = jobs.map(hw).filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
      var thr = fin.filter(function (f) { return f.at > t - DAY; }).length;
      var kp = [["Lead time · median", leads.length ? fD(q(.5)) : "—", "p90 " + (leads.length ? fD(q(.9)) : "—") + " · " + fin.length + " finished"], ["Throughput", thr + " / 24 h", fin.length + " finished in all"],
        ["First-pass rate", fin.length ? Math.round(firstPass / fin.length * 100) + " %" : "—", firstPass + " of " + fin.length + " never sent back"],
        ["Rework rate", reached.length ? Math.round(rew / reached.length * 100) + " %" : "—", rew + " of " + reached.length + " jobs that reached Build"],
        ["Human wait · median", hws.length ? fD(hws[Math.floor((hws.length - 1) / 2)]) : "—", fD(hws.reduce(function (a, b) { return a + b; }, 0)) + " in all"]];
      var per = {}; ALLST.forEach(function (s) { per[s.key] = { work: 0, wait: 0 }; });
      jobs.forEach(function (j) { intervals(j, t).forEach(function (iv) { var st = S2STAGE[iv.state]; if (DONE_STATES[iv.state] || !per[st]) return; if (GATE[iv.state] || iv.state === "pr_open") per[st].wait += iv.b - iv.a; else per[st].work += iv.b - iv.a; }); });
      var stRows = STAGES.filter(function (s) { return s.key !== "done"; }).concat(SIDES.filter(function (s) { return s.key !== "stopped"; })).map(function (s) { return { label: s.label, work: per[s.key].work, wait: per[s.key].wait }; });
      var leadRows = fin.slice().sort(function (a, b) { return b.lead - a.lead; }).map(function (f) { return { label: f.j.slug, work: f.lead - hw(f.j), wait: hw(f.j), id: f.j.id }; });
      var openRows = jobs.filter(function (j) { return !DONE_STATES[stateAt(j, t)]; }).map(function (j) { return { label: j.slug, work: t - P(j.created_at) - hw(j), wait: hw(j), id: j.id }; }).sort(function (a, b) { return (b.work + b.wait) - (a.work + a.wait); });
      fill(views.sched,
        H("div", { "class": "viewhead" }, H("h2", { text: "Schedule & dimensions" }), H("p", { text: "one row per job over time · hatched = waiting on a human · " + (live ? "now" : "at " + fT(t)) })),
        H("div", { "class": "ox", "data-keep": "sched" }, chart),
        H("div", { "class": "kpis" }, kp.map(function (k) { return H("div", { "class": "kpi" }, H("div", { "class": "kk", text: k[0] }), H("div", { "class": "kv", text: k[1] }), H("div", { "class": "meta", text: k[2] })); })),
        H("div", { "class": "dims" }, H("div", null, dimChart("Lead time · finished jobs", leadRows, "d1"), dimChart("Age · open jobs (slowest first)", openRows, "d2")), H("div", null, dimChart("Time per station · all jobs", stRows, "d3"), gateWaitChart(jobs, t))));
    }
    function dimChart(title, rows, key) {
      var w = 520, lx = 150, rh = 40, top = 34, max = Math.max.apply(null, [1].concat(rows.map(function (r) { return r.work + r.wait; }))), sx = function (v) { return (v / max) * (w - lx - 16); };
      var o = [tx(10, 22, title, { "font-size": 15, "class": "t-disp", "font-weight": 700 })];
      if (!rows.length) o.push(tx(10, top + 18, "nothing yet at this revision", { "font-size": 13, "class": "t2" }));
      rows.forEach(function (r, i) {
        var y = top + i * rh, a = lx, b = lx + sx(Math.max(0, r.work)), c = b + sx(r.wait);
        o.push(tx(10, y + 29, cut(r.label, 17), { "font-size": 13, "class": "t-mono" + (r.id ? " clickable" : ""), "data-open": r.id || null }));
        o.push(Z("text", { x: w - 8, y: y + 12, "text-anchor": "end", "font-size": 13, "class": "t-mono" }, fD(r.work + r.wait), r.wait ? ts(" · " + fD(r.wait) + " human wait", { "class": "t2" }) : null));
        o.push(Z("line", { x1: a, y1: y + 12, x2: a, y2: y + 24, "class": "ln3" }), Z("line", { x1: c, y1: y + 12, x2: c, y2: y + 24, "class": "ln3" }));
        if (c - a > 16) o.push(Z("line", { x1: a + 1, y1: y + 18, x2: c - 1, y2: y + 18, "class": "ln2", "stroke-width": 1, "marker-start": "url(#bp-dimA)", "marker-end": "url(#bp-dimA)" }));
        o.push(boxText(a, y + 24, Math.max(1, b - a), 9, { fill: "var(--ink)", "fill-opacity": .6 }));
        if (r.wait) o.push(boxText(b, y + 24, Math.max(1.5, c - b), 9, { fill: "url(#bp-h-wait)", stroke: "var(--ink)", "stroke-width": .6 }));
      });
      return H("div", { "class": "ox mb", "data-keep": key }, Z("svg", { viewBox: "0 0 " + w + " " + (top + rows.length * rh + 10 + (rows.length ? 0 : 20)), width: "100%", "class": "chart w500" }, o));
    }
    function gateWaitChart(jobs, t) {
      var per = {}; jobs.forEach(function (j) { intervals(j, t).forEach(function (iv) { var g = GATE[iv.state] || (iv.state === "pr_open" ? "H4" : null); if (!g) return; (per[g] = per[g] || []).push(iv.b - iv.a); }); });
      var rows = ["Q", "H1", "H2", "HF", "H3", "HS", "A", "P", "H4"].filter(function (g) { return per[g]; }).map(function (g) { return { label: g + " · " + per[g].length + "×", work: 0, wait: per[g].reduce(function (a, b) { return a + b; }, 0) / per[g].length }; });
      return dimChart("Human wait per gate · mean", rows, "d4");
    }

    // ---------------------------------------------------------------- sheet 5: parts list
    function renderAgents() {
      var t = S.t, recs = ACT.filter(function (a) { return P(a.at) <= t; }), roles = {};
      recs.forEach(function (a) {
        var k = a.agent || "(agent not recorded)", r = roles[k] = roles[k] || { runs: 0, den: 0, last: null, iv: [] };
        if (a.phase === "start") { r.runs++; var j = JBY[a.job], lv = j && j.history.filter(function (h) { return h.from === a.state && P(h.at) >= P(a.at); })[0]; r.iv.push([P(a.at), null, a.job, lv ? P(lv.at) : null]); }
        if (a.phase === "stop") { var op = r.iv.slice().reverse().filter(function (x) { return x[1] == null && x[2] === a.job; })[0]; if (op) op[1] = P(a.at); }
        if (a.phase === "denied") r.den++; r.last = a;
      });
      var active = {}; S.agents.forEach(function (a) { active["factory:" + a.agent] = 1; });
      var order = ["factory:intent-mapper", "factory:verifier", "factory:intent-analyst", "factory:judge", "factory:contract-editor", "factory:god-eye", "factory:option-generator", "factory:researcher", "factory:architect", "factory:threat-modeler", "factory:planner", "factory:slicer", "factory:builder", "factory:tester", "factory:integrator", "factory:code-reviewer", "factory:test-reviewer", "factory:security-reviewer", "factory:ux-reviewer", "factory:finding-verifier", "factory:lesson-writer"];
      var keys = order.concat(Object.keys(roles).filter(function (k) { return order.indexOf(k) < 0; }).sort());
      var bw = 260;
      var rowsN = keys.map(function (k, i) {
        var r = roles[k] || { runs: 0, den: 0, iv: [], last: null }, on = !!active[k];
        var bars = [Z("line", { x1: 0, y1: 9, x2: bw, y2: 9, "class": "ln3", "stroke-dasharray": "1 3" })];
        r.iv.forEach(function (iv) {
          var end = iv[1] || (iv[3] != null ? Math.min(iv[3], t) : t), lv = !iv[1] && (iv[3] == null || iv[3] > t) && on;
          var a = (iv[0] - T0) / (TN - T0) * bw, b = (end - T0) / (TN - T0) * bw;
          bars.push(boxText(a, 4, Math.max(2, b - a), 10, { fill: lv ? "var(--agent)" : "var(--ink)", "fill-opacity": lv ? 1 : .6 }));
          bars[bars.length - 1].appendChild(Z("title", null, short(iv[2]) + " " + fT(iv[0]) + " for " + fD(end - iv[0])));
        });
        var nx = (t - T0) / (TN - T0) * bw; bars.push(Z("line", { x1: nx, y1: 0, x2: nx, y2: 18, stroke: "var(--fail)", "stroke-dasharray": "4 2" }));
        var la = r.last ? fHM(P(r.last.at)) + " " + (r.last.phase === "denied" ? "refused " + (r.last.command || r.last.tool) : r.last.phase === "stop" ? "finished" : "started") + " · " + short(r.last.job) : "—";
        return H("tr", null, H("td", { "class": "item", text: String(i + 1) }), H("td", null, on ? H("span", { "class": "dotl inl" }) : null, H("b", { text: agentLabel(k) }), on ? [" ", H("span", { "class": "chip ag", text: "at work" })] : null),
          H("td", { "class": "n", text: String(r.runs) }), H("td", { "class": "n" + (r.den ? " bad" : ""), text: String(r.den) }),
          H("td", null, Z("svg", { width: bw, height: 18, viewBox: "0 0 " + bw + " 18" }, bars)), H("td", { "class": "mono last", text: la }));
      });
      var den = recs.filter(function (a) { return a.phase === "denied"; }), groups = {}; den.forEach(function (a) { var k = a.reason || "no reason recorded"; (groups[k] = groups[k] || []).push(a); });
      fill(views.agents,
        H("div", { "class": "viewhead" }, H("h2", { text: "Parts list" }), H("p", { text: "bill of materials · every agent role, what it did " + (live ? "so far" : "up to " + fT(t)) })),
        H("div", { "class": "ox", "data-keep": "bom" }, H("table", { "class": "bom" }, H("thead", null, H("tr", null, ["Item", "Part · role", "Runs", "Refused", "Runs over time", "Last action"].map(function (x) { return H("th", { text: x }); }))), H("tbody", null, rowsN))),
        H("div", { "class": "viewhead", style: { "margin-top": "22px" } }, H("h2", { "class": "sm", text: "Refused actions" }), H("p", { text: "the guard hook said no · " + den.length + " in all · grouped by reason" })),
        Object.keys(groups).length ? Object.keys(groups).sort(function (a, b) { return groups[b].length - groups[a].length; }).map(function (k) {
          return H("div", { "class": "pane mb12" }, H("h4", null, H("span", { "class": "plain", text: k }), H("em", { text: "×" + groups[k].length })),
            H("div", { "class": "pb" }, H("ul", { "class": "lst" }, groups[k].map(function (a) {
              return H("li", null, H("span", { "class": "when", text: fT(P(a.at)) }), H("span", null, H("code", { "class": "mono", text: a.command || a.tool || "?" }), " · " + (a.agent ? agentLabel(a.agent) : "agent not recorded") + " on ",
                JBY[a.job] ? H("button", { type: "button", "class": "linkbtn sm", "data-open": a.job }, short(a.job)) : short(a.job), " ", H("span", { "class": "meta", text: "(" + (a.state || "?") + ")" })));
            }))));
        }) : H("p", { "class": "meta", text: "Nothing refused yet." }));
    }

    // ---------------------------------------------------------------- sheet 6: general notes
    function renderLearn() {
      var t = S.t, ls = D.lessons.filter(function (l) { return P(l.created_at) <= t; });
      // in use: accepted or promoted (lessons.js), as decided by this revision
      var inUse = function (l) { return (l.status === "accepted" || l.status === "promoted") && (!l.decided || P(l.decided.at) <= t); };
      var lessonPane = H("div", { "class": "pane mb" }, H("h4", null, "Lessons", H("em", { text: ls.filter(inUse).length + " in use · " + S.lessonsWaiting.length + " waiting on you" })),
        H("div", { "class": "pb" }, !ls.length ? H("span", { "class": "meta", text: "No lessons yet at this revision." }) : null,
          ls.map(function (l, i) {
            var waiting = S.lessonsWaiting.indexOf(l) >= 0;
            return H("div", { "class": "gnote" }, H("div", { "class": "gn", text: (i + 1) + "." }), H("div", null,
              H("div", { "class": "rule" }, waiting ? [H("span", { "class": "chip hl", text: "waiting on you" }), " "] : null, l.rule),
              H("div", { "class": "why", text: l.id + " · " + l.why + (l.scope.length ? " · applies to " + l.scope.join(", ") : "") }),
              H("div", { "class": "counters" }, H("span", { "class": "chip " + (inUse(l) ? "ok" : l.status === "rejected" ? "fail" : "mute"), text: l.decided && P(l.decided.at) <= t ? l.decided.status : "proposed" }),
                l.decided && P(l.decided.at) <= t ? H("span", { "class": "chip mute", text: (l.decided.status || "decided") + " by " + (l.decided.by || "?") + " " + fT(P(l.decided.at)) + (l.decided.note ? " — “" + l.decided.note + "”" : "") }) : null),
              l.evidence.length ? H("div", { "class": "why", text: "from: " + l.evidence.map(function (e) { return short(e.job) + (e.text ? " — " + e.text : ""); }).join("; ") }) : null,
              waiting ? H("div", { "class": "reply" }, H("div", { "class": "lbl", text: "Reply in chat" }), H("div", { "class": "row" }, H("code", { text: "accept lesson " + l.id }), copyBtn("accept lesson " + l.id)),
                H("div", { "class": "row" }, H("code", { text: "reject lesson " + l.id + " <why>" }), copyBtn("reject lesson " + l.id + " "))) : null));
          })));
      var rounds = JOBS.filter(function (j) { return j.reviews.length || j.history.some(function (h) { return h.to === "reviewing"; }); }).map(function (j) {
        var rv = j.reviews.filter(function (v) { return !v.post_merge && P(v.at) <= t; }), n = rv.reduce(function (m, v) { return Math.max(m, v.round || 0); }, 0), max = j.max_review_rounds || n;
        var f = rv.reduce(function (a, v) { return a + v.findings.length; }, 0), dis = rv.reduce(function (a, v) { return a + v.dismissed; }, 0);
        return H("div", { "class": "crit wide" }, H("button", { type: "button", "class": "linkbtn mono sm", "data-open": j.id }, j.slug),
          H("span", { "class": n > max ? "t-fail" : null }, "●".repeat(Math.min(n, 9)) + "○".repeat(Math.max(0, max - n)) + " ", H("span", { "class": "meta", text: (n ? roundText(j, n) : "no round yet") + " · " + plural(f, "finding") })), H("span", { "class": "chip " + (dis ? "" : "mute"), text: dis + " refuted" }));
      });
      var st = D.standards;
      var stdPane = H("div", { "class": "pane mb" }, H("h4", null, "Standards in force", H("em", { text: st.adopted.join(", ") || "none adopted" })),
        H("div", { "class": "pb" }, H("div", { "class": "subhead", text: "Checks · run as gates" }),
          st.checks.length ? st.checks.map(function (c) { return H("div", { "class": "gnote narrow" }, H("div", { "class": "gn sm", text: "◆" }), H("div", null, H("div", { "class": "rule mono", text: c.name || "" }), H("div", { "class": "why", text: c.why || "" }), c.cmd ? H("code", { "class": "cmd", text: "$ " + c.cmd }) : null)); }) : H("p", { "class": "meta", text: "No checks." }),
          H("div", { "class": "subhead gap", text: "Advisory rules · given to reviewers" }),
          st.rules.length ? st.rules.map(function (r) {
            return H("div", { "class": "gnote" }, H("div", { "class": "gn sm", text: r.id || "" }), H("div", null, H("div", { "class": "rule sm", text: r.rule || "" }), H("div", { "class": "why", text: r.why || "" }),
              r.example ? H("div", { "class": "why" }, H("i", { text: "e.g." }), " " + r.example) : null,
              r.lanes.length ? H("div", { "class": "counters" }, H("span", { "class": "chip mute", text: r.lanes.join(", ") })) : null));
          }) : H("p", { "class": "meta", text: "No advisory rules." })));
      fill(views.learn,
        H("div", { "class": "viewhead" }, H("h2", { text: "General notes" }), H("p", { text: "lessons the factory learned and the standards in force · injected into plan, build and review" })),
        H("div", { "class": "two" }, H("div", null, lessonPane, H("div", { "class": "pane" }, H("h4", null, "Review rounds · suppressions per job", H("em", { text: "converging?" })), H("div", { "class": "pb" }, rounds.length ? rounds : H("span", { "class": "meta", text: "No reviews yet." })))),
          H("div", null, stdPane)));
    }

    // ---------------------------------------------------------------- epics: helpers (sheets 7-9 are drawn from the latest data)
    function epById(id) { for (var i = 0; i < D.epics.length; i++) if (D.epics[i].id === id) return D.epics[i]; return null; }
    function epOfJob(j) {
      if (!j || !j.epic) return null; var k = String(j.epic);
      return epById(k) || D.epics.filter(function (e) { return e.slug === k || short(String(e.id).replace(/^E/, "")) === short(k.replace(/^E/, "")); })[0] || null;
    }
    function epTag(j) { if (!j || !j.epic) return null; var e = epOfJob(j); return (j.slice ? j.slice + " · " : "") + (e ? e.slug : short(String(j.epic).replace(/^E/, ""))); }
    function epOpen(e) { return e.stage !== "complete" && e.stage !== "stopped"; }
    function epGates() { return D.epics.filter(function (e) { return e.waiting_on.who === "you"; }); }
    function epCur() { var e = epSel ? epById(epSel) : null; return e || epById(APP.epicPick.preferred(epEntries())) || D.epics[0] || null; }
    function goEpic(id, v) {
      if (!epById(id)) return;
      epSel = id; try { window.localStorage.setItem("dx-blueprint-epic", id); } catch (er) { /* storage blocked: the choice lasts this visit */ }
      if (sel) closeSection(); if (notesOpen) setNotes(false);
      setView(EPIC_VIEWS[v] && v !== "epics" ? v : v === "epics" ? "epics" : "eflow");
      views[view].scrollTop = 0;
    }
    // time in the current stage: since the first move of the trailing run of moves into it
    function epSince(e) {
      var at = null;
      for (var i = e.history.length - 1; i >= 0; i--) { if (epStageOf(e.history[i].to) === e.stage) at = P(e.history[i].at); else break; }
      return at || P(e.updated_at) || P(e.created_at) || TN;
    }
    function epWaitSince(e) { var h = e.history[e.history.length - 1]; return h && h.to === e.state ? P(h.at) : P(e.updated_at) || epSince(e); }
    function epWhat(e) { var g = e.waiting_on.gate; return g && g !== "?" ? gv(g) : cap(e.waiting_on.what || "decide"); }
    function epReply(e) {
      var r = e.waiting_on.reply, g = e.waiting_on.gate;
      if (r) { var parts = String(r).split(/\s+·\s+/); return { main: parts[0], alt: parts.length > 1 ? "or: " + parts.slice(1).join(" · ") : "" }; }
      if (g === "P") return { main: "resume <state>", alt: "or: cancel --reason \"…\" · abandon --reason \"…\"" };
      return { main: "approve", alt: "or: deny <what must change>" };
    }
    var EPK = EP_STAGES.map(function (s) { return s.key; });
    // which main stage the epic is at (or, on a side track, the last main stage it reached)
    function epMainIdx(e) {
      var i = EPK.indexOf(e.stage); if (i >= 0) return { i: i, side: null };
      var last = 0; e.history.forEach(function (h) { var j = EPK.indexOf(epStageOf(h.to)); if (j >= 0) last = j; else { j = EPK.indexOf(epStageOf(h.from)); if (j >= 0) last = j; } });
      return { i: last, side: e.stage };
    }
    function epSpan(e, key) {
      var a = null, b = null, ki = EPK.indexOf(key);
      e.history.forEach(function (h) { var k = epStageOf(h.to); if (k === key && a == null) a = P(h.at); else if (a != null && b == null && EPK.indexOf(k) > ki) b = P(h.at); });
      return a == null ? null : { a: a, b: b };
    }
    // a gate: passed (by whom, when), waiting on you, denied (sent back) how often, or still ahead
    function epGateState(e, g) {
      var f = EP_GATE_FROM[g], fi = EPK.indexOf(epStageOf(f)), pass = null, denied = 0;
      if (f) e.history.forEach(function (h) { if (h.from !== f) return; var ti = EPK.indexOf(epStageOf(h.to)); if (ti > fi) pass = h; else if (ti === fi) denied++; });
      var on = e.waiting_on.who === "you" && e.waiting_on.gate === g;
      var cur = epMainIdx(e);
      if (!pass && fi >= 0 && cur.i > fi) pass = { by: null, at: null };
      return { on: on, pass: pass, denied: denied };
    }
    function slInfo(s) {
      var j = s.job ? JBY[s.job] : null, st = j ? j.state : (s.job_state || null);
      var stage = st ? (S2STAGE[st] || s.station || null) : (s.station || null);
      var done = !!(st && DONE_STATES[st]);
      var ag = j ? activeAgents(j, TN) : [], g = j ? gateOf(j, TN) : null;
      var failing = !!(j && !done && (j.tasks.some(function (k) { return k.status === "failing"; }) || gateFailing(j, TN)));
      return { s: s, j: j, st: st, stage: stage, label: stage ? stageLabel(stage) : null, done: done, ag: ag, g: g && g !== "H4" ? g : null, failing: failing, started: !!st };
    }
    function slLevels(sl) {
      var by = {}, lv = {}; sl.forEach(function (s) { by[s.slice] = s; });
      var lev = function (id) {
        if (lv[id] != null) return lv[id]; var s = by[id]; lv[id] = 0;
        var d = s ? s.depends_on.filter(function (x) { return by[x] && x !== id; }) : [];
        if (d.length) lv[id] = 1 + Math.max.apply(null, d.map(lev));
        return lv[id];
      };
      sl.forEach(function (s) { lev(s.slice); }); return lv;
    }
    function slOrder(e) { var lv = slLevels(e.slices); return e.slices.slice().sort(function (a, b) { return lv[a.slice] - lv[b.slice] || (a.slice < b.slice ? -1 : a.slice > b.slice ? 1 : 0); }); }
    function slNext(e, info) { return e.slices.filter(function (s) { return s.next_to_start; })[0] || slOrder(e).filter(function (s) { return !info[s.slice].started; })[0] || null; }
    function epRounds(e) {
      return Object.keys(e.rounds).map(function (k) { var r = e.rounds[k]; return { kind: k, r: r, over: r.max > 0 && r.round > r.max, txt: k + " round " + r.round + (r.max ? " of " + r.max : "") }; });
    }
    function epAsOf() { return live ? "live · " + fT(TN) : "replay moves the line only: this sheet shows the latest data, " + fT(TN); }
    function bindChip(b) {
      var ok = /match/.test(b || ""), bad = /stale/.test(b || "");
      return H("span", { "class": "chip " + (ok ? "ok" : bad ? "fail" : "mute"), text: ok ? "✓ " + b : bad ? "✗ " + b : (b || "not bound") });
    }
    function emptyEpics() {
      return H("div", { "class": "pane" }, H("h4", null, "No epics"), H("div", { "class": "pb" },
        H("p", { "class": "meta", text: "No epic is open in this repository. Work too big for one job goes in as an epic: it is drawn here from intent to its slices, and each slice runs on the line (sheet 1) as an ordinary job tagged with its epic." })));
    }
    // the epic picker of sheets 8 and 9: one <select> per sheet, kept across renders (APP.epicPick tells same-slug epics apart)
    var epSelects = {};
    function epEntries() { return D.epics.map(function (e) { return APP.epicPick.fromDisplay(e, e.waiting_on.who === "you"); }); }
    function epPicker(v) {
      var cur = epCur(); if (D.epics.length < 2) return null;
      var sel = epSelects[v];
      if (!sel) {
        sel = epSelects[v] = APP.epicPick.make({ cls: "bp-esel", id: "bp-esel-" + v, onPick: function (id) { goEpic(id, v); } });
        sel.setAttribute("data-epick", v);
      }
      APP.epicPick.fill(sel, epEntries(), cur ? cur.id : null);
      return H("div", { "class": "epick" }, H("label", { "class": "epl", "for": "bp-esel-" + v, text: "Epic" }), sel);
    }
    function fitIn(n) { [].forEach.call(n.querySelectorAll("[data-fit]"), function (t) { fitText(t, +t.getAttribute("data-fit")); }); }
    function zoneNums(o, Wd) {
      for (var i = 0; i < 8; i++) {
        o.push(tx(Wd * (i + .5) / 8, 11, String(i + 1), { "text-anchor": "middle", "class": "t-mono t3", "font-size": 13 }));
        if (i) o.push(Z("line", { x1: Wd * i / 8, y1: 0, x2: Wd * i / 8, y2: 6, "class": "ln3" }));
      }
    }
    function keyRow(x, y, items) {
      var g = Z("g", { "class": "legend" });
      items.forEach(function (it) { kids(g, [it[1](x), tx(x + it[2], y + 4.5, it[0], { "font-size": 13, "class": "t2" })]); x += it[2] + measure(it[0], "t2", 13) + 18; });
      return g;
    }
    function drawingSvg(n, key, Wd, dr, label) {
      var avail = Math.max(320, (n.clientWidth || 1100) - 4), fits = Wd <= avail + 1;
      return [fits ? null : H("p", { "class": "swipehint eswipe", text: "Drawing at full scale: swipe sideways to read all of it." }), H("div", { "class": "ox edwrap", "data-keep": key }, Z("svg", { "class": "edraw", viewBox: "0 0 " + Wd + " " + Math.round(dr.H), width: fits ? "100%" : Wd, height: fits ? null : Math.round(dr.H), role: "group", "aria-label": label }, dr.nodes))];
    }
    function drawW(n) { return Math.max(1100, Math.floor(Math.max(320, (n.clientWidth || 1100) - 4))); }
    function waitPane(e) {
      if (e.waiting_on.who !== "you") return null; var g = e.waiting_on.gate || "?";
      return H("div", { "class": "pane gatep mb ewait" }, H("h4", null, H("span", null, e.slug + " waits on you ", H("span", { "class": "chip tag", text: g })), H("em", { text: "waiting " + fD(TN - epWaitSince(e)) })),
        H("div", { "class": "pb" }, H("div", { "class": "what", text: epWhat(e) }), replyBox(epReply(e), e.waiting_on.command, true)));
    }

    // ---------------------------------------------------------------- sheet 7: epic register (every epic, by stage and by who acts next)
    function epCard(e) {
      var you = e.waiting_on.who === "you", ag = e.agents_at_work.length, rd = epRounds(e), dl = e.delivery;
      return H("button", { type: "button", "class": "card ecard" + (you ? " wait" : "") + (!epOpen(e) ? " done" : ""), "data-epic": e.id, "data-epic-view": "eflow", "aria-label": "Epic " + e.slug + ", " + (EP_LABEL[e.stage] || e.stage) + ": open its assembly drawing" },
        H("b", { text: e.slug }), H("span", { "class": "ewhat", text: you ? epWhat(e) + " (" + (e.waiting_on.gate || "?") + ")" : (e.meaning || "") }),
        // a small title block: one fact per line
        H("dl", { "class": "etb" },
          H("dt", { text: "risk" }), H("dd", { "class": e.risk === "high" ? "bad" : null, text: e.risk + (e.flag ? " · ⚑ " + e.flag : "") }),
          H("dt", { text: "criteria" }), H("dd", { "class": dl.e_criteria_total && dl.e_criteria_delivered >= dl.e_criteria_total ? "ok" : null, text: dl.e_criteria_delivered + " of " + dl.e_criteria_total + " delivered" }),
          H("dt", { text: "slices" }), H("dd", { text: dl.slices_merged + " / " + dl.slices_total }),
          rd.length ? [H("dt", { text: "rounds" }), H("dd", { "class": rd.some(function (x) { return x.over; }) ? "bad" : null, text: rd.map(function (x) { return x.txt; }).join(" · ") })] : null,
          H("dt", { text: "in stage" }), H("dd", { text: fD(TN - epSince(e)) }),
          ag ? [H("dt", { text: "at work" }), H("dd", { "class": "ag", text: "● " + plural(ag, "agent") })] : null));
    }
    function renderRegister() {
      var EPS = D.epics;
      var head = H("div", { "class": "viewhead" }, H("h2", { text: "Epic register" }), H("p", { text: "drawing register · every epic by stage and by who acts next · " + epAsOf() }));
      if (!EPS.length) { fill(views.epics, head, emptyEpics()); return; }
      var issued = epGates().map(function (e) {
        var g = e.waiting_on.gate || "?";
        return H("div", { "class": "pane gatep" }, H("h4", null, H("span", null, e.slug + " ", H("span", { "class": "chip tag", text: g })), H("em", { text: "waiting " + fD(TN - epWaitSince(e)) })),
          H("div", { "class": "pb" }, H("div", { "class": "what", text: epWhat(e) }),
            H("div", { "class": "meta" }, (EP_LABEL[e.stage] || e.stage) + " · " + e.risk + " risk · ", H("button", { type: "button", "class": "linkbtn sm", "data-epic": e.id, "data-epic-view": "eflow" }, "assembly drawing"), " · ",
              H("button", { type: "button", "class": "linkbtn sm", "data-epic": e.id, "data-epic-view": "ebreak" }, "exploded view")),
            replyBox(epReply(e), e.waiting_on.command)));
      });
      // rows: the epic's own stages in order, then the side tracks; columns: who acts next. Empty stages stay a thin row.
      var stg = EPK.concat(["changing", "parked", "stopped"]);
      var who = [["you", "Waiting on you"], ["agent", "Agents' turn"], ["nobody", "Nobody acting"]];
      var whoOf = function (e) { var w = e.waiting_on.who; return w === "you" ? "you" : w === "agent" ? "agent" : "nobody"; };
      var board = H("div", { "class": "board eboard" }, H("div", { "class": "bh" }, "Stage"),
        who.map(function (w) { var n = EPS.filter(function (e) { return whoOf(e) === w[0]; }).length; return H("div", { "class": "bh" + (w[0] === "you" && n ? " hl" : ""), text: w[1] + " · " + n }); }),
        stg.map(function (c, i) {
          var here = EPS.filter(function (e) { return e.stage === c; }), side = i >= EPK.length;
          return [H("div", { "class": "rh" + (side ? " side" : "") + (here.length ? "" : " empty") + (side && i === EPK.length ? " first" : "") },
              H("small", { text: side ? "side" : p2(i + 1) }), " " + EP_LABEL[c], here.length ? H("span", { "class": "bn", text: String(here.length) }) : null),
            who.map(function (w) { return H("div", { "class": "bc" + (side ? " side" : "") + (here.length ? "" : " empty") + (side && i === EPK.length ? " first" : "") }, here.filter(function (e) { return whoOf(e) === w[0]; }).map(epCard)); })];
        }));
      var order = EPS.slice().sort(function (a, b) {
        var ra = a.waiting_on.who === "you" ? 0 : epOpen(a) ? 1 : 2, rb = b.waiting_on.who === "you" ? 0 : epOpen(b) ? 1 : 2;
        return ra - rb || P(b.updated_at) - P(a.updated_at);
      });
      var ths = ["No.", "Drawing · epic", "Stage", "Who acts next", "Risk", "Flag", "Epic criteria", "Slices", "Rounds", "In stage", "Revised"];
      var table = H("div", { "class": "ox", "data-keep": "ereg" }, H("table", { "class": "bom ereg" }, H("thead", null, H("tr", null, ths.map(function (x) { return H("th", { text: x }); }))),
        H("tbody", null, order.map(function (e, i) {
          var you = e.waiting_on.who === "you", rd = epRounds(e), dl = e.delivery;
          return H("tr", { "data-epic": e.id, "data-epic-view": "eflow", tabindex: 0, "class": you ? "you" : null, title: "Open the assembly drawing of " + e.slug },
            H("td", { "class": "item", text: "E" + (i + 1) }),
            H("td", null, H("b", { "class": "eslug", text: e.slug }), H("div", { "class": "meta", text: e.meaning })),
            H("td", null, H("span", { "class": "chip " + (epOpen(e) ? "" : "mute"), text: (EPK.indexOf(e.stage) >= 0 ? p2(EPK.indexOf(e.stage) + 1) + " " : "") + (EP_LABEL[e.stage] || e.stage) })),
            H("td", null, you ? H("span", { "class": "chip hl", text: (e.waiting_on.gate || "?") + " · you" }) : H("span", { "class": "chip " + (e.waiting_on.who === "agent" ? "ag" : "mute"), text: e.waiting_on.who === "agent" ? (e.agents_at_work.length ? "● " : "") + "agents" : "nobody" }),
              e.waiting_on.what && !you ? H("div", { "class": "meta", text: e.waiting_on.what }) : null),
            H("td", { "class": e.risk === "high" ? "bad" : null, text: e.risk }),
            H("td", { "class": "mono", text: e.flag || "—" }),
            H("td", { "class": "n", text: dl.e_criteria_delivered + " / " + dl.e_criteria_total }),
            H("td", { "class": "n", text: dl.slices_merged + " / " + dl.slices_total }),
            H("td", { "class": "mono" + (rd.some(function (x) { return x.over; }) ? " bad" : ""), text: rd.map(function (x) { return x.txt; }).join(" · ") || "—" }),
            H("td", { "class": "mono", text: fD(TN - epSince(e)) }),
            H("td", { "class": "mono", text: fT(P(e.updated_at)) }));
        }))));
      fill(views.epics, head,
        issued.length ? [H("div", { "class": "viewhead sub" }, H("h2", { "class": "sm", text: "Issued for approval" }), H("p", { text: plural(issued.length, "epic gate") + " wait on you · copy the reply into chat" })), H("div", { "class": "eissue" }, issued)] : null,
        H("div", { "class": "viewhead sub" }, H("h2", { "class": "sm", text: "Register by stage" }), H("p", { text: "rows: the epic's own stages, then the side tracks · columns: who acts next · click an epic for its assembly drawing" })),
        H("div", { "class": "ox mb", "data-keep": "eboard" }, board),
        H("div", { "class": "viewhead sub" }, H("h2", { "class": "sm", text: "Drawing register" }), H("p", { text: plural(EPS.length, "epic") + " · " + EPS.filter(epOpen).length + " in flight" })),
        table);
    }

    // ---------------------------------------------------------------- sheet 8: epic assembly drawing (one epic's own process)
    function epBankGroups(st) {
      var out = [], by = {};
      st.members.forEach(function (m) { if (by[m[0]]) { by[m[0]].n++; return; } by[m[0]] = { role: m[0], n: 1, name: m[1] }; out.push(by[m[0]]); });
      return out;
    }
    function epBankRows(e, st) { if (st.key === "delivery") return Math.max(2, Math.min(6, e.slices.length) + (e.slices.length > 6 ? 1 : 0)); return Math.max(2, epBankGroups(st).length); }
    function epMarker(e, x, y, w) {
      var you = e.waiting_on.who === "you", ag = e.agents_at_work.length, h = 38;
      var rk = Object.keys(e.rounds).filter(function (k) { return ROUND_STAGE[k] === e.stage; })[0], rd = rk ? e.rounds[rk] : null;
      var meta = fD(TN - epSince(e)) + (you ? " · " + (e.waiting_on.gate || "you") : "") + (rd ? " · ↺ R" + rd.round + (rd.max ? "/" + rd.max : "") : "")
        + (e.stage === "delivery" ? " · " + e.delivery.slices_merged + "/" + e.delivery.slices_total + " merged" : "");
      return Z("g", Object.assign({ "class": "mk emk" + (you ? " wait" : ag ? " run" : ""), transform: "translate(" + x + " " + y + ")" }, you ? { "data-notes": "epic", tabindex: 0, role: "button", "aria-label": e.slug + " waits on you: open the notes" } : {}),
        Z("title", null, e.slug + " · " + e.meaning),
        Z("rect", { "class": "body", x: 0, y: 0, width: w, height: h, rx: 1.5 }),
        tx(5, 15, e.slug, { "font-size": 15, "class": "t-cond lbl", "data-fit": w - 10 }),
        tx(5, 32, meta, { "font-size": 13, "class": "t-cond meta2", "font-weight": 500, "data-fit": w - (ag ? 24 : 10) }),
        ag ? [Z("circle", { cx: w - 9, cy: h - 9, r: 4, fill: "var(--agent)" }), Z("circle", { cx: w - 9, cy: h - 9, r: 4, "class": "lamp-ring pulse" })] : null);
    }
    function epKey(x, y) {
      return keyRow(x, y, [
        ["passed", function (x0) { return Z("line", { x1: x0, y1: y, x2: x0 + 24, y2: y, "class": "flow", "marker-end": "url(#bp-arw)" }); }, 30],
        ["at work", function (x0) { return Z("line", { x1: x0, y1: y, x2: x0 + 24, y2: y, "class": "flow hot", "marker-end": "url(#bp-arw-run)" }); }, 30],
        ["ahead", function (x0) { return Z("line", { x1: x0, y1: y, x2: x0 + 24, y2: y, "class": "flow pend" }); }, 30],
        ["side track", function (x0) { return Z("line", { x1: x0, y1: y, x2: x0 + 24, y2: y, "class": "side-ln", "marker-end": "url(#bp-arw-pk)" }); }, 30],
        ["agent at work", function (x0) { return Z("circle", { cx: x0 + 6, cy: y, r: 5.5, "class": "lamp on" }); }, 16],
        ["gate waits on you", function (x0) { return boxText(x0, y - 7, 22, 14, { "class": "hl-fill", stroke: "var(--ink)", "stroke-width": 1, rx: 7 }); }, 28],
        ["gate passed", function (x0) { return boxText(x0, y - 7, 22, 14, { "class": "paperfill", stroke: "var(--ok)", "stroke-width": 1.4, rx: 7 }); }, 28]]);
    }
    function epGateSym(cx, cy, g, gs) {
      var w = 38, h = 20;
      return Z("g", null, Z("title", null, "your decision " + g + ": " + gv(g) + (gs.on ? " · waits on you" : gs.pass ? " · passed" : " · ahead")),
        gs.on ? boxText(cx - w / 2, cy - h / 2, w, h, { "class": "balloon-glow pulse", rx: 10 }) : null,
        boxText(cx - w / 2, cy - h / 2, w, h, { rx: 10, "class": gs.on ? "gate-on" : "paperfill", stroke: gs.on ? "var(--ink)" : gs.pass ? "var(--ok)" : "var(--ink-3)", "stroke-width": gs.pass && !gs.on ? 1.6 : 1.3, "stroke-dasharray": !gs.on && !gs.pass ? "3 2" : null }),
        tx(cx, cy + 4.5, g, { "text-anchor": "middle", "font-size": 13, "class": "t-mono" + (gs.on ? " on-hl" : gs.pass ? " t-ok" : " t2"), "font-weight": 700 }));
    }
    function epCallout(o, bx, by, gx, gy, lane, g, gs, room) {
      // a balloon in the callout row, an orthogonal leader down to its gate on the process line, two lines of text beside it
      var w = 46, h = 26;
      o.push(Z("path", { d: "M" + bx + " " + (by + h / 2) + " V" + lane + " H" + gx + " V" + (gy - 11), "class": gs.on ? "ln" : "ln2", "stroke-width": gs.on ? 1.3 : 1, "marker-end": "url(#bp-dot)", "stroke-dasharray": gs.on || gs.pass ? null : "3 3" }));
      if (gs.on) o.push(boxText(bx - w / 2, by - h / 2, w, h, { "class": "balloon-glow pulse", rx: 13 }));
      o.push(boxText(bx - w / 2, by - h / 2, w, h, { rx: 13, "class": gs.on ? "balloon" : "paperfill", stroke: gs.on ? "var(--ink)" : gs.pass ? "var(--ok)" : "var(--ink-3)", "stroke-width": gs.on ? 1.3 : 1.5, "stroke-dasharray": !gs.on && !gs.pass ? "4 3" : null }),
        tx(bx, by + 5.5, g, { "text-anchor": "middle", "font-size": 15, "class": "t-disp" + (gs.on ? " on-hl" : gs.pass ? " t-ok" : " t2"), "font-weight": 700 }));
      var l1 = gv(g);
      var l2 = gs.on ? "waits on you now" : gs.pass ? "✓ passed" + (gs.pass.by ? " · " + gs.pass.by : "") + (gs.pass.at ? " · " + fT(P(gs.pass.at)) : "") + (gs.denied ? " · " + wd("revise") + " ×" + gs.denied : "") : gs.denied ? wd("revise") + " ×" + gs.denied + " · ahead" : "ahead";
      o.push(tx(bx + w / 2 + 8, by - 2, l1, { "font-size": 13.5, "class": "t-disp", "font-weight": 700, "data-fit": room }),
        tx(bx + w / 2 + 8, by + 15, l2, { "font-size": 13, "class": "t-cond" + (gs.on ? " cl-on" : gs.pass ? " t-ok" : " t3"), "font-weight": 600, "data-fit": room }));
    }
    function roundDetail(e, kind, r, x, y, w, letter) {
      var h = 170, stg = ROUND_STAGE[kind] || kind, here = e.stage === stg, live = here && e.agents_at_work.length > 0, g = Z("g");
      var over = r.max > 0 && r.round > r.max, ge = r.god_eye;
      kids(g, [detailBox(x, y, w, h, letter, cap(kind) + " rounds", "round " + r.round + (r.max ? " of " + r.max : "") + (over ? " + " + (r.round - r.max) + " God Eye-only" : "") + (here ? "" : " · closed"),
        live ? "agents at work" : here ? "open" : "closed", live)]);
      // the round dial: one circle per round; past the maximum they are drawn in red
      var nC = Math.max(r.round, r.max, 1), pitch = Math.max(12, Math.min(24, (w - 170) / nC)), dx = x + 18;
      kids(g, [tx(x + 10, y + 78, "Rounds", { "font-size": 13, "class": "t-disp", "font-weight": 700 })]);
      for (var k = 1; k <= nC; k++) {
        var cxk = x + 104 + (k - 1) * pitch, used = k <= r.round, past = r.max > 0 && k > r.max, cur = k === r.round && here;
        kids(g, [cur && live ? Z("circle", { cx: cxk, cy: y + 73, r: 6.5, "class": "lamp-ring pulse" }) : null,
          Z("circle", { cx: cxk, cy: y + 73, r: 6.5, fill: used ? (past ? "var(--fail)" : "var(--ink)") : "none", stroke: past ? "var(--fail)" : used ? "var(--ink)" : "var(--ink-3)", "stroke-width": 1.3, "stroke-dasharray": used ? null : "2 2" }),
          k === r.max && r.max < nC ? Z("line", { x1: cxk + pitch / 2, y1: y + 62, x2: cxk + pitch / 2, y2: y + 84, stroke: "var(--fail)", "stroke-width": 1.4, "stroke-dasharray": "3 2" }) : null]);
      }
      kids(g, [tx(x + w - 10, y + 78, r.round + (r.max ? " / " + r.max : ""), { "text-anchor": "end", "font-size": 20, "class": "t-disp" + (over ? " t-fail" : ""), "font-weight": 700 })]);
      // God Eye: its verdict stamped, with what it found
      var vd = ge && ge.verdict ? String(ge.verdict) : null, vc = vd === "approve" ? "ok" : vd ? "fail" : "";
      kids(g, [Z("text", { x: x + 10, y: y + 108, "font-size": 13, "class": "t-disp", "font-weight": 700 }, wd("godEye"), Z("title", null, wd("godEye") + ", the " + wd("godEyeSub")))]);
      if (vd) {
        var vt = (vd === "revise" ? wd("revise") : vd).toUpperCase(), vw = measure(vt, "t-disp", 14, 700) + 18;
        kids(g, [boxText(x + 100, y + 93, vw, 22, { fill: "none", stroke: "var(--" + (vc || "ink") + ")", "stroke-width": 1.8, rx: 2, transform: "rotate(-2 " + (x + 100 + vw / 2) + " " + (y + 104) + ")" }),
          tx(x + 100 + vw / 2, y + 109, vt, { "text-anchor": "middle", "font-size": 14, "class": "t-disp t-" + (vc || "ink"), "font-weight": 700 }),
          Z("text", { x: x + 100 + vw + 10, y: y + 108, "font-size": 13, "data-fit": w - vw - 120 }, ts("round " + ge.round + " · ", { "class": "t2" }),
            ts(ge.blocking + " blocking", { "class": ge.blocking ? "t-fail" : "t2", "font-weight": ge.blocking ? 700 : 400 }), ts(" · ", { "class": "t2" }), ts(ge.important + " important", { "class": ge.important ? null : "t2", "font-weight": ge.important ? 600 : 400 }))]);
      } else kids(g, [tx(x + 100, y + 108, "no verdict yet", { "font-size": 13, "class": "t3" })]);
      kids(g, [tx(x + 10, y + 136, "Questions", { "font-size": 13, "class": "t-disp", "font-weight": 700 }),
        Z("text", { x: x + 100, y: y + 136, "font-size": 13, "data-fit": w - 110 }, ts(String(r.asked), { "class": "t-mono", "font-weight": 700 }), ts(" asked · ", { "class": "t2" }),
          ts(String(r.deferred), { "class": "t-mono", "font-weight": 700 }), ts(" design questions deferred", { "class": "t2" }), r.judge_skipped ? ts(" · judge skipped", { "class": "t-fail" }) : null)]);
      var cr = e.critiques.filter(function (c) { return c.kind === kind; }).pop();
      if (cr) kids(g, [tx(x + 10, y + h - 10, "critique " + (cr.verdict || "?") + " · round " + (cr.round || "?") + (cr.at ? " · " + fT(P(cr.at)) : "") + (cr.bound ? " · bound to the draft ✓" : " · not bound"), { "font-size": 12.5, "class": "t-mono t3", "data-fit": w - 20 })]);
      return { g: g, h: h };
    }
    function deliveryDetail(e, x, y, w, h) {
      var g = Z("g"), info = {}, dl = e.delivery; e.slices.forEach(function (s) { info[s.slice] = slInfo(s); });
      var on = e.slices.some(function (s) { return info[s.slice].ag.length; });
      kids(g, [detailBox(x, y, w, h, "D", "Delivery", "slices " + dl.slices_merged + " of " + dl.slices_total + " merged · epic criteria " + dl.e_criteria_delivered + " of " + dl.e_criteria_total + " delivered", on ? "slices at work" : e.stage === "delivery" ? "on the line" : e.slices.length ? "idle" : "not sliced", on)]);
      if (!e.slices.length) { kids(g, [tx(x + 10, y + 74, "No slices yet: the slicer writes slices.json in stage 03, after EH2.", { "font-size": 13, "class": "t2", "data-fit": w - 20 })]); return g; }
      var order = slOrder(e), sq = Math.min(64, Math.floor((w - 20 - (order.length - 1) * 8) / Math.max(1, order.length)));
      order.slice(0, Math.floor((w - 20) / 40)).forEach(function (s, k) {
        var I = info[s.slice], sx = x + 10 + k * (sq + 8), cls = I.done ? "sq-pass" : I.failing ? "sq-fail" : I.ag.length ? "sq-run" : I.started ? "sq-todo solid" : "sq-todo";
        kids(g, [Z("g", I.j ? { "class": "clickable", "data-open": I.j.id, tabindex: 0, role: "button", "aria-label": s.slice + ": open its job" } : null, Z("title", null, s.slice + " " + s.title + " — " + (I.done ? "closed" : I.label ? "at " + I.label : "not on the line yet")),
          I.ag.length ? boxText(sx, y + 58, sq, 28, { "class": "lamp-ring breathe" }) : null, boxText(sx, y + 58, sq, 28, { "class": cls }),
          tx(sx + sq / 2, y + 76.5, (I.done ? "✓ " : "") + s.slice, { "text-anchor": "middle", "font-size": 13, "class": "t-mono" + (I.done ? " t-ok" : I.failing ? " t-fail" : ""), "font-weight": 700 }))]);
      });
      kids(g, [Z("g", { "class": "clickable", "data-view": "ebreak", tabindex: 0, role: "button", "aria-label": "Open the exploded view (sheet 9)" }, tx(x + w - 10, y + h - 10, "exploded view · sheet 9 →", { "text-anchor": "end", "font-size": 13, "class": "t-disp", "font-weight": 700 }))]);
      return g;
    }
    function epAssemblyDrawing(e, Wd) {
      var o = [], n = EP_STAGES.length, G8 = 28, SWd = Math.floor((Wd - 20 - (n - 1) * G8) / n), X8 = function (i) { return 10 + i * (SWd + G8); };
      var cur = epMainIdx(e), you = e.waiting_on.who === "you", agN = e.agents_at_work.length, at = {};
      e.agents_at_work.forEach(function (a) { (at[a.agent] = at[a.agent] || []).push(a); });
      var docsBy = {}; e.docs.forEach(function (d) { var k = EPK.indexOf(d.stage) >= 0 ? d.stage : "intent"; (docsBy[k] = docsBy[k] || []).push(d); });
      var maxDocs = Math.min(3, Math.max.apply(null, [0].concat(EPK.map(function (k) { return (docsBy[k] || []).length; }))));
      var SY8 = 150, SH8 = 114 + maxDocs * 17, PY8 = SY8 + 40;
      zoneNums(o, Wd);
      var ttl = "Drawing 8 · epic assembly", tw = measure(ttl, "t-disp", 18, 700);
      o.push(tx(10, 34, ttl, { "class": "t-disp", "font-size": 18, "font-weight": 700 }), tx(10 + tw + 14, 34, e.slug, { "class": "t-cond", "font-size": 19, "font-weight": 700, "data-fit": Wd - tw - 360 }),
        tx(Wd - 10, 34, [e.flag ? "flag " + e.flag : "no flag", e.risk + " risk", e.mode].join(" · "), { "text-anchor": "end", "class": "t-mono t2", "font-size": 13 }));
      o.push(epKey(10, 60));
      // gate callouts: a row of balloons (EH1 · EH2 · EH3), each leader runs down to its gate on the line
      var gates = EP_STAGES.map(function (s, i) { return s.gate ? { g: s.gate, i: i } : null; }).filter(Boolean);
      var gStep = function (i) { return X8(i) + SWd - 26; };
      gates.forEach(function (q, k) {
        var span = (Wd - 20) / gates.length, bx = 10 + k * span + 24, room = span - 64;
        epCallout(o, bx, 98, gStep(q.i), PY8, 124 + (gates.length - 1 - k) * 0, q.g, epGateState(e, q.g), room);
      });
      // the process line between stages
      for (var f = 0; f < n - 1; f++) {
        var curAg = EP_STAGES[cur.i] && EP_STAGES[cur.i].key === "delivery" ? e.slices.filter(function (s) { return slInfo(s).ag.length; }).length : agN;
        var x1 = X8(f) + SWd, x2 = X8(f + 1), passed = cur.i > f, hot = !cur.side && cur.i === f + 1 && curAg > 0;
        var cls = cur.i > f ? "flow" : "flow pend";
        o.push(Z("line", { x1: x1, y1: PY8, x2: x2 - 2, y2: PY8, "class": cls + (hot ? " hot" : ""), "marker-end": passed ? "url(#bp-arw" + (hot ? "-run" : "") + ")" : null }));
        if (hot) o.push(Z("line", { x1: x1 + 1, y1: PY8, x2: x2 - 10, y2: PY8, "class": "flow-live" }));
      }
      var maxRows = Math.max.apply(null, EP_STAGES.map(function (s) { return epBankRows(e, s); }));
      var BY8 = SY8 + SH8 + 30, BH8 = 26 + maxRows * 19 + 6;
      EP_STAGES.forEach(function (st, i) {
        var x = X8(i), state = i < cur.i ? "done" : i === cur.i ? (cur.side ? "held" : "now") : "next";
        // delivery is at work while any of its slices' jobs has agents at work on the line
        var ag = state === "now" ? (st.key === "delivery" ? e.slices.filter(function (s) { return slInfo(s).ag.length; }).length : agN) : 0, waitHere = state === "now" && you && (e.waiting_on.gate === st.gate || !st.gate);
        var stc = waitHere ? "var(--hl-line)" : state === "now" ? (ag ? "var(--agent)" : "var(--ink)") : state === "done" ? "var(--ink-2)" : state === "held" ? "var(--ink-2)" : "var(--ink-3)";
        var g = Z("g", { "class": "station" });
        kids(g, [boxText(x, SY8, SWd, SH8, { "class": "paperfill", stroke: stc, "stroke-width": state === "now" ? 2.4 : state === "next" ? 1.1 : 1.4, "stroke-dasharray": state === "next" ? "4 3" : state === "held" ? "7 3" : null }),
          ag ? boxText(x + 1, SY8 + 1, SWd - 2, 25, { "class": "st-live" }) : null,
          Z("path", { d: "M" + (x + 4) + " " + (SY8 + 4) + "h6M" + (x + 4) + " " + (SY8 + 4) + "v6M" + (x + SWd - 4) + " " + (SY8 + SH8 - 4) + "h-6M" + (x + SWd - 4) + " " + (SY8 + SH8 - 4) + "v-6", "class": "ln3" }),
          tx(x + 7, SY8 + 18, p2(i + 1), { "font-size": 13, "class": "t-mono t2" }),
          tx(x + 27, SY8 + 18, st.label, { "font-size": 16, "class": "t-disp tight" + (state === "next" ? " t2" : ""), "font-weight": 700, "data-fit": SWd - 27 - 28 }),
          state === "done" ? tx(x + SWd - 13, SY8 + 19, "✓", { "text-anchor": "middle", "font-size": 16, "class": "t-ok", "font-weight": 700 })
            : Z("circle", { cx: x + SWd - 13, cy: SY8 + 13, r: 8, "class": ag ? "lamp on" : state === "now" ? "paperfill" : "lamp", stroke: ag ? null : state === "now" ? "var(--ink)" : null, "stroke-width": 1.3 }),
          Z("line", { x1: x, y1: PY8, x2: x + SWd, y2: PY8, "class": "flow inner" + (state === "now" && ag ? " hot" : "") + (state === "next" ? " pend" : "") }),
          state === "now" && ag ? Z("line", { x1: x + 2, y1: PY8, x2: x + SWd - 2, y2: PY8, "class": "flow-live" }) : null]);
        // steps on the line: agent steps (squares, lit while their agent works), CLI checks (diamonds), the human gate (a pill)
        var steps = st.steps, ns = steps.length, hasGate = steps[ns - 1][0] === "h", sx0 = x + 16, sx1 = hasGate ? gStep(i) : x + SWd - 16;
        steps.forEach(function (sp, k) {
          var cxs = ns === 1 ? x + SWd / 2 : sx0 + (sx1 - sx0) * k / (ns - 1), sym;
          if (sp[0] === "a") {
            var god = /God Eye/.test(sp[1]), lit = state === "now" && (god ? !!at["god-eye"] : Object.keys(at).some(function (r) { return r !== "god-eye"; }));
            sym = [lit ? boxText(cxs - 7, PY8 - 7, 14, 14, { "class": "lamp-ring breathe" }) : null, boxText(cxs - 7, PY8 - 7, 14, 14, { "class": lit ? "sq-run" : "paperfill", stroke: lit ? null : state === "next" ? "var(--ink-3)" : "var(--ink)", "stroke-width": 1.3 })];
          } else if (sp[0] === "c") sym = Z("path", { d: "M" + cxs + " " + (PY8 - 8) + "L" + (cxs + 8) + " " + PY8 + "L" + cxs + " " + (PY8 + 8) + "L" + (cxs - 8) + " " + PY8 + "Z", "class": "paperfill", stroke: state === "next" ? "var(--ink-3)" : "var(--ink)", "stroke-width": 1.3 });
          else sym = epGateSym(cxs, PY8, sp[1], epGateState(e, sp[1]));
          kids(g, [Z("g", null, Z("title", null, (sp[0] === "a" ? "agent step: " : sp[0] === "c" ? "CLI check: " : "human gate: ") + sp[1]), sym)]);
        });
        // below the line: the epic itself (now), how long the stage took (done), or what it will do (ahead)
        var by0 = PY8 + 16;
        if (state === "now" || state === "held") kids(g, [epMarker(e, x + 5, by0, SWd - 10)]);
        else if (state === "done") {
          var sp2 = epSpan(e, st.key);
          kids(g, [tx(x + 8, by0 + 15, "✓ done" + (sp2 ? " · " + fD((sp2.b || TN) - sp2.a) : ""), { "font-size": 14, "class": "t-cond t-ok", "font-weight": 700, "data-fit": SWd - 16 }),
            sp2 && sp2.b ? tx(x + 8, by0 + 32, "out " + fT(sp2.b), { "font-size": 13, "class": "t-mono t2", "data-fit": SWd - 16 }) : null]);
        } else kids(g, [tx(x + 8, by0 + 15, i === cur.i + 1 && !cur.side ? "next" : "ahead", { "font-size": 13, "class": "t-disp t3", "font-weight": 700 }),
          wrapN(steps[0][1], SWd - 16, "t3", 13, 400, 2).map(function (ln, li) { return tx(x + 8, by0 + 32 + li * 16, ln, { "font-size": 13, "class": "t3", "data-fit": SWd - 16 }); })]);
        // its documents, each with its binding
        var dd = docsBy[st.key] || [];
        dd.slice(0, 3).forEach(function (d, k) {
          var ok = /match/.test(d.binding || ""), bad = /stale/.test(d.binding || ""), yy = SY8 + 116 + k * 17;
          kids(g, [Z("g", null, Z("title", null, (d.name || "document") + " · " + (d.binding || "not bound") + (d.gate ? " at " + d.gate : "")),
            Z("path", { d: "M" + (x + 8) + " " + (yy - 10) + "h7l3 3v9h-10z", fill: "none", stroke: ok ? "var(--ok)" : bad ? "var(--fail)" : "var(--ink-2)", "stroke-width": 1.1 }),
            Z("text", { x: x + 23, y: yy, "font-size": 12.5, "data-fit": SWd - 30 }, ts(d.name || "document", { "class": "t-mono" }), ts(ok ? " ✓" : bad ? " ✗ stale" : " · " + (d.binding || "draft"), { "class": ok ? "t-ok" : bad ? "t-fail" : "t3" })))]);
        });
        if (dd.length > 3) kids(g, [tx(x + SWd - 8, SY8 + SH8 - 6, "+" + (dd.length - 3), { "text-anchor": "end", "font-size": 12.5, "class": "t-mono t2" })]);
        // its agent sub-assembly
        var on = state === "now" && ag > 0, groups = epBankGroups(st);
        kids(g, [Z("line", { x1: x + SWd / 2, y1: SY8 + SH8, x2: x + SWd / 2, y2: BY8, "class": on ? "ln-agent" : "ln3", "stroke-dasharray": "2 2" }), Z("circle", { cx: x + SWd / 2, cy: SY8 + SH8, r: 2.5, fill: on ? "var(--agent)" : "var(--ink-3)" }),
          boxText(x, BY8, SWd, BH8, { "class": "paper2", stroke: on ? "var(--agent)" : "var(--ink-3)", "stroke-width": on ? 1.6 : 1 })]);
        var litN = 0; groups.forEach(function (gr) { if (state === "now" && at[gr.role]) litN += Math.min(gr.n, at[gr.role].length); });
        var tot = st.key === "delivery" ? e.slices.length : st.members.length, nOn = st.key === "delivery" ? e.slices.filter(function (s) { return slInfo(s).ag.length; }).length : litN, cnt = tot ? (nOn ? nOn + " of " + tot + " at work" : "idle") : "";
        if (nOn && measure(st.bank, "t-disp tight", 13, 700) + measure(cnt, "t-mono", 13, 700) + 24 > SWd) cnt = nOn + " of " + tot;
        kids(g, [tx(x + 7, BY8 + 16, st.bank, { "font-size": 13, "class": "t-disp tight", "font-weight": 700, "data-fit": SWd - 14 - (cnt ? measure(cnt, "t-mono", 13, 700) + 10 : 0) }),
          cnt ? tx(x + SWd - 7, BY8 + 16, cnt, { "text-anchor": "end", "font-size": 13, "class": "t-mono " + (on ? "t-agent" : "t3"), "font-weight": 700 }) : null]);
        if (st.key === "delivery") {
          if (!e.slices.length) kids(g, [tx(x + 7, BY8 + 38, "no slices yet", { "font-size": 13, "class": "t3" })]);
          slOrder(e).slice(0, 6).forEach(function (s, k) {
            var I = slInfo(s), cy = BY8 + 35 + k * 19, lit = I.ag.length > 0;
            kids(g, [Z("g", I.j ? { "class": "lamprow clickable" + (lit ? " on" : ""), "data-open": I.j.id, tabindex: 0, role: "button", "aria-label": s.slice + " " + s.title + ": open its job" } : { "class": "lamprow" },
              Z("title", null, s.slice + " · " + s.title + " — " + (I.done ? "closed" : I.label ? "at " + I.label + " (" + wd("state", I.st) + ")" : "not on the line yet")),
              lit ? Z("circle", { cx: x + 11, cy: cy, r: 5.5, "class": "lamp-ring pulse" }) : null, Z("circle", { cx: x + 11, cy: cy, r: 5.5, "class": "lamp" + (lit ? " on" : "") }),
              Z("text", { x: x + 22, y: cy + 4.5, "font-size": 13, "data-fit": SWd - 28 }, ts(s.slice + " ", { "class": "t-mono", "font-weight": 700 }),
                ts(I.done ? "✓ closed" : I.g ? I.g + " waits" : I.label ? I.label.toLowerCase() : "waiting", { "class": I.done ? "t-ok" : lit ? "t-agent" : I.failing ? "t-fail" : I.label ? "t2" : "t3" })))]);
          });
          if (e.slices.length > 6) kids(g, [tx(x + 7, BY8 + 35 + 6 * 19 + 4.5, "+" + (e.slices.length - 6) + " more", { "font-size": 13, "class": "t-mono t2" })]);
        } else if (!groups.length) {
          var bl = st.key === "complete" ? ["flag " + (e.flag || "—"), "ready to retire"] : ["A CLI check:", "no agent is needed"];
          kids(g, [tx(x + 7, BY8 + 38, bl[0], { "font-size": 13, "class": "t2", "data-fit": SWd - 12 }), tx(x + 7, BY8 + 57, bl[1], { "font-size": 13, "class": "t2", "data-fit": SWd - 12 })]);
        } else groups.forEach(function (gr, k) {
          var cy = BY8 + 35 + k * 19, jobs = state === "now" ? (at[gr.role] || []) : [], lit = Math.min(gr.n, jobs.length), lx = x + 11;
          var row = Z("g", { "class": "lamprow" + (lit ? " on" : "") }, Z("title", null, gr.name + (gr.n > 1 ? " ×" + gr.n : "") + (jobs.length ? " — at work for " + fD(TN - P(jobs[0].since)) : " — idle")));
          for (var m = 0; m < gr.n; m++) kids(row, [m < lit ? Z("circle", { cx: lx + m * 13, cy: cy, r: 5.5, "class": "lamp-ring pulse" }) : null, Z("circle", { cx: lx + m * 13, cy: cy, r: 5.5, "class": "lamp" + (m < lit ? " on" : "") })]);
          var t0x = lx + gr.n * 13 + 3;
          kids(row, [tx(t0x, cy + 4.5, gr.name + (gr.n > 1 && !lit ? " ×" + gr.n : "") + (lit && jobs[0].since ? " · " + fD(TN - P(jobs[0].since)) : ""), { "font-size": 13, "class": lit ? "t-agent t-cond" : "t2", "font-weight": lit ? 700 : 400, "data-fit": x + SWd - 6 - t0x })]);
          kids(g, [row]);
        });
        o.push(g);
      });
      // side tracks (changing · parked · stopped) and Detail D (delivery) share the next row
      var SDY = BY8 + BH8 + 44, sideW = Math.floor((Wd * .5 - 10 - 32) / 3), sideH = 104;
      var busX = X8(0) + SWd / 2;
      o.push(Z("path", { d: "M" + busX + " " + (BY8 + BH8) + " V" + (SDY - 18) + " H" + (10 + 2 * (sideW + 16) + sideW / 2), "class": "side-ln" }),
        tx(busX + 8, SDY - 25, "side tracks · from any stage", { "font-size": 13, "class": "t-disp side-t", "font-weight": 600 }));
      EP_SIDES.forEach(function (sd, k) {
        var x = 10 + k * (sideW + 16), here = cur.side === sd.key, gw = here && you && (e.waiting_on.gate === sd.gate || !sd.gate);
        o.push(Z("line", { x1: x + sideW / 2, y1: SDY - 18, x2: x + sideW / 2, y2: SDY - 2, "class": "side-ln", "marker-end": "url(#bp-arw-pk)" }),
          boxText(x, SDY, sideW, sideH, { "class": "paperfill", stroke: here ? (gw ? "var(--hl-line)" : "var(--ink-2)") : "var(--ink-3)", "stroke-width": here ? 2.2 : 1, "stroke-dasharray": here ? null : "4 3" }),
          tx(x + 8, SDY + 18, sd.label, { "font-size": 15, "class": "t-disp tight" + (here ? "" : " t2"), "font-weight": 700, "data-fit": sideW - 60 }),
          tx(x + 8, SDY + 36, sd.sub, { "font-size": 13, "class": "t2", "data-fit": sideW - 16 }));
        if (sd.gate) o.push(epGateSym(x + sideW - 26, SDY + 14, sd.gate, { on: !!gw, pass: null, denied: 0 }));
        if (here) o.push(epMarker(e, x + 5, SDY + 48, sideW - 10));
        else o.push(tx(x + 8, SDY + 66, "none", { "font-size": 13, "class": "t3" }));
        if (here && gw) o.push(tx(x + 8, SDY + sideH - 8, gv(sd.gate) + " (" + (sd.gate || "") + ")", { "font-size": 13, "class": "t-cond cl-on", "font-weight": 600, "data-fit": sideW - 16 }));
      });
      var dX = 10 + 3 * (sideW + 16) + 16, dW = Wd - 10 - dX;
      o.push(deliveryDetail(e, dX, SDY, dW, sideH));
      // round detail views: one per review loop the epic has run
      var RY = SDY + sideH + 30, RK = Object.keys(e.rounds), perRow = Math.max(1, Math.min(Math.max(2, RK.length), Math.floor((Wd - 20 + 20) / 380)));
      var rw = Math.floor((Wd - 20 - (perRow - 1) * 20) / perRow), bottom = RY;
      if (!RK.length) {
        o.push(boxText(10, RY, Wd - 20, 40, { "class": "paperfill", stroke: "var(--ink-3)", "stroke-dasharray": "4 3" }),
          Z("text", { x: 20, y: RY + 25, "font-size": 13 }, ts("Round details", { "class": "t-disp", "font-weight": 700 }), ts("   no review rounds recorded yet", { "class": "t2" })));
        bottom = RY + 40;
      }
      RK.forEach(function (k, idx) {
        var col = idx % perRow, row = Math.floor(idx / perRow), x = 10 + col * (rw + 20), y = RY + row * (170 + 20);
        var rd = roundDetail(e, k, e.rounds[k], x, y, rw, "R" + (idx + 1)); o.push(rd.g); bottom = Math.max(bottom, y + rd.h);
      });
      return { nodes: o, H: bottom + 12 };
    }
    function renderAssembly() {
      var e = epCur();
      var head = H("div", { "class": "viewhead" }, H("h2", { text: "Epic assembly drawing" }), H("p", { text: (e ? e.slug + " · " : "") + "the epic's own process: stages, gates, agent sub-assemblies, round details · " + epAsOf() }), H("span", { "class": "grow" }), epPicker("eflow"));
      if (!e) { fill(views.eflow, head, emptyEpics()); return; }
      tbDraw.textContent = "Epic assembly · " + e.slug;
      var Wd = drawW(views.eflow), dr = epAssemblyDrawing(e, Wd);
      var di = Math.min(epDocIdx[e.id] || 0, Math.max(0, e.docs.length - 1)), doc = e.docs[di];
      var docs = H("div", { "class": "pane mb" }, H("h4", null, "Documents by stage", H("em", { text: plural(e.docs.length, "document") + " · binding to the gate that approved it" })),
        H("div", { "class": "pb" }, e.docs.length ? [
          H("div", { "class": "ox" }, H("table", { "class": "rev edocs" }, H("thead", null, H("tr", null, ["Stage", "Document", "Gate", "Binding"].map(function (x) { return H("th", { text: x }); }))),
            H("tbody", null, e.docs.map(function (d, i) {
              return H("tr", { "data-edoc": i, "data-edoc-epic": e.id, tabindex: 0, "class": i === di ? "on" : null, "aria-selected": String(i === di), title: "Show this document's excerpt" },
                H("td", { text: EPK.indexOf(d.stage) >= 0 ? p2(EPK.indexOf(d.stage) + 1) + " " + EP_LABEL[d.stage] : (d.stage || "—") }), H("td", { "class": "mono", text: d.name || "document" }),
                H("td", { "class": "mono", text: d.gate || "—" }), H("td", null, bindChip(d.binding)));
            })))),
          doc ? H("pre", { "class": "doc edoc", "data-keep": "edoc", text: doc.excerpt || "(no excerpt recorded)" }) : null] : H("p", { "class": "meta", text: "No documents yet: epic-intent.md is written in stage 01." })));
      var hist = e.history.slice().reverse();
      var histP = H("div", { "class": "pane mb" }, H("h4", null, "Revision history", H("em", { text: plural(e.history.length, "move") + " · newest first" })),
        H("div", { "class": "pb" }, hist.length ? H("table", { "class": "rev" }, H("thead", null, H("tr", null, H("th", { text: "Time" }), H("th", { text: "Change" }), H("th", { text: "By" }))),
          H("tbody", null, hist.map(function (h) {
            var human = h.by && h.by !== "agent";
            return H("tr", null, H("td", { "class": "mono", text: fT(P(h.at)) }), H("td", null, wd("state", h.from || "?") + " → ", H("b", { text: wd("state", h.to) }), h.reason ? H("span", { "class": "meta", text: " — " + h.reason }) : null),
              H("td", null, human ? H("span", { "class": "chip hl", text: h.by }) : H("span", { "class": "meta", text: h.by || "—" })));
          }))) : H("p", { "class": "meta", text: "No moves recorded." })));
      var agP = H("div", { "class": "pane mb" }, H("h4", null, "At work on this epic", H("em", { text: plural(e.agents_at_work.length, "agent") + " · " + plural(e.activity_count, "recorded action") })),
        H("div", { "class": "pb" }, e.agents_at_work.length ? H("ul", { "class": "lst" }, e.agents_at_work.map(function (a) {
          return H("li", null, H("span", { "class": "dotl" }), H("span", null, H("b", { text: agentLabel(a.agent) }), H("span", { "class": "meta", text: " · " + (EP_LABEL[e.stage] || e.stage) + (a.since ? " · " + fD(TN - P(a.since)) : "") })));
        })) : H("p", { "class": "meta", text: "No agent is at work on this epic now." })));
      var crP = H("div", { "class": "pane" }, H("h4", null, "Critiques", H("em", { text: plural(e.critiques.length, "critique") })),
        H("div", { "class": "pb" }, e.critiques.length ? H("ul", { "class": "lst" }, e.critiques.slice().reverse().map(function (c) {
          return H("li", null, H("span", { "class": "when", text: c.at ? fT(P(c.at)) : "—" }), H("span", null, H("b", { text: (c.kind || "?") + " " }), H("span", { "class": "chip " + (c.verdict === "approve" ? "ok" : c.verdict ? "fail" : "mute"), text: c.verdict || "?" }),
            H("span", { "class": "meta", text: " · round " + (c.round || "?") + (c.bound ? " · bound ✓" : " · not bound") })));
        })) : H("p", { "class": "meta", text: "No critiques yet." })));
      fill(views.eflow, head, waitPane(e), drawingSvg(views.eflow, "eflow-d", Wd, dr, "Assembly drawing of epic " + e.slug + ": " + (EP_LABEL[e.stage] || e.stage)),
        H("div", { "class": "two egap" }, H("div", null, docs, histP), H("div", null, api.conversation ? H("div", { "class": "cvblk mb" }, api.conversation(e.id, S.t)) : null, agP, crP)));
      fitIn(views.eflow);
    }

    // ---------------------------------------------------------------- sheet 9: epic breakdown, an exploded view (slices as sub-assemblies)
    function epBreakdownDrawing(e, Wd) {
      var o = [], sl = e.slices, info = {}, dl = e.delivery;
      sl.forEach(function (s) { info[s.slice] = slInfo(s); });
      var nextS = slNext(e, info), lv = slLevels(sl);
      zoneNums(o, Wd);
      var ttl = "Drawing 9 · exploded view", tw = measure(ttl, "t-disp", 18, 700);
      o.push(tx(10, 34, ttl, { "class": "t-disp", "font-size": 18, "font-weight": 700 }), tx(10 + tw + 14, 34, e.slug, { "class": "t-cond", "font-size": 19, "font-weight": 700, "data-fit": Wd - tw - 420 }),
        tx(Wd - 10, 34, "slices " + dl.slices_merged + " of " + dl.slices_total + " merged · epic criteria " + dl.e_criteria_delivered + " of " + dl.e_criteria_total + " delivered", { "text-anchor": "end", "class": "t-mono t2", "font-size": 13 }));
      o.push(keyRow(10, 60, [
        ["explosion line", function (x0) { return Z("line", { x1: x0, y1: 60, x2: x0 + 26, y2: 60, "class": "phantom" }); }, 32],
        ["depends on", function (x0) { return Z("line", { x1: x0, y1: 60, x2: x0 + 24, y2: 60, "class": "dep", "marker-end": "url(#bp-arw)" }); }, 30],
        ["leads to the criterion it proves", function (x0) { return Z("line", { x1: x0, y1: 60, x2: x0 + 24, y2: 60, "class": "ldr", "marker-start": "url(#bp-dot)", "marker-end": "url(#bp-arw2)" }); }, 30],
        ["drops next", function (x0) { return boxText(x0, 53, 18, 14, { "class": "hl-fill", stroke: "var(--ink)", "stroke-width": 1 }); }, 24],
        ["at work", function (x0) { return Z("circle", { cx: x0 + 6, cy: 60, r: 5.5, "class": "lamp on" }); }, 16],
        ["closed", function (x0) { return boxText(x0, 53, 18, 14, { "class": "paperfill", stroke: "var(--ok)", "stroke-width": 1.4, "stroke-dasharray": "3 2" }); }, 24]]));
      // the parent assembly: the epic, with its contracts as the parts every slice shares
      var PA = 82, PH = 72, cx2 = Math.round(Wd * .5);
      o.push(boxText(10, PA, Wd - 20, PH, { "class": "paperfill", stroke: "var(--ink)", "stroke-width": 1.8 }),
        Z("path", { d: "M14 " + (PA + 4) + "h8M14 " + (PA + 4) + "v8M" + (Wd - 14) + " " + (PA + PH - 4) + "h-8M" + (Wd - 14) + " " + (PA + PH - 4) + "v-8", "class": "ln3" }),
        tx(22, PA + 20, "Epic · parent assembly", { "font-size": 13, "class": "t-disp t2", "font-weight": 700 }),
        tx(22, PA + 43, e.slug, { "font-size": 21, "class": "t-cond", "font-weight": 700, "data-fit": cx2 - 40 }),
        tx(22, PA + 62, (EP_LABEL[e.stage] || e.stage) + " · " + e.meaning, { "font-size": 13, "class": "t2", "data-fit": cx2 - 40 }),
        Z("line", { x1: cx2, y1: PA + 8, x2: cx2, y2: PA + PH - 8, "class": "ln3" }),
        tx(cx2 + 12, PA + 20, "Contracts · shared parts" + (e.flag ? " · flag " + e.flag : ""), { "font-size": 13, "class": "t-disp t2", "font-weight": 700, "data-fit": Wd - cx2 - 34 }));
      if (!e.contracts.length) o.push(tx(cx2 + 12, PA + 43, "none recorded yet: contracts are drawn in stage 02", { "font-size": 13, "class": "t3", "data-fit": Wd - cx2 - 34 }));
      e.contracts.slice(0, 2).forEach(function (c, k) {
        var yy = PA + 41 + k * 18;
        o.push(boxText(cx2 + 12, yy - 12, 26, 16, { "class": "paper2", stroke: "var(--ink)", "stroke-width": 1 }), tx(cx2 + 25, yy + .5, "C" + (k + 1), { "text-anchor": "middle", "font-size": 12, "class": "t-mono", "font-weight": 700 }),
          Z("text", { x: cx2 + 46, y: yy, "font-size": 13, "data-fit": Wd - cx2 - 70 }, ts(c.path, { "class": "t-mono" }), ts(c.frozen ? "  frozen" : "  open", { "class": c.frozen ? "t-ok" : "t-fail", "font-weight": 600 }),
            ts(" · " + (c.touched_by.length ? "touched by " + c.touched_by.join(", ") : "no slice yet"), { "class": "t2" })));
      });
      if (e.contracts.length > 2) o.push(tx(Wd - 22, PA + PH - 8, "+" + (e.contracts.length - 2) + " more in the table below", { "text-anchor": "end", "font-size": 12.5, "class": "t-mono t2" }));
      var cIdx = {}; e.contracts.forEach(function (c, k) { c.touched_by.forEach(function (s) { (cIdx[s] = cIdx[s] || []).push("C" + (k + 1)); }); });
      // the slices: one column per dependency level (S00 first), arrows for "depends on"
      var levels = sl.length ? Math.max.apply(null, sl.map(function (s) { return lv[s.slice]; })) + 1 : 0;
      var skips = []; sl.forEach(function (s) { s.depends_on.forEach(function (d) { if (info[d] && lv[s.slice] - lv[d] > 1) skips.push([d, s.slice]); }); });
      var SLY = PA + PH + 54 + skips.length * 9, SLH = 136, SLG = 26;
      var CWs = levels ? Math.min(330, Math.floor((Wd - 20 - (levels - 1) * 80) / levels)) : 0;
      var GAPs = levels > 1 ? Math.min(150, Math.floor((Wd - 20 - levels * CWs) / (levels - 1))) : 0;
      var used = levels * CWs + Math.max(0, levels - 1) * GAPs, x0 = 10 + Math.max(0, Math.floor((Wd - 20 - used) / 2));
      var pos = {}, perLv = {}, slBottom = SLY;
      slOrder(e).forEach(function (s) { var l = lv[s.slice], k = perLv[l] = (perLv[l] || 0) + 1; pos[s.slice] = { x: x0 + l * (CWs + GAPs), y: SLY + (k - 1) * (SLH + SLG), w: CWs, h: SLH }; slBottom = Math.max(slBottom, pos[s.slice].y + SLH); });
      if (!sl.length) {
        o.push(boxText(10, SLY, Wd - 20, 70, { fill: "none", "class": "ln3", "stroke-dasharray": "5 4" }),
          tx(Wd / 2, SLY + 30, "Not sliced yet", { "text-anchor": "middle", "font-size": 16, "class": "t-disp t2", "font-weight": 700 }),
          tx(Wd / 2, SLY + 52, "the slicer writes slices.json in stage 03 (after EH2): S00 contracts + flag first, then vertical slices", { "text-anchor": "middle", "font-size": 13, "class": "t3", "data-fit": Wd - 60 }));
        slBottom = SLY + 70;
      }
      // explosion lines: from the parent down to the first sub-assembly of each column
      var tops = {}; Object.keys(pos).forEach(function (k) { var p = pos[k]; if (!tops[p.x] || p.y < tops[p.x].y) tops[p.x] = p; });
      Object.keys(tops).forEach(function (k) { var p = tops[k]; o.push(Z("line", { x1: p.x + p.w / 2, y1: PA + PH, x2: p.x + p.w / 2, y2: p.y - 1, "class": "phantom" })); });
      // dependency arrows: neighbouring levels go straight across; longer ones run along a lane above the slices
      sl.forEach(function (s) {
        s.depends_on.forEach(function (d) {
          var pd = pos[d], ps = pos[s.slice]; if (!pd || !ps) return;
          var ok = info[d] && info[d].done, span = lv[s.slice] - lv[d];
          if (span === 1) {
            var mx = pd.x + pd.w + GAPs / 2, y1 = pd.y + 58, y2 = ps.y + 58;
            o.push(Z("path", { d: "M" + (pd.x + pd.w) + " " + y1 + " H" + mx + " V" + y2 + " H" + (ps.x - 2), "class": "dep" + (ok ? " ok" : ""), "marker-end": "url(#bp-arw)" }));
          } else if (span > 1) {
            var k = 0; skips.forEach(function (q, i) { if (q[0] === d && q[1] === s.slice) k = i; });
            var lane = SLY - 14 - k * 9, sx = pd.x + pd.w - 24 - k * 8, ex = ps.x + 24 + k * 8;
            o.push(Z("path", { d: "M" + sx + " " + (pd.y - 1) + " V" + lane + " H" + ex + " V" + (ps.y - 3), "class": "dep" + (ok ? " ok" : ""), "marker-end": "url(#bp-arw)" }));
          }
        });
      });
      sl.forEach(function (s) {
        var p = pos[s.slice], I = info[s.slice], nx = nextS && nextS.slice === s.slice, x = p.x, y = p.y, w = p.w;
        var stroke = I.g ? "var(--hl-line)" : I.failing ? "var(--fail)" : I.ag.length ? "var(--agent)" : I.done ? "var(--ok)" : I.started ? "var(--ink)" : nx ? "var(--ink)" : "var(--ink-3)";
        var g = Z("g", I.j ? { "class": "slc clickable", "data-open": I.j.id, tabindex: 0, role: "button", "aria-label": s.slice + " " + s.title + ": open its job's section view" } : { "class": "slc" },
          Z("title", null, s.slice + " · " + s.title + (I.j ? " · job " + short(I.j.id) : "")));
        var status = I.done ? "✓ closed" : I.g ? I.g + " waits on you" : I.failing ? "✗ failing" : I.started ? (I.ag.length ? "● " : "") + (I.label || wd("state", I.st)).toLowerCase() : nx ? (s.waiting_on.length ? "next · waits on " + s.waiting_on.join(", ") : "drops next") : "not started";
        kids(g, [I.ag.length ? boxText(x - 3, y - 3, w + 6, SLH + 6, { "class": "lamp-ring breathe", rx: 3 }) : null,
          boxText(x, y, w, SLH, { "class": "paperfill", stroke: stroke, "stroke-width": I.started || nx ? 2 : 1.2, "stroke-dasharray": I.done ? "5 3" : !I.started && !nx ? "4 3" : null }),
          boxText(x + 1, y + 1, w - 2, 26, { "class": nx || I.g ? "hl-fill" : I.ag.length ? "st-live" : "paper2" }),
          Z("circle", { cx: x + 18, cy: y + 14, r: 11, "class": "paperfill", stroke: "var(--ink)", "stroke-width": 1.3 }),
          tx(x + 18, y + 18.5, String(sl.indexOf(s) + 1), { "text-anchor": "middle", "font-size": 13, "class": "t-disp", "font-weight": 700 }),
          tx(x + 36, y + 19, s.slice, { "font-size": 16, "class": "t-disp" + (nx || I.g ? " on-hl" : ""), "font-weight": 700 }),
          tx(x + w - 8, y + 18.5, status, { "text-anchor": "end", "font-size": 13, "class": "t-mono " + (nx || I.g ? "on-hl" : I.done ? "t-ok" : I.failing ? "t-fail" : I.ag.length ? "t-agent" : I.started ? "" : "t3"), "font-weight": 600, "data-fit": w - 90 }),
          wrapN(s.title, w - 20, "", 14, 600, 2).map(function (ln, li) { return tx(x + 10, y + 46 + li * 17, ln, { "font-size": 14, "font-weight": 600, "data-fit": w - 20 }); }),
          // its job's live station on the line
          Z("circle", { cx: x + 15, cy: y + 85, r: 5.5, "class": "lamp" + (I.ag.length ? " on" : "") }),
          Z("text", { x: x + 27, y: y + 89.5, "font-size": 13, "data-fit": w - 37 }, I.j || I.started ? [ts("on the line · ", { "class": "t2" }), ts(I.done ? "done" : (I.label || "?") + " · " + words(I.st), { "class": I.ag.length ? "t-agent" : I.done ? "t-ok" : null, "font-weight": 600 }),
            I.ag.length ? ts(" · " + plural(I.ag.length, "agent"), { "class": "t-agent" }) : null] : ts(s.waiting_on.length ? "waits on " + s.waiting_on.join(", ") : nx ? "next onto the line" : "not on the line yet", { "class": "t3" })),
          tx(x + 10, y + 108, I.j ? short(I.j.id) : "no job yet", { "font-size": 13, "class": "t-mono t2", "data-fit": w - 20 - (cIdx[s.slice] ? cIdx[s.slice].length * 30 : 0) }),
          (cIdx[s.slice] || []).map(function (c, k) { var cx3 = x + w - 10 - (cIdx[s.slice].length - k) * 30; return [boxText(cx3, y + 96, 26, 16, { "class": "paper2", stroke: "var(--ink)", "stroke-width": 1 }), tx(cx3 + 13, y + 108.5, c, { "text-anchor": "middle", "font-size": 12, "class": "t-mono", "font-weight": 700 })]; }),
          Z("text", { x: x + 10, y: y + 127, "font-size": 13, "data-fit": w - 20 }, Z("title", null, s.e_criteria.join(", ") || "no epic criterion"), ts(s.e_criteria.length ? "proves " + critList(s.e_criteria) : "proves no criterion: contracts and the flag", { "class": s.e_criteria.length ? null : "t3", "font-weight": 600 }))]);
        o.push(g);
      });
      // the E-ACs: what the epic must prove, each fed by leader lines from the slices that deliver it
      var crit = e.e_criteria, byAC = {};
      crit.forEach(function (c) { byAC[c.id] = { c: c, from: [] }; });
      sl.forEach(function (s) { s.e_criteria.forEach(function (id) { if (!byAC[id]) { byAC[id] = { c: { id: id, text: "", status: "not_started", slices: [] }, from: [] }; crit = crit.concat([byAC[id].c]); } if (byAC[id].from.indexOf(s.slice) < 0) byAC[id].from.push(s.slice); }); });
      crit.forEach(function (c) { c.slices.forEach(function (s) { if (byAC[c.id] && pos[s] && byAC[c.id].from.indexOf(s) < 0) byAC[c.id].from.push(s); }); });
      var leaders = []; Object.keys(byAC).forEach(function (id) { byAC[id].from.forEach(function (s) { if (pos[s]) leaders.push({ s: s, id: id }); }); });
      var EWmin = 230, perRow = Math.max(1, Math.min(crit.length || 1, Math.floor((Wd - 20 + 16) / (EWmin + 16)))), EW = Math.min(320, Math.floor((Wd - 20 - (perRow - 1) * 16) / perRow)), EH = 104;
      var rowsAC = Math.ceil(crit.length / perRow), ACY = slBottom + 46 + leaders.length * 8, acPos = {};
      var acLabel = "Epic criteria · " + crit.length, acLy = ACY - 12;
      crit.forEach(function (c, i) {
        var row = Math.floor(i / perRow), col = i % perRow, inRow = Math.min(perRow, crit.length - row * perRow), rowW = inRow * EW + (inRow - 1) * 16, rx0 = 10 + Math.max(0, Math.floor((Wd - 20 - rowW) / 2));
        var x = rx0 + col * (EW + 16), y = ACY + row * (EH + 18), del = c.status === "delivered", prog = c.status === "in_progress", from = byAC[c.id] ? byAC[c.id].from : [];
        acPos[c.id] = { x: x, y: y };
        var stc = del ? "var(--ok)" : prog ? "var(--agent)" : "var(--ink-3)";
        o.push(Z("g", { "class": "eac" }, Z("title", null, c.id + " · " + c.text + " · " + words(c.status)),
          boxText(x, y, EW, EH, { "class": "paperfill", stroke: stc, "stroke-width": del || prog ? 1.8 : 1.1, "stroke-dasharray": !del && !prog ? "4 3" : null }),
          tx(x + 10, y + 22, wd("crit", c.id), { "font-size": 13, "class": "t-disp", "font-weight": 700 }),
          idTag(x + 18 + measure(wd("crit", c.id), "t-disp", 13, 700), y + 21, c.id, false).n,
          tx(x + EW - 10, y + EH - 9, del ? "✓ delivered" : prog ? "● in progress" : "○ not started", { "text-anchor": "end", "font-size": 13, "class": "t-cond " + (del ? "t-ok" : prog ? "t-agent" : "t3"), "font-weight": 700 }),
          wrapN(c.text || "(no text recorded)", EW - 20, "", 13, 400, 3).map(function (ln, li) { return tx(x + 10, y + 46 + li * 16, ln, { "font-size": 13, "data-fit": EW - 20 }); }),
          tx(x + 10, y + EH - 9, from.length ? "by " + from.join(", ") : sl.length ? "not covered by any slice" : "awaiting slicing", { "font-size": 13, "class": "t-mono " + (from.length ? "t2" : sl.length ? "t-fail" : "t3"), "data-fit": EW - 120 })));
      });
      if (!crit.length) o.push(tx(10, ACY + 20, "No epic criteria recorded yet.", { "font-size": 13, "class": "t3" }));
      // leader lines: slice (dot) → lane → E-AC (arrow), each on its own lane so none overlap
      var perSl = {}, perAc = {};
      leaders.forEach(function (q) { (perSl[q.s] = perSl[q.s] || []).push(q); (perAc[q.id] = perAc[q.id] || []).push(q); });
      leaders.forEach(function (q, k) {
        var p = pos[q.s], a = acPos[q.id]; if (!p || !a) return;
        var si = perSl[q.s].indexOf(q), ai = perAc[q.id].indexOf(q), na = perAc[q.id].length;
        var sx = p.x + 18 + si * 16, lane = slBottom + 20 + k * 8, ax = a.x + EW / 2 + (ai - (na - 1) / 2) * 14;
        var done = info[q.s] && info[q.s].done;
        o.push(Z("path", { d: "M" + sx + " " + (p.y + SLH + 1) + " V" + lane + " H" + ax + " V" + (a.y - 2), "class": "ldr" + (done ? " ok" : ""), "marker-start": "url(#bp-dot)", "marker-end": "url(#bp-arw2)" }));
      });
      // the row's title sits on a paper patch above the leaders, like a label on a drawing
      var alw = measure(acLabel, "t-disp", 14, 700) + 12;
      o.push(boxText(6, acLy - 15, alw, 21, { "class": "paperfill" }), tx(10, acLy, acLabel, { "font-size": 14, "class": "t-disp", "font-weight": 700 }));
      // the release order to the line: slices drop onto sheet 1 one by one
      var acBottom = crit.length ? ACY + rowsAC * (EH + 18) - 18 : ACY + 30, RLY = acBottom + 74, ord = slOrder(e);
      o.push(tx(10, RLY - 44, "Release order to the line", { "font-size": 14, "class": "t-disp", "font-weight": 700 }),
        tx(10 + measure("Release order to the line", "t-disp", 14, 700) + 14, RLY - 44, e.mode + " · a slice drops when the slices it depends on are closed", { "font-size": 13, "class": "t2", "data-fit": Wd - 300 }));
      var endW = 150, lineEnd = Wd - 10 - endW - 10;
      o.push(Z("line", { x1: 10, y1: RLY, x2: lineEnd, y2: RLY, "class": "flow" + (ord.some(function (s) { return info[s.slice].ag.length; }) ? " hot" : ""), "marker-end": "url(#bp-arw)" }));
      o.push(Z("g", { "class": "clickable", "data-view": "line", tabindex: 0, role: "button", "aria-label": "Open sheet 1, the line" },
        boxText(Wd - 10 - endW, RLY - 20, endW, 40, { "class": "paperfill", stroke: "var(--ink)", "stroke-width": 1.6 }),
        tx(Wd - 10 - endW / 2, RLY - 3, "Sheet 1", { "text-anchor": "middle", "font-size": 13, "class": "t-disp t2", "font-weight": 700 }),
        tx(Wd - 10 - endW / 2, RLY + 13, "the line →", { "text-anchor": "middle", "font-size": 14, "class": "t-disp", "font-weight": 700 })));
      if (!ord.length) o.push(tx(24, RLY - 10, "nothing to release yet", { "font-size": 13, "class": "t3" }));
      var slotW = ord.length ? Math.min(320, Math.floor((lineEnd - 30 - (ord.length - 1) * 14) / ord.length)) : 0;
      ord.forEach(function (s, k) {
        var I = info[s.slice], nx = nextS && nextS.slice === s.slice, x = 20 + k * (slotW + 14), y = RLY - 19;
        var cls = nx ? "hl-fill" : I.ag.length ? "st-live" : "paperfill", stc = I.done ? "var(--ok)" : I.ag.length ? "var(--agent)" : I.started || nx ? "var(--ink)" : "var(--ink-3)";
        var line2 = I.done ? "✓ closed" : I.started ? "at " + (I.label || wd("state", I.st)) : nx ? (s.waiting_on.length ? "next · waits on " + s.waiting_on.join(", ") : "drops next") : s.waiting_on.length ? "waits on " + s.waiting_on.join(", ") : "queued";
        o.push(Z("g", I.j ? { "class": "clickable", "data-open": I.j.id, tabindex: 0, role: "button", "aria-label": s.slice + ": open its job" } : null, Z("title", null, (k + 1) + ". " + s.slice + " " + s.title + " — " + line2),
          nx ? boxText(x - 4, y - 4, slotW + 8, 46, { "class": "hl-glow breathe" }) : null,
          boxText(x, y, slotW, 38, { "class": cls, stroke: stc, "stroke-width": I.started || nx ? 1.8 : 1.1, "stroke-dasharray": I.done ? "4 2" : !I.started && !nx ? "4 3" : null }),
          Z("text", { x: x + 8, y: y + 16, "font-size": 13, "data-fit": slotW - 14 }, ts((k + 1) + " · ", { "class": nx ? "on-hl" : "t2" }), ts(s.slice, { "class": "t-mono" + (nx ? " on-hl" : ""), "font-weight": 700 }), ts(" " + s.title, { "class": nx ? "on-hl" : "t2" })),
          tx(x + 8, y + 32, line2, { "font-size": 13, "class": "t-cond " + (nx ? "on-hl" : I.done ? "t-ok" : I.ag.length ? "t-agent" : I.started ? "" : "t3"), "font-weight": 600, "data-fit": slotW - 14 })));
      });
      var nl = nextS ? "Next onto the line: " + nextS.slice + " " + nextS.title + (nextS.waiting_on.length ? " — waits on " + nextS.waiting_on.map(function (w) { var I = info[w]; return w + (I ? " (" + (I.done ? "closed" : I.label ? "at " + I.label : "not started") + ")" : ""); }).join(", ") : " — ready to drop")
        : ord.length ? "Every slice is on the line or closed." : "";
      if (nl) o.push(tx(10, RLY + 44, nl, { "font-size": 13.5, "class": nextS ? "" : "t2", "font-weight": 600, "data-fit": Wd - 20 }));
      return { nodes: o, H: RLY + 58 };
    }
    function renderBreakdown() {
      var e = epCur();
      var head = H("div", { "class": "viewhead" }, H("h2", { text: "Epic breakdown" }), H("p", { text: (e ? e.slug + " · " : "") + "exploded view: slices as parts, the epic criteria each proves, what depends on what, and their order onto the line · " + epAsOf() }), H("span", { "class": "grow" }), epPicker("ebreak"));
      if (!e) { fill(views.ebreak, head, emptyEpics()); return; }
      tbDraw.textContent = "Epic breakdown · " + e.slug;
      var Wd = drawW(views.ebreak), dr = epBreakdownDrawing(e, Wd), info = {}, sl = slOrder(e);
      sl.forEach(function (s) { info[s.slice] = slInfo(s); });
      var crit = e.e_criteria;
      var cov = H("div", { "class": "pane mb" }, H("h4", null, "Which slice proves which criterion", H("em", { text: e.delivery.e_criteria_delivered + " of " + e.delivery.e_criteria_total + " delivered" })),
        H("div", { "class": "pb" }, crit.length ? H("div", { "class": "ox", "data-keep": "ecov" }, H("table", { "class": "cov" },
          H("thead", null, H("tr", null, H("th", { text: "Epic criterion" }), H("th", { text: "what it says" }), sl.map(function (s) { return H("th", { "class": "c", text: s.slice, title: s.title }); }), H("th", { text: "status" }))),
          H("tbody", null, crit.map(function (c) {
            return H("tr", null, H("td", { "class": "b", title: c.id }, wd("crit", c.id), " ", H("span", { "class": "chip tag", text: c.id })), H("td", { text: c.text }),
              sl.map(function (s) {
                var on = s.e_criteria.indexOf(c.id) >= 0 || c.slices.indexOf(s.slice) >= 0, I = info[s.slice];
                return H("td", { "class": "c" + (on ? (I.done ? " ok" : I.started ? " ag" : " pend") : ""), title: on ? s.slice + " delivers " + c.id + " · " + (I.done ? "slice closed" : I.started ? "at " + I.label : "not started") : "" }, on ? (I.done ? "✓" : I.started ? "●" : "○") : "");
              }),
              H("td", null, H("span", { "class": "chip " + (c.status === "delivered" ? "ok" : c.status === "in_progress" ? "ag" : "mute"), text: words(c.status) })));
          })),
          sl.length ? H("tfoot", null, H("tr", null, H("td", { "class": "mono b", text: "slice" }), H("td", { "class": "meta", text: "its job on the line" }),
            sl.map(function (s) { var I = info[s.slice]; return H("td", { "class": "c meta", text: I.done ? "closed" : I.label ? I.label.toLowerCase() : "—" }); }), H("td"))) : null))
          : H("p", { "class": "meta", text: "No epic criteria recorded yet." }),
          crit.length && !sl.length ? H("p", { "class": "meta", text: "Not sliced yet: each criterion gets its slices in stage 03." }) : null));
      var con = H("div", { "class": "pane mb" }, H("h4", null, "Contracts", H("em", { text: e.contracts.filter(function (c) { return c.frozen; }).length + " of " + e.contracts.length + " frozen" })),
        H("div", { "class": "pb" }, e.contracts.length ? H("table", { "class": "rev" }, H("thead", null, H("tr", null, H("th", { text: "Part" }), H("th", { text: "Path" }), H("th", { text: "State" }), H("th", { text: "Touched by" }))),
          H("tbody", null, e.contracts.map(function (c, k) {
            return H("tr", null, H("td", { "class": "mono", text: "C" + (k + 1) }), H("td", { "class": "mono", text: c.path }), H("td", null, H("span", { "class": "chip " + (c.frozen ? "ok" : "fail"), text: c.frozen ? "frozen" : "open" })), H("td", { "class": "mono", text: c.touched_by.join(", ") || "—" }));
          }))) : H("p", { "class": "meta", text: "No contracts recorded yet." })));
      var am = e.amendment_requests;
      var amP = H("div", { "class": "pane" }, H("h4", null, "Amendment requests", H("em", { text: am.filter(function (a) { return a.status !== "decided"; }).length + " open" })),
        H("div", { "class": "pb" }, am.length ? H("ul", { "class": "lst" }, am.slice().reverse().map(function (a) {
          return H("li", null, H("span", { "class": "when", text: a.at ? fT(P(a.at)) : "—" }), H("span", null, H("span", { "class": "chip " + (a.status === "decided" ? "mute" : "hl"), text: a.status || "open" }), " ", H("b", { text: a.slice || "?" }), " " + (a.reason || "")));
        })) : H("p", { "class": "meta", text: "No amendment requests: no slice has asked to change the epic." })));
      fill(views.ebreak, head, waitPane(e), drawingSvg(views.ebreak, "ebreak-d", Wd, dr, "Exploded view of epic " + e.slug + ": " + plural(e.slices.length, "slice")),
        H("div", { "class": "two egap" }, H("div", null, cov), H("div", null, con, amP)));
      fitIn(views.ebreak);
    }

    // ---------------------------------------------------------------- sheet 2: projection (globe)
    var G = { yaw: .6, pitch: .35, zoom: 1, paused: false, hover: null, nodes: [], edges: [], id: {}, layers: { repo: true, folder: true, file: true, epic: true, job: true, doc: true, task: true, agent: true }, last: 0, screen: [], running: false };
    function buildGraph() {
      var N = [], E = [], id = {}, hoverKey = G.hover && G.hover.k;
      var addN = function (k, kind, label, lat, lon, extra) { var n = Object.assign({ k: k, kind: kind, label: label, lat: lat, lon: lon }, extra || {}); id[k] = n; N.push(n); return n; };
      addN("repo", "repo", REPO, 90, 0);
      var folders = {}, files = {};
      var dirOf = function (p) { return p.indexOf("/") >= 0 ? p.slice(0, p.lastIndexOf("/")) : "."; };
      JOBS.forEach(function (j) {
        j.tasks.forEach(function (t) { t.allowed_paths.forEach(function (p) { if (p.indexOf("*") >= 0) folders[p.replace(/\/?\*.*$/, "") || "."] = 1; else { files[p] = 1; folders[dirOf(p)] = 1; } }); });
        j.reviews.forEach(function (v) { v.findings.forEach(function (f) { if (f.file) { files[f.file] = 1; folders[dirOf(f.file)] = 1; } }); });
      });
      var fl = Object.keys(folders); fl.forEach(function (f, i) { addN("d:" + f, "folder", f + "/", 58, i * 360 / fl.length); E.push(["repo", "d:" + f]); });
      var fls = Object.keys(files);
      fls.forEach(function (f) { var d = dirOf(f), pn = id["d:" + d], sib = fls.filter(function (x) { return dirOf(x) === d; }), k = sib.indexOf(f); addN("f:" + f, "file", f.split("/").pop(), 36 + (k % 2) * 7, (pn ? pn.lon : 0) + (k - (sib.length - 1) / 2) * 11); E.push(["d:" + d, "f:" + f]); });
      JOBS.forEach(function (j, i) {
        var lon = i * 360 / Math.max(1, JOBS.length) + 12, lat = ((i % 3) - 1) * 14; addN("j:" + j.id, "job", j.slug, lat, lon, { job: j });
        j.docs.forEach(function (d, k) { addN("o:" + j.id + d.name, "doc", d.name || "document", lat - 17, lon + (k - (j.docs.length - 1) / 2) * 6.5, { job: j }); E.push(["j:" + j.id, "o:" + j.id + d.name]); });
        j.tasks.forEach(function (t, k) {
          addN("t:" + j.id + t.id, "task", t.id, lat + 15, lon + (k - (j.tasks.length - 1) / 2) * 8, { job: j, task: t }); E.push(["j:" + j.id, "t:" + j.id + t.id]);
          t.allowed_paths.forEach(function (p) { var key = p.indexOf("*") >= 0 ? "d:" + (p.replace(/\/?\*.*$/, "") || ".") : "f:" + p; if (id[key]) E.push(["t:" + j.id + t.id, key]); });
        });
      });
      D.epics.forEach(function (e) {
        var js = e.slices.filter(function (s) { return s.job && id["j:" + s.job]; }).map(function (s) { return id["j:" + s.job]; });
        var lon = js.length ? js.reduce(function (a, n) { return a + n.lon; }, 0) / js.length : 0; addN("e:" + e.id, "epic", e.slug, -58, lon);
        js.forEach(function (n) { E.push(["e:" + e.id, n.k]); }); E.push(["repo", "e:" + e.id]);
      });
      var roles = uniq(ACT.filter(function (a) { return a.agent; }).map(function (a) { return a.agent; }));
      roles.forEach(function (r, i) { addN("a:" + r, "agent", agentLabel(r), 0, i * 360 / roles.length, { orbit: true, role: r }); uniq(ACT.filter(function (a) { return a.agent === r; }).map(function (a) { return a.job; })).forEach(function (jid) { E.push(["a:" + r, "j:" + jid, "agent"]); }); });
      JOBS.forEach(function (j) { E.push(["repo", "j:" + j.id, "weak"]); });
      G.nodes = N; G.edges = E.map(function (e) { return { a: id[e[0]], b: id[e[1]], kind: e[2] || "" }; }).filter(function (e) { return e.a && e.b; }); G.id = id;
      G.hover = hoverKey ? id[hoverKey] || null : null;
      var cnt = {}; N.forEach(function (n) { cnt[n.kind] = (cnt[n.kind] || 0) + 1; });
      var names = { repo: "Repository", folder: "Folder hubs", file: "Files", epic: "Epics", job: "Jobs", doc: "Documents", task: "Tasks", agent: "Agents (orbit)" };
      fill(glLayers, H("h5", { text: "Layers" }), Object.keys(names).filter(function (k) { return cnt[k] || k === "job"; }).map(function (k) {   // only layers with something on them
        var c = H("input", { type: "checkbox", "data-layer": k }); c.checked = !!G.layers[k];
        c.addEventListener("change", function () { G.layers[k] = c.checked; });
        return H("label", null, c, " " + names[k], H("span", { text: String(cnt[k] || 0) }));
      }));
    }
    function readColors() { var cs = getComputedStyle(root); ["--paper", "--paper-2", "--ink", "--ink-2", "--ink-3", "--hl", "--agent", "--fail", "--ok", "--done", "--on-hl", "--f-mono"].forEach(function (k) { C[k] = cs.getPropertyValue(k).trim(); }); }
    function proj(n, cx, cy, R, time) {
      var x, y, z;
      if (n.orbit) { var a = (n.lon * Math.PI / 180) + time * .00012, r = 1.34; x = Math.cos(a) * r; z = Math.sin(a) * r; y = Math.sin(a * 2) * .08; }
      else { var la = n.lat * Math.PI / 180, lo = n.lon * Math.PI / 180; x = Math.cos(la) * Math.sin(lo); y = Math.sin(la); z = Math.cos(la) * Math.cos(lo); }
      var cyw = Math.cos(G.yaw), syw = Math.sin(G.yaw), x1 = x * cyw + z * syw, z1 = -x * syw + z * cyw, cp = Math.cos(G.pitch), sp = Math.sin(G.pitch), y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
      return { x: cx + x1 * R, y: cy - y1 * R, z: z2 };
    }
    function globeSignals(n, t) {
      var j = n.job; if (!j) return []; var r = S.jobs.filter(function (x) { return x.j === j; })[0]; if (!r) return ["absent"]; var out = [];
      if (n.kind !== "job") return r.done ? ["done"] : [];
      if (r.g && r.g !== "H4") out.push("hl"); if (r.ag.length) out.push("agent"); if (r.done) out.push("done"); else if (t - P(j.updated_at) > 14 * DAY) out.push("stale");
      var lastMove = Math.max.apply(null, [P(j.created_at)].concat(j.history.filter(function (h) { return P(h.at) <= t; }).map(function (h) { return P(h.at); })));
      if (t - lastMove < DAY && !r.done) out.push("ok");
      if (["building", "integrating"].indexOf(r.s) >= 0) out.push("unc"); return out;
    }
    function startGlobe() { if (G.running) return; G.running = true; G.last = 0; requestAnimationFrame(drawGlobe); }
    function drawGlobe(now) {
      if (!alive() || view !== "globe") { G.running = false; return; }
      var cv = globe, dpr = window.devicePixelRatio || 1, W2 = cv.clientWidth, H2 = cv.clientHeight;
      if (!W2 || !H2) { requestAnimationFrame(drawGlobe); return; }
      if (cv.width !== Math.round(W2 * dpr) || cv.height !== Math.round(H2 * dpr)) { cv.width = Math.round(W2 * dpr); cv.height = Math.round(H2 * dpr); }
      var ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W2, H2);
      var reduce = RM.matches || snapshotOn; if (!G.paused && !reduce && !G.drag && G.last) G.yaw += (now - G.last) * .00008; G.last = now;
      var cx = W2 / 2 + (W2 > 900 ? 40 : 0), cy = H2 / 2 - 10, R = Math.min(W2 * .36, H2 * .36) * G.zoom, t = S.t;
      var orbitT = reduce ? 0 : now;
      ctx.lineWidth = 1;
      var line = function (pts) { for (var i = 1; i < pts.length; i++) { var a = pts[i - 1], b = pts[i], front = (a.z + b.z) / 2 > 0; ctx.strokeStyle = C["--ink-3"]; ctx.globalAlpha = front ? .55 : .22; ctx.setLineDash(front ? [] : [3, 4]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); } };
      var lo, la, pts;
      for (lo = 0; lo < 360; lo += 30) { pts = []; for (la = -90; la <= 90; la += 6) pts.push(proj({ lat: la, lon: lo }, cx, cy, R, 0)); line(pts); }
      for (la = -60; la <= 60; la += 30) { pts = []; for (lo = 0; lo <= 360; lo += 6) pts.push(proj({ lat: la, lon: lo }, cx, cy, R, 0)); line(pts); }
      ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.strokeStyle = C["--ink"]; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = C["--fail"]; ctx.globalAlpha = .6; ctx.lineWidth = 1; ctx.setLineDash([16, 3, 3, 3]); ctx.beginPath(); ctx.moveTo(cx - R - 24, cy); ctx.lineTo(cx + R + 24, cy); ctx.moveTo(cx, cy - R - 24); ctx.lineTo(cx, cy + R + 24); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      if (G.layers.agent) { pts = []; for (var an = 0; an <= 360; an += 5) pts.push(proj({ orbit: true, lon: an }, cx, cy, R, 0)); ctx.lineWidth = 1; for (var i = 1; i < pts.length; i++) { var a = pts[i - 1], b = pts[i], f = (a.z + b.z) / 2 > 0; ctx.strokeStyle = C["--ink-2"]; ctx.globalAlpha = f ? .5 : .18; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); } ctx.setLineDash([]); ctx.globalAlpha = 1; }
      var vis = function (n) {
        return G.layers[n.kind] && (!n.job || P(n.job.created_at) <= t) && (n.kind !== "task" || (n.job && intervals(n.job, t).some(function (iv) { return SIDX[S2STAGE[iv.state]] >= 3; })))
          && (n.kind !== "doc" || (n.job && P(n.job.created_at) + 20 * MIN <= t)) && (n.kind !== "agent" || ACT.some(function (a) { return a.agent === n.role && P(a.at) <= t; }));
      };
      var P2 = {}; G.nodes.forEach(function (n) { P2[n.k] = proj(n, cx, cy, R, orbitT); });
      var hv = G.hover, nb = {}; if (hv) { nb[hv.k] = 1; G.edges.forEach(function (e) { if (e.a === hv) nb[e.b.k] = 1; if (e.b === hv) nb[e.a.k] = 1; }); }
      G.edges.forEach(function (e) {
        if (!vis(e.a) || !vis(e.b)) return;
        if (e.kind === "agent") { var ag = S.agents.some(function (x) { return "factory:" + x.agent === e.a.role && "j:" + x.job.id === e.b.k; }); if (!ag && !(hv && (e.a === hv || e.b === hv))) return; }
        var a = P2[e.a.k], b = P2[e.b.k], front = a.z > 0 && b.z > 0, hot = hv && (e.a === hv || e.b === hv);
        ctx.strokeStyle = e.kind === "agent" ? C["--agent"] : C["--ink"]; ctx.globalAlpha = hot ? .95 : (hv ? .08 : (front ? (e.kind === "weak" ? .12 : .38) : .12)); ctx.lineWidth = hot ? 1.6 : 1; ctx.setLineDash(front ? [] : [3, 3]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      });
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      var order = G.nodes.filter(vis).sort(function (a, b) { return P2[a.k].z - P2[b.k].z; }); G.screen = [];
      var pulse = reduce ? 0 : (now % 2200) / 2200;
      order.forEach(function (n) {
        var p = P2[n.k], front = p.z > -0.05 || n.orbit, base = hv && !nb[n.k] ? .2 : (front ? 1 : .35); ctx.globalAlpha = base;
        var s = n.kind === "job" ? 7 : n.kind === "repo" ? 11 : n.kind === "epic" ? 8 : n.kind === "folder" ? 6 : n.kind === "agent" ? 5.5 : 4.5;
        ctx.lineWidth = 1.4; ctx.strokeStyle = C["--ink"]; ctx.fillStyle = C["--paper"]; ctx.beginPath();
        if (n.kind === "repo") { for (var q = 0; q < 6; q++) { var an2 = Math.PI / 3 * q + Math.PI / 6; ctx.lineTo(p.x + Math.cos(an2) * s, p.y + Math.sin(an2) * s); } ctx.closePath(); }
        else if (n.kind === "epic") { ctx.moveTo(p.x, p.y - s); ctx.lineTo(p.x + s, p.y); ctx.lineTo(p.x, p.y + s); ctx.lineTo(p.x - s, p.y); ctx.closePath(); }
        else if (n.kind === "task") { ctx.moveTo(p.x, p.y - s); ctx.lineTo(p.x + s, p.y + s * .8); ctx.lineTo(p.x - s, p.y + s * .8); ctx.closePath(); }
        else if (n.kind === "doc") ctx.rect(p.x - s * .8, p.y - s, s * 1.6, s * 2);
        else if (n.kind === "folder") ctx.rect(p.x - s, p.y - s * .7, s * 2, s * 1.4);
        else if (n.kind === "file") ctx.arc(p.x, p.y, s * .7, 0, Math.PI * 2);
        else ctx.arc(p.x, p.y, s, 0, Math.PI * 2);
        var sig = n.kind === "job" || n.kind === "doc" || n.kind === "task" ? globeSignals(n, t) : [];
        if (n.kind === "agent") { var on = S.agents.some(function (a) { return "factory:" + a.agent === n.role; }); ctx.fillStyle = on ? C["--agent"] : C["--paper"]; ctx.strokeStyle = on ? C["--agent"] : C["--ink-2"]; }
        if (n.kind === "job" && sig.indexOf("hl") >= 0) ctx.fillStyle = C["--hl"];
        if (n.kind === "task" && n.task) { var ts2 = taskStatusAt(n.job, n.task, t); if (ts2 === "failing") ctx.strokeStyle = C["--fail"]; if (ts2 === "passing") ctx.strokeStyle = C["--ok"]; }
        if (sig.indexOf("done") >= 0) ctx.strokeStyle = C["--done"];
        ctx.fill(); ctx.stroke();
        if (n.kind === "job") {
          var rr = s + 4;
          sig.forEach(function (sg) {
            var col = { hl: C["--hl"], agent: C["--agent"], ok: C["--ok"], stale: C["--fail"], done: C["--done"], unc: C["--ink-2"] }[sg]; if (!col) return;
            ctx.strokeStyle = col; ctx.lineWidth = 2.4; ctx.setLineDash(sg === "unc" ? [3, 3] : []); ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
            if ((sg === "hl" || sg === "agent") && pulse) { ctx.globalAlpha = (1 - pulse) * .8 * (front ? 1 : .4); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, rr + pulse * 14, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = base; }
            rr += 4;
          });
        }
        G.screen.push({ n: n, x: p.x, y: p.y, front: front });
      });
      ctx.globalAlpha = 1;
      ctx.font = "500 12.5px " + (C["--f-mono"] || "monospace"); ctx.textBaseline = "middle";
      order.forEach(function (n) {
        var p = P2[n.k], show = hv ? nb[n.k] : ((n.kind === "job" || n.kind === "repo" || n.kind === "epic" || (n.kind === "folder" && W2 > 700)) && p.z > 0.1); if (!show) return;
        var txt = n.kind === "epic" ? "epic " + n.label : n.label, tw = ctx.measureText(txt).width, lx = p.x + 12, ly = p.y - 14;
        ctx.fillStyle = C["--paper"]; ctx.strokeStyle = C["--ink"]; ctx.lineWidth = 1; ctx.globalAlpha = .94; ctx.fillRect(lx, ly - 9, tw + 10, 18); ctx.globalAlpha = 1; ctx.strokeRect(lx, ly - 9, tw + 10, 18);
        ctx.beginPath(); ctx.moveTo(p.x + 4, p.y - 4); ctx.lineTo(lx, ly); ctx.stroke(); ctx.fillStyle = C["--ink"]; ctx.fillText(txt, lx + 5, ly + .5);
      });
      requestAnimationFrame(drawGlobe);
    }
    function globeWords() {
      var t = S.t, js = S.jobs, hv = G.hover;
      var docs = G.nodes.filter(function (n) { return n.kind === "doc" && P(n.job.created_at) <= t; }).length, tasks = G.nodes.filter(function (n) { return n.kind === "task" && P(n.job.created_at) <= t; }).length;
      if (hv) {
        var nbs = G.edges.filter(function (e) { return e.a === hv || e.b === hv; }).map(function (e) { return e.a === hv ? e.b : e.a; });
        fill(glWords, H("b", { text: hv.kind + " · " + hv.label }), "connected to " + nbs.length + ": " + nbs.slice(0, 8).map(function (n) { return n.kind + " " + n.label; }).join(", ") + (nbs.length > 8 ? " …" : "") + (hv.job && hv.kind === "job" ? " · click to open its section view" : ""));
        return;
      }
      var ep = D.epics.length ? D.epics.length + " epic" + (D.epics.length === 1 ? "" : "s") + " (" + D.epics.map(function (e) { return e.slug; }).join(", ") + ") split" + (D.epics.length === 1 ? "s" : "") + " into " + D.epics.reduce(function (a, e) { return a + e.slices.length; }, 0) + " slices. " : "No epic is open. ";
      fill(glWords, H("b", { text: "Graph in words" }), REPO + " holds " + plural(js.length, "job") + " at this revision: " + S.gates.length + " wait on you, " + uniq(S.agents.map(function (a) { return a.job.id; })).length + " have agents at work, " + js.filter(function (r) { return r.done; }).length + " finished. " + ep +
        docs + " documents and " + tasks + " tasks touch " + G.nodes.filter(function (n) { return n.kind === "file"; }).length + " files in " + G.nodes.filter(function (n) { return n.kind === "folder"; }).length + " folders; " + G.nodes.filter(function (n) { return n.kind === "agent"; }).length + " agent roles orbit the repository.");
    }
    (function initGlobe() {
      var down = null;
      globe.addEventListener("pointerdown", function (e) { down = { x: e.clientX, y: e.clientY, yaw: G.yaw, pitch: G.pitch, moved: false }; try { globe.setPointerCapture(e.pointerId); } catch (er) { /* capture is optional */ } globe.classList.add("bp-drag"); G.drag = true; });
      globe.addEventListener("pointermove", function (e) {
        var r = globe.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
        if (down) { var dx = e.clientX - down.x, dy = e.clientY - down.y; if (Math.abs(dx) + Math.abs(dy) > 3) down.moved = true; G.yaw = down.yaw + dx * .008; G.pitch = Math.max(-1.3, Math.min(1.3, down.pitch + dy * .008)); return; }
        var best = null, bd = 16; G.screen.forEach(function (s) { if (!s.front) return; var d = Math.hypot(s.x - mx, s.y - my); if (d < bd) { bd = d; best = s.n; } });
        if (best !== G.hover) { G.hover = best; globeWords(); globe.style.cursor = best && best.kind === "job" ? "pointer" : "grab"; }
      });
      globe.addEventListener("pointerup", function () { globe.classList.remove("bp-drag"); G.drag = false; if (down && !down.moved && G.hover && G.hover.kind === "job") openSection(G.hover.job.id); down = null; });
      globe.addEventListener("pointerleave", function () { if (!down) { G.hover = null; globeWords(); } });
      globe.addEventListener("wheel", function (e) { e.preventDefault(); G.zoom = Math.max(.6, Math.min(2.2, G.zoom * (e.deltaY > 0 ? .92 : 1.08))); }, { passive: false });
      glPause.addEventListener("click", function () { G.paused = !G.paused; glPause.textContent = G.paused ? "Turn" : "Pause"; glPause.setAttribute("aria-pressed", String(G.paused)); });
      glReset.addEventListener("click", function () { G.yaw = .6; G.pitch = .35; G.zoom = 1; });
    })();

    // ---------------------------------------------------------------- render orchestration (keeps the user's place)
    function scrollers() { return [notesBody, views[view], secBody].concat([].slice.call(root.querySelectorAll("[data-keep]"))); }
    function keepPlace(fn) {
      var saved = scrollers().map(function (n) { return { key: n.getAttribute("data-keep"), n: n, top: n.scrollTop, left: n.scrollLeft }; });
      var a = document.activeElement, fk = null;
      if (a && root.contains(a) && a !== document.body) {
        ["data-epick", "data-epic", "data-edoc", "data-xp", "data-open", "data-copy", "data-v", "data-doc", "data-bm", "data-at", "data-job", "data-more", "data-view", "data-layer"].some(function (k) { if (a.hasAttribute && a.hasAttribute(k)) { fk = "[" + k + '="' + String(a.getAttribute(k)).replace(/["\\]/g, "\\$&") + '"]'; return true; } return false; });
      }
      fn();
      saved.forEach(function (s) {
        var n = s.key ? root.querySelector('[data-keep="' + s.key + '"]') : s.n;
        if (!n) return; if (s.top) n.scrollTop = s.top; if (s.left) n.scrollLeft = s.left;
      });
      if (fk && (!document.activeElement || document.activeElement === document.body || !root.contains(document.activeElement))) {
        var again = null; try { again = root.querySelector(fk); } catch (e) { again = null; }
        if (again) again.focus({ preventScroll: true });
      }
    }
    function setT(t, isLive) { T = Math.max(T0, Math.min(TN, t)); live = !!isLive || T >= TN; if (live) T = TN; if (!pending) { pending = true; requestAnimationFrame(function () { pending = false; if (alive()) renderAll(false); }); } }
    function renderAll(full) {
      S = snap(T); renderTB(); renderTicks();
      var sig = [S.rev, S.agents.length, S.den24, S.lessonsWaiting.length, Math.floor(T / ((playing ? 60 : 1) * MIN)), view, sel, filter, boardMode, EPSIG, epSel].join("|");
      if (!full && sig === lastSig) return;
      if (!full && document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute("data-epick") && root.contains(document.activeElement)) return;   // a tick never closes an open picker
      lastSig = sig;
      keepPlace(function () {
        renderNotes();
        if (view === "line") renderDrawing();
        if (view === "board") renderBoard(); if (view === "sched") renderSched(); if (view === "agents") renderAgents(); if (view === "learn") renderLearn(); if (view === "globe") globeWords();
        if (view === "epics") renderRegister(); if (view === "eflow") renderAssembly(); if (view === "ebreak") renderBreakdown();
        if (sel) renderSection();
      });
    }
    function setView(v) {
      if (VIEWS.indexOf(v) < 0) v = "line";   // a sheet this port leaves out (the epic series) opens sheet 1
      view = v; try { window.localStorage.setItem("dx-blueprint-view", v); } catch (e) { /* storage blocked */ }
      [].forEach.call(tabs.querySelectorAll("button"), function (b) { b.setAttribute("aria-selected", String(b.getAttribute("data-v") === v)); });
      VIEWS.forEach(function (k) { views[k].classList.toggle("bp-on", k === v); });
      tbDraw.textContent = VIEW_NAME[v]; tbSheetK.textContent = "Sheet " + (VIEWS.indexOf(v) + 1) + " / " + VIEWS.length;
      renderAll(true); if (v === "globe") { readColors(); startGlobe(); }
    }

    // ---------------------------------------------------------------- interactions
    var toastTimer = null;
    function toast(m) { toastEl.textContent = m; toastEl.classList.add("bp-on"); clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.classList.remove("bp-on"); }, 1400); }
    function inDraw(n) { return n && draw.contains(n); }
    root.addEventListener("click", function (e) {
      var c = e.target.closest("[data-copy]");
      if (c) { api.copy(c.getAttribute("data-copy"), c); c.classList.add("bp-done"); setTimeout(function () { c.classList.remove("bp-done"); }, 1400); toast("Copied · paste it in chat"); return; }
      var ep = e.target.closest("[data-epic]");
      if (ep) { e.stopPropagation(); goEpic(ep.getAttribute("data-epic"), ep.getAttribute("data-epic-view")); findList.hidden = true; return; }
      var ed = e.target.closest("[data-edoc]");
      if (ed) { var ee = epById(ed.getAttribute("data-edoc-epic")); if (ee) { epDocIdx[ee.id] = +ed.getAttribute("data-edoc"); keepPlace(renderAssembly); } return; }
      var d = e.target.closest("[data-doc]");
      if (d && sel) { var j = JBY[sel], i = +d.getAttribute("data-doc"); docIdx[sel] = i; [].forEach.call(secBody.querySelectorAll("[data-doc]"), function (x) { x.setAttribute("aria-selected", String(x === d)); }); var hold = d.parentNode.nextSibling; if (hold && j && j.docs[i]) fill(hold, docBody(j.docs[i])); return; }
      var xp = e.target.closest("[data-xp]"); if (xp && secBody.contains(xp)) { var xk = xp.getAttribute("data-xp"); secOpen[xk] = !secOpen[xk]; keepPlace(renderSection); return; }
      var lm = e.target.closest("[data-lesson]"); if (lm) { var lid = lm.getAttribute("data-lesson"); lessonOpen[lid] = !lessonOpen[lid]; renderNotes(); var again = notesBody.querySelector('[data-lesson="' + lid.replace(/["\\]/g, "") + '"]'); if (again) again.focus({ preventScroll: true }); return; }
      var oc = e.target.closest("[data-classic]"); if (oc && api.openClassic) { setNotes(false); api.openClassic(oc.getAttribute("data-classic")); return; }
      var dn = e.target.closest("[data-notes]"); if (dn) { setNotes(true, dn.getAttribute("data-notes") === "lessons"); return; }
      var bm = e.target.closest("[data-bm]"); if (bm) { boardMode = bm.getAttribute("data-bm"); renderAll(true); return; }
      var tb = e.target.closest("[data-v]"); if (tb && (tabs.contains(tb) || footer.contains(tb))) { setView(tb.getAttribute("data-v")); return; }
      var o = e.target.closest("[data-open]"); if (o) { openSection(o.getAttribute("data-open")); findList.hidden = true; return; }
      var m = e.target.closest(".bp-mk[data-job]"); if (inDraw(m)) { openSection(m.getAttribute("data-job")); return; }
      var more = e.target.closest(".bp-mk[data-more]"); if (inDraw(more)) { setView("board"); return; }
      // only this drawing's [data-view]: the console's own #app carries data-view too
      var v = e.target.closest("[data-view]"); if (v && root.contains(v)) { if (notes.contains(v)) setNotes(false); setView(v.getAttribute("data-view")); return; }
      var tr = e.target.closest("tr[data-at]"); if (tr) { pause(); setT(+tr.getAttribute("data-at"), false); return; }
    });
    root.addEventListener("keydown", function (e) {
      var a = e.target;
      if (e.key === "Enter" || e.key === " ") {
        if (a.matches && a.matches("tr[data-edoc]")) { e.preventDefault(); a.click(); return; }
        if (a.matches && a.matches("g[data-epic], tr[data-epic]")) { e.preventDefault(); e.stopPropagation(); goEpic(a.getAttribute("data-epic"), a.getAttribute("data-epic-view")); return; }
        if (a.matches && a.matches("g[data-open], tr[data-open]")) { e.preventDefault(); openSection(a.getAttribute("data-open")); return; }
        if (a.matches && a.matches("g[data-view]")) { e.preventDefault(); setView(a.getAttribute("data-view")); return; }
        if (a.matches && a.matches(".bp-mk[data-job]") && inDraw(a)) { e.preventDefault(); openSection(a.getAttribute("data-job")); return; }
        if (a.matches && a.matches(".bp-mk[data-more]") && inDraw(a)) { e.preventDefault(); setView("board"); return; }
        if (a.matches && a.matches("g[data-notes]")) { e.preventDefault(); setNotes(true, true); return; }
        if (a.matches && a.matches("tr[data-at]")) { e.preventDefault(); pause(); setT(+a.getAttribute("data-at"), false); return; }
      }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        if (a.matches && a.matches("[data-v]") && tabs.contains(a)) { var i = VIEWS.indexOf(a.getAttribute("data-v")), n = VIEWS[(i + (e.key === "ArrowRight" ? 1 : VIEWS.length - 1)) % VIEWS.length]; setView(n); var nb = tabs.querySelector('[data-v="' + n + '"]'); if (nb) nb.focus(); }
      }
    });
    function onDocKey(e) {
      if (!alive()) { document.removeEventListener("keydown", onDocKey); return; }
      if (root.offsetParent === null) return;   // another console view is showing: its keys are its own
      var a = document.activeElement, tag = (a && a.tagName) || "";
      if (e.key === "Escape") {
        // the find box behaves as the console's own #q: Esc clears what is typed, the next Esc lets go of the keyboard
        if (a === findIn) { if (findIn.value) { findIn.value = ""; findRender(); } else { findList.hidden = true; findIn.blur(); } return; }
        if (!findList.hidden) { findList.hidden = true; return; } if (sel) { closeSection(); return; } if (notesOpen) { setNotes(false); return; }
      }
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") { e.preventDefault(); findIn.focus(); }
    }
    document.addEventListener("keydown", onDocKey);
    var relayP = false;
    function relayout() {
      if (relayP) return; relayP = true;
      requestAnimationFrame(function () {
        relayP = false; if (!alive() || !S) return;
        if (view === "line") keepPlace(renderDrawing); else if (view === "eflow") keepPlace(renderAssembly); else if (view === "ebreak") keepPlace(renderBreakdown);
      });
    }
    // the epic drawings are laid out to the sheet's width too
    if (window.ResizeObserver) { var lastSh = ""; var roS = new ResizeObserver(function () { if (!alive()) { roS.disconnect(); return; } var k = String(sheet.clientWidth); if (k !== lastSh) { lastSh = k; if (view === "eflow" || view === "ebreak") relayout(); } }); roS.observe(sheet); }
    function onWin() { if (!alive()) { window.removeEventListener("resize", onWin); window.removeEventListener("scroll", onWin); return; } placeTop(); }
    if (window.ResizeObserver) { var lastCv = ""; var roV = new ResizeObserver(function () { if (!alive()) { roV.disconnect(); return; } var k = views.line.clientWidth + "x" + views.line.clientHeight; if (k !== lastCv) { lastCv = k; relayout(); } }); roV.observe(views.line); }
    else window.addEventListener("resize", relayout);
    window.addEventListener("resize", onWin); window.addEventListener("scroll", onWin, { passive: true });
    if (window.ResizeObserver) { var ro = new ResizeObserver(function () { if (!alive()) { ro.disconnect(); return; } placeTop(); }); ro.observe(document.body); }
    secClose.addEventListener("click", closeSection);
    // find
    var fIdx = 0;
    function findRender() {
      var q = findIn.value.trim().toLowerCase(); filter = q; if (view === "line" && gMarkers) renderMarkers(); if (!q) { findList.hidden = true; return; }
      var res = JOBS.filter(function (j) { return (j.slug + " " + j.id + " " + j.type + " " + (stateAt(j, T) || "")).toLowerCase().indexOf(q) >= 0; });
      fIdx = Math.min(fIdx, Math.max(0, res.length - 1));
      var eres = D.epics.filter(function (e) { return ("epic " + e.slug + " " + e.id + " " + e.stage).toLowerCase().indexOf(q) >= 0; });
      fill(findList, res.length || eres.length ? [res.map(function (j, i) { return H("li", { role: "option", "data-open": j.id, "aria-selected": String(i === fIdx) }, j.slug + (j.epic ? " · " + (j.slice || "slice") : ""), H("span", { text: words(stateAt(j, T) || "not yet") })); }),
        eres.map(function (e) { return H("li", { role: "option", "data-epic": e.id, "data-epic-view": "eflow" }, "epic " + e.slug, H("span", { text: (EP_LABEL[e.stage] || e.stage) + " · sheet 8" })); })] : H("li", { text: "no job or epic matches" }));
      findList.hidden = false;
    }
    findIn.addEventListener("input", function () { fIdx = 0; findRender(); });
    findIn.addEventListener("keydown", function (e) {
      var items = findList.querySelectorAll("li[data-open]");
      if (e.key === "ArrowDown") { fIdx = Math.min(items.length - 1, fIdx + 1); findRender(); e.preventDefault(); }
      if (e.key === "ArrowUp") { fIdx = Math.max(0, fIdx - 1); findRender(); e.preventDefault(); }
      if (e.key === "Enter" && items[fIdx]) { openSection(items[fIdx].getAttribute("data-open")); findList.hidden = true; }
    });
    findIn.addEventListener("blur", function () { setTimeout(function () { findList.hidden = true; }, 150); });
    // snapshot: freeze motion and hold the sheet as issued; live data waiting is applied when it is lifted
    snapBtn.addEventListener("click", function () {
      snapshotOn = !snapshotOn; root.classList.toggle("bp-snapshot", snapshotOn); snapBtn.setAttribute("aria-pressed", String(snapshotOn)); snapBtn.classList.toggle("bp-solid", snapshotOn);
      if (snapshotOn) { pause(); toast("Snapshot issued · motion and data frozen"); renderAll(true); }
      else if (heldData) { var d = heldData; heldData = null; apply(d); toast("Caught up with the live line"); }
      else renderAll(true);
    });
    // replay (revision history)
    function pause() { playing = false; playBtn.textContent = "▶"; playBtn.setAttribute("aria-label", "Play replay"); if (rafP) cancelAnimationFrame(rafP); rafP = null; }
    function play() { if (T >= TN) { T = T0; live = false; } playing = true; playBtn.textContent = "❚❚"; playBtn.setAttribute("aria-label", "Pause replay"); lastF = performance.now(); rafP = requestAnimationFrame(loop); }
    function loop(now) {
      if (!playing) return; if (!alive()) { playing = false; return; }
      var dt = (now - lastF) / 1000; lastF = now; var nt = T + dt * (+speed.value) * 1000;
      if (nt >= TN) { setT(TN, true); pause(); return; } setT(nt, false); rafP = requestAnimationFrame(loop);
    }
    playBtn.addEventListener("click", function () { if (playing) pause(); else play(); });
    liveBtn.addEventListener("click", function () { pause(); setT(TN, true); });
    scrub.addEventListener("input", function () { pause(); var v = +scrub.value; setT(T0 + (TN - T0) * v / 1000, v >= 1000); });

    // theme: SVG follows the CSS tokens by itself; the canvas reads them again
    api.onTheme(function () { if (alive()) readColors(); });
    if (window.matchMedia) { var mq = window.matchMedia("(prefers-color-scheme: light)"); var onMq = function () { if (!alive()) { try { mq.removeEventListener("change", onMq); } catch (e) { /* old browsers */ } return; } readColors(); }; try { mq.addEventListener("change", onMq); } catch (e) { /* old browsers */ } }

    // ---------------------------------------------------------------- live data
    function apply(d) {
      var wasLive = live;
      setData(d); buildGraph();
      if (wasLive) { T = TN; live = true; } else { T = Math.max(T0, Math.min(TN, T)); live = T >= TN; }
      if (sel && !JBY[sel]) { section.classList.remove("bp-on"); section.setAttribute("aria-hidden", "true"); sel = null; }
      renderAll(true);
      if (!findList.hidden && findIn.value) findRender();
    }
    function update(d) { if (!alive() || !d || !d.jobs) return; if (snapshotOn) { heldData = d; renderTB(); return; } apply(d); }

    // ---------------------------------------------------------------- boot
    setData(data); T = TN; placeTop(); readColors(); buildGraph(); setView(view);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (alive()) { mCache = {}; renderAll(true); } });
    return { update: update, debug: { update: update, setT: function (t, l) { setT(t, l); }, setView: setView, openSection: openSection, closeSection: closeSection, range: function () { return [T0, TN]; } } };
  }

  var current = null;
  APP.displays.register({
    id: "blueprint", title: "Blueprint",
    mount: function (root, data, api) { current = create(root, data, api); root.__bp = current.debug; },
    update: function (data) { if (current) current.update(data); }
  });
})();
