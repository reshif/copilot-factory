// The design at a gate (0.11): what / how / where in one place — the decision records as a table,
// every diagram drawn (mermaid.js; the source when it cannot draw it) and the project layout
// tree with each file's owner task. `d` is the CLI's design view (cli/core/design.js view()).
function designHtml(d) {
  if (!d) return '';
  const P = [`<div class="dsg"><div class="eh">Design · what, how, where</div><p class="meta">${esc(d.summary || '')}</p>`];
  if ((d.decisions || []).length) {
    P.push(`<table class="dsg-t"><thead><tr><th>Decision</th><th>Chosen</th><th>Rejected</th><th>Why</th><th>Revisit when</th></tr></thead><tbody>${d.decisions.map((x) => `<tr><td><b>${esc(x.id)}</b> ${esc(x.title || '')}</td><td>${esc(x.chosen || '—')}</td><td>${esc((x.options || []).filter((o) => o.option !== x.chosen).map((o) => `${o.option}${o.verdict ? ` (${o.verdict})` : ''}`).join('; ') || '—')}</td><td>${esc(x.why || '—')}</td><td>${esc(x.revisit || '—')}</td></tr>`).join('')}</tbody></table>`);
  }
  for (const g of d.diagrams || []) {
    let r = { svg: null, partial: false, unknown: [], reason: null };
    try { r = mermaidRender(g.source); } catch { r = { svg: null, partial: false, unknown: [], reason: 'not drawn' }; }
    const svg = r.svg;
    // drawn only in part, or not at all: the source is open next to it (release review m1)
    const note = r.partial ? ` · partly drawn: ${r.unknown.length} line(s) not understood — check the source` : !svg && r.reason ? ` · ${r.reason}` : '';
    P.push(`<figure class="dsg-fig"><figcaption>${esc(g.section || 'Diagram')} <span class="meta">${esc(g.type || 'mermaid')}${g.ok === false ? ' · malformed' : ''}${esc(note)}</span></figcaption>${svg ? `<div class="dsg-svg">${svg}</div>` : ''}<details${svg && !r.partial ? '' : ' open'}><summary>mermaid source</summary>${r.partial ? `<p class="meta bad">Not drawn: ${r.unknown.map((x) => `<code>${esc(x)}</code>`).join(' ')}</p>` : ''}<pre>${esc(g.source)}</pre></details></figure>`);
  }
  if (d.layout) {
    const L = d.layout;
    P.push(`<div class="eh">Project layout${L.planned ? ' · owner task per file' : ' · tasks are assigned at decompose'}</div><table class="dsg-t dsg-tree"><thead><tr><th>File</th><th>Status</th><th>Task</th><th>ACs</th><th>Responsibility</th></tr></thead><tbody>${(L.files || []).map((f) => {
      const depth = f.path.split('/').length - 1;
      const owner = (f.owners || []).join(', ');
      const bad = L.planned && ['new', 'changed', 'deleted'].includes(f.status) && (f.owners || []).length !== 1;
      return `<tr class="st-${esc(f.status || 'none')}"><td><code style="padding-left:${depth * 12}px">${esc(f.path.split('/').pop())}</code><span class="meta"> ${esc(f.path.split('/').slice(0, -1).join('/'))}</span></td><td>${esc(f.status || '?')}</td><td${bad ? ' class="bad"' : ''}>${esc(owner || (L.planned ? (bad ? 'no owner' : '—') : '—'))}</td><td>${esc((f.acs || []).join(', ') || '—')}</td><td>${esc(f.responsibility || '')}</td></tr>`;
    }).join('')}</tbody></table>`);
    if ((L.problems || []).length) P.push(`<ul>${L.problems.map((p) => `<li class="bad">${esc(p)}</li>`).join('')}</ul>`);
  }
  if (d.runs) P.push(`<div class="eh">How it runs</div><pre class="dsg-runs">${esc(d.runs)}</pre>`);
  if ((d.legacy || []).length) P.push(`<p class="meta">Written under an older template (${esc(d.legacy.join(', '))}): no layout or flow was required.</p>`);
  P.push('</div>');
  return P.join('');
}
