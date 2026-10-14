---
doc: ship-report
template: ship-report@1
job: {{J-0000}}
title: {{Job title}}
status: ready   # ready | shipped
date: {{YYYY-MM-DD}}
contract: contract.md
related: [{{design record}}, plan.json, docs-index.md]
fingerprint: {{build fingerprint}}
---
<!--
  Software Factory · completion report / PR body template ship-report@1.
  Rendered by the CLI (`factory report`, `factory ship`) from sealed state only, so the
  same build always renders the same report. It is the PR body.
-->

# Completion report — {{J-0000}}: {{Job title}}

## Summary
<!-- Goal from the contract, work type, risk, recipe, base and branch, fingerprint. -->
{{Goal}}

- Work type: {{feature}} · Risk: {{medium}} · Recipe: {{standard}} v{{1}}
- Base: {{main}} @ {{commit}} · Branch: {{factory/J-0000}}
- Build fingerprint: {{fingerprint}}

## What changed
<!-- rule: table -->
<!-- Every file the job branch changes against its base (git diff --name-status). -->
| Status | File |
|---|---|
| {{M}} | {{src/file.js}} |

## Acceptance criteria → evidence
<!-- rule: table; acs -->
| AC | Status | Proof |
|---|---|---|
| AC-1 {{text}} | {{proven}} | {{evidence}} |

## Design record
<!-- The design documents this build implements, by type and path. -->
- {{adr}}: {{adr-001-title.md}}

## Risk
<!-- Risk level, threat model, confirmed and non-blocking review findings. -->
- Risk level: {{medium}}

## Rollout and rollback
<!-- How it goes out and how to undo it: the merge, CI re-verify, and each task's
     rollback from plan.json. -->
- Rollout: {{…}}
- Rollback: {{…}}

## Floors
<!-- rule: table -->
| Floor | Met |
|---|---|
| {{floor}} | {{yes}} |

## Approvals
<!-- rule: table -->
| Gate | Hash | When | Via |
|---|---|---|---|
| {{H1}} | {{hash}} | {{when}} | {{chat}} |

## Review
<!-- Lane verdicts at this build, then non-blocking and dismissed findings. -->
{{…}}

## Path taken
<!-- The routing decisions in order, then the budget used. -->
{{clarify → H1 → …}}
