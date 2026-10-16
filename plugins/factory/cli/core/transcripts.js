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
// the counts above come from the stream, so they stay complete. Only the newest
// copilot.transcript_keep_runs run folders of a job are kept.

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_KEEP_RUNS = 30;
const STDERR_TAIL = 4000;

const runsDir = (root, jobId) => path.join(root, '.factory', 'scratch', 'runs', jobId);
const safe = (label) => String(label || 'agent').replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'agent';

function limits(cp = {}) {
  const n = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
  return { maxBytes: n(cp.transcript_max_bytes, DEFAULT_MAX_BYTES), keepRuns: n(cp.transcript_keep_runs, DEFAULT_KEEP_RUNS) };
}

// What the CLI reported, from its JSONL records.
function tracker() {
  const u = { api_calls: 0, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null, cost: null, models: [], session_premium_requests: null, session_nano_aiu: null, api_duration_ms: null };
  const s = { tool_calls: 0, last_tool: null, session: null, reported: false };
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
        case 'tool.execution_start':
          s.tool_calls += 1;
          if (typeof d.toolName === 'string') s.last_tool = d.toolName;
          break;
        case 'assistant.usage':
          s.reported = true;
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
          s.reported = true;
          if (num(d.totalNanoAiu) !== null) u.session_nano_aiu = Math.max(u.session_nano_aiu || 0, d.totalNanoAiu);
          if (num(d.totalPremiumRequests) !== null) u.session_premium_requests = Math.max(u.session_premium_requests || 0, d.totalPremiumRequests);
          break;
        case 'session.shutdown':
          s.reported = true;
          if (num(d.totalPremiumRequests) !== null) u.session_premium_requests = Math.max(u.session_premium_requests || 0, d.totalPremiumRequests);
          if (num(d.totalApiDurationMs) !== null) u.api_duration_ms = Math.max(u.api_duration_ms || 0, d.totalApiDurationMs);
          if (typeof d.currentModel === 'string' && d.currentModel && !u.models.includes(d.currentModel)) u.models.push(d.currentModel);
          break;
        default:
      }
    },
    result() {
      return { tool_calls: s.tool_calls, last_tool: s.last_tool, reported_session: s.session, usage: s.reported ? { reported: true, ...u, models: u.models.slice() } : { reported: false } };
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
        fs.appendFileSync(file, text);
        size += Buffer.byteLength(text);
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
  const s = String(text || '');
  return s.length > n ? `…${s.slice(s.length - n)}` : s;
}

function writeStderr(file, text, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!text) return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const s = String(text);
    fs.appendFileSync(file, s.length > maxBytes ? s.slice(s.length - maxBytes) : s);
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
  const out = { agent_runs: 0, agent_seconds: 0, tool_calls: 0, reported_runs: 0, unreported_runs: 0, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null, cost: null, premium_requests: null, nano_aiu: null, models: [] };
  const sessions = {};
  const add = (k, v) => {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = (out[k] || 0) + v;
  };
  for (const r of runs) {
    out.agent_runs += 1;
    add('agent_seconds', (Number(r.ms) || 0) / 1000);
    add('tool_calls', Number(r.tool_calls) || 0);
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

module.exports = { open, tracker, prune, fileFor, totals, limits, runsDir, stderrTail, writeStderr, safe, DEFAULT_MAX_BYTES, DEFAULT_KEEP_RUNS };
