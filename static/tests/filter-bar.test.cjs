'use strict';
// Pure-function tests for the browser facet mapping (static/modules/filter-bar.js).
// Runs the same cases file as tests/test_finding_facets.py (finding_facets.py), so
// the Recent view (server) and the Submissions view (browser) bucket findings alike.
const test = require('node:test');
const assert = require('node:assert/strict');
const taxonomy = require('../modules/taxonomy.js');
const rail = require('../modules/filter-bar.js');
const cases = require('./facet-cases.json').cases;
taxonomy.configure(require('../taxonomy-rules.json'));
rail.useTaxonomy(taxonomy);

test('shared facet cases match finding_facets.py', () => {
  assert.ok(cases.length >= 30);
  for (const c of cases) {
    const f = c.finding;
    assert.deepEqual([rail.keys.submission(f), rail.keys.severity(f), rail.keys.classKey(f)], [c.submission, c.severity, c.class], c.name);
  }
});
test('every expected key is an option', () => {
  const subs = new Set(rail.SUBMISSIONS.map(([k]) => k)), sevs = new Set(rail.SEVERITIES.map(([k]) => k)), classes = new Set(rail.classOptions().map(([k]) => k));
  for (const c of cases) { assert.ok(subs.has(c.submission), c.name); assert.ok(sevs.has(c.severity), c.name); assert.ok(classes.has(c.class), c.name); }
});
test('class info splits the category and subclass labels', () => {
  assert.deepEqual(rail.keys.classInfo({class_name: 'Cross-Site Scripting (stored)'}),
    {raw: 'Cross-Site Scripting (stored)', category: 'xss', subclass: 'stored', label: 'Cross-Site Scripting', subclass_label: 'Stored'});
  assert.equal(rail.keys.classInfo(null), null);
  assert.equal(rail.keys.classInfo({class: ''}).label, 'Unclassified');
});
test('class order: labels A to Z, Unclassified, then No linked finding', () => {
  const options = rail.classOptions().slice().sort(rail.compareClass);
  assert.deepEqual(options.slice(-2).map(([k]) => k), ['unclassified', 'none']);
  const labels = options.slice(0, -2).map(([, l]) => l.toLowerCase());
  assert.deepEqual(labels, [...labels].sort());
});
test('labels match finding_facets.py', () => {
  // Python: SUBMISSIONS and SEVERITIES in finding_facets.py (same order and text).
  const py = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../finding_facets.py'), 'utf8');
  for (const [key, label] of [...rail.SUBMISSIONS, ...rail.SEVERITIES]) assert.ok(py.includes(key === 'none' ? `(NONE, '${label}')` : `('${key}', '${label}')`), `${key} ${label}`);
});
// Review round 1, R1: a cold-start row is a copy of the server's item.finding,
// where class is an object; it must bucket into the class the server used.
test('R1: a row built from item.finding keeps the server class key', () => {
  const serverFinding = {fid: 'F001', severity: 'HIGH', submission: {state: 'not_submitted'},
    class: {raw: 'xss', category: 'xss', subclass: 'other', label: 'Cross-Site Scripting', subclass_label: 'Other'}, severity_key: 'high'};
  const row = {...serverFinding, id: 'F001'}; // recent-reports.js entryFor() fallback
  assert.equal(rail.keys.classKey(row), 'xss');
  assert.equal(rail.keys.severity(row), 'high');
  assert.equal(rail.keys.submission(row), 'not_submitted');
});
