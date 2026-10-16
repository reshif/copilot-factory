'use strict';
// A fixed machine tool inventory for tests (cli/core/machine.js honours FACTORY_MACHINE_FILE): the
// environment the factory proposes and the lint it runs depend on the machine, so tests that
// assert either describe the machine they assume. Set for the rest of the test file's process
// (and the CLIs it spawns).
const fs = require('fs');
const path = require('path');

const tool = (version = '1.0') => ({ path: `/usr/bin/x`, version });
function inventory({ venv = true, tools = {}, python = ['python3'], docker = null, sudo = 'password' } = {}) {
  const all = Object.fromEntries(require('../../cli/core/machine').TOOLS.map((t) => [t, tools[t] ? tool() : null]));
  return {
    version: 1,
    at: new Date().toISOString(),
    host: 'test',
    platform: 'linux',
    python: python.map((cmd) => ({ cmd, path: `/usr/bin/${cmd}`, version: '3.10.12' })),
    venv: venv ? { works: true, python: '/usr/bin/python3', why: null } : { works: false, python: '/usr/bin/python3', ensurepip: 'missing', why: 'The virtual environment was not created successfully because ensurepip is not available. On Debian/Ubuntu systems, you need to install the python3-venv package' },
    tools: all,
    docker: docker || { present: Boolean(tools.docker), compose: tools.docker ? 'docker compose' : null, daemon: tools.docker ? 'reachable' : null },
    sudo,
    network: { pypi: { checked: false }, npm: { checked: false } },
  };
}
// The machine most legacy tests assume: python3 -m venv works, no uv, poetry or virtualenv.
const VENV_ONLY = inventory({ tools: { node: true, npm: true, git: true, curl: true } });

function use(inv, dir) {
  const f = path.join(dir || require('./tmp').mkdtemp('factory-machine-'), 'machine.json');
  fs.writeFileSync(f, JSON.stringify(inv));
  process.env.FACTORY_MACHINE_FILE = f;
  return f;
}

module.exports = { inventory, use, VENV_ONLY };
