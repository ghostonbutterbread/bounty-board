require('./isolate-home.cjs'); // Standalone runs must not use the operator's HOME.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium}=require('playwright');

async function fixture(run){
 const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'cap-'));
 const root=path.join(tmp,'root'),store=path.join(tmp,'private'),report=path.join(root,'web_bounty/example/web/reports/report.md');
 fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'original\n');let proc,browser,port=0;
 async function start(limit){const code="import sys,app; s=app.make_server(sys.argv[1],int(sys.argv[3]),collaboration_dir=sys.argv[2],report_autosave=True,retention_max_operations=int(sys.argv[4]),retention_min_free_bytes=0); print(s.server_port,flush=True); s.serve_forever()";proc=spawn('python3',['-B','-u','-c',code,root,store,String(port),String(limit)],{cwd:tmp,env:{...process.env,PYTHONPATH:path.resolve(__dirname,'../..')},stdio:['ignore','pipe','ignore']});const [s]=await once(proc.stdout,'data');port=Number(String(s).trim());assert.ok(port);}
 async function stop(){if(proc && proc.exitCode===null && proc.signalCode===null){const p=once(proc,'exit');proc.kill();await p;}}
 try{
  await start(1);browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
  const page=await browser.newPage();page.setDefaultTimeout(8000);await page.goto(`http://127.0.0.1:${port}`);await page.getByRole('link',{name:'Programs',exact:true}).click();await page.getByRole('link',{name:'Reports',exact:true}).click();await page.getByText(/Shared draft ready/).waitFor();
  await run({page,report,store,restart:async limit=>{await stop();await start(limit);}});
 }finally{if(browser)await browser.close();await stop();fs.rmSync(tmp,{recursive:true,force:true});}
}
async function edit(page,text){await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText(text);}
const isPost=r=>r.request().method()==='POST'&&r.url().includes('/api/collaboration?');
async function fillCapacity(page){let wait=page.waitForResponse(isPost);await edit(page,'first\n');let first=await (await wait).json();assert.equal(first.publication.state,'published');await page.getByText(/Markdown file saved/).waitFor();wait=page.waitForResponse(isPost);await edit(page,'blocked\n');const response=await wait;const blocked=await response.json();assert.equal(blocked.publication.state,'capacity');await page.getByText(/Markdown was not saved/).first().waitFor();return {payload:response.request().postDataJSON(),first};}

for(const clicks of [1,2])test(`${clicks} retry click(s) during poll send the exact request once`, {timeout:35000},()=>fixture(async({page,report,restart})=>{
 const {payload}=await fillCapacity(page);await restart(2);
 let entered,release;const hit=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let held=false;const posts=[];
 await page.route('**/api/collaboration?*',async route=>{if(route.request().method()==='POST'){posts.push(route.request().postDataJSON());return route.continue();}if(!held){held=true;entered();await gate;}return route.continue();});
 try{await hit;for(let i=0;i<clicks;i++)await page.getByRole('button',{name:'Retry exact original request'}).click();await edit(page,'newer\n');await page.waitForTimeout(200);assert.equal(posts.length,0);assert.match(await page.locator('#report-status').innerText(),/waiting/i);const stored=await page.evaluate(()=>Object.values(localStorage).map(v=>{try{return JSON.parse(v)}catch{return null}}).find(v=>v?.pendingShared));assert.deepEqual(stored.pendingShared,payload);assert.equal(stored.text,'newer\n');const response=page.waitForResponse(isPost);const later=page.waitForResponse(r=>isPost(r) && r.request().postDataJSON().request_id!==payload.request_id);release();const saved=await response;assert.equal((await saved.json()).publication.state,'published');assert.deepEqual(posts[0],payload);assert.equal(await page.locator('.CodeMirror').evaluate(e=>e.CodeMirror.getValue()),'newer\n');const next=await later;assert.equal((await next.json()).publication.state,'capacity');assert.equal(posts.length,2);assert.equal(posts[1].content,'newer\n');assert.notEqual(posts[1].request_id,payload.request_id);assert.equal(fs.readFileSync(report,'utf8'),'blocked\n');}finally{release();}
}));

test('changed capacity preconditions can be reviewed without losing newer edits', {timeout:60000},()=>fixture(async({page,report,restart,store})=>{
 const base='one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\nthirteen\n';
 let response=page.waitForResponse(isPost);await edit(page,base);let first=await (await response).json();assert.equal(first.publication.state,'published');await page.getByText(/Markdown file saved/).waitFor();
 const blocked=base.replace('one','blocked'),newer=blocked.replace('five','newer'),external=base.replace('thirteen','external');
 response=page.waitForResponse(isPost);await edit(page,blocked);const capacityResponse=await response;const request=capacityResponse.request().postDataJSON();assert.equal((await capacityResponse.json()).publication.state,'capacity');await page.getByText(/Markdown was not saved/).first().waitFor();
 await edit(page,newer);fs.writeFileSync(report,external);await restart(3);
 response=page.waitForResponse(isPost);await page.getByRole('button',{name:'Retry exact original request'}).click();const retry=await response;assert.deepEqual(retry.request().postDataJSON(),request);assert.deepEqual((await retry.json()).publication.reasons,['capacity_retry_changed']);
 assert.equal(fs.readFileSync(report,'utf8'),external);const inspect=page.waitForResponse(r=>r.url().includes('/api/collaboration/recovery?'));await page.getByRole('button',{name:'Inspect original save'}).click();const inspection=await (await inspect).json();assert.equal(inspection.publication.state,'conflict');assert.deepEqual(inspection.publication.reasons,['capacity_retry_changed']);
 await page.getByRole('button',{name:'Continue after reviewing conflict'}).click();assert.equal(await page.locator('.CodeMirror').evaluate(e=>e.CodeMirror.getValue()),newer);
 assert.match(await page.getByLabel('Reviewed publication requests').inputValue(),new RegExp(request.request_id));
 response=page.waitForResponse(isPost);await page.getByRole('button',{name:'Submit editor as resolution'}).click();const continued=await (await response).json();assert.ok(['saved','merged','unchanged'].includes(continued.status),JSON.stringify(continued));assert.equal(continued.publication.state,'conflict');
 await page.getByRole('button',{name:'Preview merged report'}).waitFor();await page.getByRole('button',{name:'Preview merged report'}).click();const preview=await page.getByLabel('Merged shared report').inputValue();for(const word of ['blocked','newer','external'])assert.match(preview,new RegExp(word));
 const late=external.replace('nine','later');fs.writeFileSync(report,late);
 response=page.waitForResponse(isPost);await page.getByRole('button',{name:'Save merged report'}).click();const stale=await response;assert.equal(stale.status(),409);assert.equal((await stale.json()).error,'reconciliation_changed');assert.equal(fs.readFileSync(report,'utf8'),late);
 await page.getByRole('button',{name:'Preview merged report'}).waitFor();await page.getByRole('button',{name:'Preview merged report'}).click();const merged=await page.getByLabel('Merged shared report').inputValue();for(const word of ['blocked','newer','external','later'])assert.match(merged,new RegExp(word));
 response=page.waitForResponse(isPost);await page.getByRole('button',{name:'Save merged report'}).click();const saved=await (await response).json();assert.equal(saved.publication.state,'published');assert.equal(fs.readFileSync(report,'utf8'),merged);assert.equal(fs.readFileSync(path.join(store,'publication',first.publication.operation,'displaced'),'utf8'),'original\n');
 const current=await page.evaluate(async()=>{const url=performance.getEntriesByType('resource').map(x=>x.name).find(x=>x.includes('/api/collaboration?'));return (await fetch(url)).json();});assert.equal(current.content,merged);assert.ok(current.history.some(item=>item.kind==='client:merged'),JSON.stringify(current.history));
}));

for(const mode of ['inspect','poll failure','source unavailable','storage denial','storage changed']){
 test(`deferred retry is cancelled on ${mode}`, {timeout:35000},()=>fixture(async({page,report,restart})=>{
  const {payload}=await fillCapacity(page);await restart(2);
  let entered,release;const hit=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let held=false;const posts=[];
  await page.route('**/api/collaboration?*',async route=>{
   if(route.request().method()==='POST'){posts.push(route.request().postDataJSON());return route.continue();}
   if(!held){held=true;entered();await gate;if(mode==='poll failure')return route.fulfill({status:503,contentType:'application/json',body:'{}'});}
   return route.continue();
  });
  try{
   await hit;
   if(mode==='storage denial')await page.evaluate(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('bounty-board-report-draft-v2:'))throw new DOMException('quota','QuotaExceededError');return set.call(this,k,v);};});
   await page.getByRole('button',{name:'Retry exact original request'}).click();
   if(mode==='inspect')await page.getByRole('button',{name:'Inspect original save'}).click();
   if(mode==='source unavailable')fs.unlinkSync(report);
   if(mode==='storage changed')await page.evaluate(()=>{const k=Object.keys(localStorage).find(k=>k.startsWith('bounty-board-report-draft-v2:'));const v=JSON.parse(localStorage.getItem(k));v.pendingShared.request_id='different';localStorage.setItem(k,JSON.stringify(v));});
   release();await page.waitForTimeout(2500);assert.equal(posts.length,0);if(mode!=='source unavailable')assert.equal(fs.readFileSync(report,'utf8'),'first\n');
   if(mode==='inspect')await page.getByRole('button',{name:'Retry exact original request'}).waitFor();
   if(mode==='poll failure' || mode==='source unavailable')assert.match(await page.locator('#report-status').innerText(),/not sent|source unavailable/i);
   if(mode==='storage denial')assert.match(await page.locator('#report-status').innerText(),/storage unavailable/i);
   if(mode!=='storage changed'){const saved=await page.evaluate(()=>Object.values(localStorage).map(v=>{try{return JSON.parse(v)}catch{return null}}).find(v=>v?.pendingShared));assert.deepEqual(saved.pendingShared,payload);}
  }finally{release();}
 }));
}
