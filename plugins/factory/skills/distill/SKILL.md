---
name: distill
description: Factory distill — after a job merges, turn confirmed problems into at most three scoped lessons for the user to accept or reject. Used by factory:start when `factory next` returns skill distill.
user-invocable: false
---
# Distill

1. Run `factory distill context`.
2. If it shows confirmed findings, verify-fix rounds, or minor findings that also appear in other jobs, start the **factory:lesson-writer** agent (Agent tool) with: the distill context JSON, the cap (`cap`), the lessons already proposed, and the command to record each lesson:
   `factory lessons add --job <job> --text "<lesson>" --scope "<glob>,<glob>" --why "<finding id: what went wrong>"`.
   Each lesson becomes a card in `.factory/lessons/lessons.md` (templates/docs/lessons.md).
   If there is nothing worth learning, skip the agent.
3. Run `factory distill done`.
4. If lessons were proposed, list them for the user with their ids and say they can reply **`accept lesson L4`** or **`reject lesson L4 <why>`** at any time. Accepted lessons apply from the next plan, build and review.
5. Continue the loop (`factory next`).
