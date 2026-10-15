function paintTheme() {
  const root = document.documentElement;
  if (UI.theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', UI.theme);
  $('#b-theme').title = `Theme: ${UI.theme === 'auto' ? 'follows your system' : UI.theme} (click to change)`;
  $('#b-theme').setAttribute('aria-label', $('#b-theme').title);
}
function cycleTheme() {
  UI.theme = { auto: 'dark', dark: 'light', light: 'auto' }[UI.theme] || 'auto';
  store.set('fc-theme', UI.theme);
  paintTheme();
  if (LV.job && UI.view === 'job') { const t = LV.t; buildFlow(LV.job); LV.shown = -2; renderAt(t); }
}

// ---------- header: LED, clock, flags
