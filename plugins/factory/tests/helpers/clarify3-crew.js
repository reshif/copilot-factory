'use strict';
// A scripted crew for clarify v3 (FAKE_COPILOT_SCRIPT=clarify3-crew.js): each role reads the
// brief the factory actually gave it (the CLARIFY INPUT block of its run file, and for the
// brief writer the researchers' replies under INPUTS) and answers like the real agents did on
// J-0001 and in the clarify study's simulation, including their habits:
//   - a docs researcher that also cites /en/stable/ pages (they document Nautobot 3.x);
//   - an interviewer that forgets device credentials;
//   - a contract writer whose first draft keeps the old rename rule next to the user's answer;
//   - agents that time out, a web that is down, a God Eye whose objection has no fix.
// CREW (JSON) picks the scenario and its knobs: { "scenario": "a", ... }.

const fs = require('fs');
const path = require('path');

const crew = () => {
  try {
    return JSON.parse(process.env.CREW || '{}');
  } catch {
    return {};
  }
};

// The text the agent was given: its prompt, the run file, and the brief files it points at.
function given(c) {
  const nested = (t) => String(t || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/') && l.endsWith('.md') && fs.existsSync(l)).map((l) => fs.readFileSync(l, 'utf8')).join('\n');
  return `${c.prompt || ''}\n${c.instructions || ''}\n${nested(c.instructions)}\n${nested(c.prompt)}`;
}

// The first balanced JSON value after a marker.
function grab(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) return null;
  let j = i + marker.length;
  while (j < text.length && text[j] !== '{' && text[j] !== '[') j++;
  const open = text[j];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  for (let k = j; k < text.length; k++) {
    const ch = text[k];
    if (inStr) {
      if (ch === '\\') k++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      try {
        return JSON.parse(text.slice(j, k + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// How many times this role (and label) ran before, from the fake's own log.
function earlier(c, pred) {
  const f = process.env.FAKE_COPILOT_LOG;
  if (!f || !fs.existsSync(f)) return 0;
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter(pred).length;
}

const has = (list, re) => (list || []).find((x) => re.test(`${x.what || ''} ${x.text || ''}`));
const sleepy = (json, ms = 30) => ({ json, sleep_ms: ms });

// ---------------------------------------------------------------- docs pages (scenario a)
const NB = 'https://docs.nautobot.com/projects/core/en';
const PAGES = {
  vlangroup24: { source: `${NB}/v2.4.x/user-guide/core-data-model/ipam/vlangroup/`, version: '2.4.x', claim: 'In Nautobot 2.4 a VLAN Group can be assigned to a Location, and a VLAN ID is unique within its VLAN Group', quote: 'A VLAN group may be assigned to a location. Each VLAN ID must be unique within its group.' },
  vlan24: { source: `${NB}/v2.4.x/user-guide/core-data-model/ipam/vlan/`, version: '2.4.x', claim: 'In Nautobot 2.4 a VLAN may be assigned to a tenant and to a VLAN Group', quote: 'Each VLAN may be assigned to a tenant and to a VLAN group.' },
  vlanStable: { source: `${NB}/stable/user-guide/core-data-model/ipam/vlan/`, version: '3.0', claim: 'A VLAN can be assigned to several Locations at once', quote: 'VLANs can be associated with multiple locations.' },
  testsStable: { source: `${NB}/stable/development/jobs/testing/`, version: '3.2', claim: 'Job tests pass job_kwargs to run_job_for_testing', quote: 'run_job_for_testing(job, **job_kwargs)' },
  tests24: { source: `${NB}/v2.4.x/development/jobs/testing/`, version: '2.4.x', claim: 'Nautobot 2.4 job tests subclass nautobot.apps.testing.TransactionTestCase and run the job with run_job_for_testing', quote: 'from nautobot.apps.testing import TransactionTestCase, run_job_for_testing' },
  secrets24: { source: `${NB}/v2.4.x/user-guide/platform-functionality/secret/`, version: '2.4.x', claim: 'In Nautobot 2.4 a Secrets Group assigned to a device supplies its username and password to jobs', quote: 'A secrets group associates secrets, such as a username and a password, with an object such as a device.' },
};
const ev = (plan, p, tier = 'official') => ({ plan, claim: p.claim, source: p.source, source_tier: tier, quote: p.quote, system: 'nautobot', version: p.version, retrieved_at: '2026-10-15', confidence: 'high' });

// ---------------------------------------------------------------- the scenarios
// Each returns { readback, redirect, interpret, repo, docs, brief, writer, check } handlers;
// a handler gets (input, ctx) and returns the reply.
const S = {};

// (a) J-0001: Nautobot VLAN sync from Cisco devices.
S.a = {
  readback(inp) {
    return {
      intent: { problem: 'VLANs configured on the Cisco switches are not in Nautobot; engineers add them by hand', who: 'the network engineers who use Nautobot as the source of truth', outcome: 'a Nautobot Job reads the VLANs of chosen devices and creates or updates them in Nautobot, and reports what changed', success: 'after a run, Nautobot lists every VLAN configured on the selected devices' },
      scope: { in: ['create and update VLANs from chosen devices', 'a dry run'], out: ['pushing configuration to devices', 'deleting VLANs'] },
      took: [
        { item: 'new', text: 'Only Cisco IOS, IOS-XE and NX-OS devices', quote: 'cisco ios iosxe nxos only, nothing else' },
        { item: 'new', text: 'Every VLAN is synced, reserved ones included', quote: 'sync all vlans, reserved ones too' },
        { item: 'new', text: '6 tenants, each with its own locations', quote: 'We have 6 tenants, each with their own locations' },
        { item: 'new', text: 'VLANs must not leak between tenants', quote: 'VLANs must not leak between tenants' },
      ],
      pins: [
        { system: 'nautobot', version: '2.4.x', source: 'user', quote: 'We run Nautobot 2.4.x' },
        { system: 'nautobot', version: '>=2.0,<4.0', source: 'repo', file: 'pyproject.toml:7', quote: 'nautobot = ">=2.0,<4.0"' },
      ],
      // the habit: credentials are not on the plan (J-0001 lost them too)
      plan: [
        { item: 'new', what: 'How Nautobot 2.4 scopes a VLAN: Location, VLAN Group, Tenant', tag: 'docs', pins: ['nautobot'], impact: 'high', why: 'The scoping model decides what counts as the same VLAN.' },
        { item: 'new', what: 'How this repo registers and tests its jobs', tag: 'repo', pins: [], impact: 'medium', why: 'The job must load the way the existing ones do.' },
        { item: 'new', what: 'How Nautobot 2.4 job tests are written', tag: 'docs', pins: ['nautobot'], impact: 'medium', why: 'The tests must run against 2.4.' },
        { item: 'new', what: 'The VLAN scoping model for 6 tenants with their own locations', tag: 'decision', pins: ['nautobot'], impact: 'high', why: 'Every create and match depends on it.' },
        { item: 'new', what: "What happens when a device's VLAN name differs from Nautobot's", tag: 'decision', pins: [], impact: 'high', why: 'Renaming can overwrite another location\'s VLAN.' },
      ],
      questions: [],
      design_may_choose: ['The connection library (Netmiko or NAPALM)', 'Parallelism', 'Enable mode'],
    };
  },
  redirect(inp) {
    const text = inp.redirect.text;
    const items = inp.items || [];
    const id = (re) => (items.find((x) => re.test(x.text)) || {}).id || 'new';
    const clauses = [];
    for (const part of text.split(/;\s*/)) {
      if (/scoping/i.test(part)) clauses.push({ quote: part, item: id(/scoping model/i), action: 'research', text: 'Research the 2.4 VLAN scoping docs and recommend a model for 6 tenants with their own locations', tag: 'docs' });
      else if (/AC-3/.test(part)) clauses.push({ quote: part, item: 'new', action: 'fix', text: 'AC-3 matches within the scope so it does not contradict AC-8', tag: null });
      else if (/credential/i.test(part)) clauses.push({ quote: part, item: 'new', action: 'decide', text: 'How the job gets device credentials', tag: 'docs' });
      else if (/test approach/i.test(part)) clauses.push({ quote: part, item: id(/job tests/i), action: 'research', text: 'The test approach rests on Nautobot 2.4 docs, not 3.x', tag: 'docs' });
    }
    return { clauses };
  },
  repo(inp) {
    const p = has(inp.plan, /registers and tests/);
    return { mode: 'repo', versions: [{ name: 'nautobot', version: '>=2.0,<4.0', source: 'pyproject.toml:7' }], evidence: p ? [
      { plan: p.id, claim: 'Jobs are registered in jobs/__init__.py with register_jobs', source: 'jobs/__init__.py:1', source_tier: 'repo', quote: 'from nautobot.core.celery import register_jobs', confidence: 'high' },
      { plan: p.id, claim: 'The tests run with pytest', source: 'pyproject.toml:11', source_tier: 'repo', quote: 'pytest = "^8.0"', confidence: 'high' },
    ] : [], unresolved: [], failed_sources: [] };
  },
  docs(inp) {
    const out = [];
    const unresolved = [];
    const avoid = new Set((inp.avoid || []).map((a) => a.source));
    for (const p of inp.plan) {
      const t = `${p.what}`;
      if (/scop/i.test(t)) {
        out.push(ev(p.id, PAGES.vlangroup24), ev(p.id, PAGES.vlan24));
        if (!avoid.has(PAGES.vlanStable.source)) out.push(ev(p.id, PAGES.vlanStable)); // the habit
      } else if (/test/i.test(t)) out.push(ev(p.id, avoid.has(PAGES.testsStable.source) ? PAGES.tests24 : PAGES.testsStable));
      else if (/credential/i.test(t)) out.push(ev(p.id, PAGES.secrets24));
      else unresolved.push({ plan: p.id, reason: 'a preference: no documentation decides it' });
    }
    return sleepy({ mode: 'docs', web_available: true, versions: [], evidence: out, unresolved, failed_sources: [] });
  },
  brief(inp, ctx) {
    const ev2 = ctx.evidence;
    const src = (planId) => ev2.filter((e) => e.plan === planId).map((e) => e.source);
    const scopeDocs = has(inp.plan, /scopes a VLAN/);
    const records = [];
    const facts = [];
    const gaps = [];
    for (const p of inp.plan) {
      if (p.tag === 'decision' && /scoping model/i.test(p.what)) {
        records.push({ plan: p.id, decision: p.what, options: [{ key: 'a', text: "A VLAN Group per Location; the VLAN's tenant is the device's tenant", consequences: 'the same VLAN ID in two locations is two VLANs' }, { key: 'b', text: 'One VLAN Group per tenant', consequences: 'locations of one tenant share VLAN IDs' }, { key: 'c', text: 'Global VLANs with only the tenant set', consequences: 'IDs collide across locations' }], evidence: [...src(p.id), ...(scopeDocs ? src(scopeDocs.id) : [])], recommendation: 'a', why: 'In 2.4 a VLAN ID is unique within its VLAN Group, and a group can belong to a Location.' });
      } else if (p.tag === 'decision' && /name differs/i.test(p.what)) {
        records.push({ plan: p.id, decision: p.what, options: [{ key: 'a', text: "The device's name wins, and the change is reported", consequences: 'Nautobot follows the devices' }, { key: 'b', text: 'Report it, never rename', consequences: 'a human fixes names' }], evidence: [], recommendation: 'a', why: 'The devices are the source of truth for VLAN names.' });
      } else if (p.tag === 'decision' && /credential/i.test(p.what)) {
        records.push({ plan: p.id, decision: p.what, options: [{ key: 'a', text: "The device's Secrets Group (username and password secrets)", consequences: 'per-device credentials, none in code' }, { key: 'b', text: 'One Secrets Group chosen when the job runs', consequences: 'one credential for every device' }], evidence: src(p.id), recommendation: 'a', why: 'Nautobot 2.4 jobs read device credentials through Secrets Groups.' });
      } else if (p.tag !== 'decision') {
        const s = ev2.filter((e) => e.plan === p.id);
        if (s.length) facts.push({ plan: p.id, statement: s[0].claim, evidence: s.map((e) => e.source) });
        else gaps.push({ plan: p.id, why: 'nothing found' });
      }
    }
    return { summary: 'Nautobot 2.4 scopes VLANs by VLAN Group; jobs register in jobs/__init__.py.', records, facts, gaps };
  },
  writer(inp) {
    const items = inp.items || [];
    const val = (re) => ((items.find((x) => re.test(x.text)) || {}).value) || '';
    const blocked = (inp.blockers || []).some((b) => /AC-3/.test(`${b.ref} ${b.issue}`)) || (inp.instructions || []).some((x) => /AC-3/.test(x.text));
    const naming = val(/name differs/i);
    const creds = val(/credential/i);
    const ac3 = blocked || !/overwrite/i.test(naming)
      ? "- AC-3: within the same VLAN Group (the device's Location) and tenant, a VLAN whose name differs from the device's is logged as an inconsistency and left unchanged (evidence: test)"
      : "- AC-3: an existing VLAN with a different name gets the device's name; a matching one is left alone (evidence: test)";
    const text = `# Nautobot VLAN sync from Cisco devices

## Intent
- Problem: ${inp.intent.problem}
- Who: ${inp.intent.who}
- Outcome: ${inp.intent.outcome}
- Success signal: ${inp.intent.success}

## Goal
Engineers run a Nautobot 2.4 Job against chosen Cisco devices; the devices' VLANs are created in Nautobot in the VLAN Group of the device's Location with the device's tenant; nothing is deleted.

## Non-goals
- Pushing VLAN configuration to devices
- Deleting VLANs from Nautobot

## Acceptance criteria
- AC-1: the job appears in Nautobot; the user picks devices and a dry-run flag (evidence: test)
- AC-2: every VLAN missing from the device's Location VLAN Group is created with the device's tenant, reserved VLANs 1 and 1002-1005 included (evidence: test)
${ac3}
- AC-4: a dry run writes nothing (evidence: test)
- AC-5: an unreachable device is logged as failed and the job carries on (evidence: test)
- AC-6: the job ends with created, unchanged, inconsistent and failed counts (evidence: test)
- AC-7: the README covers install, platforms, credentials and how to run it (evidence: doc)
- AC-8: the same VLAN ID with different names across locations or tenants is logged as an inconsistency, not silently overwritten (evidence: test)

## Constraints
- Cisco IOS, IOS-XE and NX-OS only
- Nautobot 2.4.x; tests use the Nautobot 2.4 test APIs
- VLANs never leak between tenants
- No credentials in code or logs${creds ? "\n- Device credentials come only from the device's Secrets Group" : ''}
- The job deletes nothing

## Allowed paths
- jobs/**
- tests/**
- README.md

## Verify commands
- \`python -m pytest tests -q\` (AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-8)

## Assumptions
- Devices are reachable over SSH from the Nautobot worker
`;
    const where = (x) => (/AC-3/.test(x.text) ? 'AC-3' : /platform|IOS/i.test(x.text) ? 'Constraints' : /reserved|every VLAN/i.test(x.text) ? 'AC-2' : /leak|tenant/i.test(x.text) ? 'Constraints' : /scop/i.test(x.text) ? 'AC-2' : /name differs|AC-3/i.test(x.text) ? 'AC-3' : /credential/i.test(x.text) ? (creds ? 'Constraints' : 'AC-7') : /test/i.test(x.text) ? 'Constraints' : /regist/i.test(x.text) ? 'Allowed paths' : /nautobot/i.test(x.text) ? 'Constraints' : 'Goal');
    return { contract: text, covers: items.map((x) => ({ item: x.id, where: where(x) })), uncovered: [] };
  },
  check(inp, ctx) {
    const text = ctx.contract;
    const items = inp.decisions || [];
    const naming = (items.find((x) => /name differs/i.test(x.text)) || {}).value || '';
    const objections = [];
    if (/AC-3:[^\n]*gets the device's name/.test(text) && /overwrite/i.test(naming)) {
      objections.push({ check: 'self_consistent', severity: 'blocker', stage: 'assemble', ref: 'AC-3', issue: "AC-3 renames a VLAN whose name differs, but the decision says log it and don't overwrite, and AC-8 says the same", fix: 'Match within the VLAN Group and tenant, log the difference, never overwrite' });
    }
    return verdict(objections);
  },
  sheet(screen, view, round) {
    // the user's real answer to the naming question, given on the sheet
    if (round === 1) {
      const n = view.sheet.decisions.find((d) => /name differs/i.test(d.question));
      return n ? `ok, but ${n.no}: use the device's name, but if the same VLAN ID has different names in different places, log it, don't overwrite` : 'ok';
    }
    return 'ok';
  },
};

// (b) "add rate limiting to our Flask API": the unknowns are repo facts.
S.b = {
  readback() {
    return {
      intent: { problem: 'a few API clients send bursts that slow the API for everyone', who: 'the platform team that runs the API', outcome: 'each API key is limited to a fair rate; others are unaffected', success: 'a key over its limit gets HTTP 429 while other keys keep normal latency' },
      scope: { in: ['rate limits per API key on /api/v1', 'configurable limits'], out: ['billing or quota reports'] },
      took: [
        { item: 'new', text: '100 requests per minute per API key', quote: '100 requests per minute per API key' },
        { item: 'new', text: 'The admin key gets 1000 requests per minute', quote: 'the admin key gets 1000' },
        { item: 'new', text: 'All of /api/v1 except /health', quote: 'all of /api/v1 except /health' },
      ],
      pins: [{ system: 'flask', version: '2.3.3', source: 'repo', file: 'requirements.txt:1', quote: 'Flask==2.3.3' }, { system: 'redis', version: '5.0.1', source: 'repo', file: 'requirements.txt:2', quote: 'redis==5.0.1' }],
      plan: [
        { item: 'new', what: 'How a client is identified today', tag: 'repo', pins: [], impact: 'high' },
        { item: 'new', what: 'How many worker processes serve the API', tag: 'repo', pins: [], impact: 'high' },
        { item: 'new', what: 'Where the limit counters are kept', tag: 'decision', pins: ['flask'], impact: 'high' },
        { item: 'new', what: 'Which library enforces the limits', tag: 'decision', pins: ['flask'], impact: 'medium' },
      ],
      questions: [],
      design_may_choose: ['The decorator or middleware layout'],
    };
  },
  repo(inp) {
    const evd = [];
    for (const p of inp.plan) {
      if (/identified/i.test(p.what)) evd.push({ plan: p.id, claim: 'Clients send an X-API-Key header, checked by require_api_key', source: 'app/auth.py:8', source_tier: 'repo', quote: 'key = request.headers.get("X-API-Key")', confidence: 'high' });
      if (/worker/i.test(p.what)) evd.push({ plan: p.id, claim: 'gunicorn runs 4 worker processes', source: 'gunicorn.conf.py:2', source_tier: 'repo', quote: 'workers = 4', confidence: 'high' });
      if (/counters/i.test(p.what)) evd.push({ plan: p.id, claim: 'Redis is configured through REDIS_URL', source: 'app/config.py:5', source_tier: 'repo', quote: 'REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")', confidence: 'high' });
    }
    return { mode: 'repo', versions: [], evidence: evd, unresolved: [], failed_sources: [] };
  },
  docs(inp) {
    const p = has(inp.plan, /library/);
    return sleepy({ mode: 'docs', web_available: true, versions: [], evidence: p ? [{ plan: p.id, claim: 'Flask-Limiter keeps counters in a storage backend such as Redis, shared by all workers', source: 'https://flask-limiter.readthedocs.io/en/3.5.0/#configuration', source_tier: 'official', system: 'flask-limiter', quote: 'RATELIMIT_STORAGE_URI: a storage location such as redis://host:port', version: '3.5.0', retrieved_at: '2026-10-15', confidence: 'high' }] : [], unresolved: [], failed_sources: [] });
  },
  brief(inp, ctx) {
    const records = [];
    const facts = [];
    for (const p of inp.plan) {
      const src = ctx.evidence.filter((e) => e.plan === p.id);
      if (/counters/i.test(p.what)) records.push({ plan: p.id, decision: p.what, options: [{ key: 'a', text: 'Redis (already configured)', consequences: 'shared by the 4 workers' }, { key: 'b', text: 'In process memory', consequences: 'each worker counts alone: 4x the limit' }], evidence: src.map((e) => e.source), recommendation: 'a', why: '4 workers must share one count.' });
      else if (/library/i.test(p.what)) records.push({ plan: p.id, decision: p.what, options: [{ key: 'a', text: 'Flask-Limiter with Redis storage', consequences: 'a maintained library' }, { key: 'b', text: 'A small custom decorator', consequences: 'more code to own' }], evidence: src.map((e) => e.source), recommendation: 'a', why: 'It is the standard Flask extension and supports Redis.' });
      else if (src.length) facts.push({ plan: p.id, statement: src[0].claim, evidence: src.map((e) => e.source) });
    }
    return { summary: 'Keys arrive as X-API-Key; 4 workers need shared counters.', records, facts, gaps: [] };
  },
  interpret(inp) {
    // "whatever's standard": take the recommendations
    return { answers: inp.sheet.decisions.map((d) => ({ decision: d.no, choice: 'recommended', text: '', quote: inp.reply.text })), facts: [], unclear: [] };
  },
  writer(inp) {
    const text = `# Add rate limiting to the Flask API

## Intent
- Problem: ${inp.intent.problem}
- Who: ${inp.intent.who}
- Outcome: ${inp.intent.outcome}
- Success signal: ${inp.intent.success}

## Goal
Requests to /api/v1 (except /health) are limited per API key: 100 per minute, 1000 for the admin key; over the limit the API answers 429.

## Non-goals
- Billing or quota reporting

## Acceptance criteria
- AC-1: the 101st request within a minute from one API key gets HTTP 429 (evidence: test)
- AC-2: the admin key gets HTTP 429 only after 1000 requests in a minute (evidence: test)
- AC-3: /api/v1/health is never limited (evidence: test)
- AC-4: the limits are read from configuration, not code (evidence: test)

## Constraints
- No change to the public URL paths
- Counters are shared by all gunicorn workers (Redis)

## Allowed paths
- app/**
- tests/**
- requirements.txt

## Verify commands
- \`python -m pytest -q\` (AC-1, AC-2, AC-3, AC-4)

## Assumptions
- None
`;
    const where = (x) => (/1000|admin/i.test(x.text) ? 'AC-2' : /100 requests/i.test(x.text) ? 'AC-1' : /health/i.test(x.text) ? 'AC-3' : /counter|worker/i.test(x.text) ? 'Constraints' : /library/i.test(x.text) ? 'Constraints' : /identified/i.test(x.text) ? 'AC-1' : /flask|redis/i.test(x.text) ? 'Constraints' : 'Goal');
    return { contract: text, covers: (inp.items || []).map((x) => ({ item: x.id, where: where(x) })), uncovered: [] };
  },
  check: () => verdict([]),
  sheet: () => "whatever's standard",
};

// (c) "make the sync faster": a vague request.
S.c = {
  readback(inp) {
    const words = inp.words.map((w) => w.text).join('\n');
    if (!/nightly/.test(words)) {
      return {
        intent: { problem: 'the sync is slow', who: '(not known yet)', outcome: 'the sync is faster', success: '(not known yet)' },
        scope: { in: ['the sync code under sync/'], out: [] },
        took: [{ item: 'new', text: 'The sync should be faster', quote: 'make the sync faster' }],
        pins: [{ system: 'pynautobot', version: '2.1.1', source: 'repo', file: 'requirements.txt:2', quote: 'pynautobot==2.1.1' }],
        plan: [{ item: 'new', what: 'Where the sync spends its time', tag: 'repo', pins: [], impact: 'high' }],
        questions: [
          { item: 'new', question: 'Which sync do you mean, and who waits for it?', why: 'Two syncs live in sync/.' },
          { item: 'new', question: 'How long does it take today, and how fast must it be?', why: 'Without a target, "faster" cannot be tested.' },
        ],
        design_may_choose: [],
      };
    }
    const keep = (re) => (inp.items.find((x) => re.test(x.text)) || {}).id || 'new';
    return {
      intent: { problem: 'the nightly inventory sync runs into the morning', who: 'ops, who wait for it', outcome: 'the nightly sync finishes well before the morning', success: 'a full run takes under 30 minutes' },
      scope: { in: ['the nightly inventory sync (sync/)'], out: ['other jobs'] },
      took: [
        { item: keep(/faster/), text: 'The nightly inventory sync runs into the morning', quote: 'the nightly inventory sync, ops complains it runs into the morning' },
        { item: 'new', text: 'It takes about 2 hours today', quote: 'like 2 hours I think' },
        { item: 'new', text: 'Target: under 30 minutes', quote: 'ideally under 30 min' },
        { item: 'new', text: 'The devices are old: do not hammer them', quote: "devices are old, don't hammer them" },
      ],
      pins: [{ system: 'pynautobot', version: '2.1.1', source: 'repo', file: 'requirements.txt:2', quote: 'pynautobot==2.1.1' }],
      plan: [
        { item: keep(/spends its time/), what: 'Where the sync spends its time', tag: 'repo', pins: [], impact: 'high' },
        { item: 'new', what: 'How many devices may be fetched at once', tag: 'decision', pins: [], impact: 'high' },
      ],
      questions: [],
      design_may_choose: ['Threads or asyncio'],
    };
  },
  repo(inp) {
    const p = has(inp.plan, /spends its time/);
    return { mode: 'repo', versions: [], evidence: p ? [
      { plan: p.id, claim: 'fetch_all fetches one device at a time, each with a 30 s timeout', source: 'sync/fetch.py:9', source_tier: 'repo', quote: 'out.append(requests.get(f"https://{d}/api/inventory", timeout=30).json())', confidence: 'high' },
      { plan: p.id, claim: 'push_all updates Nautobot one item at a time', source: 'sync/push.py:7', source_tier: 'repo', quote: 'nb.dcim.devices.update([item])', confidence: 'high' },
    ] : [], unresolved: [], failed_sources: [] };
  },
  docs: (inp) => ({ mode: 'docs', web_available: true, versions: [], evidence: [], unresolved: inp.plan.map((p) => ({ plan: p.id, reason: 'no documentation needed' })), failed_sources: [] }),
  brief(inp, ctx) {
    const records = [];
    const facts = [];
    for (const p of inp.plan) {
      const src = ctx.evidence.filter((e) => e.plan === p.id);
      if (p.tag === 'decision') records.push({ plan: p.id, decision: p.what, options: [{ key: 'a', text: 'At most 8 devices at once, configurable', consequences: 'about 8x faster, gentle on old devices' }, { key: 'b', text: 'At most 32 at once', consequences: 'faster, risks overloading old devices' }], evidence: ctx.evidence.filter((e) => /fetch/.test(e.source)).map((e) => e.source), recommendation: 'a', why: "Fetching is sequential with 30 s timeouts; the user asked not to hammer old devices." });
      else if (src.length) facts.push({ plan: p.id, statement: src.map((e) => e.claim).join('; '), evidence: src.map((e) => e.source) });
    }
    return { summary: 'Both fetch and push are sequential.', records, facts, gaps: [] };
  },
  writer(inp) {
    const vague = !(inp.blockers || []).some((b) => /measur|testable|faster/i.test(`${b.issue} ${b.fix}`));
    const ac1 = vague ? '- AC-1: the sync completes faster than today (evidence: run)' : '- AC-1: with 200 simulated devices that each answer in 2 s, a full sync finishes in under 30 minutes of simulated time (evidence: test)';
    const text = `# Make the sync faster

## Intent
- Problem: ${inp.intent.problem}
- Who: ${inp.intent.who}
- Outcome: ${inp.intent.outcome}
- Success signal: ${inp.intent.success}

## Goal
The nightly inventory sync finishes in under 30 minutes without overloading the devices.

## Non-goals
- Other jobs

## Acceptance criteria
${ac1}
- AC-2: no more than the configured number of devices (default 8) is fetched at once (evidence: test)
- AC-3: Nautobot updates are batched, not sent one item at a time (evidence: test)

## Constraints
- At most 8 concurrent device requests by default (the devices are old)

## Allowed paths
- sync/**
- tests/**

## Verify commands
- \`python -m pytest -q\` (AC-1, AC-2, AC-3)

## Assumptions
- None
`;
    const where = (x) => (/30 min|target|2 hours|faster|morning/i.test(x.text) ? 'AC-1' : /hammer|at once|concurr/i.test(x.text) ? 'AC-2' : /spends/i.test(x.text) ? 'AC-3' : 'Goal');
    return { contract: text, covers: (inp.items || []).map((x) => ({ item: x.id, where: where(x) })), uncovered: [] };
  },
  check(inp, ctx) {
    if (/AC-1:[^\n]*faster than today/.test(ctx.contract)) return verdict([{ check: 'acs_testable', severity: 'blocker', stage: 'assemble', ref: 'AC-1', issue: '"faster than today" is not measurable and pytest cannot prove it', fix: 'State the measurable target (under 30 minutes) and how a test measures it' }]);
    return verdict([]);
  },
  readbackReply(n) {
    return n === 1 ? "the nightly inventory sync, ops complains it runs into the morning. it takes like 2 hours I think, ideally under 30 min. devices are old, don't hammer them" : 'ok';
  },
  sheet: () => 'ok',
};

// (d) the user's words contradict the repo and the docs.
S.d = {
  readback(inp) {
    const words = inp.words.map((w) => w.text).join('\n');
    return {
      intent: { problem: 'passwords are hashed with an algorithm security wants retired', who: 'the security team', outcome: 'new and changed passwords are hashed with Argon2', success: "a newly set password's stored hash starts with argon2" },
      scope: { in: ['password hashing'], out: ['password rules'] },
      took: [
        { item: 'new', text: 'Argon2 is already the default in Django 4.2', quote: 'Argon2 is already the default there' },
        { item: 'new', text: 'No migration is needed', quote: 'so no migration needed' },
      ],
      pins: [
        ...(/4\.2/.test(words) ? [{ system: 'django', version: '4.2', source: 'user', quote: "We're on Django 4.2" }] : []),
        { system: 'django', version: '3.2.25', source: 'repo', file: 'requirements.txt:1', quote: 'Django==3.2.25' },
      ],
      plan: [
        { item: 'new', what: "Django's default password hasher and how Argon2 is enabled", tag: 'docs', pins: ['django'], impact: 'high' },
        { item: 'new', what: 'How existing users keep logging in', tag: 'decision', pins: ['django'], impact: 'high' },
      ],
      questions: [],
      design_may_choose: [],
    };
  },
  repo: () => ({ mode: 'repo', versions: [{ name: 'django', version: '3.2.25', source: 'requirements.txt:1' }], evidence: [], unresolved: [], failed_sources: [] }),
  docs(inp) {
    const p = has(inp.plan, /default password hasher/);
    const q = has(inp.plan, /keep logging in/);
    const pin = (inp.pins.find((x) => x.system === 'django') || {}).version || '3.2';
    const v = /^3\.2/.test(pin) ? '3.2' : '4.2';
    const url = `https://docs.djangoproject.com/en/${v}/topics/auth/passwords/`;
    const evd = [];
    if (p) evd.push({ plan: p.id, system: 'django', claim: `In Django ${v} the default hasher is PBKDF2; Argon2 needs argon2-cffi and must be listed first in PASSWORD_HASHERS`, source: url, source_tier: 'official', quote: 'By default, Django uses the PBKDF2 algorithm', version: v, retrieved_at: '2026-10-15', confidence: 'high' });
    if (q) evd.push({ plan: q.id, system: 'django', claim: 'Django upgrades a stored hash to the first hasher in PASSWORD_HASHERS when the user logs in', source: url, source_tier: 'official', quote: 'Django will automatically upgrade the password when the user logs in', version: v, retrieved_at: '2026-10-15', confidence: 'high' });
    return { mode: 'docs', web_available: true, versions: [], evidence: evd, unresolved: [], failed_sources: [] };
  },
  brief(inp, ctx) {
    const records = [];
    const facts = [];
    const argon = (inp.stated || []).find((x) => /default/i.test(x.text));
    for (const p of inp.plan) {
      const src = ctx.evidence.filter((e) => e.plan === p.id);
      if (p.tag === 'decision') records.push({ plan: p.id, decision: p.what, options: [{ key: 'a', text: 'Keep PBKDF2 listed after Argon2 so old hashes are upgraded at login', consequences: 'no forced reset' }, { key: 'b', text: 'Force a password reset', consequences: 'users must reset' }], evidence: src.map((e) => e.source), recommendation: 'a', why: 'Django upgrades a hash at login.' });
      else if (src.length) facts.push({ plan: p.id, statement: src[0].claim, evidence: src.map((e) => e.source), ...(argon ? { contradicts: argon.id } : {}) });
    }
    return { summary: 'Django 3.2 hashes with PBKDF2 by default.', records, facts, gaps: [] };
  },
  writer(inp) {
    const contra = (inp.items || []).find((x) => /default/i.test(x.text) && x.kind === 'decision');
    const text = `# Use Argon2 for password hashing

## Intent
- Problem: ${inp.intent.problem}
- Who: ${inp.intent.who}
- Outcome: ${inp.intent.outcome}
- Success signal: ${inp.intent.success}

## Goal
New and changed passwords are hashed with Argon2 on Django 3.2; existing users still log in and their hashes are upgraded at login.

## Non-goals
- Changing password rules

## Acceptance criteria
- AC-1: a newly set password is stored as an Argon2 hash (evidence: test)
- AC-2: a user with a PBKDF2 hash can still log in, and their hash is upgraded to Argon2 (evidence: test)

## Constraints
- No forced password reset
- argon2-cffi is added and Argon2PasswordHasher is first in PASSWORD_HASHERS${contra ? '' : ''}

## Allowed paths
- portal/**
- accounts/**
- tests/**
- requirements.txt

## Verify commands
- \`python -m pytest -q\` (AC-1, AC-2)

## Assumptions
- None
`;
    const where = (x) => (/migration|logging in|old/i.test(x.text) ? 'AC-2' : /default|hasher|argon/i.test(x.text) ? 'Constraints' : /django/i.test(x.text) ? 'Goal' : 'Goal');
    return { contract: text, covers: (inp.items || []).map((x) => ({ item: x.id, where: where(x) })), uncovered: [] };
  },
  check: () => verdict([]),
  readbackReply: () => 'ok',
  sheet: () => 'ok',
};

// (j) J-0002's shape: an interface VLAN sync with many decisions and free-form answers.
const J2_DECISIONS = ['Which interfaces are synced: access, trunk or both', 'What is recorded for a trunk\'s native VLAN', 'How "allowed VLANs: all" is stored', 'What happens to a VLAN the device uses but Nautobot lacks', 'What happens to an interface Nautobot lacks', 'Whether port-channel members are synced', 'Whether a run without --commit is a dry run'];
S.j = {
  readback() {
    return {
      intent: { problem: "interface VLAN assignments on the switches are not in Nautobot's interfaces", who: 'the network engineers', outcome: "Nautobot's interfaces carry their mode, access VLAN and tagged VLANs from the devices", success: "after a run, a chosen device's interfaces in Nautobot match the device" },
      scope: { in: ['interface mode, untagged and tagged VLANs'], out: ['changing devices'] },
      took: [{ item: 'new', text: 'Cisco NX-OS and IOS-XE switches', quote: 'Cisco NX-OS and IOS-XE switches' }],
      pins: [{ system: 'nautobot', version: '2.4.x', source: 'user', quote: 'Nautobot 2.4.x' }],
      plan: [
        { item: 'new', what: 'How Nautobot 2.4 stores an interface mode and its VLANs', tag: 'docs', pins: ['nautobot'], impact: 'high' },
        { item: 'new', what: 'The NX-OS show command that lists switchport VLANs', tag: 'docs', pins: [], impact: 'medium' },
        ...J2_DECISIONS.map((d, i) => ({ item: 'new', what: d, tag: 'decision', pins: [], impact: i < 6 ? 'high' : 'medium' })),
      ],
      questions: [],
      design_may_choose: ['The exact NX-OS and IOS-XE command syntax and parsing'],
    };
  },
  repo: () => ({ mode: 'repo', versions: [], evidence: [], unresolved: [], failed_sources: [] }),
  docs(inp) {
    const evd = [];
    const failed = [];
    for (const p of inp.plan) {
      if (/stores an interface/i.test(p.what)) evd.push({ plan: p.id, claim: 'In Nautobot 2.4 an interface has a mode (access, tagged, tagged-all), an untagged VLAN and tagged VLANs', source: `${NB}/v2.4.x/user-guide/core-data-model/dcim/interface/`, source_tier: 'official', system: 'nautobot', quote: 'mode: access, tagged, or tagged (all)', version: '2.4.x', retrieved_at: '2026-10-15', confidence: 'high' });
      if (/NX-OS show/i.test(p.what)) failed.push({ plan: p.id, source: 'https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus9000/sw/93x/interfaces/configuration/guide.html', reason: 'HTTP 404' });
    }
    return { mode: 'docs', web_available: true, versions: [], evidence: evd, unresolved: failed.map((f) => ({ plan: f.plan, reason: f.reason })), failed_sources: failed };
  },
  brief(inp, ctx) {
    const iface = ctx.evidence.filter((e) => /interface/.test(e.source)).map((e) => e.source);
    const records = inp.plan.filter((p) => p.tag === 'decision').map((p) => ({ plan: p.id, decision: p.what, options: [{ key: 'a', text: 'Option a for this', consequences: 'x' }, { key: 'b', text: 'Option b for this', consequences: 'y' }], evidence: /trunk|interfaces are synced|allowed/i.test(p.what) ? iface : [], recommendation: 'a', why: 'The common choice.' }));
    const facts = inp.plan.filter((p) => p.tag !== 'decision').flatMap((p) => { const s = ctx.evidence.filter((e) => e.plan === p.id); return s.length ? [{ plan: p.id, statement: s[0].claim, evidence: s.map((e) => e.source) }] : []; });
    return { summary: 'Interfaces carry a mode and VLANs in 2.4.', records, facts, gaps: [] };
  },
  writer(inp) {
    const decided = (inp.items || []).filter((x) => x.kind === 'decision');
    const acs = decided.map((d, i) => `- AC-${i + 1}: ${d.text}: ${d.value} (evidence: test)`).join('\n');
    const text = `# Interface VLAN sync

## Intent
- Problem: ${inp.intent.problem}
- Who: ${inp.intent.who}
- Outcome: ${inp.intent.outcome}
- Success signal: ${inp.intent.success}

## Goal
A Nautobot 2.4 job sets each chosen device's interface modes and VLANs from the device.

## Non-goals
- Changing devices

## Acceptance criteria
${acs || '- AC-1: interfaces match (evidence: test)'}

## Constraints
- Cisco NX-OS and IOS-XE only

## Allowed paths
- jobs/**
- tests/**

## Verify commands
- \`python -m pytest -q\` (${(decided.length ? decided.map((_, i) => `AC-${i + 1}`) : ['AC-1']).join(', ')})

## Assumptions
- None
`;
    let n = 0;
    return { contract: text, covers: (inp.items || []).map((x) => ({ item: x.id, where: x.kind === 'decision' ? `AC-${++n}` : 'Goal' })), uncovered: [] };
  },
  check: () => verdict([]),
  sheet(screen, view, round) {
    // free-form answers, J-0002 style
    const parts = view.sheet.decisions.map((d, i) => (i % 2 === 0 ? `${d.no}: ${['trunk ports too, both modes', 'record it as untagged', 'store all as tagged-all', 'create it', 'skip it and log it', 'yes', 'yes, dry run by default'][J2_DECISIONS.findIndex((x) => x === d.question)] || 'as you recommend'}` : `${d.no} a`));
    return parts.join('\n');
  },
};

// (av) J-0001, then a redirect at H1 that names another version than the pin ("we actually run
// 2.3.x"). The interviewer is a faithful one: it refers to the items it is given by id, links the
// version clause to the pin, and on the read-back after the redirect quotes both versions the user
// gave. The docs researcher cites the pages of whatever version is pinned.
const byText = (items, re) => ((items || []).find((x) => re.test(x.text || '')) || {}).id || 'new';
S.av = {
  ...S.a,
  readback(inp) {
    const r = S.a.readback(inp);
    const words = inp.words.map((w) => w.text).join('\n');
    const items = inp.items || [];
    for (const t of r.took) t.item = byText(items.filter((x) => x.kind === 'fact'), new RegExp(t.text.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    for (const p of r.plan) p.item = byText(items.filter((x) => ['fact', 'decision'].includes(x.kind)), new RegExp(p.what.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    const v = /2\.3\.x/.test(words) ? '2.3.x' : '2.4.x';
    if (v === '2.3.x') {
      r.pins.push({ system: 'nautobot', version: '2.3.x', source: 'user', quote: 'we actually run Nautobot 2.3.x' });
      for (const p of r.plan) p.what = p.what.replace('2.4', '2.3');
    }
    return r;
  },
  redirect(inp) {
    const pin = (inp.items || []).find((x) => x.kind === 'pin');
    return { clauses: [{ quote: 'we actually run Nautobot 2.3.x, not 2.4', item: pin ? pin.id : 'new', action: 'fact', text: 'Nautobot 2.3.x is the version in use', tag: null }] };
  },
  docs(inp) {
    const pin = (inp.pins.find((p) => p.system === 'nautobot') || {}).version || '2.4.x';
    const r = S.a.docs(inp);
    const j = r.json || r;
    if (/^2\.3/.test(pin)) for (const e of j.evidence) if (/v2\.4\.x/.test(e.source)) Object.assign(e, { source: e.source.replace('v2.4.x', 'v2.3.x'), version: '2.3.x', claim: e.claim.replace('2.4', '2.3') });
    return r;
  },
  writer(inp) {
    const pin = (inp.items || []).find((x) => x.kind === 'pin' && x.value);
    const r = S.a.writer(inp);
    if (pin && /^2\.3/.test(pin.value)) {
      r.contract = r.contract.replace('the Nautobot 2.4 test APIs', 'the Nautobot 2.3 test APIs').replace(/Nautobot 2\.4(\.x)?/g, 'Nautobot 2.3.x');
      // the reworded constraint is a removal of the old text: said, with the item it rests on
      r.removed = [{ ref: 'Constraints', text: 'Nautobot 2.4.x; tests use the Nautobot 2.4 test APIs', because: pin.id, why: 'the user runs Nautobot 2.3.x' }];
    }
    return r;
  },
  sheet: (screen, view, round) => S.a.sheet(screen, view, round),
};

// (loop) God Eye that never runs out of things to ask: every readiness check sends a new
// decision to the sheet. The readiness cycle cap parks it; nothing loops the user forever.
S.loop = { ...S.b, check: (inp) => verdict([{ check: 'decisions_closed', severity: 'blocker', stage: 'sheet', ref: 'contract', issue: `Who owns the limits? (asked ${(inp.decisions || []).length})`, fix: 'ask the user' }]), interpret: (inp) => ({ answers: inp.sheet.decisions.map((d) => ({ decision: d.no, choice: 'other', text: inp.reply.text, quote: inp.reply.text })), facts: [], unclear: [] }), sheet: () => 'the platform team' };

// (hello) the hello-world park of 0.8.x: God Eye raises 3 findings the writer can fix (each with a
// fix), then 1, then none. 0.9.0 runs those rounds by itself: H1 with no park and no user turn.
const HELLO = (round) => `# Hello world script

## Intent
- Problem: there is no script that greets the user
- Who: whoever runs the script
- Outcome: running it prints a greeting
- Success signal: running it prints Hello, world

## Goal
\`node hello.js\` prints "Hello, world" and exits 0.

## Non-goals
${round >= 2 ? '- Command-line arguments or other languages' : '- None'}

## Acceptance criteria
- AC-1: \`node hello.js\` prints exactly "Hello, world" followed by a newline (evidence: test)
${round >= 3 ? '- AC-2: `node hello.js` exits with code 0 (evidence: test)\n' : ''}
## Constraints
- No dependencies

## Allowed paths
- hello.js
- tests/**

## Verify commands
- \`${round >= 2 ? 'node tests/hello.test.js' : 'node hello.js'}\` (AC-1${round >= 3 ? ', AC-2' : ''})

## Assumptions
- None
`;
S.hello = {
  readback() {
    return { intent: { problem: 'there is no script that greets the user', who: 'whoever runs the script', outcome: 'running it prints a greeting', success: 'running it prints Hello, world' }, scope: { in: ['a hello-world script'], out: [] }, took: [{ item: 'new', text: 'It prints Hello, world', quote: 'prints Hello, world' }], pins: [], plan: [], questions: [], design_may_choose: ['The file name'] };
  },
  repo: () => ({ mode: 'repo', versions: [], evidence: [], unresolved: [], failed_sources: [] }),
  docs: () => ({ mode: 'docs', web_available: true, versions: [], evidence: [], unresolved: [], failed_sources: [] }),
  brief: () => ({ summary: 'nothing to research', records: [], facts: [], gaps: [] }),
  writer(inp) {
    const round = earlier({}, (l) => l.agent === 'factory:contract-writer') + 1;
    return { contract: HELLO(round), covers: (inp.items || []).map((x) => ({ item: x.id, where: 'AC-1' })), uncovered: [], removed: [], changed: [] };
  },
  check() {
    const n = earlier({}, (l) => l.agent === 'factory:god-eye') + 1;
    const all = [
      { check: 'acs_testable', severity: 'blocker', stage: 'assemble', ref: 'AC-1', issue: 'The verify command `node hello.js` runs the script but checks nothing: it passes whatever the script prints.', fix: 'Add tests/hello.test.js that runs hello.js and compares its output, and make it the verify command for AC-1.', fixable_by: 'writer' },
      { check: 'scope_bounded', severity: 'blocker', stage: 'assemble', ref: 'Non-goals', issue: 'Non-goals says None: arguments and other languages are neither in nor out.', fix: 'Add a non-goal: command-line arguments and other languages.', fixable_by: 'writer' },
      { check: 'acs_testable', severity: 'blocker', stage: 'assemble', ref: 'Goal', issue: 'The Goal says it exits 0, but no criterion proves the exit code.', fix: 'Add AC-2: node hello.js exits with code 0 (evidence: test), covered by the verify command.' },
    ];
    // the first version has all three; the second fixed two; the third all
    return verdict(n === 1 ? all : n === 2 ? all.slice(2) : []);
  },
  sheet: () => 'ok',
};

// The failure scenarios reuse b's world with one agent broken.
S.e1 = { ...S.b, readback: () => ({ __timeout: true }) };
S.e2 = { ...S.b, docs: (inp) => ({ mode: 'docs', web_available: false, versions: [], evidence: [], unresolved: inp.plan.map((p) => ({ plan: p.id, reason: 'web_fetch failed: no network' })), failed_sources: [] }) };
S.e3 = { ...S.b, sheet: () => 'ok', check: () => verdict([{ check: 'intent_clear', severity: 'blocker', stage: 'assemble', ref: 'Goal', issue: 'The goal could be sharper', fix: '' }]) };
S.e4 = { ...S.b, docs: () => ({ __timeout: true }) };
// (e5, the simulation's) every agent fails every time and nobody steps in
const failAll = () => ({ __fail: true });
S.e5 = { ...S.b, readback: failAll, redirect: failAll, interpret: failAll, repo: failAll, docs: failAll, brief: failAll, writer: failAll, check: failAll };
S.e6 = { ...S.b, brief: () => ({ __fail: true }) };

function verdict(objections) {
  const ck = { intent_clear: true, scope_bounded: true, acs_testable: true, self_consistent: true, facts_honoured: true, instructions_handled: true, decisions_closed: true };
  for (const o of objections) if (o.severity === 'blocker') ck[o.check] = false;
  return { verdict: objections.some((o) => o.severity === 'blocker') ? 'blocked' : 'ready', restatement: { problem: 'as the contract says', outcome: 'as the contract says' }, checklist: ck, objections };
}

// ---------------------------------------------------------------- dispatch
module.exports = (c) => {
  const C = crew();
  const sc = S[C.scenario];
  if (!sc) return { exit: 1, stderr: `clarify3-crew: no scenario ${C.scenario}` };
  const text = given(c);
  const inp = grab(text, 'CLARIFY INPUT (JSON):') || {};
  const inputs = grab(text, 'INPUTS (JSON):') || [];
  const root = c.env.FACTORY_ROOT;
  const J = c.env.FACTORY_JOB;
  const contractFile = path.join(root, '.factory', 'jobs', J, 'contract.md');
  const evidence = inputs.flatMap((x) => (x.output && x.output.evidence) || []);
  const ctx = { evidence, contract: fs.existsSync(contractFile) ? fs.readFileSync(contractFile, 'utf8') : '' };
  const out = (r) => {
    if (r && r.__timeout) return { json: {}, sleep_ms: Number(C.timeout_sleep_ms || 6000) };
    if (r && r.__fail) return { exit: 1, stderr: 'model error' };
    return r && r.json ? r : { json: r, sleep_ms: 20 };
  };
  switch (c.role) {
    case 'interviewer':
      if (inp.mode === 'readback') return out(sc.readback(inp, ctx));
      if (inp.mode === 'redirect') return out(sc.redirect ? sc.redirect(inp, ctx) : { clauses: [] });
      if (inp.mode === 'interpret') return out(sc.interpret ? sc.interpret(inp, ctx) : { answers: [], facts: [], unclear: [inp.reply.text] });
      return { exit: 1, stderr: `interviewer: unknown mode ${inp.mode}` };
    case 'researcher':
      return out(inp.mode === 'repo' ? sc.repo(inp, ctx) : sc.docs(inp, ctx));
    case 'brief-writer':
      return out(sc.brief(inp, ctx));
    case 'contract-writer':
      return out(sc.writer(inp, ctx));
    case 'god-eye':
      // the loop engine's diagnosis (focus diagnosis): why the writer loop made no progress
      if (inp.focus === 'diagnosis') return out(sc.diagnosis ? sc.diagnosis(inp, ctx) : { cause: 'The same objection came back every round: the writer cannot settle it from what the record holds.', needs_user: false, approach: 'State the goal as one observable outcome with its number, and name the boundary case.', question: '', options: [], recommendation: '' });
      return out(sc.check(inp, ctx));
    case 'finding-verifier':
      // clarify's tie-break on a disputed readiness objection (mode dispute)
      if (inp.mode === 'dispute') return out(sc.dispute ? sc.dispute(inp, ctx) : { finding_id: inp.finding.id, status: 'confirmed', evidence: 'contract.md: the objection holds as written', reason: 'The contract does not settle it yet.' });
      return { exit: 1, stderr: 'clarify3-crew: finding-verifier outside a dispute' };
    default:
      return { exit: 1, stderr: `clarify3-crew: no script for ${c.agent}` };
  }
};
module.exports.SCENARIOS = S;
module.exports.earlier = earlier;
module.exports.grab = grab;
