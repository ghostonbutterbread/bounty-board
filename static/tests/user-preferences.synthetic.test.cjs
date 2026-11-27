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
  await page.waitForFunction(() => !Object.keys(localStorage).some(k => k.startsWith('bounty-board-preferences-pending:v1:')));
}

test('draft write guard rejects report endpoints and draft content in preference payloads', () => {
  const base='http://127.0.0.1:1234', draft='draft-sentinel-content';
  assert.throws(()=>assertPreferencesOnly([{method:'POST',url:base+'/api/live/save',body:'{}'}],base,[draft]));
  assert.throws(()=>assertPreferencesOnly([{method:'POST',url:base+'/api/user-preferences',body:JSON.stringify({set:{'bounty-board-theme':draft},expected:{'bounty-board-theme':0}})}],base,[draft]));
  assert.doesNotThrow(()=>assertPreferencesOnly([{method:'POST',url:base+'/api/user-preferences',body:JSON.stringify({set:{'bounty-board-theme':'dark'},expected:{'bounty-board-theme':0}})}],base,[draft]));
});

async function withEmptyBoard(initial, run) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bup-review-'));
  const root=path.join(dir,'data'), config=path.join(dir,'private','user.conf');
  fs.mkdirSync(root,{recursive:true});
  if(initial) { fs.mkdirSync(path.dirname(config),{recursive:true}); fs.writeFileSync(config,JSON.stringify(initial)); }
  let child,browser;
  try {
    const running=await start(root,config); child=running.child;
    browser=await chromium.launch({executablePath:process.env.CHROME_BIN,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    await run({browser,base:`http://127.0.0.1:${running.port}`,config});
  } finally { if(browser)await browser.close(); await stop(child); fs.rmSync(dir,{recursive:true,force:true}); }
}

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
  assert.equal(await a.evaluate(()=>localStorage.getItem('bounty-board-preferences-pending:v1:bounty-board-theme')),'dusk');
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

test('failed bootstrap retries the read and hydrates before clearing alert', {timeout:60000}, () => withEmptyBoard({'bounty-board-theme':'dark'},async({browser,base})=>{
  const page=await browser.newPage();
  await page.route('**/api/user-preferences',r=>r.request().method()==='GET'?r.abort('failed'):r.continue());
  await page.goto(base); await page.locator('#preferences-save-error').waitFor();
  await page.unroute('**/api/user-preferences');
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark',null,{timeout:4000});
  await page.waitForFunction(()=>!document.querySelector('#preferences-save-error'));
}));

test('server theme is applied when browser storage is blocked', {timeout:60000}, () => withEmptyBoard({'bounty-board-theme':'dark'},async({browser,base})=>{
  const context=await browser.newContext();
  await context.addInitScript(()=>{Storage.prototype.setItem=function(){throw new DOMException('blocked','SecurityError');};});
  const page=await context.newPage(); await page.goto(base);
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark',null,{timeout:4000});
  assert.equal(await page.locator('#preferences-save-error').isVisible(),true,'blocked fallback is visible');
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
    const good=fs.readFileSync(config,'utf8'); fs.writeFileSync(config,'{broken');
    await afterRestart.reload();
    await afterRestart.locator('#preferences-save-error').waitFor();
    await afterRestart.locator('#theme-button').click();
    await afterRestart.getByRole('menuitemradio',{name:'Dusk',exact:true}).click();
    await afterRestart.waitForFunction(()=>localStorage.getItem('bounty-board-preferences-pending:v1:bounty-board-theme')==='dusk');
    assert.equal(fs.readFileSync(config,'utf8'),'{broken');
    assert.equal(await afterRestart.locator('html').getAttribute('data-theme'),'dusk');
    fs.writeFileSync(config,good);
    await afterRestart.reload();
    await waitSaved(afterRestart);
    assert.equal(await afterRestart.locator('html').getAttribute('data-theme'),'dusk');
    assert.equal(JSON.parse(fs.readFileSync(config))['bounty-board-theme'],'dusk');
  } finally {
    if(browser) await browser.close();
    await stop(child);
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
