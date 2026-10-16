---
name: park
description: "Explains why a factory job is parked and which exact replies move it on. Use when factory drive stops with kind parked, or `factory next` returns action parked."
user-invocable: false
---
# Parked

Park, floor and recipe are defined in the start skill's [glossary](../start/references/glossary.md).

The CLI parked the job: `reason`, and `park` with its `kind` (the cause: `needs_paths`, `dependency_conflict`, `regression`, `environment_broken`, `task_exhausted`, `review_rounds`, `verify_fix_rounds`, `integration`, `budget`, …), `next` (the step that moves it on) and, for a loop or the budget, **`question`** with `options` and a `recommendation`, in the drive's stop or the `factory next` output. Parking is how the factory stops instead of guessing. Before it parks, the factory already tried what a program can: transient Copilot errors were retried with backoff, a task whose dependencies did not merge was rebuilt once on the integrated branch, a reconcile regression was rebuilt once on the merged code, files changed outside the allowed paths were reverted once, and a loop (review-fix, verify-fix, the integrator) ran while its open problems shrank, then on a stronger model, then was diagnosed by God Eye: the park's `question` is that diagnosis's, never a bare "resume".

1. Run `factory why --format md`: its park rows show each park with its kind, reason and suggested next step; look at the last few rows to understand how it got here.
2. Tell the user, in a few lines:
   - what stopped it and why (plain words, not the rule id),
   - what you'd suggest (e.g. "one more review round is reasonable — the last round confirmed only one small issue", or "this needs a plan change: T2 needs files outside its paths"),
   - the park's **`question`**, its options and the recommendation, as given;
   - their options:
     - **any answer in their own words** — a reply to a park is resume + content: their message resumes the job, and every agent that works on it next gets their words (the loop starts a new round with them). A question to you ("why is it parked?") is not a reply. In a terminal: `factory resume --job <id> <their words>`.
     - **`resume`** — continue without words (a loop starts a new segment). **The budget is absolute:** a budget park needs the grant in the reply — **`resume +50%`**, **`resume +100%`** (or the budget question's option `a` / `b`); a bare `resume` is refused and nothing changes.
     - **`cancel job`** or **`abandon job`** — stop for good; files are kept
     - **`waive ci_reverify <reason>`** — only when the CI re-verify floor can't be met (no `factory-gate` workflow and no local merge to re-verify)
     - **`environment_repair`** (0.11) is the one park a free reply does not resume: a repaired build environment waits for its seal. Show its full diff (the question) and give exactly the replies the drive's stop names: **`approve environment <hash>`** (the short hash the question names) or **`a`** seals it; **`b`** (or their words) repairs it again; **`c`** re-checks after they fixed it on their machine. A bare `approve environment`, `ok`, `yes` or `sure` seals nothing (free words then `yes` discards the repair). Never seal it yourself.
     - or tell you what to change (you may then need the **amend** skill). For `needs_paths` or `dependency_conflict` that is the usual fix: an amendment that gives the task its paths or a dependency; approving it also resumes the job, with no separate `resume`.
   Example: "J-0004 is parked: the same confirmed review finding (an unchecked null in `src/cart/total.js`) survived three fix rounds, the last on a stronger model. God Eye's diagnosis: the contract says totals may be empty, the finding says they may not. Its question: *Can a cart total be empty?* a) yes, return 0 (recommended) · b) no, reject it. Reply with your answer in your own words (it resumes the job with them), **`cancel job`**, or tell me what to change."
3. **Stop.** After the reply hook applies their reply, start the drive again (`factory drive --detach`; its stop's `last_reply` says whether the reply was applied).
