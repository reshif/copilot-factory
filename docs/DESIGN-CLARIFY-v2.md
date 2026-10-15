# Clarify v2: a convergent clarify stage (design)

> **Superseded by [DESIGN-CLARIFY-v3.md](DESIGN-CLARIFY-v3.md).** Clarify v3 replaces the analyst panel, the judge loop, token-overlap identity, the contract lock and progress-parking described here with a read-back, one pinned research pass, one decision sheet, one contract writer and a readiness check. Kept as history; v2 records migrate on their first v3 touch.

Builds on [DESIGN-GROUNDED-INTENT.md](DESIGN-GROUNDED-INTENT.md) (research first, ask only
what research can't answer). That design made clarify grounded; this one makes it
**converge**: one ledger of issues that the CLI owns, identity by subject instead of wording,
one answer channel, a defined exit for research, rounds that review only what changed, and a
park rule that measures progress instead of counting rounds.

## Why

On a real job (Nautobot interface VLAN sync, standard@medium) clarify ran 9 rounds in about
2.5 hours and parked 4 times on the round cap. Every round re-reviewed the whole contract,
paraphrases of a settled question got new ids, free-form answers never grounded anything,
unreachable vendor pages were researched again every round, God Eye's "revise" left the user
with nothing to answer, and implementation details (the exact switch command) were treated as
intent.

## The ledger (one source of truth)

The ledger is the job's existing sealed `jobs/<J>/intent-evidence.json`, now `version: 2`.
Each unknown (`U-n`) is an **issue**. A second file would hold the same unknowns twice, so the
research record and the ledger stay one file.

| Field | Meaning |
|---|---|
| `id` | `U-n`, kept for continuity |
| `subject` | a short stable key, e.g. `nxos.switchport-command` (agent-given or derived) |
| `text` (title), `kind`, `impact` | `kind`: intent, scope, constraint, acceptance, repo, world, decision or user |
| `owner` | `research`, `user` or `design` |
| `status` | `open` → `researching` → `proposed` → `settled`, or `deferred_to_design` / `dropped` |
| `settled_by` | `evidence`, `user`, `assumption_accepted` or `design_deferral` |
| `evidence`, `question_id`, `answer`, `assumption` | links to E-n, Q-n, the answer, A-n |
| `default`, `reason` | the proposed default and why research could not settle it |
| `aliases` | folded duplicates (`[{id, text}]`) |
| `attempts`, `failed_sources` | research attempts and the sources that failed |
| `notes`, `history` | `{round, event, actor, text?}` |
| `applied_round` | the round whose contract edit reflected this settled issue |
| `resolution`, `note`, `researched` | the v1 fields, derived from the above for older readers |

Top level adds `notes` (God Eye's approve-with-notes), `migration` (the report) and, per
round, a `ledger` block: `opened`, `settled`, `deferred`, `asked`, `progress`, `degraded` and
the `totals` after the round. The contract's section hashes at each recorded round
(`sections`) tell the next round what changed.

**Settled is final.** A settled issue reopens only when a new *confirmed* evidence item says
`contradicts: "U-n"`. A paraphrase or an agent's new question about a settled subject is
recorded as a note on the issue, never a reopen. Only the user can replace their own answer.

## State machine

```
            research-owned                          user-owned
open ──scout──▶ evidence usable ─────────────▶ settled (evidence)
  │             transient failure (attempt 1)
  │               └▶ researching ──retry×2 budget──▶ (same checks)
  │             unreachable / unverified / contradicted / verifier timeout / budget spent
  │               └▶ owner user, proposed (default = the claim, reason = why) ──┐
  │                                                                            ▼
  └── user / decision / intent… ──────────────────────▶ proposed ──answer──▶ settled (user)
                                                          │ unanswered next round,
                                                          │ default given ─▶ settled (assumption_accepted)
implementation fact (owner design) ─────────────────▶ deferred_to_design (design_deferral)
low impact, not researched ─────────────────────────▶ settled (assumption_accepted)
judge dismissal / user drop ────────────────────────▶ dropped
```

The workflow applies these rules first (it cannot import modules, so they are written
twice, as before) and `factory record` re-applies them on the CLI's own copy.

## Identity: the dedup rule

Every agent output that raises an issue (mapper unknowns, analyst and judge questions, God
Eye items and researchable questions) carries `same_as` (`"U-n"` or `"new"`) and a `subject`.

1. `same_as: "U-n"` naming a live issue (or one of its aliases) attaches to it.
2. Otherwise the subject keys are compared: equal keys are the same issue when at least one
   side's key was given by an agent (a key derived from the text's first words is no identity
   on its own).
3. Otherwise significant tokens are compared (subject and text, lower-cased, stop words out,
   plurals stripped, a few synonyms: `cli`/`syntax`/`cmd` → `command`, `NX-OS` → `nxos`; for
   the comparison also `-ed`/`-ing`/`-e` endings): at least 3 shared tokens and Jaccard ≥ 0.5
   or overlap coefficient ≥ 0.75. When a word is swapped for another (each side lacks as
   many of the other's tokens), at least 5 shared tokens are required (the swapped word may
   be the point: "native VLAN" vs "allowed VLANs", "leaf" vs "spine"). When both sides carry an agent-given subject that
   differs, Jaccard ≥ 0.6 is required.

A match against an open issue attaches (aliases, evidence, question); against a settled one
it becomes a note. The rule is deterministic, so the workflow and the CLI agree, and the
migration uses the same rule on wording alone.

Every clarify brief carries the ledger: settled issues as "do not re-raise (use same_as)",
open issues as "the only things to ask about", deferred items as "not clarify's".

## Owner classification (implementation facts go to design)

Clarify settles what the user wants, the scope, the constraints and how done is judged; how
it is built is design. An issue is `owner: design` when the mapper or judge says so (an
`owner` field), or, as the CLI fallback, when a repo or world issue's text is about exact
API field names, source line ranges, command syntax or parser behaviour (a keyword rule:
"exact syntax", "command form", "field name", "line range", "parser", "which command" …).
Design-owned issues become `deferred_to_design` with a note. They go into the ground brief
and the decide inputs, and `groundedProblems` / `intent_grounded` ignore them.

## One answer channel

- `factory answer U-n "<answer>"` or `factory answer Q-n "<answer>"` settles the issue
  (`settled_by: user`), world facts included (recorded as `user_asserted`).
  `factory answer Q-n --default` (or the answer `default`) accepts the proposed default.
- `factory answer --question "…" --answer "…"` matches the text to an issue by subject or
  overlap. No match during clarify: the command fails with `no_match` and lists the open ids;
  nothing is silently dropped. (After H1, ground's blocking questions keep the v1 behaviour.)
- Chat: the prompt hook reads a numbered reply ("1 yes, 2 trunk ports too", one per line or
  comma-separated; "Q-4 no" names the question by id) as answers to the questions the last
  clarify round showed, in the order shown (`state.clarify_shown`), through the same function.
  All or nothing: a number outside the set, a question twice or one already settled refuses
  the reply. A reply none of whose numbers is in the set, or with an item ending in "?", is an
  ordinary message and is left alone.
- `factory clarify note U-n "…"` adds context for the next round.
- `factory clarify split U-n <alias>` (human-only, the user's terminal) undoes a wrong fold: the
  alias becomes its own issue again (asked, researched or deferred next round as a new raise).

Gating is unchanged from `factory answer` today: it is the main session's (the user's
relay), never a factory agent's (`FACTORY_RUNNER`, the CLI and the guard both refuse it).

## Rounds review only what changed

Round N's brief carries the answers and evidence since round N−1, the open issues, and the
contract sections whose hash changed since the last recorded round. With nothing changed and
nothing new, the analysts and the judge are skipped and the ledger's own proposals are the
questions.

God Eye uses a fixed checklist (`intent_clear`, `scope_bounded`, `acs_testable`,
`no_open_blockers`, `constraints_consistent`), and each item points at an AC, a section or
an issue (`ref`). Then:

- an item about a settled issue, or a duplicate subject, is a note;
- an item with a `ref` and severity blocker or major is **actionable**: the contract editor
  revises the contract and God Eye looks once more;
- what is still an actionable blocker after that becomes a user issue whose proposed default
  is God Eye's suggestion (one word to accept);
- "revise" with nothing actionable left is **approve-with-notes**: the notes are recorded.

So a round never ends `needs_user` with zero questions.

## One writer

During clarify the contract changes only through the workflow and `factory record`:

- the new **contract-editor** agent (read-only tools) returns the revised contract text; the
  CLI validates it (it must parse, keep the Intent section, add no contract problems, and
  lose no acceptance criterion, constraint or non-goal unless the editor lists it under
  `removed` with a reason that holds up: a settled or dropped issue, or the God Eye item, user
  note or gate denial it was given) and writes it when it records the round. When the CLI
  refuses a revision, the round is not `ok` even if God Eye approved the revision. The editor
  runs at the start of a round when settled issues are not reflected yet, notes or a denial
  reason are new (a denial goes to it once), or the contract has problems; and once after God
  Eye's actionable items;
- the CLI writes `## Clarifications (settled)` (user answers and accepted defaults) and
  `## Deferred to design` from the ledger, beside `## Assumptions (evidence-backed)`.

The guard denies Write/Edit of `.factory/jobs/<J>/contract.md` while the job is in clarify:
at least one clarify round recorded, no H1/EH1 approval, no amendment open. The first draft
(intake, the clarify skill's draft, before round 1) and amendments after H1 stay allowed. The
deny names `factory answer`, `factory clarify note`, `factory clarify status` and
`factory next`.

## Convergence: progress, not rounds

- A round makes **progress** when something was settled, deferred or dropped since the last
  round, or the round asked the user new questions, or opened new research-owned issues, or
  the contract editor's revision changed the text and applied what it was given (a settled
  issue, a note, a denial) or fixed a contract problem. A rewrite that applies nothing is not
  progress.
- Clarify parks ("not converging") after `limits.clarify_no_progress_rounds` (default 2)
  rounds in a row without progress, or at the hard ceiling `limits.max_intent_rounds`
  (now default 10).
- A degraded round (agents failed after their retry) is retried once automatically
  (`status: retry`); it counts toward neither rule. A second degraded round in a row asks the
  user, as before.
- `resume` resets the no-progress counter and, after a ceiling park, allows
  `clarify_no_progress_rounds` more rounds. The round counter itself stays monotonic.

`factory clarify status [--job J] [--json]` prints the issue table (id, subject, status,
owner, next action) and per-round counts with the trend. It is read-only and open to agents.

## Migration

The first v2 touch of a v1 record (status, answer, note, a new round) migrates it; status
migrates in memory only, so it works right after an upgrade with no new round:

1. Subjects are derived from the text by the normalised-key rule.
2. Issues with the same subject (or a token-overlap match) are folded into the earliest id;
   the others become aliases, and evidence, assumptions and questions are re-pointed.
3. `assumption` → settled by evidence; `answered` → settled by user; free-form answers in
   `answers.json` with no Q-n are matched by overlap (the report lists which); `deferred`
   (low impact) → settled, accepted; `dismissed`/`dropped` → dropped; asked questions →
   proposed; `pending` → open.
4. Implementation-fact unknowns are reclassified `deferred_to_design` by the keyword rule;
   the report lists them.
5. Pre-v2 policy snapshots (no `clarify_no_progress_rounds`) get the ceiling
   `max(max_intent_rounds + 2, the live default)`, and the rounds the job ran before its first
   v2 round (`counters.clarify_v2_from`) are not counted against it: J-0002 had run 9 rounds,
   which would have left it one.

## Visibility

- Console: a Clarify block in the Blueprint's section view and in the Job view (issues table
  with status, owner and next action; the per-round opened/settled trend; deferred items).
  The Board's "Your turn · Clarify" shows "N questions" from the ledger.
- `factory next` for clarify carries `clarify`: open issues by owner, the open questions and
  the exact `factory answer` commands.

## Known limits

- The token rule keeps short texts one telling word apart, but longer texts that share five or
  more words can still be folded ("Does the Nautobot interface VLAN API expose tagged VLANs?"
  vs "… the native VLAN?"): no word rule tells that apart from a paraphrase. A folded issue
  shows its aliases in `factory clarify status`, and `factory clarify split` undoes it.
- The implementation-fact rule is a keyword rule; it only applies to repo and world issues
  without an agent-given owner.
- The contract editor rewrites the whole text; the CLI rejects a revision that adds contract
  problems, but cannot judge that a rewording is faithful (God Eye's second look does).
