---
name: distill
description: "Factory distill — after a job merges, turn confirmed problems into at most three scoped lessons for the user to accept or reject. Used by the start skill when `factory next` returns skill distill."
user-invocable: false
---
# Distill

1. Run `factory distill write`. It starts the factory's **lesson-writer** agent as its own Copilot session (like `factory run`: works in the Copilot CLI and in every VS Code harness), gives it the distill context and the cap, and the agent records each lesson with `factory lessons add`. When the job left nothing to learn from (no confirmed findings, no verify-fix rounds, no minor findings repeated in other jobs) or the cap is used, it starts no agent and says so (`skipped: true`). Don't start the lesson-writer yourself with the task tool. It takes a while; wait for it to finish and don't run it twice.
   Each lesson becomes a card in `.factory/lessons/lessons.md` (templates/docs/lessons.md).
2. Run `factory distill done`.
3. If lessons were proposed (`lessons` in the output of step 1), list them for the user with their ids and say they can reply **`accept lesson L4`** or **`reject lesson L4 <why>`** at any time. Accepted lessons apply from the next plan, build and review. If it says Copilot is unavailable (`copilot_unavailable`), tell the user what it says and move on with step 2.
4. Continue the loop (`factory next`).
