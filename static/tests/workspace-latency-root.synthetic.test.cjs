// Deferred selected-lane data must be revalidated at the moment it is applied.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

test('report index warning survives later lane apply and clears after refresh', {timeout:30000}, async()=>{
  assert.notEqual(process.getuid(),0,'permission regression requires nonroot');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'br-'));
  const repo=path.resolve(__dirname,'../..');
  const child=spawn('python3',['-u','tests/workspace_latency_browser_fixture.py',root],{cwd:repo,env:{...process.env,PYTHONPATH:repo,HELD_SOURCE:'map_entries'},stdio:['ignore','pipe','inherit']});
  let browser,release;
  const hidden=path.join(root,'source/web_bounty/alpha/web/reports/hidden');
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    fs.unlinkSync(path.join(root,'source/web_bounty/alpha/web/reports/report.md'));
    fs.mkdirSync(hidden);fs.writeFileSync(path.join(hidden,'fixed.md'),'# valid report');fs.chmodSync(hidden,0);
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const page=await browser.newPage();page.setDefaultTimeout(5000);
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    let ready;const arrived=new Promise(r=>ready=r), gate=new Promise(r=>release=r);
    await page.route('**/api/lane?*',async route=>{const response=await route.fetch();ready();await gate;await route.fulfill({response});});
    await page.goto(`http://127.0.0.1:${port}`);await arrived;
    await page.getByRole('button',{name:'Open workspace'}).click();
    await page.getByRole('link',{name:'Reports',exact:true}).click();
    await page.getByText('No reports loaded.').waitFor();
    const summary=page.getByRole('region',{name:'Data availability'});
    assert.match(await summary.innerText(),/Inaccessible or invalid: 1 lane/);
    assert.equal(await page.locator('.summary-line > div').filter({hasText:'Reports'}).locator('strong').innerText(),'Unknown');
    await page.getByLabel('Program').focus();release();
    const apply=page.getByRole('button',{name:'Apply selected lane'});await apply.waitFor();await apply.click();
    await page.waitForFunction(()=>document.querySelector('.summary-line')?.textContent.includes('Assessment questions') && document.querySelector('.summary-line strong')?.textContent==='1');
    assert.match(await summary.innerText(),/Inaccessible or invalid: 1 lane/);
    assert.equal(await page.locator('.summary-line > div').filter({hasText:'Reports'}).locator('strong').innerText(),'Unknown');
    assert.equal(await page.getByText('No reports in this lane.').count(),0);
    await page.getByLabel('Program').selectOption('web_bounty/zeta');
    await page.locator('#report-select').waitFor();
    assert.doesNotMatch(await summary.innerText(),/Inaccessible or invalid/);
    await page.getByLabel('Program').selectOption('web_bounty/alpha');
    await page.getByText('No reports loaded.').waitFor();
    assert.match(await summary.innerText(),/Inaccessible or invalid: 1 lane/);
    assert.equal(await page.locator('.summary-line > div').filter({hasText:'Reports'}).locator('strong').innerText(),'Unknown');
    fs.chmodSync(hidden,0o700);
    await page.getByRole('button',{name:'Refresh'}).click();
    await page.locator('#report-select').waitFor();
    assert.match(await page.locator('#report-select').innerText(),/hidden\/fixed\.md/);
    assert.doesNotMatch(await summary.innerText(),/Inaccessible or invalid/);
    assert.equal(await page.locator('.summary-line > div').filter({hasText:'Reports'}).locator('strong').innerText(),'1');
  } finally {
    if(release)release();fs.writeFileSync(path.join(root,'release'),'released');
    if(browser)await browser.close();child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));
    try{fs.chmodSync(hidden,0o700);}catch{}fs.rmSync(root,{recursive:true,force:true});
  }
});

test('lane-first warnings retain their owners until complete snapshot replaces them', {timeout:30000}, async()=>{
  assert.notEqual(process.getuid(),0,'permission regression requires nonroot');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'br-'));
  const repo=path.resolve(__dirname,'../..');
  const child=spawn('python3',['-u','tests/workspace_latency_browser_fixture.py',root],{cwd:repo,env:{...process.env,PYTHONPATH:repo,HELD_SOURCE:'map_entries'},stdio:['ignore','pipe','inherit']});
  let browser,releaseFull;
  const lane=path.join(root,'source/web_bounty/alpha/web'), hidden=path.join(lane,'reports/hidden');
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    fs.unlinkSync(path.join(lane,'reports/report.md'));fs.mkdirSync(hidden);fs.writeFileSync(path.join(hidden,'fixed.md'),'# valid');fs.chmodSync(hidden,0);
    fs.writeFileSync(path.join(lane,'ledgers/ledger.json'),'{bad');
    fs.writeFileSync(path.join(lane,'recon/maps/map.jsonl'),'{bad\n');
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const page=await browser.newPage();page.setDefaultTimeout(5000);
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    const fullGate=new Promise(resolve=>releaseFull=resolve);
    await page.route('**/api/data?phase=complete*',async route=>{await fullGate;await route.continue();});
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByRole('button',{name:'Open workspace'}).click();
    await page.waitForFunction(()=>document.querySelector('.summary-line strong')?.textContent==='1' || [...document.querySelectorAll('button')].some(b=>b.textContent==='Apply selected lane'));
    const selectedApply=page.getByRole('button',{name:'Apply selected lane'});if(await selectedApply.isVisible())await selectedApply.click();
    await page.waitForFunction(()=>document.querySelector('.summary-line strong')?.textContent==='1');
    const summary=page.getByRole('region',{name:'Data availability'});
    await summary.locator('summary').click();
    assert.match(await summary.innerText(),/Ledger inaccessible or invalid:\s*1 lane/);
    assert.match(await summary.innerText(),/Map inaccessible or invalid:\s*1 lane/);
    // The index rereads a now-fixed ledger, but does not replace displayed findings.
    fs.writeFileSync(path.join(lane,'ledgers/ledger.json'),JSON.stringify({findings:[]}));
    await page.getByRole('link',{name:'Reports',exact:true}).click();
    await page.getByText('No reports loaded.').waitFor();
    await summary.locator('summary').click();
    const text=await summary.innerText();
    assert.match(text,/Ledger inaccessible or invalid:\s*1 lane/);
    assert.match(text,/Map inaccessible or invalid:\s*1 lane/);
    assert.match(text,/Reports inaccessible or invalid:\s*1 lane/);
    assert.match(text,/1 lane has/);
    assert.equal(await page.locator('.summary-line > div').filter({hasText:'Reports'}).locator('strong').innerText(),'Unknown');
    fs.chmodSync(hidden,0o700);fs.writeFileSync(path.join(root,'release'),'released');releaseFull();
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Apply loaded reports') || [...document.querySelectorAll('button')].some(b=>b.textContent==='Load entire portfolio' && b.parentElement.hidden));
    const apply=page.getByRole('button',{name:'Apply loaded reports'});if(await apply.isVisible())await apply.click();
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Load entire portfolio' && b.parentElement.hidden));
    await summary.locator('summary').click();
    const full=await summary.innerText();
    assert.match(full,/Map inaccessible or invalid:\s*1 lane/);
    assert.doesNotMatch(full,/Ledger inaccessible or invalid|Reports inaccessible or invalid/);
    assert.equal(await page.locator('.summary-line > div').filter({hasText:'Reports'}).locator('strong').innerText(),'1');
  } finally {
    if(releaseFull)releaseFull();fs.writeFileSync(path.join(root,'release'),'released');
    if(browser)await browser.close();child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));
    try{fs.chmodSync(hidden,0o700);}catch{}fs.rmSync(root,{recursive:true,force:true});
  }
});

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
    await page.getByRole('link',{name:'Reports',exact:true}).click();await arrived;
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
    await page.getByRole('link',{name:'Reports',exact:true}).click();await arrived;
    fs.renameSync(path.join(root,'source'),path.join(root,'old-source'));fs.mkdirSync(path.join(root,'source'));release();
    await page.getByText(/Selected reports could not be loaded or the source changed/).waitFor({timeout:5000});
    assert.equal(await page.locator('#report-select, .CodeMirror').count(),0);
  } finally {
    if(release)release();fs.writeFileSync(path.join(root,'release'),'released');
    if(browser)await browser.close();child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));fs.rmSync(root,{recursive:true,force:true});
  }
});
