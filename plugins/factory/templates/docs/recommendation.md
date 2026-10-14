---
doc: recommendation
template: recommendation@1
job: {{J-0000}}
title: {{The question in a few words}}
status: proposed   # proposed | accepted | rejected
date: {{YYYY-MM-DD}}
contract: contract.md
related: [findings.md]
---
<!--
  Software Factory · spike recommendation template recommendation@1.
  A spike answers a question; it does not ship code. Keep the front matter and the
  "##" headings in order; replace every {{…}}. Check before you return:
      factory doc check <this file> --job <J>
-->

# Recommendation: {{The question in a few words}}

## Question
<!-- The research question from the contract, and why it matters now. -->
{{Question}}

## Options weighed
<!-- rule: table -->
<!-- One row per candidate answer, with the measurements or facts that separate them.
     Cite sources in the cells or under "Evidence". -->
| # | Option | {{Criterion 1}} | {{Criterion 2}} | Verdict |
|---|---|---|---|---|
| 1 | {{Option}} | {{…}} | {{…}} | recommended |
| 2 | {{Option}} | {{…}} | {{…}} | not recommended: {{why}} |

## Recommendation
<!-- One paragraph: what to do, and the conditions it assumes. -->
{{Recommendation}}

## Confidence
<!-- low | medium | high, and the one or two facts the confidence rests on. -->
{{medium}} — {{why}}

## What would change it
<!-- The observations that would flip the recommendation, so the next person knows
     when to revisit it. -->
- {{Observation → which option would then win}}

## Evidence
<!-- Every measurement and fact used above, cited: file:line, a command and its output,
     or a URL. Mark anything unsourced UNVERIFIED. -->
- {{Claim}} — `{{source}}`

## Diagram
<!-- rule: optional -->
<!-- Optional: a flowchart or sequenceDiagram of the recommended shape. -->

## Next steps
<!-- rule: optional -->
<!-- Optional: the follow-up job(s) this recommendation implies. -->
