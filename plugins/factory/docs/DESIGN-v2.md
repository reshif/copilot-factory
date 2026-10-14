# Software Factory — Grounded Orchestrator (Design v2)

**Status:** final draft for build decision · **Date:** 2026-10-14 · **Base:** Software Factory v0.7.5
**Supersedes:** the "pattern-learning orchestrator" draft (v1), revised after four independent reviews (buildability, learning soundness, ROI, safety).

---

## 1. Summary

Software Factory moves from one fixed pipeline to a **grounded orchestrator**:

- Every job works toward an **outcome contract** (goal, acceptance criteria, constraints), approved by a human and bound to its hash.
- Work is done by a small set of **primitives**, composed into **recipes** chosen by **deterministic rules** (work type + risk).
- An **evidence ledger** records what proved each acceptance criterion and which steps ran.
- **Hard floors per risk level** are enforced by the CLI. No recipe can skip them.
- **Telemetry** plus a **monthly human review** improves recipes over time.

**Deliberately not in v2:** automatic learning of recipes, scoring-based selection, shadow runs, golden-set benchmarking. At solo or small-team volume (tens of jobs a month) these can't reach statistical meaning, and the reviewers showed they would drift toward less scrutiny. Section 12 says when to revisit them.

---

## 2. Problems this solves

| Problem today | How v2 addresses it |
|---|---|
| Small jobs pay for the full ceremony (design, plan, all gates) | Rule-chosen fast-path recipes for low-risk work |
| No per-stage cost/time/value data; can't tell which stages earn their keep | Per-stage telemetry and a decision record per step |
| Stage-specific orchestration code (three workflows + two runners) is hard to reuse | Shared primitives: one fan-out/judge engine with configs |
| "Done" is spread across several gates | One `finalize` check over the ledger and floors |
| Epic line is separate machinery | Outcome tree with depth ≤ 2 (epic → slice) on the same primitives |

If the first experiment (section 11) doesn't show the fast path is cheaper without more defects, stop here. The rest isn't justified.

---

## 3. Principles

1. **Outcome first.** Stages exist to move an approved contract to proof.
2. **The CLI decides, agents propose.** The next step, gates, floors, scores and state are computed by the deterministic CLI. No LLM picks the next step.
3. **Evidence over confidence.** Nothing passes without fingerprint-bound evidence. A step that never ran is **missing evidence**, never a clean result.
4. **Floors are code, not prose.** Each risk level has a minimum set of steps that `finalize`, the Stop gate and CI enforce.
5. **Bounded everything.** Rounds, retries, tree depth, per-node and whole-tree budgets. Hitting a limit escalates. It never continues silently.
6. **Explainable paths.** Every step writes a decision record. "Why did it do that?" is always answerable from the log.
7. **Humans improve recipes.** Telemetry informs a human. The system never promotes its own patterns.

---

## 4. World model

```text
outcome_tree        depth ≤ 2: root (job or epic) → children (tasks or slices)
outcome_contract    goal · AC-1..n (evidence types, freshness) · non-goals ·
                    allowed paths · risk (locked) · standards · approval hash
evidence_ledger     append-only; AC → evidence (type, fingerprint, source)
                    + floor_steps_run per fingerprint
decision_log        one decision record per step (section 8)
budget_ledger       tokens · wall time · rounds · retries — per node and per tree
lesson_store        scoped lessons; recurring ones promote to checks (existing flow)
recipe_registry     versioned, human-authored recipes (section 6)
```

**Risk is part of the contract hash.** Lowering it needs a human amendment. Policy rules can still only raise it.

---

## 5. Primitives

Ten building blocks. Five are workflows (agents, fan-out). Five are deterministic CLI steps.

| # | Primitive | Kind | Shape | Done when |
|---|---|---|---|---|
| 1 | **ground** | workflow | Parallel probes (repo, dependencies, prior ADRs + lessons, docs) → merged findings, every claim cited or `UNVERIFIED` | Every claim the next step relies on is cited or marked |
| 2 | **fanout-judge** | workflow engine | N independent agents → retry once → judge merges → optional cold critique (God Eye) | Config-specific (below) |
| 2a | ↳ `clarify` config | | Intent gate first (alone), then analysts: ambiguity, constraints, testability; judge orders intent > scope > constraint > acceptance within a per-round budget | Contract draft has no open questions; God Eye restates and confirms the intent and approves |
| 2b | ↳ `decide` config | | Option generators (+ threat-modeler at high risk, in parallel) → architect decides | ADR or `no-adr.md` with rejected options; design critique approves |
| 2c | ↳ `challenge` config | | Review lanes by policy → convergence rules → finding-verifier per blocker/major | No confirmed blocker/major on this fingerprint, or round budget spent with trend verdict |
| 3 | **decompose** | workflow | Planner (or slicer for epics) → `factory plan validate` → loop ≤ 3 | Valid task graph with waves; coverage of every AC; no shared files in a wave |
| 4 | **realize** | workflow | Per task, own worktree: builder → independent tester → retry with escalation; waves in parallel | Every task done, or blocked/exhausted with dependents skipped |
| 5 | **reconcile** | workflow | Integrator merges in dependency order; textual vs behavioural conflict classifier | Parent fingerprint exists; behavioural conflicts escalate |
| 6 | **prove** | CLI | `factory verify run`: tests, scans, rehearsal, standards ratchet, flaky reruns | Each AC proven, disproven, or unprovable with a reason |
| 7 | **gate** | CLI + human | Hash-bound human approval (H1, H2, H3, HF, EH1–3, A) | Approval recorded against the current hash |
| 8 | **ship** | CLI + GitHub | Report → `gate:ship` → PR → CI re-verify → human merge (H4) → `pr sync` | Merge commit recorded |
| 9 | **amend / park** | CLI + human | Amend contract or plan with impact; park with reason; resume / cancel | Approvals re-bound, or a human decision recorded |
| 10 | **distill** | CLI + agent | CLI computes telemetry from the ledger; lesson-writer proposes ≤ 3 lessons | Metrics written; lessons queued for human accept |

**Workflow scripts to build: 5**

- `ground.js`
- `fanout-judge.js`, with three configs
- `decompose.js`
- `realize.js`, which replaces `build-tasks.js`
- `reconcile.js`

`intent-review.js` and `review-lanes.js` become configs of `fanout-judge.js`. The design and plan runners are replaced by `fanout-judge(decide)` and `decompose`.

### Shared result envelope

Every workflow returns the same envelope:

```json
{
  "status": "ok | needs_user | degraded | stale | park | error",
  "next_gate": "H1 | H2 | H3 | HF | EH1 | EH2 | EH3 | A | null",
  "input_hash": "sha256",
  "budgets": { "used": {}, "limit": {} },
  "artifacts": ["paths written via CLI recorders"],
  "questions": ["only when needs_user"],
  "park_reason": "only when park",
  "summary": "≤ 10 lines"
}
```

---

## 6. Recipes (human-authored, rule-selected)

Recipes are versioned data in `recipes/*.json`. The CLI selects one from `(work_type, risk)` with a fixed table. A recipe can **add** steps above the floor, never remove floor steps.

| Recipe | Selected when | Sequence |
|---|---|---|
| `bug@low` (fast path) | bug, docs, dependency at low risk | clarify → H1 → ground → realize (single wave) → reconcile → prove → challenge(code) → ship |
| `feature@low` | feature, refactor at low risk | clarify → H1 → ground → decompose (God Eye plan critique may auto-approve H3) → realize → reconcile → prove → challenge(code, tests) → ship |
| `standard@medium` | any type at medium risk | clarify → H1 → ground → decide → [H2 if ADR] → decompose → H3 → realize → reconcile → prove → challenge(code, tests, security) → ship |
| `full@high` | any type at high risk (migration and hotfix are floored here) | clarify → H1 → ground → decide (+ threat model) → H2 → decompose → H3 → realize → reconcile → prove → challenge(all lanes) → ship |
| `hotfix@high` | hotfix | clarify → H1 → ground (scoped to the failing path) → decide (+ threat model; `no-adr.md` allowed) → H2 → decompose → H3 → realize → reconcile → prove → challenge(all lanes) → ship → post-merge challenge(code, security) |
| `spike` | spike | clarify → H1 → ground → decide (recommendation only) → HF |
| `epic` | intake says epic | clarify(epic) → EH1 → ground → decide (contracts) → EH2 → decompose(slices) → EH3 → each slice runs its own recipe → epic gate → challenge(conformance) |

Post-merge review **adds to** pre-merge review. It never replaces it.

---

## 7. Hard floors (CLI-enforced)

`factory finalize`, the Stop gate and CI `factory-gate` refuse unless the ledger shows every floor step ran **on the current fingerprint**.

| Floor | Low | Medium | High |
|---|:-:|:-:|:-:|
| Contract approved by a human (hash-bound, risk locked) | ✅ | ✅ | ✅ |
| Realization in isolated worktrees | ✅ | ✅ | ✅ |
| `prove` on the final fingerprint | ✅ | ✅ | ✅ |
| `challenge` code lane on the final fingerprint | ✅ | ✅ | ✅ |
| CI re-verify on the merge result + human merge | ✅ | ✅ | ✅ |
| `ground` with cited findings | — | ✅ | ✅ |
| Design record (ADR or `no-adr.md`) + God Eye critique | — | ✅ | ✅ |
| Plan validated before `realize` | — | ✅ | ✅ |
| `challenge` tests + security lanes, finding verifiers | — | ✅ | ✅ |
| Threat model | — | — | ✅ |
| Human approval of design (H2) and plan (H3) | — | — | ✅ |
| All lanes before merge; no trial or experimental recipes | — | — | ✅ |
| Human sign-off on every irreversible step | — | — | ✅ |

A missing floor step is reported as `missing_evidence: <step>` and routes back to that step. It never passes.

---

## 8. Control loop

### 8.1 Alignment vector (gate and route only, never learned from)

Evaluated in order. The first failing element decides the next step.

1. `contract_approved` — the contract hash has a human approval
2. `no_drift` — no files touched outside allowed paths, and the contract hash is unchanged since approval
3. `floors_satisfied_so_far` — every floor step due by this point has run
4. `no_confirmed_serious` — confirmed blocker/major findings = 0
5. `acs_proven` — proven ACs / total ACs = 1.0 on the current fingerprint
6. `no_stale_evidence` — no evidence bound to an older fingerprint

### 8.2 Decision table (in the CLI: `factory next`)

| First failing element | Next step |
|---|---|
| `contract_approved` | clarify → H1 |
| `no_drift` (scope) | park, or amend if the human says so |
| `no_drift` (contract changed) | amend → A |
| `floors_satisfied_so_far` | the missing floor step |
| `no_confirmed_serious` | realize (fix scope: tasks owning the findings) → reconcile → prove → challenge |
| `acs_proven` | realize (verify-fix scope) → reconcile → prove |
| `no_stale_evidence` | prove, then challenge on the new fingerprint |
| all pass, not shipped | ship |
| all pass, merged | distill → closed |

Inside the conditions above, the recipe decides the order of not-yet-run steps.

### 8.3 Caps and loop guards

| Guard | Default |
|---|---|
| Outcome tree depth | 2 |
| Minimum task size | ≥ 1 AC and ≥ 1 verify command |
| `clarify` rounds | `max_intent_rounds` (CLI refuses at +2) |
| `decide` critique rounds | 2 |
| `decompose` validate rounds | 3 |
| `realize` attempts per task | `retry_limit` (with model escalation) |
| `challenge` rounds | `max_review_rounds` |
| Repeat guard | same primitive + same state hash twice → park |
| Budgets | per node **and** per tree (tokens, wall time); exhaustion → park |

### 8.4 Invalidation

- A new fingerprint at a node marks that node's evidence and review stale.
- A merged child marks its parent's `prove` and `challenge` stale.
- An approved amendment re-binds approvals and restricts `realize` to the affected tasks.

At depth ≤ 2, invalidation cascades at most one level.

---

## 9. Decision record

One record per step, appended to `.factory/log/decisions.jsonl` by the CLI:

```json
{
  "ts": "2026-10-14T01:54:00+05:30",
  "job": "J-0142",
  "node": "J-0142/T3",
  "state_hash": "sha256",
  "fingerprint": "sha256",
  "recipe": "standard@medium",
  "recipe_version": "3",
  "alignment": {
    "contract_approved": true,
    "no_drift": true,
    "floors_satisfied_so_far": true,
    "no_confirmed_serious": false,
    "acs_proven": 0.8,
    "no_stale_evidence": true
  },
  "first_failing": "no_confirmed_serious",
  "candidates": ["realize:fix"],
  "chosen": "realize:fix",
  "rule": "decision_table.row4",
  "budget_delta": { "tokens": 41200, "wall_s": 312, "rounds": 1 },
  "outcome": "ok"
}
```

`factory why <job>` renders the path from this log. Replaying a job's records deterministically reproduces its route.

---

## 10. Telemetry and recipe improvement

### Metrics computed by the CLI from the ledger, never by agents

| Level | Metric |
|---|---|
| Outcome (primary, pre-registered) | Escaped defects and reverts within 30 days of merge · cost per job (tokens, wall time) |
| Outcome (diagnostic) | Accepted without a rework round · human corrections at gates (deny count, amend count) |
| Step | Tokens, wall time, rounds, retries · findings raised vs confirmed vs dismissed, per lane · gate denials per gate |

Diagnostics are watched, not optimized.

### Monthly human review (30 minutes)

1. `factory telemetry report --since 30d`, one page per recipe.
2. Ask, for each recipe: which steps cost the most and changed the least? Which lanes raise mostly dismissed findings? Which escaped defects would a floor step have caught?
3. Edit recipes above the floor, or open a backlog item to change a floor. Floor changes are policy changes.
4. Promote recurring lessons to checks (`factory lessons promote`).

### For a specific question ("is the extra lane worth it?")

Run a **paired A/B** on the same task: same base commit, both recipes, 3 seeds each. Record the variance band, not a point score. A human decides.

---

## 11. Rollout

| Phase | Work | Effort* | Exit criterion |
|---|---|---|---|
| **0 · Telemetry** | Per-stage telemetry and budget ledger on the **current** pipeline; `decisions.jsonl` | 1–2 wks | Two weeks of baseline data on real jobs |
| **1 · Fast-path experiment** | Hand-written `bug@low` recipe, selected by rule; run ≥ 10 real small jobs | 1–2 wks | Kill criterion below |
| **2 · Primitives** | Refactor into 5 workflows (`fanout-judge` with 3 configs) + CLI steps; **equivalence test**: the same jobs through the seed recipes hit the same gates, produce the same artifacts and record the same state transitions as v0.7.5 | 4–5 wks | Equivalence suite green |
| **3 · Ledger + floors** | Evidence ledger, alignment vector, `factory next` decision table, floors in `finalize`/Stop/CI, caps, invalidation, `factory why` | 3–4 wks | Floor bypass tests fail closed; every path explainable |
| **4 · Recipes + review loop** | Remaining recipes, recipe registry with versions, `telemetry report`, monthly review checklist | 1–2 wks | First monthly review held |
| **Total** | | **~10–15 wks** | |

\*One strong engineer working with agents.

### Kill criterion (end of phase 1)

Stop the orchestrator direction and invest elsewhere (cost per job, flaky-test handling, onboarding) if **either** of these holds:

- The `bug@low` fast path does not cut cost **or** wall time by **≥ 30%** compared with the last 10 comparable full-pipeline jobs.
- The fast path shows **more** escaped defects, reverts, or gate corrections than the full pipeline.

Also stop if phase 0 telemetry shows no stage that costs much and changes little, because then there is nothing to adapt.

---

## 12. Deferred (and when to revisit)

| Deferred item | Why deferred | Revisit when |
|---|---|---|
| Learned recipe selection / scoring | About 130 jobs per arm to detect a 15-point gain; most (type × risk) cells get < 5 jobs a year | Pooled volume reaches several hundred jobs per recipe |
| Per-step contribution scoring | Confounded by step order; would demote clarify and ground | A credit-assignment method validated on ablations |
| Shadow runs | Doubles cost; output never reviewed or merged, so the comparison is biased | Only for cheap single steps whose output a human labels |
| Golden-set replay as a benchmark | Non-determinism, repo drift, answer leakage | Use now only as a regression smoke test (pinned base, artifacts stripped, k seeds) |
| Repo-trait stratification | No volume | Multi-repo, multi-team deployment |
| Tree depth > 2 | Invalidation cascades | Invalidation spec proven at depth 2 |

---

## 13. Invariants (unchanged and non-negotiable)

1. Humans approve contracts, design and plan at high risk, irreversible actions, amendments, and floor or recipe changes.
2. The CLI is the only writer of state, approvals, gates, ledger, metrics and decision records.
3. Every claim is evidence-bound. No evidence, no pass. A missing step is missing evidence.
4. Realization happens in isolation. Only `reconcile` touches the job branch.
5. Budgets and caps are hard. Exhaustion escalates.
6. Nothing in the loop can edit invariants, floors, policies, recipes or metric definitions.
7. Existing enforcement stays as it is: PreToolUse guard, SubagentStop output gate, Stop gate, commit-msg trailers, hash-bound approvals, and CI re-verify on the merge result.

---

## Appendix A — Review summary

| Lens | Score | Key finding adopted |
|---|---|---|
| Buildability | 6/10 | Phase 0 must be an equivalence test; ship/amend/gate are primitives; merge P1/P3/P7 into one engine; DECIDE in the CLI; depth cap 2 |
| Learning soundness | 5/10 | Cut statistical learning; pre-register outcome metrics; paired A/B instead of passive scoring |
| ROI | 6/10 | Telemetry first; `bug@low` fast path as a 2-week experiment with a kill criterion |
| Safety | 6/10 | CLI-enforced floors per risk; missing review = missing evidence; risk locked in the contract; decision record per step; the hotfix seed must not skip pre-merge review |

## Appendix B — Mapping from v0.7.5

| v0.7.5 | v2 |
|---|---|
| `intent-review.js` | `fanout-judge.js` (clarify) |
| design-runner | `ground.js` + `fanout-judge.js` (decide) |
| plan-runner | `decompose.js` |
| `build-tasks.js` | `realize.js` |
| integrator | `reconcile.js` |
| `factory verify run` | `prove` (unchanged) |
| `review-lanes.js` | `fanout-judge.js` (challenge) |
| SHIP stage | `ship` |
| AMENDMENT / PARKED | `amend / park` |
| lessons flow | `distill` |
| Epic line | `epic` recipe, outcome tree depth 2 |
| Inspector | unchanged; also reads `decisions.jsonl` |
