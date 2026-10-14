---
doc: findings
template: findings@1
job: {{J-0000}}
title: {{Job title}}
status: grounded   # grounded | blocked (blocking unknowns still unanswered)
date: {{YYYY-MM-DD}}
contract: contract.md
related: []
---
<!--
  Software Factory · findings template findings@1.
  Written by the CLI (`factory record` after the ground workflow) from the
  researchers' cited claims; agents do not edit it. Every claim carries a source
  (file:line, a command and its output, or a URL) or is marked UNVERIFIED.
-->

# Findings — {{J-0000}}: {{Job title}}

## Summary
<!-- rule: table -->
Every claim is cited (file:line, command, or URL) or marked UNVERIFIED.

| Topic | Claims | Unverified | Unknowns | Blocking |
|---|---|---|---|---|
| {{codebase}} | {{3}} | {{0}} | {{1}} | {{0}} |

## Topics
<!-- One "###" subsection per research topic, in the order the topics ran. -->
### {{codebase}}
- {{Claim}} — `{{source}}`

## Unknowns
<!-- Every unknown the researchers raised; blocking ones are marked and say whether
     the human has answered them. -->
- {{(blocking) [topic] question — answered / unanswered}}

## Answers from the human
<!-- Answers recorded with `factory answer` before this grounding ran. -->
- Q: {{question}} — A: {{answer}}
