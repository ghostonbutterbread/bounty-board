const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {chromium} = require('playwright');

// Disposable roots and real backend editability policy. One conflict case below
// explicitly injects a publication status; all store operations are real.
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
async function open(page,base){page.setDefaultTimeout(15000);await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();await page.getByText(/Shared draft ready/).waitFor();}
async function edit(page,text){await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText(text);}
async function get(page,url){return page.evaluate(async url=>{const r=await fetch(url);return {status:r.status,body:await r.json()};},url);}
test('newer local edit while merged store receipt is in flight preserves remote text', {timeout:60000},()=>fixture(async({browser,base,report,initial})=>{
  const a=await browser.newPage(), b=await browser.newPage(); await Promise.all([open(a,base),open(b,base)]);
  const fd=fs.openSync(report,'r+');
  let go,arrive,finish,committed; const gate=new Promise(r=>go=r), started=new Promise(r=>arrive=r), done=new Promise(r=>finish=r), ack=new Promise(r=>committed=r);
  const seen=[];
  try {
    const first=a.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/api/collaboration?'));
    await edit(a,initial.replace('one','board')); await first;
    await b.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror.getValue().includes('board'));
    const bFirst=initial.replace('one','board').replace('three','client');
    const bNewer=bFirst.replace('five','newer');
    const hold=async route=>{
      if(route.request().method()!=='POST')return route.continue();
      const payload=route.request().postDataJSON();seen.push(payload);
      if(seen.length===1){arrive(); await gate; const response=await route.fetch(); const body=await response.json(); console.log('FIRST RECEIPT',JSON.stringify(body)); committed(body); await done; return route.fulfill({response,json:body});}
      const response=await route.fetch(); const body=await response.json(); console.log('SECOND RECEIPT',JSON.stringify(body)); return route.fulfill({response,json:body});
    };
    await b.route('**/api/collaboration?*',hold);await edit(b,bFirst);await started;
    const outside=initial.replace('seven','outside');fs.writeSync(fd,outside,0,'utf8');fs.ftruncateSync(fd,Buffer.byteLength(outside));fs.fsyncSync(fd);
    go();const receipt=await ack;assert.equal(receipt.status,'merged');assert.match(receipt.content,/outside/);assert.equal(receipt.publication.reasons[0],'store_needs_reconciliation');
    await edit(b,bNewer);finish();
    await b.waitForFunction(()=>{const v=document.querySelector('.CodeMirror')?.CodeMirror.getValue()||'';return v.includes('newer')&&v.includes('outside');});
    console.log('POSTS',JSON.stringify(seen));console.log('EDITOR',await b.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()));
    assert.ok(seen.length>=2,'newer draft should autosave');
    assert.equal(seen[1].base,receipt.incoming_revision,'newer text must use its actual causal base');
    const current=await get(b, (await b.evaluate(()=>performance.getEntriesByType('resource').map(x=>x.name).find(x=>x.includes('/api/collaboration?')))) );
    console.log('HEAD',JSON.stringify(current.body));
    await b.getByRole('button',{name:'Preview merged report'}).click();
    const preview=await b.getByLabel('Merged shared report').inputValue();for(const word of ['board','client','newer','outside'])assert.match(preview,new RegExp(word));
    await b.getByRole('button',{name:'Save merged report'}).click();await b.getByText(/Markdown file saved/).waitFor();
    console.log('PUBLISHED FILE',JSON.stringify(fs.readFileSync(report,'utf8')));
    for(const word of ['board','client','newer','outside']) assert.match(fs.readFileSync(report,'utf8'),new RegExp(word),'published report must retain '+word);
    assert.match(current.body.content,/outside/,'shared head must retain external text');
    assert.ok(current.body.history.some(h=>h.kind==='client:merged'),'history records causal merge');
    await b.locator('.CodeMirror textarea').focus();await b.keyboard.press('Control+z');
    assert.match(await b.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),/outside/,'undo must not undo the merged external edit');
  } finally {go();finish();fs.closeSync(fd);}
}));

test('overlapping newer edits remain local until explicit three-way resolution', {timeout:60000},()=>fixture(async({browser,base,report,initial})=>{
  const a=await browser.newPage(), b=await browser.newPage();await Promise.all([open(a,base),open(b,base)]);
  const fd=fs.openSync(report,'r+');let go,arrive,finish,committed;
  const gate=new Promise(r=>go=r),started=new Promise(r=>arrive=r),done=new Promise(r=>finish=r),ack=new Promise(r=>committed=r);
  try {
    const first=a.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/api/collaboration?'));
    await edit(a,initial.replace('one','board'));await first;await b.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror.getValue().includes('board'));
    const bFirst=initial.replace('one','board').replace('three','client'), bNewer=bFirst.replace('seven','local-conflicting');let count=0;
    const hold=async route=>{if(route.request().method()!=='POST')return route.continue();count++;if(count===1){arrive();await gate;const response=await route.fetch(),body=await response.json();committed(body);await done;return route.fulfill({response,json:body});}return route.continue();};
    await b.route('**/api/collaboration?*',hold);await edit(b,bFirst);await started;
    const outside=initial.replace('seven','outside');fs.writeSync(fd,outside,0,'utf8');fs.ftruncateSync(fd,Buffer.byteLength(outside));fs.fsyncSync(fd);go();const receipt=await ack;assert.equal(receipt.status,'merged');
    const conflict=b.waitForResponse(async r=>r.request().method()==='POST'&&r.url().includes('/api/collaboration?')&&(await r.json()).status==='conflict');
    await edit(b,bNewer);finish();const conflictBody=await (await conflict).json();assert.equal(conflictBody.status,'conflict');assert.match(conflictBody.content,/outside/);
    assert.equal(await b.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),bNewer);
    assert.doesNotMatch(fs.readFileSync(report,'utf8'),/local-conflicting/);
    await b.unroute('**/api/collaboration?*',hold);await b.getByRole('button',{name:'Inspect original save'}).click();
    await b.getByRole('button',{name:'Continue after reviewing conflict'}).waitFor();await b.getByRole('button',{name:'Continue after reviewing conflict'}).click();
    await edit(b,bNewer.replace('local-conflicting','outside plus local-conflicting'));
    await b.getByRole('button',{name:'Submit editor as resolution'}).click();
    await b.waitForFunction(()=>!document.querySelector('[data-inspect-save]')&&document.querySelector('.CodeMirror')?.CodeMirror.getValue().includes('outside plus local-conflicting'));
    await b.getByRole('button',{name:'Preview merged report'}).click();assert.match(await b.getByLabel('Merged shared report').inputValue(),/outside plus local-conflicting/);
    await b.getByRole('button',{name:'Save merged report'}).click();await b.getByText(/Markdown file saved/).waitFor();
    for(const word of ['board','client','outside','local-conflicting'])assert.match(fs.readFileSync(report,'utf8'),new RegExp(word));
  } finally {go();finish();fs.closeSync(fd);}
}));

// Inject a non-store-only publication conflict to exercise review; the store is real.
test('reviewing a publication conflict cannot treat unseen merged text as the editor base', {timeout:60000},()=>fixture(async({browser,base,report,initial})=>{
  const a=await browser.newPage(),b=await browser.newPage();await Promise.all([open(a,base),open(b,base)]);const fd=fs.openSync(report,'r+');
  let go,arrive;const gate=new Promise(r=>go=r),started=new Promise(r=>arrive=r);
  try {
    const first=a.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/api/collaboration?'));await edit(a,initial.replace('one','board'));await first;
    await b.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror.getValue().includes('board'));
    let firstPost=true;const handler=async route=>{if(route.request().method()!=='POST'||!firstPost)return route.continue();firstPost=false;arrive();await gate;const response=await route.fetch(),body=await response.json();assert.equal(body.status,'merged');body.publication={state:'conflict',operation:'synthetic',reasons:['source_changed']};return route.fulfill({response,json:body});};
    await b.route('**/api/collaboration?*',handler);await b.route('**/api/collaboration/recovery?*',async route=>{const response=await route.fetch(),body=await response.json();body.publication={state:'conflict',operation:'synthetic',reasons:['source_changed']};return route.fulfill({response,json:body});});
    await edit(b,initial.replace('one','board').replace('three','client'));await started;
    const outside=initial.replace('seven','outside');fs.writeSync(fd,outside,0,'utf8');fs.ftruncateSync(fd,Buffer.byteLength(outside));fs.fsyncSync(fd);go();
    await b.getByText(/Publication conflict/).waitFor();await b.getByRole('button',{name:'Inspect original save'}).click();await b.getByRole('button',{name:'Continue after reviewing conflict'}).waitFor();
    await b.waitForTimeout(2200);await b.getByRole('button',{name:'Continue after reviewing conflict'}).click();
    const response=b.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/api/collaboration?'));await b.getByRole('button',{name:'Submit editor as resolution'}).click();const body=await (await response).json();
    assert.match(body.content,/outside/,'resolution must not delete the unseen merged edit');assert.match(body.content,/client/);
  }finally{go();fs.closeSync(fd);}
}));
