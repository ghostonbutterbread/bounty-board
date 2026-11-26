const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

test('lazy scoped observations render as inert text and pending reads cannot cross programs', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bmd-'));
  const repo=path.resolve(__dirname,'../..');
  const child=spawn('python3',['-u','tests/mapstore_browser_fixture.py',root],{cwd:repo,env:{...process.env,PYTHONPATH:repo},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(new Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome'});
    const page=await browser.newPage();
    const seen=[];
    page.on('request',request=>seen.push(request.url()));
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByRole('button',{name:'Open workspace'}).click();
    await page.getByRole('link',{name:'Gadgets',exact:true}).click();
    assert.match(await page.locator('#app').innerText(),/archived/);
    assert.match(await page.locator('#app').innerText(),/residual/);
    assert.equal(seen.filter(u=>u.includes('/api/map-observation?')).length,0);
    await page.getByRole('button',{name:'Open observation'}).click();
    await page.getByText(/alpha Capability:/).waitFor();
    assert.equal(await page.locator('#app img').count(),0);
    assert.equal(await page.locator('#app a:not([data-section]):not([data-scope-badge])').count(),0); // section tabs and the scope badge are links; observation text must add none
    assert.equal(seen.filter(u=>u.includes('evil.invalid')).length,0);
    await page.getByRole('link',{name:'MapStore',exact:true}).click();
    assert.match(await page.locator('#app').innerText(),/not recorded/i);
    const missing=page.locator('.record').filter({hasText:'alpha missing'});
    await missing.getByRole('button',{name:'Open observation'}).click();
    await missing.getByText(/unavailable/i).waitFor();
    let release, started;
    const entered=new Promise(resolve=>started=resolve);
    const gate=new Promise(resolve=>release=resolve);
    await page.route('**/api/map-observation?**',async route=>{started();await gate;await route.continue();});
    const gadget=page.locator('.record').filter({hasText:'alpha gadget'});
    await gadget.getByRole('button',{name:'Open observation'}).click();
    await entered;
    await page.locator('#program-select').selectOption('web_bounty/beta');
    release();
    await page.waitForResponse(r=>r.url().includes('/api/map-observation?') && r.status()===200);
    assert.doesNotMatch(await page.locator('#app').innerText(),/alpha Capability/);
    assert.match(await page.locator('#app').innerText(),/beta gadget/);
  } finally {
    if(browser)await browser.close();
    child.kill('SIGTERM'); await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null ? resolve() : child.once('exit',resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('nonfinite map input leaves the healthy program usable in a real browser', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bmn-'));
  const repo=path.resolve(__dirname,'../..');
  const child=spawn('python3',['-u','tests/mapstore_browser_fixture.py',root,'nonfinite'],{cwd:repo,env:{...process.env,PYTHONPATH:repo},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(new Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome'});
    const page=await browser.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByRole('button',{name:'Open workspace'}).click();
    await page.getByRole('link',{name:'MapStore',exact:true}).click();
    const availability=page.getByRole('region',{name:'Data availability'});
    await availability.locator('summary').click();
    assert.match(await availability.innerText(),/Map inaccessible or invalid/);
    await page.locator('#program-select').selectOption('web_bounty/beta');
    assert.match(await page.locator('#app').innerText(),/beta gadget/);
    await page.getByRole('link',{name:'Gadgets',exact:true}).click();
    await page.getByRole('button',{name:'Open observation'}).click();
    await page.getByText(/beta Capability:/).waitFor();
    assert.equal(await page.locator('#app img').count(),0);
    assert.equal(await page.locator('#app a:not([data-section]):not([data-scope-badge])').count(),0); // section tabs and the scope badge are links; observation text must add none
  } finally {
    if(browser)await browser.close();
    child.kill('SIGTERM'); await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null ? resolve() : child.once('exit',resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
