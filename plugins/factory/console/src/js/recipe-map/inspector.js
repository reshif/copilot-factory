function agentRows(names) {
  return names.filter((a) => AGENTS[a]).map((a) => {
    const [, role, tools, write] = AGENTS[a];
    return `<div class="agentrow"><b>factory:${esc(a)}</b><span>${esc(role)}</span><span class="t">${tools.join(' · ')} — ${write ? 'can write' : 'read-only'}</span></div>`;
  }).join('');
}
function inRecipes(n) {
  return Object.keys(RECIPES).filter((r) => {
    const keep = recipe;
    recipe = r;
    const ok = nodeActive(n);
    recipe = keep;
    return ok;
  });
}
function showNode(n) {
  const d = n.detail || {};
  const st = STAGES.find((s) => s.id === n.stage);
  const kind = n.type === 'agentnode' ? 'agent' : n.type;
  const parts = [`<div><span class="kindtag k-${kind}">${kind === 'cli' ? 'factory cli' : kind}</span> <span class="label">stage ${STAGES.indexOf(st) + 1} · ${esc(st.name)}</span></div>`, `<h3>${esc(n.title)}</h3>`, `<p>${esc(d.what || '')}</p>`];
  if (d.agents) parts.push(`<div class="label">Agents it puts together</div>${agentRows(d.agents)}`);
  if (d.skills) parts.push(`<div class="label">Skills Copilot follows</div><div class="chips">${d.skills.map((s) => `<span class="chip skill">${esc(s)}</span>`).join('')}</div>`);
  if (d.cmds) parts.push(`<div class="label">Commands</div><div class="chips">${d.cmds.map((s) => `<span class="chip cli">${esc(s)}</span>`).join('')}</div>`);
  if (d.you) parts.push(`<div class="label">Your part</div><div class="chips">${d.you.map((s) => `<span class="chip you">${esc(s)}</span>`).join('')}</div>`);
  if (d.outputs) parts.push(`<div class="label">Produces</div><div class="chips">${d.outputs.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>`);
  if (d.floors) parts.push(`<div class="label">Floor</div><p>${esc(d.floors)}</p>`);
  const rs = inRecipes(n);
  parts.push(`<div class="label">Runs in</div><div class="chips">${Object.keys(RECIPES).map((r) => `<span class="chip${rs.includes(r) ? '' : ' off'}">${esc(r)}</span>`).join('')}</div>`);
  $('#side').innerHTML = parts.join('');
}
function showStage(st) {
  selected = null;
  document.querySelectorAll('.node.sel').forEach((x) => x.classList.remove('sel'));
  const nodes = st.nodes.filter(nodeActive);
  const agents = [...new Set(st.nodes.flatMap((n) => (n.detail && n.detail.agents) || []))];
  const skills = [...new Set(st.nodes.flatMap((n) => (n.detail && n.detail.skills) || []))];
  $('#side').innerHTML = `<div><span class="kindtag k-stage">stage ${STAGES.indexOf(st) + 1}</span></div><h3>${esc(st.name)}</h3><p>${esc(st.what)}</p>
    <div class="label">In ${esc(recipe)}</div><div class="chips">${nodes.map((n) => `<span class="chip">${esc(n.title)}</span>`).join('') || '<span class="chip off">not used by this recipe</span>'}</div>
    ${skills.length ? `<div class="label">Skills</div><div class="chips">${skills.map((s) => `<span class="chip skill">${esc(s)}</span>`).join('')}</div>` : ''}
    ${agents.length ? `<div class="label">Agents</div>${agentRows(agents)}` : ''}`;
}
function showIntro() {
  $('#side').innerHTML = `<div class="label">How to read it</div><h3>From your request to a merged change</h3>
    <p>Left to right, eight stages. Inside each, top to bottom, what happens in order. Above them all, the router picks every step; along the bottom, enforcement that never switches off.</p>
    <p>Workflow boxes show their agents: a column runs in parallel, the lines show fan-out and fan-in. Red dashed curves are the loops back to Build when review or proof fails.</p>
    <p>Click a stage name or any box for details, or press <b>Run a request</b> to follow one through ${esc(recipe)}.</p>`;
}
function select(id) {
  selected = id;
  document.querySelectorAll('.node').forEach((x) => x.classList.toggle('sel', x.dataset.id === id));
  showNode(LAYOUT.nodes[id]);
  if (window.innerWidth <= 1000 && !run) $('#side').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ===================================================================== pan + zoom
