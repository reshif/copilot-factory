'use strict';
// The findings register: .factory/inspect/register.json. The inspector only adds and
// updates findings; their status changes only when you mark them.
//   open → acknowledged → fixed | wont_fix ;  a fixed finding that is seen again reopens.

const { readJson, writeJson, sha256, nowIso, layout } = require('./io');

function load(root) {
  return readJson(layout(root).register, null) || { version: 1, findings: [], inspected: {}, runs: [] };
}

function save(root, reg) {
  writeJson(layout(root).register, reg);
}

function keyOf(fd) {
  return sha256(`${fd.rule}|${fd.subject}`).slice(0, 16);
}

// Merge freshly detected findings. Returns { added, reopened, seen }.
function merge(reg, detected, rulebook) {
  const res = { added: [], reopened: [], seen: [] };
  for (const fd of detected) {
    const key = keyOf(fd);
    const existing = reg.findings.find((x) => x.key === key);
    if (!existing) {
      const id = `F${reg.findings.length + 1}`;
      reg.findings.push({ id, key, ...fd, status: 'open', first_seen: nowIso(), last_seen: nowIso(), times_seen: 1, rulebook: rulebook || null, history: [] });
      res.added.push(id);
      continue;
    }
    existing.last_seen = nowIso();
    existing.times_seen += 1;
    existing.summary = fd.summary;
    existing.evidence = fd.evidence;
    existing.latest = fd.latest || existing.latest || null;
    // Health findings come from history that stays in the logs: only newer evidence reopens.
    const fixedAt = existing.status === 'fixed' ? (existing.history.filter((h) => h.to === 'fixed').pop() || {}).at : null;
    if (fixedAt && fd.latest && fd.latest <= fixedAt) {
      res.seen.push(existing.id);
      continue;
    }
    if (existing.status === 'fixed') {
      existing.history.push({ at: nowIso(), from: 'fixed', to: 'open', why: 'seen again after being marked fixed' });
      existing.status = 'open';
      existing.regressed = true;
      res.reopened.push(existing.id);
    } else {
      res.seen.push(existing.id);
    }
  }
  return res;
}

const STATUSES = { ack: 'acknowledged', acknowledged: 'acknowledged', fixed: 'fixed', wontfix: 'wont_fix', wont_fix: 'wont_fix', open: 'open' };

function mark(reg, id, status, reason) {
  const fd = reg.findings.find((x) => x.id === id.toUpperCase());
  if (!fd) throw new Error(`No finding ${id}`);
  const to = STATUSES[status];
  if (!to) throw new Error(`Status must be one of: ack, fixed, wontfix, open`);
  if (to === 'wont_fix' && !reason) throw new Error('wontfix needs a reason');
  fd.history.push({ at: nowIso(), from: fd.status, to, why: reason || '' });
  fd.status = to;
  return fd;
}

module.exports = { load, save, merge, mark, keyOf };
