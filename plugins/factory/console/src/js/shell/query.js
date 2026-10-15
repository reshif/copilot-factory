const QTOKENS = ['is:waiting', 'is:running', 'is:parked', 'is:stopped', 'is:done', 'is:unread', 'risk:high', 'risk:medium', 'risk:low', 'recipe:bug@low', 'gate:H2', 'gate:any', 'has:finding', 'has:rework', 'has:retry', 'has:agents', 'has:guard', 'agent:builder', 'stage:build', 'since:2d', 'since:3h'];
function parseQ(q) {
  const out = { toks: [], words: [] };
  for (const part of String(q || '').trim().split(/\s+/).filter(Boolean)) {
    const m = /^(-?)(is|risk|recipe|gate|has|agent|since|stage|id|status):(.+)$/i.exec(part);
    if (m) out.toks.push({ neg: Boolean(m[1]), k: m[2].toLowerCase(), v: m[3].toLowerCase() });
    else out.words.push(part.toLowerCase());
  }
  return out;
}
function fuzzy(word, text) {
  let i = 0;
  let first = -1;
  for (let k = 0; k < text.length && i < word.length; k++) if (text[k] === word[i]) { if (first < 0) first = k; i += 1; if (i === word.length) return k - first <= word.length * 2.5; }
  return false;
}
const unreadOf = (m) => Boolean(SEEN[m.id]) && SEEN[m.id] !== m.rev;
function tokOk(m, t) {
  const j = m.job;
  switch (t.k) {
    case 'is': case 'status': {
      const v = { waiting: 'turn', yours: 'turn', turn: 'turn', 'your-turn': 'turn', blocked: 'stopped', failed: 'stopped', closed: 'done', merged: 'done' }[t.v] || t.v;
      if (BUCKET_NAME[v]) return m.bucket === v;
      if (v === 'active') return j.status === 'active';
      if (v === 'cancelled' || v === 'abandoned') return j.status === v;
      if (v === 'epic') return Boolean(j.epic);
      if (v === 'child') return Boolean(j.parent);
      if (v === 'followup' || v === 'follow-up') return Boolean(j.followup_of);
      if (v === 'unread') return unreadOf(m);
      return false;
    }
    case 'risk': return String(j.risk || '').toLowerCase().startsWith(t.v);
    case 'recipe': return String(j.recipe || '').toLowerCase().startsWith(t.v);
    case 'gate': return t.v === 'any' ? Boolean(m.gate) : String(m.gate || '').toLowerCase() === t.v;
    case 'has': return ({ finding: m.findingsTotal > 0, findings: m.findingsTotal > 0, rework: m.loops > 0, retry: m.retries > 0, retries: m.retries > 0, agents: (j.running_agents || []).length > 0, running: (j.running_agents || []).length > 0, tasks: m.tasksTotal > 0, guard: m.guards > 0, amend: m.amends > 0, followup: m.spawned.length > 0 || Boolean(j.followup_of), lessons: (j.lessons || []).length > 0, pr: Boolean(j.pr) })[t.v] || false;
    case 'agent': return [...m.roles].some((r) => r.includes(t.v)) || (j.running_agents || []).some((a) => roleShort(a.agent_type).includes(t.v));
    case 'since': { const d = durTok(t.v); return d ? m.updated >= nowMs() - d : true; }
    case 'stage': return String(m.stage).startsWith(t.v);
    case 'id': return m.id.toLowerCase().includes(t.v);
    default: return true;
  }
}
function qOk(m, pq) {
  for (const t of pq.toks) if (tokOk(m, t) === t.neg) return false;
  for (const w of pq.words) {
    if (m.id.toLowerCase().includes(w) || m.titleL.includes(w) || m.hay.includes(w)) continue;
    if (w.length >= 3 && fuzzy(w, m.titleL)) continue;
    return false;
  }
  return true;
}

// ---------- facets
