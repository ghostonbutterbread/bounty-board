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
  await page.getByRole('button', {name: 'Dashboard', exact: true}).click();
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
  assert.equal(new URL(page.url()).hash, '#/recent');
  await page.getByRole('heading', {name: 'Recent reports', level: 1}).waitFor();
  const titles = () => page.locator('.recent-table a.recent-link').allInnerTexts();
  const rowsSettled = async expected => page.waitForFunction(want => JSON.stringify([...document.querySelectorAll('.recent-table a.recent-link')].map(a => a.textContent)) === JSON.stringify(want), expected);
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
  assert.equal(new URL(page.url()).hash, '#/recent');
  // A new report shows up on refresh; the sidebar item opens the view.
  assert.equal((await titles()).length, 7);
  await page.reload();
  await page.getByRole('button', {name: 'Recent reports'}).waitFor();
  await page.locator('.recent-table a.recent-link').first().waitFor();
  assert.equal(await page.locator('[data-view="recent"]').getAttribute('aria-current'), 'page');
  // Phone width: neither the view nor the dashboard widens the page.
  await page.setViewportSize({width: 375, height: 800});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), 'recent view fits 375 px');
  await page.getByRole('button', {name: 'Dashboard', exact: true}).click();
  await panel.locator('a.recent-link').first().waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), 'dashboard fits 375 px');
}));
