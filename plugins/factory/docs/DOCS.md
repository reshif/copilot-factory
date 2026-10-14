# The factory's documents

Every document the factory keeps about a job follows a versioned template in [`templates/docs/`](../templates/docs). The aim: docs that look the same from job to job, that a reviewer can read in a known order, that tooling can parse, and that still answer "why is it like this?" a year later.

## The set

| Type | Template | Written by | Lives at | Required diagram |
|---|---|---|---|---|
| `findings` | [`findings.md`](../templates/docs/findings.md) | CLI, from researchers' cited claims | `jobs/<J>/findings.md` | — |
| `threat-model` | [`threat-model.md`](../templates/docs/threat-model.md) | threat modeler (high risk) | `jobs/<J>/threat-model.md` | Mermaid data-flow `flowchart` with every trust boundary as a `subgraph` |
| `adr` | [`adr.md`](../templates/docs/adr.md) (MADR-style) | architect | `jobs/<J>/adr-NNN-<title>.md` | Mermaid architecture diagram: C4-style `flowchart`/`graph` or `C4Context`/`C4Container`…; optional `sequenceDiagram` for the key flow |
| `no-adr` | [`no-adr.md`](../templates/docs/no-adr.md) | architect, when there is one obvious way | `jobs/<J>/no-adr.md` | optional |
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
- **Guidance comments** (`<!-- … -->`) explain each section; `<!-- rule: … -->` comments are what the check enforces: `optional`, `table`, `acs` (every contract criterion id appears), `threats` (every `TH-n` of the threat model appears), `mermaid <types>` (a well-formed block of one of these diagram types), `subgraph` (that block draws a boundary). The template is the single source of truth: change a template's rules and the check follows.
- **IDs carry through**: `AC-n` from the contract, `TH-n` from the threat model, `T-n`/`S-n` from the plan, `L-n` for lessons, finding ids from review.
- **Versioning**: bump `@N` in a template's front matter when a change would make old docs fail; the check compares against the current version.

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
- **Ground** and **ship**: the CLI renders findings, the completion report and the index from sealed state, so they always match their templates; the same build renders the same report.

## Why it pays off later

The docs form one traceable chain: **contract** (what, `AC-n`) → **findings** (cited facts) → **threat model** (`TH-n`) → **ADR** (decision, diagram, AC table, threat mapping, rollback) → **plan** (tasks own `AC-n`) → **evidence** (ledger) → **completion report** (AC → proof, what changed, risk, rollback) → **lessons** (rule, scope, why). `docs-index.md` puts the chain for each criterion on one row. Months later, `grep -l "doc: adr" -r .factory/jobs` finds every decision, the diagram shows the shape the team agreed on, and the report says how it was proven and how to undo it.
