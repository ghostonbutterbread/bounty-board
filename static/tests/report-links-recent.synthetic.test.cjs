// Report links open in new tabs, cold deep links land on the report, and the
// Recent reports view and dashboard panel. Disposable synthetic fixture only.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

const repo = path.resolve(__dirname, '../..');
const ACME = encodeURIComponent('web_bounty/acme-cloud');
const reportRoute = (program, lane, report) => `#/programs/${encodeURIComponent(program)}/${lane}/reports/${encodeURIComponent(report)}`;

async function withFixture(run, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brl-'));
  const child = spawn('python3', ['-u', 'tests/report_links_fixture.py', root], {cwd: repo, env: {...process.env, ...env, PYTHONPATH: repo}, stdio: ['ignore', 'pipe', 'inherit']});
  let browser;
  try {
    const port = await new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', code => reject(Error(`fixture exited ${code}`))); child.stdout.once('data', data => resolve(Number(String(data).trim())));});
    browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_BIN, args: ['--no-sandbox', '--disable-dev-shm-usage', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const context = await browser.newContext({viewport: {width: 1440, height: 900}});
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await run({page, context, url: `http://127.0.0.1:${port}/`, errors});
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    child.kill('SIGTERM'); await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
    fs.rmSync(root, {recursive: true, force: true});
  }
}
const selected = page => page.locator('#report-select').inputValue();
async function waitReport(page, id) {
  await page.waitForFunction(value => document.querySelector('#report-select')?.value === value, id);
}
// A modified click on a link opens a new tab; returns the new page once its report is open.
async function openedInNewTab(context, action, id) {
  const [popup] = await Promise.all([context.waitForEvent('page'), action()]);
  popup.setDefaultTimeout(10000);
  await popup.waitForLoadState('domcontentloaded');
  if (id) await waitReport(popup, id);
  return popup;
}

test('Reports section lists the lane reports as links; modified clicks open new tabs, plain clicks stay in-app', {timeout: 90000}, async () => withFixture(async ({page, context, url}) => {
  await page.goto(`${url}#/programs/${ACME}/web/reports`);
  const links = page.locator('.report-links a.report-link');
  await links.first().waitFor();
  assert.deepEqual(await links.evaluateAll(els => els.map(e => e.querySelector('.report-link-path')?.textContent || e.querySelector('.report-link-title').textContent)),
    ['confirmed/stored xss.md', 'ac-2-invoice-idor.md', 'notes.md'], 'newest first, generated navigation hidden');
  assert.equal(await links.first().getAttribute('href'), `#/programs/${ACME}/web/reports/${encodeURIComponent('confirmed/stored xss.md')}`);
  // Navigation stubs are one tick away.
  await page.getByLabel(/Show generated navigation \(1\)/).check();
  await page.locator('.report-links a.report-link', {hasText: 'index/xss.md'}).waitFor();
  await page.getByLabel(/Show generated navigation/).uncheck();
  await page.locator('.report-links a.report-link', {hasText: 'index/xss.md'}).waitFor({state: 'detached'});
  // Plain click: in-app navigation, no reload, URL updated.
  await page.evaluate(() => { window.__noReload = true; });
  await links.filter({hasText: 'notes.md'}).click();
  await waitReport(page, 'notes.md');
  assert.equal(new URL(page.url()).hash, reportRoute('web_bounty/acme-cloud', 'web', 'notes.md'));
  assert.equal(await page.evaluate(() => window.__noReload), true, 'plain click did not reload the page');
  assert.equal(await page.locator('.report-links a[aria-current="page"]').innerText().then(t => t.includes('notes.md')), true);
  // Ctrl+click, middle click and Shift+click each open the report in a new page; this page stays put.
  const ctrl = await openedInNewTab(context, () => links.filter({hasText: 'ac-2-invoice-idor.md'}).click({modifiers: ['Control']}), 'ac-2-invoice-idor.md');
  assert.equal(new URL(ctrl.url()).hash, reportRoute('web_bounty/acme-cloud', 'web', 'ac-2-invoice-idor.md'));
  await ctrl.close();
  const middle = await openedInNewTab(context, () => links.filter({hasText: 'confirmed/stored xss.md'}).click({button: 'middle'}), 'confirmed/stored xss.md');
  await middle.close();
  const shift = await openedInNewTab(context, () => links.filter({hasText: 'notes.md'}).click({modifiers: ['Shift']}), 'notes.md');
  await shift.close();
  assert.equal(await selected(page), 'notes.md');
  assert.equal(await page.evaluate(() => window.__noReload), true);
  // The filter hides rows in place.
  await page.getByLabel('Filter report list by name, path or finding').fill('invoice');
  assert.equal(await links.filter({visible: true}).count(), 1);
  assert.equal(await page.locator('#report-filter-count').innerText(), '1 of 3');
  // The fast picker still works.
  await page.locator('#report-select').selectOption('ac-2-invoice-idor.md');
  await waitReport(page, 'ac-2-invoice-idor.md');
}));

test('cold deep link opens its report through the lazily loaded lane, before and after the complete phase', {timeout: 90000}, async () => withFixture(async ({page, url}) => {
  const target = reportRoute('web_bounty/acme-cloud', 'web', 'confirmed/stored xss.md');
  const started = Date.now();
  await page.goto(`${url}${target}`);
  await waitReport(page, 'confirmed/stored xss.md');
  assert.ok(Date.now() - started < 3500, 'opened before the delayed complete phase');
  assert.equal(await page.locator('.toast', {hasText: 'Reports loaded'}).count(), 0, 'complete phase not applied yet');
  await page.locator('#report-source').waitFor({state: 'attached'});
  await page.locator('.CodeMirror').waitFor();
  assert.match(await page.locator('.CodeMirror').innerText(), /Stored XSS report/);
  await page.locator('.toast', {hasText: 'Reports loaded'}).waitFor({timeout: 15000});
  assert.equal(await selected(page), 'confirmed/stored xss.md', 'complete phase keeps the routed report');
  assert.equal(new URL(page.url()).hash, target);
  // Each following link is a cold load (a hash-only goto would stay in the same document).
  const cold = async hash => { await page.goto('about:blank'); await page.goto(`${url}${hash}`); };
  // A finding deep link highlights the row.
  await cold(`#/programs/${ACME}/web/findings/AC-2`);
  await page.locator('tr.highlight[data-finding-id="AC-2"]').waitFor();
  // A stale report link explains itself instead of opening another report.
  await cold(reportRoute('web_bounty/acme-cloud', 'web', 'gone/missing.md'));
  const missing = page.locator('[data-report-missing]');
  await missing.waitFor();
  assert.match(await missing.innerText(), /Report not found in this lane: gone\/missing\.md/);
  assert.equal(await page.locator('#live-report-host, .CodeMirror').count(), 0);
  await page.locator('.report-links a.report-link', {hasText: 'notes.md'}).click();
  await waitReport(page, 'notes.md');
  // An unknown program in a link says so.
  await cold(`#/programs/${encodeURIComponent('web_bounty/no-such-program')}/web/reports/x.md`);
  await page.getByText('The linked program "web_bounty/no-such-program" was not found.').waitFor();
  // The same inside an open page (hash change), and a stale link within the page.
  await page.goto(`${url}#/programs/${encodeURIComponent('web_bounty/also-missing')}/web/findings`);
  await page.getByText('The linked program "web_bounty/also-missing" was not found.').waitFor();
  await page.goto(`${url}${reportRoute('web_bounty/acme-cloud', 'web', 'gone/missing.md')}`);
  await page.locator('[data-report-missing]').waitFor();
}, {SLOW_COMPLETE: '1'}));

test('findings, dashboard drill-down and search results are links that open new tabs', {timeout: 90000}, async () => withFixture(async ({page, context, url}) => {
  await page.goto(`${url}#/programs/${ACME}/web/findings`);
  const ref = page.locator('tr[data-finding-id="AC-1"] a.report-ref');
  await ref.waitFor();
  assert.equal(await ref.getAttribute('href'), reportRoute('web_bounty/acme-cloud', 'web', 'confirmed/stored xss.md'));
  const fromRow = await openedInNewTab(context, () => ref.click({modifiers: ['Control']}), 'confirmed/stored xss.md');
  await fromRow.close();
  await ref.click();
  await waitReport(page, 'confirmed/stored xss.md');
  // Dashboard drill-down: finding and report links.
  await page.getByRole('link', {name: 'Dashboard', exact: true}).click();
  await page.locator('[data-breakdown="sev:critical"]').click();
  const drillFinding = page.locator('.drill').getByRole('link', {name: 'Invoice IDOR'});
  assert.equal(await drillFinding.getAttribute('href'), `#/programs/${ACME}/web/findings/AC-2`);
  const highlighted = await openedInNewTab(context, () => drillFinding.click({button: 'middle'}));
  await highlighted.locator('tr.highlight[data-finding-id="AC-2"]').waitFor();
  await highlighted.close();
  const drillReport = page.locator('.drill').getByRole('link', {name: /Report/});
  assert.equal(await drillReport.getAttribute('href'), reportRoute('web_bounty/acme-cloud', 'web', 'ac-2-invoice-idor.md'));
  // Program table rows are links too.
  assert.equal(await page.locator('[data-open-program="web_bounty/globex"]').getAttribute('href'), `#/programs/${encodeURIComponent('web_bounty/globex')}/web/findings`);
  // Search palette: rows carry real hrefs; Ctrl+click and Ctrl+Enter open new tabs, a plain click stays.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('invoice');
  const report = page.locator('.search-item', {hasText: 'ac-2-invoice-idor.md'});
  await report.waitFor({timeout: 15000});
  assert.equal(await report.locator('a.search-link').getAttribute('href'), reportRoute('web_bounty/acme-cloud', 'web', 'ac-2-invoice-idor.md'));
  const finding = page.locator('.search-item', {hasText: 'AC-2'}).first();
  assert.equal(await finding.locator('a.search-link').getAttribute('href'), `#/programs/${ACME}/web/findings/AC-2`);
  assert.equal(await finding.locator('a.search-open-report').getAttribute('href'), reportRoute('web_bounty/acme-cloud', 'web', 'ac-2-invoice-idor.md'));
  const fromSearch = await openedInNewTab(context, () => report.click({modifiers: ['Control']}), 'ac-2-invoice-idor.md');
  await fromSearch.close();
  assert.equal(await page.locator('.search-overlay').isVisible(), true, 'palette stays open after a new-tab click');
  await report.hover();
  const fromKeys = await openedInNewTab(context, () => page.keyboard.press('Control+Enter'), 'ac-2-invoice-idor.md');
  await fromKeys.close();
  await report.click();
  await waitReport(page, 'ac-2-invoice-idor.md');
  assert.equal(await page.locator('.search-overlay').isVisible(), false);
}));

test('Recent reports view: newest first across programs, filters, sort, links; dashboard panel loads after first paint', {timeout: 120000}, async () => withFixture(async ({page, context, url}) => {
  const order = [];
  page.on('request', request => { const u = new URL(request.url()); if (u.pathname.startsWith('/api/')) order.push(`${u.pathname}${u.pathname === '/api/data' ? '?' + (u.searchParams.get('phase') || request.headers()['x-bounty-board-phase'] || '') : ''}`); });
  await page.goto(url);
  await page.getByRole('heading', {name: 'Portfolio overview'}).waitFor();
  const panel = page.getByRole('region', {name: 'Recently updated reports'});
  const panelLinks = panel.locator('a.recent-link');
  await panelLinks.first().waitFor({timeout: 15000});
  assert.deepEqual(await panelLinks.allInnerTexts(), ['Globex SQLi report', 'Stored XSS report', 'Initech APK notes', 'Invoice IDOR report', 'API token report', 'Acme working notes', 'Globex old draft']);
  assert.ok(order.indexOf('/api/recent-reports') > order.indexOf('/api/data?summary'), `panel loads after the summary: ${order.join(', ')}`);
  assert.equal(await panelLinks.first().getAttribute('href'), reportRoute('web_bounty/globex', 'web', 'gx-sqli.md'));
  const fromPanel = await openedInNewTab(context, () => panelLinks.nth(1).click({modifiers: ['Control']}), 'confirmed/stored xss.md');
  await fromPanel.close();
  await panel.getByRole('link', {name: 'View all'}).click();
  assert.equal(new URL(page.url()).hash, '#/recent?within=7d&order=newest', 'View all opens the 7-day view');
  await page.getByRole('heading', {name: 'Recent reports', level: 1}).waitFor();
  const titles = () => page.locator('.recent-table a.recent-link').allInnerTexts();
  const rowsSettled = async expected => page.waitForFunction(want => JSON.stringify([...document.querySelectorAll('.recent-table a.recent-link')].map(a => a.textContent)) === JSON.stringify(want), expected);
  await rowsSettled(['Globex SQLi report', 'Stored XSS report', 'Initech APK notes', 'Invoice IDOR report']);
  await page.locator('[data-recent-window="all"]').click();
  await rowsSettled(['Globex SQLi report', 'Stored XSS report', 'Initech APK notes', 'Invoice IDOR report', 'API token report', 'Acme working notes', 'Globex old draft']);
  assert.match(await page.locator('.recent-status').innerText(), /Showing 1 to 7 of 7 reports/);
  const row = page.locator('tr[data-recent-row][data-path="confirmed/stored xss.md"]');
  assert.match(await row.innerText(), /acme-cloud[\s\S]*web[\s\S]*AC-1[\s\S]*HIGH[\s\S]*2 h ago/);
  assert.ok(await row.locator('time').getAttribute('title'), 'absolute time on hover');
  assert.equal(await row.locator('a.recent-link').getAttribute('href'), reportRoute('web_bounty/acme-cloud', 'web', 'confirmed/stored xss.md'));
  // Time windows.
  await page.locator('[data-recent-window="1d"]').click();
  await rowsSettled(['Globex SQLi report', 'Stored XSS report']);
  await page.locator('[data-recent-window="7d"]').click();
  await rowsSettled(['Globex SQLi report', 'Stored XSS report', 'Initech APK notes', 'Invoice IDOR report']);
  await page.locator('[data-recent-window="all"]').click();
  // Program multi-select.
  await page.locator('[data-recent-programs]').click();
  await page.getByLabel('Search programs to filter').fill('glob');
  await page.locator('.recent-program-list label.option', {hasText: 'globex'}).locator('input').check();
  await rowsSettled(['Globex SQLi report', 'Globex old draft']);
  await page.getByLabel('Search programs to filter').fill('');
  assert.equal(await page.locator('.recent-program-list label.option', {hasText: 'globex'}).locator('.count').innerText(), '2');
  await page.locator('.recent-program-list label.option', {hasText: 'initech'}).locator('input').check();
  await rowsSettled(['Globex SQLi report', 'Initech APK notes', 'Globex old draft']);
  await page.getByRole('button', {name: 'Done'}).click();
  await page.getByRole('button', {name: 'Remove program filter initech'}).click();
  await rowsSettled(['Globex SQLi report', 'Globex old draft']);
  await page.locator('[data-recent-clear]').first().click();
  assert.equal(await page.locator('[data-recent-window="7d"]').getAttribute('aria-pressed'), 'true', 'Clear filters returns to the 7-day default');
  await page.locator('[data-recent-window="all"]').click();
  // Lane, text filter and sort.
  await page.locator('#recent-lane').selectOption('api');
  await rowsSettled(['API token report']);
  await page.locator('#recent-lane').selectOption('');
  await page.getByLabel('Filter recent reports by title or path').fill('invoice');
  await rowsSettled(['Invoice IDOR report']);
  await page.getByLabel('Filter recent reports by title or path').fill('');
  await page.locator('[data-recent-order]').click();
  await rowsSettled(['Globex old draft', 'Acme working notes', 'API token report', 'Invoice IDOR report', 'Initech APK notes', 'Stored XSS report', 'Globex SQLi report']);
  await page.locator('[data-recent-order]').click();
  await page.getByLabel('Include generated navigation').check();
  await page.waitForFunction(() => document.querySelector('.recent-table tr[data-recent-row]')?.dataset.path === 'index/xss.md');
  await page.getByLabel('Include generated navigation').uncheck();
  await rowsSettled(['Globex SQLi report', 'Stored XSS report', 'Initech APK notes', 'Invoice IDOR report', 'API token report', 'Acme working notes', 'Globex old draft']);
  // Links: modified click opens a new tab; plain click navigates in-app and Back returns here.
  const fromView = await openedInNewTab(context, () => page.locator('.recent-table a.recent-link', {hasText: 'Initech APK notes'}).click({button: 'middle'}), 'apk-notes.md');
  await fromView.close();
  await page.locator('.recent-table a.recent-link', {hasText: 'Initech APK notes'}).click();
  await waitReport(page, 'apk-notes.md');
  await page.goBack();
  await rowsSettled(['Globex SQLi report', 'Stored XSS report', 'Initech APK notes', 'Invoice IDOR report', 'API token report', 'Acme working notes', 'Globex old draft']);
  assert.equal(new URL(page.url()).hash, '#/recent?within=all&order=newest');
  // A new report shows up on refresh; the sidebar item opens the view.
  assert.equal((await titles()).length, 7);
  await page.reload();
  await page.getByRole('link', {name: 'Recent reports', exact: true}).waitFor();
  await page.locator('.recent-table a.recent-link').first().waitFor();
  assert.equal(await page.locator('[data-view="recent"]').getAttribute('aria-current'), 'page');
  // Phone width: neither the view nor the dashboard widens the page.
  await page.setViewportSize({width: 375, height: 800});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), 'recent view fits 375 px');
  await page.getByRole('link', {name: 'Dashboard', exact: true}).click();
  await panel.locator('a.recent-link').first().waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), 'dashboard fits 375 px');
}));

// ---- Recent filters in the URL, sidebar and section tab links ----------------
const recentRows = page => page.locator('.recent-table a.recent-link').allInnerTexts();
const recentSettled = (page, expected) => page.waitForFunction(want => JSON.stringify([...document.querySelectorAll('.recent-table a.recent-link')].map(a => a.textContent)) === JSON.stringify(want), expected);
const hashOf = page => new URL(page.url()).hash;
const historyLength = page => page.evaluate(() => history.length);
const FULL = '#/recent?within=all&program=web_bounty%2Facme-cloud&program=web_bounty%2Fglobex&lane=web&q=report&order=oldest&nav=1';
const FULL_ROWS = ['Invoice IDOR report', 'Stored XSS report', 'Globex SQLi report'];

test('Recent view: 7-day default, every filter round-trips through the URL with replaceState, cold links restore the view', {timeout: 150000}, async () => withFixture(async ({page, context, url}) => {
  const bad = [];
  context.on('response', response => { if (response.url().includes('/api/recent-reports') && response.status() >= 400) bad.push(`${response.status()} ${response.url()}`); });
  // First visit: no saved preference, no window in the link.
  await page.goto(`${url}#/recent`);
  await recentSettled(page, ['Globex SQLi report', 'Stored XSS report', 'Initech APK notes', 'Invoice IDOR report']);
  assert.equal(await page.locator('[data-recent-window="7d"]').getAttribute('aria-pressed'), 'true');
  assert.equal(hashOf(page), '#/recent?within=7d&order=newest');
  assert.equal(await page.locator('[data-recent-clear]').count(), 0, 'the default window is not a filter');
  // Every filter change replaces the URL; history does not grow.
  const before = await historyLength(page);
  await page.locator('[data-recent-window="all"]').click();
  await recentSettled(page, ['Globex SQLi report', 'Stored XSS report', 'Initech APK notes', 'Invoice IDOR report', 'API token report', 'Acme working notes', 'Globex old draft']);
  assert.equal(hashOf(page), '#/recent?within=all&order=newest');
  await page.locator('[data-recent-programs]').click();
  await page.locator('.recent-program-list label.option', {hasText: 'acme-cloud'}).locator('input').check();
  await page.locator('.recent-program-list label.option', {hasText: 'globex'}).locator('input').check();
  await page.getByRole('button', {name: 'Done'}).click();
  await page.locator('#recent-lane').selectOption('web');
  await page.getByLabel('Filter recent reports by title or path').pressSequentially('report', {delay: 30});
  await page.locator('[data-recent-order]').click();
  await page.getByLabel('Include generated navigation').check();
  await recentSettled(page, FULL_ROWS);
  await page.waitForFunction(want => location.hash === want, FULL);
  assert.equal(await historyLength(page), before, 'filters and typing use replaceState');
  // The sidebar link carries the current view.
  await page.locator('.nav a[data-view="recent"]').hover();
  assert.equal(await page.locator('.nav a[data-view="recent"]').getAttribute('href'), FULL);
  // Cold start in a new page with no stored preferences restores the exact view.
  const fresh = await context.browser().newContext({viewport: {width: 1440, height: 900}});
  await fresh.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const cold = await fresh.newPage();
  cold.setDefaultTimeout(10000);
  const coldErrors = []; cold.on('pageerror', error => coldErrors.push(String(error)));
  await cold.goto(`${url}${FULL}`);
  await recentSettled(cold, FULL_ROWS);
  assert.equal(hashOf(cold), FULL);
  assert.equal(await cold.locator('[data-recent-window="all"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await cold.locator('#recent-lane').inputValue(), 'web');
  assert.equal(await cold.getByLabel('Filter recent reports by title or path').inputValue(), 'report');
  assert.equal(await cold.locator('#recent-nav').isChecked(), true);
  assert.match(await cold.locator('[data-recent-order]').innerText(), /Oldest first/);
  assert.equal(await cold.locator('.chips [data-recent-remove-program]').count(), 2);
  // Unknown and invalid values fall back to the defaults without errors.
  await cold.goto(`${url}#/recent?within=bogus&program=nope%2Fnope&lane=zzz&q=%00&order=sideways&nav=yes&page=-3&extra=1`);
  await cold.reload();
  await recentSettled(cold, ['Globex SQLi report', 'Stored XSS report', 'Initech APK notes', 'Invoice IDOR report']);
  assert.equal(hashOf(cold), '#/recent?within=7d&order=newest');
  // Values are escaped, never injected.
  const hostile = '<img src=x onerror="window.__pwned=1">';
  await cold.goto(`${url}#/recent?within=all&q=${encodeURIComponent(hostile)}&program=${encodeURIComponent('web_bounty/acme-cloud')}`);
  await cold.reload();
  await cold.locator('.recent-panel .empty').waitFor();
  assert.equal(await cold.getByLabel('Filter recent reports by title or path').inputValue(), hostile);
  assert.equal(await cold.evaluate(() => window.__pwned), undefined);
  assert.equal(await cold.locator('#app img').count(), 0);
  assert.deepEqual(coldErrors, []);
  await fresh.close();
  // In the original browser the link wins over the remembered filters.
  const linked = await context.newPage();
  linked.setDefaultTimeout(10000);
  await linked.goto(`${url}#/recent?within=1d&order=newest`);
  await recentSettled(linked, ['Globex SQLi report', 'Stored XSS report']);
  await linked.close();
  // A plain #/recent in the same browser uses the remembered filters (query text is not remembered).
  const remembered = await context.newPage();
  remembered.setDefaultTimeout(10000);
  await remembered.goto(`${url}#/recent`);
  await remembered.waitForFunction(() => location.hash.startsWith('#/recent?within=all&program='));
  assert.equal(hashOf(remembered), '#/recent?within=all&program=web_bounty%2Facme-cloud&program=web_bounty%2Fglobex&lane=web&order=oldest&nav=1');
  await remembered.close();
  // Middle-click on the sidebar item opens the same filtered view in a new tab.
  const [popup] = await Promise.all([context.waitForEvent('page'), page.locator('.nav a[data-view="recent"]').click({button: 'middle'})]);
  popup.setDefaultTimeout(10000);
  await recentSettled(popup, FULL_ROWS);
  assert.equal(hashOf(popup), FULL);
  await popup.close();
  assert.deepEqual(bad, [], 'no rejected recent-report requests');
}));

test('Recent view paging: page in the URL, Next pushes history, Back returns, cold page link', {timeout: 120000}, async () => withFixture(async ({page, url}) => {
  await page.goto(`${url}#/recent?within=7d&order=newest&page=2`);
  await page.locator('.recent-status', {hasText: 'Showing 51 to 64 of 64 reports'}).waitFor();
  assert.equal(hashOf(page), '#/recent?within=7d&order=newest&page=2');
  assert.equal(await page.locator('.recent-pager .hint').innerText(), 'Page 2 of 2');
  await page.getByRole('button', {name: 'Previous'}).click();
  await page.locator('.recent-status', {hasText: 'Showing 1 to 50 of 64 reports'}).waitFor();
  assert.equal(hashOf(page), '#/recent?within=7d&order=newest');
  const before = await historyLength(page);
  await page.getByRole('button', {name: 'Next'}).click();
  await page.locator('.recent-status', {hasText: 'Showing 51 to 64'}).waitFor();
  assert.equal(hashOf(page), '#/recent?within=7d&order=newest&page=2');
  assert.equal(await historyLength(page), before + 1, 'a page change pushes');
  await page.goBack();
  await page.locator('.recent-status', {hasText: 'Showing 1 to 50 of 64 reports'}).waitFor();
  assert.equal(hashOf(page), '#/recent?within=7d&order=newest');
  // A filter change returns to page 1 and replaces.
  await page.getByRole('button', {name: 'Next'}).click();
  await page.locator('.recent-status', {hasText: 'Showing 51 to 64'}).waitFor();
  const atPage2 = await historyLength(page);
  await page.locator('[data-recent-order]').click();
  await page.locator('.recent-status', {hasText: 'Showing 1 to 50 of 64 reports'}).waitFor();
  assert.equal(hashOf(page), '#/recent?within=7d&order=oldest');
  assert.equal(await historyLength(page), atPage2);
  // A page past the end lands on the last page and fixes the link.
  await page.goto(`${url}#/recent?within=7d&order=newest&page=9`);
  await page.reload();
  await page.locator('.recent-status', {hasText: 'Showing 51 to 64 of 64 reports'}).waitFor();
  await page.waitForFunction(() => location.hash === '#/recent?within=7d&order=newest&page=2');
  assert.equal((await recentRows(page)).length, 14);
}, {EXTRA_REPORTS: '60'}));

test('Sidebar items and section tabs are links: correct hrefs, modified clicks open new tabs, plain clicks stay in-app', {timeout: 150000}, async () => withFixture(async ({page, context, url}) => {
  await page.goto(url);
  await page.getByRole('heading', {name: 'Portfolio overview'}).waitFor();
  const nav = name => page.getByRole('link', {name, exact: true});
  assert.equal(await nav('Dashboard').getAttribute('href'), '#/dashboard');
  assert.equal(await nav('Dashboard').getAttribute('aria-current'), 'page');
  assert.equal(await nav('Recent reports').getAttribute('href'), '#/recent');
  assert.match(await nav('Programs').getAttribute('href'), /^#\/programs/);
  // Program table link: an explicit choice, so it also lands in the sidebar's recent list.
  await page.evaluate(() => { window.__noReload = true; });
  await page.locator('[data-open-program="web_bounty/acme-cloud"]').click();
  await page.getByRole('heading', {name: 'acme-cloud', level: 1}).waitFor();
  await page.evaluate(route => { location.hash = route; }, `#/programs/${ACME}/web/findings`); // first lane is api
  await page.locator('tr[data-finding-id="AC-1"]').waitFor();
  const tab = name => page.locator('.workspace-nav').getByRole('link', {name, exact: true});
  for (const [name, section] of [['Findings', 'findings'], ['Coverage', 'coverage'], ['Reports', 'reports'], ['MapStore', 'map'], ['Gadgets', 'gadgets']])
    assert.equal(await tab(name).getAttribute('href'), `#/programs/${ACME}/web/${section}`);
  assert.equal(await tab('Findings').getAttribute('aria-current'), 'page');
  assert.equal(await nav('Programs').getAttribute('href'), `#/programs/${ACME}/web/findings`);
  assert.equal(await nav('Programs').getAttribute('aria-current'), 'page');
  // Plain click on a tab: in-app, focus stays on the tab, active state moves.
  await tab('Reports').click();
  await page.locator('#report-select').waitFor();
  const reportHash = `#/programs/${ACME}/web/reports/${encodeURIComponent(await selected(page))}`;
  assert.equal(hashOf(page), reportHash);
  assert.equal(await tab('Reports').getAttribute('aria-current'), 'page');
  assert.equal(await tab('Findings').getAttribute('aria-current'), null);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.section), 'reports');
  assert.equal(await tab('Reports').getAttribute('href'), reportHash, 'the Reports tab keeps the open report');
  // Keyboard: Enter on a focused tab link.
  await tab('Coverage').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(want => location.hash === want, `#/programs/${ACME}/web/coverage`);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.section), 'coverage');
  // Ctrl+click and middle click on tabs open new pages on that section; this page stays.
  const [ctrlTab] = await Promise.all([context.waitForEvent('page'), tab('Findings').click({modifiers: ['Control']})]);
  ctrlTab.setDefaultTimeout(10000);
  await ctrlTab.locator('.workspace-nav a[data-section="findings"][aria-current="page"]').waitFor();
  assert.equal(hashOf(ctrlTab), `#/programs/${ACME}/web/findings`);
  await ctrlTab.locator('tr[data-finding-id="AC-1"]').waitFor();
  await ctrlTab.close();
  const [midTab] = await Promise.all([context.waitForEvent('page'), tab('Gadgets').click({button: 'middle'})]);
  midTab.setDefaultTimeout(10000);
  await midTab.locator('.workspace-nav a[data-section="gadgets"][aria-current="page"]').waitFor();
  await midTab.close();
  assert.equal(hashOf(page), `#/programs/${ACME}/web/coverage`);
  // Sidebar: modified clicks open new pages on the right view.
  const [dash] = await Promise.all([context.waitForEvent('page'), nav('Dashboard').click({modifiers: ['Control']})]);
  dash.setDefaultTimeout(10000);
  await dash.getByRole('heading', {name: 'Portfolio overview'}).waitFor();
  assert.equal(hashOf(dash), '#/dashboard');
  await dash.close();
  const [recent] = await Promise.all([context.waitForEvent('page'), nav('Recent reports').click({button: 'middle'})]);
  recent.setDefaultTimeout(10000);
  await recent.getByRole('heading', {name: 'Recent reports', level: 1}).waitFor();
  await recentSettled(recent, ['Globex SQLi report', 'Stored XSS report', 'Initech APK notes', 'Invoice IDOR report']);
  await recent.close();
  const [prog] = await Promise.all([context.waitForEvent('page'), nav('Programs').click({modifiers: ['Control']})]);
  prog.setDefaultTimeout(10000);
  await prog.locator('.workspace-nav a[data-section="coverage"][aria-current="page"]').waitFor();
  assert.equal(await prog.getByRole('heading', {level: 1}).innerText(), 'acme-cloud');
  await prog.close();
  // Recently used programs in the sidebar are links too.
  const side = page.locator('#recent-programs a[data-recent-program="web_bounty/acme-cloud"]');
  assert.equal(await side.getAttribute('href'), `#/programs/${ACME}/web/coverage`);
  const [sideTab] = await Promise.all([context.waitForEvent('page'), side.click({modifiers: ['Control']})]);
  sideTab.setDefaultTimeout(10000);
  await sideTab.locator('.workspace-nav a[data-section="coverage"][aria-current="page"]').waitFor();
  await sideTab.close();
  // Plain clicks on sidebar items stay in-app.
  await nav('Dashboard').click();
  await page.getByRole('heading', {name: 'Portfolio overview'}).waitFor();
  assert.equal(hashOf(page), '#/dashboard');
  assert.equal(await nav('Dashboard').getAttribute('aria-current'), 'page');
  await nav('Recent reports').click();
  await page.getByRole('heading', {name: 'Recent reports', level: 1}).waitFor();
  await page.waitForFunction(() => location.hash === '#/recent?within=7d&order=newest');
  await nav('Programs').click();
  await page.locator('.workspace-nav a[data-section="coverage"][aria-current="page"]').waitFor();
  assert.equal(hashOf(page), `#/programs/${ACME}/web/coverage`);
  await page.goBack();
  await page.getByRole('heading', {name: 'Recent reports', level: 1}).waitFor();
  assert.equal(await page.evaluate(() => window.__noReload), true, 'no plain click reloaded the page');
  // Collapsed sidebar keeps the links and their names.
  await page.locator('#sidebar-toggle').click();
  assert.equal(await nav('Dashboard').getAttribute('href'), '#/dashboard');
}));
