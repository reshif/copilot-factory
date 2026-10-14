---
name: gate
description: Present a factory human gate (H1 contract, H2 design, H3 plan, HF findings, HS ship sign-off, EH1–EH3 epic, A amendment) with its documents and hash, then wait for the user's reply. Used by factory:start when `factory next` returns a gate.
user-invocable: false
---
# Human gate

`factory next` returned `action: gate` with `gate: { id, hash, docs }`. The approval will be bound to that exact hash: if a document changes after you present it, the approval is refused and you present it again.

## What each gate shows
| Gate | Show |
|---|---|
| H1 / EH1 | The contract (it is short: show the goal and every acceptance criterion with its evidence type; mention allowed paths and verify commands). |
| H2 / EH2 | The design record: the decision, rejected options, how criteria are met, and the ADR's architecture diagram (paste its ```mermaid block as is so it renders); the God Eye critique verdict and any open items (from `critiques/design.json`). For EH2, the contracts being frozen. |
| H3 / EH3 | The plan as a table: task, objective, allowed paths, depends on, criteria; then the waves. For EH3, the slices and their order. |
| HF | The findings summary and the recommendation (spike). |
| HS | Run `factory report` first, then show the floors table and the AC → proof table from the report. This signs off the irreversible step (push / PR). |
| A | The amendment: what changed, who asked, criteria changed, tasks that will be rebuilt. |

Read the files in `docs` yourself and summarise faithfully — don't hide open critique items.

## Then
End with exactly this, and **stop**:

> **Gate {id}** · hash `{first 12 chars}` — reply **`approve`** to continue, or **`deny <what must change>`**.

Rules:
- Only the user's own reply counts. Never approve on their behalf and never run `factory approve` (the guard blocks it).
- If they answer with other words ("looks good", "yes"), ask them to reply exactly `approve` — the hook only applies the exact reply.
- After they reply, the hook applies it before you see the message and adds a `[factory]` note. If it says *Applied*, continue the loop with `factory next`. If it says *NOT applied* (e.g. the document changed), present the gate again.
- On `deny`, revise what they asked for (contract, design or plan — via the right step) and present it again when `factory next` returns the gate.
