// Deferred selected-lane data must be revalidated at the moment it is applied.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

test('deferred selected lane rejects a root swap before apply', {timeout:30000}, async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'br-'));
  const repo=path.resolve(__dirname,'../..');
  const child=spawn('python3',['-u','tests/workspace_latency_browser_fixture.py',root],{cwd:repo,env:{...process.env,PYTHONPATH:repo,HELD_SOURCE:'map_entries'},stdio:['ignore','pipe','inherit']});
  let browser,release;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const page=await browser.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    let ready;const arrived=new Promise(r=>ready=r), gate=new Promise(r=>release=r);
    await page.route('**/api/lane?*',async route=>{const response=await route.fetch();ready();await gate;await route.fulfill({response});});
    await page.goto(`http://127.0.0.1:${port}`);await arrived;
    await page.getByRole('button',{name:'Open workspace'}).click();
    await page.getByLabel('Program').focus();release();
    await page.getByRole('button',{name:'Apply selected lane'}).waitFor();
    fs.renameSync(path.join(root,'source'),path.join(root,'old-source'));fs.mkdirSync(path.join(root,'source'));
    await page.getByRole('button',{name:'Apply selected lane'}).click();
    await page.getByText(/source changed.*Refresh to retry/).waitFor({timeout:5000});
    assert.equal(await page.getByText('alpha finding',{exact:true}).count(),0);
  } finally {
    if(release)release();fs.writeFileSync(path.join(root,'release'),'released');
    if(browser)await browser.close();child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));fs.rmSync(root,{recursive:true,force:true});
  }
});

test('deferred selected apply from an earlier A cannot apply after A-B-A', {timeout:30000}, async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'br-'));
  const repo=path.resolve(__dirname,'../..');
  const child=spawn('python3',['-u','tests/workspace_latency_browser_fixture.py',root],{cwd:repo,env:{...process.env,PYTHONPATH:repo,HELD_SOURCE:'map_entries'},stdio:['ignore','pipe','inherit']});
  let browser,releaseFirst,releaseSecond;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const page=await browser.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    let firstReady,secondReady,count=0;
    const firstArrived=new Promise(r=>firstReady=r), secondArrived=new Promise(r=>secondReady=r);
    const firstGate=new Promise(r=>releaseFirst=r), secondGate=new Promise(r=>releaseSecond=r);
    await page.route('**/api/lane?*',async route=>{
      if(new URL(route.request().url()).searchParams.get('program')!=='alpha')return route.continue();
      const response=await route.fetch(), n=++count;
      if(n===1){firstReady();await firstGate;}else if(n===2){secondReady();await secondGate;}
      await route.fulfill({response});
    });
    await page.goto(`http://127.0.0.1:${port}`);await firstArrived;
    await page.getByRole('button',{name:'Open workspace'}).click();await page.getByLabel('Program').focus();releaseFirst();
    const apply=page.getByRole('button',{name:'Apply selected lane'});await apply.waitFor();
    await page.getByLabel('Program').selectOption('web_bounty/zeta');
    await page.getByLabel('Program').selectOption('web_bounty/alpha');await secondArrived;
    await apply.click();
    assert.equal(await page.getByText('alpha finding',{exact:true}).count(),0);
    await apply.evaluate(e=>{e.dataset.oldApply='yes';});
    releaseSecond();
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Apply selected lane' && !b.dataset.oldApply) || document.querySelector('#app')?.textContent.includes('alpha finding'),null,{timeout:5000});
    if(await page.getByRole('button',{name:'Apply selected lane'}).isVisible())await page.getByRole('button',{name:'Apply selected lane'}).click();
    await page.getByText('alpha finding',{exact:true}).waitFor({timeout:5000});
  } finally {
    if(releaseFirst)releaseFirst();if(releaseSecond)releaseSecond();fs.writeFileSync(path.join(root,'release'),'released');
    if(browser)await browser.close();child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));fs.rmSync(root,{recursive:true,force:true});
  }
});

test('selected report body received before root swap is never rendered', {timeout:30000}, async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'br-'));
  const repo=path.resolve(__dirname,'../..');
  const child=spawn('python3',['-u','tests/workspace_latency_browser_fixture.py',root],{cwd:repo,env:{...process.env,PYTHONPATH:repo,HELD_SOURCE:'map_entries'},stdio:['ignore','pipe','inherit']});
  let browser,release;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const page=await browser.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    let ready;const arrived=new Promise(r=>ready=r), gate=new Promise(r=>release=r);
    await page.route('**/api/report?*',async route=>{const response=await route.fetch();assert.equal(response.status(),200);ready();await gate;await route.fulfill({response});});
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByRole('button',{name:'Open workspace'}).click();
    await page.getByRole('button',{name:'Reports',exact:true}).click();await arrived;
    fs.renameSync(path.join(root,'source'),path.join(root,'old-source'));fs.mkdirSync(path.join(root,'source'));release();
    await page.getByText('Report could not be loaded. Refresh the workspace to retry.').waitFor({timeout:5000});
    assert.equal(await page.locator('.CodeMirror').count(),0);
  } finally {
    if(release)release();fs.writeFileSync(path.join(root,'release'),'released');
    if(browser)await browser.close();child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));fs.rmSync(root,{recursive:true,force:true});
  }
});

test('selected report index received before root swap is never rendered', {timeout:30000}, async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'br-'));
  const repo=path.resolve(__dirname,'../..');
  const child=spawn('python3',['-u','tests/workspace_latency_browser_fixture.py',root],{cwd:repo,env:{...process.env,PYTHONPATH:repo,HELD_SOURCE:'map_entries'},stdio:['ignore','pipe','inherit']});
  let browser,release;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const page=await browser.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    let ready;const arrived=new Promise(r=>ready=r), gate=new Promise(r=>release=r);
    await page.route('**/api/lane-reports?*',async route=>{const response=await route.fetch();assert.equal(response.status(),200);ready();await gate;await route.fulfill({response});});
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByRole('button',{name:'Open workspace'}).click();
    await page.getByRole('button',{name:'Reports',exact:true}).click();await arrived;
    fs.renameSync(path.join(root,'source'),path.join(root,'old-source'));fs.mkdirSync(path.join(root,'source'));release();
    await page.getByText(/Selected reports could not be loaded or the source changed/).waitFor({timeout:5000});
    assert.equal(await page.locator('#report-select, .CodeMirror').count(),0);
  } finally {
    if(release)release();fs.writeFileSync(path.join(root,'release'),'released');
    if(browser)await browser.close();child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));fs.rmSync(root,{recursive:true,force:true});
  }
});
