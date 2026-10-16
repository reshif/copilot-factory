'use strict';
// Desktop notifications when `factory drive` stops (a gate, a clarify turn, a park, done …).
// Best effort and never blocking: the notifier is spawned detached with its output ignored and
// a short kill timer, any error is swallowed, and the drive goes on whatever happens here.
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

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const asQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function toastScript(title, body) {
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    `$x = $t.GetElementsByTagName('text'); $x.Item(0).AppendChild($t.CreateTextNode(${psQuote(title)})) > $null; $x.Item(1).AppendChild($t.CreateTextNode(${psQuote(body)})) > $null`,
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Software Factory').Show([Windows.UI.Notifications.ToastNotification]::new($t))",
  ].join('; ');
}

// The command that would show the notification here: { method, file, args } or { method: 'bell' }.
function plan(title, body, { platform = process.platform, env = process.env, wsl = null, find = (n) => which(n, env) } = {}) {
  const t = String(title).slice(0, 120);
  const b = String(body).slice(0, 400);
  if (platform === 'darwin') {
    const f = find(['osascript']);
    if (f) return { method: 'osascript', file: f, args: ['-e', `display notification ${asQuote(b)} with title ${asQuote(t)}`] };
  } else if (platform === 'win32') {
    return { method: 'powershell', file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', toastScript(t, b)] };
  } else if (platform === 'linux') {
    if (wsl === null ? isWsl(env) : wsl) {
      const w = find(['wsl-notify-send.exe', 'wsl-notify-send']);
      if (w) return { method: 'wsl-notify-send', file: w, args: ['--category', t, b] };
      const ps = find(['powershell.exe']);
      if (ps) return { method: 'powershell', file: ps, args: ['-NoProfile', '-NonInteractive', '-Command', toastScript(t, b)] };
    }
    const n = find(['notify-send']);
    if (n) return { method: 'notify-send', file: n, args: ['--app-name=Software Factory', t, b] };
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
        const child = spawn(p.file, p.args, { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
        child.on('error', () => {});
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* gone */
          }
        }, 5000);
        timer.unref();
        child.on('exit', () => clearTimeout(timer));
        child.unref();
        res = { sent: true, method: p.method };
      }
    }
  } catch (e) {
    res = { sent: false, method: 'error', error: String(e.message).slice(0, 200) };
  }
  try {
    require('./events').append(root, { event: 'notify', job, kind, method: res.method, sent: res.sent, title: String(title || '').slice(0, 120) });
  } catch {
    /* logging is best effort too */
  }
  return res;
}

module.exports = { notify, plan, isWsl, which, enabled };
