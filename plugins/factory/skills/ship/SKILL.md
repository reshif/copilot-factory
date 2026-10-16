---
name: ship
description: "Opens the pull request or local merge for a factory job whose pre-ship floors are met, and waits for the human merge. Use when `factory next` returns skill ship. Not for pushing or merging work outside a factory job."
user-invocable: false
---
# Ship

Under `factory drive` the drive runs `factory ship` itself and stops at the merge (kind `wait`); its stop carries what `factory ship` printed under `ship`. Tell the user step 2 from it, then **stop**. The steps below are for stepping by hand.

**The ship review comes first, once.** Before ship, everything that needs the user is asked in one place (the drive stops with kind `wait` and `ship_review`; at high risk it is gate HS): the user's own checks of criteria (`confirm AC-n`, asked once on the final build, after the review and its fix rounds; a later fix round that leaves the criterion's files as they are keeps the check), each serious finding no verifier could settle, also a second verifier on a stronger model (`accept finding <id> <why>` or `dismiss finding <id> <why>`), and the push when the PR would not be an opted-in draft (`approve ship`). Show its `screen` as it is; **one reply settles it**, the parts separated by `;` (for example `confirm AC-2; dismiss finding code-1 not reachable from the API; approve ship`). At HS, `deny <what must change>` turns the user's reason into a fix round.


Floors and the CI re-verify floor are defined in the start skill's [glossary](../start/references/glossary.md).

1. Run `factory ship`. It refuses unless every pre-ship floor is met (it lists the missing ones — then run `factory next`, which routes to the missing step).
   - With a GitHub remote and an authenticated `gh`, it pushes the job branch and opens a PR whose body is the completion report (templates/docs/ship-report.md: what changed, AC → evidence, design record, risk, rollout and rollback). It also refreshes the job's `docs-index.md` (contract → design → plan → evidence traceability). At low or medium risk a PR opened without the user's `approve ship` is a **draft**, and only on a repository that opted in once (policy `ship.auto_pr: "draft"`); otherwise the ship review asks for the push.
   - Otherwise it prepares a **local** merge (local mode also skips HS: nothing is pushed, so the user's own merge is the irreversible step).
2. Tell the user, briefly:
   - GitHub: the PR link; that CI (`factory-gate`) re-verifies on the merge result; that they review and merge on GitHub. No reply is needed: the factory notices the merge (`factory next` or `factory drive` syncs the PR).
   - Local: the exact commands from the `next` field (`git checkout <base> && git merge --no-ff <branch>`). Then they reply **`merged`** (or `merged <commit>`): the factory sees when the base branch contains the job branch and asks for that reply, but never records a merge it only sees (an agent or a script could have made it).
3. **Stop** and wait.

After the merge:
- GitHub: `factory next` runs `factory pr sync`, which records checks and the merge commit.
- Local: once the user replied `merged`, the router itself asks for `factory ci verify` (the CI re-verify floor) before distill; don't run it on your own. Only the human merges the job branch (the guard refuses it to Copilot and its agents).
- If `factory-gate` isn't set up in the repo, suggest the user run `factory ci install` themselves (it's human-only) and commit it on their base branch. Until then, after a GitHub merge, run `factory ci verify --commit <merge commit>` to re-verify locally, or the user can reply `waive ci_reverify <reason>`.
