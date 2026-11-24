// Screenshots of the integrated workspace on synthetic data (1440x900).
// Usage: node static/tests/tools/integrated-screenshots.cjs OUT_DIR
// Starts tests/integrated_workspace_fixture.py in a fresh directory under
// TMPDIR, loopback only (other hosts are aborted). Nothing real is read.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

const repo=path.resolve(__dirname,'../../..');
const out=path.resolve(process.argv[2]||path.join(os.tmpdir(),'screens'));
fs.mkdirSync(out,{recursive:true});

(async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'bb-shots-'));
  const child=spawn('python3',['-u','tests/integrated_workspace_fixture.py',base],{cwd:repo,env:{...process.env,PYTHONPATH:`${repo}:${repo}/tests`},stdio:['ignore','pipe','inherit']});
  const port=await new Promise((resolve,reject)=>{child.once('exit',c=>reject(Error(`fixture exited ${c}`)));child.stdout.once('data',d=>resolve(Number(String(d).trim())));});
  const url=`http://127.0.0.1:${port}`;
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
  const shots=[];
  try {
    const context=await browser.newContext({viewport:{width:1440,height:900}});
    await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
    const page=await context.newPage();
    const theme=async name=>{await page.evaluate(t=>{document.documentElement.dataset.theme=t;},name);await page.waitForTimeout(120);};
    const shot=async name=>{const file=path.join(out,name);await page.screenshot({path:file});shots.push(file);};
    const report=path.join(base,'data/web_bounty/acme-cloud/web/reports/A101/REPORT.md');

    await page.goto(url);
    await page.getByRole('heading',{name:'Portfolio overview'}).waitFor();
    await page.locator('.breakdown-row[data-class-name="xss"]').click();
    await page.waitForTimeout(200);
    await theme('light');await shot('dashboard-light.png');
    await theme('dark');await shot('dashboard-dark.png');
    await theme('dusk');await shot('dashboard-dusk.png');
    await theme('light');

    await page.getByRole('button',{name:'By category',exact:true}).click();
    await page.locator('[data-category-row="xss"]').click();
    await shot('dashboard-categories-light.png');
    await page.getByRole('button',{name:'By class',exact:true}).click();

    // Search palette.
    await page.keyboard.press('Control+K');
    await page.keyboard.type('xss');
    await page.locator('.search-results[data-results-for="xss"]').waitFor();
    await page.waitForTimeout(150);
    await shot('search-palette-light.png');
    await theme('dark');await shot('search-palette-dark.png');await theme('light');
    await page.keyboard.press('Escape');

    // Findings with the row menu open.
    await page.goto(`${url}#/programs/${encodeURIComponent('web_bounty/acme-cloud')}/web/findings`);
    await page.locator('tr[data-finding-id="A101"]').waitFor();
    await page.getByRole('button',{name:'Actions for Stored XSS in project description'}).click();
    await page.getByRole('menu').waitFor();
    await shot('findings-row-menu-light.png');
    await theme('dark');await shot('findings-row-menu-dark.png');await theme('light');
    await page.keyboard.press('Escape');

    // Move to Gadgets preview (opened from the row menu; drag opens the same dialog).
    await page.getByRole('button',{name:'Actions for Open redirect on logout continuation'}).click();
    await page.getByRole('menuitem',{name:'Move to Gadgets…'}).click();
    const move=page.getByRole('dialog');
    await move.waitFor();
    await move.getByLabel('Grants').fill('Redirect to an attacker origin after logout');
    await page.waitForTimeout(150);
    await shot('move-to-gadgets-preview-light.png');
    await theme('dark');await shot('move-to-gadgets-preview-dark.png');await theme('light');
    await move.getByRole('button',{name:'Close'}).click();

    // Report view: live editor beside the artifacts panel.
    await page.goto(`${url}#/programs/${encodeURIComponent('web_bounty/acme-cloud')}/web/reports/${encodeURIComponent('A101/REPORT.md')}`);
    await page.locator('#live-report-host .CodeMirror').waitFor();
    await page.locator('[data-artifact="reports/A101/evidence/screen.png"]').waitFor();
    await page.locator('[data-artifact="reports/A101/evidence/screen.png"] [data-artifact-preview]').click();
    await page.waitForTimeout(300);
    await page.locator('.report-panel').scrollIntoViewIfNeeded();
    await page.evaluate(()=>document.querySelector('.report-panel').scrollIntoView({block:'start'}));
    await page.waitForTimeout(150);
    await shot('report-live-artifacts-light.png');
    await theme('dark');await shot('report-live-artifacts-dark.png');
    await theme('dusk');await shot('report-live-artifacts-dusk.png');await theme('light');

    // Conflict state: hold the browser's save, edit the same line outside, release.
    let release;const held=new Promise(r=>{release=r;});
    await page.route(/\/api\/live\/save\?/,async route=>{await held;await route.continue();});
    await page.evaluate(()=>{const cm=document.querySelector('#live-report-host .CodeMirror').CodeMirror;const line=cm.getValue().split('\n').indexOf('Synthetic report used by the integrated workspace test.');cm.focus();cm.setCursor({line,ch:999});});
    await page.keyboard.type(' Board wording.');
    await page.waitForTimeout(900);
    fs.writeFileSync(report,fs.readFileSync(report,'utf8').replace('Synthetic report used by the integrated workspace test.','Synthetic report used by the integrated workspace test, agent wording.'));
    await page.waitForTimeout(400);
    release();
    await page.locator('[data-live-status][data-state="conflict"]').waitFor({timeout:15000});
    await page.unroute(/\/api\/live\/save\?/);
    await page.waitForTimeout(200);
    await page.evaluate(()=>document.querySelector('.report-panel').scrollIntoView({block:'start'}));
    await shot('report-conflict-light.png');
    await theme('dark');await shot('report-conflict-dark.png');await theme('light');

    // Coverage drill-down.
    await page.goto(`${url}#/programs/${encodeURIComponent('web_bounty/acme-cloud')}/web/coverage`);
    await page.locator('#coverage-drilldown-host .cd-panel').waitFor();
    await page.evaluate(()=>document.querySelector('#coverage-drilldown-host').scrollIntoView({block:'start'}));
    await page.waitForTimeout(150);
    await shot('coverage-drilldown-light.png');
    await theme('dark');await shot('coverage-drilldown-dark.png');await theme('light');
  } finally {
    await browser.close();
    const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;
    fs.rmSync(base,{recursive:true,force:true});
  }
  console.log(shots.join('\n'));
})().catch(error=>{console.error(error);process.exit(1);});
