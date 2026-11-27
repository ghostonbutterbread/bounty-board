// Disposable Board process, data tree and preference file; no user's HOME.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');
const {once} = require('node:events');
const {assertPreferencesOnly} = require('./preference-write-check.cjs');
const repo = path.resolve(__dirname, '../..');
const source = `import sys,app
s=app.make_server(sys.argv[1],int(sys.argv[3]),user_config=sys.argv[2],terminal_url='/terminal/')
print(s.server_port,flush=True)
s.serve_forever()`;

async function start(root, config, port=0) {
  const child = spawn('python3', ['-u', '-c', source, root, config, String(port)], {cwd: repo, env: {...process.env, PYTHONPATH: repo}, stdio: ['ignore','pipe','inherit']});
  const number = await new Promise((resolve,reject) => {
    let text=''; child.stdout.on('data', chunk => { text += chunk; if(text.includes('\n')) resolve(Number(text.split('\n')[0])); });
    child.once('error', reject); child.once('exit', code => reject(new Error(`fixture exited ${code}`)));
  });
  return {child, port:number};
}
async function stop(child) { if(child && child.exitCode===null && child.signalCode===null) { child.kill('SIGTERM'); await once(child, 'exit'); } }
async function waitSaved(page) {
  try { await page.waitForFunction(() => !window.BoardPreferences.hasPending(),null,{timeout:10000}); }
  catch(error) {
    const state=await page.evaluate(()=>({alert:document.querySelector('#preferences-save-error')?.textContent,records:Object.keys(localStorage).filter(k=>k.startsWith('bounty-board-preferences-edit:v2:')).map(k=>JSON.parse(localStorage.getItem(k)))}));
    throw new Error(`preferences did not settle: ${JSON.stringify(state)}`,{cause:error});
  }
}

test('draft write guard rejects report endpoints and draft content in preference payloads', () => {
  const base='http://127.0.0.1:1234', draft='draft-sentinel-content';
  assert.throws(()=>assertPreferencesOnly([{method:'POST',url:base+'/api/live/save',body:'{}'}],base,[draft]));
  assert.throws(()=>assertPreferencesOnly([{method:'POST',url:base+'/api/user-preferences',body:JSON.stringify({set:{'bounty-board-theme':draft},expected:{'bounty-board-theme':0}})}],base,[draft]));
  assert.doesNotThrow(()=>assertPreferencesOnly([{method:'POST',url:base+'/api/user-preferences',body:JSON.stringify({set:{'bounty-board-theme':'dark'},expected:{'bounty-board-theme':0}})}],base,[draft]));
  const multiline='draft "quoted"\nsecond line';
  const nested=JSON.stringify([multiline]);
  assert.throws(()=>assertPreferencesOnly([{method:'POST',url:base+'/api/user-preferences',body:JSON.stringify({set:{'list.recent.programs':nested},expected:{'list.recent.programs':0}})}],base,[multiline]));
  const doubleNested=JSON.stringify({inner:JSON.stringify([multiline])});
  assert.throws(()=>assertPreferencesOnly([{method:'POST',url:base+'/api/user-preferences',body:JSON.stringify({migrate:{'list.recent.programs':doubleNested}})}],base,[multiline]));
});

async function waitResolutionReady(page) {
  await page.waitForFunction(()=>{
    const b=document.querySelector('#preferences-save-error button');
    return !!b && !!b.getClientRects().length && getComputedStyle(b).visibility==='visible' && !b.disabled && b.getAttribute('aria-disabled')!=='true';
  },null,{timeout:10000});
}

async function chooseTheme(page,name) {
  await page.getByRole('button',{name:'Theme',exact:true}).click();
  await page.getByRole('menuitemradio',{name,exact:true}).click();
}

async function withEmptyBoard(initial, run) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bup-review-'));
  const root=path.join(dir,'data'), config=path.join(dir,'private','user.conf');
  fs.mkdirSync(root,{recursive:true});
  if(initial) { fs.mkdirSync(path.dirname(config),{recursive:true}); fs.writeFileSync(config,JSON.stringify(initial)); }
  let child,browser;
  try {
    const running=await start(root,config); child=running.child;
    browser=await chromium.launch({executablePath:process.env.CHROME_BIN,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    await run({browser,base:`http://127.0.0.1:${running.port}`,config,root});
  } finally { if(browser)await browser.close(); await stop(child); fs.rmSync(dir,{recursive:true,force:true}); }
}

test('rapid same-key edits do not resurrect an unsent intermediate choice', {timeout:60000}, () => withEmptyBoard(null,async({browser,base,config})=>{
  const page=await browser.newPage(); await page.goto(base);
  let release,seen,count=0;
  const gate=new Promise(resolve=>{release=resolve;}), entered=new Promise(resolve=>{seen=resolve;});
  await page.route('**/api/user-preferences',async route=>{
    if(route.request().method()==='POST' && ++count===1){seen(); await gate;}
    await route.continue().catch(()=>{});
  });
  try {
    await chooseTheme(page,'Dark'); await entered;
    await chooseTheme(page,'Dusk'); await chooseTheme(page,'Light');
    release(); await waitSaved(page);
    assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'light');
    assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('bounty-board-preferences-edit:v2:')).map(k=>JSON.parse(localStorage.getItem(k))).filter(v=>v.key==='bounty-board-theme').map(v=>v.value)),[]);
    await page.reload();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
    assert.equal(await page.locator('#preferences-save-error').count(),0);
  } finally {release();}
}));

test('superseded unsent records survive until the newer choice is acknowledged', {timeout:60000}, () => withEmptyBoard(null,async({browser,base})=>{
  const page=await browser.newPage(); await page.goto(base);
  let release,seen,count=0;
  const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{seen=resolve;});
  await page.route('**/api/user-preferences',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    if(++count===1){seen();await gate;return route.continue().catch(()=>{});}
    return route.abort('failed');
  });
  try {
    await chooseTheme(page,'Dark'); await entered; await chooseTheme(page,'Dusk'); await chooseTheme(page,'Light'); release();
    await page.locator('#preferences-save-error').waitFor();
    const values=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('bounty-board-preferences-edit:v2:')).map(k=>JSON.parse(localStorage.getItem(k)).value).sort());
    assert.deepEqual(values,['dusk','light']);
  } finally {release();}
}));

test('new acknowledgements never delete other-owner or uncertain records', {timeout:60000}, () => withEmptyBoard(null,async({browser,base,config})=>{
  const page=await browser.newPage(); await page.goto(base);
  const foreign=JSON.stringify({owner:'other-owner',key:'bounty-board-theme',value:'dusk',base:0,stamp:1});
  await page.evaluate(value=>localStorage.setItem('bounty-board-preferences-edit:v2:foreign',value),foreign);
  await page.route('**/api/user-preferences',r=>r.request().method()==='POST'?r.abort('failed'):r.continue());
  await chooseTheme(page,'Dark'); await page.locator('#preferences-save-error').waitFor();
  await page.unroute('**/api/user-preferences'); await chooseTheme(page,'Light'); await waitSaved(page);
  assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'light');
  assert.equal(await page.evaluate(()=>localStorage.getItem('bounty-board-preferences-edit:v2:foreign')),foreign);
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('bounty-board-preferences-edit:v2:') && JSON.parse(localStorage.getItem(k)).value==='dark')),true,'uncertain earlier request retained');
  assert.equal(await page.locator('#preferences-save-error').isVisible(),true);
}));

test('scrolled preference warning stays below the sticky topbar at intermediate widths', {timeout:60000}, () => withEmptyBoard(null,async({browser,base})=>{
  const context=await browser.newContext({viewport:{width:760,height:500}}), a=await context.newPage(), b=await context.newPage();
  await a.goto(base); await b.goto(base);
  await chooseTheme(a,'Dark'); await waitSaved(a);
  await chooseTheme(b,'Dusk'); await b.getByRole('button',{name:/use my choice.*theme/i}).waitFor();
  await b.evaluate(()=>{const spacer=document.createElement('div');spacer.style.height='1800px';document.querySelector('#app').append(spacer);});
  for(const width of [650,700,760,761]){
    await b.setViewportSize({width,height:500});
    await b.evaluate(()=>window.scrollTo(0,600));
    await b.waitForFunction(()=>window.scrollY>100);
    const position=await b.locator('.preferences-error-message').evaluate(el=>({textTop:el.getBoundingClientRect().top,barBottom:document.querySelector('.topbar').getBoundingClientRect().bottom}));
    assert.ok(position.textTop>=Math.max(0,position.barBottom)-1 && position.textTop>=0,`warning text is behind the topbar at ${width}px: ${JSON.stringify(position)}`);
  }
}));

test('many preference conflicts leave workspace visible and every action reachable on a short phone', {timeout:60000}, () => withEmptyBoard(null,async({browser,base})=>{
  const context=await browser.newContext({viewport:{width:375,height:500}}), page=await context.newPage();
  await page.goto(base);
  await page.evaluate(()=>{
    const owner=sessionStorage.getItem('bounty-board-preferences-owner:v2');
    const fields=['window','order','nav','hideNa','programs','lanes','subs','sevs','classes'];
    const value=field=>field==='window'?'"7d"':field==='order'?'"newest"':(field==='nav'||field==='hideNa')?'false':'[]';
    [...['recent','submissions'].flatMap(name=>fields.map(field=>[`list.${name}.${field}`,value(field)])),['bounty-board-theme','dark']].forEach(([key,v],i)=>{
      localStorage.setItem(`bounty-board-preferences-edit:v2:seed-${i}`,JSON.stringify({owner,key,value:v,base:null,stamp:i+1}));
    });
  });
  await page.reload();
  await page.waitForFunction(()=>document.querySelectorAll('#preferences-save-error button').length===19);
  await page.evaluate(()=>{const spacer=document.createElement('div');spacer.style.height='1800px';document.querySelector('#app').append(spacer);window.scrollTo(0,600);});
  await page.waitForFunction(()=>window.scrollY>100);
  const dims=await page.locator('#preferences-save-error').evaluate(el=>({height:el.getBoundingClientRect().height,viewport:innerHeight,top:el.getBoundingClientRect().top}));
  assert.ok(dims.height<dims.viewport/2,`recovery banner consumes the viewport: ${JSON.stringify(dims)}`);
  const last=page.locator('#preferences-save-error button').last(); await last.focus();
  assert.equal(await last.evaluate(el=>document.activeElement===el),true);
  assert.ok(await page.locator('#preferences-save-error').evaluate(el=>el.scrollTop)>0,'last action is reachable by scrolling the banner');
}));

test('persistent preference conflict and Board toast are both actionable', {timeout:60000}, () => withEmptyBoard(null,async({browser,base})=>{
  for(const width of [1440,375]){
    const context=await browser.newContext({viewport:{width,height:812}}), a=await context.newPage(), b=await context.newPage();
    try {
      await a.goto(base); await b.goto(base);
      await chooseTheme(a,'Dark'); await waitSaved(a);
      await chooseTheme(b,'Dusk');
      const recover=b.getByRole('button',{name:/use my choice.*theme/i}); await recover.waitFor();
      await b.evaluate(()=>{document.querySelector('#toasts').replaceChildren();window.BoardUI.toast('Important save warning','danger',{timeout:0});});
      const toast=b.locator('.toast').filter({hasText:'Important save warning'});
      const dismiss=toast.getByRole('button',{name:'Dismiss notification'}); await dismiss.waitFor();
      const textVisible=await toast.locator('.toast-text').evaluate(el=>{const r=el.getBoundingClientRect(); const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return hit===el || el.contains(hit);});
      assert.equal(textVisible,true,`toast text is not covered at ${width}px`);
      const dismissVisible=await dismiss.evaluate(el=>{const r=el.getBoundingClientRect(); const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return hit===el || el.contains(hit);});
      assert.equal(dismissVisible,true,`toast dismiss is not covered at ${width}px`);
      await dismiss.click({timeout:3000});
      assert.equal(await toast.count(),0);
      assert.equal(await recover.isVisible(),true);
    } finally {await context.close();}
  }
}));

test('conflict action does not cover sidebar navigation', {timeout:60000}, () => withEmptyBoard(null,async({browser,base})=>{
  const context=await browser.newContext({viewport:{width:1440,height:900}}), a=await context.newPage(), b=await context.newPage();
  await a.goto(base); await b.goto(base);
  await chooseTheme(a,'Dark'); await waitSaved(a);
  await chooseTheme(b,'Dusk');
  await b.getByRole('button',{name:/use my choice.*theme/i}).waitFor();
  await b.getByRole('button',{name:'Collapse sidebar'}).click({timeout:3000});
  assert.equal(await b.locator('#shell.sidebar-collapsed').count(),1);
}));

test('a stale tab can explicitly resolve its own choice then make another choice', {timeout:60000}, () => withEmptyBoard(null,async({browser,base,config})=>{
  const context=await browser.newContext(),a=await context.newPage(),b=await context.newPage();
  await a.goto(base); await b.goto(base);
  await chooseTheme(a,'Dark'); await waitSaved(a);
  await chooseTheme(b,'Dusk'); await b.locator('#preferences-save-error').waitFor();
  assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'dark');
  await chooseTheme(b,'Light');
  assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'dark','new choice is not silently forced');
  await b.getByRole('button',{name:/use my choice.*theme/i}).click(); await waitSaved(b);
  assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'light');
  await chooseTheme(b,'Dusk'); await waitSaved(b);
  assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'dusk');
  assert.equal(await b.locator('#preferences-save-error').count(),0);
}));

test('migration disables the conflict action until it can be used', {timeout:60000}, () => withEmptyBoard(null,async({browser,base,config})=>{
  const ca=await browser.newContext(), cb=await browser.newContext();
  await cb.addInitScript(()=>{if(!sessionStorage.seeded){localStorage.setItem('bounty-board-terminal:v1',JSON.stringify({dock:'left'}));sessionStorage.seeded='1';}});
  const a=await ca.newPage(),b=await cb.newPage(); await a.goto(base);
  let releaseRead,seeRead,releaseMigration,seeMigration;
  const readGate=new Promise(r=>{releaseRead=r;}),readSeen=new Promise(r=>{seeRead=r;});
  const migrationGate=new Promise(r=>{releaseMigration=r;}),migrationSeen=new Promise(r=>{seeMigration=r;});
  let firstRead=true;
  await b.route('**/api/user-preferences',async route=>{
    const req=route.request();
    if(req.method()==='GET' && firstRead){firstRead=false;seeRead();await readGate;}
    if(req.method()==='POST' && JSON.parse(req.postData()).migrate){seeMigration();await migrationGate;}
    await route.continue().catch(()=>{});
  });
  try {
    await b.goto(base,{waitUntil:'domcontentloaded'}); await readSeen;
    await chooseTheme(a,'Dark'); await waitSaved(a);
    await chooseTheme(b,'Dusk'); const button=b.getByRole('button',{name:/use my choice.*theme/i}); await waitResolutionReady(b);
    releaseRead(); await migrationSeen;
    assert.equal(await button.isDisabled(),true,'action must not appear usable while migration is held');
    assert.match(await b.locator('#preferences-save-error').innerText(),/migration/i);
    await button.focus(); await b.keyboard.press('Enter');
    assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'dark','disabled action cannot initiate a save');
    releaseMigration(); await waitResolutionReady(b);
    await button.click(); await waitSaved(b);
    assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'dusk');
  } finally {releaseRead();releaseMigration();}
}));

test('a second race during explicit resolution leaves the conflict intact', {timeout:60000}, () => withEmptyBoard(null,async({browser,base,config})=>{
  const context=await browser.newContext(),a=await context.newPage(),b=await context.newPage();
  await a.goto(base); await b.goto(base); await chooseTheme(a,'Dark'); await waitSaved(a);
  await chooseTheme(b,'Dusk'); await b.locator('#preferences-save-error').waitFor();
  let release,seen;
  const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{seen=resolve;});
  await b.route('**/api/user-preferences',async route=>{if(route.request().method()==='POST'){seen();await gate;}await route.continue().catch(()=>{});});
  try {
    const button=b.getByRole('button',{name:/use my choice.*theme/i});
    await button.focus(); await b.evaluate(()=>window.resolutionButton=document.activeElement);
    await b.keyboard.press('Enter'); await entered;
    assert.equal(await b.evaluate(()=>document.activeElement===window.resolutionButton),true,'focus remains on resolution action while request is held');
    assert.equal(await button.isDisabled(),true);
    const c=await context.newPage(); await c.goto(base); await chooseTheme(c,'Light'); await waitSaved(c);
    release();
    await b.getByRole('button',{name:/use my choice.*theme/i}).waitFor({state:'visible'});
    await waitResolutionReady(b);
    assert.equal(await b.evaluate(()=>document.activeElement===window.resolutionButton),true,'focus remains on same action after 409');
    assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'light');
    assert.equal(await b.evaluate(()=>window.BoardPreferences.hasPending()),true);
    await b.unroute('**/api/user-preferences');
    await b.keyboard.press('Enter'); await waitSaved(b);
    assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'dusk');
  } finally {release();}
}));

test('an uncertain in-flight resolution is retained after a newer choice saves', {timeout:60000}, () => withEmptyBoard(null,async({browser,base,config})=>{
  const context=await browser.newContext(),a=await context.newPage(),b=await context.newPage();
  await a.goto(base); await b.goto(base); await chooseTheme(a,'Dark'); await waitSaved(a);
  await chooseTheme(b,'Dusk'); await b.locator('#preferences-save-error').waitFor();
  let release,seen,abortDone;
  const events=[];
  b.on('request',r=>{if(r.url().endsWith('/api/user-preferences'))events.push({phase:'request',method:r.method(),body:r.postData()});});
  b.on('response',r=>{if(r.url().endsWith('/api/user-preferences'))events.push({phase:'response',method:r.request().method(),status:r.status(),body:r.request().postData()});});
  const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{seen=resolve;}),aborted=new Promise(resolve=>{abortDone=resolve;});
  await b.route('**/api/user-preferences',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    const response=await route.fetch(); events.push({phase:'upstream',status:response.status(),body:route.request().postData()});
    seen(); await gate; await route.abort('failed').catch(()=>{}); abortDone();
  });
  try {
    await b.getByRole('button',{name:/use my choice.*theme/i}).click(); await entered;
    await chooseTheme(b,'Light'); release(); await aborted;
    await waitResolutionReady(b);
    await b.unroute('**/api/user-preferences');
    const ack=b.waitForResponse(r=>r.url().endsWith('/api/user-preferences') && r.request().method()==='POST' && JSON.parse(r.request().postData()).set?.['bounty-board-theme']==='light' && r.status()===200);
    await b.getByRole('button',{name:/use my choice.*theme/i}).click(); await ack; await waitSaved(b);
    assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'light');
    assert.equal(await b.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('bounty-board-preferences-edit:v2:') && JSON.parse(localStorage.getItem(k)).value==='dusk')),true);
    assert.equal(await b.locator('#preferences-save-error').isVisible(),true,'uncertain earlier edit is not hidden');
    assert.ok(events.some(e=>e.phase==='upstream' && e.status===200),'first resolution reached server');
    assert.ok(events.some(e=>e.phase==='response' && e.status===200 && e.body && JSON.parse(e.body).set?.['bounty-board-theme']==='light'),'new resolution acknowledged');
  } catch(error) {
    const state=await b.evaluate(()=>({alert:document.querySelector('#preferences-save-error')?.outerHTML,theme:document.documentElement.dataset.theme,pending:BoardPreferences.hasPending(),records:Object.keys(localStorage).filter(k=>k.startsWith('bounty-board-preferences-edit:v2:')).map(k=>localStorage.getItem(k))})).catch(()=>null);
    const server=fs.existsSync(config)?fs.readFileSync(config,'utf8'):'missing';
    throw new Error(`uncertain resolution failed: ${JSON.stringify({state,server,events})}`,{cause:error});
  } finally {release();}
}));

test('a retry 409 cannot make a previously uncertain write safe to retire', {timeout:60000}, () => withEmptyBoard(null,async({browser,base,config})=>{
  const page=await browser.newPage(); await page.goto(base);
  await page.route('**/api/user-preferences',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    await route.fetch(); await route.abort('failed');
  });
  await chooseTheme(page,'Dusk'); await page.locator('#preferences-save-error').waitFor();
  assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'dusk');
  await page.unroute('**/api/user-preferences');
  const conflict=page.waitForResponse(r=>r.url().endsWith('/api/user-preferences') && r.request().method()==='POST' && r.status()===409);
  await page.evaluate(()=>window.dispatchEvent(new Event('online'))); await conflict;
  await chooseTheme(page,'Light');
  await page.getByRole('button',{name:/use my choice.*theme/i}).click(); await waitSaved(page);
  assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'light');
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('bounty-board-preferences-edit:v2:') && JSON.parse(localStorage.getItem(k)).value==='dusk')),true);
  assert.equal(await page.locator('#preferences-save-error').isVisible(),true);
}));

test('unknown-base edit requires explicit resolution after config repair', {timeout:60000}, () => withEmptyBoard(null,async({browser,base,config})=>{
  fs.mkdirSync(path.dirname(config),{recursive:true}); fs.writeFileSync(config,'{broken');
  const context=await browser.newContext();
  await context.addInitScript(()=>localStorage.setItem('bounty-board-preferences-revisions:v1','{}'));
  const page=await context.newPage(); await page.goto(base); await page.locator('#preferences-save-error').waitFor();
  await chooseTheme(page,'Dark'); fs.writeFileSync(config,JSON.stringify({'bounty-board-theme':'light'}));
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  const resolve=page.getByRole('button',{name:/use my choice.*theme/i}); await resolve.waitFor();
  assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'light','no automatic unknown-base replay');
  await resolve.focus(); await page.keyboard.press('Enter'); await waitSaved(page);
  assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'dark');
  assert.equal(await page.locator('#preferences-save-error').count(),0);
}));

test('failed older same-key edit does not overwrite a newer device', {timeout:60000}, () => withEmptyBoard(null,async({browser,base,config})=>{
  const a=await browser.newPage(), b=await browser.newPage();
  await a.goto(base); await b.goto(base);
  await a.route('**/api/user-preferences',r=>r.request().method()==='POST'?r.abort('failed'):r.continue());
  await a.evaluate(()=>window.BoardPreferences.set('bounty-board-theme','dusk'));
  await a.locator('#preferences-save-error').waitFor();
  await b.evaluate(()=>window.BoardPreferences.set('bounty-board-theme','dark'));
  await waitSaved(b);
  assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'dark');
  await a.unroute('**/api/user-preferences');
  await a.evaluate(()=>window.dispatchEvent(new Event('online')));
  await a.waitForTimeout(1200);
  assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'dark', 'stale pending edit must not win');
  assert.equal(await a.locator('#preferences-save-error').isVisible(),true,'conflict remains visible');
  await a.reload();
  await a.locator('#preferences-save-error').waitFor();
  assert.equal(await a.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('bounty-board-preferences-edit:v2:') && JSON.parse(localStorage.getItem(k)).value==='dusk')),true);
  assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'dark','reload retains the unsent conflict');
}));

test('same-origin tabs retain their own failed same-key edit across reload', {timeout:60000}, () => withEmptyBoard(null,async({browser,base,config})=>{
  const context=await browser.newContext(), a=await context.newPage(), b=await context.newPage();
  await a.goto(base); await b.goto(base);
  await a.route('**/api/user-preferences',r=>r.request().method()==='POST'?r.abort('failed'):r.continue());
  await a.evaluate(()=>window.BoardPreferences.set('bounty-board-theme','dusk'));
  await a.locator('#preferences-save-error').waitFor();
  await b.evaluate(()=>window.BoardPreferences.set('bounty-board-theme','dark'));
  await waitSaved(b);
  assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'dark');
  await a.unroute('**/api/user-preferences');
  await a.evaluate(()=>window.dispatchEvent(new Event('online')));
  await a.waitForTimeout(1000);
  await a.reload();
  await a.locator('#preferences-save-error').waitFor({timeout:4000});
  assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'dark');
}));

test('a tab opened after a failed edit cannot consume another tab pending edit', {timeout:60000}, () => withEmptyBoard(null,async({browser,base,config})=>{
  const context=await browser.newContext(), a=await context.newPage();
  await a.goto(base);
  await a.route('**/api/user-preferences',r=>r.request().method()==='POST'?r.abort('failed'):r.continue());
  await a.evaluate(()=>window.BoardPreferences.set('bounty-board-theme','dusk'));
  await a.locator('#preferences-save-error').waitFor();
  const b=await context.newPage(); await b.goto(base);
  await b.evaluate(()=>window.BoardPreferences.set('bounty-board-theme','dark'));
  await waitSaved(b);
  await a.unroute('**/api/user-preferences');
  await a.evaluate(()=>window.dispatchEvent(new Event('online')));
  await a.waitForTimeout(700); await a.reload();
  await a.locator('#preferences-save-error').waitFor({timeout:4000});
  assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'dark');
  assert.equal(await a.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('bounty-board-preferences-edit:v2:') && JSON.parse(localStorage.getItem(k)).value==='dusk')),true);
}));

test('cloned reload cannot claim or erase a live tab pending edit', {timeout:60000}, () => withEmptyBoard(null,async({browser,base,config})=>{
  const context=await browser.newContext(), a=await context.newPage(), b=await context.newPage();
  await a.goto(base); await b.goto(base);
  await a.route('**/api/user-preferences',r=>r.request().method()==='POST'?r.abort('failed'):r.continue());
  await a.evaluate(()=>window.BoardPreferences.set('bounty-board-theme','dusk'));
  await a.locator('#preferences-save-error').waitFor();
  const owner=await a.evaluate(()=>sessionStorage.getItem('bounty-board-preferences-owner:v2'));
  await b.evaluate(owner=>sessionStorage.setItem('bounty-board-preferences-owner:v2',owner),owner);
  await b.reload();
  await b.waitForFunction(owner=>sessionStorage.getItem('bounty-board-preferences-owner:v2')!==owner,owner);
  await b.evaluate(()=>window.BoardPreferences.set('bounty-board-theme','dark')); await waitSaved(b);
  await a.unroute('**/api/user-preferences'); await a.evaluate(()=>window.dispatchEvent(new Event('online')));
  await a.waitForTimeout(700); await a.reload(); await a.locator('#preferences-save-error').waitFor({timeout:4000});
  assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'dark');
  assert.equal(await a.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('bounty-board-preferences-edit:v2:') && JSON.parse(localStorage.getItem(k)).value==='dusk')),true);
}));

test('without Web Locks a recovered pending edit remains visible and is not replayed', {timeout:60000}, () => withEmptyBoard(null,async({browser,base,config})=>{
  const context=await browser.newContext();
  await context.addInitScript(()=>Object.defineProperty(navigator,'locks',{value:undefined}));
  const page=await context.newPage(); await page.goto(base);
  await page.route('**/api/user-preferences',r=>r.request().method()==='POST'?r.abort('failed'):r.continue());
  await page.evaluate(()=>window.BoardPreferences.set('bounty-board-theme','dusk'));
  await page.locator('#preferences-save-error').waitFor();
  await page.unroute('**/api/user-preferences'); await page.reload();
  await page.locator('#preferences-save-error').waitFor();
  assert.equal(await page.evaluate(()=>window.BoardPreferences.get('bounty-board-theme')),'dusk');
  assert.equal(fs.existsSync(config),false);
  await page.reload(); await page.locator('#preferences-save-error').waitFor();
  assert.equal(await page.evaluate(()=>window.BoardPreferences.get('bounty-board-theme')),'dusk');
  assert.equal(fs.existsSync(config),false);
}));

test('multiple failed edits to one key remain visible and retained on reload', {timeout:60000}, () => withEmptyBoard(null,async({browser,base})=>{
  const page=await browser.newPage(); await page.goto(base);
  await page.route('**/api/user-preferences',r=>r.request().method()==='POST'?r.abort('failed'):r.continue());
  await page.evaluate(()=>window.BoardPreferences.set('bounty-board-theme','dusk'));
  await page.locator('#preferences-save-error').waitFor();
  await page.evaluate(()=>window.BoardPreferences.set('bounty-board-theme','dark'));
  await page.reload(); await page.locator('#preferences-save-error').waitFor();
  assert.equal(await page.evaluate(()=>window.BoardPreferences.get('bounty-board-theme')),'dark','latest unsent choice remains displayed');
  const values=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('bounty-board-preferences-edit:v2:')).map(k=>JSON.parse(localStorage.getItem(k)).value).sort());
  assert.deepEqual(values,['dark','dusk']);
}));

test('corrupt initial snapshot recovers without overwriting the file', {timeout:60000}, () => withEmptyBoard(null,async({browser,base,config})=>{
  fs.mkdirSync(path.dirname(config),{recursive:true}); fs.writeFileSync(config,'{broken');
  const page=await browser.newPage(); await page.goto(base);
  await page.locator('#preferences-save-error').waitFor(); assert.equal(fs.readFileSync(config,'utf8'),'{broken');
  fs.writeFileSync(config,JSON.stringify({'bounty-board-theme':'dark'}));
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  await page.waitForFunction(()=>!document.querySelector('#preferences-save-error'));
}));

test('failed bootstrap retries the read and hydrates before clearing alert', {timeout:60000}, () => withEmptyBoard({'bounty-board-theme':'light'},async({browser,base,config})=>{
  const page=await browser.newPage();
  await page.route('**/api/user-preferences',r=>r.request().method()==='GET'?r.abort('failed'):r.continue());
  await page.goto(base); await page.locator('#preferences-save-error').waitFor();
  fs.writeFileSync(config,JSON.stringify({'bounty-board-theme':'dark'}));
  await page.unroute('**/api/user-preferences');
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark',null,{timeout:4000});
  await page.waitForFunction(()=>!document.querySelector('#preferences-save-error'));
}));

test('late recovery does not dismiss an open theme menu', {timeout:60000}, () => withEmptyBoard({'bounty-board-show-archived':'false'},async({browser,base,config})=>{
  const page=await browser.newPage();
  await page.route('**/api/user-preferences',r=>r.request().method()==='GET'?r.abort('failed'):r.continue());
  await page.goto(base); await page.locator('#preferences-save-error').waitFor();
  await page.evaluate(()=>window.registerBoardModule({name:'test-render-seam',afterRender:ctx=>{window.__testRender=ctx.render;}}));
  await page.getByRole('button',{name:'Theme',exact:true}).click();
  await page.getByRole('menuitemradio',{name:'Dusk',exact:true}).waitFor();
  fs.writeFileSync(config,JSON.stringify({'bounty-board-show-archived':'true','bounty-board-theme':'dark'}));
  await page.unroute('**/api/user-preferences'); await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  await page.evaluate(()=>window.__testRender());
  await page.getByRole('menuitemradio',{name:'Dusk',exact:true}).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dusk');
}));

test('late recovery updates terminal Settings', {timeout:60000}, () => withEmptyBoard({'terminal.dock':'bottom'},async({browser,base,config})=>{
  const page=await browser.newPage();
  await page.route('**/api/user-preferences',r=>r.request().method()==='GET'?r.abort('failed'):r.continue());
  await page.goto(base+'/#/settings'); await page.locator('#preferences-save-error').waitFor();
  await page.locator('[data-set-dock="bottom"]').waitFor();
  fs.writeFileSync(config,JSON.stringify({'terminal.dock':'right','terminal.ctrlVPaste':'false'}));
  await page.unroute('**/api/user-preferences');
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>document.querySelector('[data-set-dock="right"]')?.getAttribute('aria-pressed')==='true');
  assert.equal(await page.locator('[data-term-pref="ctrlVPaste"]').isChecked(),false);
}));

test('late recovery updates an untouched recent list', {timeout:60000}, () => withEmptyBoard({'list.recent.order':'"newest"'},async({browser,base,config})=>{
  const page=await browser.newPage();
  await page.route('**/api/user-preferences',r=>r.request().method()==='GET'?r.abort('failed'):r.continue());
  await page.goto(base+'/#/recent'); await page.locator('#preferences-save-error').waitFor();
  await page.locator('#recent-order').waitFor();
  fs.writeFileSync(config,JSON.stringify({'list.recent.order':'"oldest"'}));
  await page.unroute('**/api/user-preferences'); await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>document.querySelector('#recent-order')?.value==='oldest');
}));

test('late recovery preserves an active report draft and focus', {timeout:60000}, () => withEmptyBoard({'bounty-board-theme':'light'},async({browser,base,config,root})=>{
  const reports=path.join(root,'web_bounty','fictional','web','reports');
  fs.mkdirSync(reports,{recursive:true}); fs.writeFileSync(path.join(reports,'example.md'),'# original');
  const page=await browser.newPage();
  await page.route('**/api/user-preferences',r=>r.request().method()==='GET'?r.abort('failed'):r.continue());
  await page.goto(base+'/#/programs/web_bounty%2Ffictional/web/reports');
  await page.locator('.CodeMirror textarea').waitFor(); await page.locator('#preferences-save-error').waitFor();
  await page.locator('.CodeMirror textarea').focus(); await page.keyboard.press('Control+A'); await page.keyboard.insertText('draft survives recovery');
  fs.writeFileSync(config,JSON.stringify({'bounty-board-theme':'dark'}));
  await page.unroute('**/api/user-preferences'); await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  assert.match(await page.locator('.CodeMirror').innerText(),/draft survives recovery/);
  assert.equal(await page.locator('.CodeMirror textarea').evaluate(e=>e===document.activeElement),true);
  assert.equal(fs.readFileSync(path.join(reports,'example.md'),'utf8'),'# original');
}));

test('server theme is applied when browser storage is blocked', {timeout:60000}, () => withEmptyBoard({'bounty-board-theme':'dark','bounty-board-sidebar-collapsed':'true','terminal.dock':'left','terminal.ctrlVPaste':'false'},async({browser,base})=>{
  const context=await browser.newContext();
  await context.addInitScript(()=>{Storage.prototype.setItem=function(){throw new DOMException('blocked','SecurityError');};});
  const page=await context.newPage(); await page.goto(base+'/#/settings');
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark',null,{timeout:4000});
  assert.equal(await page.locator('#preferences-save-error').isVisible(),true,'blocked fallback is visible');
  assert.equal(await page.locator('#shell').evaluate(e=>e.classList.contains('sidebar-collapsed')),true);
  await page.locator('[data-set-dock="left"]').waitFor();
  assert.equal(await page.locator('[data-set-dock="left"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('[data-term-pref="ctrlVPaste"]').isChecked(),false);
}));

test('preferences GET cannot block DOMContentLoaded indefinitely', {timeout:60000}, () => withEmptyBoard({'bounty-board-theme':'dark'},async({browser,base})=>{
  const page=await browser.newPage(); let release;
  const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/user-preferences',async route=>{if(route.request().method()==='GET')await gate; await route.continue().catch(()=>{});});
  const navigation=page.goto(base,{waitUntil:'domcontentloaded'});
  const finished=await Promise.race([navigation.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),1200))]);
  release(); await navigation;
  assert.equal(finished,true,'DOMContentLoaded must not await the preference server');
}));

test('never completing preference GET times out without blocking the page', {timeout:60000}, () => withEmptyBoard(null,async({browser,base})=>{
  const page=await browser.newPage(); let release;
  const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/user-preferences',async route=>{if(route.request().method()==='GET')await gate; await route.continue().catch(()=>{});});
  try {
    await page.goto(base,{waitUntil:'domcontentloaded',timeout:5000});
    await page.locator('#preferences-save-error').waitFor({timeout:6000});
    assert.equal(await page.getByRole('button',{name:'Theme',exact:true}).isVisible(),true);
  } finally {release();}
}));

test('an edit made while migration is in flight is not a false conflict', {timeout:60000}, () => withEmptyBoard(null,async({browser,base,config})=>{
  const context=await browser.newContext();
  await context.addInitScript(()=>localStorage.setItem('bounty-board-terminal:v1',JSON.stringify({dock:'left'})));
  const page=await context.newPage(); let release, seen;
  const gate=new Promise(resolve=>{release=resolve;}), entered=new Promise(resolve=>{seen=resolve;});
  await page.route('**/api/user-preferences',async route=>{
    const req=route.request();
    if(req.method()!=='POST' || !JSON.parse(req.postData()).migrate)return route.continue();
    const response=await route.fetch(); seen(); await gate; await route.fulfill({response}).catch(()=>{});
  });
  try {
    await page.goto(base,{waitUntil:'domcontentloaded'}); await entered;
    await page.evaluate(()=>window.BoardPreferences.set('terminal.dock','right'));
    release(); await waitSaved(page);
    assert.equal(JSON.parse(fs.readFileSync(config))['terminal.dock'],'right');
  } finally { release(); }
}));

test('a stale delayed read cannot roll back a completed edit', {timeout:60000}, () => withEmptyBoard(null,async({browser,base,config})=>{
  const page=await browser.newPage(); let release, seen;
  const gate=new Promise(resolve=>{release=resolve;});
  const entered=new Promise(resolve=>{seen=resolve;});
  await page.route('**/api/user-preferences',async route=>{
    if(route.request().method()!=='GET')return route.continue();
    seen(); await gate; await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({preferences:{},revisions:{}})}).catch(()=>{});
  });
  try {
    await page.goto(base,{waitUntil:'domcontentloaded'}); await entered;
    await page.evaluate(()=>window.BoardPreferences.set('bounty-board-theme','dark'));
    await waitSaved(page);
    release();
    await page.waitForTimeout(500);
    await page.evaluate(()=>window.BoardPreferences.set('bounty-board-theme','dusk'));
    await waitSaved(page);
    assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'dusk');
    assert.equal(await page.locator('#preferences-save-error').count(),0);
  } finally { release(); }
}));

test('reports insertion and stale rerender do not save the details default', {timeout:60000}, async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bup-details-'));
  const root=path.join(dir,'data'), config=path.join(dir,'private','user.conf');
  const lane=path.join(root,'web_bounty','fictional','web');
  fs.mkdirSync(path.join(lane,'ledgers'),{recursive:true});
  fs.mkdirSync(path.join(lane,'reports'),{recursive:true});
  fs.writeFileSync(path.join(lane,'ledgers','ledger.json'), JSON.stringify({findings:[]}));
  fs.writeFileSync(path.join(lane,'reports','notes.md'),'# fictional');
  let child,browser;
  try {
    const running=await start(root,config); child=running.child;
    const base=`http://127.0.0.1:${running.port}`;
    browser=await chromium.launch({executablePath:process.env.CHROME_BIN,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const a=await browser.newPage(), b=await browser.newPage();
    let posts=[];
    a.on('request',r=>{if(r.method()==='POST' && r.url().endsWith('/api/user-preferences'))posts.push(r.postData());});
    const url=base+'/#/programs/web_bounty%2Ffictional/web/reports';
    await a.goto(url); await a.locator('[data-report-browser]').waitFor();
    await a.waitForTimeout(500);
    assert.deepEqual(posts,[], 'opening Reports does not save defaults');
    await b.goto(url); await b.locator('[data-report-browser] summary').click();
    await waitSaved(b);
    assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-report-list-open'],'false');
    await a.getByRole('link',{name:'Findings',exact:true}).first().click();
    await a.getByRole('link',{name:'Reports',exact:true}).first().click();
    await a.locator('[data-report-browser]').waitFor(); await a.waitForTimeout(500);
    assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-report-list-open'],'false');
  } finally { if(browser)await browser.close(); await stop(child); fs.rmSync(dir,{recursive:true,force:true}); }
});

test('server preferences migrate, survive reload/new device/restart, and report a failed save', {timeout:120000}, async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bup-'));
  const root=path.join(dir,'data'), config=path.join(dir,'private','user.conf');
  const lane=path.join(root,'web_bounty','fictional','web');
  fs.mkdirSync(path.join(lane,'ledgers'),{recursive:true});
  fs.mkdirSync(path.join(lane,'reports'),{recursive:true});
  fs.writeFileSync(path.join(lane,'ledgers','ledger.json'), JSON.stringify({findings:[]}));
  let child, browser;
  try {
    let running=await start(root,config); child=running.child; const port=running.port, base=`http://127.0.0.1:${port}`;
    browser=await chromium.launch({executablePath:process.env.CHROME_BIN,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const virgin=await browser.newContext(); const virginPage=await virgin.newPage();
    await virginPage.goto(base);
    await virginPage.getByRole('heading',{name:'Portfolio overview'}).waitFor();
    assert.equal(fs.existsSync(config),false,'loading defaults does not create a config');
    await virgin.close();
    const context=await browser.newContext();
    await context.addInitScript(() => {
      if (!sessionStorage.seeded) {
        localStorage.setItem('bounty-board-theme','dusk');
        localStorage.setItem('bounty-board-sidebar-collapsed','true');
        localStorage.setItem('bounty-board-terminal:v1',JSON.stringify({dock:'left',copyOnSelect:false,open:true,height:400}));
        localStorage.setItem('bounty-board-recent-reports',JSON.stringify({order:'severity',window:'7d'}));
        localStorage.setItem('bounty-board-live-secret-draft','never-sync-sentinel');
        sessionStorage.seeded='1';
      }
    });
    const page=await context.newPage();
    await page.goto(base);
    await page.getByRole('heading',{name:'Portfolio overview'}).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'dusk');
    assert.equal(await page.locator('#shell').evaluate(e=>e.classList.contains('sidebar-collapsed')),true);
    assert.equal(await page.evaluate(()=>window.BoardTerminal.prefs.dock),'left');
    await new Promise((resolve,reject)=>{
      const deadline=Date.now()+10000;
      function check() {
        try {
          const saved=JSON.parse(fs.readFileSync(config));
          if(saved['terminal.dock']==='left' && saved['list.recent.order']==='"severity"')return resolve();
        } catch(error) { if(error.code!=='ENOENT')return reject(error); }
        if(Date.now()>deadline)return reject(new Error('migration did not reach the config file'));
        setTimeout(check,50);
      }
      check();
    });
    let saved=JSON.parse(fs.readFileSync(config));
    assert.equal(saved['terminal.copyOnSelect'],'false');
    assert.equal(saved['terminal.dock'],'left');
    assert.equal(saved['list.recent.order'],'"severity"');
    assert.ok(!JSON.stringify(saved).includes('never-sync-sentinel'));
    assert.ok(!Object.hasOwn(saved,'terminal.open'));
    assert.ok(!Object.hasOwn(saved,'terminal.height'));

    await page.locator('#theme-button').click();
    await page.getByRole('menuitemradio',{name:'Dark',exact:true}).click();
    await page.locator('#sidebar-toggle').click();
    await page.getByRole('button',{name:'Open workspace'}).click();
    await page.waitForFunction(()=>document.querySelector('[data-recent-program]'));
    await page.evaluate(()=>{location.hash='#/settings';});
    await page.locator('[data-set-dock="right"]').click();
    await page.locator('[data-term-pref="ctrlVPaste"]').uncheck();
    await page.locator('[data-shortcut-recorder]').click();
    await page.keyboard.press('Alt+T');
    await waitSaved(page);
    saved=JSON.parse(fs.readFileSync(config));
    assert.equal(saved['bounty-board-theme'],'dark');
    assert.equal(saved['terminal.dock'],'right');
    assert.equal(saved['terminal.ctrlVPaste'],'false');
    assert.equal(JSON.parse(saved['terminal.shortcut']).code,'KeyT');
    assert.ok(saved['bounty-board-recent-programs']);
    await page.reload();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
    assert.equal(await page.locator('[data-set-dock="right"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('[data-term-pref="ctrlVPaste"]').isChecked(),false);
    assert.equal(await page.locator('[data-shortcut-key]').textContent(),'Alt+T');

    // A stale browser migrates missing keys only: server values always win.
    const other=await browser.newContext();
    await other.addInitScript(()=>{if(!sessionStorage.seeded){localStorage.setItem('bounty-board-theme','light');sessionStorage.seeded='1';}});
    const otherPage=await other.newPage();
    await otherPage.goto(base+'/#/settings');
    await otherPage.locator('[data-set-dock="right"]').waitFor();
    assert.equal(await otherPage.locator('html').getAttribute('data-theme'),'dark');
    assert.equal(await otherPage.locator('[data-term-pref="ctrlVPaste"]').isChecked(),false);
    assert.equal(await otherPage.locator('[data-shortcut-key]').textContent(),'Alt+T');
    assert.ok(await otherPage.locator('[data-recent-program]').count());

    // Two stale tabs edit different fields of the same list preference.
    await page.evaluate(()=>{location.hash='#/recent';});
    await otherPage.evaluate(()=>{location.hash='#/recent';});
    await page.locator('#recent-order').waitFor();
    await otherPage.locator('#recent-order').waitFor();
    await page.locator('#recent-order').selectOption('oldest');
    await waitSaved(page);
    await otherPage.locator('[data-facet-open="opts"]').click();
    await otherPage.locator('#recent-nav').check();
    await waitSaved(otherPage);
    saved=JSON.parse(fs.readFileSync(config));
    assert.equal(saved['list.recent.order'],'"oldest"');
    assert.equal(saved['list.recent.nav'],'true');

    await stop(child); child=null;
    running=await start(root,config,port); child=running.child;
    const fresh=await browser.newContext(); const afterRestart=await fresh.newPage();
    await afterRestart.goto(base+'/#/settings');
    await afterRestart.locator('[data-set-dock="right"]').waitFor();
    assert.equal(await afterRestart.locator('html').getAttribute('data-theme'),'dark');
    assert.equal(await afterRestart.locator('[data-term-pref="ctrlVPaste"]').isChecked(),false);

    // Corruption never gets overwritten; UI visibly keeps the browser fallback.
    // Fence the failed save until after reload, so it cannot commit while the
    // original page is unloading and create an intentionally ambiguous ack.
    await afterRestart.route('**/api/user-preferences',route=>route.request().method()==='POST'?route.abort('failed'):route.continue());
    const good=fs.readFileSync(config,'utf8'); fs.writeFileSync(config,'{broken');
    await afterRestart.reload();
    await afterRestart.locator('#preferences-save-error').waitFor();
    await afterRestart.locator('#theme-button').click();
    await afterRestart.getByRole('menuitemradio',{name:'Dusk',exact:true}).click();
    await afterRestart.waitForFunction(()=>Object.keys(localStorage).some(k=>k.startsWith('bounty-board-preferences-edit:v2:') && JSON.parse(localStorage.getItem(k)).value==='dusk'));
    assert.equal(fs.readFileSync(config,'utf8'),'{broken');
    assert.equal(await afterRestart.locator('html').getAttribute('data-theme'),'dusk');
    fs.writeFileSync(config,good);
    await afterRestart.reload();
    await afterRestart.unroute('**/api/user-preferences');
    await afterRestart.evaluate(()=>window.dispatchEvent(new Event('online')));
    await afterRestart.getByRole('button',{name:/use my choice.*theme/i}).click();
    await waitSaved(afterRestart);
    assert.equal(await afterRestart.locator('html').getAttribute('data-theme'),'dusk');
    assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'dusk');
  } finally {
    if(browser) await browser.close();
    await stop(child);
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
