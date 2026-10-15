function boot() {
  paintTheme();
  renderPicker();
  render();
  showIntro();
  bindTransport();
  siglegend();
  bindShell();
  ingest(DATA);
  UI.booted = true;
  seedSeen();
  paintFlags();
  renderCrew();
  applyHash(readHash());
  renderWire();
  connectLive();
}
boot();
// Text is measured for layout; redraw once the web fonts have loaded.
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => {
  stopRun();
  render();
  apply();
  if (selected) select(selected);
  if (LV.job && UI.view === 'job' && UI.jobTab === 'line') { const t = LV.t; const sl = $('#street').scrollLeft; buildFlow(LV.job); LV.shown = -2; renderAt(t); $('#street').scrollLeft = sl; }
  if (UI.view === 'lines') lmPaint();
});
window.addEventListener('resize', () => { if (!$('#view-plan').hidden) apply(); });
