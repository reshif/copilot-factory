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
  $('#flags').innerHTML = flags.join('');
  const hb = $('#f-health');
  if (hb) hb.addEventListener('click', () => { UI.wireHealth = !UI.wireHealth; if (UI.wireHealth && UI.view === 'job') { UI.wireOpen = true; $('#app').classList.add('wire-open'); } if (window.innerWidth <= 960) { const t = document.querySelector('.mtabs [data-mpane="wire"]'); if (t) t.click(); } paintFlags(); renderWire(); });
  $('#proj').textContent = DATA ? `${DATA.project} · read-only${DATA.plugin_version ? ` · factory ${DATA.plugin_version}` : ''}` : 'Software Factory · read-only';
  paintLed();
  $('#foot').innerHTML = DATA
    ? `${LIVE.on ? 'Streaming from' : 'Written'} by <code>factory console${LIVE.on ? ' --serve' : ''}</code> from <code>${esc(DATA.project)}/.factory/</code>: routing decisions, the ledger, the event log and job state, read without changing anything. ${LIVE.on ? 'Updates arrive as they happen.' : `Snapshot of ${esc(fmtDate(DATA.generated_at))}: re-run it to refresh, or run <code>factory console --serve</code> to watch live.`}`
    : 'Built from the factory\'s own definitions: recipes, skills, workflows, agents and the router\'s checks. Generate it with <code>factory console</code> to see real jobs.';
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
