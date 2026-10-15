function paintLed() {
  const led = $('#led');
  const state = LIVE.on ? (LIVE.connected ? 'live' : 'reconnecting') : 'snapshot';
  led.dataset.led = state;
  led.querySelector('span').textContent = state;
  led.title = state === 'live' ? 'Streaming from factory console --serve: the page updates as hooks and the CLI write to .factory/' : state === 'reconnecting' ? 'Lost the connection to factory console --serve; retrying' : 'A file written by factory console: run factory console --serve to watch live';
  paintClock();
}
function paintClock() {
  if (!DATA) { $('#clk').textContent = ''; return; }
  const at = LIVE.on && LIVE.lastAt ? LIVE.lastAt : Date.parse(DATA.generated_at);
  $('#clk').innerHTML = `${LIVE.on ? 'updated' : 'snapshot'} <b>${esc(fmtClock(new Date(at).toISOString()))}</b><br>${esc(shortAgo(nowMs() - at) === 'now' ? 'just now' : `${shortAgo(nowMs() - at)} ago`)}`;
}
function tickAgo() {
  document.querySelectorAll('[data-ago]').forEach((e) => { e.textContent = shortAgo(nowMs() - +e.dataset.ago); });
  document.querySelectorAll('.bnow .w[data-since]').forEach((e) => { if (e.dataset.since) e.textContent = `waits ${shortAgo(nowMs() - +e.dataset.since)}`; });
  paintClock();
}

// ---------- views and the URL
