# Floors

Floors are the steps no recipe may omit, per risk level ([`policy/floors.json`](../policy/floors.json)). They are enforced **twice**:

- **Statically**: `factory recipe check` (and every recipe load) refuses a recipe that doesn't contain a floor step for a risk it applies to.
- **Dynamically**: `factory finalize`, `factory ship`, `factory close`, the stop gate (`agentStop` hook), and the alignment vector check the ledger — the floor step must have run **on the current build**. A step that never ran is missing evidence, never a pass.

| Floor | Low | Medium | High | Met when |
|---|:-:|:-:|:-:|---|
| `contract_approved` | ✅ | ✅ | ✅ | H1 (EH1) approved for the current contract hash (risk is part of it) |
| `intent_grounded` | advisory | ✅ | ✅ | every outside-world claim the contract relies on is confirmed evidence or an open question: each `E-n` cited in Intent, Constraints and `## Assumptions (evidence-backed)` exists in `intent-evidence.json` (web evidence confirmed by the verifier, repo evidence not contradicted or unverified), each URL cited there is the source of confirmed evidence, and every medium- or high-impact world unknown is confirmed, asked, answered or dismissed. Checked when clarify is recorded and by `factory contract check`; at low risk only a warning. Jobs whose `recipe.lock.json` predates this floor are exempt |
| `isolation` | ✅ | ✅ | ✅ | every task's latest evidence passed in its own worktree, on the tree its branch has now |
| `prove` | ✅ | ✅ | ✅ | a passing `factory verify run` bound to the current fingerprint |
| `challenge:code` | ✅ | ✅ | ✅ | the code lane passed on the current fingerprint |
| `no_unverified_serious` | ✅ | ✅ | ✅ | the job's latest review left no blocker/major finding unverified. A finding whose verifier timed out or said `unverifiable` is carried into every later round, whether or not a reviewer raises it again, and re-verified with twice the agent time cap until a verifier confirms or refutes it; after `max_reverify_rounds` (3) the job parks. `ship`, `merged` (H4) and `close` refuse while one is open, and the completion report lists them |
| `ci_reverify` | ✅ | ✅ | ✅ | the `factory-gate` check succeeded on the merge result (GitHub), or `factory ci verify` passed on the local merge, or you waived it |
| `human_merge` | ✅ | ✅ | ✅ | the merge commit is recorded (GitHub via `pr sync`, or your `merged <commit>` reply) |
| `ground` | | ✅ | ✅ | findings recorded for the current contract |
| `design_record` | | ✅ | ✅ | an ADR / no-adr / contracts record, decided for the current contract |
| `design_critique` | | ✅ | ✅ | God Eye approved this design hash, or rounds ran out and you approved it at H2 |
| `plan_validated` | | ✅ | ✅ | `plan validate` passed for the current plan hash |
| `challenge:tests` · `challenge:security` | | ✅ | ✅ | those lanes passed on the current fingerprint |
| `finding_verifiers` | | ✅ | ✅ | every blocker/major finding was confirmed or refuted (none unverified) |
| `threat_model` | | | ✅ | `threat-model.md` exists and is part of the decided design |
| `H2` · `H3` | | | ✅ | you approved the design and the plan (no auto-approval) |
| `challenge:all_before_merge` | | | ✅ | code, tests, security — and ux if UI files changed — all passed before merge |
| `no_trial_recipes` | | | ✅ | the job's recipe is `proven` |
| `irreversible_signoff` | | | ✅ | you approved HS for the current fingerprint before ship |

`ci_reverify` and `human_merge` are owed after merge; `factory ship` checks everything else. Waivable: `ci_reverify`, `ship_size` (reply `waive <floor> <reason>`). Changing a floor is a policy change — make it in the plugin, run `factory recipe check`, and note why.
