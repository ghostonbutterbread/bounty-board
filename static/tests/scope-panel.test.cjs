'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const sp = require('../modules/scope-panel.js');

test('scope panel query keys round-trip and validate', () => {
  assert.deepEqual(sp.parseQuery('kind=apps&change=release&rules=all&policy=open'), {kind: 'apps', change: 'release', rules: true, policy: true});
  assert.deepEqual(sp.parseQuery('kind=__proto__&change=evil&rules=1&policy=yes'), {kind: '', change: '', rules: false, policy: false});
  assert.equal(sp.buildQuery({kind: 'executables', change: '', rules: true, policy: false}), 'kind=executables&rules=all');
  assert.equal(sp.buildQuery(sp.parseQuery('')), '');
});

test('pull and backfill commands are shell-quoted and refuse unsafe names', () => {
  assert.equal(sp.pullCommand('acme-demo'), "bbh agents/scope_puller.py 'acme-demo' --if-older-than 7");
  assert.equal(sp.pullCommand("o'brien"), "bbh agents/scope_puller.py 'o'\\''brien' --if-older-than 7");
  assert.equal(sp.rebuildCommand('acme-demo'), "bbh agents/scope_puller.py --rebuild-inventory 'acme-demo'");
  for (const bad of ['a\x1b[201~b', 'a\rb', 'a‮b', 'a​b', ''])
    assert.equal(sp.pullCommand(bad), null, JSON.stringify(bad));
  assert.equal(sp.pullCommand('acme-demo', false), null); // server says the raw name was unsafe
});

test('ages, kind filters and change summaries', () => {
  assert.equal(sp.ageText(0), 'today');
  assert.equal(sp.ageText(1), '1 day ago');
  assert.equal(sp.ageText(34), '34 days ago');
  assert.equal(sp.shortAge(null), 'age unknown');
  assert.ok(sp.matchesKind({kind: 'ios_app'}, 'apps'));
  assert.ok(!sp.matchesKind({kind: 'executable'}, 'apps'));
  assert.ok(sp.matchesKind({kind: 'mystery', known_kind: false}, 'other'));
  const entry = {state: 'ok', source: 'pull', added_count: 2, removed_count: 1, changed_count: 0, release_changed_count: 1};
  assert.equal(sp.changeSummary(entry), '+2 added, -1 removed, 1 release changed');
  assert.equal(sp.changeSummary({state: 'ok', source: 'baseline'}), 'Inventory started');
  assert.equal(sp.changeSummary({state: 'invalid'}), 'Unreadable line');
  assert.ok(sp.entryHas(entry, 'release'));
  assert.ok(!sp.entryHas(entry, 'changed'));
  assert.ok(sp.entryHas(entry, ''));
});
