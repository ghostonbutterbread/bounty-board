'use strict';
// Interactive Recon page (feat/board-recon-interactive) against a synthetic backend
// (tests/recon_interactive_fixture.py) with a fake BBH writer. SHOT_DIR (optional)
// receives screenshots of synthetic data: light, dark, dusk, wide and phone.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

const until = async (fn, label = 'condition', ms = 15000) => {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { if (await fn()) return; } catch (e) { last = e; } await new Promise(r => setTimeout(r, 60)); }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
};

async function withBoard(mode, fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'brx-'));
  const repo = path.resolve(__dirname, '../..');
  const child = spawn('python3', ['-u', 'tests/recon_interactive_fixture.py', base, mode], {cwd: repo, env: {...process.env, PYTHONPATH: repo}, stdio: ['ignore', 'pipe', 'inherit']});
  let browser;
  try {
    const port = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', c => reject(new Error(`fixture exited ${c}`))); child.stdout.once('data', d => resolve(Number(String(d).trim()))); });
    const origin = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const context = await browser.newContext({viewport: {width: 1360, height: 1000}});
    const page = await context.newPage();
    const errors = [], outside = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/*', route => { const u = new URL(route.request().url()); if (u.hostname === '127.0.0.1') return route.continue(); outside.push(u.hostname); return route.abort(); });
    const lane = path.join(base, 'home/Shared/web_bounty/acme-demo/web');
    const finding = fid => JSON.parse(fs.readFileSync(path.join(lane, 'ledgers/ledger.json'), 'utf8')).findings.find(f => f.fid === fid);
    const calls = () => fs.existsSync(path.join(base, 'writer.log')) ? fs.readFileSync(path.join(base, 'writer.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const shots = process.env.SHOT_DIR;
    if (shots) fs.mkdirSync(shots, {recursive: true});
    const shot = async (name, locator) => { if (!shots) return; if (!locator) await page.evaluate(() => window.scrollTo(0, 0)); await (locator || page).screenshot({path: path.join(shots, name), ...(locator ? {} : {fullPage: true})}); };
    await fn({page, origin, base, finding, calls, shot});
    assert.deepEqual(errors, []);
    assert.deepEqual(outside, []);
  } finally {
    await browser?.close();
    child.kill();
    fs.rmSync(base, {recursive: true, force: true});
  }
}
const programUrl = (origin, extra = '') => `${origin}/#/recon?p=web_bounty%2Facme-demo&lane=web${extra}`;
const rows = page => page.locator('tr[data-ru-row]');
const rowIds = page => rows(page).evaluateAll(trs => trs.map(t => Number(t.dataset.ruRow)));
const waitRows = (page, n, label) => until(async () => (await rows(page).count()) === n && !(await page.locator('[data-ru-status]').innerText()).includes('updating'), label || `${n} URL rows`);

test('URL browser: links from counts, keyset pages, filters in the hash, history and marks', {timeout: 180000}, () => withBoard('writer', async ({page, origin, base, calls, shot}) => {
  // Dashboard card rows open that program's Recon page (the whole row is the link).
  await page.goto(`${origin}/#/dashboard`);
  const cardRow = page.locator('#dashboard-recon-host [data-ri-card-row]').filter({hasText: 'acme-demo'});
  await cardRow.waitFor({timeout: 30000});
  await cardRow.click({position: {x: 600, y: 10}}); // a click anywhere on the row, not only on the name
  await page.waitForFunction(() => location.hash.startsWith('#/recon?p=web_bounty%2Facme-demo&lane=web'));
  await page.locator('[data-ri-depth]').waitFor({timeout: 30000});
  await until(async () => (await page.locator('[data-ri-depth] a[data-ri-urls]').count()) > 0, 'depth links');

  // The URLs count opens the URL browser (a real link, filters in the hash).
  const urlsLink = page.locator('[data-ri-depth] .ri-stat').filter({hasText: 'URLs'}).first().locator('a[data-ri-urls]');
  assert.match(await urlsLink.getAttribute('href'), /^#\/recon\?p=web_bounty%2Facme-demo&lane=web.*&u=1/);
  await urlsLink.click();
  await page.locator('#ri-urls').waitFor();
  await waitRows(page, 50, 'first page');
  const first = await rowIds(page);
  assert.deepEqual(first, [...first].sort((a, b) => a - b));
  await page.locator('[data-ru-page="next"]').click();
  await page.waitForFunction(() => /[?&]ua=\d+/.test(location.hash));
  await until(async () => (await rowIds(page))[0] > first[first.length - 1], 'second page starts after the first');
  const second = await rowIds(page);
  assert.equal(second.length, 49);
  assert.ok(!second.some(id => first.includes(id)), 'no overlap between pages');
  await page.locator('[data-ru-page="prev"]').click();
  await until(async () => (await rowIds(page))[0] === first[0], 'previous page');

  // A host row opens its URLs; the history of a tested URL links its report evidence.
  await page.locator('tr[data-ri-host="app.example.test"] td.ri-host a[data-ri-urls]').click();
  await page.waitForFunction(() => location.hash.includes('uh=app.example.test'));
  await waitRows(page, 50, 'host page 1');
  assert.equal(await page.locator('[data-ru-filters] input[name=host]').inputValue(), 'app.example.test');
  const tested = rows(page).filter({hasText: 'Surface reviewed'}).first();
  const testedId = await tested.getAttribute('data-ru-row');
  await tested.locator(`[data-ru-history="${testedId}"]`).click();
  const history = page.locator(`[data-ru-history-panel="${testedId}"]`);
  await history.waitFor();
  assert.match(await history.innerText(), /reflected safely/);
  assert.equal(await history.locator('a', {hasText: 'reports/xss-notes.md'}).first().getAttribute('href'), '#/programs/web_bounty%2Facme-demo/web/reports/xss-notes.md');
  await shot('recon-urls-light.png');

  // Filters: status, has parameters, parameter name. All in the hash and kept on reload.
  await page.locator('[data-ru-filters] select[name=status]').selectOption('untested');
  await page.locator('[data-ru-filters] input[name=params]').check();
  await page.locator('[data-ru-filters] input[name=param]').fill('file');
  await page.waitForFunction(() => location.hash.includes('us=untested') && location.hash.includes('up=1') && location.hash.includes('un=file'));
  await until(async () => { const n = await rows(page).count(); return n > 0 && n < 20 && (await page.locator('tr[data-ru-row] .ru-path').allInnerTexts()).every(t => t.includes('file=')); }, 'file rows');
  const filtered = await rowIds(page);
  await page.reload();
  await until(async () => JSON.stringify(await rowIds(page)) === JSON.stringify(filtered), 'same rows after reload');
  assert.equal(await page.locator('[data-ru-filters] select[name=status]').inputValue(), 'untested');

  // Hunt next parameters open the matching untested URLs.
  await page.locator('[data-ri-hunt="param"][data-param="next"] a[data-ri-urls]').click();
  await page.waitForFunction(() => location.hash.includes('un=next') && location.hash.includes('us=untested') && location.hash.includes('ul=open-redirect'));
  await until(async () => (await rows(page).count()) > 0 && (await page.locator('tr[data-ru-row] .ru-path').allInnerTexts()).every(t => t.includes('next=')), 'next rows');

  // Mark one URL: BBH url_ingest mark runs with the mapped arguments; the row and the summary update.
  const target = rows(page).first();
  const targetId = Number(await target.getAttribute('data-ru-row'));
  const targetUrl = await page.evaluate(id => window.BoardReconUrls && document.querySelector(`tr[data-ru-row="${id}"] .ru-path`).textContent, targetId);
  await target.locator('[data-ru-mark]').click();
  const form = page.locator('.ru-mark-form');
  await form.locator('select[name=lane]').selectOption('open-redirect');
  await form.locator('select[name=status]').selectOption('deep_reviewed');
  await form.locator('input[name=param]').fill('next');
  await form.locator('input[name=notes]').fill('checked with an owned account');
  await shot('recon-mark-form.png', page.locator('.ru-mark-popover'));
  await form.getByRole('button', {name: 'Mark', exact: true}).click();
  await until(async () => (await page.locator(`tr[data-ru-row="${targetId}"] .ru-result.is-ok`).count()) === 1, 'row marked');
  const call = calls().at(-1);
  assert.deepEqual(call.slice(0, 3), ['agents/url_ingest.py', 'mark', 'acme-demo']);
  assert.ok(call[3].startsWith('--url=https://app.example.test/') && call[3].endsWith(targetUrl), call[3]);
  assert.deepEqual(call.slice(4), ['--lane=open-redirect', '--status=deep_reviewed', '--agent-id=bounty-board', '--param=next', '--param-location=query', '--notes=checked with an owned account']);
  assert.match(await page.locator(`tr[data-ru-row="${targetId}"] .ru-lanes`).innerText(), /open-redirect\s*next\s*Deep reviewed/);
  const testedTile = page.locator('[data-ri-depth] .ri-stat').filter({hasText: 'Tested URLs'});
  await until(async () => (await testedTile.locator('strong').innerText()).trim() === '5', 'tested URLs recomputed (4 to 5)', 30000);

  // Bulk mark: sequential BBH calls with progress.
  await page.goto(programUrl(origin, '&u=1&uh=static.example.test'));
  await waitRows(page, 8, 'static host rows');
  const before = calls().length;
  for (const box of (await page.locator('.ru-row-select').all()).slice(0, 3)) await box.check();
  assert.match(await page.locator('[data-ru-bulk]').innerText(), /3 selected/);
  await page.locator('[data-ru-bulk-mark]').click();
  await page.locator('.ru-mark-form select[name=status]').selectOption('surface_reviewed');
  await page.locator('.ru-mark-form').getByRole('button', {name: 'Mark 3'}).click();
  await until(async () => /Marked 3 of 3/.test(await page.locator('[data-ru-bulk]').innerText()), 'bulk done');
  assert.equal(calls().length - before, 3);
  assert.ok(calls().slice(-3).every(c => c[1] === 'mark' && c.includes('--status=surface_reviewed') && c.includes('--lane=recon')));
  await page.locator('[data-ru-bulk-close]').click();

  // A URL with control characters is shown escaped and cannot be marked.
  await page.goto(programUrl(origin, '&u=1&uq=evil'));
  await waitRows(page, 1, 'unsafe row');
  const unsafe = rows(page).first();
  assert.match(await unsafe.innerText(), /evil\\u202e/);
  assert.match(await unsafe.innerText(), /contains control characters/);
  assert.equal(await unsafe.locator('[data-ru-mark], .ru-row-select, a.row-icon').count(), 0);

  // A failing BBH call stops the bulk run, reports per row, and turns editing off.
  await page.goto(programUrl(origin, '&u=1&uh=api.example.test'));
  await waitRows(page, 30, 'api host rows');
  for (const box of (await page.locator('.ru-row-select').all()).slice(0, 2)) await box.check();
  fs.writeFileSync(path.join(base, 'mode'), 'fail');
  await page.locator('[data-ru-bulk-mark]').click();
  await page.locator('.ru-mark-form').getByRole('button', {name: 'Mark 2'}).click();
  await until(async () => /1 failed/.test(await page.locator('[data-ru-bulk]').innerText()), 'failure reported');
  assert.match(await page.locator('[data-ru-bulk]').innerText(), /Stopped after a writer failure: 1 not attempted/);
  assert.equal(await page.locator('tr.ru-failed').count(), 1);
  await until(async () => (await page.locator('[data-ru-mark]').count()) === 0, 'editing off after the failure');
  assert.match(await page.locator('#ri-urls').innerText(), /Editing is off/);
}));

test('findings and reports on the Recon page use the dashboard panels', {timeout: 150000}, () => withBoard('writer', async ({page, origin, finding, shot}) => {
  await page.goto(programUrl(origin));
  const panels = page.locator('[data-ri-slot="findings"] #recon-scope-panels');
  await panels.waitFor({timeout: 30000});
  assert.equal(await panels.locator('.breakdown-row[data-breakdown^="sev:"]').count(), 3); // MEDIUM, HIGH, LOW (archived hidden)
  // Pill edit through the existing metadata path.
  await panels.locator('.breakdown-row[data-breakdown="sev:low"]').click();
  await panels.locator('li[data-finding-id="D03"]').waitFor();
  await panels.locator('li[data-finding-id="D03"] [data-sev-pick]').click();
  await page.getByRole('menu', {name: 'Change severity'}).getByRole('menuitemradio', {name: 'Medium'}).click();
  await until(() => finding('D03').severity === 'MEDIUM', 'D03 saved as MEDIUM');
  // The scoped expansion survives the refresh; the row moved to the MEDIUM group.
  await panels.locator('.breakdown-row[data-breakdown="sev:medium"]').click();
  await page.locator('#recon-scope-panels li[data-finding-id="D03"]').waitFor();
  // Context menu on a drill row.
  await page.locator('#recon-scope-panels li[data-finding-id="D01"] a.link-button').click({button: 'right'});
  const menu = page.getByRole('menu', {name: 'Actions for Reflected value in search'});
  await menu.waitFor();
  assert.equal(await menu.getByRole('menuitem', {name: 'Change severity…'}).isDisabled(), false);
  await page.keyboard.press('Escape');
  // Drag one row onto a class row (single row: no confirm).
  const source = page.locator('#recon-scope-panels li[data-finding-id="D03"] a.link-button');
  const targetRow = page.locator('#recon-scope-panels .breakdown-row[data-class-name="idor"]');
  await targetRow.evaluate(n => n.scrollIntoView({block: 'center'}));
  await source.dragTo(targetRow);
  await until(() => finding('D03').class_name === 'idor', 'D03 class moved to idor');
  // Selection and bulk bar from the scoped drill list.
  const open = async key => { const r = page.locator(`#recon-scope-panels .breakdown-row[data-breakdown="${key}"]`); if (await r.getAttribute('aria-expanded') !== 'true') await r.click(); };
  await open('sev:medium');
  await until(async () => (await page.locator('#recon-scope-panels .drill li[data-finding-id]').count()) > 0, 'drill open');
  await page.locator('#recon-scope-panels [data-select-list="drill"]').click();
  await page.getByRole('region', {name: 'Selected findings'}).waitFor();
  await shot('recon-findings-light.png', page.locator('#recon-scope-panels'));
  // Archive (Delete) from the bulk bar, through the existing status write.
  await page.keyboard.press('Escape'); // clears the selection
  await open('sev:low');
  await page.locator('#recon-scope-panels li[data-finding-id="D04"]').waitFor();
  await page.locator('#recon-scope-panels li[data-finding-id="D04"] a.link-button').click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Delete…'}).click();
  await page.getByRole('dialog', {name: 'Delete 1 finding?'}).getByRole('button', {name: 'Delete (archive)'}).click();
  await until(() => finding('D04').status === 'archive', 'D04 archived');

  // Reports panel: Recent rows for this lane, finding pills, link to the full list.
  const reports = page.locator('#recon-reports-host');
  await reports.locator('[data-recent-row]').first().waitFor({timeout: 30000});
  assert.match(await reports.innerText(), /Reflected value report/);
  assert.equal(await reports.locator('a', {hasText: 'All reports'}).getAttribute('href'), '#/programs/web_bounty%2Facme-demo/web/reports');
  assert.equal(await reports.locator('[data-recent-row][data-path="D01/REPORT.md"] [data-recent-pick="sev"]').count(), 1);
  await shot('recon-reports-light.png', reports);

  // Host findings count opens those findings.
  await page.locator('tr[data-ri-host="app.example.test"] [data-ri-host-findings]').click();
  const popover = page.locator('.ri-host-findings-popover');
  await popover.waitFor();
  assert.equal(await popover.locator('a', {hasText: 'Reflected value in search'}).getAttribute('href'), '#/programs/web_bounty%2Facme-demo/web/findings/D01');
  await page.keyboard.press('Escape');
}));

test('writer off: no Mark; layouts in light, dark, dusk, wide and phone', {timeout: 120000}, () => withBoard('readonly', async ({page, origin, shot}) => {
  await page.goto(programUrl(origin, '&u=1'));
  await waitRows(page, 50, 'rows');
  assert.equal(await page.locator('[data-ru-mark], .ru-row-select').count(), 0);
  assert.match(await page.locator('#ri-urls').innerText(), /Editing is off: the backend has not enabled the BBH writer\./);
  await page.locator('#recon-scope-panels').waitFor();
  await until(async () => (await page.locator('.ri-computing').count()) === 0 && (await page.locator('[data-ri-depth] a[data-ri-urls]').count()) > 0, 'summary computed', 30000);
  await page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
  await shot('recon-program-light.png');
  for (const theme of ['dark', 'dusk']) {
    await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    await shot(`recon-program-${theme}.png`);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.setViewportSize({width: 1680, height: 1000});
  await shot('recon-program-wide.png');
  await page.setViewportSize({width: 390, height: 844});
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `phone layout overflows by ${overflow}px`);
  await shot('recon-program-phone.png');
}));
