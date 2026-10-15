---
name: gate
description: "Presents a factory human gate (contract, design, plan, findings, ship sign-off, epic or amendment) with its documents and hash, and waits for the user's reply. Use when `factory next` returns action gate. Not for approving anything on the user's behalf."
user-invocable: false
---
# Human gate

Gate ids, hashes and God Eye are defined in the start skill's [glossary](../start/references/glossary.md).

`factory next` returned `action: gate` with `gate: { id, hash, docs }`. The approval will be bound to that exact hash: if a document changes after you present it, the approval is refused and you present it again.

## What each gate shows
| Gate | Show |
|---|---|
| H1 / EH1 | The contract (it is short: show the goal and every acceptance criterion with its evidence type; mention allowed paths and verify commands). Then the **evidence-backed assumptions** (`## Assumptions (evidence-backed)`, each `A-n` with its evidence ids) and, from `factory intent show`, the key findings they rest on (claim, source, date, verdict); mark any the user overrode. Tell them `change A-n <value>` or `drop A-n` overrides one (the contract changes, so the gate comes back). Say which questions were asked although research could have answered them (web off, no web access) — never present an unverified claim as fact. Then the user's settled answers (`## Clarifications (settled)`) and what was handed to design (`## Deferred to design`: decided in ground and decide, not now). |
| H2 / EH2 | The design record: the decision, rejected options, how criteria are met, and the ADR's architecture diagram (paste its ```mermaid block as is so it renders); the God Eye critique verdict and any open items (from `critiques/design.json`). For EH2, the contracts being frozen. |
| H3 / EH3 | The plan as a table: task, objective, allowed paths, depends on, criteria; then the waves. For EH3, the slices and their order. |
| HF | The findings summary and the recommendation (spike). |
| HS | Run `factory report` first, then show the floors table and the AC → proof table from the report. This signs off the irreversible step (push / PR). |
| A | The amendment: what changed, who asked, criteria changed, tasks that will be rebuilt. |

Read the files in `docs` yourself and summarise faithfully — don't hide open critique items.

## Then
If `factory next` gave a `notice` (chat replies aren't reaching the factory), show it once, above the line below: a chat `approve` would not be applied, and the notice says how to check the hooks and which command the user can run in their own terminal instead (it asks them to type the job id).

Example, gate H3 for a two-task plan:

> | Task | Objective | Allowed paths | Depends on | Criteria |
> |---|---|---|---|---|
> | T1 | `add` returns the sum | `src/add.js`, `tests/add.test.js` | — | AC-1 |
> | T2 | cart total uses `add` | `src/cart/**` | T1 | AC-2 |
>
> Waves: T1, then T2. God Eye approved the plan with no open items.
>
> **Gate H3** · hash `3f9a1c0b7e21` — reply **`approve`** to continue, or **`deny <what must change>`**.

End with exactly this, and **stop**:

> **Gate {id}** · hash `{first 12 chars}` — reply **`approve`** to continue, or **`deny <what must change>`**.

Rules:
- Only the user's own reply counts. Never approve on their behalf and never run `factory approve` (the guard blocks it).
- If they answer with other words ("looks good", "yes"), ask them to reply exactly `approve` — the hook only applies the exact reply.
- After they reply, the reply hook applies it before you act on the message. Don't rely on a note in the conversation: run `factory next`. Its `last_reply` says whether the reply was applied. If it was, continue the loop with what `factory next` returned. If it was *not* applied (for example the document changed, or the reply wasn't exact), tell the user why and present the gate again.
- On `deny`: `factory next` routes back to the step that made the document (clarify, decide or decompose) with the user's reason; follow it, and the gate comes back afterwards.
- A bare `deny` is refused (`last_reply` refused, code `needs_reason`): ask the user to reply `deny <what must change>` (`deny: …` works too).
