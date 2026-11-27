require('./isolate-home.cjs'); // Standalone runs must not use the operator's HOME.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium}=require('playwright');

async function fixture(run) {
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'board-undo-'));
  const root=path.join(tmp,'root'), report=path.join(root,'web_bounty/example/web/reports/example.md');
  fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'one\ntwo\nthree\n');
  const proc=spawn('python3',['-B','-u','-c',"import sys,app; s=app.make_server(sys.argv[1],0,collaboration_dir=sys.argv[2]); print(s.server_port,flush=True); s.serve_forever()",root,path.join(tmp,'private')],{cwd:path.resolve(__dirname,'../..'),env:process.env,stdio:['ignore','pipe','ignore']});
  let browser;
  try {
    const [chunk]=await once(proc.stdout,'data');const base='http://127.0.0.1:'+Number(chunk.toString().trim());
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    // Baseline backend advertises every report read-only; model the sibling's
    // editable policy for this real synthetic Markdown fixture.
    const newPage=browser.newPage.bind(browser);
    browser.newPage=async (...args)=>{const page=await newPage(...args);await page.route('**/api/report?*',async route=>{const response=await route.fetch(),body=await response.json();body.editable=true;await route.fulfill({response,json:body});});return page;};
    await run({browser,base,report});
  } finally {if(browser)await browser.close();if(proc.exitCode===null&&proc.signalCode===null){const done=once(proc,'exit');proc.kill();await done;}fs.rmSync(tmp,{recursive:true,force:true});}
}
async function open(page,base){page.setDefaultTimeout(8000);await page.goto(base);await page.getByRole('link',{name:'Programs',exact:true}).click();await page.getByRole('link',{name:'Reports',exact:true}).click();await page.getByText(/Shared draft ready/).waitFor();}
const value=page=>page.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue());

test('undo with no local edits cannot revert a remote edit', {timeout:30000},()=>fixture(async({browser,base})=>{
  const a=await browser.newPage(),b=await browser.newPage();await Promise.all([open(a,base),open(b,base)]);
  await b.locator('.CodeMirror textarea').focus();await b.keyboard.press('Control+End');await b.keyboard.insertText(' remote');
  await a.waitForFunction(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()==='one\ntwo\nthree\n remote');
  await a.locator('.CodeMirror textarea').focus();await a.keyboard.press('Control+z');
  assert.equal(await value(a),'one\ntwo\nthree\n remote','undo must not revert a collaborator');
  await a.waitForTimeout(1500);
  assert.equal(await value(b),'one\ntwo\nthree\n remote','undo must not publish a remote revert');
}));

test('undo a local edit across a same-line remote edit preserves remote content', {timeout:30000},()=>fixture(async({browser,base})=>{
  const a=await browser.newPage(),b=await browser.newPage();await Promise.all([open(a,base),open(b,base)]);
  await a.locator('.CodeMirror textarea').focus();await a.keyboard.press('Control+End');await a.keyboard.insertText('local');
  await a.getByText(/Shared draft ready/).waitFor();
  await b.waitForFunction(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()==='one\ntwo\nthree\nlocal');
  await b.locator('.CodeMirror textarea').focus();await b.keyboard.press('Control+End');await b.keyboard.insertText(' remote');
  await a.waitForFunction(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()==='one\ntwo\nthree\nlocal remote');
  await a.locator('.CodeMirror textarea').focus();await a.keyboard.press('Control+z');
  assert.equal(await value(a),'one\ntwo\nthree\nlocal remote','unsafe same-line undo must not overwrite remote content');
  await a.getByText(/Some local undo history was discarded/).waitFor();
  await a.waitForTimeout(1500);
  assert.equal(await value(b),'one\ntwo\nthree\nlocal remote');
}));

test('undo a local edit across a disjoint remote edit preserves remote content', {timeout:30000},()=>fixture(async({browser,base})=>{
  const a=await browser.newPage(),b=await browser.newPage();await Promise.all([open(a,base),open(b,base)]);
  await a.locator('.CodeMirror textarea').focus();await a.keyboard.press('Control+Home');await a.keyboard.insertText('local ');
  await a.getByText(/Shared draft ready/).waitFor();
  await b.waitForFunction(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()==='local one\ntwo\nthree\n');
  await b.locator('.CodeMirror textarea').focus();await b.keyboard.press('Control+End');await b.keyboard.insertText('remote');
  await a.waitForFunction(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()==='local one\ntwo\nthree\nremote');
  await a.locator('.CodeMirror textarea').focus();await a.keyboard.press('Control+z');
  assert.equal(await value(a),'one\ntwo\nthree\nremote','local undo must preserve disjoint remote content');
  await b.waitForFunction(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()==='one\ntwo\nthree\nremote');
}));
