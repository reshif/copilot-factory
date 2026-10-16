'use strict';
// The 0.11 crew ("design depth") for fake-copilot.js: crew.js plays every role, except
//   - the option generators, which propose three different ways to sync VLANs (O-1…O-3);
//   - the architect, which writes the full adr@2 design for a Nautobot VLAN sync job
//     (tests/fixtures/design/adr-vlan-sync.md) — on its first run without the O-3 row, which
//     `factory record` rejects (every generated option needs a row), so the next run fixes it;
//   - the planner, whose first plan does not follow the Project layout (one task owns a whole
//     tree another task also builds in, some files have no owner), fixed once validate says so.

const fs = require('fs');
const path = require('path');
const base = require('./crew');

const FIX = path.join(__dirname, '..', 'fixtures', 'design');
const ADR = (J) => fs.readFileSync(path.join(FIX, 'adr-vlan-sync.md'), 'utf8').replace(/^job: J-0001$/m, `job: ${J}`);
const OPTIONS = {
  'O-1': { title: 'Netmiko "show vlan brief" per device, own diff, per-device transaction', touches: ['nautobot_vlan_sync/jobs.py', 'nautobot_vlan_sync/collectors/netmiko_collector.py', 'nautobot_vlan_sync/diff.py'] },
  'O-2': { title: 'NAPALM get_vlans() with a diffsync adapter', touches: ['nautobot_vlan_sync/jobs.py', 'nautobot_vlan_sync/adapters.py'] },
  'O-3': { title: 'Read VLANs from Golden Config backups', touches: ['nautobot_vlan_sync/jobs.py', 'nautobot_vlan_sync/backups.py'] },
};
const T = (id, objective, paths, criteria, deps = []) => ({ id, objective, allowed_paths: paths, depends_on: deps, criteria_ids: criteria, verify_commands: [{ cmd: 'node tests/add.test.js', covers: criteria }] });
const GOOD = [
  T('T1', 'Collector and records from ADR 001 D-1 (Netmiko, TextFSM, DeviceError)', ['nautobot_vlan_sync/records.py', 'nautobot_vlan_sync/collectors/**', 'tests/fixtures/show_vlan_brief.txt', 'tests/test_collector.py', 'pyproject.toml'], ['AC-1', 'AC-3']),
  T('T2', 'plan_changes keyed on (group, vid) from ADR 001 D-2', ['nautobot_vlan_sync/diff.py', 'tests/test_diff.py'], ['AC-1', 'AC-4'], ['T1']),
  T('T3', 'VlanSyncJob, writer and registration from ADR 001 D-3', ['nautobot_vlan_sync/jobs.py', 'nautobot_vlan_sync/writer.py', 'nautobot_vlan_sync/__init__.py', 'tests/test_jobs.py'], ['AC-1', 'AC-2', 'AC-3', 'AC-5'], ['T1', 'T2']),
];
const BAD = [
  T('T1', 'The whole app', ['nautobot_vlan_sync/**'], ['AC-1', 'AC-2', 'AC-3', 'AC-5']),
  T('T2', 'The diff', ['nautobot_vlan_sync/diff.py', 'docs/**'], ['AC-4'], ['T1']),
];

module.exports = (c) => {
  const root = c.env.FACTORY_ROOT;
  const J = c.env.FACTORY_JOB;
  const jd = path.join(root, '.factory', 'jobs', J);
  const nested = (t) => t.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/') && l.endsWith('.md') && fs.existsSync(l)).map((l) => fs.readFileSync(l, 'utf8')).join('\n');
  const text = `${c.instructions || ''}\n${nested(c.instructions || '')}\n${c.prompt || ''}`;
  switch (c.role) {
    case 'option-generator': {
      const id = (/Your option is \*\*(O-\d+)\*\*/.exec(text) || [])[1] || 'O-1';
      const o = OPTIONS[id] || OPTIONS['O-1'];
      return { title: o.title, summary: `${o.title}.`, criteria: [{ id: 'AC-1', how: 'creates and updates VLANs per device' }], touches: o.touches, pros: ['meets AC-1'], cons: ['see the ADR'] };
    }
    case 'architect': {
      const file = path.join(jd, 'adr-001-vlan-sync.md');
      const fixing = /breaks the doc templates/.test(text);
      const adr = fixing ? ADR(J) : ADR(J).replace(/^\| O-3 \|.*\n/m, '');
      fs.writeFileSync(file, adr);
      return { kind: 'adr', paths: [file], summary: 'Collect VLANs over SSH with Netmiko, match on (group, vid), write per device.', rejected: [{ option: OPTIONS['O-2'].title, reason: 'platform coverage' }, { option: OPTIONS['O-3'].title, reason: 'stale data' }], decisions: [{ id: 'D-1', title: 'How VLANs are collected from devices', chosen: 'O-1' }, { id: 'D-2', title: 'How a found VLAN is matched', chosen: '(group, vid)' }, { id: 'D-3', title: 'How writes are grouped', chosen: 'per device' }], layout: { files: 14, new: 11, changed: 2 } };
    }
    case 'planner': {
      const file = path.join(jd, 'plan.json');
      const fixed = /The validator reported these errors[\s\S]*owned by/.test(text);
      fs.writeFileSync(file, JSON.stringify({ tasks: fixed ? GOOD : BAD }));
      const v = require('./fixture').cli(root, ['plan', 'validate', '--job', J]);
      return { valid: Boolean(v.valid), errors: v.errors || [], path: file };
    }
    default:
      return base(c);
  }
};
module.exports.GOOD = GOOD;
module.exports.BAD = BAD;
