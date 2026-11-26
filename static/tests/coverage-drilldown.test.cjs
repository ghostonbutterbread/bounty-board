'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cd = require('../modules/coverage-drilldown.js');
const taxonomy = require('../modules/taxonomy.js');
taxonomy.configure(require('../taxonomy-rules.json'));

const NOW = Date.parse('2026-11-23T00:00:00Z');
const row = (id, cls, status, extra = {}) => ({surface_id: id, kind: 'endpoint', host: 'a.example', surface_key: 'GET /' + id, class_name: cls, status,
  updated_at: '2026-11-20T00:00:00+00:00', freshness: 'current', evidence_refs: ['reports/r.md'], reason: 'r', boundary: 'b', ...extra});
const cov = {
  mapped_kinds: {endpoint: 4, route: 2},
  items: [row('s1', 'xss', 'bounded_review'), row('s1', 'idor', 'blocked', {reason: 'WAF challenge on every request', evidence_refs: []}),
    row('s2', 'xss', 'no_assessment', {evidence_refs: [], freshness: 'not_applicable', updated_at: null}),
    row('s3', 'ssrf', 'in_progress', {updated_at: '2026-08-01T00:00:00+00:00', freshness: 'unknown'}),
    row('s4', 'xss', 'stale', {prior_status: 'bounded_review', freshness: 'stale', kind: 'route'})],
  unassessed_surfaces: [{surface_id: 's5', kind: 'route'}]
};

test('summary reconciles surfaces and keeps surface and question counts separate', () => {
  const s = cd.summarize(cov, {now: NOW, staleDays: 30});
  assert.equal(s.surfaces.mapped, 6);
  assert.equal(s.surfaces.with_questions, 4);
  assert.equal(s.surfaces.without_questions, 1);
  assert.equal(s.reconciled, false); // 4 + 1 != 6: surface s6 is unaccounted for, and the UI must say so
  assert.equal(s.questions.total, 5);
  assert.equal(s.surfaces.bounded_review, 1);
  assert.equal(s.surfaces.blocked, 1);
  assert.equal(s.surfaces.stale, 1);
  assert.equal(s.surfaces.none_started, 2); // s2 (question open only) + s5 (no question)
  assert.equal(s.questions.aged, 1); // only the August in-progress row
  assert.equal(s.questions.freshness_unknown, 1);
  assert.equal(s.questions.without_evidence, 1);
  assert.deepEqual(s.blocked_tags, {'Edge, WAF or challenge': 1});
});
test('summary reconciles when inventory matches', () => {
  assert.equal(cd.summarize({...cov, mapped_kinds: {endpoint: 5}}, {now: NOW}).reconciled, true);
});
test('stale threshold changes the aged count', () => {
  assert.equal(cd.summarize(cov, {now: NOW, staleDays: 200}).questions.aged, 0);
});
test('attention view lists blocked, in-progress, stale and aged rows only', () => {
  const rows = cd.filterQuestions(cov.items, {view: 'attention'}, {now: NOW, staleDays: 30, normalizeClass: taxonomy.normalizeClass});
  assert.deepEqual(rows.map(r => r.status), ['blocked', 'in_progress', 'stale']);
});
test('category filter uses normalized class categories', () => {
  const rows = cd.filterQuestions(cov.items, {view: 'all', category: 'Cross-Site Scripting'}, {now: NOW, normalizeClass: taxonomy.normalizeClass});
  assert.equal(rows.length, 3);
});
test('byClass groups raw classes by category; byKind counts surfaces once', () => {
  const classes = cd.byClass(cov.items, taxonomy.normalizeClass);
  assert.equal(classes.find(c => c.label === 'Cross-Site Scripting').total, 3);
  const kinds = cd.byKind({...cov, items: [...cov.items, row('s1', 'ssrf', 'bounded_review')]});
  assert.deepEqual(kinds.find(k => k.kind === 'endpoint'), {kind: 'endpoint', mapped: 4, reviewed: 1});
});
test('evidence refs link only to reports present in the lane', () => {
  const reports = [{id: 'x1', path: 'dir/r.md'}];
  assert.equal(cd.reportForRef('reports/dir/r.md', reports).id, 'x1');
  assert.equal(cd.reportForRef('https://elsewhere.example/a', reports), null);
  assert.equal(cd.reportForRef(42, reports), null);
  // Evidence files are not reports; a reports/.../EVIDENCE.md ref maps to the evidence view path.
  assert.equal(cd.evidenceForRef('reports/F1-xss/EVIDENCE.md'), 'F1-xss/EVIDENCE.md');
  assert.equal(cd.evidenceForRef('./reports/F1/evidence.md'), 'F1/evidence.md');
  assert.equal(cd.evidenceForRef('reports/../x/EVIDENCE.md'), null);
  assert.equal(cd.evidenceForRef('reports/F1/notes.md'), null);
  assert.equal(cd.evidenceForRef('evidence/F1/EVIDENCE.md'), null);
});
test('missing or malformed coverage does not throw', () => {
  assert.equal(cd.summarize(null).questions.total, 0);
  assert.equal(cd.age('not a date', NOW), null);
});
