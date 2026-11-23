const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

for(const mode of ['shared','autosave']) for(const source of ['map_entries','coverage'])
test(`${mode}: selected collaborative report works while unrelated ${source} is held`,{timeout:45000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bc-'));
  const repo=path.resolve(__dirname,'../..');
  const child=spawn('python3',['-u','tests/workspace_latency_browser_fixture.py',root],{
    cwd:repo,env:{...process.env,PYTHONPATH:repo,HELD_SOURCE:source,BOARD_COLLAB_MODE:mode},stdio:['ignore','pipe','inherit']});
  let browser,held,heldDone;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    const base=`http://127.0.0.1:${port}`;
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const c1=await browser.newContext(),c2=await browser.newContext();
    for(const context of [c1,c2])await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    const a=await c1.newPage(),b=await c2.newPage();
    const summary=a.waitForResponse(r=>r.request().headers()['x-bounty-board-phase']==='summary');
    await a.goto(base);
    const data=await (await summary).json();
    assert.equal(data.capabilities.source_authoritative,false);
    const q=new URLSearchParams({root_instance:data.root_instance,family:'web_bounty',program:'zeta',lane:'web'});
    heldDone=new Promise(resolve=>{held=http.get(`${base}/api/lane?${q}`,r=>{r.resume();r.on('end',resolve);});held.on('error',resolve);});
    const deadline=Date.now()+5000;
    while(!fs.existsSync(path.join(root,'entered'))){if(Date.now()>deadline)throw Error('unrelated source barrier not reached');await new Promise(r=>setTimeout(r,10));}
    async function open(page){
      if(page!==a)await page.goto(base);
      await page.getByRole('button',{name:'Open workspace'}).click();
      await page.getByRole('button',{name:'Reports',exact:true}).click();
      await page.getByText(/Shared draft ready/).waitFor({timeout:10000});
    }
    await open(a);await open(b);
    assert.equal(fs.existsSync(path.join(root,'release')),false,'selected editors must load before unrelated source is released');
    await a.locator('.CodeMirror textarea').focus();
    await a.keyboard.press('Control+End');await a.keyboard.insertText(' from first');
    await b.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror.getValue().includes(' from first'),null,{timeout:12000});
    await b.getByText('Shared history and conflicts').click();
    await b.locator('.record').first().waitFor();
    const report=path.join(root,'source/web_bounty/alpha/web/reports/report.md');
    if(mode==='autosave'){
      await a.waitForFunction(()=>document.querySelector('#report-status')?.textContent.includes('Markdown file saved and inspected'),null,{timeout:12000});
      assert.match(fs.readFileSync(report,'utf8'),/from first/);
      fs.writeFileSync(report,'# external saved change\n');
      await b.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror.getValue().includes('external saved change'),null,{timeout:12000});
    } else assert.equal(fs.readFileSync(report,'utf8'),'# synthetic\n');
    assert.equal(fs.existsSync(path.join(root,'release')),false);
    await b.locator('#report-select').selectOption('zz-nav.md');
    await b.getByText(/This report is read-only under the backend editing policy/).waitFor();
    assert.equal(await b.locator('#report-source').getAttribute('readonly'),'');
    // Full discovery was also held; release only after the selected editor,
    // two-client exchange, navigation policy and source observation succeed.
    const fullDeadline=Date.now()+5000;
    while(!fs.existsSync(path.join(root,'entered-2'))){if(Date.now()>fullDeadline)throw Error('portfolio barrier not reached');await new Promise(r=>setTimeout(r,10));}
    await a.locator('.CodeMirror textarea').focus();
    const beforeCompletion=await a.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue());
    const completion=a.waitForResponse(r=>r.url().includes('/api/data?phase=complete') && r.status()===200,{timeout:10000});
    fs.writeFileSync(path.join(root,'release'),'released');
    const full=await (await completion).json();
    assert.equal(full.capabilities.source_authoritative,true);
    assert.equal(full.programs.length,2);
    await a.getByRole('button',{name:'Apply loaded reports'}).waitFor({timeout:5000});
    assert.equal(await a.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),beforeCompletion);
    assert.equal(await a.evaluate(()=>document.activeElement.classList.contains('CodeMirror-input') || !!document.activeElement.closest('.CodeMirror')),true);
  } finally {
    fs.writeFileSync(path.join(root,'release'),'released');
    if(heldDone)await Promise.race([heldDone,new Promise(resolve=>setTimeout(resolve,2000))]);
    if(held)held.destroy();if(browser)await browser.close();
    child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('collaborative editor refuses a non-authoritative partial report body',{timeout:30000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bc-'));
  const repo=path.resolve(__dirname,'../..');
  const child=spawn('python3',['-u','tests/workspace_latency_browser_fixture.py',root],{cwd:repo,env:{...process.env,PYTHONPATH:repo,HELD_SOURCE:'map_entries',BOARD_COLLAB_MODE:'autosave'},stdio:['ignore','pipe','inherit']});
  let browser,page,release,completeStarted=false;const gate=new Promise(resolve=>release=resolve);
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    page=await browser.newPage();let posts=0;
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    await page.route('**/api/data?phase=complete*',async route=>{completeStarted=true;await gate;await route.continue();});
    await page.route('**/api/report?*',async route=>{const response=await route.fetch();const data=await response.json();data.source_authoritative=false;await route.fulfill({response,json:data});});
    await page.route('**/api/collaboration?*',async route=>{if(route.request().method()==='POST')posts++;await route.continue();});
    const summary=page.waitForResponse(r=>r.request().headers()['x-bounty-board-phase']==='summary');
    await page.goto(`http://127.0.0.1:${port}`);
    const data=await (await summary).json();
    await page.evaluate(rootIdentity=>{
      const id=window.name.slice('bounty-board-tab:'.length);
      const key=JSON.stringify([rootIdentity,'web_bounty/alpha','web','report.md']);
      localStorage.setItem(`bounty-board-report-draft-v2:${key}:${id}`,JSON.stringify({version:1,text:'retained local draft',original:'# synthetic\n',revision:null,hasDraft:true}));
    },data.root_identity);
    await page.getByRole('button',{name:'Open workspace'}).click();
    await page.getByRole('button',{name:'Reports',exact:true}).click();
    await page.getByText(/Your retained draft is read-only/).waitFor({timeout:8000});
    assert.equal(await page.locator('#report-source').inputValue(),'retained local draft');
    assert.equal(await page.locator('#report-source').getAttribute('readonly'),'');
    assert.equal(await page.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getOption('readOnly')),true);assert.equal(posts,0);
    assert.equal(fs.readFileSync(path.join(root,'source/web_bounty/alpha/web/reports/report.md'),'utf8'),'# synthetic\n');
  } finally {
    const done=completeStarted ? page.waitForResponse(r=>r.url().includes('/api/data?phase=complete'),{timeout:3000}).catch(()=>{}) : null;
    fs.writeFileSync(path.join(root,'release'),'released');release();if(done)await done;if(browser)await browser.close();
    child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));fs.rmSync(root,{recursive:true,force:true});
  }
});
