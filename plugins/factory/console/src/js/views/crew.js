function renderCrew() {
  const used = {};
  if (DATA && DATA.jobs) {
    for (const job of DATA.jobs) for (const it of job.timeline) if (it.type === 'agents') for (const a of it.agents || []) {
      const u = (used[a.role] = used[a.role] || { n: 0, jobs: new Set(), models: new Set() });
      u.n += 1; u.jobs.add(job.id); if (a.model) u.models.add(a.model);
    }
  }
  const groups = [...new Set(Object.values(AGENTS).map((a) => a[0]))];
  $('#crew').innerHTML = groups.map((g) => {
    const list = Object.entries(AGENTS).filter(([, a]) => a[0] === g);
    return `<section class="crew-group"><h2>${esc(g)} <small>${list.length} agent${list.length > 1 ? 's' : ''}</small></h2><div class="agents">${list.map(([name, [, role, tools, write]]) => {
      const u = used[name];
      const usedLine = DATA ? (u ? `<span class="used">ran ${u.n}× in ${u.jobs.size} job${u.jobs.size > 1 ? 's' : ''}${u.models.size ? ` · ${esc([...u.models].join(', '))}` : ''}</span>` : '<span class="used none">not used in these jobs</span>') : '';
      return `<div class="panel agent-card"><div class="name"><b>factory:${esc(name)}</b><span class="badge ${write ? 'write' : 'read'}">${write ? 'can write' : 'read-only'}</span></div>
      <p>${esc(role)}</p>${usedLine}<div class="tools">${tools.map((t) => `<span>${esc(t)}</span>`).join('')}</div></div>`;
    }).join('')}</div></section>`;
  }).join('');
}

// ===================================================================== boot
