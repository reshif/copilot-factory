'use strict';
// Drives one clarify v3 scenario end to end through the real factory CLI: `factory next`,
// `factory run clarify` on the fake Copilot with the scripted crew (clarify3-crew.js), the
// user's replies through `factory clarify reply` (the path that works without the prompt
// hook), and gate replies (approve, deny, proceed, resume) as chat replies. It records every
// user turn with the agent calls it cost, every screen and every H1 view.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./fixture');

const CREW = path.join(__dirname, 'clarify3-crew.js');
const FAKE = path.join(__dirname, 'fake-copilot.js');

function makeRepo(files) {
  const root = require('./tmp').mkdtemp('clarify3-');
  F.sh(root, 'git init -q -b main && git config user.email t@example.com && git config user.name Tester && git config commit.gpgsign false');
  for (const [rel, text] of Object.entries(files)) F.write(root, rel, text);
  F.sh(root, 'git add -A && git commit -qm init');
  const out = F.cli(root, ['init']);
  if (out.error) throw new Error(JSON.stringify(out));
  return root;
}

function mergePolicy(root, extra) {
  if (!extra) return;
  const pf = path.join(root, '.factory', 'policy.json');
  const cur = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, 'utf8')) : {};
  const merge = (a, b) => {
    for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] || {}, v) : v;
    return a;
  };
  fs.writeFileSync(pf, JSON.stringify(merge(cur, extra), null, 2));
}

function drive(scen, { log = () => {} } = {}) {
  // an existing repository (a job made by an earlier version, upgraded mid-clarify) or a new one
  const root = scen.existing ? scen.existing.root : makeRepo(scen.repo);
  mergePolicy(root, scen.policy);
  const logFile = path.join(root, '.factory', 'scratch', 'copilot.jsonl');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const env = { COPILOT_BIN: FAKE, FAKE_COPILOT_SCRIPT: CREW, FAKE_COPILOT_LOG: logFile, CREW: JSON.stringify({ scenario: scen.crew, ...(scen.crewOpts || {}) }) };
  const cli = (args) => F.cli(root, args, { env });
  const created = scen.existing ? { job: scen.existing.J } : cli(['job', 'new', '--title', scen.title, '--type', scen.type || 'feature', '--risk', scen.risk || 'medium', '--request', scen.request]);
  if (!created.job) throw new Error(`job new failed: ${JSON.stringify(created)}`);
  const J = created.job;
  const JD = F.jobDir(root, J);
  if (scen.draft) fs.writeFileSync(path.join(JD, 'contract.md'), scen.draft);
  const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const status = () => cli(['clarify', 'status', '--json']);
  const rec = { root, J, JD, turns: [{ turn: 0, said: scen.request, at_stage: 'request', calls: [] }], screens: [], h1: [], runs: [], parks: [], end: null };
  let mark = 0;
  const closeTurn = () => {
    const all = calls();
    rec.turns[rec.turns.length - 1].calls.push(...all.slice(mark).map((l) => String(l.agent || '').replace('factory:', '')));
    mark = all.length;
  };
  const user = (stage, said) => {
    closeTurn();
    rec.turns.push({ turn: rec.turns.length, said, at_stage: stage, calls: [] });
  };
  const chat = (text) => {
    try {
      return F.reply(root, text);
    } catch (e) {
      return { error: e.message, code: e.code };
    }
  };
  let sheets = 0;
  let readbacks = 0;
  let redirects = 0;
  let gates = 0;
  for (let step = 0; step < (scen.maxSteps || 40); step++) {
    const n = cli(['next']);
    if (n.action === 'skill' && n.skill === 'clarify') {
      const c = n.clarify || {};
      if (c.run) {
        const r = cli(['run', 'clarify', '--json']);
        rec.runs.push({ stage: c.stage, status: r.status, code: r.code || null, message: r.message || r.error || null });
        log(`run ${c.stage}: ${r.status || r.code} ${String(r.message || r.error || '').slice(0, 160)}`);
        if (r.__code !== 0 && !r.status) throw new Error(`factory run clarify failed: ${JSON.stringify(r).slice(0, 800)}`);
        continue;
      }
      if (c.waiting_for_user) {
        const view = status();
        rec.screens.push({ stage: c.stage, screen: c.screen });
        let said;
        if (c.stage === 'readback_wait') said = scen.readbackReply ? scen.readbackReply(++readbacks, c.screen, view) : 'ok';
        else if (c.stage === 'sheet_wait') said = scen.sheet(c.screen, view, ++sheets);
        else if (c.stage === 'redirect_wait') said = scen.redirectReply ? scen.redirectReply(++redirects, c.screen, view) : 'ok';
        else throw new Error(`unknown wait stage ${c.stage}`);
        user(c.stage, said);
        const r = cli(['clarify', 'reply', said]);
        log(`you (${c.stage}): ${said} → ${r.message || r.error}`);
        if (r.__code !== 0) throw new Error(`clarify reply refused: ${JSON.stringify(r).slice(0, 600)}`);
        continue;
      }
      throw new Error(`clarify neither runs nor waits: ${JSON.stringify(n).slice(0, 600)}`);
    }
    if (n.action === 'gate' && /H1/.test(n.step || '')) {
      gates += 1;
      const contract = fs.readFileSync(path.join(JD, 'contract.md'), 'utf8');
      const view = status();
      const h1 = n.clarify_h1 || view.h1;
      rec.h1.push({ gate: gates, h1, contract, view });
      const d = scen.gate(gates, { contract, h1, view, root, J, JD });
      user('H1', d.deny ? `deny ${d.deny}` : 'approve');
      if (d.deny) {
        const r = chat(`deny ${J} ${d.deny}`);
        log(`you (H1 #${gates}): deny (${(d.missing || []).join(', ')}) → ${r.message || r.error}`);
        continue;
      }
      const r = chat(`approve ${J} H1`);
      log(`you (H1 #${gates}): approve → ${r.message || r.error}`);
      closeTurn();
      rec.end = { action: 'approved', gates };
      break;
    }
    if (n.action === 'parked') {
      rec.parks.push(n.reason);
      const what = scen.onPark ? scen.onPark(rec.parks.length, n.reason, status()) : null;
      log(`parked: ${String(n.reason).slice(0, 200)} → ${what || 'stop'}`);
      if (!what) {
        closeTurn();
        rec.end = { action: 'parked', reason: n.reason };
        break;
      }
      user('park', what);
      const r = chat(`${what} ${J}`);
      if (r.error) throw new Error(`${what} refused: ${r.error}`);
      continue;
    }
    closeTurn();
    rec.end = { action: n.action, step: n.step || null, next: n };
    break;
  }
  if (!rec.end) {
    closeTurn();
    rec.end = { action: 'max_steps' };
  }
  rec.final = status();
  rec.ledger = JSON.parse(fs.readFileSync(path.join(JD, 'clarify.json'), 'utf8'));
  rec.contract = fs.readFileSync(path.join(JD, 'contract.md'), 'utf8');
  rec.calls = calls();
  // how each agent came back, as the runner logged it (a killed agent never writes the fake's log)
  rec.agentRuns = fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'agent_run').map((e) => ({ role: e.role, label: e.label, outcome: e.outcome }));
  rec.cli = cli;
  return rec;
}

module.exports = { drive, makeRepo, CREW, FAKE };
