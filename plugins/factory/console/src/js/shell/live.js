const LIVE = { on: false, connected: false, lastAt: 0 };
function healthOpen() { return ((DATA && DATA.inspector && DATA.inspector.health) || []).filter((f) => f.status === 'open'); }
function paintFlags() {
  const flags = [];
  if (DATA && DATA.label) flags.push(`<span class="flag sample" title="${esc(DATA.label)}">${esc(DATA.label)}</span>`);
  if (DATA) {
    const s = DATA.integrity && DATA.integrity.status;
    flags.push(s === 'verified' ? `<span class="flag ok" title="${DATA.integrity.valid} sealed records checked">seals verified</span>` : s === 'tampered' ? `<span class="flag bad" title="${DATA.integrity.invalid} records fail their seal">seal mismatch</span>` : '<span class="flag unk" title="This machine has no factory key, so seals were not checked">seals not checked</span>');
    const h = healthOpen();
    if (h.length) flags.push(`<button type="button" class="flag bad" id="f-health" aria-pressed="${UI.wireHealth}" style="cursor:pointer;background:none" title="${esc(h.map((f) => `${f.id} ${f.rule}: ${f.summary}`).join('\n'))}">⚑ ${h.length} health</button>`);
  }
  const ap = DATA && DATA.autopilot;
  if (ap) flags.push(`<span class="flag ${ap.recent ? 'bad' : 'unk'}" title="${esc(autopilotText(ap))}">⚠ autopilot</span>`);
  $('#flags').innerHTML = flags.join('');
  paintAutopilot(ap);
  paintInbox(DATA && DATA.inbox);
  const hb = $('#f-health');
  if (hb) hb.addEventListener('click', () => { UI.wireHealth = !UI.wireHealth; if (UI.wireHealth && UI.view === 'job') { UI.wireOpen = true; $('#app').classList.add('wire-open'); } if (window.innerWidth <= 960) { const t = document.querySelector('.mtabs [data-mpane="wire"]'); if (t) t.click(); } paintFlags(); renderWire(); });
  $('#proj').textContent = DATA ? `${DATA.project} · read-only${DATA.plugin_version ? ` · factory ${DATA.plugin_version}` : ''}` : 'Software Factory · read-only';
  paintLed();
  $('#foot').innerHTML = DATA
    ? `${LIVE.on ? 'Streaming from' : 'Written'} by <code>factory console${LIVE.on ? ' --serve' : ''}</code> from <code>${esc(DATA.project)}/.factory/</code>: routing decisions, the ledger, the event log and job state, read without changing anything. ${LIVE.on ? 'Updates arrive as they happen.' : `Snapshot of ${esc(fmtDate(DATA.generated_at))}: re-run it to refresh, or run <code>factory console --serve</code> to watch live.`}`
    : 'Built from the factory\'s own definitions: recipes, skills, workflows, agents and the router\'s checks. Generate it with <code>factory console</code> to see real jobs.';
}
// Copilot's Autopilot answers prompts by itself and keeps going past the factory's stops, so it
// could answer a gate for the user. The prompt hook records a sighting (.factory/autopilot.json);
// the Board and the Wire say so plainly while it is recent, and quietly after.
function autopilotText(ap) {
  return ap.recent
    ? `Copilot Autopilot was seen in this project (last ${fmtDate(ap.last_at)}). Autopilot answers prompts by itself and keeps going past the factory's stops, so it could answer a gate for you. Switch Copilot back to interactive mode (Shift+Tab, or /autopilot off) for factory work.`
    : `Copilot Autopilot was last seen in this project ${fmtDate(ap.last_at)}, more than ${ap.window_hours || 6} h ago. While it is on, it could answer a gate for you.`;
}
function paintAutopilot(ap) {
  for (const id of ['#ap-board', '#ap-wire']) {
    const el = $(id);
    if (!el) continue;
    el.hidden = !ap;
    if (!ap) { el.innerHTML = ''; continue; }
    el.className = `apwarn${id === '#ap-wire' ? ' sm' : ''}${ap.recent ? '' : ' old'}`;
    el.innerHTML = `<b>⚠ ${ap.recent ? 'Autopilot seen: gates at risk' : 'Autopilot seen earlier'}</b> <span>${esc(id === '#ap-wire' ? `last ${fmtDate(ap.last_at)}: it may answer gates for you.` : autopilotText(ap))}</span>`;
  }
}
function connectLive() {
  if (!DATA || !DATA.live || !/^https?:$/.test(location.protocol) || !window.EventSource) { paintLed(); return; }
  LIVE.on = true;
  LIVE.lastAt = nowMs();
  const es = new EventSource('events');
  es.addEventListener('open', () => { LIVE.connected = true; paintLed(); });
  es.addEventListener('error', () => { LIVE.connected = false; paintLed(); }); // EventSource retries by itself
  es.addEventListener('data', (e) => {
    let next;
    try { next = JSON.parse(e.data); } catch (err) { return; } // keep the last good page
    LIVE.connected = true;
    ingest(next, { live: true });
  });
  paintFlags();
  renderWire();
}

// ===================================================================== crew
