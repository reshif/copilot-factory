---
doc: no-adr
template: no-adr@1
job: {{J-0000}}
title: {{What is being done}}
status: accepted   # accepted | superseded
date: {{YYYY-MM-DD}}
contract: contract.md
related: [findings.md]   # add threat-model.md when there is one
---
<!--
  Software Factory · no-ADR note template no-adr@1.
  Use it when there is one obvious way to meet the contract. Keep the front matter
  and the "##" headings in order; replace every {{…}}. A diagram is optional here,
  but any mermaid block you add must be well formed. Check before you return:
      factory doc check <this file> --job <J>
-->

# No ADR: {{What is being done}}

## Why no decision is needed
<!-- Why there is only one viable way: cite the findings, and say in a line each why
     the other options the generators proposed are not real alternatives here. -->
{{Reason}}

## Approach
<!-- What will be done, concretely enough for a planner: files, functions, data shapes. -->
{{Approach}}

## How each acceptance criterion is met
<!-- rule: table; acs -->
| AC | How the approach meets it | Proof |
|---|---|---|
| AC-1 | {{…}} | test: `{{verify command}}` |

## Threat mitigations
<!-- rule: optional; threats -->
<!-- Only when there is a threat model: one row per threat (TH-1…) and its mitigation. -->
| Threat | Mitigation | Where |
|---|---|---|
| {{TH-1}} | {{…}} | {{…}} |

## Diagram
<!-- rule: optional -->
<!-- Optional: a small flowchart of the touched path if it helps the reviewer. -->

## Rollback
<!-- How to undo it once merged. -->
{{Rollback}}
