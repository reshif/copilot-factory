// factory inbox on the page: what waits on the human across jobs (a gate, a clarify turn, a park,
// a merge), with the chat reply and the terminal command, and where factory drive is. Read-only:
// the page never answers anything; a human-only command asks for its code on the user's terminal.
function paintInbox(ib) {
  const el = $('#inbox');
  if (!el) return;
  const items = (ib && ib.items) || [];
  const d = ib && ib.drive;
  el.hidden = !items.length && !d;
  if (el.hidden) { el.innerHTML = ''; return; }
  const driveLine = d ? `<p class="ib-drive">${d.running ? `<b>factory drive</b> is running ${esc(d.job || '')}${d.step ? `: <code>${esc(d.step)}</code>` : ''}` : `<b>factory drive</b> ${esc(d.status || 'stopped')}${d.last ? `: ${esc(d.last)}` : ''}`}</p>` : '';
  const row = (it) => `<li class="ib-item ib-${esc(it.kind)}"><span class="ib-job mono">${esc(it.job)}</span> <span class="ib-what">${esc(it.what || it.kind)}</span>${it.gate ? ` <span class="ib-gate mono">${esc(it.gate)} · ${esc(String(it.hash || '').slice(0, 12))}</span>` : ''}${it.since ? ` <span class="ib-since" data-ago="${Date.parse(it.since) || ''}">${esc(shortAgo(nowMs() - Date.parse(it.since)))}</span>` : ''}${it.next ? `<div class="ib-next">${esc(it.next)}</div>` : ''}<div class="ib-how">Reply in chat: ${(it.reply || []).map((r) => `<code>${esc(r)}</code>`).join(' · ')}${it.command ? ` &nbsp;or in your terminal: <code>${esc(it.command)}</code>${it.human_only ? ' <span class="ib-note">(it asks for a code shown on that terminal)</span>' : ''}` : ''}</div></li>`;
  el.innerHTML = `<h3>Waiting on you <span class="cnt">${items.length}</span></h3>${driveLine}${items.length ? `<ul>${items.map(row).join('')}</ul>` : '<p class="ib-none">Nothing waits on you.</p>'}`;
}
