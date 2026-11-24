'use strict';
// Pure-function tests for static/modules/taxonomy.js. Uses the same cases file as
// tests/test_taxonomy.py, so the Python and JavaScript implementations cannot drift.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const taxonomy = require('../modules/taxonomy.js');
const rules = require('../taxonomy-rules.json');
const cases = require('./taxonomy-cases.json');
taxonomy.configure(rules);

test('class cases match the shared expectations', () => {
  for (const [raw, category, subclass, confidence] of cases.class) {
    const got = taxonomy.normalizeClass(raw);
    assert.deepEqual([got.category, got.subclass, got.confidence], [category, subclass, confidence], String(raw));
    assert.equal(got.raw, raw);
  }
});
test('alternates are reported for compound labels', () => {
  for (const [raw, alternates] of cases.alternates) assert.deepEqual(taxonomy.normalizeClass(raw).alternates, alternates, raw);
});
test('severity cases match the shared expectations', () => {
  for (const [raw, value, kind] of cases.severity) {
    const got = taxonomy.normalizeSeverity(raw);
    assert.deepEqual([got.value, got.kind], [value, kind], String(raw));
  }
});
test('before rules load, classes stay unclassified and raw severity is not rewritten', () => {
  delete require.cache[require.resolve('../modules/taxonomy.js')];
  const fresh = require('../modules/taxonomy.js');
  assert.equal(fresh.ready(), false);
  assert.equal(fresh.normalizeClass('xss').category, 'unclassified');
  assert.equal(fresh.normalizeSeverity('p2').kind, 'rules_not_loaded');
});
test('python and javascript agree on labels with prototype-like names', () => {
  assert.equal(taxonomy.normalizeClass('constructor').category, 'unclassified');
  assert.equal(taxonomy.normalizeSeverity('constructor').kind, 'unmapped');
});
