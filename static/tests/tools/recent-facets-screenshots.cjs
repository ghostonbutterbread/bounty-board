// Screenshots for feat/board-recent-facets (synthetic fixture only):
//   node static/tests/tools/recent-facets-screenshots.cjs <out dir>
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');
const repo = path.resolve(__dirname, '../../..');
const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'screens'));
fs.mkdirSync(out, {recursive: true});
(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'facet-shots-'));
  const child = spawn('python3', ['-u', 'tests/recent_actions_fixture.py', base, 'readonly'], {cwd: repo, env: {...process.env, PYTHONPATH: `${repo}:${repo}/tests`}, stdio: ['ignore', 'pipe', 'inherit']});
  const port = await new Promise(r => child.stdout.once('data', d => r(Number(String(d).trim()))));
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_BIN, args: ['--no-sandbox', '--disable-dev-shm-usage']});
  const shots = [];
  async function shot(name, {width = 1440, height = 900, theme = 'light', hash, open, setup, clip, full = false} = {}) {
    const context = await browser.newContext({viewport: {width, height}});
    await context.addInitScript(t => { try { localStorage.setItem('bounty-board-theme', t); } catch {} }, theme);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/${hash}`);
    await page.locator('.recent-table tr[data-recent-row], .recent-panel .empty, #dashboard-recent-host li').first().waitFor({timeout: 15000});
    await page.waitForTimeout(600);
    await page.addStyleTag({content: '#toasts{display:none!important}'}); // transient load toast
    if (setup) await setup(page);
    if (open) { await page.locator(`[data-facet-open="${open}"]`).click(); await page.locator('.facet-popover').waitFor(); await page.waitForTimeout(300); }
    const file = path.join(out, name);
    if (clip) await page.locator(clip).screenshot({path: file}); else await page.screenshot({path: file, fullPage: full});
    shots.push(file);
    await context.close();
  }
  try {
    await shot('recent-bar-light.png', {hash: '#/recent?within=all&order=newest'});
    await shot('recent-bar-dark.png', {hash: '#/recent?within=all&order=newest', theme: 'dark'});
    await shot('recent-class-open-light.png', {hash: '#/recent?within=all&order=newest', open: 'class'});
    await shot('recent-filtered-light.png', {hash: '#/recent?within=all&sev=high&sev=medium&class=xss&class=broken_access_control&order=severity'});
    await shot('recent-1024-open-light.png', {width: 1024, hash: '#/recent?within=all&order=newest', open: 'sub'});
    await shot('recent-1280-open-dark.png', {width: 1280, hash: '#/recent?within=all&order=newest', open: 'program', theme: 'dark'});
    await shot('recent-375-open-light.png', {width: 375, height: 812, hash: '#/recent?within=all&order=newest', open: 'program'});
    await shot('recent-375-light.png', {width: 375, height: 812, hash: '#/recent?within=all&sev=high&order=newest', full: true});
    await shot('submissions-light.png', {hash: '#/submissions'});
    await shot('submissions-dark.png', {hash: '#/submissions', theme: 'dark'});
    await shot('submissions-duplicate-light.png', {hash: '#/submissions?within=all&sub=duplicate&order=newest'});
    await shot('submissions-dusk.png', {hash: '#/submissions?within=all&sub=duplicate&order=newest', theme: 'dusk'});
    await shot('dashboard-panel-light.png', {hash: '#/dashboard', clip: '#dashboard-recent-host'});
    await shot('dashboard-panel-dark.png', {hash: '#/dashboard', clip: '#dashboard-recent-host', theme: 'dark'});
    console.log(shots.join('\n'));
  } finally { await browser.close(); child.kill(); fs.rmSync(base, {recursive: true, force: true}); }
})();
