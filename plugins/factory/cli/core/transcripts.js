'use strict';
// Agent transcripts and usage (P4.1). `factory run` streams each agent's Copilot JSONL to
// .factory/scratch/runs/<job>/<run>/<label>.jsonl as it arrives (every spawn of one agent:
// its first turn, a format correction, a builder's time-up turn, appended to the same file),
// and reads what the CLI reports about the run from the same stream:
//
//   tool.execution_start         → tool_calls, last_tool
//   assistant.usage (per call)   → input/output/cache/reasoning tokens and `cost` (the model
//                                  multiplier), summed; the models used
//   session.usage_checkpoint     → session_nano_aiu, session_premium_requests (session-wide)
//   session.shutdown             → session_premium_requests, api_duration_ms (session-wide)
//
// Event names and fields: docs/research/copilot-cli-usage.md §1 (the SDK's session events; the
// `-p` JSONL schema itself is not documented). A field no record carried stays null and
// `usage.reported` is false when no usage record arrived: unknown is never shown as zero.
// The session-wide totals are cumulative for the session (a resumed builder attempt carries
// the earlier attempts'), so reports take the largest value per session id, never a sum.
//
// Size caps: a transcript that passes copilot.transcript_max_bytes is rotated to
// <label>.1.jsonl (one older part is kept), so an agent keeps at most twice the cap on disk;
// the counts above come from the stream, so they stay complete. On disk, at each run's start
// (pruneAll): the newest copilot.transcript_keep_runs runs per job and workflow; a closed,
// cancelled or abandoned job's transcripts after copilot.transcript_closed_days, and beyond the
// newest copilot.transcript_keep_jobs such jobs; then, while .factory/scratch/runs is over
// copilot.transcript_max_total_bytes, the oldest run folders first. The run in progress (and any
// run whose job holds a live run lock) is never pruned. A link to a pruned transcript shows as
// "pruned" in the console.
//
// Redaction: what is written (transcripts and stderr logs) passes through redact(): tokens that
// look like GitHub, OpenAI/Anthropic, AWS or Slack credentials, bearer tokens, private keys and
// NAME=value pairs whose name says secret, token, password or key are replaced by «redacted».
// Best effort: Copilot redacts its own JSON output only since 1.0.97. .factory/ is kept out of git
// (setup.js writes it to .git/info/exclude).

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_KEEP_RUNS = 30;
const DEFAULT_TOTAL_BYTES = 500 * 1024 * 1024;
const DEFAULT_CLOSED_DAYS = 14;
const DEFAULT_KEEP_JOBS = 20;

// Obvious secrets, replaced before anything reaches disk.
const SECRET_PATTERNS = [
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(sk-(?:ant-)?[A-Za-z0-9_-]{20,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const SECRET_ASSIGN = /\b([A-Za-z0-9_]*?(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"'\\]{6,})/gi;
function redact(text) {
  let t = String(text);
  for (const re of SECRET_PATTERNS) t = t.replace(re, (m, a) => (/^Bearer/i.test(m) ? `${a}«redacted»` : '«redacted»'));
  return t.replace(SECRET_ASSIGN, (_, name, eq, q) => `${name}${eq}${q}«redacted»`);
}
const STDERR_TAIL = 4000;

const runsDir = (root, jobId) => path.join(root, '.factory', 'scratch', 'runs', jobId);
const safe = (label) => String(label || 'agent').replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'agent';

function limits(cp = {}) {
  const n = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
  return { maxBytes: n(cp.transcript_max_bytes, DEFAULT_MAX_BYTES), keepRuns: n(cp.transcript_keep_runs, DEFAULT_KEEP_RUNS), totalBytes: n(cp.transcript_max_total_bytes, DEFAULT_TOTAL_BYTES), closedDays: n(cp.transcript_closed_days, DEFAULT_CLOSED_DAYS), keepJobs: n(cp.transcript_keep_jobs, DEFAULT_KEEP_JOBS) };
}

// What the CLI reported, from its JSONL records.
function tracker() {
  const u = { api_calls: 0, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null, cost: null, models: [], session_premium_requests: null, session_nano_aiu: null, api_duration_ms: null };
  // tool_calls stays null (unknown) until the stream shows the CLI reports events at all (an
  // assistant message or a tool event); usage is "reported" only once a numeric field arrived
  const s = { tool_calls: 0, last_tool: null, session: null, reported: false, events: false };
  const num0 = (v) => typeof v === 'number' && Number.isFinite(v);
  const add = (k, v) => {
    if (typeof v === 'number' && Number.isFinite(v)) u[k] = (u[k] || 0) + v;
  };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    feed(o) {
      if (!o || typeof o !== 'object' || typeof o.type !== 'string') return;
      const d = o.data && typeof o.data === 'object' ? o.data : {};
      switch (o.type) {
        case 'session.start':
          if (typeof d.sessionId === 'string' && d.sessionId) s.session = d.sessionId;
          break;
        case 'assistant.message':
          s.events = true;
          break;
        case 'tool.execution_start':
          s.events = true;
          s.tool_calls += 1;
          if (typeof d.toolName === 'string') s.last_tool = d.toolName;
          break;
        case 'assistant.usage':
          if (['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'cost'].some((k) => num0(d[k]))) s.reported = true;
          u.api_calls += 1;
          add('input_tokens', d.inputTokens);
          add('output_tokens', d.outputTokens);
          add('cache_read_tokens', d.cacheReadTokens);
          add('cache_write_tokens', d.cacheWriteTokens);
          add('reasoning_tokens', d.reasoningTokens);
          add('cost', d.cost);
          if (typeof d.model === 'string' && d.model && !u.models.includes(d.model)) u.models.push(d.model);
          break;
        case 'session.usage_checkpoint':
          if (num0(d.totalNanoAiu) || num0(d.totalPremiumRequests)) s.reported = true;
          if (num(d.totalNanoAiu) !== null) u.session_nano_aiu = Math.max(u.session_nano_aiu || 0, d.totalNanoAiu);
          if (num(d.totalPremiumRequests) !== null) u.session_premium_requests = Math.max(u.session_premium_requests || 0, d.totalPremiumRequests);
          break;
        case 'session.shutdown':
          if (num0(d.totalPremiumRequests) || num0(d.totalApiDurationMs)) s.reported = true;
          if (num(d.totalPremiumRequests) !== null) u.session_premium_requests = Math.max(u.session_premium_requests || 0, d.totalPremiumRequests);
          if (num(d.totalApiDurationMs) !== null) u.api_duration_ms = Math.max(u.api_duration_ms || 0, d.totalApiDurationMs);
          if (typeof d.currentModel === 'string' && d.currentModel && !u.models.includes(d.currentModel)) u.models.push(d.currentModel);
          break;
        default:
      }
    },
    result() {
      return { tool_calls: s.events ? s.tool_calls : null, last_tool: s.last_tool, reported_session: s.session, usage: s.reported ? { reported: true, ...u, models: u.models.slice() } : { reported: false } };
    },
  };
}

// One agent's transcript: append stdout chunks as they arrive, parse each complete line.
function open(file, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const t = tracker();
  let partial = '';
  let size = 0;
  let broken = false;
  try {
    if (!file) throw new Error('no transcript file'); // counts only
    fs.mkdirSync(path.dirname(file), { recursive: true });
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch {
    broken = true;
  }
  const rotated = file ? file.replace(/\.jsonl$/, '.1.jsonl') : null;
  const line = (l) => {
    const x = l.trim();
    if (!x || x[0] !== '{') return;
    try {
      t.feed(JSON.parse(x));
    } catch {
      /* not a JSONL record */
    }
  };
  return {
    file,
    write(chunk) {
      const text = String(chunk);
      const parts = (partial + text).split('\n');
      partial = parts.pop();
      parts.forEach(line);
      if (broken) return;
      try {
        const safeText = redact(text);
        fs.appendFileSync(file, safeText);
        size += Buffer.byteLength(safeText);
        if (size > maxBytes) {
          fs.renameSync(file, rotated); // one older part kept; the stream's counts stay complete
          size = 0;
        }
      } catch {
        broken = true; // a transcript is a convenience: never fail the agent over it
      }
    },
    // A spawn ended: a last line without a newline still counts.
    flush() {
      if (partial) line(partial);
      partial = '';
    },
    result: () => t.result(),
  };
}

// A failed spawn's stderr: the tail kept in the agent_run record, the whole of it (to the cap)
// in <label>.stderr.log next to the transcript.
function stderrTail(text, n = STDERR_TAIL) {
  const s = redact(String(text || ''));
  return s.length > n ? `…${s.slice(s.length - n)}` : s;
}

function writeStderr(file, text, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!text) return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const s = String(text);
    fs.appendFileSync(file, redact(s.length > maxBytes ? s.slice(s.length - maxBytes) : s));
    return file;
  } catch {
    return null;
  }
}

// Keep the newest `keep` run folders of a job (folder names start with a sortable stamp).
function prune(root, jobId, keep = DEFAULT_KEEP_RUNS) {
  const dir = runsDir(root, jobId);
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return 0;
  }
  const old = names.slice(0, Math.max(0, names.length - keep));
  for (const n of old) {
    try {
      fs.rmSync(path.join(dir, n), { recursive: true, force: true });
    } catch {
      /* in use or gone */
    }
  }
  return old.length;
}

// Every run folder under .factory/scratch/runs: job, name, bytes, time.
function runFolders(root) {
  const base = path.join(root, '.factory', 'scratch', 'runs');
  const out = [];
  let jobs = [];
  try {
    jobs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  const size = (p) => {
    let n = 0;
    try {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) n += e.isDirectory() ? size(path.join(p, e.name)) : fs.statSync(path.join(p, e.name)).size;
    } catch {
      /* gone */
    }
    return n;
  };
  for (const job of jobs) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(base, job), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      names = [];
    }
    for (const name of names) {
      const dir = path.join(base, job, name);
      let mtime = 0;
      try {
        mtime = fs.statSync(dir).mtimeMs;
      } catch {
        mtime = 0;
      }
      out.push({ job, name, dir, bytes: size(dir), mtime });
    }
  }
  return out;
}

// The disk budget across jobs (see the header). `protect`: run folders never to delete (the run in
// progress); runs of a job whose run lock is live are protected too. Returns the folders removed.
function pruneAll(root, lim = {}, { protect = [], ownJob = null, now = Date.now() } = {}) {
  const L = { ...limits({}), ...lim };
  const runs = runFolders(root);
  const keep = new Set(protect.map((p) => path.resolve(p)));
  const status = {};
  const live = {};
  for (const job of new Set(runs.map((r) => r.job))) {
    const jd = path.join(root, '.factory', 'jobs', job);
    let st = null;
    try {
      st = JSON.parse(fs.readFileSync(path.join(jd, 'state.json'), 'utf8'));
    } catch {
      st = null;
    }
    status[job] = st;
    try {
      live[job] = require('./runner').lockFileAlive(path.join(jd, 'run.lock'));
    } catch {
      live[job] = false;
    }
  }
  const removed = [];
  const drop = (r, why) => {
    if (keep.has(path.resolve(r.dir)) || (live[r.job] && r.job !== ownJob)) return; // another job's live run: never
    try {
      fs.rmSync(r.dir, { recursive: true, force: true });
      removed.push({ job: r.job, run: r.name, bytes: r.bytes, why });
      r.gone = true;
    } catch {
      /* in use */
    }
  };
  // per job and workflow: the newest keepRuns (folder names are <stamp>-<workflow>[-<config>]-<pid>)
  const key = (r) => `${r.job}|${r.name.replace(/^\d{8}T\d{6}-/, '').replace(/-\d+$/, '')}`;
  const groups = {};
  for (const r of runs) (groups[key(r)] = groups[key(r)] || []).push(r);
  for (const list of Object.values(groups)) list.sort((a, b) => a.name.localeCompare(b.name)).slice(0, Math.max(0, list.length - L.keepRuns)).forEach((r) => drop(r, 'keep_runs'));
  // ended jobs: after closedDays, and beyond the newest keepJobs of them
  const ENDED = ['closed', 'cancelled', 'abandoned'];
  const ended = Object.entries(status).filter(([, st]) => st && ENDED.includes(st.status)).map(([job, st]) => ({ job, at: Date.parse(st.closed_at || st.updated_at || '') || 0 })).sort((a, b) => b.at - a.at);
  ended.forEach((e, i) => {
    if (i >= L.keepJobs || (e.at && now - e.at > L.closedDays * 864e5)) runs.filter((r) => r.job === e.job && !r.gone).forEach((r) => drop(r, i >= L.keepJobs ? 'keep_jobs' : 'closed_days'));
  });
  // the total budget, oldest first
  let total = runs.filter((r) => !r.gone).reduce((n, r) => n + r.bytes, 0);
  for (const r of runs.filter((x) => !x.gone).sort((a, b) => a.mtime - b.mtime)) {
    if (total <= L.totalBytes) break;
    drop(r, 'total_bytes');
    if (r.gone) total -= r.bytes;
  }
  return removed;
}

// A unique file for one agent in one run folder: <label>.jsonl, or <label>-2.jsonl when two
// agents of the run share a label.
function fileFor(dir, label, taken) {
  const base = safe(label);
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  taken.add(name);
  return path.join(dir, `${name}.jsonl`);
}

// Totals over agent_run records (telemetry, the console): tokens and cost are summed per run;
// the session-wide counters (premium requests, nano-AIU) are counted once per session id, at
// their largest value. `unreported` counts runs whose CLI sent no usage record at all.
function totals(runs) {
  const out = { agent_runs: 0, agent_seconds: 0, tool_calls: null, reported_runs: 0, unreported_runs: 0, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null, cost: null, premium_requests: null, nano_aiu: null, models: [] };
  const sessions = {};
  const add = (k, v) => {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = (out[k] || 0) + v;
  };
  for (const r of runs) {
    out.agent_runs += 1;
    add('agent_seconds', (Number(r.ms) || 0) / 1000);
    if (typeof r.tool_calls === 'number') add('tool_calls', r.tool_calls);
    const u = r.usage;
    if (!u || !u.reported) {
      out.unreported_runs += 1;
      continue;
    }
    out.reported_runs += 1;
    for (const k of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'cost']) add(k, u[k]);
    for (const m of u.models || []) if (!out.models.includes(m)) out.models.push(m);
    const sid = r.session_id || r.run_id || `run-${out.agent_runs}`;
    const s = (sessions[sid] = sessions[sid] || { premium: null, nano: null });
    if (typeof u.session_premium_requests === 'number') s.premium = Math.max(s.premium || 0, u.session_premium_requests);
    if (typeof u.session_nano_aiu === 'number') s.nano = Math.max(s.nano || 0, u.session_nano_aiu);
  }
  for (const s of Object.values(sessions)) {
    add('premium_requests', s.premium);
    add('nano_aiu', s.nano);
  }
  out.agent_seconds = Math.round(out.agent_seconds);
  if (typeof out.cost === 'number') out.cost = Math.round(out.cost * 1000) / 1000;
  return out;
}

module.exports = { redact, pruneAll, runFolders, open, tracker, prune, fileFor, totals, limits, runsDir, stderrTail, writeStderr, safe, DEFAULT_MAX_BYTES, DEFAULT_KEEP_RUNS };
