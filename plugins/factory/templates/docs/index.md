---
doc: index
template: index@1
job: {{J-0000}}
title: {{Job title}}
status: current
date: {{YYYY-MM-DD}}
contract: contract.md
related: []
---
<!--
  Software Factory · per-job docs index template index@1.
  Rendered by the CLI (`factory doc index`, and by `factory ship`) into the job folder
  as docs-index.md. It is the map from the contract to everything that followed:
  contract → findings → design record → plan → evidence → completion report → lessons.
-->

# Docs index — {{J-0000}}: {{Job title}}

## Documents
<!-- rule: table -->
<!-- Every document of the job, in pipeline order, with its template check. -->
| Document | Type | Template | Status | Check |
|---|---|---|---|---|
| {{contract.md}} | {{contract}} | {{—}} | {{approved H1}} | {{ok}} |

## Traceability
<!-- rule: table; acs -->
<!-- One row per acceptance criterion: where the design addresses it, which tasks
     build it, and how it was proven. -->
| AC | Design | Tasks | Proof |
|---|---|---|---|
| AC-1 | {{adr-001 · How each acceptance criterion is met}} | {{T1}} | {{proven: …}} |

## Changelog
<!-- The job's recorded steps in order (from the sealed ledger). -->
| When | Step | Result |
|---|---|---|
| {{2026-01-01T00:00}} | {{clarify}} | {{ok}} |
