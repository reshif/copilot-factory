---
name: park
description: "Explains why a factory job is parked and which exact replies move it on. Use when `factory next` returns action parked."
user-invocable: false
---
# Parked

Park, floor and recipe are defined in the start skill's [glossary](../start/references/glossary.md).

The CLI parked the job (`reason` in the `factory next` output). Parking is how the factory stops instead of guessing: budgets, round caps, no-progress loops, scope drift, conflicts, failed epic gates.

1. Run `factory why --format md` and look at the last few rows to understand how it got here.
2. Tell the user, in a few lines:
   - what stopped it and why (plain words, not the rule id),
   - what you'd suggest (e.g. "one more review round is reasonable — the last round confirmed only one small issue", or "this needs a plan change: T2 needs files outside its paths"),
   - their options, as exact replies:
     - **`resume`** — continue; the cap that stopped it gets one more round (for budgets, +50%; for a serious finding no verifier could settle, one more re-verification: it is never dropped, and it blocks ship until confirmed or refuted)
     - **`cancel job`** or **`abandon job`** — stop for good; files are kept
     - **`waive ci_reverify <reason>`** — only when the CI re-verify floor can't be met (no `factory-gate` workflow and no local merge to re-verify)
     - or tell you what to change (you may then need the **amend** skill).
   Example: "J-0004 is parked: the review found a new major issue in each of the last three fix rounds, which is the round cap. The last round confirmed only one small issue (an unchecked null in `src/cart/total.js`), so one more round is reasonable. Reply **`resume`** for one more round, **`cancel job`** or **`abandon job`** to stop, or tell me what to change."
3. **Stop.** After the reply hook applies their reply, continue with `factory next` (its `last_reply` says whether the reply was applied).
