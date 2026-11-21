const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {chromium} = require('playwright');

test('two browsers share synthetic edits and retain conflicts across restart', {timeout:60000}, async () => {
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'board-collab-'));
  const root=path.join(tmp,'root'); const report=path.join(root,'web_bounty/example/web/reports/example.md');
  fs.mkdirSync(path.dirname(report),{recursive:true}); fs.writeFileSync(report,'one\ntwo\nthree\n');
  const store=path.join(tmp,'private'); let proc, browser;
  const start=async(port=0)=>{
    proc=spawn('python3',['-B','-u','-c',"import sys,app; s=app.make_server(sys.argv[1],int(sys.argv[3]),collaboration_dir=sys.argv[2],experimental_fixture_publish=True); print(s.server_port,flush=True); s.serve_forever()",root,store,String(port)],{cwd:path.resolve(__dirname,'../..'),env:{...process.env},stdio:['ignore','pipe','pipe']});
    const [chunk]=await once(proc.stdout,'data'); return `http://127.0.0.1:${Number(chunk.toString().trim())}`;
  };
  const stop=async()=>{if(proc && proc.exitCode===null && proc.signalCode===null){const done=once(proc,'exit');proc.kill();await done;}};
  try {
    const base=await start(); browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN || '/usr/bin/google-chrome'});
    const a=await browser.newPage(), b=await browser.newPage();
    async function open(page){page.setDefaultTimeout(15000); await page.goto(base,{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();await page.locator('.CodeMirror').waitFor();await page.getByText(/Shared draft ready/).waitFor();}
    await Promise.all([open(a),open(b)]);
    async function edit(page,text){await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText(text);}
    await edit(a,'ONE\ntwo\nthree\n');
    await b.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror?.getValue()==='ONE\ntwo\nthree\n');
    assert.equal(fs.readFileSync(report,'utf8'),'one\ntwo\nthree\n');
    let releaseLate, acknowledgeLate, finishLate;
    const lateGate=new Promise(resolve=>releaseLate=resolve), lateCommitted=new Promise(resolve=>acknowledgeLate=resolve), lateDone=new Promise(resolve=>finishLate=resolve);
    const holdResponse=async route=>{if(route.request().method()!=='POST')return route.continue();
      const response=await route.fetch();acknowledgeLate();await lateGate;await route.fulfill({response});finishLate();};
    await a.route('**/api/collaboration?*',holdResponse);
    await edit(a,'late first\ntwo\nthree\n');await lateCommitted;
    await edit(a,'late newer\ntwo\nthree\n');releaseLate();await lateDone;await a.unroute('**/api/collaboration?*',holdResponse);
    await b.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror?.getValue()==='late newer\ntwo\nthree\n');
    assert.equal(await a.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'late newer\ntwo\nthree\n');
    await edit(a,'ONE\ntwo\nthree\n');
    await b.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror?.getValue()==='ONE\ntwo\nthree\n');
    let release; const held=new Promise(resolve=>release=resolve);
    let arrived; const posted=new Promise(resolve=>arrived=resolve);
    await b.route('**/api/collaboration?*',async route=>{if(route.request().method()==='POST'){arrived();await held;}await route.continue();});
    await edit(b,'B edit\ntwo\nthree\n');
    await posted;
    await edit(a,'A edit\ntwo\nthree\n');
    const rootId=(await (await a.request.get(base+'/api/data')).json()).root_identity;
    const deadline=Date.now()+8000; let actual;
    do {actual=(await (await a.request.get(base+'/api/collaboration?family=web_bounty&program=example&lane=web&path=example.md&root_identity='+rootId)).json()).content; if(actual!=='A edit\ntwo\nthree\n')await new Promise(resolve=>setTimeout(resolve,100));} while(actual!=='A edit\ntwo\nthree\n' && Date.now()<deadline);
    assert.equal(actual,'A edit\ntwo\nthree\n');
    release();
    await b.getByText(/^Conflict:/).waitFor();
    assert.equal(await b.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'B edit\ntwo\nthree\n');
    await b.getByRole('button',{name:'Submit editor as resolution'}).click();
    await a.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror?.getValue()==='B edit\ntwo\nthree\n');
    fs.writeFileSync(report,'one\ntwo\nEXTERNAL\n');
    await a.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror?.getValue()==='B edit\ntwo\nEXTERNAL\n');
    const port=Number(new URL(base).port); await stop(); await start(port);
    await a.reload({waitUntil:'domcontentloaded'}); await a.getByRole('button',{name:'Programs',exact:true}).click();await a.getByRole('button',{name:'Reports',exact:true}).click();
    await a.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror?.getValue()==='B edit\ntwo\nEXTERNAL\n');
    await a.getByText('Shared history and conflicts').click();
    await a.getByText('client:conflict').waitFor();
    await a.locator('.record').filter({hasText:'source:initial'}).getByRole('button',{name:'Preview this version'}).click();
    await a.getByRole('button',{name:'Confirm restore version'}).click();
    await b.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror?.getValue()==='one\ntwo\nthree\n');
    await a.locator('.record').filter({hasText:'source:merged'}).getByRole('button',{name:'Preview resulting revision'}).click();
    await a.getByRole('button',{name:'Confirm restore version'}).click();
    await b.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror?.getValue()==='B edit\ntwo\nEXTERNAL\n');
    const publishTrace=[];
    a.on('request',r=>{if(r.url().includes('/api/collaboration?')&&r.method()==='POST'){const body=r.postDataJSON();if(body?.action==='publish')publishTrace.push({event:'request',revision:body.revision});}});
    a.on('response',r=>{if(r.url().includes('/api/collaboration?')&&r.request().method()==='POST'){const body=r.request().postDataJSON();if(body?.action==='publish')publishTrace.push({event:'response',status:r.status()});}});
    await a.evaluate(()=>{window.__publishStatuses=[];const node=document.querySelector('#report-status');new MutationObserver(()=>window.__publishStatuses.push(node.textContent)).observe(node,{childList:true,characterData:true,subtree:true});});
    await a.getByText(/Shared draft ready/).waitFor();
    await a.getByRole('button',{name:'Publish fixture report'}).click();
    try {await a.getByText(/Fixture report published/).waitFor();}
    catch(error){const statuses=await a.evaluate(()=>window.__publishStatuses);throw new Error(`fixture publish did not reach visible success; trace=${JSON.stringify(publishTrace)} statuses=${JSON.stringify(statuses)} syntheticSource=${JSON.stringify(fs.readFileSync(report,'utf8'))}`,{cause:error});}
    assert.equal(fs.readFileSync(report,'utf8'),'B edit\ntwo\nEXTERNAL\n');
    const popupPromise=a.waitForEvent('popup'); await a.evaluate(()=>window.open('/','_blank')); const popup=await popupPromise;
    await open(popup);
    const stopWrites=route=>route.request().method()==='POST' ? route.abort() : route.continue();
    await a.route('**/api/collaboration?*',stopWrites);await popup.route('**/api/collaboration?*',stopWrites);
    await edit(a,'first unsent tab');await edit(popup,'second unsent tab');
    const records=await a.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('bounty-board-report-draft-v2:')).map(([,v])=>JSON.parse(v).text));
    assert.ok(records.includes('first unsent tab')); assert.ok(records.includes('second unsent tab'));
  } finally {if(browser)await browser.close();await stop();fs.rmSync(tmp,{recursive:true,force:true});}
});
