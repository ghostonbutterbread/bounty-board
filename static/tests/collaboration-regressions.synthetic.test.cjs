const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {chromium} = require('playwright');

async function fixture(run) {
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'board-regression-'));
  const root=path.join(tmp,'root'), report=path.join(root,'web_bounty/example/web/reports/example.md');
  fs.mkdirSync(path.dirname(report),{recursive:true}); fs.writeFileSync(report,'one\ntwo\nthree\n');
  const proc=spawn('python3',['-B','-u','-c',"import sys,app; s=app.make_server(sys.argv[1],0,collaboration_dir=sys.argv[2]); print(s.server_port,flush=True); s.serve_forever()",root,path.join(tmp,'private')],{cwd:path.resolve(__dirname,'../..'),env:process.env,stdio:['ignore','pipe','pipe']});
  let browser;
  try {
    const [chunk]=await once(proc.stdout,'data'); const base='http://127.0.0.1:'+Number(chunk.toString().trim());
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN || '/usr/bin/google-chrome',args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    await run({browser,base,report});
  } finally {
    if(browser)await browser.close();
    if(proc.exitCode===null && proc.signalCode===null){const done=once(proc,'exit');proc.kill();await done;}
    fs.rmSync(tmp,{recursive:true,force:true});
  }
}
async function open(page,base) {
  page.setDefaultTimeout(8000); await page.goto(base); await page.getByRole('link',{name:'Programs',exact:true}).click();
  await page.getByRole('link',{name:'Reports',exact:true}).click(); await page.getByText(/Shared draft ready/).waitFor();
}

test('save acknowledgment and unchanged poll preserve cursor and undo', {timeout:30000}, async()=>fixture(async({browser,base})=>{
  const page=await browser.newPage(); await open(page,base);
  let release, arrived;
  const gate=new Promise(r=>release=r), committed=new Promise(r=>arrived=r);
  const hold=async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();arrived();await gate;await route.fulfill({response});};
  await page.route('**/api/collaboration?*',hold);
  await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText(' edited');await committed;
  await page.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.setCursor({line:0,ch:2}));
  const before=await page.evaluate(()=>{const cm=document.querySelector('.CodeMirror').CodeMirror;return {cursor:cm.getCursor(),history:cm.historySize()};});
  assert.ok(before.history.undo>0);
  release();await page.getByText(/Shared draft ready/).waitFor();await page.unroute('**/api/collaboration?*',hold);
  const after=await page.evaluate(()=>{const cm=document.querySelector('.CodeMirror').CodeMirror;return {cursor:cm.getCursor(),history:cm.historySize()};});
  assert.deepEqual(after,before,'ack must not reset cursor or undo history');
  await page.waitForTimeout(2500);
  const polled=await page.evaluate(()=>{const cm=document.querySelector('.CodeMirror').CodeMirror;return {cursor:cm.getCursor(),history:cm.historySize()};});
  assert.deepEqual(polled,before,'identical polling must not reset cursor or undo history');
  await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+z');
  assert.equal(await page.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'one\ntwo\nthree\n');
}));

test('remote change preserves cursor and warns when local undo overlaps', {timeout:30000}, async()=>fixture(async({browser,base})=>{
  const a=await browser.newPage(), b=await browser.newPage();await Promise.all([open(a,base),open(b,base)]);
  await a.locator('.CodeMirror textarea').focus();await a.keyboard.press('Control+End');await a.keyboard.insertText(' local');
  await a.getByText(/Shared draft ready/).waitFor();
  await b.waitForFunction(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()==='one\ntwo\nthree\n local');
  await a.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.setCursor({line:0,ch:2}));
  const before=await a.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.historySize().undo);
  await b.locator('.CodeMirror textarea').focus();await b.keyboard.press('Control+End');await b.keyboard.insertText(' remote');
  await a.waitForFunction(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()==='one\ntwo\nthree\n local remote');
  const actual=await a.evaluate(()=>{const cm=document.querySelector('.CodeMirror').CodeMirror;const p=cm.getCursor();return {line:p.line,ch:p.ch,undo:cm.historySize().undo};});
  assert.equal(actual.line,0);assert.equal(actual.ch,2);assert.ok(actual.undo<before);
  await a.getByText(/Some local undo history was discarded/).waitFor();
}));

test('failed unsent shared edit is restored and retried after reload', {timeout:30000}, async()=>fixture(async({browser,base})=>{
  const page=await browser.newPage(); await open(page,base);
  await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('shared differs from source');
  await page.getByText(/Shared draft ready/).waitFor();
  const failPost=route=>route.request().method()==='POST' ? route.abort() : route.continue();
  await page.route('**/api/collaboration?*',failPost);
  await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('offline unsent draft');
  await page.getByText(/Shared save failed/).waitFor();
  await page.reload();await page.getByRole('link',{name:'Programs',exact:true}).click();await page.getByRole('link',{name:'Reports',exact:true}).click();
  await page.locator('.CodeMirror').waitFor();
  assert.equal(await page.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'offline unsent draft');
  await page.unroute('**/api/collaboration?*',failPost);
  await page.getByText(/Shared draft ready/).waitFor();
  const other=await browser.newPage();await open(other,base);
  assert.equal(await other.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'offline unsent draft');
}));
