// UI redesign behaviors against disposable synthetic fixtures only.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

const repo = path.resolve(__dirname, '../..');

async function withFixture(script, run, env={}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bui-'));
  const child = spawn('python3', ['-u', script, root], {cwd: repo, env: {...process.env, ...env, PYTHONPATH: repo}, stdio: ['ignore', 'pipe', 'inherit']});
  let browser;
  try {
    const port = await new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', code => reject(Error(`fixture exited ${code}`))); child.stdout.once('data', data => resolve(Number(String(data).trim())));});
    browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_BIN, args: ['--no-sandbox', '--disable-dev-shm-usage', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const context = await browser.newContext({viewport: {width: 1440, height: 900}});
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    await run({page, root, url: `http://127.0.0.1:${port}/`, context});
  } finally {
    try {fs.writeFileSync(path.join(root, 'release'), 'release');} catch {}
    if (browser) await browser.close();
    child.kill('SIGTERM'); await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
    fs.rmSync(root, {recursive: true, force: true});
  }
}
const showcase = run => withFixture('tests/ui_showcase_fixture.py', run);
const stat = (page, label) => page.locator('.stat').filter({hasText: label}).locator('strong');
async function ready(page, url) {
  await page.goto(url);
  await page.getByRole('heading', {name: 'Portfolio overview'}).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.stat')].some(e => e.textContent.includes('Report records') && /^\d+$/.test(e.querySelector('strong')?.textContent || '')));
}

test('dashboard breakdown lists findings by program and opens the finding; history returns', {timeout: 60000}, async () => showcase(async ({page, url}) => {
  await ready(page, url);
  assert.equal(new URL(page.url()).hash, '#/dashboard');
  const critical = page.getByRole('region', {name: 'Severity breakdown'}).locator('[data-breakdown="sev:critical"]');
  assert.equal(await critical.getAttribute('aria-expanded'), 'false');
  await critical.click();
  assert.equal(await critical.getAttribute('aria-expanded'), 'true');
  const drill = page.locator('.drill');
  assert.match(await drill.innerText(), /acme-cloud \/ web/);
  assert.match(await drill.innerText(), /umbrella-desktop \/ exe/);
  assert.equal(await critical.evaluate(el => el === document.activeElement), true, 'focus stays on the expanded row');
  // Drill-down entries are real links (open in a new tab with a modified click).
  await drill.getByRole('link', {name: 'Invoice export reachable across organizations by numeric ID'}).click();
  await page.locator('tr.highlight[data-finding-id="AC-102"]').waitFor();
  assert.equal(await page.locator('#program-select').inputValue(), 'web_bounty/acme-cloud');
  assert.equal(await page.locator('#lane-select').inputValue(), 'web');
  assert.equal(new URL(page.url()).hash, '#/programs/web_bounty%2Facme-cloud/web/findings');
  const row = page.locator('tr[data-finding-id="AC-102"]');
  assert.equal(await row.getAttribute('data-program'), 'web_bounty/acme-cloud');
  assert.equal(await row.getAttribute('data-lane'), 'web');
  await page.goBack();
  await page.getByRole('heading', {name: 'Portfolio overview'}).waitFor();
  await page.goForward();
  await page.locator('tr[data-finding-id="AC-102"]').waitFor();
  // A report link in a drill-down opens that exact report.
  await page.getByRole('link', {name: 'Dashboard', exact: true}).click();
  await page.locator('[data-breakdown="class:ssrf"]').click();
  await page.locator('.drill').getByRole('link', {name: /Report/}).click();
  await page.locator('.CodeMirror').waitFor();
  assert.equal(await page.locator('#report-select').inputValue(), 'ac-202-webhook-ssrf.md');
  assert.match(new URL(page.url()).hash, /\/api\/reports\/ac-202-webhook-ssrf\.md$/);
  await page.reload();
  await page.locator('.CodeMirror').waitFor();
  assert.equal(await page.locator('#report-select').inputValue(), 'ac-202-webhook-ssrf.md', 'reload restores the routed report');
}));

test('not-submitted filter, program search and explicit workspace target', {timeout: 60000}, async () => showcase(async ({page, url}) => {
  await ready(page, url);
  // One showcase finding is archived; archived findings are hidden unless "Show archived" is on.
  assert.equal(await stat(page, 'Finding records').innerText(), '16');
  await page.getByLabel('Show archived').check();
  assert.equal(await stat(page, 'Finding records').innerText(), '17');
  await page.getByLabel('Show archived').uncheck();
  assert.match(await page.locator('.target-note').innerText(), /First program; none chosen yet/);
  await page.getByRole('button', {name: 'Not submitted', exact: true}).click();
  assert.equal(await page.getByRole('button', {name: 'Not submitted', exact: true}).getAttribute('aria-pressed'), 'true');
  // Missing submission records default to not submitted (BBH semantics).
  assert.equal(await stat(page, 'Finding records').innerText(), '11');
  await page.reload();
  await page.getByRole('heading', {name: 'Portfolio overview'}).waitFor();
  assert.equal(await page.getByRole('button', {name: 'Not submitted', exact: true}).getAttribute('aria-pressed'), 'true', 'preference persists');
  await page.getByRole('button', {name: 'All records', exact: true}).click();
  const search = page.getByRole('searchbox', {name: 'Search programs'});
  await search.fill('north');
  assert.equal(await page.locator('[data-program-row]:visible').count(), 1);
  await search.fill('zzz-none');
  await page.getByText('No programs match this search.').waitFor();
  await search.fill('');
  // The picker searches programs and opens the chosen one explicitly.
  await page.getByRole('button', {name: 'Switch program'}).click();
  const picker = page.getByRole('combobox', {name: 'Search programs'});
  assert.equal(await picker.evaluate(el => el === document.activeElement), true);
  await picker.fill('initech');
  await page.keyboard.press('Enter');
  await page.getByText('Exported activity accepts arbitrary deep link URL into WebView').waitFor();
  assert.equal(await page.locator('#program-select').inputValue(), 'binaries/initech-mobile');
  assert.equal(await page.locator('.context-note').count(), 0, 'an explicit choice is not labelled as a default');
  await page.getByRole('link', {name: 'Dashboard', exact: true}).click();
  assert.match(await page.locator('.target-note').innerText(), /initech-mobile/);
  assert.match(await page.locator('.target-note').innerText(), /Current selection|Last used/);
  assert.equal(await page.locator('#recent-programs [data-recent-program]').count(), 1);
}));

test('multi-select filters, chips, persisted sort and row actions', {timeout: 60000}, async () => showcase(async ({page, url}) => {
  await ready(page, url);
  await page.goto(`${url}#/programs/${encodeURIComponent('web_bounty/acme-cloud')}/web/findings`);
  await page.locator('tr[data-finding-id]').first().waitFor();
  assert.equal(await page.locator('tr[data-finding-id]').count(), 5);
  const trigger = page.getByRole('button', {name: 'Filter severities', exact: true});
  await trigger.click();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  await page.getByRole('checkbox', {name: 'HIGH'}).check();
  await page.getByRole('checkbox', {name: 'CRITICAL'}).check();
  assert.equal(await page.getByRole('checkbox', {name: 'CRITICAL'}).evaluate(el => el === document.activeElement), true, 'popover stays open while selecting');
  await page.keyboard.press('Escape');
  assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'Escape returns focus to the trigger');
  assert.equal(await page.locator('tr[data-finding-id]').count(), 2);
  assert.equal(await page.locator('[data-filter-chip]').count(), 2);
  await page.getByRole('button', {name: 'Remove filter Severity HIGH'}).click();
  assert.equal(await page.locator('tr[data-finding-id]').count(), 1);
  assert.equal(await page.getByRole('button', {name: 'Remove filter Severity CRITICAL'}).evaluate(el => el === document.activeElement), true, 'focus moves to the next chip');
  await page.getByRole('button', {name: 'Clear all'}).click();
  assert.equal(await page.locator('tr[data-finding-id]').count(), 5);
  // Severity sort ranks by the severity scale and persists across reloads.
  await page.locator('[data-sort="severity"]').click();
  assert.equal(await page.locator('th[aria-sort="ascending"]').count(), 1);
  assert.equal(await page.locator('tr[data-finding-id]').first().getAttribute('data-finding-id'), 'AC-102');
  await page.locator('[data-sort="severity"]').click();
  assert.equal(await page.locator('tr[data-finding-id]').first().getAttribute('data-finding-id'), 'AC-104');
  await page.reload();
  await page.locator('tr[data-finding-id]').first().waitFor();
  assert.equal(await page.locator('th[aria-sort="descending"]').count(), 1);
  assert.equal(await page.locator('tr[data-finding-id]').first().getAttribute('data-finding-id'), 'AC-104');
  // Row action menu is keyboard operable and opens the owned report.
  const kebab = page.getByRole('button', {name: 'Actions for Stored XSS in project description renders for invited members'});
  await kebab.focus(); await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', {name: 'Actions for Stored XSS in project description renders for invited members'});
  await menu.waitFor();
  assert.equal(await menu.getByRole('menuitem').first().evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('ArrowDown');
  assert.equal(await menu.getByRole('menuitem', {name: 'Open report'}).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.locator('.CodeMirror').waitFor();
  assert.equal(await page.locator('#report-select').inputValue(), 'ac-101-stored-xss.md');
  // Non-live editor: the EasyMDE toolbar keeps a normal height (the report
  // preview rule no longer matches the toolbar's "preview" button).
  assert.ok((await page.locator('.editor-toolbar').boundingBox()).height < 60);
  // Drop-target hooks and module hosts exist for other feature modules.
  assert.equal(await page.locator('.tabs [data-section="map"].drop-target').count(), 1);
  assert.equal(await page.locator('.tabs [data-section="gadgets"].drop-target').count(), 1);
  assert.equal(await page.locator('#global-search-host').count(), 1);
  assert.equal(await page.evaluate(() => typeof window.BoardUI?.toast), 'function');
}));

test('theme menu is keyboard operable and persists', {timeout: 60000}, async () => showcase(async ({page, url}) => {
  await ready(page, url);
  const button = page.getByRole('button', {name: 'Theme', exact: true});
  await button.focus(); await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', {name: 'Theme'});
  await menu.waitFor();
  assert.equal(await menu.getByRole('menuitemradio', {name: 'Light'}).getAttribute('aria-checked'), 'true');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await button.evaluate(el => el === document.activeElement), true);
  await button.click(); await page.keyboard.press('Escape');
  assert.equal(await menu.count(), 0);
  await page.reload();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  // The sidebar collapses to an icon rail; names stay available and it persists.
  await page.getByRole('button', {name: 'Collapse sidebar'}).click();
  assert.equal(await page.locator('#shell.sidebar-collapsed').count(), 1);
  assert.equal(await page.getByRole('button', {name: 'Expand sidebar'}).getAttribute('aria-expanded'), 'false');
  await page.reload();
  assert.equal(await page.locator('#shell.sidebar-collapsed').count(), 1);
  await page.getByRole('link', {name: 'Programs', exact: true}).click();
  await page.locator('#program-select').waitFor();
  await page.getByRole('button', {name: 'Expand sidebar'}).click();
  assert.equal(await page.locator('#shell.sidebar-collapsed').count(), 0);
}));

test('tablet width keeps navigation usable without horizontal overflow', {timeout: 60000}, async () => showcase(async ({page, url}) => {
  await page.setViewportSize({width: 820, height: 1000});
  await ready(page, url);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.getByRole('link', {name: 'Programs', exact: true}).click();
  await page.locator('tr[data-finding-id]').first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
}));

// Completed portfolio data waits while a text field is focused and then applies
// itself once focus leaves, keeping the explicit button for an immediate apply.
test('loaded reports apply automatically after editing focus leaves', {timeout: 60000}, async () => withFixture('tests/progressive_browser_fixture.py', async ({page, root, url}) => {
  await page.goto(url);
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(root, 'entered'))) {if (Date.now() > deadline) throw Error('report barrier not reached'); await new Promise(r => setTimeout(r, 10));}
  await page.getByRole('button', {name: 'Open workspace'}).click();
  const search = page.getByLabel('Search findings');
  await search.waitFor();
  await search.fill('synthetic');
  fs.writeFileSync(path.join(root, 'release'), 'release');
  await page.getByRole('button', {name: 'Apply loaded reports'}).waitFor();
  assert.equal(await search.inputValue(), 'synthetic');
  assert.equal(await search.evaluate(el => el === document.activeElement), true, 'focus is not disturbed');
  await page.getByRole('heading', {name: 'Findings ledger'}).click();
  await page.locator('.toast').filter({hasText: 'Reports loaded'}).waitFor();
  assert.equal(await page.getByRole('button', {name: 'Apply loaded reports'}).count(), 0);
  assert.equal(await page.getByLabel('Search findings').inputValue(), 'synthetic', 'filters survive the refresh');
}));

// Module hosts are preserved across unrelated renders so a live editor session
// mounted by a feature module is not torn down; a different report gets a new host.
test('live report host survives re-render while the report is unchanged', {timeout: 60000}, async () => withFixture('tests/ui_showcase_fixture.py', async ({page, url}) => {
  await page.goto(`${url}#/programs/${encodeURIComponent('web_bounty/acme-cloud')}/web/reports/ac-101-stored-xss.md`);
  const host = page.locator('#live-report-host');
  await host.waitFor();
  assert.equal(await host.getAttribute('data-path'), 'ac-101-stored-xss.md');
  assert.equal(await page.locator('#report-artifacts-host').getAttribute('data-report-id'), 'ac-101-stored-xss.md');
  await host.evaluate(el => {el.dataset.sessionMarker = 'kept';});
  await page.locator('.tabs [data-section="reports"]').click();
  assert.equal(await page.locator('#live-report-host').getAttribute('data-session-marker'), 'kept');
  await page.locator('#report-select').selectOption('notes.md');
  await page.locator('#live-report-host[data-path="notes.md"]').waitFor();
  assert.equal(await page.locator('#live-report-host').getAttribute('data-session-marker'), null);
}, {LIVE_EDIT: '1'}));
