// Screenshots of the dashboard (Recent panel, Severity breakdown and Finding
// classes drill-downs), the Recent view and the program Reports list on
// synthetic data. Light and dark at 1440x900 and 1920x1080, light and dark at 375 px.
// Usage: node static/tests/tools/recent-actions-screenshots.cjs OUT_DIR [PREFIX]
// Starts tests/recent_actions_fixture.py in a fresh directory under TMPDIR,
// loopback only (other hosts are aborted). Nothing real is read.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

const repo = path.resolve(__dirname, '../../..');
const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'screens'));
const prefix = process.argv[3] || 'after';
fs.mkdirSync(out, {recursive: true});

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-recent-shots-'));
  const child = spawn('python3', ['-u', 'tests/recent_actions_fixture.py', base, 'writer'], {cwd: repo, env: {...process.env, PYTHONPATH: `${repo}:${repo}/tests`}, stdio: ['ignore', 'pipe', 'inherit']});
  const port = await new Promise((resolve, reject) => {child.once('exit', c => reject(Error(`fixture exited ${c}`))); child.stdout.once('data', d => resolve(Number(String(d).trim())));});
  const url = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_BIN, args: ['--no-sandbox', '--disable-dev-shm-usage', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
  const shots = [];
  try {
    for (const [label, viewport] of [['desktop', {width: 1440, height: 900}], ['wide', {width: 1920, height: 1080}], ['phone', {width: 375, height: 812}]]) {
      for (const theme of ['light', 'dark']) {
        if (label === 'wide' && theme === 'dark') continue;
        const context = await browser.newContext({viewport});
        await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
        await context.addInitScript(t => {try {localStorage.setItem('bounty-board-theme', t);} catch {}}, theme);
        const page = await context.newPage();
        const shot = async (name, locator, options = {}) => {
          await page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove()));
          const file = path.join(out, `${prefix}-${name}-${label}-${theme}.png`); await (locator || page).screenshot({path: file, ...options}); shots.push(file);
        };
        await page.goto(url);
        await page.locator('.breakdown-row').first().waitFor();
        await page.locator('#dashboard-recent-host .recent-link').first().waitFor();
        // Mark one report N/A when the feature exists, to show the dimmed row.
        const na = page.locator('#dashboard-recent-host [data-na-toggle]').nth(2);
        if (await na.count() && theme === 'light' && label === 'desktop') {await na.click(); await page.waitForTimeout(400);}
        await shot('dashboard-recent', page.locator('#dashboard-recent-host'));
        await page.locator('[data-breakdown="class:xss"]').click();
        await page.locator('.drill li[data-finding-id]').first().waitFor();
        await shot('dashboard-classes', page.locator('section[aria-label="Finding classes"]'));
        await page.locator('[data-breakdown^="sev:"]').first().click();
        await page.locator('.drill li[data-finding-id]').first().waitFor();
        await shot('dashboard-severity', page.locator('section[aria-label="Severity breakdown"]'));
        await shot('dashboard-full', null, {fullPage: true});
        await page.goto(`${url}#/recent?within=all&order=newest`);
        await page.locator('.recent-table a.recent-link').first().waitFor();
        await page.waitForTimeout(300);
        await shot('recent-view', null, {fullPage: label === 'phone'});
        await context.close();
      }
    }
  } finally {
    await browser.close();
    child.kill('SIGTERM');
    fs.rmSync(base, {recursive: true, force: true});
  }
  console.log(shots.join('\n'));
})().catch(error => {console.error(error); process.exit(1);});
