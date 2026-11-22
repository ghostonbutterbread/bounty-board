const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

for (const source of ['map_entries','coverage']) test(`selected lane works while unrelated ${source} is held`, {timeout:30000}, async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bw-'));
  const repo=path.resolve(__dirname,'../..');
  const child=spawn('python3',['-u','tests/workspace_latency_browser_fixture.py',root],{cwd:repo,env:{...process.env,PYTHONPATH:repo,HELD_SOURCE:source},stdio:['ignore','pipe','inherit']});
  let browser, releaseAlpha, heldRequest;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(new Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const page=await browser.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    const alphaGate=new Promise(resolve=>{releaseAlpha=resolve;});
    await page.route('**/api/lane?*',async route=>{
      if(new URL(route.request().url()).searchParams.get('program')==='alpha')await alphaGate;
      await route.continue();
    });
    const summary=page.waitForResponse(r=>r.request().headers()['x-bounty-board-phase']==='summary');
    await page.goto(`http://127.0.0.1:${port}`);
    const data=await (await summary).json();
    assert.equal(data.programs[0].lanes[0].findings,null);
    const q=new URLSearchParams({root_instance:data.root_instance,family:'web_bounty',program:'zeta',lane:'web'});
    heldRequest=http.get(`http://127.0.0.1:${port}/api/lane?${q}`,res=>res.resume());
    heldRequest.on('error',()=>{});
    const deadline=Date.now()+5000;
    while(!fs.existsSync(path.join(root,'entered'))){if(Date.now()>deadline)throw Error('unrelated barrier not reached');await new Promise(r=>setTimeout(r,10));}
    releaseAlpha();
    await page.getByRole('button',{name:'Open workspace'}).click();
    await page.getByText('alpha finding',{exact:true}).waitFor({timeout:5000});
    assert.match(await page.locator('.summary-line').innerText(),/1\s*Assessment questions/);
    await page.getByRole('button',{name:'MapStore',exact:true}).click();
    await page.getByText('alpha map',{exact:true}).waitFor({timeout:5000});
    await page.getByRole('button',{name:'Gadgets',exact:true}).click();
    await page.getByText('alpha map',{exact:true}).waitFor({timeout:5000});
    assert.equal(fs.existsSync(path.join(root,'release')),false);
    const fullDeadline=Date.now()+5000;
    while(!fs.existsSync(path.join(root,'entered-2'))){if(Date.now()>fullDeadline)throw Error('portfolio barrier not reached');await new Promise(r=>setTimeout(r,10));}
    fs.writeFileSync(path.join(root,'release'),'released');
    await page.waitForFunction(()=>document.querySelector('button') && (![...document.querySelectorAll('button')].some(b=>b.textContent==='Load entire portfolio' && !b.parentElement.hidden) || [...document.querySelectorAll('button')].some(b=>b.textContent==='Apply loaded reports')),null,{timeout:10000});
    if(await page.getByRole('button',{name:'Apply loaded reports'}).isVisible())await page.getByRole('button',{name:'Apply loaded reports'}).click();
    await page.getByRole('button',{name:'Dashboard',exact:true}).click();
    await page.waitForFunction(()=>[...document.querySelectorAll('.stat')].some(e=>e.textContent.includes('Finding records') && e.querySelector('strong')?.textContent==='2'),null,{timeout:5000});
  } finally {
    if(releaseAlpha)releaseAlpha();
    fs.writeFileSync(path.join(root,'release'),'released');
    if(heldRequest)heldRequest.destroy();
    if(browser)await browser.close();
    child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null ? resolve() : child.once('exit',resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('changing programs while another selection is held keeps the newer selection', {timeout:30000}, async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bw-'));
  const repo=path.resolve(__dirname,'../..');
  const child=spawn('python3',['-u','tests/workspace_latency_browser_fixture.py',root],{cwd:repo,env:{...process.env,PYTHONPATH:repo,HELD_SOURCE:'map_entries'},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const page=await browser.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByRole('button',{name:'Open workspace'}).click();
    await page.getByText('alpha finding',{exact:true}).waitFor({timeout:5000});
    await page.getByLabel('Program').selectOption('web_bounty/zeta');
    const deadline=Date.now()+5000;
    while(!fs.existsSync(path.join(root,'entered-2'))){if(Date.now()>deadline)throw Error('zeta selection barrier not reached');await new Promise(r=>setTimeout(r,10));}
    await page.getByLabel('Program').selectOption('web_bounty/alpha');
    assert.equal(await page.getByLabel('Program').inputValue(),'web_bounty/alpha');
    const response=page.waitForResponse(r=>r.url().includes('/api/lane?') && r.url().includes('program=zeta'),{timeout:5000});
    fs.writeFileSync(path.join(root,'release'),'released');
    await response;
    assert.equal(await page.getByLabel('Program').inputValue(),'web_bounty/alpha');
    assert.equal(await page.getByText('zeta finding',{exact:true}).count(),0);
    assert.equal(await page.getByText('alpha finding',{exact:true}).count(),1);
  } finally {
    fs.writeFileSync(path.join(root,'release'),'released');
    if(browser)await browser.close();
    child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null ? resolve() : child.once('exit',resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
