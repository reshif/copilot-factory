'use strict';
// Clarify v3 acceptance suite (docs/DESIGN-CLARIFY-v3.md, "Acceptance suite"). Each scenario
// of the clarify study's simulation (clarify-study/simulation.md: a–e) plus a J-0002-shaped job
// runs end to end on the real CLI and `factory run clarify`, with a crew that reads the briefs
// it is given and keeps the real agents' habits (tests/helpers/clarify3-crew.js). The pass
// criteria are the simulation's:
//   - J-0001: all four points of the user's denial met; the user's version honoured;
//   - no item vanishes; contradictions are surfaced, not approved;
//   - failures are shown; a vague request ends in measurable criteria or explicit questions;
//   - degraded runs park.
// It also measures what each user turn costs in agent calls.
// CLARIFY_ACCEPTANCE_REPORT=<file> writes a JSON summary of every scenario.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { drive } = require('./helpers/clarify3-drive');

const REPORT = {};
const report = (name, rec, extra = {}) => {
  REPORT[name] = {
    end: rec.end && rec.end.action,
    gates: rec.h1.length,
    parks: rec.parks.length,
    user_turns: rec.turns.length - 1,
    agent_calls: rec.calls.length,
    turns: rec.turns.map((t) => ({ said: String(t.said).slice(0, 90), at: t.at_stage, calls: t.calls })),
    ...extra,
  };
  if (process.env.CLARIFY_ACCEPTANCE_REPORT) fs.writeFileSync(process.env.CLARIFY_ACCEPTANCE_REPORT, JSON.stringify(REPORT, null, 2));
};
const quiet = { log: process.env.CLARIFY_ACCEPTANCE_VERBOSE ? (m) => process.stderr.write(`${m}\n`) : () => {} };

// Every item has a visible disposition: final, and either covered by the contract or listed in
// one of the CLI-owned sections the H1 view shows.
function noVanished(rec) {
  const L = rec.ledger;
  const out = [];
  for (const it of L.items) {
    if (['open', 'to_decide'].includes(it.status)) out.push(`${it.id} (${it.text}) is still ${it.status}`);
    // dropped only with a visible reason, and never something the user said
    if (it.status === 'dropped' && !(it.history || []).some((h) => /dropped/.test(h.event))) out.push(`${it.id} was dropped with no reason`);
    if (it.status === 'dropped' && it.strength === 'user') out.push(`${it.id} (${it.text}) is the user's and was dropped`);
    if (it.kind === 'intent' || it.status === 'dropped') continue; // the Intent section; history
    const shown = (it.covered && it.covered.where) || it.superseded || rec.contract.includes(it.text.slice(0, 30)) || (it.value && rec.contract.includes(String(it.value).slice(0, 30)));
    if (!shown) out.push(`${it.id} (${it.text}) is not in the contract`);
  }
  return out;
}

// ---------------------------------------------------------------- (a) J-0001
const DENY = 'research official Nautobot 2.4 docs for VLAN scoping (VLAN locations, VLANGroup, Tenant) and recommend a model for 6 tenants with their own locations; make AC-3 match within that scope so it does not contradict AC-8; decide how device credentials are supplied; base the test approach on Nautobot 2.4, not 3.x';

const A = {
  crew: 'a',
  title: 'Nautobot VLAN sync from Cisco devices',
  request: 'Nautobot job that syncs VLANs from our Cisco devices into Nautobot. cisco ios iosxe nxos only, nothing else; sync all vlans, reserved ones too. We run Nautobot 2.4.x. We have 6 tenants, each with their own locations; VLANs must not leak between tenants.',
  repo: {
    'pyproject.toml': '[tool.poetry]\nname = "nautobot-jobs"\nversion = "0.3.0"\n\n[tool.poetry.dependencies]\npython = ">=3.9,<3.13"\nnautobot = ">=2.0,<4.0"\nnetmiko = "^4.3"\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8.0"\n',
    'jobs/__init__.py': 'from nautobot.core.celery import register_jobs\n\nfrom .interface_audit import InterfaceAudit\n\nregister_jobs(InterfaceAudit)\n',
    'jobs/interface_audit.py': 'from nautobot.apps.jobs import Job, MultiObjectVar\nfrom nautobot.dcim.models import Device\n\n\nclass InterfaceAudit(Job):\n    devices = MultiObjectVar(model=Device)\n',
    'tests/test_interface_audit.py': 'def test_placeholder():\n    assert True\n',
    'README.md': '# nautobot-jobs\n\nJobs for our Nautobot, loaded as a Git repository.\n',
  },
  // the user's checks at H1: the four points of their real denial
  checks({ contract, view }) {
    const L = view;
    const items = L.items;
    const ev = Object.fromEntries(L.evidence.map((e) => [e.id, e]));
    const scoping = items.find((x) => x.kind === 'decision' && /scoping model/i.test(x.text));
    const creds = items.find((x) => x.kind === 'decision' && /credential/i.test(x.text));
    const cited = items.flatMap((x) => (x.status === 'decided' || x.status === 'assumed') && x.strength === 'evidence' ? x.evidence || [] : []);
    return {
      scoping_researched: Boolean(scoping && scoping.status === 'decided' && (scoping.evidence || []).some((id) => ev[id] && ev[id].verdict === 'pinned' && /v2\.4/.test(ev[id].source)) && scoping.recommendation && /VLAN Group/.test(contract)),
      ac3_scoped: /- AC-3:[^\n]*(VLAN Group|scope)/i.test(contract) && !/- AC-3:[^\n]*gets the device's name/.test(contract),
      credentials_decided: Boolean(creds && creds.status === 'decided' && /Secrets Group/i.test(contract.replace(/- AC-7:[^\n]*/, ''))),
      // the Research gaps section names the skipped 3.x pages on purpose: nothing else may
      no_3x_docs: !/\/stable\//.test(contract.replace(/## Research gaps[\s\S]*?(?=\n## |$)/, '')) && cited.every((id) => ev[id] && ['pinned', 'repo'].includes(ev[id].verdict)) && L.evidence.filter((e) => /\/stable\//.test(e.source)).every((e) => e.verdict !== 'pinned'),
    };
  },
  gate(n, g) {
    const c = A.checks(g);
    const missing = Object.keys(c).filter((k) => !c[k]);
    return missing.length && n <= 3 ? { deny: DENY, missing } : { approve: true, missing };
  },
};

test('(a) J-0001 replay: the four denial points are met, 2.4.x is honoured, the denial is tracked clause by clause', () => {
  const rec = drive({ ...A, sheet: (s, v, n) => require('./helpers/clarify3-crew').SCENARIOS.a.sheet(s, v, n) }, quiet);
  const first = rec.h1[0];
  const last = rec.h1[rec.h1.length - 1];
  const c1 = A.checks(first);
  const c2 = A.checks(last);
  report('a', rec, { first_h1: c1, final_h1: c2 });
  assert.equal(rec.end.action, 'approved', JSON.stringify(rec.end));
  // the read-back quoted the user's version and used it as the pin; the repo range is no pin
  assert.match(rec.screens[0].screen, /We run Nautobot 2\.4\.x/);
  const pins = rec.ledger.items.filter((x) => x.kind === 'pin' && x.status === 'decided');
  assert.deepEqual(pins.map((p) => [p.system, p.value, p.strength]), [['nautobot', '2.4.x', 'user']]);
  // the first H1 already met three points on its own (research before asking, pins, the readiness check)
  assert.deepEqual(c1, { scoping_researched: true, ac3_scoped: true, credentials_decided: false, no_3x_docs: true }, 'v3 only lacked what the interviewer forgot');
  // God Eye's blocker on the rename rule went back to the writer, never into a note
  assert.ok(rec.ledger.checks.some((k) => (k.objections || []).some((o) => o.severity === 'blocker' && o.ref === 'AC-3' && o.stage === 'assemble')), 'the AC-3 contradiction was a blocker');
  // after the denial: every point met
  assert.deepEqual(c2, { scoping_researched: true, ac3_scoped: true, credentials_decided: true, no_3x_docs: true });
  assert.equal(rec.h1.length, 2);
  // the denial: read back, four clauses tracked, each reported done at the next H1
  const R = rec.ledger.redirects;
  assert.equal(R.length, 1);
  assert.equal(R[0].clauses.length, 4);
  assert.ok(rec.screens.some((s) => s.stage === 'redirect_wait' && /credentials/i.test(s.screen)), 'the redirect was read back before work restarted');
  const shown = last.h1.redirects[0];
  assert.deepEqual(shown.clauses.map((x) => x.done), [true, true, true, true], JSON.stringify(shown));
  // 3.x pages were never used to confirm anything
  assert.ok(rec.ledger.evidence.filter((e) => /\/stable\//.test(e.source)).every((e) => e.verdict === 'other_version' || e.verdict === 'unpinned'));
  assert.ok(last.h1.skipped.some((k) => /\/stable\//.test(k.source)), 'the skipped 3.x pages stay visible at H1');
  assert.deepEqual(last.h1.gaps, [], 'every gap was closed by the redirect: nothing is left unresearched');
  assert.deepEqual(noVanished(rec), []);
  // what each turn cost: the read-back is shown, not waited on (0.9.0), so the request alone runs
  // the read-back and research; the first screen is the sheet, with the read-back on top
  assert.deepEqual([...rec.turns[0].calls].sort(), ['brief-writer', 'interviewer', 'researcher', 'researcher'], 'the request runs the read-back and research without a turn in between');
  assert.ok(!rec.turns.some((t) => t.at_stage === 'readback_wait'), 'no read-back turn: nothing on it needed the user');
  assert.match(rec.screens[0].screen, /^\*\*Decisions[^\n]*\n\n\*\*What I understood/, 'the sheet opens with the read-back');
  const sheet1 = rec.turns.find((t) => t.at_stage === 'sheet_wait');
  assert.ok(sheet1.calls.every((r) => ['contract-writer', 'god-eye'].includes(r)) && sheet1.calls.length <= 4, `sheet reply: ${sheet1.calls}`);
  const deny = rec.turns.find((t) => t.at_stage === 'H1' && /^deny/.test(t.said));
  assert.deepEqual(deny.calls, ['interviewer'], 'a denial costs one call before it is read back');
  assert.ok(rec.turns.length - 1 <= 7, `${rec.turns.length - 1} user turns`);
});

// ---------------------------------------------------------------- (b) repo facts
const B = {
  crew: 'b',
  title: 'Add rate limiting to the Flask API',
  request: 'add rate limiting to our Flask API: 100 requests per minute per API key, the admin key gets 1000; all of /api/v1 except /health',
  repo: {
    'requirements.txt': 'Flask==2.3.3\nredis==5.0.1\ngunicorn==21.2.0\npytest==8.1.1\n',
    'gunicorn.conf.py': 'bind = "0.0.0.0:8000"\nworkers = 4\ntimeout = 30\n',
    'app/__init__.py': 'from flask import Flask\n\nfrom .config import Config\n\n\ndef create_app(config=Config):\n    app = Flask(__name__)\n    app.config.from_object(config)\n    from .api.routes import api\n    app.register_blueprint(api, url_prefix="/api/v1")\n    return app\n',
    'app/config.py': 'import os\n\n\nclass Config:\n    REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")\n    API_KEYS_TABLE = "api_keys"\n',
    'app/auth.py': 'from functools import wraps\nfrom flask import request, abort\n\n\ndef require_api_key(f):\n    @wraps(f)\n    def inner(*a, **k):\n        key = request.headers.get("X-API-Key")\n        if not key:\n            abort(401)\n        return f(*a, **k)\n    return inner\n',
    'app/api/routes.py': 'from flask import Blueprint, jsonify\n\napi = Blueprint("api", __name__)\n\n\n@api.get("/health")\ndef health():\n    return jsonify(ok=True)\n',
    'tests/test_api.py': 'def test_health():\n    assert True\n',
  },
  sheet: () => "whatever's standard",
  gate: () => ({ approve: true }),
};

test('(b) repo facts settle from the repo; the limits become testable criteria; free prose on the sheet counts', () => {
  const rec = drive(B, quiet);
  report('b', rec);
  assert.equal(rec.end.action, 'approved');
  assert.equal(rec.h1.length, 1);
  const repoEv = rec.ledger.evidence.filter((e) => e.verdict === 'repo');
  assert.ok(repoEv.length >= 3, 'repo quotes checked at their lines');
  for (const it of rec.ledger.items.filter((x) => x.kind === 'fact' && x.tag === 'repo')) assert.equal(it.strength, 'evidence', `${it.text} settled by the repo`);
  // the user's numbers are user-stated and in testable criteria with a verify command
  const stated = rec.ledger.items.filter((x) => x.strength === 'user' && x.kind === 'fact');
  assert.ok(stated.some((x) => /100 requests/.test(x.text)) && stated.some((x) => /1000/.test(x.text)));
  assert.match(rec.contract, /- AC-\d+: the 101st request[^\n]*\(evidence: test\)/);
  assert.match(rec.contract, /- AC-\d+: the admin key[^\n]*1000[^\n]*\(evidence: test\)/);
  // "whatever's standard": the interviewer mapped it, quoting the user; the recommendations were taken
  const dec = rec.ledger.items.filter((x) => x.kind === 'decision');
  assert.ok(dec.length >= 2 && dec.every((d) => d.status === 'decided' && d.strength === 'accepted'), JSON.stringify(dec.map((d) => [d.text, d.status, d.strength])));
  assert.ok(dec.every((d) => (d.history || []).some((h) => /whatever's standard/.test(h.text || ''))), 'each decision records the words that decided it');
  assert.deepEqual(noVanished(rec), []);
  const sheet = rec.turns.find((t) => t.at_stage === 'sheet_wait');
  assert.deepEqual(sheet.calls, ['interviewer', 'contract-writer', 'god-eye'], 'plain prose costs one interpret call, then the writer and God Eye');
});

// ---------------------------------------------------------------- (c) vague
const C = {
  crew: 'c',
  title: 'Make the sync faster',
  request: 'make the sync faster',
  repo: {
    'requirements.txt': 'requests==2.31.0\npynautobot==2.1.1\n',
    'sync/__init__.py': '',
    'sync/runner.py': 'from .fetch import fetch_all\nfrom .push import push_all\n\n\ndef main():\n    data = fetch_all()\n    push_all(data)\n',
    'sync/fetch.py': 'import requests\n\nfrom .inventory import devices\n\n\ndef fetch_all():\n    out = []\n    for d in devices():\n        out.append(requests.get(f"https://{d}/api/inventory", timeout=30).json())\n    return out\n',
    'sync/push.py': 'import pynautobot\n\n\ndef push_all(data):\n    nb = pynautobot.api("https://nautobot.example", token="x")\n    for item in data:\n        nb.dcim.devices.update([item])\n',
    'tests/test_runner.py': 'def test_import():\n    import sync.runner  # noqa\n',
  },
  readbackReply: (n) => require('./helpers/clarify3-crew').SCENARIOS.c.readbackReply(n),
  sheet: () => 'ok',
  gate: () => ({ approve: true }),
};

test('(c) a vague request: explicit questions first, then measurable criteria with a runnable verify', () => {
  const rec = drive(C, quiet);
  report('c', rec);
  assert.equal(rec.end.action, 'approved');
  const first = rec.screens[0].screen;
  assert.match(first, /Which sync do you mean/);
  assert.match(first, /How long does it take today/);
  // God Eye's "not measurable" went back to the writer, which fixed it
  assert.ok(rec.ledger.checks.some((k) => (k.objections || []).some((o) => o.check === 'acs_testable' && o.severity === 'blocker')));
  assert.doesNotMatch(rec.contract, /faster than today/);
  assert.match(rec.contract, /- AC-1:[^\n]*under 30 minutes[^\n]*\(evidence: test\)/);
  assert.match(rec.contract, /`python -m pytest -q` \(AC-1/);
  assert.doesNotMatch(rec.contract, /^The sync runs faster\.$/m);
  assert.deepEqual(noVanished(rec), []);
});

// ---------------------------------------------------------------- (d) contradictions
const D = {
  crew: 'd',
  title: 'Use Argon2 for password hashing',
  request: "switch our Django password hashing to Argon2. We're on Django 4.2 and Argon2 is already the default there, so no migration needed; just make sure it's enforced",
  repo: {
    'requirements.txt': 'Django==3.2.25\npsycopg2-binary==2.9.9\npytest-django==4.8.0\n',
    'portal/settings.py': 'SECRET_KEY = "dev"\nINSTALLED_APPS = ["django.contrib.auth", "accounts"]\n',
    'accounts/__init__.py': '',
    'tests/test_auth.py': 'def test_ok():\n    assert True\n',
  },
  readbackReply: () => 'ok',
  sheet: () => 'ok',
  gate: () => ({ approve: true }),
};

test('(d) the user contradicts the repo and the docs: both conflicts are surfaced, neither is approved silently', () => {
  const rec = drive(D, quiet);
  report('d', rec);
  assert.equal(rec.end.action, 'approved');
  // the version conflict is on the read-back, with the repo's version recommended
  const rb = rec.screens.find((s) => s.stage === 'readback_wait').screen;
  assert.match(rb, /Django 4\.2/);
  assert.match(rb, /3\.2\.25/);
  assert.match(rb, /conflict|disagree/i);
  const pin = rec.ledger.items.find((x) => x.kind === 'pin' && x.status === 'decided');
  assert.equal(pin.value, '3.2.25');
  assert.ok(rec.ledger.evidence.every((e) => !/\/4\.2\//.test(e.source)), 'research used the confirmed version');
  // "Argon2 is already the default" against Django 3.2's docs: a decision on the sheet
  const sheet = rec.screens.find((s) => s.stage === 'sheet_wait').screen;
  assert.match(sheet, /You said[^\n]*Argon2 is already the default/i);
  assert.match(sheet, /PBKDF2/);
  const contra = rec.ledger.items.find((x) => x.kind === 'decision' && /default/i.test(x.text));
  assert.ok(contra && contra.status === 'decided');
  // H1 shows how the user's own statements came out
  const checked = rec.h1[0].h1.checked;
  assert.ok(checked.some((c) => /Argon2 is already the default/.test(c.quote) && !c.ok), JSON.stringify(checked));
  assert.ok(checked.some((c) => /Django 4\.2/.test(c.quote) && !c.ok));
  assert.doesNotMatch(rec.contract, /Django 4\.2/);
  assert.deepEqual(noVanished(rec), []);
});

// ---------------------------------------------------------------- (e) agents fail
test('(e1) the interviewer times out twice: the run parks with the failure named, nothing pretends', () => {
  const rec = drive({ ...B, crew: 'e1', crewOpts: { timeout_sleep_ms: 9000 }, policy: { clarify: { agent_seconds: { interviewer: 6 } } } }, quiet);
  report('e1', rec);
  assert.equal(rec.end.action, 'parked');
  assert.match(rec.end.reason, /interviewer/);
  assert.match(rec.end.reason, /timed out/);
  assert.equal(rec.agentRuns.filter((r) => r.role === 'interviewer').length, 2, 'one attempt and one retry');
  assert.ok(rec.agentRuns.every((r) => r.outcome === 'timeout'));
  assert.equal(rec.ledger.stage, 'readback');
  assert.ok(rec.final.failures.some((f) => /interviewer/.test(f.what) && /timed out/.test(f.reason)));
});

test('(e2) the web is down: every docs item says so on the sheet, in the contract and at H1', () => {
  const rec = drive({ ...B, crew: 'e2', sheet: () => 'ok' }, quiet);
  report('e2', rec);
  assert.equal(rec.end.action, 'approved');
  const sheet = rec.screens.find((s) => s.stage === 'sheet_wait').screen;
  assert.match(sheet, /web (is )?unavailable|no network/i);
  assert.match(sheet, /not researched/i);
  assert.match(rec.contract, /## Research gaps[\s\S]*no network/);
  assert.ok(rec.h1[0].h1.gaps.length >= 1);
  const lib = rec.ledger.items.find((x) => x.kind === 'decision' && /library/i.test(x.text));
  assert.equal(lib.researched, false);
  assert.ok(rec.ledger.items.every((x) => !(x.tag === 'docs' && x.strength === 'evidence')), 'nothing from the docs counts as evidence');
});

test('(e3) God Eye blocks with no fix and never moves: the loop engine escalates, diagnoses, then H1 shows the objection open, never a park', () => {
  const rec = drive({ ...B, crew: 'e3', sheet: () => 'ok', onPark: () => null }, quiet);
  report('e3', rec);
  assert.equal(rec.parks.length, 0, 'no park: H1 is the gate');
  const writers = rec.calls.filter((c) => c.agent === 'factory:contract-writer');
  // the first version, two rounds on the writer's own model, one on the stronger model, one with the diagnosis's approach
  assert.equal(writers.length, 5, writers.map((c) => c.model || 'default').join(', '));
  assert.deepEqual(writers.map((c) => c.model || null), [null, null, null, 'claude-opus-5.5', 'claude-opus-5.5'], 'the escalated rounds run on the stronger model, the first ones on the session default');
  assert.equal(rec.calls.filter((c) => c.agent === 'factory:finding-verifier').length, 1, 'the disputed objection got one tie-break');
  assert.equal(rec.agentRuns.filter((r) => r.label === 'diagnosis').length, 1, 'one diagnosis before the loop ended');
  assert.equal(rec.end.action, 'approved');
  const h1 = rec.h1[0].h1;
  assert.ok(h1.objections.some((o) => o.severity === 'blocker' && o.open && /sharper/.test(o.issue)), JSON.stringify(h1.objections));
  assert.equal(h1.loop_end.rule, 'no_progress');
  assert.match(h1.screen, /The readiness loop ended[\s\S]*Diagnosis: The same objection came back/);
  assert.ok(!/approved with notes/i.test(JSON.stringify(h1)));
  assert.ok(!rec.ledger.parked);
});

test('(e4) the docs researcher times out: one more pass, then the gap is on the sheet and at H1', () => {
  const rec = drive({ ...B, crew: 'e4', sheet: () => 'ok', crewOpts: { timeout_sleep_ms: 9000 }, policy: { clarify: { research_minutes: { medium: 0.1 } } } }, quiet);
  report('e4', rec);
  assert.equal(rec.end.action, 'approved');
  assert.equal(rec.ledger.research.passes.length, 2, 'a timeout earns one more pass');
  const sheet = rec.screens.find((s) => s.stage === 'sheet_wait').screen;
  assert.match(sheet, /timed out/);
  assert.ok(rec.h1[0].h1.gaps.some((g) => /timed out/.test(g.reason)));
  const lib = rec.ledger.items.find((x) => x.kind === 'decision' && /library/i.test(x.text));
  assert.equal(lib.researched, false);
});

test('(e5) every agent fails every time and nobody steps in: the job parks after one retry, names the agent, and never loops', () => {
  const rec = drive({ ...B, crew: 'e5', onPark: (n) => (n === 1 ? 'resume' : null) }, quiet);
  report('e5', rec);
  assert.equal(rec.end.action, 'parked');
  assert.equal(rec.parks.length, 2, 'parked, resumed once by the user, parked again');
  for (const p of rec.parks) assert.match(p, /The interviewer failed twice at the readback stage \(failed/);
  assert.equal(rec.agentRuns.length, 4, 'two attempts per run, one run per park: bounded');
  assert.ok(rec.agentRuns.every((r) => r.outcome === 'failed'));
  assert.equal(rec.ledger.stage, 'readback', 'nothing moved on without an agent');
});

test('(e6) the brief writer fails in both passes: no park; the decisions go on unresearched and the gap is named on the sheet and at H1', () => {
  const rec = drive({ ...B, crew: 'e6', sheet: () => 'ok', onPark: () => null }, quiet);
  report('e6', rec);
  assert.equal(rec.parks.length, 0);
  assert.equal(rec.ledger.research.passes.length, 2);
  assert.ok(rec.h1.length >= 1, JSON.stringify(rec.end));
  assert.ok(rec.h1[0].h1.gaps.some((g) => /brief writer/.test(g.reason)), JSON.stringify(rec.h1[0].h1.gaps));
});

// ---------------------------------------------------------------- J-0002's shape
test('(j) J-0002 shape: many decisions in at most two sheets, free-form answers count, nothing asked twice', () => {
  const rec = drive({
    crew: 'j',
    title: 'Sync interface VLANs from NX-OS and IOS-XE',
    request: 'Nautobot job to sync interface VLAN assignments (access VLAN, trunk allowed VLANs, native VLAN) from Cisco NX-OS and IOS-XE switches into Nautobot interfaces. Nautobot 2.4.x.',
    repo: { 'jobs/__init__.py': 'from nautobot.core.celery import register_jobs\n', 'tests/test_x.py': 'def test_x():\n    assert True\n' },
    sheet: (s, v, n) => require('./helpers/clarify3-crew').SCENARIOS.j.sheet(s, v, n),
    gate: () => ({ approve: true }),
  }, quiet);
  report('j', rec);
  assert.equal(rec.end.action, 'approved');
  const sheets = rec.screens.filter((s) => s.stage === 'sheet_wait');
  assert.equal(sheets.length, 2);
  const asked = rec.ledger.sheets.flatMap((s) => s.decisions.map((d) => d.item));
  assert.equal(new Set(asked).size, asked.length, 'no decision asked twice');
  assert.ok(rec.ledger.sheets.every((s) => s.decisions.length <= 5));
  const free = rec.ledger.items.filter((x) => x.kind === 'decision' && x.strength === 'user');
  assert.ok(free.length >= 3 && free.some((x) => x.value === 'trunk ports too, both modes'), 'free-form answers are kept verbatim');
  assert.ok(rec.h1[0].h1.gaps.some((g) => /404/.test(g.reason)));
  assert.ok(rec.h1[0].h1.design_may_choose.some((d) => /NX-OS/.test(d)));
  assert.ok(rec.turns.length - 1 <= 5, `${rec.turns.length - 1} user turns`);
  assert.deepEqual(noVanished(rec), []);
});
