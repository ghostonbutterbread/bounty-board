const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {chromium} = require('playwright');

// Disposable roots; only the report-read editability flag is adapted. Shared
// store, recovery and Markdown publication use the actual synthetic backend.
async function fixture(run, enabled=true) {
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'rel-'));
  const root=path.join(tmp,'root'), store=path.join(tmp,'private');
  const report=path.join(root,'web_bounty/example/web/reports/report.md');
  fs.mkdirSync(path.dirname(report),{recursive:true});
  const initial='one\ntwo\nthree\nfour\nfive\nsix\nseven\n';
  fs.writeFileSync(report,initial);
  let proc, browser, port=0;
  async function start(on) {
    const code="import sys,app; kw={'report_autosave':True} if sys.argv[4]=='1' else {}; s=app.make_server(sys.argv[1],int(sys.argv[3]),collaboration_dir=sys.argv[2],**kw); print(s.server_port,flush=True); s.serve_forever()";
    proc=spawn('python3',['-B','-u','-c',code,root,store,String(port),on?'1':'0'],{cwd:path.resolve(__dirname,'../..'),env:process.env,stdio:['ignore','pipe','ignore']});
    const [chunk]=await once(proc.stdout,'data'); port=Number(String(chunk).trim());assert.ok(port);
  }
  async function stop(){if(proc && proc.exitCode===null && proc.signalCode===null){const exit=once(proc,'exit');proc.kill();await exit;}}
  try {
    await start(enabled);
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    await run({browser,base:`http://127.0.0.1:${port}`,report,initial,restart:async on=>{await stop();await start(on);}});
  } finally {if(browser)await browser.close();await stop();fs.rmSync(tmp,{recursive:true,force:true});}
}
async function open(page,base){await page.route('**/api/report?*',async route=>{const response=await route.fetch(),body=await response.json();body.editable=true;await route.fulfill({response,json:body});});page.setDefaultTimeout(15000);await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();await page.getByText(/Shared draft ready/).waitFor();}
async function edit(page,text){await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText(text);}
async function get(page,url){return page.evaluate(async url=>{const r=await fetch(url);return {status:r.status,body:await r.json()};},url);}
test('lost store-only acknowledgement recovers merged content', {timeout:60000},()=>fixture(async({browser,base,report,initial})=>{
 const a=await browser.newPage(),b=await browser.newPage();await Promise.all([open(a,base),open(b,base)]);const fd=fs.openSync(report,'r+');
 let go,arrive,done;const gate=new Promise(r=>go=r),started=new Promise(r=>arrive=r),committed=new Promise(r=>done=r);
 try{
  const first=a.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/api/collaboration?'));await edit(a,initial.replace('one','board'));await first;
  await b.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror.getValue().includes('board'));
  const handler=async route=>{if(route.request().method()!=='POST')return route.continue();arrive();await gate;const response=await route.fetch();const body=await response.json();console.log('DROPPED',JSON.stringify(body));await route.abort();done(body);};
  await b.route('**/api/collaboration?*',handler);await edit(b,initial.replace('one','board').replace('three','client'));await started;
  const late=initial.replace('seven','outside');fs.writeSync(fd,late,0,'utf8');fs.ftruncateSync(fd,Buffer.byteLength(late));fs.fsyncSync(fd);go();const receipt=await committed;assert.equal(receipt.status,'merged');
  await b.getByText(/Save outcome unconfirmed/).waitFor();await b.unroute('**/api/collaboration?*',handler);
  const newer=initial.replace('one','board').replace('three','client').replace('five','newer');
  await edit(b,newer);const saved=await b.evaluate(()=>Object.values(localStorage).map(v=>{try{return JSON.parse(v);}catch{return null;}}).find(v=>v?.pendingShared));
  assert.equal(saved.text,newer);assert.equal(saved.pendingShared.content,receipt.content.replace('outside','seven'));
  await b.reload();await b.getByRole('button',{name:'Programs',exact:true}).click();await b.getByRole('button',{name:'Reports',exact:true}).click();
  await b.getByRole('button',{name:'Inspect original save'}).waitFor();assert.equal(await b.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),newer);
  const inspection=b.waitForResponse(r=>r.url().includes('/api/collaboration/recovery?'));await b.getByRole('button',{name:'Inspect original save'}).click();console.log('INSPECT',JSON.stringify(await (await inspection).json()));
  await b.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror.getValue().includes('outside'));
  const u=await b.evaluate(()=>performance.getEntriesByType('resource').map(x=>x.name).find(x=>x.includes('/api/collaboration?')));const current=await get(b,u);
  for(const word of ['board','client','newer','outside']) assert.match(current.body.content,new RegExp(word));
  assert.ok(current.body.history.some(h=>h.kind==='client:merged'));
  await b.getByRole('button',{name:'Preview merged report'}).click();
  const preview=await b.getByLabel('Merged shared report').inputValue();assert.match(preview,/outside/);assert.match(preview,/client/);
  await b.getByRole('button',{name:'Save merged report'}).click();await b.getByText(/Markdown file saved/).waitFor();
  for(const word of ['board','client','newer','outside']) assert.match(fs.readFileSync(report,'utf8'),new RegExp(word));
 }finally{go();fs.closeSync(fd);}
}));
