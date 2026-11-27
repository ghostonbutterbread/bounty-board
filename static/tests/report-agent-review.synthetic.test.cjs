// Regression tests for the review of 608a962..7696646 (docs/integrations/report-agent-ui.md, review
// round): U2 arrow keys and the disabled Terminal tab, U3 guard listeners on re-created tab terminals,
// and the mount race the reviewer left unverified. Fixture: tests/report_agent_browser_fixture.py.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

const repo=path.resolve(__dirname,'../..');
const REPORT='D1-sqli-login/example-com-sqli-D1.md';
async function withFixture(mode,fn){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ra-rv-'));
  const child=spawn('python3',['-u','tests/report_agent_browser_fixture.py',dir,mode],{cwd:repo,env:{...process.env,PYTHONPATH:repo},stdio:['ignore','pipe','inherit']});
  let browser;
  try{
    const info=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',c=>reject(Error(`fixture exited ${c}`)));let b='';child.stdout.on('data',d=>{b+=d;if(b.includes('\n'))resolve(JSON.parse(b.split('\n')[0]));});});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const newPage=async()=>{const c=await browser.newContext({viewport:{width:1280,height:900}});await c.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());const p=await c.newPage();p.errors=[];p.on('pageerror',e=>p.errors.push(String(e)));return p;};
    await fn({...info,base:`http://127.0.0.1:${info.port}`,newPage});
  }finally{
    if(browser)await browser.close();
    child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null||child.signalCode!==null?r():child.once('exit',r));
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
async function openReport(page,base,report,{wait=true}={}){
  await page.goto(base);
  await page.getByRole('button',{name:'Open workspace'}).click();
  await page.getByRole('link',{name:'Reports',exact:true}).click();
  await page.locator('#report-select').selectOption(report);
  if(wait)await page.locator('#live-report-host .live-editor .CodeMirror').waitFor({timeout:15000});
}
const tabText=(page,id)=>page.evaluate(id=>{const t=window.BoardReportAgent.tabTerm(id);if(!t)return '';const b=t.buffer.active;const o=[];for(let i=0;i<b.length;i++)o.push(b.getLine(i).translateToString(true));return o.join('\n');},id);
async function waitTab(page,id,re){for(let i=0;i<150;i++){if(re.test(await tabText(page,id)))return;await page.waitForTimeout(100);}throw Error(`tab ${id} never showed ${re}`);}
async function openConnect(page,pane){
  await page.waitForFunction(()=>{const b=document.querySelector('[data-agent-toggle]');return b&&!b.disabled;},null,{timeout:20000});
  await page.locator('[data-agent-toggle]').click();
  await page.locator(`[data-agent-popover] .ra-row[data-agent-pane="${pane}"]`).click({timeout:15000});
  const id=await page.evaluate(()=>window.BoardTerminal.activeTab());
  assert.match(id,/^connect-/);
  await waitTab(page,id,new RegExp(`ATTACHED ${pane}`));
  return id;
}

test('U2: outside a packet, arrow keys and Home never select the disabled Terminal tab',{timeout:180000},async()=>{
  await withFixture('',async({base,newPage})=>{
    const page=await newPage();
    await openReport(page,base,'active.md');
    const id=await openConnect(page,'w1:p1');
    assert.equal(await page.locator('[data-term-tab-select="terminal"]').isDisabled(),true);
    await page.locator(`[data-term-tab-select="${id}"]`).focus();
    for(const key of ['Home','ArrowLeft','ArrowRight','End']){
      await page.keyboard.press(key);
      assert.equal(await page.evaluate(()=>window.BoardTerminal.activeTab()),id,`${key} selected the disabled shell tab`);
    }
    assert.equal(await page.evaluate(()=>window.BoardTerminal.status),'idle','no shell attached');
    assert.deepEqual(page.errors,[]);
  });
});

test('U3: a tab terminal re-created on every reopen keeps one guard set; the scrub still works',{timeout:180000},async()=>{
  await withFixture('',async({base,newPage})=>{
    const page=await newPage();
    await openReport(page,base,REPORT);
    const id=await openConnect(page,'w1:p2');
    const count=async()=>{
      const cdp=await page.context().newCDPSession(page);
      const {result}=await cdp.send('Runtime.evaluate',{expression:`document.querySelector('[data-term-tab-screen="${id}"]')`});
      const {listeners}=await cdp.send('DOMDebugger.getEventListeners',{objectId:result.objectId});
      const doc=await cdp.send('Runtime.evaluate',{expression:'document'});
      const docListeners=(await cdp.send('DOMDebugger.getEventListeners',{objectId:doc.result.objectId})).listeners;
      await cdp.detach();
      const by={};for(const l of listeners)by[l.type]=(by[l.type]||0)+1;
      by.documentMouseup=docListeners.filter(l=>l.type==='mouseup').length;
      return by;
    };
    const before=await count();
    for(let i=0;i<3;i++){
      await page.locator('#term-drawer [data-term-close]').click();
      await page.locator('[data-term-toggle]').click();
      await page.locator(`[data-term-tab-select="${id}"]`).click();
      await waitTab(page,id,/ATTACHED w1:p2/);
    }
    const scrubbed=await page.evaluate(id=>{const a=document.querySelector(`[data-term-tab-screen="${id}"] textarea`);a.value='x\u001b[201~y';a.dispatchEvent(new CompositionEvent('compositionend',{data:'x\u001b[201~y',bubbles:true}));return a.value;},id);
    assert.equal(scrubbed,'','compositionend scrub on the re-created xterm');
    const after=await count();
    for(const type of ['paste','beforeinput','input','compositionend','mousedown','documentMouseup'])
      assert.equal(after[type],before[type],`${type} listeners after 3 close and reopen cycles: ${JSON.stringify({before,after})}`);
    assert.equal(await page.evaluate(id=>document.querySelectorAll(`[data-term-tab-screen="${id}"] .xterm`).length,id),1,'one xterm in the tab');
    assert.deepEqual(page.errors,[]);
  });
});

test('mount race: no shell attaches before the mount answer for the current report; a late answer for an earlier report is ignored',{timeout:180000},async()=>{
  await withFixture('',async({base,newPage})=>{
    const page=await newPage();
    const sockets=[];
    page.on('websocket',ws=>sockets.push(ws.url()));
    // 1. Drawer open on a packet report, then switch to a report outside a packet whose mount answer is slow.
    await openReport(page,base,REPORT);
    await page.locator('[data-term-toggle]').click();
    await page.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
    let release;const gate=new Promise(r=>{release=r;});
    await page.route(u=>u.pathname.endsWith('/api/mount')&&u.searchParams.get('path')==='active.md',async route=>{await gate;await route.continue();});
    await page.locator('#report-select').selectOption('active.md');
    await page.waitForTimeout(2500);   // the drawer is open and the mount answer has not come
    const early=sockets.filter(u=>/path=active\.md/.test(u)&&!/kind=(agent|connect)/.test(u));
    assert.deepEqual(early,[],'a shell attach was tried before the mount answer');
    assert.notEqual(await page.evaluate(()=>window.BoardTerminal.status),'connected','the previous report\'s shell is not shown as attached');
    release();
    await page.waitForFunction(()=>document.querySelector('[data-term-toggle]')?.disabled,null,{timeout:15000});
    await page.waitForTimeout(800);
    assert.deepEqual(sockets.filter(u=>/path=active\.md/.test(u)&&!/kind=(agent|connect)/.test(u)),[],'no shell attach for a report outside a packet');
    assert.equal(await page.evaluate(()=>window.BoardTerminal.open),false,'the drawer closes for a report without a terminal');
    // 2. A late OK answer for D1 arrives after the answer for active.md: ignored.
    let release2;const gate2=new Promise(r=>{release2=r;});
    await page.route(u=>u.pathname.endsWith('/api/mount')&&u.searchParams.get('path')===REPORT,async route=>{await gate2;await route.continue();});
    await page.locator('#report-select').selectOption(REPORT);
    await page.waitForTimeout(300);
    await page.locator('#report-select').selectOption('active.md');
    await page.waitForFunction(()=>window.BoardTerminal.mount()?.ok===false,null,{timeout:15000});
    release2();
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(()=>window.BoardTerminal.mount()?.ok),false,'the late D1 answer did not replace the current one');
    assert.equal(await page.locator('[data-term-toggle]').isDisabled(),true);
    assert.deepEqual(page.errors,[]);
  });
});
