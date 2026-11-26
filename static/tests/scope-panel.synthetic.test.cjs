'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

// Synthetic backend (tests/scope_panel_browser_fixture.py) and browser.
// SHOT_DIR (optional) receives light, dark and phone screenshots of synthetic data.
test('scope panel: section route, stale banner, rules, policy, assets, releases, change log, empty states', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-'));
  const root = path.join(base, 'root');
  fs.mkdirSync(root);
  const repo = path.resolve(__dirname, '../..');
  const child = spawn('python3', ['-u', 'tests/scope_panel_browser_fixture.py', root], {cwd: repo, env: {...process.env, PYTHONPATH: repo}, stdio: ['ignore', 'pipe', 'inherit']});
  let browser;
  try {
    const port = await new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', code => reject(new Error(`fixture exited ${code}`))); child.stdout.once('data', d => resolve(Number(String(d).trim())));});
    const origin = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const context = await browser.newContext({viewport: {width: 1360, height: 1000}});
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin});
    const page = await context.newPage();
    const errors = [], outside = [], scopeRequests = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('request', r => { if (r.url().includes('/api/scope')) scopeRequests.push(r.url()); });
    await page.route('**/*', route => { const u = new URL(route.request().url()); if (u.hostname === '127.0.0.1') return route.continue(); outside.push(u.hostname); return route.abort(); });
    const shots = process.env.SHOT_DIR;
    if (shots) fs.mkdirSync(shots, {recursive: true});
    const shot = async name => { if (!shots) return; await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('#toasts')?.replaceChildren(); }); await page.screenshot({path: path.join(shots, name), fullPage: true}); };
    const host = page.locator('#scope-panel-host');
    const loaded = () => host.locator('[data-sp-state]').waitFor({timeout: 20000});

    // Program view: the Scope tab is a real link, and the title badge links to it.
    await page.goto(origin + '/#/programs/web_bounty%2Facme-demo/web/findings');
    const tab = page.locator('a[data-section="scope"]');
    await tab.waitFor({timeout: 20000});
    assert.equal(await tab.getAttribute('href'), '#/programs/web_bounty%2Facme-demo/web/scope');
    const badge = page.locator('[data-scope-badge]');
    await badge.waitFor({timeout: 20000});
    assert.equal((await badge.innerText()).trim(), 'Scope 34 d old');
    assert.match(await badge.getAttribute('class'), /warning/);
    assert.equal(await badge.getAttribute('href'), '#/programs/web_bounty%2Facme-demo/web/scope');
    await tab.click();
    await page.waitForFunction(() => location.hash === '#/programs/web_bounty%2Facme-demo/web/scope');
    await loaded();
    assert.match(await page.locator('#breadcrumb-trail').innerText(), /Scope/);

    // Freshness, failed attempt and the stale banner with its copy button.
    assert.match(await host.locator('[data-sp-fresh]').innerText(), /Scope last pulled 34 days ago/);
    assert.match(await host.locator('[data-sp-attempt]').innerText(), /Last pull attempt failed.*HTTP 429 from platform/);
    const banner = host.locator('[data-sp-stale]');
    assert.match(await banner.innerText(), /Scope last pulled 34 days ago\. Programs change their scope often/);
    assert.doesNotMatch(await host.innerText(), /\u2014/); // no em-dashes in copy
    await banner.locator('button[data-sp-copy]').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "bbh agents/scope_puller.py 'acme-demo' --if-older-than 7");

    // Rules: 12 chips then "+2 more", expanding in place; the state is in the URL and survives reload.
    const inChips = host.locator('[data-sp-chips="in"] code.sp-chip');
    assert.equal(await inChips.count(), 12);
    assert.equal(await host.locator('[data-sp-chips="out"] code.sp-out').count(), 4);
    await host.locator('[data-sp-more="in"]').click();
    assert.equal(await inChips.count(), 14);
    await page.waitForFunction(() => location.hash === '#/programs/web_bounty%2Facme-demo/web/scope?rules=all');
    await page.reload();
    await loaded();
    assert.equal(await host.locator('[data-sp-chips="in"] code.sp-chip').count(), 14);
    assert.equal(await page.locator('a[data-section="scope"].active').count(), 1);
    await host.locator('[data-sp-less]').first().click();
    assert.equal(await host.locator('[data-sp-chips="in"] code.sp-chip').count(), 12);

    // Program policy: safe Markdown, hostile HTML stays inert text, collapsed with expand.
    const policy = host.locator('[data-sp-policy]');
    assert.equal(await policy.locator('h1').innerText(), 'Acme demo policy');
    assert.equal(await policy.locator('li').count(), 3);
    assert.equal(await policy.locator('img, script, a, iframe').count(), 0);
    assert.match(await policy.innerText(), /<img src=x onerror=/);
    assert.match(await policy.innerText(), /\\u202eevil\\u202c and ESC \\x1b\[201~/);
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    const collapsed = await policy.evaluate(el => el.clientHeight);
    assert.ok(collapsed <= 240, `collapsed height ${collapsed}`);
    await host.locator('[data-sp-policy-toggle]').click();
    await page.waitForFunction(() => location.hash.includes('policy=open'));
    assert.ok(await host.locator('[data-sp-policy]').evaluate(el => el.clientHeight) > collapsed * 2);
    assert.equal(await host.locator('[data-sp-policy-toggle]').innerText(), 'Show less');

    // Other assets with in/out pills, tiers and lane links (only to discovered lanes).
    const assets = host.locator('[data-sp-asset]');
    assert.equal(await assets.count(), 6);
    const android = host.locator('[data-sp-asset="android_app"]');
    assert.match(await android.innerText(), /In\s+Acme for Android\s+com\.acme\.example\.app · Android app\s+Tier 1/);
    assert.equal(await android.locator('a[data-sp-lane]').getAttribute('href'), '#/programs/binaries%2Facme-demo/apk/findings');
    assert.equal(await host.locator('[data-sp-asset="executable"] a[data-sp-lane]').getAttribute('href'), '#/programs/binaries%2Facme-demo/exe/findings');
    assert.equal(await host.locator('[data-sp-asset="ios_app"] a').count(), 0);
    assert.match(await host.locator('[data-sp-asset="ios_app"]').innerText(), /no lane yet/);
    assert.match(await host.locator('[data-sp-asset="source_code"]').innerText(), /^Out/);
    assert.match(await host.locator('[data-sp-asset="mystery_kind"]').innerText(), /thing-\\u202eevil/);
    await host.locator('a.sp-filter', {hasText: 'Apps'}).click();
    await page.waitForFunction(() => /kind=apps/.test(location.hash));
    assert.equal(await assets.count(), 2);
    assert.equal(await host.locator('a.sp-filter.active', {hasText: 'Apps'}).getAttribute('href'), '#/programs/web_bounty%2Facme-demo/web/scope?kind=apps&policy=open');
    await host.locator('a.sp-filter', {hasText: 'All'}).first().click();
    assert.equal(await assets.count(), 6);

    // Releases: changed, unchanged, error muted, lane stale only where the lane is older than the change.
    const rel = kind => host.locator(`[data-sp-release-row="${kind}"]`);
    assert.match(await rel('android_app').innerText(), /Release changed/);
    assert.equal(await rel('android_app').locator('[data-sp-lane-stale]').innerText(), 'Lane may be stale');
    assert.equal(await host.locator('[data-sp-lane-stale]').count(), 1);
    assert.match(await rel('ios_app').innerText(), /Version 5\.3\.0[\s\S]*No change since/);
    assert.equal(await rel('executable').locator('[data-sp-release-error]').innerText(), 'no download URL');

    // Change log: newest first, expandable diff, baseline line, unreadable line, type filter.
    const changes = host.locator('.sp-change');
    assert.equal(await changes.count(), 4);
    assert.equal(await changes.nth(0).getAttribute('data-sp-change'), 'invalid');
    assert.match(await changes.nth(3).innerText(), /Inventory started/);
    const latest = changes.nth(1);
    assert.match(await latest.innerText(), /\+2 added, -1 removed, 1 release changed/);
    assert.equal(await latest.locator('.sp-diff').isVisible(), false);
    await latest.locator('summary').click();
    assert.match(await latest.locator('.sp-diff').innerText(), /\+ iOS app Acme for iOS[\s\S]*- host legacy\.acme\.example\.test[\s\S]*\* release Acme for Android: Updated on Oct 2, 2026 to Updated on Nov 20, 2026/);
    await changes.nth(2).locator('summary').click();
    assert.match(await changes.nth(2).locator('.sp-diff').innerText(), /~ web_host:status\.acme\.example\.test: in_scope in scope to out of scope/);
    await host.locator('a.sp-filter', {hasText: 'Releases'}).click();
    assert.equal(await changes.count(), 1);
    assert.equal(await host.locator('details[data-sp-entry][open]').count(), 1); // expansion kept across repaint
    await host.locator('a.sp-filter', {hasText: 'All'}).last().click();
    // Quiet refresh while visible: a new change line appears without a reload; expansion is kept.
    const scopeDir = path.join(root, 'scopes', 'acme-demo');
    fs.appendFileSync(path.join(scopeDir, 'scope-history.jsonl'), JSON.stringify({at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), source: 'pull',
      added: [{key: 'cloud:bucket-demo', kind: 'cloud', name: 'bucket-demo', in_scope: true}]}) + '\n');
    await page.evaluate(() => window.BoardScopePanel.refresh());
    await page.waitForFunction(() => document.querySelectorAll('#scope-panel-host .sp-change').length === 5);
    assert.match(await changes.nth(0).innerText(), /\+1 added/);
    assert.equal(await host.locator('details[data-sp-entry][open]').count(), 2);
    // Collapse the policy again and check the light screenshot.
    await host.locator('[data-sp-policy-toggle]').click();
    await shot('scope-panel-light.png');
    await page.evaluate(() => localStorage.setItem('bounty-board-theme', 'dark'));
    await page.reload(); await loaded();
    await shot('scope-panel-dark.png');
    await page.evaluate(() => localStorage.setItem('bounty-board-theme', 'dusk'));
    await page.reload(); await loaded();
    await shot('scope-panel-dusk.png');
    await page.evaluate(() => localStorage.setItem('bounty-board-theme', 'light'));

    // Unknown query keys and values are dropped from the URL.
    await page.goto(origin + '/#/programs/web_bounty%2Facme-demo/web/scope?kind=bogus&rules=all&x=%3Cscript%3E');
    await page.waitForFunction(() => location.hash === '#/programs/web_bounty%2Facme-demo/web/scope?rules=all', null, {timeout: 20000});
    await loaded();
    assert.equal(await host.locator('[data-sp-chips="in"] code.sp-chip').count(), 14);

    // Lane link opens the binaries lane in the app.
    await page.reload(); await loaded();
    await host.locator('[data-sp-asset="android_app"] a[data-sp-lane]').click();
    await page.waitForFunction(() => location.hash === '#/programs/binaries%2Facme-demo/apk/findings');
    await page.goBack();
    await page.waitForFunction(() => location.hash.startsWith('#/programs/web_bounty%2Facme-demo/web/scope'));
    await loaded();

    // No inventory yet: rules from the text files, policy, the backfill note; no asset sections.
    await page.goto(origin + '/#/programs/web_bounty%2Fglobex-demo/web/scope');
    await page.waitForFunction(() => document.querySelector('#scope-panel-host [data-sp-rules]')?.dataset.spRules === 'txt', null, {timeout: 20000});
    assert.equal(await host.locator('[data-sp-chips="in"] code').count(), 2);
    assert.match(await host.locator('[data-sp-no-inventory]').innerText(), /No scope inventory yet/);
    await host.locator('[data-sp-no-inventory] button[data-sp-copy]').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "bbh agents/scope_puller.py --rebuild-inventory 'globex-demo'");
    assert.equal(await host.locator('[data-sp-stale]').count(), 0);
    assert.match(await host.locator('[data-sp-fresh]').innerText(), /estimated from the in-scope\.txt time/);
    assert.equal(await host.locator('[data-sp-asset], [data-sp-release-row], .sp-change').count(), 0);
    assert.match(await host.locator('[data-sp-policy]').innerText(), /Be kind/);
    assert.match(await page.locator('[data-scope-badge]').innerText(), /Scope today \(est\.\)/);
    await shot('scope-panel-no-inventory.png');

    // No scope directory: open scope with the pull command.
    await page.goto(origin + '/#/programs/web_bounty%2Finitech-demo/web/scope');
    await page.waitForFunction(() => document.querySelector('#scope-panel-host [data-sp-state="none"]') && /initech/.test(location.hash), null, {timeout: 20000});
    assert.match(await host.innerText(), /No scope on file[\s\S]*open scope/);
    await host.locator('button[data-sp-copy]').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "bbh agents/scope_puller.py 'initech-demo' --if-older-than 7");
    assert.equal((await page.locator('[data-scope-badge]').innerText()).trim(), 'No scope on file');
    await shot('scope-panel-no-scope.png');

    // Phone: no horizontal overflow.
    await page.setViewportSize({width: 390, height: 844});
    await page.goto(origin + '/#/programs/web_bounty%2Facme-demo/web/scope');
    await page.waitForFunction(() => document.querySelector('#scope-panel-host [data-sp-state="loaded"]') && /acme/.test(location.hash), null, {timeout: 20000});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'phone layout overflows');
    await shot('scope-panel-phone.png');

    assert.ok(scopeRequests.every(u => new URL(u).hostname === '127.0.0.1'));
    assert.deepEqual(errors, []);
    assert.deepEqual(outside, []);
  } finally {
    await browser?.close();
    child.kill();
    fs.rmSync(base, {recursive: true, force: true});
  }
});
