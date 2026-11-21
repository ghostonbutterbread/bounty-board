const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium}=require('playwright');

async function fixture(run,autosave=false) {
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'front-fixes-'));
  const root=path.join(tmp,'root'), report=path.join(root,'web_bounty/example/web/reports/example.md');
  fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'original\n');
  const proc=spawn('python3',['-B','-u','-c',"import sys,app; s=app.make_server(sys.argv[1],0,collaboration_dir=sys.argv[2],report_autosave=sys.argv[3]=='1'); print(s.server_port,flush=True); s.serve_forever()",root,path.join(tmp,'private'),autosave?'1':'0'],{cwd:tmp,env:{...process.env,PYTHONPATH:path.resolve(__dirname,'../..')},stdio:['ignore','pipe','pipe']});
  let stderr='';proc.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-12000);});
  let browser;
  try {
    const [chunk]=await withTimeout(once(proc.stdout,'data'),10000,'server startup');const base='http://127.0.0.1:'+Number(chunk.toString().trim());
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    await run({browser,base,report});
  } catch(error) {console.error('Synthetic server stderr (tail):',stderr);throw error;}
  finally {try {if(browser)await withTimeout(browser.close(),5000,'browser close');} finally {if(proc.exitCode===null&&proc.signalCode===null){const done=once(proc,'exit');proc.kill('SIGKILL');await withTimeout(done,5000,'server exit');}fs.rmSync(tmp,{recursive:true,force:true});}}
}
async function withTimeout(promise,ms,phase){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Timed out: ${phase}`)),ms);})]);}finally{clearTimeout(timer);}}
async function open(page,base){page.setDefaultTimeout(10000);await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();await page.getByText(/Shared draft ready/).waitFor();}

for(const failure of ['quota','cas','silent']) test(`recovery ${failure} failure keeps copyable text and never sends an undurable request`, {timeout:60000},()=>fixture(async({browser,base})=>{
  const context=await browser.newContext(),source=await context.newPage();await open(source,base);
  await source.route('**/api/collaboration?*',route=>route.request().method()==='POST'?route.abort():route.continue());
  await source.locator('.CodeMirror textarea').focus();await source.keyboard.press('Control+A');await source.keyboard.insertText('recovered text');
  await source.getByText(/Shared save failed/).waitFor();
  const sourceEntry=await source.evaluate(()=>Object.entries(localStorage).find(([k,v])=>k.startsWith('bounty-board-report-draft-v2:')&&JSON.parse(v).text==='recovered text'));
  assert.ok(JSON.parse(sourceEntry[1]).pendingShared);
  await source.close();
  const page=await context.newPage(),posts=[];await page.route('**/api/collaboration?*',route=>{if(route.request().method()==='POST')posts.push(route.request().postDataJSON());return route.continue();});
  await open(page,base);await page.getByRole('button',{name:'Find saved drafts'}).click();
  const card=page.locator('[data-recovery-candidate]').filter({hasText:'recovered text'});
  const destination=await page.evaluate(()=>Object.keys(localStorage).find(k=>k.startsWith('bounty-board-report-draft-v2:')&&k.endsWith(window.name.slice('bounty-board-tab:'.length))));
  const before=await page.evaluate(k=>localStorage.getItem(k),destination);
  assert.equal(JSON.parse(before).text,'original\n');
  await page.evaluate(({failure,destination})=>{
    const get=Storage.prototype.getItem,set=Storage.prototype.setItem;let reads=0;
    Storage.prototype.getItem=function(k){if(k===destination&&failure==='cas'&&++reads===2){set.call(this,k,'concurrent destination');}return get.call(this,k);};
    Storage.prototype.setItem=function(k,v){if(k===destination&&failure==='quota')throw new DOMException('quota','QuotaExceededError');if(k===destination&&failure==='silent')return;return set.call(this,k,v);};
  },{failure,destination});
  await card.getByRole('button',{name:'Recover this draft'}).click();
  await page.locator('#draft-recovery').waitFor({state:'visible'});
  assert.equal(await page.getByLabel('Recover draft text').inputValue(),'recovered text');
  assert.doesNotMatch(await card.getByRole('status').innerText(),/Recovered into this tab/);
  assert.equal(await page.evaluate(k=>localStorage.getItem(k),sourceEntry[0]),sourceEntry[1]);
  assert.equal(await page.evaluate(k=>localStorage.getItem(k),destination),failure==='cas'?'concurrent destination':before);
  await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('new editor text');
  assert.equal(await page.getByLabel('Recover draft text').inputValue(),'new editor text');
  assert.equal(await card.getByLabel('Saved draft (select and copy if recovery is unavailable)').inputValue(),'recovered text');
  assert.equal(await page.evaluate(k=>localStorage.getItem(k),sourceEntry[0]),sourceEntry[1]);
  await page.waitForTimeout(3000);
  assert.deepEqual(posts,[],'no shared request may be sent without durable pending payload');
}));

test('recovered conflict updates preview and status immediately and after a poll', {timeout:60000},()=>fixture(async({browser,base})=>{
  const context=await browser.newContext(),source=await context.newPage();await open(source,base);
  await source.route('**/api/collaboration?*',route=>route.request().method()==='POST'?route.abort():route.continue());
  await source.locator('.CodeMirror textarea').focus();await source.keyboard.press('Control+A');await source.keyboard.insertText('# Recovered conflict');
  await source.getByText(/Shared save failed/).waitFor();
  const key=await source.evaluate(()=>Object.keys(localStorage).find(k=>k.startsWith('bounty-board-report-draft-v2:')&&JSON.parse(localStorage.getItem(k)).text==='# Recovered conflict'));
  await source.evaluate(k=>{const saved=JSON.parse(localStorage.getItem(k));saved.conflict=true;saved.pendingShared=null;localStorage.setItem(k,JSON.stringify(saved));},key);
  await source.close();
  const page=await context.newPage(),posts=[];await page.route('**/api/collaboration?*',route=>{if(route.request().method()==='POST')posts.push(route.request().postDataJSON());return route.continue();});
  await open(page,base);await page.getByRole('button',{name:'Find saved drafts'}).click();
  const card=page.locator('[data-recovery-candidate]').filter({hasText:'Recovered conflict'});
  let release,arrive;const gate=new Promise(r=>release=r),started=new Promise(r=>arrive=r);let held=false;
  await page.route('**/api/collaboration?*',async route=>{if(route.request().method()!=='GET'||held)return route.continue();held=true;arrive();await gate;await route.continue();});
  await started;
  const response=page.waitForResponse(response=>response.url().includes('/api/collaboration?')&&response.request().method()==='GET',{timeout:30000}).catch(()=>null);
  try {
    await card.getByRole('button',{name:'Recover this draft'}).click();
    await card.getByText('Recovered into this tab; original saved draft retained.').waitFor();
    assert.equal(await page.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'# Recovered conflict');
    assert.equal(await page.locator('#report-preview h1').innerText(),'Recovered conflict');
    assert.match(await page.locator('#report-status').innerText(),/conflict/i);
    assert.doesNotMatch(await page.locator('#report-status').innerText(),/saving shared/i);
    await page.evaluate(()=>{window.beforePollHistory=document.querySelector('#collaboration-history summary');});
  } finally {release();await response;}
  assert.equal(await page.waitForFunction(()=>window.beforePollHistory && !window.beforePollHistory.isConnected).then(()=>true),true);
  await page.waitForFunction(()=>document.querySelector('#report-status')?.textContent.includes('Conflict:'));
  assert.equal(await page.locator('#report-preview h1').innerText(),'Recovered conflict');
  assert.match(await page.locator('#report-status').innerText(),/conflict/i);
  assert.doesNotMatch(await page.locator('#report-status').innerText(),/saving shared/i);
  assert.deepEqual(posts,[]);
}));

test('a newly created shared request is not sent when its persistence fails', {timeout:60000},()=>fixture(async({browser,base})=>{
 const context=await browser.newContext(),page=await context.newPage(),posts=[];
 await page.route('**/api/collaboration?*',route=>{if(route.request().method()==='POST')posts.push(route.request().postDataJSON());return route.continue();});
 await open(page,base);
 await page.evaluate(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('bounty-board-report-draft-v2:')&&JSON.parse(v).pendingShared)throw new DOMException('quota','QuotaExceededError');return set.call(this,k,v);};});
 await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('locally persisted edit');
 await page.locator('#draft-recovery').waitFor({state:'visible'});
 assert.equal(await page.getByLabel('Recover draft text').inputValue(),'locally persisted edit');
 const saved=await page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('bounty-board-report-draft-v2:')).map(([,v])=>JSON.parse(v)));
 assert.ok(saved.some(d=>d.text==='locally persisted edit'&&!d.pendingShared));
 await page.waitForTimeout(3000);assert.deepEqual(posts,[]);
}));

async function historyBurst({browser,base},injectFailure=false){
  let phase='setup';
  try {
  const context=await browser.newContext(),page=await context.newPage();
  const root=(await (await context.request.get(base+'/api/data')).json()).root_identity;
  const query=new URLSearchParams({family:'web_bounty',program:'example',lane:'web',path:'example.md',root_identity:root});
  const endpoint=base+'/api/collaboration?'+query;
  let head=await (await context.request.get(endpoint)).json();
  const post=async (content,id)=>{const r=await context.request.post(endpoint,{headers:{Origin:base,'X-Requested-With':'Bounty-Board'},data:{base:head.revision,content,request_id:id}});assert.equal(r.status(),200,await r.text());head=await r.json();};
  phase='initial submissions';
  for(let i=0;i<52;i++) await withTimeout(post(`initial ${i}\n`,`initial-${i}`),10000,`history: initial submission ${i}`);
  phase='open and load older history';
  await open(page,base);await page.getByText('Shared history and conflicts').click();
  await page.getByRole('button',{name:'Load older history'}).click();
  await page.getByText('source:initial',{exact:true}).waitFor();
  let release,arrive;const gate=new Promise(r=>release=r),started=new Promise(r=>arrive=r);
  let releaseBridge=()=>{};
  try {
    let held=false;const hold=async route=>{if(route.request().method()!=='GET'||held)return route.continue();held=true;arrive();await gate;await route.continue();};
    phase='initial poll barrier';
    // The intentionally held poll must survive fixture setup. Its native 10 s
    // AbortSignal would expire during slow sequential submissions, allowing a
    // later poll to consume a partial burst before the barrier is released.
    await page.evaluate(()=>{window.restorePollTimeout=AbortSignal.timeout;AbortSignal.timeout=()=>new AbortController().signal;});
    await page.route('**/api/collaboration?*',hold);await withTimeout(started,10000,'history: initial poll barrier');
    await page.evaluate(()=>{AbortSignal.timeout=window.restorePollTimeout;delete window.restorePollTimeout;});
    if(injectFailure)throw new Error('injected held-poll failure');
    phase='burst submissions';
    for(let i=0;i<100;i++) await withTimeout(post(`burst ${i}\n`,`burst-${i}`),10000,`history: burst submission ${i}`);
    phase='collect expected history';
    const latest=await (await context.request.get(endpoint)).json();
    const expected=[];let before;
    do {const q=new URLSearchParams(query);if(before)q.set('before',before);const result=await (await context.request.get(base+'/api/collaboration/history?'+q)).json();expected.push(...result.history.map(x=>x.id));before=result.next_before;} while(before);
    let arriveBridge;const bridgeGate=new Promise(r=>releaseBridge=r),bridgeStarted=new Promise(r=>arriveBridge=r);
    let bridgeHeld=false;await page.route('**/api/collaboration/history?*',async route=>{if(bridgeHeld)return route.continue();bridgeHeld=true;arriveBridge();await bridgeGate;await route.continue();});
    phase='bridge barrier';release();
    await withTimeout(bridgeStarted,10000,'history: bridge barrier');
    assert.match(await page.locator('#report-status').innerText(),/history is incomplete/i);
    releaseBridge();phase='history convergence';
    await page.waitForFunction(revision=>document.querySelector('#report-status')?.textContent.includes('Shared draft ready')&&document.querySelector('.CodeMirror')?.CodeMirror.getValue()==='burst 99\n',latest.revision);
    await page.waitForFunction(count=>document.querySelectorAll('#collaboration-history [data-version]').length>=count,expected.length,{timeout:12000});
    const ids=await page.locator('#collaboration-history [data-version]').evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.version)));
    assert.deepEqual(ids,expected);
  } finally {release();releaseBridge();}
  } catch(error) {throw new Error(`history phase: ${phase}: ${error.message}`,{cause:error});}
}
test('history bridges a 100-submission burst after older history is loaded', {timeout:120000},()=>fixture(historyBurst));
test('history fixture releases held requests and propagates failures', {timeout:60000},async()=>{
  await assert.rejects(fixture(args=>historyBurst(args,true)),/history phase: initial poll barrier: injected held-poll failure/);
});


test('old conflict resolved in another tab cannot remain actionable', {timeout:120000},()=>fixture(async({browser,base})=>{
  const context=await browser.newContext(),a=await context.newPage(),b=await context.newPage();
  const root=(await (await context.request.get(base+'/api/data')).json()).root_identity;
  const query=new URLSearchParams({family:'web_bounty',program:'example',lane:'web',path:'example.md',root_identity:root});
  const endpoint=base+'/api/collaboration?'+query;
  const initial=await (await context.request.get(endpoint)).json();
  const post=async payload=>{const r=await context.request.post(endpoint,{headers:{Origin:base,'X-Requested-With':'Bounty-Board'},data:payload});assert.equal(r.status(),200,await r.text());return r.json();};
  let head=await post({base:initial.revision,content:'head\n',request_id:'head'});
  const conflict=await post({base:initial.revision,content:'conflicting\n',request_id:'conflict'});
  assert.equal(conflict.status,'conflict');
  for(let i=0;i<52;i++)head=await post({base:head.revision,content:`edit ${i}\n`,request_id:`edit-${i}`});
  await Promise.all([open(a,base),open(b,base)]);
  for(const page of [a,b]) {await page.getByText('Shared history and conflicts').evaluate(el=>el.click());await page.getByRole('button',{name:'Load older history'}).click({force:true});await page.getByRole('button',{name:`Resolve conflict ${conflict.conflict_id} with editor`}).waitFor();}
  let releasePoll,arrivePoll;const gate=new Promise(r=>releasePoll=r),started=new Promise(r=>arrivePoll=r);let held=false;const posts=[];
  await b.route('**/api/collaboration?*',async route=>{
    if(route.request().method()==='POST'){posts.push(route.request().postDataJSON());return route.continue();}
    if(held)return route.continue();held=true;arrivePoll();await gate;return route.continue();
  });
  try {
    await withTimeout(started,10000,'resolution: poll barrier');
    const button=b.getByRole('button',{name:`Resolve conflict ${conflict.conflict_id} with editor`});
    await button.click();await b.waitForTimeout(1000);
    assert.doesNotMatch(await b.locator('#report-status').innerText(),/Shared draft ready/);
  } finally {releasePoll();}
  await b.waitForFunction(()=>document.querySelector('#report-status')?.textContent.includes('Shared draft ready'),null,{timeout:10000});
  assert.equal(posts.length,1,'resolution must be sent exactly once after poll');
  assert.equal(posts[0].conflict_id,conflict.conflict_id);
  const cached=a.getByRole('button',{name:`Resolve conflict ${conflict.conflict_id} with editor`});
  await a.waitForFunction(id=>document.querySelector(`[data-conflict="${id}"]`)?.disabled,conflict.conflict_id,{timeout:10000});
  assert.equal(await cached.isDisabled(),true);
  await a.getByRole('button',{name:`Refresh conflict ${conflict.conflict_id} status`}).click({force:true});
  const row=a.locator('.record').filter({has:a.locator(`[data-version="${conflict.conflict_id}"]`)});
  await a.waitForFunction(id=>{const row=document.querySelector(`[data-version="${id}"]`)?.closest('.record');return row?.textContent.includes('(resolved)');},conflict.conflict_id);
  assert.equal(await a.getByRole('button',{name:`Resolve conflict ${conflict.conflict_id} with editor`}).count(),0);
}));


test('conflict resolution waits visibly for an ordinary in-flight save', {timeout:30000},()=>fixture(async({browser,base})=>{
  const context=await browser.newContext(),{conflict}=await recentConflict(context,base),page=await context.newPage();await open(page,base);
  await page.getByText('Shared history and conflicts').click();
  let release,arrive;const gate=new Promise(r=>release=r),started=new Promise(r=>arrive=r),posts=[];let held=false;
  await page.route('**/api/collaboration?*',async route=>{if(route.request().method()!=='POST')return route.continue();posts.push(route.request().postDataJSON());if(!held){held=true;arrive();await gate;}return route.continue();});
  try {
    await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('ordinary edit\n');
    await withTimeout(started,10000,'ordinary save');
    const button=page.getByRole('button',{name:`Resolve conflict ${conflict.conflict_id} with editor`});
    assert.equal(await button.isDisabled(),true,'resolution must not look actionable during an ordinary save');
    assert.match(await page.locator('#collaboration-history').innerText(),/wait.*current save/i);
  } finally {release();}
  const button=page.getByRole('button',{name:`Resolve conflict ${conflict.conflict_id} with editor`});
  await button.waitFor();await page.waitForFunction(id=>!document.querySelector(`[data-conflict="${id}"]`)?.disabled,conflict.conflict_id);
  await button.click();
  await page.waitForFunction(id=>!document.querySelector(`[data-conflict="${id}"]`),conflict.conflict_id,{timeout:12000});
  assert.equal(posts.filter(p=>p.conflict_id===conflict.conflict_id).length,1);
}));

test('autosave stale resolution inspects and explicitly continues without losing its causal base', {timeout:45000},()=>fixture(async({browser,base})=>{
  const context=await browser.newContext(),{head,conflict,post}=await recentConflict(context,base),page=await context.newPage(),posts=[];await open(page,base);
  await page.getByText('Shared history and conflicts').click();const button=page.getByRole('button',{name:`Resolve conflict ${conflict.conflict_id} with editor`});await button.waitFor();
  let release,arrive;const gate=new Promise(r=>release=r),started=new Promise(r=>arrive=r);let held=false;
  await page.route('**/api/collaboration?*',async route=>{if(route.request().method()==='POST'){posts.push(route.request().postDataJSON());return route.continue();}if(held)return route.continue();held=true;arrive();await gate;return route.continue();});
  let staleResponse;
  try {
    await withTimeout(started,10000,'stale autosave held poll');await button.click();
    staleResponse=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/api/collaboration?'));
    await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('later local\n');
    const resolved=await post({base:head.revision,content:'other resolution\n',request_id:'external-resolve',conflict_id:conflict.conflict_id});assert.notEqual(resolved.status,'conflict');
  } finally {release();}
  assert.equal((await staleResponse).status(),409);await page.getByText(/Save outcome unconfirmed/).waitFor();assert.equal(posts.length,1);
  const original=posts[0];assert.equal(original.base,head.revision);assert.equal(original.conflict_id,conflict.conflict_id);
  await page.reload();await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();
  await page.getByRole('button',{name:'Inspect original save'}).waitFor();assert.equal(await page.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'later local\n');
  await page.getByRole('button',{name:'Inspect original save'}).click();await page.getByRole('button',{name:'Retry exact original request'}).waitFor();
  const retry=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/api/collaboration?'));
  await page.getByRole('button',{name:'Retry exact original request'}).click();assert.equal((await retry).status(),409);assert.deepEqual(posts[1],original);
  await page.getByRole('button',{name:'Inspect original save'}).click();
  await page.getByRole('button',{name:'Continue as a new edit after review'}).waitFor();
  assert.equal(posts.length,2);
  const continued=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/api/collaboration?'));
  await page.getByRole('button',{name:'Continue as a new edit after review'}).click();
  const continuedBody=await (await continued).json();assert.equal(continuedBody.status,'conflict');
  assert.equal(posts[2].base,original.base);assert.equal(posts[2].content,'later local\n');assert.equal(posts[2].conflict_id,undefined);assert.notEqual(posts[2].request_id,original.request_id);
  await page.getByText('Reviewed publication requests').click();const reviewed=JSON.parse(await page.getByLabel('Reviewed publication requests').inputValue());assert.deepEqual(reviewed.at(-1).request,original);
  assert.match(await page.locator('#report-status').innerText(),/earlier resolution outcome remains unconfirmed/i);
},true));

for(const mode of ['network-unknown','committed-409'])test(`resolution recovery distinguishes ${mode} from an unobserved rejection`,{timeout:30000},()=>fixture(async({browser,base})=>{
  const context=await browser.newContext(),{conflict}=await recentConflict(context,base),page=await context.newPage(),posts=[];await open(page,base);
  await page.getByText('Shared history and conflicts').click();
  let original;
  await page.route('**/api/collaboration?*',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    original=route.request().postDataJSON();posts.push(original);
    if(mode==='network-unknown')return route.abort();
    const response=await route.fetch();assert.equal(response.status(),200);return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'invalid_or_conflicting_request'})});
  });
  await page.getByRole('button',{name:`Resolve conflict ${conflict.conflict_id} with editor`}).click();
  await page.waitForFunction(()=>document.querySelector('#report-status')?.textContent.includes('Save outcome unconfirmed'));
  const inspection=page.waitForResponse(r=>r.url().includes('/api/collaboration/recovery?'));
  await page.getByRole('button',{name:'Inspect original save'}).click();const result=await inspection;
  assert.equal(result.status(),mode==='network-unknown'?404:200);
  if(mode==='network-unknown'){
    await page.getByRole('button',{name:'Retry exact original request'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Continue as a new edit after review'}).count(),0);
    assert.deepEqual(JSON.parse(await page.getByLabel('Original pending request').inputValue()),original);
  } else {
    const receipt=await result.json();assert.equal(receipt.store_saved,true);assert.equal(await page.getByRole('button',{name:'Continue as a new edit after review'}).count(),0);
  }
  assert.equal(posts.length,1);
},true));

test('resolution continuation storage denial retains original and sends nothing new',{timeout:30000},()=>fixture(async({browser,base})=>{
  const context=await browser.newContext(),{conflict}=await recentConflict(context,base),page=await context.newPage(),posts=[];await open(page,base);
  await page.getByText('Shared history and conflicts').click();
  await page.route('**/api/collaboration?*',route=>{if(route.request().method()!=='POST')return route.continue();posts.push(route.request().postDataJSON());return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'invalid_or_conflicting_request'})});});
  await page.getByRole('button',{name:`Resolve conflict ${conflict.conflict_id} with editor`}).click();
  await page.waitForFunction(()=>document.querySelector('#report-status')?.textContent.includes('Save outcome unconfirmed'));
  await page.getByRole('button',{name:'Inspect original save'}).click();await page.getByRole('button',{name:'Continue as a new edit after review'}).waitFor();
  await page.evaluate(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('bounty-board-report-draft-v2:'))throw new DOMException('quota','QuotaExceededError');return set.call(this,k,v);};});
  await page.getByRole('button',{name:'Continue as a new edit after review'}).click();
  await page.getByText(/storage unavailable/i).first().waitFor();await page.waitForTimeout(1000);
  assert.equal(posts.length,1);assert.deepEqual(JSON.parse(await page.getByLabel('Original pending request').inputValue()),posts[0]);
  assert.equal(await page.getByLabel('Recover draft text').inputValue(),'reviewed head\n');
},true));

async function recentConflict(context,base){
  const root=(await (await context.request.get(base+'/api/data')).json()).root_identity;
  const query=new URLSearchParams({family:'web_bounty',program:'example',lane:'web',path:'example.md',root_identity:root});
  const endpoint=base+'/api/collaboration?'+query,initial=await (await context.request.get(endpoint)).json();
  async function post(payload){const response=await context.request.post(endpoint,{headers:{Origin:base,'X-Requested-With':'Bounty-Board'},data:payload});assert.equal(response.status(),200,await response.text());return response.json();}
  const head=await post({base:initial.revision,content:'reviewed head\n',request_id:'setup-head'});
  const conflict=await post({base:initial.revision,content:'other edit\n',request_id:'setup-conflict'});
  assert.equal(conflict.status,'conflict');return {endpoint,head,conflict,post};
}

for(const failure of [false,true])test(`resolution survives a ${failure?'failed':'successful'} held poll, repeat clicks and later edits`,{timeout:45000},()=>fixture(async({browser,base})=>{
  const context=await browser.newContext(),{head,conflict}=await recentConflict(context,base),page=await context.newPage();await open(page,base);
  await page.getByText('Shared history and conflicts').click();
  const button=page.getByRole('button',{name:`Resolve conflict ${conflict.conflict_id} with editor`});await button.waitFor();
  let release,arrive;const gate=new Promise(r=>release=r),started=new Promise(r=>arrive=r),posts=[];let held=false;
  await page.route('**/api/collaboration?*',async route=>{if(route.request().method()==='POST'){posts.push(route.request().postDataJSON());return route.continue();}if(held)return route.continue();held=true;arrive();await gate;return failure?route.abort():route.continue();});
  try {
    await withTimeout(started,10000,'resolution held poll');await button.click();await button.click();
    const saved=await page.evaluate(()=>Object.values(localStorage).map(x=>{try{return JSON.parse(x)}catch{return null}}).find(x=>x?.pendingShared));
    assert.ok(saved,'resolution intent must be durable before the poll completes');assert.equal(saved.hasDraft,true);assert.equal(saved.pendingShared.base,head.revision);assert.equal(saved.pendingShared.conflict_id,conflict.conflict_id);assert.equal(saved.pendingShared.content,'reviewed head\n');
    await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('later edit\n');
    await page.waitForTimeout(700);assert.equal(posts.length,0);assert.equal(await page.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'later edit\n');
  } finally {release();}
  await page.waitForFunction(()=>document.querySelector('#report-status')?.textContent.includes('Shared draft ready'),null,{timeout:12000});
  assert.equal(posts.filter(p=>p.conflict_id===conflict.conflict_id).length,1);assert.equal(posts[0].content,'reviewed head\n');assert.equal(posts[0].base,head.revision);assert.equal(posts.at(-1).content,'later edit\n');
  assert.equal(await page.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'later edit\n');
}));

test('resolution storage failure preserves copyable text and never sends', {timeout:30000},()=>fixture(async({browser,base})=>{
  const context=await browser.newContext(),{conflict}=await recentConflict(context,base),page=await context.newPage(),posts=[];await open(page,base);
  await page.getByText('Shared history and conflicts').click();
  const button=page.getByRole('button',{name:`Resolve conflict ${conflict.conflict_id} with editor`});await button.waitFor();
  let release,arrive;const gate=new Promise(r=>release=r),started=new Promise(r=>arrive=r);let held=false;
  await page.route('**/api/collaboration?*',async route=>{if(route.request().method()==='POST'){posts.push(route.request().postDataJSON());return route.continue();}if(held)return route.continue();held=true;arrive();await gate;return route.continue();});
  try {await withTimeout(started,10000,'storage held poll');await page.evaluate(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('bounty-board-report-draft-v2:'))throw new DOMException('quota','QuotaExceededError');return set.call(this,k,v);};});await button.click();
    assert.equal(await page.getByLabel('Recover draft text').inputValue(),'reviewed head\n');
  } finally {release();}
  await page.waitForTimeout(1500);assert.deepEqual(posts,[]);assert.match(await page.locator('#report-status').innerText(),/storage unavailable/i);
}));


test('stale held-poll resolution preserves both the reviewed submission and later editor text', {timeout:30000},()=>fixture(async({browser,base})=>{
  const context=await browser.newContext(),{head,conflict,post}=await recentConflict(context,base),page=await context.newPage(),posts=[];await open(page,base);
  await page.getByText('Shared history and conflicts').click();const button=page.getByRole('button',{name:`Resolve conflict ${conflict.conflict_id} with editor`});await button.waitFor();
  let release,arrive;const gate=new Promise(r=>release=r),started=new Promise(r=>arrive=r);let held=false;
  await page.route('**/api/collaboration?*',async route=>{if(route.request().method()==='POST'){posts.push(route.request().postDataJSON());return route.continue();}if(held)return route.continue();held=true;arrive();await gate;return route.continue();});
  try {await withTimeout(started,10000,'stale resolution held poll');await button.click();await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('later local\n');
    const advanced=await post({base:head.revision,content:'other head\n',request_id:'advance-head'});assert.equal(advanced.status,'saved');
  } finally {release();}
  await page.waitForFunction(()=>document.querySelector('#report-status')?.textContent.includes('stale resolution'),null,{timeout:10000});
  const saved=await page.evaluate(()=>Object.values(localStorage).map(x=>{try{return JSON.parse(x)}catch{return null}}).find(x=>x?.staleResolution));
  assert.equal(saved.text,'later local\n');assert.deepEqual(saved.rejectedResolutions,[posts[0]]);
  assert.equal(await page.getByLabel('Rejected resolution requests').inputValue(),JSON.stringify([posts[0]],null,2));
  assert.equal(posts.length,1);assert.equal(await page.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'later local\n');
}));


test('reopen discovers orphan and replays the exact pending request before newer text', {timeout:60000},()=>fixture(async({browser,base})=>{
  const context=await browser.newContext(),a=await context.newPage();await open(a,base);
  let first,notify;const committed=new Promise(r=>notify=r);
  await a.route('**/api/collaboration?*',async route=>{if(route.request().method()!=='POST')return route.continue();first=route.request().postDataJSON();await route.fetch();notify();await route.abort();});
  await a.locator('.CodeMirror textarea').focus();await a.keyboard.press('Control+A');await a.keyboard.insertText('pending exact');await committed;
  await a.getByText(/Shared save failed/).waitFor();
  await a.locator('.CodeMirror textarea').focus();await a.keyboard.press('Control+A');await a.keyboard.insertText('newer unsent');
  await a.close();
  const b=await context.newPage(),replay=[];
  await b.route('**/api/collaboration?*',route=>{if(route.request().method()==='POST')replay.push(route.request().postDataJSON());return route.continue();});
  await open(b,base);
  await b.getByRole('button',{name:'Find saved drafts'}).click();
  const candidate=b.locator('[data-recovery-candidate]').filter({hasText:'newer unsent'});
  await candidate.getByRole('button',{name:'Recover this draft'}).click();
  await b.waitForFunction(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()==='newer unsent');
  await b.getByText(/Shared draft ready/).waitFor({timeout:12000});
  assert.deepEqual(replay[0],first);
  assert.equal((await b.evaluate(()=>Object.values(localStorage).map(x=>{try{return JSON.parse(x).text}catch{return null}}))).includes('newer unsent'),true);
}));


test('multiple saved drafts and live tab survive navigation and lockless copy fallback', {timeout:90000},()=>fixture(async({browser,base})=>{
  const context=await browser.newContext(),a=await context.newPage(),b=await context.newPage(),live=await context.newPage();
  for(const page of [a,b,live]) {await open(page,base);await page.route('**/api/collaboration?*',route=>route.request().method()==='POST'?route.abort():route.continue());}
  async function edit(page,text){await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText(text);await page.getByText(/Shared save failed/).waitFor();}
  await edit(a,'orphan one');await edit(b,'orphan two');await edit(live,'active draft');
  const saved=await live.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('bounty-board-report-draft-v2:'))));
  await a.goto(base);await b.close();
  await a.getByRole('button',{name:'Programs',exact:true}).click();await a.getByRole('button',{name:'Reports',exact:true}).click();await a.getByText(/Shared draft ready/).waitFor();
  await a.getByRole('button',{name:'Find saved drafts'}).click();
  for(const text of ['orphan one','orphan two','active draft'])await a.locator('[data-recovery-candidate]').filter({hasText:text}).waitFor();
  const liveCard=a.locator('[data-recovery-candidate]').filter({hasText:'active draft'});
  await liveCard.getByRole('button',{name:'Recover this draft'}).click();await liveCard.getByText(/belongs to a live tab/).waitFor();
  assert.equal(await live.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'active draft');
  for(const [key,value] of Object.entries(saved))assert.equal(await live.evaluate(k=>localStorage.getItem(k),key),value);
  const lockless=await context.newPage();await lockless.addInitScript(()=>Object.defineProperty(navigator,'locks',{value:undefined}));await open(lockless,base);
  await lockless.getByRole('button',{name:'Find saved drafts'}).click();
  const fallback=lockless.locator('[data-recovery-candidate]').filter({hasText:'orphan two'});
  await fallback.getByRole('button',{name:'Recover this draft'}).click();await fallback.getByText(/Select and copy the draft text/).waitFor();
  assert.equal(await fallback.getByLabel('Saved draft (select and copy if recovery is unavailable)').inputValue(),'orphan two');
  assert.ok(JSON.parse(await fallback.getByLabel('Pending request (copy for manual recovery if needed)').inputValue()).request_id);
  for(const [key,value] of Object.entries(saved))assert.equal(await live.evaluate(k=>localStorage.getItem(k),key),value);
  await lockless.route('**/api/collaboration?*',route=>route.request().method()==='POST'?route.abort():route.continue());
  await edit(lockless,'active without locks');
  await a.getByRole('button',{name:'Find saved drafts'}).click();
  const locklessLive=a.locator('[data-recovery-candidate]').filter({hasText:'active without locks'});
  await locklessLive.getByRole('button',{name:'Recover this draft'}).click();
  await locklessLive.getByText(/older or lockless draft cannot be safely claimed/).waitFor();
  assert.equal(await lockless.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'active without locks');
}));

test('a cloned reload cannot claim a live lockless namespace', {timeout:60000},()=>fixture(async({browser,base})=>{
  const context=await browser.newContext(),a=await context.newPage();
  await a.addInitScript(()=>Object.defineProperty(navigator,'locks',{value:undefined}));await open(a,base);
  await a.route('**/api/collaboration?*',route=>route.request().method()==='POST'?route.abort():route.continue());
  await a.locator('.CodeMirror textarea').focus();await a.keyboard.press('Control+A');await a.keyboard.insertText('live lockless');
  await a.getByText(/Shared save failed/).waitFor();
  const inherited=await a.evaluate(()=>window.name);
  const b=await context.newPage();await b.addInitScript(name=>{window.name=name;const original=performance.getEntriesByType.bind(performance);performance.getEntriesByType=type=>type==='navigation'?[{type:'reload'}]:original(type);},inherited);
  await b.route('**/api/collaboration?*',route=>route.request().method()==='POST'?route.abort():route.continue());
  await b.goto(base);await b.getByRole('button',{name:'Programs',exact:true}).click();await b.getByRole('button',{name:'Reports',exact:true}).click();await b.locator('.CodeMirror').waitFor();
  assert.notEqual(await b.evaluate(()=>window.name),inherited,'live lockless namespace must not be reused by a cloned reload');
  assert.equal(await a.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'live lockless');
}));
