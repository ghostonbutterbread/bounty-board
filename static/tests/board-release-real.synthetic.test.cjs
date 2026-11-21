const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {chromium} = require('playwright');

// Only disposable roots; no fixture publisher or fabricated backend responses.
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

test('real clients, retained fd, history and restart retry preserve source and versions', {timeout:90000},()=>fixture(async({browser,base,report,initial,restart})=>{
  const a=await browser.newPage(), b=await browser.newPage();
  await Promise.all([open(a,base),open(b,base)]);
  const fd=fs.openSync(report,'r+');
  try {
    const posted=a.waitForRequest(r=>r.method()==='POST' && r.url().includes('/api/collaboration?'));
    const published=a.waitForResponse(r=>r.request().method()==='POST' && r.url().includes('/api/collaboration?'));
    await edit(a,initial.replace('one','board'));
    const request=await posted, payload=request.postDataJSON(), url=request.url();
    assert.equal((await (await published).json()).publication.state,'published');
    await a.getByText(/Markdown file saved/).waitFor();
    assert.equal(fs.readFileSync(report,'utf8'),initial.replace('one','board'));
    await b.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror.getValue().includes('board'));
    const bPublished=b.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/api/collaboration?'));
    const visible=initial.replace('one','board').replace('two','second');
    await edit(b,visible);
    assert.equal((await (await bPublished).json()).publication.state,'published');
    assert.equal(fs.readFileSync(report,'utf8'),visible);
    // Old inode survives exchange; an independent process can still edit it.
    const late=initial.replace('seven','outside');
    fs.writeSync(fd,late,0,'utf8');fs.ftruncateSync(fd,Buffer.byteLength(late));fs.fsyncSync(fd);
    const history=await get(b,url.replace('/api/collaboration?','/api/collaboration/history?'));
    assert.equal(history.status,200);
    const retained=history.body.history.find(x=>x.kind.startsWith('retained:'));
    assert.ok(retained,JSON.stringify(history.body));
    const version=await get(b,url.replace('/api/collaboration?','/api/collaboration/version?')+'&revision='+encodeURIComponent(retained.revision));
    assert.equal(version.status,200);assert.equal(version.body.content,late);
    const current=await get(b,url);assert.match(current.body.content,/board/);assert.match(current.body.content,/outside/);
    assert.equal(fs.readFileSync(report,'utf8'),visible);
    await b.getByText('Shared history and conflicts').click();
    await b.getByText(/retained:/).first().waitFor();
    // A second client's new edit is retained in the store, not falsely published.
    await b.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror.getValue().includes('outside'));
    const save=b.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/api/collaboration?'));
    await edit(b,current.body.content.replace('three','third'));
    const second=await (await save).json();assert.equal(second.store_saved,true);assert.notEqual(second.publication.state,'published');
    assert.equal(fs.readFileSync(report,'utf8'),visible);
    await restart(true);
    const recovery=await get(a,url.replace('/api/collaboration?','/api/collaboration/recovery?')+'&request_id='+encodeURIComponent(payload.request_id));
    assert.equal(recovery.status,200);assert.notEqual(recovery.body.publication.state,'published');
    const retry=await a.evaluate(async ({url,payload})=>{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'Bounty-Board'},body:JSON.stringify(payload)});return {status:r.status,body:await r.json()};},{url,payload});
    assert.equal(retry.status,200);assert.notEqual(retry.body.publication.state,'published');
    assert.equal(fs.readFileSync(report,'utf8'),visible);
    // The actual version endpoint remains available following restart.
    const afterVersion=await get(a,url.replace('/api/collaboration?','/api/collaboration/version?')+'&revision='+encodeURIComponent(retained.revision));
    assert.equal(afterVersion.body.content,late);
  } finally {fs.closeSync(fd);}
}));

test('default disabled keeps shared edits out of synthetic Markdown', {timeout:50000},()=>fixture(async({browser,base,report,initial})=>{
  const page=await browser.newPage();await open(page,base);
  const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/api/collaboration?'));
  await edit(page,'store only\n');const result=await (await response).json();
  assert.equal(result.publication,undefined);assert.equal(fs.readFileSync(report,'utf8'),initial);
  assert.doesNotMatch(await page.locator('#report-status').innerText(),/Markdown file saved/);
},false));
