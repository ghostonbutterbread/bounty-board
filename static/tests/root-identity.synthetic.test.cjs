const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {chromium} = require('playwright');

test('same origin separates drafts when backend root changes and restores them on return', {timeout:30000}, async () => {
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR || '/home/ryushe/.hermes/cache/scratch','board-root-'));
  const roots=['a','b'].map(name=>path.join(tmp,name));
  for(const root of roots){const dir=path.join(root,'web_bounty','fictional','web','reports');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'same.md'),'# Identical source');}
  const code='import sys,app; s=app.make_server(sys.argv[1],int(sys.argv[2])); print(s.server_port,flush=True); s.serve_forever()';
  let proc,browser,port;
  async function start(root) {proc=spawn('python3',['-B','-u','-c',code,root,String(port||0)],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,TMPDIR:tmp},stdio:['ignore','pipe','pipe']}); const [chunk]=await once(proc.stdout,'data');port=Number(chunk.toString().trim());}
  async function stop(){if(proc && proc.exitCode===null && proc.signalCode===null){const done=once(proc,'exit');proc.kill('SIGTERM');await done;}}
  try {
    await start(roots[0]);browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome'});
    const page=await browser.newPage();page.setDefaultTimeout(4000);page.on('dialog',d=>d.accept());
    const base=`http://127.0.0.1:${port}`;
    async function open(){await page.getByRole('link',{name:'Programs',exact:true}).click();await page.getByRole('link',{name:'Reports',exact:true}).click();await page.locator('.CodeMirror').waitFor();}
    await page.goto(base);await open();await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('Root A draft');
    await stop();await start(roots[1]);await page.getByRole('button',{name:'Refresh'}).click();await page.locator('.CodeMirror').waitFor();
    assert.match(await page.locator('.CodeMirror').innerText(),/Identical source/);
    await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('Root B draft');
    await stop();await start(roots[0]);await page.getByRole('button',{name:'Refresh'}).click();await page.locator('.CodeMirror').waitFor();
    assert.match(await page.locator('.CodeMirror').innerText(),/Root A draft/);
    await page.reload();await open();assert.match(await page.locator('.CodeMirror').innerText(),/Root A draft/);
    for(const root of roots)assert.equal(fs.readFileSync(path.join(root,'web_bounty','fictional','web','reports','same.md'),'utf8'),'# Identical source');
  } finally {if(browser)await browser.close();await stop();fs.rmSync(tmp,{recursive:true,force:true});}
});


test('a delayed storage event cannot cause a stale tab to overwrite another draft', {timeout:30000}, async () => {
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR || '/home/ryushe/.hermes/cache/scratch','board-tabs-'));
  const dir=path.join(tmp,'web_bounty','fictional','web','reports');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'same.md'),'# Source');
  const code='import sys,app; s=app.make_server(sys.argv[1],0); print(s.server_port,flush=True); s.serve_forever()';
  const proc=spawn('python3',['-B','-u','-c',code,tmp],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,TMPDIR:tmp},stdio:['ignore','pipe','pipe']});let browser;
  try {
    const [chunk]=await once(proc.stdout,'data');const base=`http://127.0.0.1:${Number(chunk.toString().trim())}`;
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome'});const context=await browser.newContext();
    const a=await context.newPage(), b=await context.newPage();for(const p of [a,b]){p.setDefaultTimeout(4000);p.on('dialog',d=>d.accept());}
    await b.addInitScript(()=>window.addEventListener('storage',e=>e.stopImmediatePropagation()));
    async function open(p){await p.goto(base);await p.getByRole('link',{name:'Programs',exact:true}).click();await p.getByRole('link',{name:'Reports',exact:true}).click();await p.locator('.CodeMirror').waitFor();}
    await open(a);await open(b);
    await a.locator('.CodeMirror textarea').focus();await a.keyboard.press('Control+A');await a.keyboard.insertText('Draft from A');
    await b.locator('.CodeMirror textarea').focus();await b.keyboard.press('Control+A');await b.keyboard.insertText('Draft from B');
    assert.match(await b.locator('#report-status').innerText(),/another tab/i);
    assert.match(await b.locator('.CodeMirror').innerText(),/Draft from B/);
    const drafts=await b.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('bounty-board-report-draft-v2:')).map(([,v])=>JSON.parse(v).text));
    assert.deepEqual(drafts,['Draft from A']);
    const c=await context.newPage(),d=await context.newPage();for(const p of [c,d]){p.setDefaultTimeout(4000);p.on('dialog',dialog=>dialog.accept());}
    await open(c);await open(d);
    await c.locator('.CodeMirror textarea').focus();await c.keyboard.press('Control+A');await c.keyboard.insertText('Draft from C');
    await d.getByText(/changed in another tab/).waitFor();
    await d.locator('.CodeMirror textarea').focus();await d.keyboard.press('Control+A');await d.keyboard.insertText('Draft from D');
    assert.match(await d.locator('.CodeMirror').innerText(),/Draft from D/);
    const after=await d.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('bounty-board-report-draft-v2:')).map(([,v])=>JSON.parse(v).text));
    assert.deepEqual(after,['Draft from C']);
  } finally {if(browser)await browser.close();if(proc.exitCode===null && proc.signalCode===null){const done=once(proc,'exit');proc.kill('SIGTERM');await done;}fs.rmSync(tmp,{recursive:true,force:true});}
});


test('missing identity keeps legacy draft untouched and does not persist an unscoped draft', {timeout:30000}, async () => {
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR || '/home/ryushe/.hermes/cache/scratch','board-no-identity-'));
  const dir=path.join(tmp,'web_bounty','fictional','web','reports');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'same.md'),'# Source');
  const code='import sys,app; s=app.make_server(sys.argv[1],0); print(s.server_port,flush=True); s.serve_forever()';
  const proc=spawn('python3',['-B','-u','-c',code,tmp],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,TMPDIR:tmp},stdio:['ignore','pipe','pipe']});let browser;
  try {
    const [chunk]=await once(proc.stdout,'data');const base=`http://127.0.0.1:${Number(chunk.toString().trim())}`;
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome'});const page=await browser.newPage();page.setDefaultTimeout(4000);
    const legacy='bounty-board-report-draft-v1:'+JSON.stringify(['web_bounty/fictional','web','same.md']);
    page.on('dialog',d=>d.accept());
    await page.addInitScript(key=>localStorage.setItem(key,'legacy retained'),legacy);
    await page.route('**/api/data',async route=>{const response=await route.fetch();const data=await response.json();delete data.root_identity;await route.fulfill({json:data});});
    await page.goto(base);await page.getByRole('link',{name:'Programs',exact:true}).click();await page.getByRole('link',{name:'Reports',exact:true}).click();await page.locator('.CodeMirror').waitFor();
    assert.match(await page.locator('.CodeMirror').innerText(),/Source/);
    await page.locator('.CodeMirror textarea').focus();await page.keyboard.insertText(' local edit');
    assert.match(await page.locator('#report-status').innerText(),/identity unavailable/i);
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),legacy),'legacy retained');
    assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('bounty-board-report-draft-v2:')).length),0);
    await page.unroute('**/api/data');await page.reload();await page.getByRole('link',{name:'Programs',exact:true}).click();await page.getByRole('link',{name:'Reports',exact:true}).click();await page.locator('.CodeMirror').waitFor();
    assert.match(await page.locator('.CodeMirror').innerText(),/Source/);
    await page.locator('.CodeMirror textarea').focus();await page.keyboard.insertText(' new scoped edit');
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),legacy),'legacy retained');
    assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('bounty-board-report-draft-v2:')).length),1);
  } finally {if(browser)await browser.close();if(proc.exitCode===null && proc.signalCode===null){const done=once(proc,'exit');proc.kill('SIGTERM');await done;}fs.rmSync(tmp,{recursive:true,force:true});}
});
