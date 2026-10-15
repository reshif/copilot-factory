// words.js: the console's one glossary. Internal ids (H1, AC-3, awaiting_plan_approval, the review lanes) map to plain
// words here, and every view and display shows the plain words first, with the id beside it in a quieter style,
// because the CLI commands use the ids. Pure data and functions: no DOM.
// Ported from claude-software-factory for the Blueprint; Copilot Factory adds HS, its station names and its roles.
//
// The displays get the same object as `api.words` (core/displays.js). Its interface:
//   W.gate(id)            "H1" -> "Approve the contract"          (unknown ids come back unchanged)
//   W.gateShort(id)       "H1" -> "contract"                       (for "Waiting for you: contract")
//   W.state(s, kind)      "awaiting_plan_approval" -> "Waiting for you: plan"; kind "epic" for epic states
//   W.station(id)         "verify" -> "Check"
//   W.lane(id)            "security" -> "Security review"
//   W.role(id)            "finding-verifier" -> "Finding checker"
//   W.verdict(v)          "revise" -> "sent back", "approve" -> "approved", "changes" -> "changes asked"
//   W.criterion(id)       "AC-3" -> "Criterion 3", "E-AC-2" -> "Epic criterion 2"
//   W.criteria(text)      the same, inside a sentence
//   W.type(t)             "dependency" -> "Dependency update"
//   W.term(key)           { word, tip } for fingerprint, evidence, waiver, attestation, slice, contract, ...
//   W.tip(key)            the one-line explanation alone ("" when unknown)
//   W.GOD_EYE             { name: "God Eye", sub: "independent reviewer" }
//   W.GATES, W.STATES, W.EPIC_STATES, W.STATIONS, W.LANES, W.ROLES, W.VERDICTS, W.TERMS, W.TYPES: the tables
APP.words = (function () {
  // The decisions only a person makes. `short` finishes "Waiting for you: ...".
  var GATES = {
    // Q is not a recipe gate: clarify asked you questions and waits on your answers (the Board's "Your turn · Clarify").
    Q: { title: "Answer clarify's questions", short: "questions", tip: "Clarify asked what research could not settle; answer in chat (a question you skip takes its default), or reply change A-n <value> / drop A-n to override an assumption. Then clarify runs its next round." },
    H1: { title: "Approve the contract", short: "contract", tip: "Agree that the contract and its numbered criteria describe what you want (H1 · contract)." },
    H2: { title: "Approve the design", short: "design", tip: "Agree with the approach, written as a design record." },
    H3: { title: "Approve the plan", short: "plan", tip: "Agree with the tasks; approving it starts the build." },
    HS: { title: "Sign off the ship", short: "ship", tip: "Agree that the change is ready to ship; the pull request opens next." },
    H4: { title: "Merge", short: "merge", tip: "Only you merge: on GitHub, or locally and reply merged <commit>. The merge commit is recorded." },
    HF: { title: "Approve the findings", short: "findings", tip: "Accept what the investigation found; nothing merges." },
    A: { title: "Approve a change to the criteria", short: "change", tip: "The criteria or the plan changed after approval; agree to the change." },
    P: { title: "Parked: your call", short: "your call", tip: "The work stopped and waits for your decision; nothing moves until then." },
    EH1: { title: "Approve the epic's goal", short: "epic goal", tip: "Agree with the epic's outcome and its criteria." },
    EH2: { title: "Approve the epic's architecture", short: "architecture", tip: "Agree with the design every slice builds on; the contracts freeze." },
    EH3: { title: "Approve the slices", short: "slices", tip: "Agree with how the epic is split into slices; the first one can start." },
    EA: { title: "Approve a change to the epic", short: "epic change", tip: "The epic changed after approval; agree to the change." }
  };

  // Every job state in schemas/state-machine.json and epic state in schemas/epic-state-machine.json.
  var STATES = {
    received: "Received", intent: "Writing the contract", awaiting_answers: "Waiting for you: questions", awaiting_intent_approval: "Waiting for you: contract",
    designing: "Designing", awaiting_design_approval: "Waiting for you: design",
    awaiting_findings_approval: "Waiting for you: findings", planning: "Planning",
    awaiting_plan_approval: "Waiting for you: plan", awaiting_ship_approval: "Waiting for you: ship", building: "Building", integrating: "Combining the tasks",
    verifying: "Checking", reviewing: "Reviewing", ready_to_ship: "Ready to ship", pr_open: "Waiting for you: merge",
    merged: "Merged", post_merge_review: "Checking after the merge", learning: "Learning", closed: "Done", amending: "Changing the criteria",
    awaiting_amendment_approval: "Waiting for you: change", needs_replan: "Needs a new plan",
    findings_delivered: "Findings delivered", parked: "Parked", cancelled: "Cancelled", abandoned: "Abandoned",
    epic_intent: "Writing the epic's goal", awaiting_epic_intent_approval: "Waiting for you: epic goal",
    epic_architecture: "Designing the architecture", awaiting_architecture_approval: "Waiting for you: architecture",
    slicing: "Splitting into slices", awaiting_slice_plan_approval: "Waiting for you: slices", in_delivery: "Delivering the slices",
    epic_gate: "Final epic check", complete: "Complete"
  };
  // Where one state name means something else on an epic.
  var EPIC_STATES = { amending: "Changing the epic", awaiting_amendment_approval: "Waiting for you: epic change" };

  // The stations of schemas/flow.json, as the line shows them.
  var STATIONS = {
    intake: "Intake", intent: "Contract", design: "Design", plan: "Plan", build: "Build", verify: "Prove", review: "Challenge",
    ship: "Ship", done: "Learn", change: "Change", parked: "Parked", stopped: "Stopped",
    epic_intent: "Epic goal", architecture: "Architecture", slicing: "Slices", delivery: "Delivery", epic_gate: "Final check", complete: "Complete"
  };

  var LANES = { code: "Code review", tests: "Test review", security: "Security review", ux: "Usability review", conformance: "Conformance review" };

  // Every role in schemas/flow.json: a plain name, and what it does.
  var ROLES = {
    "intake-classifier": ["Intake", "sorts the request"], "intent-analyst": ["Intent analyst", "finds gaps in the intent"],
    "intent-mapper": ["Intent mapper", "lists the unknowns before anyone asks you"], verifier: ["Evidence verifier", "re-checks each high-impact finding"],
    "option-generator": ["Option generator", "proposes one independent design option"],
    judge: ["Judge", "merges the analysts' reports"], "god-eye": ["God Eye", "independent reviewer: reads the whole document fresh"],
    researcher: ["Researcher", "finds facts in the code, with sources"], architect: ["Architect", "weighs the options, writes the design record"],
    "threat-modeler": ["Threat modeller", "lists what could be attacked, on high-risk work"], planner: ["Planner", "breaks the work into tasks"],
    slicer: ["Slicer", "splits an epic into slices"], builder: ["Builder", "builds one task"], tester: ["Tester", "checks one task independently"],
    integrator: ["Integrator", "combines the task branches"], "code-reviewer": ["Code reviewer", "reads the code change"],
    "test-reviewer": ["Test reviewer", "checks the tests prove every criterion"], "security-reviewer": ["Security reviewer", "looks for security problems"],
    "ux-reviewer": ["Usability reviewer", "checks what people see and use"], "finding-verifier": ["Finding checker", "challenges a serious finding before it counts"],
    "lesson-writer": ["Lesson writer", "turns a confirmed problem into a lesson"], "epic-reviewer": ["Epic reviewer", "reviews the whole epic"],
    "design-runner": ["Design runner", "runs the design step in its own session"], "plan-runner": ["Plan runner", "runs the plan step in its own session"],
    recorder: ["Recorder", "records a workflow's results"]
  };

  var VERDICTS = {
    approve: "approved", ready: "approved", revise: "sent back", pass: "passed", changes: "changes asked",
    changes_requested: "changes asked", insufficient_evidence: "not enough proof", fail: "failed"
  };

  var TYPES = {
    feature: "Feature", bug: "Bug fix", hotfix: "Urgent fix", refactor: "Refactor", migration: "Migration",
    dependency: "Dependency update", docs: "Documentation", spike: "Investigation", greenfield: "New project", epic: "Epic"
  };

  // Terms that stay on screen, each with one plain line.
  var TERMS = {
    intent: ["Intent", "What the work must achieve, as numbered criteria you approve."],
    criterion: ["Criterion", "One numbered, testable statement of what done means."],
    fingerprint: ["Version checked", "A short code for the exact version of the code that was reviewed, so the review matches what ships."],
    evidence: ["Proof", "A recorded run of a check command, with its result."],
    waiver: ["Exception", "A recorded, time-limited exception to a rule: who allowed it, why, until when."],
    attestation: ["Signed record", "A signed statement of what was checked, by whom, on which version."],
    slice: ["Slice", "One piece of an epic, small enough to ship on its own and safe to stop after."],
    contract: ["Shared interface", "An interface the epic's slices agree on; it freezes when you approve the architecture."],
    adr: ["Design record", "The design decision, the options weighed and why (an ADR)."],
    worktree: ["Separate copy", "A separate working copy of the repository where one task is built."],
    lane: ["Review", "One independent review that looks at one concern."],
    gate: ["Decision point", "A point where the work stops until someone decides."],
    park: ["Parked", "Stopped until you decide; nothing moves meanwhile."],
    amendment: ["Change", "A change to approved criteria or a plan after the work started."],
    pr: ["Pull request", "The change, proposed for merging on GitHub."],
    flag: ["Switch", "Keeps the epic's change turned off until you turn it on."],
    spike: ["Investigation", "Time-boxed research; it delivers findings, not code."],
    flaky: ["Unreliable", "Passed and failed on the same code, so it does not count as proof."],
    lesson: ["Lesson", "A rule learnt from a confirmed problem and given to later work."],
    autopilot: ["Autopilot", "Copilot's Autopilot mode: it answers prompts by itself and keeps going past the factory's stops, so it could answer a gate for you. The factory warns when it sees it; use interactive mode for factory work."],
    epic: ["Epic", "A large piece of work split into slices that each go down the line as a job."],
    job: ["Job", "One piece of work going down the line, from request to merge."],
    task: ["Task", "One bounded step of a job's plan, built and checked on its own."],
    rework: ["Sent back", "A check or a review found a problem, so the work goes back to be fixed."],
    risk: ["Risk", "How careful the factory is: higher risk means more checks and reviews."],
    godeye: ["God Eye", "An independent reviewer that reads the whole document fresh, without the history."]
  };

  var GOD_EYE = { name: "God Eye", sub: "independent reviewer" };

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function words(s) { return String(s === undefined || s === null ? "" : s).replace(/_/g, " "); }

  function gate(id) { return has(GATES, id) ? GATES[id].title : String(id || ""); }
  function gateShort(id) { return has(GATES, id) ? GATES[id].short : String(id || ""); }
  function gateTip(id) { return has(GATES, id) ? GATES[id].tip : ""; }
  function state(s, kind) { return kind === "epic" && has(EPIC_STATES, s) ? EPIC_STATES[s] : has(STATES, s) ? STATES[s] : words(s); }
  function station(id) { return has(STATIONS, id) ? STATIONS[id] : words(id); }
  function lane(id) { var k = String(id || "").toLowerCase(); return has(LANES, k) ? LANES[k] : words(id) + " review"; }
  function role(id) { var k = String(id || "").replace(/^factory:/, ""); return has(ROLES, k) ? ROLES[k][0] : words(k).replace(/-/g, " "); }
  function roleDoes(id) { var k = String(id || "").replace(/^factory:/, ""); return has(ROLES, k) ? ROLES[k][1] : ""; }
  function verdict(v) { return has(VERDICTS, v) ? VERDICTS[v] : words(v); }
  function type(t) { return has(TYPES, t) ? TYPES[t] : words(t); }
  function criterion(id) {
    var m = /^(E-)?AC-(\d+)$/.exec(String(id || ""));
    return m ? (m[1] ? "Epic criterion " : "Criterion ") + m[2] : String(id || "");
  }
  function criteria(text) {
    return String(text || "").replace(/\bE-AC-(\d+)\b/g, "epic criterion $1").replace(/\bAC-(\d+)\b/g, "criterion $1");
  }
  function term(key) { var k = String(key || "").toLowerCase(); return has(TERMS, k) ? { word: TERMS[k][0], tip: TERMS[k][1] } : { word: String(key || ""), tip: "" }; }
  function tip(key) { return term(key).tip; }

  return { GATES: GATES, STATES: STATES, EPIC_STATES: EPIC_STATES, STATIONS: STATIONS, LANES: LANES, ROLES: ROLES, VERDICTS: VERDICTS,
           TYPES: TYPES, TERMS: TERMS, GOD_EYE: GOD_EYE, gate: gate, gateShort: gateShort, gateTip: gateTip, state: state,
           station: station, lane: lane, role: role, roleDoes: roleDoes, verdict: verdict, type: type, criterion: criterion,
           criteria: criteria, term: term, tip: tip };
})();
