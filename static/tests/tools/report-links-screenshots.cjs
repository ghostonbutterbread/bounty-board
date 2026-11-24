// Screenshots of report links and Recent reports on synthetic data (1440x900).
// Usage: node static/tests/tools/report-links-screenshots.cjs OUT_DIR
// Starts tests/report_links_fixture.py in a fresh directory under TMPDIR,
// loopback only (other hosts are aborted). Nothing real is read.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

const repo = path.resolve(__dirname, '../../..');
const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'screens'));
fs.mkdirSync(out, {recursive: true});

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-links-shots-'));
  const child = spawn('python3', ['-u', 'tests/report_links_fixture.py', base], {cwd: repo, env: {...process.env, PYTHONPATH: repo}, stdio: ['ignore', 'pipe', 'inherit']});
  const port = await new Promise((resolve, reject) => {child.once('exit', c => reject(Error(`fixture exited ${c}`))); child.stdout.once('data', d => resolve(Number(String(d).trim())));});
  const url = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_BIN, args: ['--no-sandbox', '--disable-dev-shm-usage', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
  const shots = [];
  try {
    const context = await browser.newContext({viewport: {width: 1440, height: 900}});
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const page = await context.newPage();
    const theme = async name => {await page.evaluate(t => {document.documentElement.dataset.theme = t;}, name); await page.waitForTimeout(150);};
    const shot = async (name, locator, options = {}) => {
      await page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove()));
      const file = path.join(out, name); await (locator || page).screenshot({path: file, ...options}); shots.push(file);
    };

    await page.goto(`${url}#/recent`);
    await page.locator('.recent-table a.recent-link').first().waitFor();
    await theme('light'); await shot('recent-light.png');
    await theme('dark'); await shot('recent-dark.png');
    await page.locator('[data-recent-programs]').click();
    await page.locator('.recent-program-list label.option', {hasText: 'acme-cloud'}).locator('input').check();
    await page.waitForFunction(() => document.querySelectorAll('.recent-table tr[data-recent-row]').length === 4);
    await shot('recent-program-filter-dark.png');
    await page.keyboard.press('Escape');
    await page.locator('[data-recent-clear]').first().click();
    await theme('light');

    await page.getByRole('button', {name: 'Dashboard', exact: true}).click();
    const panel = page.getByRole('region', {name: 'Recently updated reports'});
    await panel.locator('a.recent-link').first().waitFor();
    await shot('dashboard-light.png');
    await shot('dashboard-recent-panel-light.png', panel);
    await theme('dark'); await shot('dashboard-recent-panel-dark.png', panel);

    await theme('light');
    await page.goto(`${url}#/programs/${encodeURIComponent('web_bounty/acme-cloud')}/web/reports/notes.md`);
    await page.locator('.report-links a.report-link').first().waitFor();
    await page.locator('.CodeMirror').waitFor();
    await shot('reports-link-list-light.png', null, {fullPage: true});
    await theme('dark'); await shot('reports-link-list-dark.png', null, {fullPage: true});
    await theme('light');
    await page.goto('about:blank');
    await page.goto(`${url}#/programs/${encodeURIComponent('web_bounty/acme-cloud')}/web/reports/${encodeURIComponent('gone/missing.md')}`);
    await page.locator('[data-report-missing]').waitFor();
    await shot('reports-missing-light.png');
    await page.goto(`${url}#/programs/${encodeURIComponent('web_bounty/acme-cloud')}/web/findings`);
    await page.locator('a.report-ref').first().waitFor();
    await shot('findings-report-links-light.png');
    await page.setViewportSize({width: 375, height: 800});
    await page.goto(`${url}#/recent`);
    await page.locator('.recent-table a.recent-link').first().waitFor();
    await shot('recent-phone-light.png');
  } finally {
    await browser.close();
    child.kill('SIGTERM');
    fs.rmSync(base, {recursive: true, force: true});
  }
  console.log(shots.join('\n'));
})().catch(error => {console.error(error); process.exit(1);});
