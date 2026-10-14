---
doc: threat-model
template: threat-model@1
job: {{J-0000}}
title: {{What changes, in a few words}}
status: draft   # draft | reviewed
date: {{YYYY-MM-DD}}
contract: contract.md
related: [findings.md]
---
<!--
  Software Factory · threat model template threat-model@1 (STRIDE).
  Written before the design is decided; the ADR maps every threat id (TH-1…) to a
  mitigation. Keep the front matter and the "##" headings in order; replace every
  {{…}}. Check before you return:
      factory doc check <this file> --job <J>
-->

# Threat model: {{What changes, in a few words}}

## Scope and assets
<!-- rule: table -->
<!-- What the change touches and what is worth protecting: data, credentials, money,
     availability, integrity. One row per asset. -->
| Asset | Why it matters | Where it lives |
|---|---|---|
| {{Asset}} | {{confidentiality / integrity / availability}} | {{file, store, service}} |

## Data-flow diagram
<!-- rule: mermaid flowchart|graph; subgraph -->
<!-- Required. How data moves through what this change touches. Draw every trust
     boundary as a subgraph (internet, service, data tier, third party…), label every
     edge with the data that crosses it, and give each process and store a short id
     the threats below can refer to. -->
```mermaid
flowchart LR
  user([{{External actor}}])
  subgraph internet["Trust boundary: internet"]
    user
  end
  subgraph svc["Trust boundary: {{service}}"]
    entry[{{Entry point}}] -->|{{validated input}}| proc[{{Process}}]
    proc -->|{{query}}| db[({{Data store}})]
  end
  user -->|{{untrusted request}}| entry
  proc -->|{{outbound call}}| ext[{{Third party}}]
```

## Entry points and trust boundaries
<!-- rule: table -->
<!-- Every place untrusted input or a less-trusted caller crosses into the change. -->
| Entry point | Crosses | Who can reach it | Authn / authz |
|---|---|---|---|
| {{route / CLI / queue}} | {{boundary}} | {{anyone / signed-in / internal}} | {{…}} |

## Threats (STRIDE)
<!-- rule: table -->
<!-- One row per credible threat, ids TH-1, TH-2… STRIDE = Spoofing, Tampering,
     Repudiation, Information disclosure, Denial of service, Elevation of privilege.
     Likelihood and impact: low | medium | high. The mitigation must be something
     the design can include and a test or review can check. -->
| ID | STRIDE | Threat | Entry point / asset | Likelihood | Impact | Mitigation the design must include |
|---|---|---|---|---|---|---|
| TH-1 | {{Spoofing}} | {{…}} | {{…}} | {{medium}} | {{high}} | {{…}} |

## Out of scope
<!-- Threats and components deliberately not covered, and why. -->
- {{…}}

## Residual risk
<!-- rule: optional -->
<!-- Optional: what stays risky after the mitigations, and who accepts it. -->
