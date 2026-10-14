---
name: amend
description: Factory amendment — change an approved contract or plan when requirements change, with an impact summary and the user's approval; only affected tasks are rebuilt. Use when the user says requirements changed during a job, or when `factory next` returns skill amend.
user-invocable: false
---
# Amend

Approved documents are bound to their hash. Changing them goes through an amendment, never a silent edit.

1. If no amendment is open: ask the user what changed and who asked for it (if they haven't said), then run
   `factory amend start --reason "<what changed>" --by "<who asked>"`.
   If `factory next` sent you here because an approved document drifted, the reason is that drift — confirm with the user whether the change is intended; if not, restore the approved original from `.factory/jobs/<job>/approved/` (the CLI keeps a copy of every approved contract and plan) and run `factory next`.
2. Edit **only** the affected acceptance criteria in `contract.md` and the affected tasks in `plan.json` (or slices in `slices.json`).
3. Run `factory amend submit`. It validates both, computes the impact (criteria changed, tasks affected) and puts gate **A** in front of the user.
4. Run `factory next` — it returns gate A; follow **factory:gate**.
After approval, earlier steps are carried forward to the new hashes and only the affected tasks rebuild.
