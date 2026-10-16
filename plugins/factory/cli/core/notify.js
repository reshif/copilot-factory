'use strict';
// Desktop notifications when `factory drive` stops (a gate, a clarify turn, a park, done …).
// Best effort and never blocking: the notifier is spawned detached with its output ignored and
// never waited on, any error is swallowed, and the drive goes on whatever happens here.
//
//   Linux     notify-send
//   WSL       wsl-notify-send.exe, else a powershell.exe toast (WSL is detected by
//             /proc/version naming Microsoft/WSL, or WSL_DISTRO_NAME being set)
//   macOS     osascript -e 'display notification …'
//   Windows   a powershell toast
//   anything else, or no notifier found: a terminal bell on the controlling terminal
//
// policy.notify: true (default) or false turns them on or off; FACTORY_NOTIFY=off does the same
// for one process (the test suite). Each notification is also logged as a `notify` event (the
// method used, never failing), so the inspector and the console can see that the human was told.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function enabled(root) {
  if (/^(0|off|false|no)$/i.test(String(process.env.FACTORY_NOTIFY || ''))) return false;
  try {
    const pol = require('./policy').load(root);
    if (pol && pol.notify === false) return false;
    if (pol && pol.notify && typeof pol.notify === 'object' && pol.notify.enabled === false) return false;
  } catch {
    /* no policy: on */
  }
  return true;
}

function isWsl(env = process.env, read = (f) => fs.readFileSync(f, 'utf8')) {
  if (env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft|wsl/i.test(read('/proc/version'));
  } catch {
    return false;
  }
}

// The first of `names` found on PATH (absolute path), or null.
function which(names, env = process.env) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const n of names) {
    for (const d of dirs) {
      const f = path.join(d, n);
      try {
        fs.accessSync(f, fs.constants.X_OK);
        if (fs.statSync(f).isFile()) return f;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

// Nothing the notification shows is ever part of a script's text: the title and body can carry
// agent-written words (a park reason), and PowerShell and AppleScript would run what a quote in
// them closes over. They travel as environment variables (PowerShell reads $env:…; WSL passes
// them to the Windows side through WSLENV) or as argv items (osascript's `on run argv`,
// notify-send), and control characters are stripped.
const NOTE_ENV = ['FACTORY_NOTE_TITLE', 'FACTORY_NOTE_BODY'];
// eslint-disable-next-line no-control-regex
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
// PowerShell's own AppUserModelID (registered on every Windows install), so the toast is shown
const PS_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const TOAST_SCRIPT = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
  '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$x = $t.GetElementsByTagName('text'); $x.Item(0).AppendChild($t.CreateTextNode($env:FACTORY_NOTE_TITLE)) > $null; $x.Item(1).AppendChild($t.CreateTextNode($env:FACTORY_NOTE_BODY)) > $null",
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${PS_APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($t))`,
].join('; ');
const OSA_ARGS = ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run'];

// The command that would show the notification here: { method, file, args, env } or { method: 'bell' }.
function plan(title, body, { platform = process.platform, env = process.env, wsl = null, find = (n) => which(n, env) } = {}) {
  const t = clean(title, 120);
  const b = clean(body, 400);
  const vars = { FACTORY_NOTE_TITLE: t, FACTORY_NOTE_BODY: b };
  const ps = (file, viaWsl) => ({ method: 'powershell', file, args: ['-NoProfile', '-NonInteractive', '-Command', TOAST_SCRIPT], env: { ...vars, ...(viaWsl ? { WSLENV: [env.WSLENV, ...NOTE_ENV].filter(Boolean).join(':') } : {}) } });
  if (platform === 'darwin') {
    const f = find(['osascript']);
    if (f) return { method: 'osascript', file: f, args: [...OSA_ARGS, t, b], env: {} };
  } else if (platform === 'win32') {
    return ps('powershell.exe', false);
  } else if (platform === 'linux') {
    if (wsl === null ? isWsl(env) : wsl) {
      const w = find(['wsl-notify-send.exe', 'wsl-notify-send']);
      if (w) return { method: 'wsl-notify-send', file: w, args: ['--category', t, '--', b], env: {} };
      const p = find(['powershell.exe']);
      if (p) return ps(p, true);
    }
    const n = find(['notify-send']);
    if (n) return { method: 'notify-send', file: n, args: ['--app-name=Software Factory', '--', t, b], env: {} };
  }
  return { method: 'bell' };
}

// A terminal bell: on the controlling terminal when there is one, else nothing (a detached drive
// has no terminal; its log and the inbox still say what waits).
function bell() {
  try {
    const fd = fs.openSync(process.platform === 'win32' ? '\\\\.\\CONOUT$' : '/dev/tty', 'w');
    fs.writeSync(fd, '\x07');
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

// Notify; returns { sent, method } and never throws or waits on the notifier.
function notify(root, { title, body, job = null, kind = null } = {}) {
  let res = { sent: false, method: 'off' };
  try {
    if (!enabled(root)) res = { sent: false, method: 'off' };
    else {
      const p = plan(title, body);
      if (p.method === 'bell') res = { sent: bell(), method: 'bell' };
      else {
        // detached and never waited on: the drive goes on (and may exit) whatever the notifier does
        const child = spawn(p.file, p.args, { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true, env: { ...process.env, ...(p.env || {}) } });
        child.on('error', () => {});
        child.unref();
        res = { sent: true, spawned: true, method: p.method };
      }
    }
  } catch (e) {
    res = { sent: false, method: 'error', error: String(e.message).slice(0, 200) };
  }
  try {
    require('./events').append(root, { event: 'notify', job, kind, method: res.method, sent: res.sent, ...(res.spawned ? { result: 'spawned' } : {}), title: String(title || '').slice(0, 120) });
  } catch {
    /* logging is best effort too */
  }
  return res;
}

module.exports = { notify, plan, isWsl, which, enabled, clean, TOAST_SCRIPT };
