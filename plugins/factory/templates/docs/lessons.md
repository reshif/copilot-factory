---
doc: lessons
template: lessons@1
job: project
title: Lessons register
status: current
date: {{YYYY-MM-DD}}
contract: none
related: [lessons.json]
---
<!--
  Software Factory · lessons register template lessons@1.
  Rendered by the CLI from .factory/lessons/lessons.json every time a lesson is added,
  accepted, rejected or promoted; agents do not edit it. Each lesson is a card with the
  same four parts, so a reader (or a reviewer checking "lesson:<id>") sees the rule,
  where it applies, why it exists and how it is checked.
-->

# Lessons register

## Summary
<!-- rule: table -->
| Lesson | Status | Scope | Source job | Rule |
|---|---|---|---|---|
| {{L1}} | {{accepted}} | {{src/api/**}} | {{J-0001}} | {{one-line rule}} |

## Lessons
<!-- One "###" card per lesson, newest last:
       ### L1 — accepted
       - Rule: one or two sentences, general and checkable, in the project's terms.
       - Scope: the globs it applies to.
       - Why: the confirmed finding or failure it came from (job, finding id).
       - Check: the command that enforces it once promoted, or "review".
       - Decided: when and why it was accepted or rejected. -->
### {{L1}} — {{accepted}}
- Rule: {{…}}
- Scope: {{…}}
- Why: {{…}}
- Check: {{review}}
- Decided: {{…}}
