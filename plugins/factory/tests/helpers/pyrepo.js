'use strict';
// A Python repo whose tests pass only inside a venv set up in the checkout under test (the
// audit's build exp1): the test runner is a console script that exists only in .venv/bin,
// and the venv holds an editable install (a .pth pointing at the checkout it was made in).
// The root checkout has its own .venv, so an absolute path to it would test the ROOT's code.

const fs = require('fs');
const path = require('path');
const F = require('./fixture');

const MKENV = `#!/usr/bin/env bash
# Sets up this checkout's venv: an editable install of this checkout and its test runner.
set -euo pipefail
python3 -m venv .venv
site=$(.venv/bin/python -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')
echo "$PWD" > "$site/myapp-editable.pth"
cat > .venv/bin/myapp-check <<EOF
#!$PWD/.venv/bin/python
import myapp.check
myapp.check.main()
EOF
chmod +x .venv/bin/myapp-check
`;

const CHECK = `import os
import sys

import myapp
from myapp.text import slug


def main():
    print("myapp imported from", os.path.dirname(os.path.dirname(os.path.abspath(myapp.__file__))))
    print("python", sys.prefix)
    got = slug("a b")
    if got != "a-b":
        print("slug('a b') = %r, want 'a-b'" % got)
        sys.exit(1)
    print("ok")
`;

function makePyRepo() {
  const root = F.makeRepo();
  F.sh(root, 'git rm -q -r src tests && git commit -qm "python now"');
  F.write(root, 'pyproject.toml', '[project]\nname = "myapp"\nversion = "0.1.0"\n');
  F.write(root, 'myapp/__init__.py', '');
  F.write(root, 'myapp/text.py', 'def slug(s):\n    return s.replace(" ", " ")  # bug: should join words with -\n');
  F.write(root, 'myapp/check.py', CHECK);
  F.write(root, 'scripts/mkenv.sh', MKENV);
  F.write(root, '.gitignore', '.venv/\n');
  F.sh(root, 'chmod +x scripts/mkenv.sh && git add -A && git commit -qm "myapp"');
  // the developer's own venv at the root: an editable install of the ROOT checkout
  F.sh(root, 'bash scripts/mkenv.sh');
  return root;
}

const ENV = { version: 1, name: 'python-venv', setup: ['bash scripts/mkenv.sh'], cache_key: ['pyproject.toml', 'scripts/mkenv.sh'], env: { VIRTUAL_ENV: '{worktree}/.venv', PATH: '{worktree}/.venv/bin:$PATH' }, ignore: ['.venv/'], timeout_seconds: 300 };

const CONTRACT = (F_) => F_.contractText({ goal: 'slug("a b") returns "a-b".', allowed: ['myapp/**'], verify: '`myapp-check` (AC-1)', ac: '- AC-1: slug("a b") returns "a-b" (evidence: test)' });

module.exports = { makePyRepo, ENV, CONTRACT, MKENV };

if (require.main === module) process.stdout.write(`${makePyRepo()}\n`);
void fs;
void path;
