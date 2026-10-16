---
name: distill
description: "Turns a merged factory job's confirmed problems and build trouble into at most three scoped lessons for the user to accept or reject. Use when `factory next` returns skill distill."
user-invocable: false
---
# Distill

Under `factory drive` the drive runs steps 1 and 2 itself and its `done` stop lists the `lessons` proposed: only step 3 is yours. The steps below are for stepping by hand.

1. Run `factory distill write`. It starts the factory's **lesson-writer** agent as its own Copilot session (like `factory run`: works in the Copilot CLI and in every VS Code harness), gives it the distill context and the cap, and the agent records each lesson with `factory lessons add`. When the job left nothing to learn from (no confirmed findings, no verify-fix rounds, no minor findings repeated in other jobs, and no build trouble: parks, retries, scope violations, a broken environment, timeouts, integration failures, manual repairs) or the cap is used, it starts no agent and says so (`skipped: true`). Don't start the lesson-writer yourself with the task tool. It takes a while; wait for it to finish and don't run it twice.
   Each lesson becomes a card in `.factory/lessons/lessons.md` (templates/docs/lessons.md). The lesson-writer may also propose edits to the project brief (`.factory/project.md`); they become a proposal (`project_brief.proposal`, e.g. P1) that changes nothing until the user replies **`accept brief P1`** (or **`reject brief P1 <why>`**); under `factory drive` the done stop and `factory inbox` list it. Tell the user in one line what it proposes; never edit that file yourself.
2. Run `factory distill done`.
3. If lessons were proposed (`lessons` in the output of step 1), list them for the user with their ids, together with any brief proposal: the **end-of-job digest**. One reply settles them all, the parts separated by `;` (the done stop's `digest.reply` is the accept-all form, e.g. `accept lesson L4; accept lesson L5; accept brief P1`); the user may reject any with **`reject lesson L4 <why>`** / **`reject brief P1 <why>`**, at any time (`factory inbox` lists them). Nothing applies without their reply. Accepted lessons apply from the next plan, build and review. If it says Copilot is unavailable (`copilot_unavailable`), tell the user what it says and move on with step 2.
4. Continue the loop (`factory next`, or `factory drive`).
