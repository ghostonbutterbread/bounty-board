'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ri = require('../modules/recon-intel.js');

test('hash query round-trips and rejects unknown values', () => {
  const s = ri.parseQuery('p=web_bounty%2Facme-demo&lane=web&hsort=js_files&hdir=asc&hq=cdn&under=1&hint=ssrf&sort=bogus');
  assert.equal(s.p, 'web_bounty/acme-demo');
  assert.equal(s.lane, 'web');
  assert.equal(s.hsort, 'js_files');
  assert.equal(s.hdir, 'asc');
  assert.equal(s.under, true);
  assert.equal(s.hint, 'ssrf');
  assert.equal(s.sort, 'urls');
  assert.equal(ri.parseQuery(ri.buildQuery(s)).hq, 'cdn');
  assert.equal(ri.parseQuery('p=binaries%2Fx').p, '');           // web programs only
  assert.equal(ri.parseQuery('p=web_bounty%2Fa%2F..%2Fb').p, '');  // no nested paths
  assert.equal(ri.parseQuery('hint=<script>').hint, '');
  assert.equal(ri.buildQuery(ri.parseQuery('')), '');
  assert.equal(ri.buildQuery({...ri.parseQuery(''), sort: 'js_bytes', dir: 'desc', q: 'acme'}), 'sort=js_bytes&dir=desc&q=acme');
});

test('sorting keeps unknown values last in both directions', () => {
  const rows = [{id: 'a', urls: {value: 5}}, {id: 'b', urls: null}, {id: 'c', urls: {value: 50, approximate: true}}, {id: 'd', urls: 7}];
  assert.deepEqual(ri.sortRows(rows, 'urls', 'desc').map(r => r.id), ['c', 'd', 'a', 'b']);
  assert.deepEqual(ri.sortRows(rows, 'urls', 'asc').map(r => r.id), ['a', 'd', 'c', 'b']);
});

test('formatting', () => {
  assert.equal(ri.fmtNum(1320747), '1.3M');
  assert.equal(ri.fmtNum(13200), '13.2k');
  assert.equal(ri.fmtNum(9999), '9,999');
  assert.equal(ri.fmtNum(null), '—');
  assert.equal(ri.fmtBytes(117000), '114 KB');
  assert.equal(ri.fmtBytes(512), '512 B');
  assert.equal(ri.fmtBytes(160 * 1024 * 1024), '160 MB');
});

test('copy commands are shell-quoted and URLs are http(s) only', () => {
  assert.equal(ri.shellQuote("a'b"), `'a'\\''b'`);
  assert.equal(ri.curlCommand("https://x.example.test/?q='1"), `curl -sS -i --max-time 20 'https://x.example.test/?q='\\''1'`);
  assert.equal(ri.bbhNext('acme-demo', 'ssrf', 'url'), "bbh agents/url_ingest.py next 'acme-demo' --lane 'ssrf' --param 'url' --limit 20");
  assert.equal(ri.bbhStatus('acme-demo', 'cdn.example.test'), "bbh agents/url_ingest.py status 'acme-demo' --host 'cdn.example.test' --limit 50");
  assert.equal(ri.safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(ri.safeHttpUrl('data:text/html,x'), null);
  assert.equal(ri.safeHttpUrl('https://a.example.test/x'), 'https://a.example.test/x');
});

test('depth gap ranks surface per test run', () => {
  const big = {urls: {value: 1000}, js_files: {value: 0}, test_runs: {value: 0}};
  const tested = {urls: {value: 1000}, js_files: {value: 10}, test_runs: {value: 100}};
  assert.ok(ri.depthGap(big) > ri.depthGap(tested));
});
