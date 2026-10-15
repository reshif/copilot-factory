const AGE = (m) => { const a = nowMs() - m.updated; return a < 3600e3 ? '< 1 hour' : a < 864e5 ? '< 1 day' : a < 6048e5 ? '< 1 week' : 'older'; };
const FACETS = [
  ['status', 'Status', (m) => m.bucket, (k) => BUCKET_NAME[k] || k, BUCKETS.map((b) => b[0])],
  ['recipe', 'Recipe', (m) => m.job.recipe || '—', null, null],
  ['risk', 'Risk', (m) => m.job.risk || '—', null, ['high', 'medium', 'low']],
  ['gate', 'Waiting at', (m) => m.gate || (m.bucket === 'parked' ? 'parked (resume)' : null), (k) => (STEP_INFO[k] ? STEP_INFO[k][0] : k), null],
  ['insp', 'Inspector', (m) => (m.findings ? 'open findings' : m.findingsTotal ? 'settled findings' : 'no findings'), null, ['open findings', 'settled findings', 'no findings']],
  ['shape', 'Shape', (m) => (m.job.epic ? 'epic' : m.job.parent ? 'slice of an epic' : m.job.followup_of ? 'follow-up' : 'single job'), null, ['single job', 'epic', 'slice of an epic', 'follow-up']],
  ['age', 'Updated', AGE, null, ['< 1 hour', '< 1 day', '< 1 week', 'older']],
];
const facetSet = (k) => (UI.facets[k] = UI.facets[k] || new Set());
function facetOk(m, except) {
  for (const [k, , fn] of FACETS) {
    if (k === except) continue;
    const s = UI.facets[k];
    if (s && s.size && !s.has(fn(m))) return false;
  }
  return true;
}

// ---------- grouping and order
