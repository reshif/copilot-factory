'use strict';
// Lessons: short, scoped rules learned from confirmed problems. Agents propose,
// you accept or reject in chat. Accepted lessons feed plans, builds and reviews.

const path = require('path');
const { readJson, writeJson, writeText, nowIso, fail } = require('../lib/util');
const { project } = require('../lib/paths');
const { matchesAny, globsOverlap } = require('../lib/glob');

function load(root) {
  return readJson(project(root).lessonsFile, { lessons: [] });
}

function save(root, doc) {
  writeJson(project(root).lessonsFile, doc);
  writeText(path.join(path.dirname(project(root).lessonsFile), 'lessons.md'), register(doc));
}

// lessons.md: the human-readable register, rendered from lessons.json with
// templates/docs/lessons.md (lessons@1). One card per lesson, same parts every time.
function register(doc) {
  const { frontBlock, cell, loadTemplate } = require('./doc');
  const ls = doc.lessons || [];
  const date = ls.flatMap((l) => [l.created_at, l.decided_at]).filter(Boolean).sort().pop() || '1970-01-01';
  const L = [
    frontBlock({ doc: 'lessons', template: loadTemplate('lessons').version, job: 'project', title: 'Lessons register', status: 'current', date: date.slice(0, 10), contract: 'none', related: ['lessons.json'] }),
    '',
    '# Lessons register',
    '',
    '## Summary',
    '',
    '| Lesson | Status | Scope | Source job | Rule |',
    '|---|---|---|---|---|',
    ...ls.map((l) => `| ${l.id} | ${l.status} | ${cell(l.scope.join(', '))} | ${l.source_job || '—'} | ${cell(l.text)} |`),
    ...(ls.length ? [] : ['| — | — | — | — | — |']),
    '',
    '## Lessons',
    '',
  ];
  for (const l of ls) {
    L.push(`### ${l.id} — ${l.status}`, `- Rule: ${l.text}`, `- Scope: ${l.scope.join(', ')}`, `- Why: ${l.why || (l.source_job ? `confirmed problems in ${l.source_job}` : 'not recorded')}`, `- Check: ${l.check ? `\`${l.check}\`` : `review (findings cite "lesson:${l.id}")`}`, `- Decided: ${l.decided_at ? `${l.status} ${l.decided_at}${l.reason ? ` — ${l.reason}` : ''}` : 'awaiting your accept or reject'}`, '');
  }
  if (!ls.length) L.push('None yet.', '');
  return L.join('\n');
}

function add(root, { jobId, text, scope, why }) {
  if (!text || text.length < 10) fail('A lesson needs a sentence of text.', 'bad_input');
  const scopes = (Array.isArray(scope) ? scope : String(scope || '**').split(',')).map((s) => s.trim()).filter(Boolean);
  const doc = load(root);
  const job = require('./job');
  const state = jobId ? job.load(root, jobId) : null;
  const max = state ? state.policy.lessons_max_per_job : 3;
  const mine = doc.lessons.filter((l) => l.source_job === jobId);
  if (jobId && mine.length >= max) fail(`${jobId} already proposed ${max} lessons (the cap).`, 'cap');
  const id = `L${doc.lessons.length + 1}`;
  const lesson = { id, status: 'proposed', text, scope: scopes, source_job: jobId || null, ...(why ? { why: String(why) } : {}), created_at: nowIso() };
  doc.lessons.push(lesson);
  save(root, doc);
  return lesson;
}

function decide(root, { id, accept, reason, channel }) {
  require('./human').requireHumanChannel(channel);
  const doc = load(root);
  const l = doc.lessons.find((x) => x.id === id);
  if (!l) fail(`Lesson ${id} not found`, 'bad_input');
  if (l.status !== 'proposed') fail(`Lesson ${id} is already ${l.status}`, 'bad_input');
  require('./human').confirmTyped(channel, l.id, `${accept ? 'accept' : 'reject'} it`);
  l.status = accept ? 'accepted' : 'rejected';
  l.decided_at = nowIso();
  l.reason = reason || '';
  save(root, doc);
  return { lesson: l, message: `Lesson ${id} ${l.status}.${accept ? ' It applies from the next plan, build and review.' : ''}` };
}

function promote(root, { id, check, channel }) {
  require('./human').requireHumanChannel(channel);
  if (!check) fail('Promotion needs the check command that enforces the lesson.', 'bad_input');
  const doc = load(root);
  const l = doc.lessons.find((x) => x.id === id);
  if (!l || l.status !== 'accepted') fail(`Lesson ${id} must exist and be accepted`, 'bad_input');
  require('./human').confirmTyped(channel, l.id, `promote it to the check "${check}"`);
  l.status = 'promoted';
  l.check = check;
  save(root, doc);
  const p = project(root).policyFile;
  const pol = readJson(p, {}) || {};
  pol.checks = [...(pol.checks || []), { cmd: check, from_lesson: id }];
  writeJson(p, pol);
  return { lesson: l, message: `Lesson ${id} promoted to a check: ${check}` };
}

// Accepted lessons whose scope touches any of the given paths or globs.
function inScope(root, pathsOrGlobs) {
  const list = Array.isArray(pathsOrGlobs) ? pathsOrGlobs : [];
  return load(root)
    .lessons.filter((l) => l.status === 'accepted' || l.status === 'promoted')
    .filter((l) => !list.length || l.scope.includes('**') || list.some((p) => matchesAny(p, l.scope)) || globsOverlap(l.scope, list))
    .map((l) => ({ id: l.id, text: l.text, scope: l.scope }));
}

module.exports = { load, add, decide, promote, inScope, register };
