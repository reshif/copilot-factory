---
doc: contracts
template: contracts@1
job: {{J-0000}}
title: {{Epic title}}
status: proposed   # proposed | frozen | superseded
date: {{YYYY-MM-DD}}
contract: contract.md
related: [adr-001-{{title}}.md, contracts.json]
---
<!--
  Software Factory · epic contracts template contracts@1.
  The interfaces slice S00 freezes before any other slice starts. contracts.json is
  the machine-readable list of the same interfaces (name, kind, owner, version); keep
  the two in step. Keep the front matter and the "##" headings in order; replace
  every {{…}}. Check before you return:
      factory doc check <this file> --job <J>
-->

# Contracts: {{Epic title}}

## Interfaces to freeze
<!-- rule: table -->
<!-- One row per interface. Kind: http, function, event, schema, cli, config.
     Owner: the slice that implements it. Consumers: the slices that call it. -->
| Interface | Kind | Version | Owner slice | Consumers |
|---|---|---|---|---|
| {{name}} | {{http}} | {{v1}} | {{S01}} | {{S02, S03}} |

## Interface details
<!-- One "###" subsection per interface: signature or schema, errors, limits,
     examples. Precise enough that two slices can build against it independently. -->
### {{name}}
{{Signature, request/response or schema, errors}}

## Interface map
<!-- rule: optional -->
<!-- Optional but recommended: a flowchart of which slice owns and which consumes
     each interface. -->

## Compatibility and versioning
<!-- What may change without a version bump, what may not, and how old callers keep
     working while slices land one by one. -->
{{…}}

## Feature flag
<!-- The flag S00 adds, its default, and which slice turns it on. "None" with a reason
     if the epic is safe without one. -->
{{flag name — default off — turned on by S0n}}

## Change procedure
<!-- How a frozen interface changes later: an amendment on the epic, a version bump,
     and which slices must re-verify. -->
{{…}}
