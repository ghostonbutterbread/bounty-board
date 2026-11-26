'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ru = require('../modules/recon-urls.js');
const ri = require('../modules/recon-intel.js');

const row = {id: 7, url: 'https://app.example.test/r1?id=1', unsafe_chars: false, params: ['id']};
const base = {program: 'acme-demo', lane: 'web', rootInstance: 'a'.repeat(64), row, testLane: 'ssrf', status: 'surface_reviewed'};

test('API query: only set filters, keyset cursor, bounded limit', () => {
  assert.equal(ru.apiQuery('acme-demo', 'web', {}), 'family=web_bounty&program=acme-demo&lane=web&order=desc&limit=50'); // newest first by default
  assert.equal(new URLSearchParams(ru.apiQuery('acme-demo', 'web', {order: 'asc'}, 7)).toString(), 'family=web_bounty&program=acme-demo&lane=web&order=asc&cursor=7&limit=50');
  assert.equal(new URLSearchParams(ru.apiQuery('acme-demo', 'web', {order: 'sideways'})).get('order'), 'desc');
  const q = new URLSearchParams(ru.apiQuery('acme-demo', 'web', {host: 'a.example.test', q: 'x y', lane: 'xss', status: 'untested', params: true, param: 'q'}, 120, 25));
  assert.deepEqual(Object.fromEntries(q), {family: 'web_bounty', program: 'acme-demo', lane: 'web', host: 'a.example.test', q: 'x y', test_lane: 'xss', status: 'untested', params: '1', param: 'q', order: 'desc', cursor: '120', limit: '25'});
  assert.equal(new URLSearchParams(ru.apiQuery('p', 'web', {status: 'bogus', lane: 'Bad Lane'})).has('status'), false);
  assert.equal(new URLSearchParams(ru.apiQuery('p', 'web', {status: 'bogus', lane: 'Bad Lane'})).has('test_lane'), false);
  assert.equal(new URLSearchParams(ru.apiQuery('p', 'web', {}, 0)).has('cursor'), false);
});

test('mark body: BBH statuses and lanes only, web lane only, no control characters', () => {
  assert.deepEqual(ru.markBody(base), {family: 'web_bounty', program: 'acme-demo', lane: 'web', root_instance: 'a'.repeat(64), url_id: 7,
    url: row.url, test_lane: 'ssrf', status: 'surface_reviewed'});
  assert.deepEqual(ru.markBody({...base, param: ' id ', notes: ' checked '}), {...ru.markBody(base), param: 'id', param_location: 'query', notes: 'checked'});
  assert.equal(ru.markBody({...base, param: 'id', location: 'header'}).param_location, 'header');
  assert.equal(ru.markBody({...base, status: 'untested'}), null);   // a filter, not a BBH status
  assert.equal(ru.markBody({...base, status: 'tested'}), null);
  assert.equal(ru.markBody({...base, testLane: 'rce'}), null);
  assert.equal(ru.markBody({...base, lane: 'api'}), null);           // BBH writes the web lane only
  assert.equal(ru.markBody({...base, row: {...row, unsafe_chars: true}}), null);
  assert.equal(ru.markBody({...base, notes: 'a\x1b[201~b'}), null);
  assert.equal(ru.markBody({...base, param: 'a‮b'}), null);
  assert.equal(ru.markBody({...base, notes: 'x'.repeat(501)}), null);
});

test('mark refusals explain why a row has no Mark button', () => {
  assert.equal(ru.markRefusal(row, 'web', true), null);
  assert.equal(ru.markRefusal(row, 'web', false), 'off');
  assert.equal(ru.markRefusal(row, 'api', true), 'BBH marks only the web lane.');
  assert.equal(ru.markRefusal({...row, unsafe_chars: true}, 'web', true), 'Contains control characters.');
});

test('URL browser state round-trips through the recon hash', () => {
  const state = {...ri.parseQuery('p=web_bounty%2Facme-demo&lane=web'), ...ri.urlState({host: 'a.example.test', q: 'admin', lane: 'xss', status: 'deep_reviewed', params: true, param: 'q'}, 40)};
  const query = ri.buildQuery(state);
  assert.match(query, /&u=1&uh=a\.example\.test&uq=admin&ul=xss&us=deep_reviewed&un=q&up=1&ua=40$/);
  const back = ri.parseQuery(query);
  assert.deepEqual(ri.urlFilters(back), {host: 'a.example.test', q: 'admin', lane: 'xss', status: 'deep_reviewed', params: true, param: 'q', order: ''});
  // Oldest first is kept in the hash (uo=asc); newest first leaves no key.
  const oldest = ri.buildQuery({...back, ...ri.urlState({...ri.urlFilters(back), order: 'asc'}, 9)});
  assert.match(oldest, /&uo=asc&ua=9$/);
  assert.equal(ri.urlFilters(ri.parseQuery(oldest)).order, 'asc');
  assert.equal(ri.parseQuery(query.replace('ua=40', 'uo=sideways')).uo, '');
  assert.equal(back.ua, 40);
  // Invalid values fall back; the overview never carries URL keys.
  const bad = ri.parseQuery('p=web_bounty%2Fx&u=1&us=bogus&ul=Bad%20Lane&ua=-3');
  assert.deepEqual([bad.us, bad.ul, bad.ua], ['', '', 0]);
  assert.equal(ri.buildQuery({...ri.parseQuery(''), ...ri.urlState({host: 'h'})}), '');
});
