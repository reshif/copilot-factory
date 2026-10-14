---
doc: intent-findings
template: intent-findings@1
job: {{J-0000}}
title: {{Job title}}
status: grounded   # grounded | open (questions still unanswered) | degraded (part of the research could not run)
date: {{YYYY-MM-DD}}
contract: contract.md
related: [intent-evidence.json]
---
<!--
  Software Factory · intent findings template intent-findings@1.
  Written by the CLI (`factory record` after each clarify round, and after a
  "change A-n" / "drop A-n" reply) from jobs/<J>/intent-evidence.json; agents do not
  edit it. Research comes before questions: every claim here has a source (file:line
  or URL), an exact quote, and a verdict from the verifier or the CLI's own check.
-->

# Intent findings — {{J-0000}}: {{Job title}}

## Summary
<!-- rule: table -->
Research came first: repo and world unknowns were researched within the risk budget, high-impact and web findings re-checked, and only what research could not settle is asked.

| Unknowns | Researched | Evidence | Confirmed | Assumptions | Questions open | Web research |
|---|---|---|---|---|---|---|
| {{6}} | {{4}} | {{5}} | {{3}} | {{3}} | {{2}} | {{on}} |

## What we found
<!-- rule: table -->
<!-- One row per finding (E-n): the claim, its source (file:line or URL), the source tier
     (official · primary · standard · secondary · forum · repo), when it was retrieved,
     the version it applies to, the scout's confidence and the verdict
     (confirmed · contradicted · unverified · unchecked). -->
| Evidence | Unknown | Claim | Source | Tier | Retrieved | Version | Confidence | Verdict |
|---|---|---|---|---|---|---|---|---|
| {{E-1}} | {{U-1}} | {{claim}} | {{source}} | {{official}} | {{2026-01-01}} | {{v2}} | {{high}} | {{confirmed}} |

## What we are assuming
<!-- The evidence-backed assumptions (A-n) the CLI writes into the contract under
     "## Assumptions (evidence-backed)"; the human overrides one with "change A-n <value>"
     or removes it with "drop A-n". Low-impact unknowns are listed as assumed, not researched. -->
- {{A-1: statement (evidence: E-1)}}

## What only you can answer
<!-- User and decision unknowns, and researchable ones research could not settle (with why). -->
- {{U-3 [user, high] question — asked as Q-1}}

## Unknowns
<!-- rule: table -->
| Unknown | Kind | Impact | Resolution | Evidence | Note |
|---|---|---|---|---|---|
| {{U-1 text}} | {{repo}} | {{high}} | {{assumption (A-1)}} | {{E-1}} | {{—}} |

## Research log
<!-- Per clarify round: whether the unknowns were mapped, which scouts ran and how they
     came back, verifiers, what degraded; the versions the research was done against. -->
- {{Round 1: mapped the unknowns; 2 scout(s), 1 verifier(s)}}
