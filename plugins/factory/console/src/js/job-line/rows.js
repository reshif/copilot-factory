function buildRows(job, items) {
  const idx = (id) => job.steps.findIndex((s) => s.id === id);
  const rows = [];
  const rowOf = [];
  let cur = null;
  const start = (kind, step, i, extra) => { cur = { kind, step, first: i, items: [], ...(extra || {}) }; rows.push(cur); };
  const visits = {};
  let fixRounds = 0;
  items.forEach((it, i) => {
    if (it.type === 'created') start('start', 'request', i);
    else if (it.type === 'route' && it.step) {
      const from = cur ? cur.step : 'request';
      const back = idx(it.step) < idx(from);
      const same = it.step === from && cur && cur.kind === 'stop';
      visits[it.step] = (visits[it.step] || 0) + 1;
      if (back && /^row[45]\./.test(it.rule || '')) fixRounds += 1;
      start('stop', it.step, i, { back, same, rule: it.rule, scope: it.scope, visit: visits[it.step], fixRound: back && /^row[45]\./.test(it.rule || '') ? fixRounds : 0 });
    } else if (it.type === 'park') start('park', cur ? cur.step : 'request', i);
    else if (it.type === 'human' && it.action === 'resume') start('resume', cur ? cur.step : 'request', i);
    else if (it.type === 'stopped' || (it.type === 'human' && (it.action === 'cancelled' || it.action === 'abandoned'))) {
      if (!cur || cur.kind !== 'halt') start('halt', cur ? cur.step : 'request', i, { how: it.action || job.status });
      else if (it.action) cur.how = it.action;
    } else if (it.type === 'amend' && it.phase === 'start') start('amend', (job.steps.find((s) => s.stage === 'contract') || job.steps[0]).id, i, { id: it.id });
    else if (it.type === 'end' && job.status === 'closed') start('finish', job.steps[job.steps.length - 1].id, i);
    if (!cur) start('start', 'request', i);
    cur.items.push(i);
    rowOf[i] = rows.length - 1;
  });
  return { rows, rowOf };
}

function rowTitle(job, row) {
  const name = stepName(row.step);
  switch (row.kind) {
    case 'start': return ['Request submitted', [`${job.work_type} · ${job.risk} risk → ${job.recipe}`]];
    case 'park': return ['Parked', []];
    case 'resume': return ['Resumed by you', []];
    case 'halt': return [row.how === 'abandoned' ? 'Abandoned by you' : row.how === 'cancelled' ? 'Cancelled by you' : 'Stopped', []];
    case 'amend': return [`Amendment ${row.id || ''}`.trim(), ['contract changed mid-job']];
    case 'finish': return [job.pr && job.pr.merged ? 'Closed · merged' : 'Closed', []];
    default: {
      const tags = [];
      if (row.back) tags.push(row.fixRound ? `${/^row5/.test(row.rule) ? 'verify-fix' : 'fix'} round ${row.fixRound}` : /^row6/.test(row.rule) ? 'prove again' : 'back');
      else if (row.same) tags.push('again');
      if (row.visit > 1 && !row.back) tags.push(`visit ${row.visit}`);
      return [name, tags];
    }
  }
}

// Content lines of a row, each tied to the timeline item it came from.
function rowLines(job, row) {
  const lines = [];
  const items = LV.items;
  const t0 = Date.parse(items[row.first].t);
  const add = (i, text, cls, extra) => lines.push({ i, text, cls, ...(extra || {}) });
  if (row.kind === 'stop' && row.rule && row.rule !== 'order.next_step') add(row.first, `Why: ${RULES[row.rule] || row.rule}`, row.back ? 'why back' : 'why');
  if (row.kind === 'start') add(row.first, `“${job.title}”`, 'quote');
  for (const i of row.items) {
    const it = items[i];
    if (i === row.first && it.type !== 'park' && it.type !== 'amend' && it.type !== 'stopped') continue;
    switch (it.type) {
      case 'agents': add(i, `${it.workflow ? `${it.workflow}${it.config ? ` · ${it.config}` : ''}${it.mode ? ` (${it.mode})` : ''}` : 'agents seen by the hooks'} · ${it.runs} agent run${it.runs === 1 ? '' : 's'} · ${fmtDur(Date.parse(it.t) - t0)}`, 'wf', { agents: it.agents }); break;
      case 'result': {
        if (it.research && it.research.unknowns) { const x = it.research; add(i, `◎ ${x.scouts || x.verifiers ? `${x.unknowns} unknowns · ${x.confirmed}/${x.evidence} confirmed` : 'research reused'} · ${x.assumptions} assumed${(x.asked || []).length ? ` · ${x.asked.length} asked` : ''}${x.web === 'off' ? ' · web off' : x.web === 'unavailable' ? ' · no web' : ''}`, 'wf'); }
        add(i, `${it.ok ? '✓' : it.outcome === 'ask' ? '?' : '✕'} ${it.text}`, it.ok ? 'ok' : it.outcome === 'ask' ? 'ask' : 'bad');
        for (const f of (it.findings || []).filter((x) => x.status === 'confirmed' || x.status === 'unverified').slice(0, 3)) add(i, `⚑ ${f.id} · ${f.severity} · ${f.status}: ${f.summary}`, f.status === 'confirmed' ? 'bad find' : 'ask find');
        break;
      }
      case 'clarify': add(i, `${it.waiting ? '?' : it.outcome === 'park' ? '⏸' : '·'} ${it.text}`, it.waiting ? 'ask' : it.outcome === 'park' ? 'bad' : 'wf'); break;
      case 'human': {
        const g = it.gate || stepName(it.step);
        const wait = fmtDur(Date.parse(it.t) - t0);
        if (it.action === 'approve') add(i, `✓ You approved ${g}${it.via ? ` (${it.via})` : ''} · after ${wait}`, 'you');
        else if (it.action === 'deny') add(i, `✕ You denied ${g}${it.reason ? `: ${it.reason}` : ''}`, 'you bad');
        else if (it.action === 'merged') add(i, `⇢ You merged${it.commit ? ` ${it.commit}` : ''} · after ${wait}`, 'you');
        else if (it.action === 'resume') add(i, `▶ You resumed the job${row.kind === 'resume' ? '' : ''}`, 'you');
        else if (it.action === 'cancelled' || it.action === 'abandoned') add(i, `${it.reason || ''}`, 'you bad');
        else if (it.action === 'change_assumption') add(i, `✎ You overrode ${it.assumption || 'an assumption'}${it.value ? `: ${it.value}` : ''}`, 'you');
        else if (it.action === 'drop_assumption') add(i, `✎ You dropped ${it.assumption || 'an assumption'}`, 'you');
        else add(i, `You: ${it.action}${it.reason ? ` — ${it.reason}` : ''}`, 'you');
        break;
      }
      case 'park': add(i, `⏸ ${it.text}`, 'park'); break;
      case 'stopped': if (it.text) add(i, it.text, 'bad'); break;
      case 'amend': add(i, it.phase === 'start' ? `✎ ${it.text}` : it.phase === 'submit' ? `↗ ${it.text}` : `⟲ ${it.text}`, 'amend'); break;
      case 'spawn': add(i, `→ ${it.text}`, 'link', { job: it.job }); break;
      case 'guard': {
        // repeats of the same block on one row are counted, not listed
        const prev = lines.find((l) => l.guardKey === `${it.who}|${it.text}|${it.target}`);
        if (prev) { prev.times += 1; prev.text = `⚠ ${prev.base} (×${prev.times})`; break; }
        const base = `${it.text}${it.who ? ` — by ${it.who}` : ''}`;
        add(i, `⚠ ${base}`, 'warn', { guardKey: `${it.who}|${it.text}|${it.target}`, base, times: 1 });
        if (it.target) add(i, `$ ${it.target}`, 'cmd');
        break;
      }
      case 'refused': case 'hook_error': case 'stop_block': case 'unparsed': add(i, `⚠ ${it.text}`, 'warn'); break;
      case 'error': add(i, `✕ ${it.text}`, 'bad'); break;
      case 'route': if (it.action === 'parked') add(i, `Router parked the job: ${RULES[it.rule] || it.rule}`, 'bad'); break;
      default: break;
    }
  }
  return lines;
}

// chips: one per role in one agents item
function chipsFor(agents) {
  const by = new Map();
  for (const a of agents || []) {
    const c = by.get(a.role) || { role: a.role, n: 0, models: [], retries: 0, fails: 0 };
    c.n += 1;
    if (a.model && !c.models.includes(a.model)) c.models.push(a.model);
    if (a.retry || /^build \S+ #([2-9]|\d{2,})/.test(a.label || '')) c.retries += 1;
    if (BAD_OUTCOME.has(a.outcome)) c.fails += 1;
    by.set(a.role, c);
  }
  return [...by.values()].map((c) => {
    const suffix = `${c.retries ? ` ↻${c.retries}` : ''}${c.fails ? ` ✕${c.fails}` : ''}${c.models.length > 1 ? ` ↑${modelLetter(c.models[c.models.length - 1])}` : ''} ×${c.n}`;
    const w = Math.ceil(textW(c.role + suffix, CHIP_FONT)) + (c.models.length ? 30 : 18);
    return { ...c, suffix, w };
  });
}

function measureRow(job, row, geo) {
  const x = geo.col[row.step] || geo.col.request;
  const lw = FG.LABEL_W;
  const left = x + 18 + lw > geo.gridRight + (geo.insp ? 0 : 10) && x - 18 - lw > FG.TIME_W;
  const [title, tags] = rowTitle(job, row);
  const lines = rowLines(job, row);
  const laid = [];
  let h = FG.NODE_Y + 6;
  for (const ln of lines) {
    if (ln.agents) {
      laid.push({ ...ln, y: h, kind: 'text', wrapped: [ln.text] });
      h += FG.LINE_H;
      let cx = 0;
      let cy = h;
      const chips = chipsFor(ln.agents).map((c) => {
        if (cx + c.w > lw && cx > 0) { cx = 0; cy += FG.CHIP_H + FG.CHIP_GAP; }
        const o = { ...c, dx: cx, y: cy };
        cx += c.w + 5;
        return o;
      });
      laid.push({ ...ln, kind: 'chips', chips, y: h });
      h = cy + FG.CHIP_H + FG.CHIP_GAP + 2;
    } else {
      const wrapped = wrap(ln.text, BODY_FONT, lw).slice(0, 3);
      laid.push({ ...ln, kind: 'text', wrapped, y: h });
      h += wrapped.length * FG.LINE_H;
    }
  }
  return { x, left, title, tags, laid, h: Math.max(h + 6, 34) + FG.TRANSIT };
}

// ---------- build the canvas for one job
