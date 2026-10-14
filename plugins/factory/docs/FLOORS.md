# Floors

Floors are the steps no recipe may omit, per risk level ([`policy/floors.json`](../policy/floors.json)). They are enforced **twice**:

- **Statically**: `factory recipe check` (and every recipe load) refuses a recipe that doesn't contain a floor step for a risk it applies to.
- **Dynamically**: `factory finalize`, `factory ship`, `factory close`, the Stop hook, and the alignment vector check the ledger — the floor step must have run **on the current build**. A step that never ran is missing evidence, never a pass.

| Floor | Low | Medium | High | Met when |
|---|:-:|:-:|:-:|---|
| `contract_approved` | ✅ | ✅ | ✅ | H1 (EH1) approved for the current contract hash (risk is part of it) |
| `isolation` | ✅ | ✅ | ✅ | every task's latest evidence passed in its own worktree, on the tree its branch has now |
| `prove` | ✅ | ✅ | ✅ | a passing `factory verify run` bound to the current fingerprint |
| `challenge:code` | ✅ | ✅ | ✅ | the code lane passed on the current fingerprint |
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
