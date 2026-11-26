'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

// Synthetic backend (tests/recon_intel_browser_fixture.py) and browser.
// SHOT_DIR (optional) receives light, dark and phone screenshots of synthetic data.
test('recon intel view: sidebar link, overview sorting, program sections, hunt next, hash filters, dashboard card', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bri-'));
  const root = path.join(base, 'root');
  fs.mkdirSync(root);
  const repo = path.resolve(__dirname, '../..');
  const child = spawn('python3', ['-u', 'tests/recon_intel_browser_fixture.py', root], {cwd: repo, env: {...process.env, PYTHONPATH: repo}, stdio: ['ignore', 'pipe', 'inherit']});
  let browser;
  try {
    const port = await new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', code => reject(new Error(`fixture exited ${code}`))); child.stdout.once('data', d => resolve(Number(String(d).trim())));});
    const origin = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const context = await browser.newContext({viewport: {width: 1360, height: 1000}});
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin});
    const page = await context.newPage();
    const errors = [];
    const outside = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/*', route => { const u = new URL(route.request().url()); if (u.hostname === '127.0.0.1') return route.continue(); outside.push(u.hostname); return route.abort(); });
    const shots = process.env.SHOT_DIR;
    if (shots) fs.mkdirSync(shots, {recursive: true});
    const shot = async (name, locator) => { if (shots && !locator) await page.evaluate(() => window.scrollTo(0, 0)); if (shots) await (locator || page).screenshot({path: path.join(shots, name), ...(locator ? {} : {fullPage: true})}); };

    // Dashboard card, inserted after the recent reports panel.
    await page.goto(origin + '/#/dashboard');
    const cardHost = page.locator('#dashboard-recon-host');
    await cardHost.locator('[data-ri-card-row]').first().waitFor({timeout: 20000});
    assert.match(await cardHost.innerText(), /Recon depth/);
    assert.match(await cardHost.innerText(), /URLs in 2 indexes/);
    assert.equal(await cardHost.locator('a', {hasText: 'Open recon intel'}).getAttribute('href'), '#/recon');
    // Highest in-scope surface per test run first. Before any program view the overview
    // scales globex (173 URLs, 3 of 4 hosts in scope, no tests) by its in-scope host share.
    await page.waitForFunction(() => /in-scope URLs/.test(document.querySelector('#dashboard-recon-host [data-ri-card-row]')?.innerText || ''), null, {timeout: 20000});
    assert.match(await cardHost.locator('[data-ri-card-row]').first().innerText(), /globex-demo\s+web\s*≈130 in-scope URLs/);
    assert.match(await cardHost.innerText(), /Most in-scope surface per test run/i);
    await shot('recon-dashboard-card.png', cardHost);

    // Sidebar link is a real link with a hash route.
    const link = page.locator('.sidebar a[data-view="recon"]');
    assert.equal(await link.getAttribute('href'), '#/recon');
    await link.click();
    await page.waitForFunction(() => location.hash === '#/recon');
    assert.equal(await page.locator('#breadcrumb').innerText(), 'Recon intel');
    const rows = page.locator('.ri-overview tbody tr[data-ri-program]');
    await page.waitForFunction(() => document.querySelectorAll('.ri-overview tbody tr[data-ri-program]').length === 3 && !document.querySelector('[data-ri-status] .ri-computing'), null, {timeout: 20000});
    // In-scope host column: globex 3 of 4 (shop excluded), acme has no scope on file.
    assert.match(await page.locator('tr[data-ri-program="web_bounty/globex-demo"] [data-ri-scope-cell]').innerText(), /^3\s*\/\s*4$/);
    assert.equal(await page.locator('tr[data-ri-program="web_bounty/acme-demo"] [data-ri-scope-cell]').innerText(), 'open');
    const order = async () => (await rows.evaluateAll(trs => trs.map(tr => tr.dataset.riProgram.split('/')[1])));
    assert.deepEqual(await order(), ['globex-demo', 'acme-demo', 'initech-demo']); // URLs desc, unknown last
    await page.locator('[data-ri-sort="js_files"]').click();
    assert.deepEqual((await order())[0], 'acme-demo');
    assert.match(page.url(), /#\/recon\?sort=js_files&dir=desc$/);
    await page.locator('[data-ri-sort="js_files"]').click();
    assert.match(page.url(), /dir=asc/);
    assert.equal(await page.locator('th[aria-sort="ascending"]').count(), 1);
    assert.deepEqual((await order()).at(-1), 'initech-demo'); // unknown stays last when ascending
    await page.locator('[data-ri-sort="urls"]').click();
    await page.locator('#ri-filter').fill('glob');
    await page.waitForFunction(() => document.querySelectorAll('.ri-overview tbody tr[data-ri-program]').length === 1);
    await page.waitForFunction(() => location.hash.includes('q=glob'));
    assert.match(await page.locator('[data-ri-status]').innerText(), /artifact root is not readable/);
    await page.locator('#ri-filter').fill('');
    await page.waitForFunction(() => document.querySelectorAll('.ri-overview tbody tr[data-ri-program]').length === 3);
    await shot('recon-overview-light.png');

    // Program view through the overview link.
    await page.locator('.ri-overview a', {hasText: 'acme-demo'}).click();
    await page.waitForFunction(() => location.hash.startsWith('#/recon?p=web_bounty%2Facme-demo&lane=web'));
    const hostRow = page.locator('tr[data-ri-host="static.example.test"]');
    await hostRow.waitFor({timeout: 20000});
    await page.waitForFunction(() => !document.querySelector('[data-ri-status] .ri-computing'), null, {timeout: 20000});
    // No scope on file: open scope. Rows are shown, copy stays enabled, a muted badge says so.
    assert.equal(await page.locator('[data-ri-scope-badge]').innerText(), 'No scope on file');
    assert.equal(await page.locator('[data-ri-scope-badge="no_scope"].outline').count(), 1);
    assert.equal(await page.locator('[data-ri-oos-hidden]').count(), 0);
    assert.equal(await page.locator('[data-ri-scope]').count(), 0);
    assert.equal(await page.locator('#ri-hosts button[data-ri-copy-blocked]').count(), 0);
    for (const name of ['Depth summary', 'Hosts', 'What has been looked for', 'What to hunt next', 'JavaScript'])
      assert.equal(await page.getByRole('heading', {name, exact: true}).count(), 1, name);
    const depth = (await page.locator('[data-ri-depth]').innerText()).replace(/\s+/g, ' ');
    assert.match(depth, /98 URLs/);
    assert.match(depth, /15 Unique routes/);
    assert.match(depth, /4 Tested URLs/);
    assert.match(depth, /15 JS files/);
    assert.match(depth, /2 Findings 1 archived not counted/);
    // Under-tested highlight: lots of JS, no tests.
    assert.equal(await hostRow.getAttribute('class'), 'ri-under');
    assert.match(await hostRow.innerText(), /Under-tested/);
    assert.equal(await page.locator('tr[data-ri-host="app.example.test"]').getAttribute('class'), '');
    await page.locator('#ri-under').check();
    await page.waitForFunction(() => location.hash.includes('under=1'));
    assert.equal(await page.locator('tr[data-ri-host]').count(), 1);
    await page.locator('#ri-under').uncheck();
    await page.locator('[data-ri-hsort="js_files"]').click();
    assert.equal(await page.locator('tr[data-ri-host]').first().getAttribute('data-ri-host'), 'static.example.test');
    // What has been looked for: matrix and recent runs; evidence inside the lane links to the report.
    assert.match(await page.locator('[data-ri-matrix]').innerText(), /open-redirect/);
    const evidence = page.locator('[data-ri-recent] a.link-button', {hasText: 'reports/xss-notes.md'});
    assert.equal(await evidence.getAttribute('href'), '#/programs/web_bounty%2Facme-demo/web/reports/xss-notes.md');
    assert.equal(await page.locator('[data-ri-recent] code.ri-path', {hasText: '/elsewhere/out.txt'}).count(), 1); // outside: text only
    // Target links: http(s), new tab, no opener or referrer. Nothing was fetched from targets.
    const ext = page.locator('a.ri-ext').first();
    assert.equal(await ext.getAttribute('target'), '_blank');
    assert.equal(await ext.getAttribute('rel'), 'noopener noreferrer');
    // Hunt next.
    const params = page.locator('[data-ri-hunt="param"]');
    assert.deepEqual(await params.evaluateAll(ls => ls.map(l => l.dataset.param).sort()), ['file', 'next', 'url']);
    await page.locator('[data-ri-hint="ssrf"]').click();
    await page.waitForFunction(() => location.hash.includes('hint=ssrf'));
    assert.deepEqual(await params.evaluateAll(ls => ls.map(l => l.dataset.param)), ['url']);
    await params.first().getByRole('button', {name: 'bbh next'}).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "bbh agents/url_ingest.py next 'acme-demo' --lane 'ssrf' --param 'url' --limit 20");
    await params.first().getByRole('button', {name: 'curl'}).click();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^curl -sS -i --max-time 20 'https:\/\/app\.example\.test\/r\d\?url=v'$/);
    assert.equal(await page.locator('[data-ri-hunt="host"]').count(), 1);
    assert.equal(await page.locator('[data-ri-hunt="js"]').count(), 2);
    assert.equal(await page.locator('[data-ri-hunt="lead"]').count(), 1);
    // JS section.
    assert.match(await page.locator('[data-ri-js-hosts]').innerText(), /static\.example\.test\s+12/);
    assert.match(await page.locator('[data-ri-signals]').innerText(), /endpoints/);
    await shot('recon-program-light.png');

    // Deep link with filters survives a reload.
    await page.goto(origin + '/#/recon?p=web_bounty%2Facme-demo&lane=web&hq=static&hint=lfi');
    await page.reload();
    await page.locator('tr[data-ri-host]').first().waitFor({timeout: 20000});
    assert.equal(await page.locator('#ri-host-filter').inputValue(), 'static');
    assert.equal(await page.locator('tr[data-ri-host]').count(), 1);
    assert.deepEqual(await page.locator('[data-ri-hunt="param"]').evaluateAll(ls => ls.map(l => l.dataset.param)), ['file']);
    // Back returns to the overview.
    await page.goto(origin + '/#/recon');
    await page.locator('.ri-overview').waitFor();

    // Review 9 blocker 2: control characters are shown escaped and never offered for copying.
    await page.locator('#ri-program').selectOption('web_bounty/globex-demo|web');
    const evil = page.locator('[data-ri-hunt="param"]').filter({hasText: 'redirect_url'});
    await evil.waitFor({timeout: 20000});
    assert.match(await evil.innerText(), /\\x1b\[201~\\x15touch PWNED\\x0dredirect_url/);
    assert.equal(await evil.locator('[data-ri-copy]').count(), 0);
    assert.equal(await evil.locator('button[data-ri-copy-blocked][disabled]').count(), 3); // URL, curl, bbh next
    assert.match(await evil.innerText(), /contains control characters/);
    assert.equal(await evil.locator('a.ri-ext').count(), 0); // the escaped text is not the real URL: no link
    const evilHost = page.locator('tr[data-ri-host]').filter({hasText: 'evil\\u202e.example.test'});
    assert.equal(await evilHost.count(), 1);
    assert.equal(await evilHost.locator('button[data-ri-copy-blocked][disabled]').count(), 1);
    const hostileText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\u2028\u2029\ufeff]/;
    assert.equal(hostileText.test(await page.locator('#recon-intel-host').evaluate(el => el.innerHTML)), false);
    // Ordinary in-scope items in the same view still copy.
    assert.ok(await page.locator('#ri-hosts [data-ri-copy]').count() > 0);

    // Scope: shop.example.test is excluded, cdn.example.test is partly in scope.
    await page.waitForFunction(() => document.querySelector('[data-ri-scope-badge]')?.dataset.riScopeBadge === 'checked', null, {timeout: 20000});
    assert.match(await page.locator('[data-ri-scope-badge]').innerText(), /^Scope checked/);
    assert.match((await page.locator('[data-ri-scope-hosts]').innerText()).replace(/\s+/g, ' '), /3 of 4 In-scope hosts 1 partly in scope/);
    assert.match((await page.locator('[data-ri-scope-urls]').innerText()).replace(/\s+/g, ' '), /^33 In-scope URLs/);
    assert.equal(await page.locator('tr[data-ri-host="shop.example.test"]').count(), 0); // hidden by default
    assert.match(await page.locator('[data-ri-oos-hidden="hosts"]').innerText(), /1 out-of-scope host hidden · Show/);
    assert.match(await page.locator('[data-ri-oos-hidden="untested_params"]').innerText(), /out-of-scope parameters? hidden/);
    assert.equal(await page.locator('[data-ri-hunt="param"]').filter({hasText: /^url\b/}).count(), 0);
    const cdn = page.locator('tr[data-ri-host="cdn.example.test"]');
    assert.equal(await cdn.locator('[data-ri-scope="partial"]').innerText(), 'Partly in scope');
    assert.match(await cdn.locator('[data-ri-scope="partial"]').getAttribute('title'), /in scope except paths under \/private\/ · rule: \*\.example\.test/);
    assert.equal(await cdn.locator('[data-ri-copy]').count(), 1); // partial hosts stay copyable
    const show = page.locator('[data-ri-oos-hidden="hosts"] a');
    assert.match(await show.getAttribute('href'), /^#\/recon\?p=web_bounty%2Fglobex-demo&lane=web&oos=1$/);
    await show.click();
    await page.waitForFunction(() => location.hash.endsWith('oos=1'));
    const shop = page.locator('tr[data-ri-host="shop.example.test"]');
    assert.match(await shop.getAttribute('class'), /ri-oos/);
    assert.equal(await shop.locator('[data-ri-scope="out"]').innerText(), 'OOS');
    assert.equal(await shop.locator('[data-ri-scope="out"]').getAttribute('title'), 'excluded by shop.example.test');
    assert.equal(await shop.locator('button[data-ri-copy-blocked][disabled]').count(), 1);
    assert.match(await shop.innerText(), /out of scope/);
    assert.doesNotMatch(await shop.innerText(), /Under-tested/); // out-of-scope surface is never highlighted
    const oosParam = page.locator('[data-ri-hunt="param"].ri-oos').first();
    await oosParam.waitFor();
    assert.equal(await oosParam.locator('[data-ri-copy]').count(), 0);
    assert.equal(await oosParam.locator('button[data-ri-copy-blocked][disabled]').count(), 3); // URL, curl, bbh next
    assert.equal(await oosParam.locator('button[data-ri-copy-blocked]').first().getAttribute('title'), 'Not copied: out of scope');
    assert.match(await oosParam.locator('[data-ri-scope="out"]').getAttribute('title'), /excluded by shop\.example\.test/);
    assert.match(await page.locator('[data-ri-oos-hidden="hosts"]').innerText(), /1 out-of-scope host shown · Hide/);
    // oos=1 survives a reload; an unknown value falls back to hiding.
    await page.reload();
    await shop.waitFor({timeout: 20000});
    assert.equal(await page.locator('[data-ri-oos-hidden="hosts"] a').innerText(), 'Hide');
    await shot('scope-program-light.png');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await shot('scope-program-dark.png');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.goto(origin + '/#/recon?p=web_bounty%2Fglobex-demo&lane=web&oos=yes');
    await page.locator('tr[data-ri-host="cdn.example.test"]').waitFor({timeout: 20000});
    assert.equal(await page.locator('tr[data-ri-host="shop.example.test"]').count(), 0);

    // Empty states explain what produces the data.
    await page.locator('#ri-program').selectOption('web_bounty/initech-demo|web');
    await page.locator('[data-ri-empty="url_index"]').waitFor({timeout: 20000});
    assert.match(await page.locator('[data-ri-empty="url_index"]').innerText(), /No URL index yet: ?|No URL index yet/);
    assert.match(await page.locator('[data-ri-empty="url_index"]').innerText(), /url_ingest\.py ingest initech-demo/);
    const jsEmpty = await page.locator('[data-ri-empty="js"]').innerText();
    assert.match(jsEmpty, /not readable on this host/);
    assert.match(jsEmpty, /initech-demo\/web\/recon\/js\/_library\/js_info\.sqlite/);

    // Dark and phone screenshots (synthetic data).
    await page.goto(origin + '/#/recon?p=web_bounty%2Facme-demo&lane=web');
    await page.locator('tr[data-ri-host]').first().waitFor({timeout: 20000});
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await shot('recon-program-dark.png');
    await page.setViewportSize({width: 390, height: 844});
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `phone layout overflows by ${overflow}px`);
    await shot('recon-program-phone.png');
    await page.goto(origin + '/#/recon?p=web_bounty%2Fglobex-demo&lane=web&oos=1');
    await page.locator('tr[data-ri-host="shop.example.test"]').waitFor({timeout: 20000});
    await page.waitForTimeout(200);
    const oosOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(oosOverflow <= 1, `phone layout with out-of-scope rows overflows by ${oosOverflow}px`);
    await shot('scope-program-phone.png');
    await page.goto(origin + '/#/recon');
    await page.locator('.ri-overview').waitFor();
    await shot('recon-overview-phone.png');
    // Once a program view cached per-host counts, the dashboard ranks by exact in-scope surface:
    // globex drops to 33 in-scope URLs (shop is excluded), so acme leads.
    await page.setViewportSize({width: 1360, height: 1000});
    await page.goto(origin + '/#/dashboard');
    await page.reload();
    await cardHost.locator('[data-ri-card-row]').first().waitFor({timeout: 20000});
    await page.waitForFunction(() => /acme-demo/.test(document.querySelector('#dashboard-recon-host [data-ri-card-row]')?.innerText || ''), null, {timeout: 20000});
    assert.match(await cardHost.locator('[data-ri-card-row]').filter({hasText: 'globex-demo'}).innerText(), /33 in-scope URLs/);
    await shot('scope-dashboard-card.png', cardHost);
    assert.deepEqual(errors, []);
    assert.deepEqual(outside, []);
  } finally {
    await browser?.close();
    child.kill();
    fs.rmSync(base, {recursive: true, force: true});
  }
});
