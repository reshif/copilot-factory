# Clarify v3: read-back, research, one decision sheet (design)

Replaces [DESIGN-CLARIFY-v2.md](DESIGN-CLARIFY-v2.md) and the clarify half of
[DESIGN-GROUNDED-INTENT.md](DESIGN-GROUNDED-INTENT.md). Jobs that are still in clarify migrate
(see *Migration*); jobs whose contract is already approved keep their v2 record, which ground and
decide still read.

## Why

Two real jobs on one repository (nautobot-jobs) showed the same failure class.

- **J-0002 (v1):** 9 rounds, about 2.5 hours, 4 parks, still blocked. Free-form answers did not
  count, God Eye raised one subject under 6 ids, vendor pages returned 404 every round.
- **J-0001 (v2):** the user's version ("Nautobot 2.4.x") never reached research, so the contract
  rested on 3.x docs. The scoping and naming decisions reached the user with no researched
  recommendation. Credentials vanished. The user's four-point denial changed one acceptance
  criterion: v2 treats settled issues as final, a denial was one todo line for a read-only text
  editor, and God Eye's objections became notes that passed H1.

The simulation (`clarify-study/simulation.md`) reproduced this on the real CLI and showed that
patches move the failure (v2.1 parked on a disagreement between the workflow and the CLI copies
of one rule, and regressed scenario d). The shape was wrong:

- **Routing by a label given once.** An agent's `owner`/`kind` at map time decided whether an
  issue was researched, asked or deferred. Later knowledge re-entered only through word-overlap
  matching and special cases.
- **Sticky, strengthless settlement.** A default nobody chose, a free-text answer, memory and
  wrong-version evidence all froze equally; the user could not reopen.
- **Convergence by a critic loop.** Every reply cost a 7–18 minute round of 8 agent roles.
- **Rules written twice** (workflow and CLI) and kept in step by tests.

v3 is a staged pipeline with a fixed dependency order and an explicit authority order, the way
every precedent we studied works (Spec Kit `/clarify` + `/plan` research, Claude Code's interview
to SPEC.md, Kiro's editable requirements, Devin's plan with citations): read back, research
against pinned versions, put a handful of researched decisions in front of the user once, write
the contract once, check it against a fixed checklist.

## The stages

```
                 your words
                     │
 (1) READ-BACK ──────┤ one interviewer call (seconds)
     intent, scope,  │ screen: what I took from your words, versions, what I'll find out
     pins, plan      ▼
              you: "ok" ─────────── or an edit in your words → read-back again
                     │
 (2) RESEARCH        │ one time-boxed pass: repo + docs researchers in parallel, then the
     pinned to the   │ brief writer (Decision / Options / Evidence / Recommendation)
     versions        │ ≤ 2 passes per entry; failures listed, never hidden
                     ▼
 (3) DECISION SHEET  │ ≤ 5 decisions with options, evidence, a recommendation;
                     │ facts I'll assume, with sources
              you: "ok" / "ok, but 2 b" / "3: other: …" (applied by the CLI, no agent)
                     │
 (4) CONTRACT        │ one contract writer call; you may edit contract.md yourself
                     ▼
 (5) READINESS       │ deterministic checks, then one God Eye pass with a fixed checklist;
                     │ a blocker goes back to the stage it concerns (never a note)
                     ▼
 (6) H1              │ goal, done means, checked against what you said, decisions and who
                     │ made them, what design may choose, research gaps, objections
              you: approve ─ or deny <words> → REDIRECT (read back, then restart at the
                                                 earliest affected stage)
```

A redirect can also be given at any time during clarify (`factory clarify redirect "<words>"`).

### 1. Read-back

- **Who:** the `interviewer` agent (mode `readback`), one call, read-only tools.
- **In:** every word the user gave (request, replies, denials), the draft contract, the
  repository's manifests, and the ledger's live items with their ids (on a re-run or after
  migration).
- **Out:** the intent (problem, who, outcome, success signal), scope in and out, the user's
  stated facts each with the exact quote, version pins each with its source, the research plan,
  and questions only the user can answer.
- **Pins** come from two places only:
  - a repo file, with the line quoted;
  - the user's explicit words, quoted.

  The CLI checks every quote: a user quote must be in the user's recorded words, a repo quote
  must be at the cited line. A pin it cannot verify is dropped and the plan gets an item to find
  the version out. A range (`>=2.0,<4.0`) is not a pin. Two pins for one system that disagree
  are a **conflict**: the read-back shows it and research waits until the user settles it.
- **The plan** is a list of things to find out, each tagged `repo`, `docs` or `decision`, with
  the pins it must be researched against. Implementation choices (which SSH library, how many
  threads) are not plan items: they are listed as "design may choose".
- **Shown, not waited on (0.9.0).** Intake no longer asks the user to confirm its restatement,
  type and risk: the read-back shows them a minute later. When nothing on the read-back needs the
  user (no pin conflict, no question only they can answer, no version a redirect changed), research
  starts at once; the read-back heads the next screen the user sees (the sheet, or H1 when there is
  no sheet) as **What I understood**, and the intent stays the factory's restatement (`assumed`)
  until H1 approves it. Words the user sends meanwhile become a redirect (a correction).
  `clarify.readback: "wait"` restores the blocking read-back.
- **Reply** (when it waits): `ok` (or yes, go, looks good …) confirms the read-back. Anything else
  is an edit: the words are recorded and the interviewer runs again with them (seconds).
- **Scope** in and out are items (kind `scope`): a redirect or a sheet answer can change a scope
  line by its id, and the change is shown like any other change of the user's words.

### 2. Research (the only long step)

- **Who:** `researcher` in `repo` mode and in `docs` mode, in parallel, each time-boxed
  (`clarify.research_minutes` for the job's risk), then the `brief-writer` once.
- **Pinned:** every docs finding carries the version its page documents. The CLI decides:

  | Finding | Verdict | Can it settle a fact? |
  |---|---|---|
  | repo quote found at the cited line | `repo` | yes |
  | repo quote not at the line | `bad_quote` | no |
  | docs, version matches the pin (`2.4.x` ↔ `2.4.3`, `/v2.4.x/` in the URL) | `pinned` | yes |
  | docs for another version (`3.2`, `/en/v3.0/`) | `other_version` | no |
  | docs for a pinned system with no version, or `/stable/` `/latest/` | `unpinned` | no |
  | docs about a system with no pin (an RFC, a vendor API with no version) | `docs` | yes |
  | no URL or no quote | `unsourced` | no |

  Every docs finding names the `system` its page documents; that is how the CLI matches it to a
  pin (never by word overlap with the plan item).

  Evidence for another version cannot confirm anything. When a pin changes, every finding is
  re-judged against the new pin.
- **The brief:** one research brief per pass. Each decision is a record in the Spec Kit form:
  **Decision**, **Options** (each with its consequences), **Evidence** (sources from the
  researchers' findings), **Recommendation** and why. A recommendation counts as researched only
  when it cites at least one usable finding.
- **Failures** are listed explicitly: a researcher that timed out or failed, web unavailable, each
  source that failed and why, pages skipped because they document another version. They go on
  the sheet, into the contract's `## Research gaps` section and onto H1.
- **Caps:** at most 2 passes per entry into research. A second pass runs only for high-impact
  items left without usable evidence after a transient failure (timeout, failed agent). If the
  brief writer fails in both passes the job **goes on, never parks** (0.9.0): every item it covered
  is marked "not researched" (a research gap on the sheet, in the contract and at H1) and its
  decisions are asked without a researched recommendation.

### 3. Decision sheet (one user turn)

The CLI builds it from the ledger, by current state:

- **Decisions:** items still to decide, high impact first, **at most 5**; more wait for a second
  sheet. Each has options, evidence and a recommendation, or says plainly that research did not
  produce one and why ("the docs researcher timed out"). A contradiction between the user's words
  and pinned evidence is a decision too ("You said Argon2 is the default; Django 3.2's docs say
  PBKDF2").
- **Facts I'll assume:** every fact the contract will rely on, with its source (your words, a repo
  line, a pinned doc, or "my assumption, not researched").
- **Reply in plain words; no ids needed.**

  | Reply | Effect |
  |---|---|
  | `ok` | every recommendation is accepted (strength *accepted*) |
  | `ok, but 2 b` / `2: report only` / `2 other: log it` | decision 2 takes option b, or the user's own words (strength *user*) |
  | `3 defer` / `3: design decides` | decision 3 is deferred, owner design |
  | `fact 2: we use Netmiko` | fact 2 corrected (strength *user*) |
  | anything else | the `interviewer` (mode `interpret`, one call) maps it to the sheet, quoting the reply; the CLI checks each quote |

  `ok` does not decide a decision that has no recommendation: it stays on the sheet, which says so.
  Answering is CLI work; the only agent call is the `interpret` fallback.

### 4. Contract assembly

- **Who:** the `contract-writer` agent, one call. It gets the read-back, the pins, the brief, the
  decided items with their strength and source, redirect items and any readiness blockers, and
  returns the full contract plus a **coverage map**: for every live item, where the contract
  honours it (an AC, a constraint, a non-goal, "design may choose").
- **The CLI** checks that the text parses, keeps the Intent section, adds no contract problem and
  cites no unusable evidence; then writes it and the CLI-owned sections from the ledger:
  `## Decisions`, `## Facts relied on`, `## Design may choose` and `## Research gaps`.
- **The user may edit `contract.md` directly**, at any time before H1 (the v2 guard lock is gone).
  The CLI notices a hash it neither wrote nor checked. Before the readiness check has passed, the
  next writer is told to keep the edit. Once it has passed (or while it runs), the edited text goes
  through the whole check again, deterministic checks first; an item the edit took out of the
  contract (the user deleted the AC that honoured it) becomes a decision on the sheet: put it back,
  or leave it out (the item is then dropped by the user; a user-stated item gets no
  recommendation). H1 says the contract was edited by hand.
- **Nothing leaves the contract silently.** Once the factory has written a version (or the user
  edited one), an AC, constraint or non-goal the writer's new text no longer has must be listed
  under the writer's `removed` with the item, blocker or redirect it rests on; otherwise the CLI
  refuses the text. H1 lists what was taken out and why.
- The contract is an input of the read-back, the writer and the readiness check only: an edit while
  research runs does not throw the research away.

### 5. Readiness

**Deterministic checks (CLI):**

| Check | A failure goes back to |
|---|---|
| the contract parses and has no contract problems | contract |
| every AC with `test`/`run` evidence is covered by a verify command | contract |
| every live item is covered (the writer's map, and the AC it names still exists) | contract |
| every high-impact decision is decided, or deferred with an owner | sheet |
| no evidence cited in the contract is `other_version`, `unpinned` or `bad_quote` | research |
| every redirect clause has an outcome | the clause's stage |

**God Eye pass (one call):** only when the deterministic checks pass, with a fixed checklist,
each item answered true or false:

1. `intent_clear`: the intent and goal agree and could be restated.
2. `scope_bounded`: non-goals say what is out.
3. `acs_testable`: every AC is testable and has a runnable verify.
4. `self_consistent`: no AC, constraint or decision contradicts another (AC-3 vs AC-8).
5. `facts_honoured`: every user-stated fact is honoured.
6. `instructions_handled`: every user instruction (redirect clause) is handled.
7. `decisions_closed`: every high-impact decision is decided or explicitly deferred with an owner.

Each objection names its check, `severity` (`blocker` or `note`), the `stage` it concerns, what it
points at, a fix, and **who can fix it** (`fixable_by`: `writer` from what is settled, or `user`; a
`user` blocker carries the `question`, its `options` and God Eye's `recommendation`). Without
`fixable_by` the CLI decides: its own checks by stage (assemble: the writer; sheet or read-back: the
user); God Eye's `assemble` and `research` blockers, a weak verify command (`acs_testable`) and a
self-contradiction that points at nothing the user said are the writer's; anything else the user's.
**A blocker goes back to whoever can fix it; it is never turned into a note.** Notes are shown at
H1 as remarks.

**The readiness loop (0.9.0, the shared loop engine `cli/core/loop.js`).** Writer blockers go back
to the contract writer in an automatic round, with God Eye's exact findings and fixes (the brief's
`round`: `n`, `of`, and the diagnosis's `approach` once there is one). Each round's open blockers
are fingerprinted (`check|REF`, plus the text of the CLI's own refusals); the loop goes on while
the set shrinks. After two rounds without shrinking, the writer runs on the stronger model
(`loops.escalate_model`, "opus"; a model the CLI refuses falls back to the session default); one
more round without progress and God Eye diagnoses the loop (focus `diagnosis`: the cause, and
either a different approach for the writer or the one specific question for the user). One more
round without progress after that ends the loop, as does the ceiling
(`limits.clarify_writer_rounds`, 5). A loop that ends goes to **H1 with the open objections and
the diagnosis shown** (`loop_end`), never to a park; a diagnosis that says only the user can
settle it puts its question (with options and a recommendation) on the sheet instead.

- **Tie-break:** a God Eye blocker raised again after a writer round that was given its fix is
  checked once by the `finding-verifier` (stage `dispute`, mode dispute: an objection on the
  contract, not on code). Refuted, it becomes a note (shown at H1 as a remark, never a blocker
  again); confirmed, the writer gets the verifier's reasoning with it.
- **User blockers** become one question each on the next sheet, with God Eye's options and
  recommendation; the writer blockers raised with them wait for the writer that runs after the
  user's answer.
- Writer rounds are counted apart from the readiness cycles that reach the user
  (`counters.writer_rounds`, `writer_loop`); a new cycle (after a user turn, research or a
  redirect) starts the automatic rounds again.

### 6. H1

`factory next` carries the H1 view (`clarify_h1`); the gate skill shows it:

- the goal and a short "done means" list;
- **checked against what you said**: each of the user's stated facts and instructions, and where
  the contract honours it;
- **the decisions and who made them** (you; your acceptance of a recommendation; pinned evidence;
  deferred to design);
- **what design may still choose**;
- **research gaps** and **God Eye objections** (with `loop_end` when the readiness loop ended
  without converging: its rule, rounds and the diagnosis);
- the read-back, when it was shown here and on no sheet;
- **changed by your later words** and **reworded in the contract** (each change with what it rests on);
- after a redirect, each clause **done** or **not done**.

H1 approval stays human-only (chat reply or the terminal with its typed code).

### Deny or redirect

A denial at H1 (or `factory clarify redirect "<words>"` at any time) is the highest-authority
input:

1. The words are recorded verbatim and become a redirect `R-n`.
2. The `interviewer` (mode `redirect`, one call) splits it into clauses, each quoting the user,
   and links each to an existing ledger item by id, or proposes a new item, with an action:
   `research`, `decide`, `fix` (contract text), `fact` (the user states it) or `instruction`.
   A sentence of the denial no clause quotes becomes an `instruction` item verbatim: nothing is
   dropped.
3. The CLI reads it back: "I took your redirect as: 1 … 2 … Reply ok, or say what I got wrong."
4. On `ok`, linked items **reopen** (the user can always reopen; the old value stays in history)
   and work restarts at the **earliest affected stage** (research < sheet < contract).
5. Each clause is tracked to an outcome and reported at the next H1 as done or not done.

Conservation is checked on the user's text, not sentence by sentence: every part of the redirect
no clause quotes ("…, and decide how credentials are supplied") becomes its own `instruction`
clause, verbatim. Two denials given before clarify reads either become one redirect. The same holds
for a sheet answer the interviewer reads (interpret): what it returns as `unclear`, word for word,
and any part of the reply no mapping quotes, become the user's `instruction` items verbatim.

**Later words win (0.9.0).** When the user's later words change what they said before (a clause
linked to an earlier fact, instruction or scope line by its id), the later words win and the change
is kept on the item (`changes`) and shown on the next screen: "changed: X → Y because you said …"
(the sheet, or H1). When the writer rewords a constraint or a non-goal because of it, it lists the
rewording under `changed` (`from`, `to`, `because`: the `I-n`, the user's words `W-n`, a blocker or
`R-n`): a cited change, recorded and shown at H1, not a drop. A placeholder ("None") the writer
replaces is no drop either.

**A version in a redirect** ("we actually run 2.3, not 2.4"): a clause linked to a pin, or a stated
fact that names a version, restarts at the **read-back**: the pin is reopened, the interviewer
reads the user's words again (between two versions the user gave, the latest is recommended), and
on `ok` every finding is judged again against the new pin. Facts that rested on the old version
drop to assumptions and are researched again; a decision whose researched recommendation rested on
it is reopened (unless the user decided it). The clause is done only when a version from words
given with or after the redirect is confirmed.

## Data model

One sealed file per job, `jobs/<J>/clarify.json`, `version: 3`. The CLI is its only writer.

| Field | What |
|---|---|
| `stage` | `readback`, `readback_wait`, `research`, `sheet_wait`, `interpret`, `redirect`, `redirect_wait`, `assemble`, `check`, `dispute`, `diagnose`, `ready` |
| `rev` | incremented on every write; part of a run's input hash (a result for an older state is stale) |
| `words` | `W-n`: everything the user said, verbatim, with how it arrived (`request`, `reply`, `denial`, `redirect`, `migration`) |
| `items` | `I-n`: the ledger (below) |
| `plan` | `P-n`: what to find out, each `{item, what, tag: repo|docs|decision, pins}` |
| `evidence` | `E-n`: `{item, claim, source, quote, version, tier, verdict}` |
| `readback` | the last read-back: intent, scope, `took`, pins, plan, questions, `confirmed` |
| `sheet` | the current sheet: decisions `D-n` (numbered 1…), facts `F-n`, queued decisions |
| `research` | passes (scouts, outcome, failures), the brief records, the failures list |
| `redirects` | `R-n`: the words, clauses `{quote, item, action, stage, outcome}`, status |
| `checks` | each readiness run: deterministic results, God Eye's checklist and objections |
| `contract` | the hash the writer produced, and whether it was edited by hand since |
| `counters` | research passes this entry, automatic writer rounds this cycle (`writer_rounds`), readiness cycles, sheets |
| `writer_loop` | the loop engine's state for the readiness loop: rounds, the open set per round, level (stronger model, diagnosed), the diagnosis |
| `disputes` | the tie-break verdicts, by blocker fingerprint |
| `loop_end` | how the readiness loop ended without converging (rule, rounds, findings, diagnosis), shown at H1 |
| `parked_words` | the user's words sent while the job was parked, read back as a redirect when it resumes |
| `migration` | the report, for a migrated job |

**An item** (`I-n`): `kind` (`intent`, `scope`, `fact`, `pin`, `decision`, `question`,
`instruction`), `text`, `value`, `status` (`open`, `to_decide`, `decided`, `assumed`, `deferred`,
`done`, `dropped`), `strength`, `source`, `tag`, `impact`, `owner` (for a deferral), `covered`
(the writer's map), `links` (redirects) and `history`.

**Identity** comes from ids the system assigns: the read-back's items, the plan, the sheet's
numbered decisions, the redirect clauses. Agents refer to existing items by id; the CLI never
matches items by word overlap.

## Authority

| Strength | Means | Overturned by |
|---|---|---|
| `user` | the user said it (their words, quoted) | the user only |
| `evidence` | a repo line, or a doc pinned to the confirmed version | the user; stronger evidence never exists above it |
| `accepted` | the user accepted a recommendation (`ok`) | the user; pinned evidence |
| `assumption` | an agent's assumption, shown under "facts I'll assume" | the user; pinned evidence |

- **The user can always reopen** anything: an edit, a sheet reply, a redirect.
- **Agents overturn only with stronger evidence.** Pinned evidence that disagrees with a
  `user` item does not overwrite it: the disagreement goes on the sheet as a decision.
- **Routing is by current state at every stage**, computed by one function
  (`clarify.route(item)`): an open `repo`/`docs` item with passes left goes to research; a
  decision with research done (or impossible) goes to the sheet; a decided item goes to the
  contract; a reopened item routes again from scratch. No label given once decides anything.
- **One module owns every rule:** `cli/core/clarify.js`. The workflow (`workflows/clarify.js`) only
  dispatches the agents the brief names and returns their raw replies.

## Agents

| Agent | Stage | Calls | Replaces |
|---|---|---|---|
| `interviewer` | read-back, redirect, interpret | 1 per user turn that needs words understood | intent-mapper, intent-analyst ×4, judge |
| `researcher` (repo, docs modes) | research | 1–2 in parallel, time-boxed | the per-unknown scouts |
| `brief-writer` | research | 1 | (new) |
| `contract-writer` | contract | 1, then automatic fix rounds while the blockers shrink (ceiling `limits.clarify_writer_rounds`) | contract-editor |
| `finding-verifier` | dispute | 1 per disputed objection (at most once each) | (new in 0.9.0) |
| `god-eye` (focus `readiness`) | readiness | 1 | God Eye's intent critique |

Retired: `intent-mapper`, `intent-analyst`, `judge`, `verifier` (evidence verifier: the CLI checks
repo quotes and versions itself), `contract-editor` (repurposed as `contract-writer`).

## CLI commands

| Command | Who | What |
|---|---|---|
| `factory run clarify` | main session | runs the stage `factory next` names (one workflow, its agents) |
| `factory clarify reply "<words>"` | main session, for the user | the user's words: read-back ok/edit, sheet answers, redirect confirmation |
| `factory answer "<words>"` | main session | the same as `clarify reply` during clarify |
| `factory clarify redirect "<words>"` | main session, for the user | a redirect at any time during clarify |
| `factory clarify status [--json] [--h1]` | anyone | the stage, items, sheet, failures, checks; `--h1` prints the H1 view |
| `factory proceed` / chat `proceed` | human only | after a cap park of a job from before 0.9.0: go on with the gaps explicit |
| `factory clarify split` | — | kept for migrated jobs: says that v3 has no folded issues |

`clarify reply` and `answer` are not gate verbs, so the main session runs them on the user's
behalf; the reply works when the prompt hook does not fire (VS Code on WSL). The prompt hook
still applies a chat reply when it does fire, but only an unmistakable one (`ok`, a numbered
sheet reply); other words are left for the main session to record. Approving H1 stays
human-only.

`factory next` while clarify is the step carries `clarify`: `{ stage, run, waiting_for_user,
screen, reply_command, status_command }`. `screen` is the CLI-rendered read-back, sheet or
redirect read-back; the skill shows it as is.

## The screens, for J-0001

### Read-back (turn 0, seconds after the request)

> **Read-back · J-0001 Nautobot VLAN sync from Cisco devices**
>
> **What you want** (my words, correct me)
> - Problem: VLANs configured on the Cisco switches are not in Nautobot; engineers add them by hand.
> - Who: the network engineers who use Nautobot as the source of truth.
> - Outcome: a Nautobot Job reads the VLANs of chosen devices and creates or updates them in Nautobot, and reports what changed.
> - Success signal: after a run, Nautobot lists every VLAN configured on the selected devices.
> - In scope: create and update; dry run. Out of scope: pushing configuration to devices; deleting VLANs.
>
> **What I took from your words**
> 1. Only Cisco IOS, IOS-XE and NX-OS — "cisco ios iosxe nxos only, nothing else"
> 2. Every VLAN is synced, reserved ones included — "sync all vlans"
> 3. 6 tenants, each with its own locations — "6 tenants, each with their own locations"
>
> **Versions I will research against**
> - Nautobot 2.4.x — you said "we run Nautobot 2.4.x" (the repo allows ">=2.0,<4.0", pyproject.toml:7)
> - netmiko ^4.3 — pyproject.toml:8
>
> **What I will find out** (about 10 minutes)
> 1. [docs] How Nautobot 2.4 scopes a VLAN: Location, VLAN Group, Tenant
> 2. [docs] How a Nautobot 2.4 job gets device credentials
> 3. [repo] How this repo registers and tests its jobs
> 4. [decision] The VLAN scoping model for 6 tenants with their own locations
> 5. [decision] What happens when a device's VLAN name differs from Nautobot's
> 6. [decision] How the job gets device credentials
>
> **Design may choose:** the connection library, parallelism, enable mode.
>
> Reply **ok** to start research, or tell me in your own words what to change.

### Decision sheet (turn 1, after research)

> **Decisions · J-0001** (research: 2 researchers, 1 pass)
>
> 1. **The VLAN scoping model for 6 tenants with their own locations**
>    - a) A VLAN Group per Location; the VLAN's tenant is the device's tenant **(recommended)**
>    - b) One VLAN Group per tenant
>    - c) Global VLANs with only the tenant set
>
>    Why a: in Nautobot 2.4 a VLAN's VID is unique within its VLAN Group, and a VLAN Group can be tied to a Location (docs.nautobot.com/projects/core/en/v2.4.x/user-guide/core-data-model/ipam/vlangroup/, E-2).
> 2. **The same VLAN ID with a different name in the same scope**
>    - a) The device's name wins, and the change is reported **(recommended)**
>    - b) Report it, never rename
> 3. **How the job gets device credentials**
>    - a) The device's Secrets Group (username and password secrets) **(recommended)**
>    - b) One Secrets Group chosen when the job runs
>
>    Why a: Nautobot 2.4 jobs read device credentials through Secrets Groups (…/v2.4.x/user-guide/platform-functionality/secret/, E-4).
>
> **Facts I'll assume** (say if one is wrong)
> 1. Jobs are registered in jobs/__init__.py with register_jobs (jobs/__init__.py:1)
> 2. Job tests run with pytest (pyproject.toml:11)
>
> **Sources skipped** (not relied on)
> - docs.nautobot.com/projects/core/en/stable/…: a moving page (stable/latest), not the confirmed version
>
> Reply **ok** to take my recommendations, or say what to change: **ok, but 2 b**, **3: other: …**, **2 defer**.

### H1 (turn 2: "ok, but 2 b")

> **Contract · J-0001 Nautobot VLAN sync from Cisco devices**
>
> **Goal:** engineers run a Nautobot 2.4 Job against chosen Cisco devices; the devices' VLANs are created in Nautobot in the VLAN Group of the device's Location with the device's tenant; name mismatches are reported, never renamed; nothing is deleted.
>
> **Done means**
> - AC-1 The job is listed with a device picker and a dry-run flag.
> - AC-2 Every VLAN missing in the device's Location VLAN Group is created, reserved VLANs included.
> - AC-3 A VLAN with the same ID and a different name in the same scope is reported and left unchanged.
> - …
>
> **Checked against what you said**
> - ✓ "cisco ios iosxe nxos only, nothing else" → Constraints
> - ✓ "sync all vlans" → AC-2
> - ✓ "we run Nautobot 2.4.x" → every source cited documents v2.4.x
>
> **Decisions and who made them**
> - Scoping model → a VLAN Group per Location (recommended; you accepted)
> - Name mismatch → report, never rename (you: "2 b")
> - Credentials → the device's Secrets Group (recommended; you accepted)
>
> **Design may still choose:** the connection library; parallelism; enable mode.
>
> **Sources skipped:** 1 (a moving page (stable/latest), not the confirmed version); none of them is relied on.
>
> **God Eye:** all 7 checks pass.

When the user chose `proceed` over an open blocker, the God Eye line is replaced by **God Eye
objects** (it did not approve this contract …) with each objection; drops are listed under
**Dropped** with who dropped each item and why; open research gaps under **Research gaps**.
>
> **Gate H1** · hash `…` — reply **approve**, or **deny <what must change>**.

## Latency

| User turn | CLI work | Agent calls |
|---|---|---|
| request → read-back | record the words | 1 interviewer |
| `ok` → sheet | confirm, plan | 1–2 researchers (parallel, time-boxed) + 1 brief writer |
| sheet reply → H1 | apply answers | 0 (1 interviewer only when the reply is free prose) + 1 writer + 1 God Eye |
| `approve` | approval | 0 |
| a redirect | record, read back | 1 interviewer; then only the stages it reaches |

v2 spent a full round (mapper, scouts, verifier, 4 analysts, judge, God Eye, editor; 7–18
minutes) on every reply. v3 spends the long research once; every other turn is one or two short
calls.

## Caps and stop rules (0.9.0: progress first, counts as ceilings)

| Loop or cap | Default | When reached |
|---|---|---|
| research passes per entry into research | 2 | go on: the items are research gaps, the sheet asks without a researched recommendation |
| decisions per sheet | 5 | the rest wait for the next sheet |
| the readiness loop (writer ⇄ God Eye) | while the open blockers shrink; 2 rounds without → the stronger model; 1 more → the diagnosis; 1 more → the end; ceiling `limits.clarify_writer_rounds` (5) | **H1** with the open objections and the diagnosis shown (or the diagnosis's question on the sheet) |
| readiness checks that send work back to the user's stages (the sheet, research, the read-back) | 3 | **H1** with the open objections shown |
| `ok` on a sheet whose open decisions have no recommendation | the second `ok` | those decisions are deferred to design, recorded as the user's (the sheet warned after the first) |
| an agent that returns nothing | retried once in the same run | park with the failure named (the only clarify park left) |

While a job is parked, `clarify reply` and `clarify redirect` **store the words** (never refused):
the user's own chat reply is resume + content, and the words are read back as a redirect once the
job resumes. Resume stays the user's alone.

Policy keys: `clarify.readback` (`show` | `wait`), `clarify.facts_sheet`, `clarify.tiebreak`,
`clarify.max_research_passes`, `clarify.max_sheet_decisions`, `clarify.max_readiness_cycles`,
`clarify.research_minutes.{low,medium,high}`, `limits.clarify_writer_rounds`, and the shared loop
engine's `loops.{ceiling, stall_rounds, escalate_model, diagnose}`. The web switch and search tool
stay `intent_research.web` and `intent_research.search_mcp`. (`clarify.max_writer_attempts` is gone:
the writer's rounds are the loop's.)

## Who said it

Every word is recorded with how it arrived. Words the main session relays (`job new --request`,
`clarify reply`, `clarify redirect`) are marked `relayed`: the factory cannot tell them from the
user's own (in VS Code on WSL the reply hook never fires, so all of them are). H1 marks each
quote that came this way and says how many of the user's words were relayed; `clarify status`
lists them. Gate verbs (approve, deny, resume, proceed, reseal) stay human-only.

`clarify.json` is sealed. A record that fails its seal is never run, replied to or recorded over
(a forged envelope cannot reseal it); `factory reseal` (human-only) keeps the file as it is.

## Migration

The first v3 touch of a job that is in clarify with a v1 or v2 record (`intent-evidence.json`)
and no `clarify.json` migrates it. The v2 record is left as it was (history).

- Each v2 issue becomes an item; each alias a v2 fold merged becomes **its own item** again,
  linked to the one it was folded into (no `split` needed).
- `answered` (settled by the user) → strength `user`, the answer kept as a word `W-n`.
- An accepted default → strength `accepted`. A low-impact issue the v2 rules assumed without
  asking → strength `assumption`, shown under "facts I'll assume".
- Settled by evidence → strength `evidence` if the evidence is pinned once the read-back confirms
  the versions; otherwise it drops to `assumption` with the reason.
- Deferred to design → `deferred`, owner design. Dropped → `dropped`, with the reason (the user
  can reopen it).
- Open, researching and asked issues → `open` / `to_decide`.
- The H1 denials newer than the last approval become one redirect (all of them, in order), read
  back to the user after the read-back.
- The options v2 asked with are kept; a v2 default becomes the recommendation only when it names
  one of the options ("Your call: …" was no recommendation). A drop keeps who dropped it and why
  from the v2 history (J-0001's credentials: "judge: the README will cover it").
- A migrated finding names no system: it is judged against the item's pins, or every pin, so a
  `/stable/` (3.x) page never confirms a 2.4 fact. With only the repository's range known, a moving
  page or a page outside the range confirms nothing either.
- The job restarts at the **read-back** with all of this pre-filled; the screen says what was
  carried over.

A job whose contract is approved keeps its v2 record; ground and decide read it as before.

## Removed

- The 4-analyst panel, the judge and the round loop (`fanout-judge --config clarify`).
- Token-overlap identity, subjects, aliases and folds; `clarify split` (a no-op message now).
- Progress-parking arithmetic (`clarify_no_progress_rounds`, ceilings, bonus rounds, degraded
  streaks); replaced by the fixed caps above and the human `proceed`. (0.9.0 brings progress back
  as one set comparison on the ids the CLI assigns, in the shared loop engine, and ends at H1
  rather than in a park: no arithmetic, no word overlap.)
- (0.9.0) Intake's own confirmation question, the facts-only sheet, the writer-attempt park and
  the readiness-cycle park.
- "Settled is final" for the user.
- The guard's clarify lock on `contract.md`.
- The question protocol module (`questions.js`) and the evidence verifier agent.

## Kept

Sealed records, human-only safety (TTY code, guard), the `factory run` runner, H1 semantics
(bound to the contract hash), the console's Clarify block (now showing the stage, items, sheet
and failures), and `factory clarify status`.

## Acceptance suite

`tests/clarify-v3-acceptance.test.js` drives the real CLI and `factory run clarify` against the
scripted fake Copilot with crews that read the briefs they are given, modelled on how the real
agents behaved (including a docs researcher that also fetches `/stable/` pages, a writer whose
first draft contradicts itself, a researcher that times out). One scenario per simulation case:

| Scenario | Pass criteria |
|---|---|
| a. J-0001 replay | the four denial points are met: scoping researched in 2.4 docs with a recommended model; AC-3 matches within the scope; credentials decided; nothing rests on 3.x docs. The user's 2.4.x is honoured. A denial is read back, tracked and reported done item by item |
| b. Flask rate limiting (repo facts) | repo facts settle from the repo; the limits become a testable AC; no item vanishes |
| c. "make the sync faster" | measurable ACs with a runnable verify, or explicit questions on the sheet; never "the sync runs faster" |
| d. the user contradicts research | the version conflict is shown on the read-back; the false "Argon2 is the default" is a decision on the sheet, not approved silently |
| e. agents fail | failures are shown on the sheet, in the contract and at H1; a run with nothing usable parks |
| J-0002 shape | a long multi-answer job ends in at most two sheets; no subject asked twice; free-form answers count |
