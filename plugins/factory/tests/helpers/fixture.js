'use strict';
// Test fixtures: a throwaway git repo with a tiny project, and helpers that drive the
// real CLI binary and play the parts agents and the human would play.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN = path.resolve(__dirname, '..', '..');
const BIN = path.join(PLUGIN, 'bin', 'factory');

function sh(cwd, cmd) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
  sh(root, 'git init -q -b main && git config user.email t@example.com && git config user.name Tester && git config commit.gpgsign false');
  write(root, 'src/add.js', "module.exports = (a, b) => a - b; // bug: should add\n");
  write(root, 'tests/add.test.js', "const add = require('../src/add');\nif (add(2, 3) !== 5) { console.error('add(2,3) =', add(2, 3)); process.exit(1); }\nconsole.log('ok');\n");
  write(root, 'README.md', '# tiny\n');
  sh(root, 'git add -A && git commit -qm init');
  const out = cli(root, ['init']);
  if (out.error) throw new Error(JSON.stringify(out));
  return root;
}

function cli(root, args, { allowFail = true } = {}) {
  const r = spawnSync('node', [BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '' } });
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = { raw: r.stdout, stderr: r.stderr };
  }
  if (!allowFail && r.status !== 0) throw new Error(`factory ${args.join(' ')} failed: ${r.stdout}${r.stderr}`);
  return Object.assign(json, { __code: r.status });
}

function reply(root, text) {
  const human = require('../../cli/core/human');
  const parsed = human.parseReply(text);
  if (!parsed) throw new Error(`not a reply: ${text}`);
  return human.applyReply(root, parsed, 'chat');
}

const INTENT = [
  '- Problem: add(2, 3) returns -1, so totals built on it are wrong',
  '- Who: callers of src/add.js (the cart totals)',
  '- Outcome: add returns the arithmetic sum',
  '- Why now: a user reported a wrong total',
  '- Success signal: tests/add.test.js passes',
].join('\n');

// intent: null leaves the section out (a contract from before the Intent section).
function contractText({ goal = 'add(a, b) returns the sum of a and b for all numbers.', allowed = ['src/**', 'tests/**'], verify = '`node tests/add.test.js` (AC-1)', ac = '- AC-1: add(2, 3) returns 5 (evidence: test)', intent = INTENT } = {}) {
  return `# Fix add
${intent === null ? '' : `
## Intent
${intent}
`}
## Goal
${goal}

## Non-goals
- Changing the module's export shape

## Acceptance criteria
${ac}

## Constraints
- No new dependencies

## Allowed paths
${allowed.map((a) => `- ${a}`).join('\n')}

## Verify commands
- ${verify}

## Assumptions
- Node is available
`;
}

// Design docs that follow templates/docs (what an architect or threat modeler writes).
function front(doc, job, title, status, related = ['findings.md']) {
  return `---\ndoc: ${doc}\ntemplate: ${doc}@1\njob: ${job}\ntitle: ${title}\nstatus: ${status}\ndate: 2026-01-01\ncontract: contract.md\nrelated: [${related.join(', ')}]\n---\n`;
}
const DIAGRAM = '```mermaid\nflowchart LR\n  caller([Caller]) -->|add(a, b)| add\n  subgraph repo["tiny — this repository"]\n    add[src/add.js] -->|sum| caller2[tests/add.test.js]\n  end\n```\n';
function adrText({ job, title = 'Fix add in place', acs = ['AC-1'], threats = [], diagram = DIAGRAM, decision = 'We will fix the operator in src/add.js.' } = {}) {
  return `${front('adr', job, title, 'proposed')}
# ADR 001: ${title}

## Context
add subtracts instead of adding (findings · codebase · src/add.js:1).

## Decision drivers
- AC-1 must hold without changing the export shape.

## Considered options
| # | Option | Pros | Cons | Verdict |
|---|---|---|---|---|
| 1 | Fix the operator | One line | None | chosen |
| 2 | Rewrite the module | — | Larger change | rejected: out of scope |

## Decision
${decision}

## Architecture diagram
${diagram}
## Consequences
- Positive: callers get sums.

## How each acceptance criterion is met
| AC | How | Proof |
|---|---|---|
${acs.map((a) => `| ${a} | operator fixed | test: \`node tests/add.test.js\` |`).join('\n')}

## Threat mitigations
${threats.length ? `| Threat | Mitigation | Where |\n|---|---|---|\n${threats.map((t) => `| ${t} | validated input | src/add.js |`).join('\n')}` : 'No threat model at this risk.'}

## Rollback and migration
Revert the merge commit; no data changes.

## Open questions
None.
`;
}
function noAdrText({ job, acs = ['AC-1'] } = {}) {
  return `${front('no-adr', job, 'Fix the operator', 'accepted')}
# No ADR: Fix the operator

## Why no decision is needed
One viable fix.

## Approach
Change - to + in src/add.js.

## How each acceptance criterion is met
| AC | How | Proof |
|---|---|---|
${acs.map((a) => `| ${a} | operator fixed | test |`).join('\n')}

## Rollback
Revert the merge commit.
`;
}
function threatModelText({ job, ids = ['TH-1'] } = {}) {
  return `${front('threat-model', job, 'add', 'draft')}
# Threat model: add

## Scope and assets
| Asset | Why it matters | Where it lives |
|---|---|---|
| Sums | integrity | src/add.js |

## Data-flow diagram
\`\`\`mermaid
flowchart LR
  subgraph caller["Trust boundary: caller"]
    c([Caller])
  end
  subgraph lib["Trust boundary: library"]
    add[add]
  end
  c -->|numbers| add
\`\`\`

## Entry points and trust boundaries
| Entry point | Crosses | Who can reach it | Authn / authz |
|---|---|---|---|
| add(a, b) | caller → library | any caller | none |

## Threats (STRIDE)
| ID | STRIDE | Threat | Entry point / asset | Likelihood | Impact | Mitigation the design must include |
|---|---|---|---|---|---|---|
${ids.map((id) => `| ${id} | Tampering | Non-numbers concatenate | add(a, b) | low | medium | Coerce or reject non-numbers |`).join('\n')}

## Out of scope
- Callers' own input handling.
`;
}
function recommendationText({ job } = {}) {
  return `${front('recommendation', job, 'Which approach', 'proposed')}
# Recommendation: Which approach

## Question
A or B?

## Options weighed
| # | Option | Cost | Verdict |
|---|---|---|---|
| 1 | A | low | recommended |
| 2 | B | high | not recommended: cost |

## Recommendation
Use A.

## Confidence
medium — one measurement.

## What would change it
- A second instance → B.

## Evidence
- A is cheaper — \`bench.txt\`
`;
}
function contractsDocText({ job } = {}) {
  return `${front('contracts', job, 'Big epic', 'proposed', ['contracts.json'])}
# Contracts: Big epic

## Interfaces to freeze
| Interface | Kind | Version | Owner slice | Consumers |
|---|---|---|---|---|
| add | function | v1 | S01 | S02 |

## Interface details
### add
add(a: number, b: number): number

## Compatibility and versioning
Additive changes only.

## Feature flag
None: the change is additive.

## Change procedure
Amend the epic and bump the version.
`;
}

function envelope(brief, status, data, extra = {}) {
  return {
    workflow: brief.workflow,
    config: brief.config || null,
    mode: brief.mode || null,
    job: brief.job,
    status,
    next_gate: null,
    input_hash: brief.input_hash,
    budgets: { used: { agent_runs: 3 } },
    artifacts: [],
    questions: [],
    park_reason: null,
    summary: 'test',
    data,
    ...extra,
  };
}

function record(root, env) {
  const f = path.join(root, '.factory', 'scratch', `env-${Date.now()}-${Math.floor(performance.now())}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(env));
  return cli(root, ['record', '--file', f]);
}

function jobDir(root, id) {
  return path.join(root, '.factory', 'jobs', id);
}

module.exports = { PLUGIN, BIN, sh, write, makeRepo, cli, reply, contractText, envelope, record, jobDir, adrText, noAdrText, threatModelText, recommendationText, contractsDocText, DIAGRAM };
