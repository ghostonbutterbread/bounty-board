// Disposable Board process, data tree and preference file; no user's HOME.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');
const {once} = require('node:events');
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
