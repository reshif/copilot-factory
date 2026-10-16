---
doc: no-adr
template: no-adr@2
job: {{J-0000}}
title: {{What is being done}}
status: accepted   # accepted | superseded
date: {{YYYY-MM-DD}}
contract: contract.md
related: [findings.md]   # add threat-model.md when there is one
---
<!--
  Software Factory · no-ADR note template no-adr@2 ("design depth", factory 0.11).
  Use it when there is one obvious way to meet the contract. Keep the front matter
  (template: no-adr@2 is the version marker the check reads) and the "##" headings in
  order; replace every {{…}}. The human still sees where every file goes (Project layout)
  and how it runs. Check before you return:
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

## Flow
<!-- rule: optional -->
<!-- Optional: a sequenceDiagram (or flowchart) of the touched path, with its failure branch,
     when the order of things matters. Any mermaid block must be well formed. -->

## Project layout
<!-- rule: layout -->
<!-- Required. Every file that will exist after the job and matters to it, in one fenced
     text block: one file per line, then "# status · responsibility · ACs" (status: new | changed |
     existing | deleted). Every AC must be served by at least one file; the planner turns the
     tree into tasks and `factory plan validate` checks every new, changed or deleted file has
     exactly one owner task. -->
```text
{{src}}/
└── {{file}}.js        # changed · {{what it does}} · AC-1
tests/
└── {{file}}.test.js   # changed · {{what it proves}} · AC-1
```

## How it runs
<!-- rule: runs -->
<!-- The entry point, where it is registered (if anywhere) and the commands that test it,
     each in `code`. -->
- Test: `{{verify command}}`

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

## Rollback
<!-- How to undo it once merged. -->
{{Rollback}}
