# The factory's documents

Every document the factory keeps about a job follows a versioned template in [`templates/docs/`](../templates/docs). The aim: docs that look the same from job to job, that a reviewer can read in a known order, that tooling can parse, and that still answer "why is it like this?" a year later.

## The set

| Type | Template | Written by | Lives at | Required diagram |
|---|---|---|---|---|
| `intent-findings` | [`intent-findings.md`](../templates/docs/intent-findings.md) | CLI, after each clarify round and each `change A-n` / `drop A-n`, from `intent-evidence.json` | `jobs/<J>/intent-findings.md` | — |
| `findings` | [`findings.md`](../templates/docs/findings.md) | CLI, from researchers' cited claims | `jobs/<J>/findings.md` | — |
| `threat-model` | [`threat-model.md`](../templates/docs/threat-model.md) | threat modeler (high risk) | `jobs/<J>/threat-model.md` | Mermaid data-flow `flowchart` with every trust boundary as a `subgraph` |
| `adr` | [`adr.md`](../templates/docs/adr.md) (MADR-style, `adr@2`: design depth) | architect | `jobs/<J>/adr-NNN-<title>.md` | Component diagram (C4-style `flowchart`/`graph` with a boundary, naming modules of the layout); end-to-end `sequenceDiagram` with an `alt`/`opt`/`break` failure or dry-run path; data mapping table (or `erDiagram`); failure table (optional `stateDiagram-v2`); a `text` project-layout tree |
| `no-adr` | [`no-adr.md`](../templates/docs/no-adr.md) (`no-adr@2`) | architect, when there is one obvious way | `jobs/<J>/no-adr.md` | flow optional; the project-layout tree is required; refused (an ADR is required) when the option generators proposed two or more materially different options (different files, or different titles without files), or at medium/high risk when the job uses an external system (pinned packages or API ledger entries) |
| `recommendation` | [`recommendation.md`](../templates/docs/recommendation.md) | architect (spike) | `jobs/<J>/recommendation.md` | optional |
| `contracts` | [`contracts.md`](../templates/docs/contracts.md) | architect (epic) | `jobs/<J>/contracts.md` (+ `contracts.json`) | optional interface map |
| `ship-report` | [`ship-report.md`](../templates/docs/ship-report.md) | CLI (`factory report`, `factory ship`) — also the PR body | `jobs/<J>/completion-report.md` | — |
| `index` | [`index.md`](../templates/docs/index.md) | CLI (`factory doc index`, `factory ship`) | `jobs/<J>/docs-index.md` | — |
| `lessons` | [`lessons.md`](../templates/docs/lessons.md) | CLI, on every lesson change | `.factory/lessons/lessons.md` | — |

The outcome contract (`contract.md`) keeps its own format (`cli/core/contract.js`); the other docs link to it.

## Conventions

- **Front matter** on every doc: `doc` (type), `template` (`<type>@<version>`), `job`, `title`, `status` (allowed values are listed in the template's comment), `date` (YYYY-MM-DD), `contract`, `related` (sibling docs). The ship report adds the build `fingerprint`.
- **One H1** shaped like the template's (`# ADR 001: …`, `# Threat model: …`).
- **Fixed `##` sections in a fixed order.** Add `###` subsections freely; extra `##` sections go after the last template section.
- **Guidance comments** (`<!-- … -->`) explain each section; `<!-- rule: … -->` comments are what the check enforces: `optional`, `table`, `acs` (every contract criterion id appears), `threats` (every `TH-n` of the threat model appears), `mermaid <types>` (a well-formed block of one of these diagram types), `subgraph` (that block draws a boundary), `ledger` (External API usage rows cite verified `L-n`). The design-depth rules (0.11, `adr@2` / `no-adr@2`) are listed below. The template is the single source of truth: change a template's rules and the check follows.
- **IDs carry through**: `AC-n` from the contract, `TH-n` from the threat model, `T-n`/`S-n` from the plan, `L-n` for lessons, finding ids from review.
- **Versioning**: bump `@N` in a template's front matter when a change would make old docs fail, and keep the old template under [`templates/docs/legacy/`](../templates/docs/legacy) (`adr@1.md`, `no-adr@1.md`). The `template:` line in a doc's front matter is its version marker: a doc that names an older version is checked by that version's rules (with a warning), so designs written before an upgrade, in jobs still in flight, keep passing; a doc that names the current version — or none — gets the current rules. A job created under design depth carries `design_templates` (`adr@2`, `no-adr@2`) in its sealed recipe lock: in such a job an ADR or no-adr note written under an older template is a doc check **error**; only jobs created before this release (no `design_templates` in their lock) keep the older rules.

## Design depth (0.11: `adr@2`, `no-adr@2`)

The design the human approves at H2 (or the medium-risk combined gate) must show **what** is decided and why, **how** the whole thing works end to end, and **where** every file goes. The ADR's sections, in order: Context · Decision drivers · Considered options · Decision · **Decision records** · Architecture diagram · **End-to-end flow** · **Data model and mapping** · **Failure and state flow** · **Project layout** · **How it runs** · External API usage · Consequences · How each acceptance criterion is met · Threat mitigations · Rollback and migration · Open questions. Their rules, all deterministic (`cli/core/design.js`):

| Rule | Section | Checked |
|---|---|---|
| `refs` | Decision drivers | cites at least one `AC-n` |
| `options` | Considered options | two or more options; a row for every option generator's option by its id (`O-1`, `O-2`…; `factory record` writes them to `jobs/<J>/options.json` from the decide fan-out) |
| `decisions` | Decision records | one or more `### D-n: <title>` records, each with **Context.**, **Drivers.** (cited by id: AC-n, A-n, a constraint, a finding), **Options.** — a trade-off table with ≥ 2 options, ≥ 2 criteria columns and exactly one `chosen` verdict — **Choice.**, **Consequences.** and **Revisit when.**, none of them a token sentence |
| `mermaid …; subgraph; layout-names` | Architecture diagram | a flowchart/C4 block with a boundary that names at least one module of the Project layout |
| `mermaid sequenceDiagram; branch; flow-acs` | End-to-end flow | a sequence diagram with ≥ 4 messages and an `alt`/`opt`/`break` path; every AC appears here or in a failure row |
| `mapping` | Data model and mapping | a Source → Target table with a match key (column marked yes, or a sentence naming the key), or an `erDiagram`/`classDiagram`, or `None: <why>` |
| `failures` | Failure and state flow | a table of ≥ 2 failures with how each is detected and what the run does, mapped to ACs |
| `layout` | Project layout | a fenced `text` tree, one file per line with `# status · responsibility · ACs` (status `new`, `changed`, `existing` or `deleted`); paths inside the repository and unique; every AC served by a file; a new or changed test file when an AC needs test evidence |
| `runs` | How it runs | entry points, registration and commands in `code` |

`factory doc design --job J [--format md]` prints what the gate shows: the decision summary table, every diagram, the layout tree with each file's owner task (once there is a plan), and how it runs.

## `factory doc`

```bash
factory doc list                       # types, template versions, sections
factory doc template adr               # print a template to start from
factory doc check path/to/adr-001-x.md # check one file (inside a job folder: against that job's ACs and threats)
factory doc check --job J-0007         # check every templated doc of a job
factory doc index --job J-0007         # (re)write jobs/J-0007/docs-index.md
```

The check is cheap and syntactic — no Mermaid renderer is needed. For Mermaid it checks the block is closed, starts with a known diagram type, has balanced brackets and `subgraph`/`end` (or `alt`/`loop`…/`end`) blocks, and draws at least one edge, message or relationship.

## Where it is enforced

- **Decide**: `factory record` checks the whole design record (ADR, no-adr, recommendation, threat model, epic contracts). Any problem — a missing section, no Mermaid architecture diagram, an uncovered criterion, an unmapped threat — makes the step `retry`; the next decide brief lists the problems for the architect, and three failures in a row park the job. The architect and threat modeler are told the template path and to run `factory doc check` before returning.
- **Decompose**: with an `adr@2` / `no-adr@2` design, `factory plan validate` derives ownership from the Project layout: every new, changed or deleted file is owned by exactly one task (its allowed paths cover it, no other task's do), and every task's allowed path is either one of its own layout files or a glob whose every match (among the layout's files and the repository's files at the base commit) is one of them: never `**`, a bare directory, or a glob that also covers an existing file or another task's; existing files need no owner. Layout entries are files, never patterns, and their status is checked against the base commit (`existing`, `changed` and `deleted` files must exist there, `new` ones must not). The planner's brief lists the files to own; the result carries `layout` and `layout_tree` (each file's owner) for H3.
- **Gates**: `review.design` at H2 and H3 (and the combined medium gate) carries the decisions, the diagrams and the layout with owners; the gate skill, `factory inbox`, the drive's stop and the console (which draws the Mermaid diagrams itself) present it in one place.
- **Critics**: God Eye's design checklist and the API-conformance critic check that the flow and the layout are complete and consistent with the contract and the API ledger.
- **Clarify**: the CLI renders `intent-findings.md` (summary, what we found with source, retrieval date, version and verdict, what we are assuming, what only you can answer, every unknown, the research log) after every round; `ground`'s `findings.md` links it and does not research those unknowns again.
- **Ground** and **ship**: the CLI renders findings, the completion report and the index from sealed state, so they always match their templates; the same build renders the same report.

## Why it pays off later

The docs form one traceable chain: **intent findings** (the evidence behind the intent, `E-n`, `A-n`) → **contract** (what, `AC-n`) → **findings** (cited facts) → **threat model** (`TH-n`) → **ADR** (decision records, component and sequence diagrams, data mapping, failure flow, project layout, AC table, threat mapping, rollback) → **plan** (tasks own `AC-n`) → **evidence** (ledger) → **completion report** (AC → proof, what changed, risk, rollback) → **lessons** (rule, scope, why). `docs-index.md` puts the chain for each criterion on one row. Months later, `grep -l "doc: adr" -r .factory/jobs` finds every decision, the diagram shows the shape the team agreed on, and the report says how it was proven and how to undo it.
