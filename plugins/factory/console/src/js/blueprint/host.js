// ===================================================================== blueprint: the host
// The Blueprint view is a display ported from claude-software-factory's console: it mounts once
// into #bp-root and takes every later update. APP is the small namespace the ported files use
// (APP.words, APP.epicPick, APP.displays.register); nothing else in this page reads it.
var APP = {};
APP.displays = (function () {
  const list = [];
  const themeFns = [];
  const resolvedTheme = () => {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  };
  const api = {
    copy(text, button) {
      const done = (msg) => { if (!button) return; const old = button.textContent; button.textContent = msg; setTimeout(() => { button.textContent = old; }, 1400); };
      try { navigator.clipboard.writeText(text).then(() => done('Copied'), () => done('Select and copy')); } catch (e) { done('Select and copy'); }
    },
    theme: resolvedTheme,
    onTheme(fn) { themeFns.push(fn); },
    openClassic(view) { setView(view || 'board'); },
    get words() { return APP.words; },
  };
  if (window.MutationObserver) {
    new MutationObserver(() => { for (const f of themeFns) { try { f(resolvedTheme()); } catch (e) { /* a display's problem stays its own */ } } })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  return { register(d) { list.push(d); }, get(id) { return list.find((d) => d.id === id) || null; }, api };
})();

const BP = { mounted: false, rev: '' };
// the jobs, and an Autopilot sighting (not part of any job) so the gate-safety note follows it live
const bpRev = () => ((DATA && DATA.jobs) || []).map((j) => jobRev(j)).join('|') + (DATA && DATA.autopilot ? `|ap:${DATA.autopilot.last_at}:${DATA.autopilot.recent}` : '');
function showBlueprint() {
  const d = APP.displays.get('blueprint');
  const root = $('#bp-root');
  if (!d || !root) return;
  if (!BP.mounted) {
    root.textContent = '';
    try { d.mount(root, toDisplay(DATA), APP.displays.api); BP.mounted = true; BP.rev = bpRev(); } catch (e) {
      root.textContent = `The Blueprint could not draw this data: ${e.message}`;
    }
    return;
  }
  updateBlueprint();
}
// called on every ingest: a mounted Blueprint keeps the reader's sheet, selection and replay place
function updateBlueprint() {
  if (!BP.mounted) return;
  const rev = bpRev();
  if (rev === BP.rev) return;
  BP.rev = rev;
  const d = APP.displays.get('blueprint');
  try { d.update(toDisplay(DATA)); } catch (e) { /* the next update tries again */ }
}
