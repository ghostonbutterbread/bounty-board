const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

async function fixture(run, env={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bp-'));
  const repo=path.resolve(__dirname,'../..');
  const child=spawn('python3',['-u','tests/progressive_browser_fixture.py',root],{cwd:repo,env:{...process.env,...env,PYTHONPATH:repo},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(new Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const page=await browser.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    await run({root,page,url:`http://127.0.0.1:${port}`});
  } finally {
    fs.writeFileSync(path.join(root,'release'),'release');
    if(browser)await browser.close();
    child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
}
async function held(root) {
  const deadline=Date.now()+5000;
  while(!fs.existsSync(path.join(root,'entered'))) {if(Date.now()>deadline)throw new Error('report barrier not reached');await new Promise(r=>setTimeout(r,10));}
}

test('focused filter is retained until the completed data is explicitly applied', async()=>fixture(async({root,page,url})=>{
  const summary=page.waitForResponse(r=>r.request().headers()['x-bounty-board-phase']==='summary');
  await page.goto(url);const data=await (await summary).json();
  assert.equal(data.reports_loading,true);
  assert.equal(data.programs[0].lanes[0].reports,null);
  assert.equal(data.capabilities.finding_metadata,false);
  assert.equal(data.capabilities.report_autosave,false);
  assert.equal(data.capabilities.collaboration,false);
  await held(root);
  await page.locator('#dashboard-program').selectOption('web_bounty/alpha');
  await page.locator('#dashboard-program').focus();
  fs.writeFileSync(path.join(root,'release'),'release');
  await page.getByRole('button',{name:'Apply loaded reports'}).waitFor();
  assert.equal(await page.locator('#dashboard-program').inputValue(),'web_bounty/alpha');
  assert.equal(await page.locator('#dashboard-program').evaluate(e=>e===document.activeElement),true);
  await page.getByRole('button',{name:'Apply loaded reports'}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.stat')].some(e=>e.textContent.includes('Report records') && e.querySelector('strong')?.textContent==='1'));
  assert.equal(await page.locator('#dashboard-program').inputValue(),'web_bounty/alpha');
}));

test('manual refresh supersedes an older held full response', async()=>fixture(async({root,page,url})=>{
  await page.goto(url);await held(root);
  fs.writeFileSync(path.join(root,'source/web_bounty/alpha/web/ledgers/ledger.json'),JSON.stringify({findings:[{fid:'B2',title:'Newer finding'}]}));
  await page.locator('#refresh').click();
  await page.getByRole('heading',{name:'Portfolio overview'}).waitFor();
  await page.getByRole('button',{name:'Open workspace'}).click();
  await page.getByText('Newer finding').waitFor();
  const oldResponse=page.waitForResponse(r=>r.url().includes('phase=complete'));
  fs.writeFileSync(path.join(root,'release'),'release');
  await oldResponse;
  assert.equal(await page.getByText('Newer finding').count(),1);
  assert.equal(await page.getByText('Known synthetic finding').count(),0);
},{FIRST_REPORT_ONLY:'1'}));

test('superseded full response does not disturb an active report draft', async()=>fixture(async({root,page,url})=>{
  await page.goto(url);await held(root);
  await page.locator('#refresh').click();
  await page.getByRole('button',{name:'Open workspace'}).click();
  await page.getByRole('button',{name:'Reports',exact:true}).click();
  const input=page.locator('.CodeMirror textarea');await input.waitFor();await input.focus();
  await page.keyboard.press('Control+A');await page.keyboard.insertText('Unsaved synthetic draft');
  const oldResponse=page.waitForResponse(r=>r.url().includes('phase=complete'));
  fs.writeFileSync(path.join(root,'release'),'release');
  await (await oldResponse).finished();
  await page.waitForFunction(()=>document.querySelector('.CodeMirror textarea')===document.activeElement);
  assert.equal(await page.locator('#report-source').inputValue(),'Unsaved synthetic draft');
  assert.match(await page.locator('#report-status').innerText(),/draft saved in browser/i);
},{FIRST_REPORT_ONLY:'1'}));

test('root replacement during a held full read is rejected and refresh recovers', async()=>fixture(async({root,page,url})=>{
  await page.goto(url);await held(root);
  fs.renameSync(path.join(root,'source'),path.join(root,'old-source'));
  const lane=path.join(root,'source/web_bounty/beta/web');fs.mkdirSync(path.join(lane,'ledgers'),{recursive:true});
  fs.writeFileSync(path.join(lane,'ledgers/ledger.json'),JSON.stringify({findings:[{fid:'B',title:'Replacement finding'}]}));
  fs.writeFileSync(path.join(root,'release'),'release');
  await page.getByText(/source changed.*Refresh to retry/).waitFor();
  await page.locator('#refresh').click();
  await page.getByRole('button',{name:'Open workspace'}).click();
  await page.getByText('Replacement finding').waitFor();
}));

test('deferred report result is rejected if root changes before apply', async()=>fixture(async({root,page,url})=>{
  await page.goto(url);await held(root);
  await page.locator('#dashboard-program').focus();
  fs.writeFileSync(path.join(root,'release'),'release');
  await page.getByRole('button',{name:'Apply loaded reports'}).waitFor();
  fs.renameSync(path.join(root,'source'),path.join(root,'old-source'));
  fs.mkdirSync(path.join(root,'source'));
  await page.getByRole('button',{name:'Apply loaded reports'}).click();
  await page.getByText(/source changed.*Refresh to retry/).waitFor();
  assert.equal(await page.getByRole('button',{name:'Apply loaded reports'}).count(),0);
}));

test('failed complete request retains summary and refresh retries', async()=>fixture(async({root,page,url})=>{
  let failed=false;
  await page.route('**/api/data?phase=complete**',async route=>{failed=true;await route.fulfill({status:500,contentType:'application/json',body:'{}'});});
  await page.goto(url);
  await page.getByText(/could not be loaded.*Refresh to retry/).waitFor();
  assert.equal(failed,true);
  assert.equal(await page.getByRole('heading',{name:'Portfolio overview'}).count(),1);
  fs.writeFileSync(path.join(root,'release'),'release');
  await page.locator('#refresh').click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.stat')].some(e=>e.textContent.includes('Report records') && e.querySelector('strong')?.textContent==='1'));
}));

test('a delayed summary does not begin the full read early', async()=>fixture(async({root,page,url})=>{
  let release, reached;
  const gate=new Promise(resolve=>{release=resolve;});
  const arrived=new Promise(resolve=>{reached=resolve;});
  await page.route('**/api/data',async route=>{if(route.request().headers()['x-bounty-board-phase']!=='summary')return route.continue();const response=await route.fetch();reached();await gate;await route.fulfill({response});});
  try {
    await page.goto(url);await arrived;
    assert.equal(fs.existsSync(path.join(root,'entered')),false);
    assert.match(await page.locator('#app').innerText(),/Loading workspace/);
    release();await held(root);
    await page.getByRole('heading',{name:'Portfolio overview'}).waitFor();
  } finally {release();}
}));

test('writer-enabled browser receives only a full writable snapshot', async()=>fixture(async({root,page,url})=>{
  const response=page.waitForResponse(r=>r.request().headers()['x-bounty-board-phase']==='summary');
  await page.goto(url);await held(root);
  assert.match(await page.locator('#app').innerText(),/Loading workspace/);
  fs.writeFileSync(path.join(root,'release'),'release');
  const data=await (await response).json();
  assert.equal(data.reports_loading,undefined);
  assert.equal(data.capabilities.finding_metadata,true);
  assert.equal(data.programs[0].lanes[0].reports.length,1);
  await page.getByRole('heading',{name:'Portfolio overview'}).waitFor();
},{WRITER_FIXTURE:'1'}));
