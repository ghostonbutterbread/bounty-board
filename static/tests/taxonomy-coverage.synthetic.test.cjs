'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

// Synthetic backend and browser. SHOT_DIR (optional) receives screenshots of synthetic data.
test('taxonomy labels and coverage drill-down render from real API data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'btx-'));
  const repo = path.resolve(__dirname, '../..');
  const child = spawn('python3', ['-u', 'tests/taxonomy_coverage_browser_fixture.py', root], {cwd: repo, env: {...process.env, PYTHONPATH: repo}, stdio: ['ignore', 'pipe', 'inherit']});
  let browser;
  try {
    const port = await new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', code => reject(new Error(`fixture exited ${code}`))); child.stdout.once('data', d => resolve(Number(String(d).trim())));});
    browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const page = await browser.newPage({viewport: {width: 1280, height: 1000}});
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByLabel('Dashboard program').waitFor({timeout: 5000});
    await page.waitForFunction(() => window.BoardTaxonomy?.ready());
    await page.getByLabel('Dashboard program').selectOption('web_bounty/acme-demo');
    const shots = process.env.SHOT_DIR;
    if (shots) fs.mkdirSync(shots, {recursive: true});
    // Integrated UI: categories are a toggle inside the redesigned class breakdown.
    await page.getByRole('button', {name: 'By category', exact: true}).click();
    await page.waitForSelector('[data-category-row]');
    await page.locator('[data-category-row="xss"]').click();
    assert.match(await page.locator('.drill').innerText(), /stored-xss/); // raw class shown in the expanded category
    const dash = await page.locator('#app').innerText();
    assert.match(dash, /By category/);
    assert.match(page.url(), /./);
    assert.equal(await page.locator('[data-category-row]').filter({hasText: 'Cross-Site Scripting'}).count(), 1);
    if (shots) await page.screenshot({path: path.join(shots, 'dashboard-categories.png'), fullPage: true});

    await page.getByRole('button', {name: 'Open workspace'}).click();
    // Findings: raw class and severity stay; display-time notes are additive.
    const finding = title => page.locator('tr').filter({hasText: title});
    assert.match(await finding('Stored script in profile').innerText(), /stored-xss/);
    assert.match(await finding('Stored script in profile').innerText(), /Category: Cross-Site Scripting > Stored/);
    assert.match(await finding('Stored script in profile').innerText(), /Shown as HIGH/);
    assert.match(await finding('Template draft').innerText(), /LOW\|MEDIUM\|HIGH\|CRITICAL/);
    assert.match(await finding('Template draft').innerText(), /Template placeholder/);
    assert.match(await finding('Template draft').innerText(), /Category: Unclassified/);
    assert.match(await finding('Range rating').innerText(), /Range recorded/);
    assert.doesNotMatch(await finding('Order id swap').innerText(), /Shown as/);
    await page.getByRole('button', {name: 'Filter classes', exact: true}).click();
    assert.equal(await page.getByRole('checkbox', {name: 'stored-xss'}).count(), 1); // filter still uses raw values
    await page.keyboard.press('Escape');
    if (shots) await page.screenshot({path: path.join(shots, 'findings-taxonomy.png'), fullPage: true});

    await page.getByRole('link', {name: 'Coverage', exact: true}).click();
    const host = page.locator('#coverage-drilldown-host');
    await host.getByRole('heading', {name: 'Coverage drill-down'}).waitFor();
    const surfaces = await host.locator('[data-cd-surfaces]').innerText();
    assert.match(surfaces.replace(/\s+/g, ' '), /40 Mapped surfaces/);
    assert.match(await host.locator('[data-cd-reconcile]').innerText(), /Check: 31 surfaces with questions \+ 9 without = 40 mapped/);
    // Needs-attention default: blocked 3, in progress 4, stale 1 (+ aged in-progress rows already counted).
    assert.match(await host.locator('[data-cd-count]').innerText(), /^8 of 36 questions/);
    assert.equal(await host.locator('[data-cd-row][data-status="blocked"]').count(), 3);
    assert.match(await host.locator('[data-cd-blocked]').innerText(), /Edge, WAF or challenge\s+1/);
    assert.match(await host.locator('[data-cd-quality]').innerText(), /no evidence reference/);
    if (shots) await host.screenshot({path: path.join(shots, 'coverage-drilldown.png')});
    await host.locator('#cd-view').selectOption('bounded_review');
    assert.match(await host.locator('[data-cd-count]').innerText(), /^15 of 36 questions/);
    await host.locator('#cd-category').selectOption('Cross-Site Scripting');
    assert.match(await host.locator('[data-cd-count]').innerText(), /^10 of 36 questions/);
    await host.locator('#cd-search').fill('item3');
    assert.equal(await host.locator('#cd-search').evaluate(el => document.activeElement === el), true);
    // Evidence refs matching a report in this lane open it in the Board.
    await host.locator('#cd-search').fill('');
    assert.match(await host.locator('[data-cd-report]').first().getAttribute('href'), /^#\/programs\/[^/]+\/[^/]+\/reports\/.+\.md$/, 'evidence report refs are real links');
    await host.locator('[data-cd-report]').first().click();
    await page.waitForFunction(() => document.querySelector('#report-select'));
    assert.match(await page.locator('#report-select').innerText(), /idor-notes\.md/);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    if (browser) await browser.close();
    child.kill('SIGTERM'); await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
    fs.rmSync(root, {recursive: true, force: true});
  }
});
