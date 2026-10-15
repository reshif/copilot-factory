const TOASTED = new Set();
function toastGate(m) {
  const job = m.job;
  const g = (job.pending_gate && job.pending_gate.id) || '';
  const key = `${job.id}|${g}|${job.pending_gate && job.pending_gate.at}`;
  if (TOASTED.has(key)) return;
  TOASTED.add(key);
  const reply = gateReply(job, g);
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'alert');
  t.innerHTML = `<div class="tt"><i class="beacon" style="--bk:var(--sig-amber)"></i>Your turn · ${esc(job.id)}<button type="button" class="x" aria-label="Dismiss">×</button></div><p><b>${esc(job.title)}</b> waits on you at ${esc(g === 'P' ? 'a park' : stepName(g))}.</p>${reply ? `<div class="reply"><code>${esc(reply)}</code><button type="button" class="copy" data-copy="${esc(reply)}">Copy</button><button type="button" class="tbtn" data-open>Open</button></div>` : ''}`;
  $('#toasts').prepend(t);
  bindCopies(t);
  t.querySelector('.x').addEventListener('click', () => t.remove());
  const o = t.querySelector('[data-open]');
  if (o) o.addEventListener('click', () => { t.remove(); openJob(job.id, { user: true, tab: 'story' }); });
  while ($('#toasts').children.length > 4) $('#toasts').lastElementChild.remove();
  if (UI.notify && window.Notification && Notification.permission === 'granted') {
    try { const n = new Notification(`Factory: your turn on ${job.id}`, { body: `${job.title}\nReply: ${reply || 'see the console'}`, tag: key }); n.onclick = () => { window.focus(); openJob(job.id, { user: true, tab: 'story' }); }; } catch (e) { /* not allowed here */ }
  }
}
function paintNotify() {
  const b = $('#b-notify');
  b.setAttribute('aria-pressed', String(UI.notify));
  b.title = UI.notify ? 'Desktop notifications are on: you are told when a job needs you' : 'Desktop notifications when a job needs you (off)';
}
function toggleNotify() {
  if (!UI.notify && window.Notification && Notification.permission !== 'granted') {
    try { Notification.requestPermission().then((p) => { UI.notify = p === 'granted'; store.set('fc-notify', UI.notify ? '1' : '0'); paintNotify(); }); } catch (e) { /* unsupported */ }
    return;
  }
  UI.notify = !UI.notify;
  store.set('fc-notify', UI.notify ? '1' : '0');
  paintNotify();
}

// ---------- theme
