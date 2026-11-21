const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const root=path.resolve(__dirname,'..');
const fixture=()=>({root_identity:'a'.repeat(64),programs:[{id:'synthetic',name:'Synthetic',family:'Test',lanes:[{name:'Web',findings:[],coverage:[],reports:[{id:'r',path:'r.md',content:'Original',revision:'1'}],warnings:[]}]}]});
async function run(fn){
 const data=fixture();let source={content:'Original',revision:'1'},fail=false;const requests=[];
 const server=http.createServer((req,res)=>{requests.push([req.method,req.url]);if(req.method!=='GET'){res.writeHead(405);return res.end();}const p=new URL(req.url,'http://localhost').pathname;if(p==='/api/data'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(data));}if(p==='/api/report'){res.writeHead(fail?503:200,{'content-type':'application/json'});return res.end(JSON.stringify(source));}const file=path.join(root,p==='/'?'index.html':p.slice(1));if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}fs.readFile(file,(e,b)=>{if(e){res.writeHead(404);return res.end();}res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'text/plain');res.end(b);});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;let browser;
 try {browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome'});const context=await browser.newContext();const page=await context.newPage();page.setDefaultTimeout(2000);const external=[];await context.route('**/*',r=>r.request().url().startsWith(base+'/')?r.continue():(external.push(r.request().url()),r.abort()));const open=async()=>{await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();};await fn({page,data,base,open,setFailure:v=>fail=v,setSource:v=>source=v});assert.deepEqual(external,[]);assert.equal(requests.some(([method])=>method!=='GET'),false);assert.equal(requests.some(([,url])=>url.startsWith('/missing')),false);
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
}
async function edit(page,value){await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText(value);}

test('native keyboard previews never execute raw HTML or load images', {timeout:15000},()=>run(async({page,open})=>{await open();await edit(page,'<img src="/missing" onerror="window.pwned=1">\n\n![image](/missing-image)');await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+p');await page.locator('.editor-preview-active').waitFor();assert.equal(await page.locator('.editor-preview-active img').count(),0);assert.match(await page.locator('.editor-preview-active').innerText(),/<img/);await page.keyboard.press('Control+p');await page.locator('.editor-preview-active').waitFor({state:'hidden'});await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('F9');await page.locator('.editor-preview-active-side').waitFor();assert.equal(await page.locator('.editor-preview-active-side img').count(),0);assert.match(await page.locator('.editor-preview-active-side').innerText(),/<img/);assert.equal(await page.evaluate(()=>window.pwned),undefined);}));

test('switching directly from native preview to side-by-side works', {timeout:15000},()=>run(async({page,open})=>{await open();await edit(page,'Synthetic');await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+p');await page.locator('.editor-preview-active').waitFor();await page.keyboard.press('F9');await page.locator('.editor-preview-active-side').waitFor();assert.match(await page.locator('.editor-preview-active-side').innerText(),/Synthetic/);}));

test('unidentified root refresh keeps the in-memory draft visible', {timeout:15000},()=>run(async({page,data,open})=>{delete data.root_identity;await open();await edit(page,'Only in memory');await page.getByRole('button',{name:'Refresh'}).click();assert.match(await page.locator('.CodeMirror').innerText(),/Only in memory/);assert.match(await page.locator('#report-status').innerText(),/identity unavailable/i);}));

test('failed lazy source load exposes the persisted draft, not an invented empty source', {timeout:15000},()=>run(async({page,data,open,setFailure,setSource})=>{delete data.programs[0].lanes[0].reports[0].content;delete data.programs[0].lanes[0].reports[0].revision;setFailure(true);const key='bounty-board-report-draft-v2:'+JSON.stringify(['a'.repeat(64),'synthetic','Web','r']);await page.addInitScript(key=>localStorage.setItem(key,JSON.stringify({version:1,text:'Recovered draft',original:'previous source',revision:'old'})),key);await open();await page.getByText(/could not be loaded/i).waitFor();assert.match(await page.locator('.CodeMirror').innerText(),/Recovered draft/);assert.match(await page.locator('#report-status').innerText(),/source.*unavailable/i);await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');assert.equal(await page.locator('.CodeMirror').evaluate(el=>el.CodeMirror.getSelection()),'Recovered draft');setFailure(false);setSource({content:'changed source',revision:'new'});await page.getByRole('button',{name:'Refresh'}).click();await page.getByText(/^Conflict:/).waitFor();assert.match(await page.locator('.CodeMirror').innerText(),/Recovered draft/);}));

test('empty lazy source is distinct from failed source with no draft', {timeout:15000},()=>run(async({page,data,open,setFailure,setSource})=>{delete data.programs[0].lanes[0].reports[0].content;delete data.programs[0].lanes[0].reports[0].revision;setFailure(true);await open();await page.getByText(/could not be loaded/i).waitFor();assert.equal(await page.locator('.CodeMirror').count(),0);setFailure(false);setSource({content:'',revision:'empty'});await page.getByRole('button',{name:'Refresh'}).click();await page.locator('.CodeMirror').waitFor();assert.equal(await page.locator('#report-source').inputValue(),'');assert.equal(await page.getByText(/could not be loaded/i).count(),0);}));

test('source conflict and another-tab warning are both displayed', {timeout:15000},()=>run(async({page,data,open})=>{await open();await edit(page,'Draft');data.programs[0].lanes[0].reports[0].revision='2';data.programs[0].lanes[0].reports[0].content='Changed';await page.getByRole('button',{name:'Refresh'}).click();await page.getByText(/^Conflict:/).waitFor();await page.evaluate(()=>{const key=Object.keys(localStorage).find(k=>k.startsWith('bounty-board-report-draft-v2:'));window.dispatchEvent(new StorageEvent('storage',{key}));});const status=await page.locator('#report-status').innerText();assert.match(status,/Conflict:/);assert.match(status,/another tab/i);}));

test('revisionless source conflict stays visible when original content returns', {timeout:15000},()=>run(async({page,data,open})=>{const report=data.programs[0].lanes[0].reports[0];delete report.revision;await open();await edit(page,'Original');report.content='Changed';await page.getByRole('button',{name:'Refresh'}).click();await page.getByText(/^Conflict:/).waitFor();report.content='Original';await page.getByRole('button',{name:'Refresh'}).click();await page.getByText(/^Conflict:/).waitFor();}));

test('content change conflicts even when source revision is unchanged', {timeout:15000},()=>run(async({page,data,open})=>{const report=data.programs[0].lanes[0].reports[0];await open();await edit(page,'Draft');report.content='Changed';await page.getByRole('button',{name:'Refresh'}).click();await page.getByText(/^Conflict:/).waitFor();}));

test('visible source label focuses the keyboard editor', {timeout:15000},()=>run(async({page,open})=>{await open();await page.locator('label').filter({hasText:'Markdown source'}).click();assert.equal(await page.locator('.CodeMirror textarea').evaluate(el=>document.activeElement===el),true);}));


test('identified root storage failure blocks refresh and keeps the draft accessible', {timeout:15000},()=>run(async({page,data,open})=>{
  if(process.env.SYNTHETIC_BASELINE_ENTRY) await page.route('**/app.js',async route=>{const response=await route.fetch();let body=await response.text();for(const before of ['if(hasUnrecoverableDraft()) {blockRefresh();render();return;}','if(hasUnrecoverableDraft()) blockRefresh();']){assert.ok(body.includes(before));body=body.replace(before,before.replace('hasUnrecoverableDraft()','false'));}await route.fulfill({response,body});});
  await page.addInitScript(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('bounty-board-report-draft-v2:'))throw new DOMException('quota','QuotaExceededError');return set.call(this,key,value);};});
  await open();await edit(page,'Memory only');assert.match(await page.locator('#report-status').innerText(),/storage unavailable/i);
  await page.getByRole('button',{name:'Coverage',exact:true}).click();data.root_identity='b'.repeat(64);await page.getByRole('button',{name:'Refresh'}).click();
  await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);assert.match(await page.locator('#app').innerText(),/Refresh blocked/i);await page.getByRole('button',{name:'Reports',exact:true}).click();assert.match(await page.locator('.CodeMirror').innerText(),/Memory only/);
}));


test('conflict survives source reversion and browser reload', {timeout:15000},()=>run(async({page,data,open,base})=>{
  const report=data.programs[0].lanes[0].reports[0];await open();await edit(page,'Draft');report.content='Changed';report.revision='2';
  await page.getByRole('button',{name:'Refresh'}).click();await page.getByText(/^Conflict:/).waitFor();report.content='Original';report.revision='1';
  await page.getByRole('button',{name:'Refresh'}).click();await page.getByText(/^Conflict:/).waitFor();
  page.on('dialog',dialog=>dialog.accept());await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();
  assert.match(await page.locator('#report-status').innerText(),/^Conflict:/);assert.match(await page.locator('.CodeMirror').innerText(),/Draft/);
}));


test('lazy content reconciles an in-place report object after its revision was listed', {timeout:15000},()=>run(async({page,data,open,setSource})=>{
  await open();await edit(page,'Draft');const report=data.programs[0].lanes[0].reports[0];delete report.content;setSource({content:'Changed lazily',revision:'1'});
  await page.getByRole('button',{name:'Refresh'}).click();await page.locator('.CodeMirror').waitFor();
  assert.match(await page.locator('#report-status').innerText(),/^Conflict:/);assert.match(await page.locator('.CodeMirror').innerText(),/Draft/);
}));


test('another tab changing storage during refresh prevents a root switch', {timeout:15000},()=>run(async({page,data,open,base})=>{
  if(process.env.SYNTHETIC_BASELINE_REFRESH) await page.route('**/app.js',async route=>{const response=await route.fetch();const body=await response.text();const before='if(hasUnrecoverableDraft()) blockRefresh();';assert.ok(body.includes(before));await route.fulfill({response,body:body.replace(before,'if(false) blockRefresh();')});});
  await page.addInitScript(()=>window.addEventListener('storage',()=>{window.sawStorage=true;}));
  await open();await edit(page,'Tab A draft');const other=await page.context().newPage();await other.goto(base);
  let release,arrived;const gate=new Promise(r=>release=r),requested=new Promise(r=>arrived=r);
  await page.route('**/api/data',async route=>{arrived();await gate;await route.continue();});
  await page.getByRole('button',{name:'Refresh'}).click();await requested;data.root_identity='b'.repeat(64);
  const key=await other.evaluate(()=>Object.keys(localStorage).find(k=>k.startsWith('bounty-board-report-draft-v2:')));
  await other.evaluate(key=>localStorage.setItem(key,JSON.stringify({version:1,text:'Tab B draft',original:'Original',revision:'1'})),key);
  await page.waitForFunction(()=>window.sawStorage);release();
  await page.getByText(/Refresh blocked/i).waitFor();assert.match(await page.locator('.CodeMirror').innerText(),/Tab A draft/);
  assert.equal(JSON.parse(await other.evaluate(key=>localStorage.getItem(key),key)).text,'Tab B draft');await other.close();
}));


test('conflict persistence failure is reported without another edit', {timeout:15000},()=>run(async({page,data,open})=>{
  await page.addInitScript(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(window.failDraftWrite && key.startsWith('bounty-board-report-draft-v2:'))throw new DOMException('quota','QuotaExceededError');return set.call(this,key,value);};});
  await open();await edit(page,'Draft');await page.evaluate(()=>window.failDraftWrite=true);data.programs[0].lanes[0].reports[0].content='Changed';
  await page.getByRole('button',{name:'Refresh'}).click();await page.getByText(/^Conflict:/).waitFor();
  assert.match(await page.locator('#report-status').innerText(),/conflict warning could not be saved/i);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('bounty-board-report-draft-v2:')))).conflict),false);
  await page.getByRole('button',{name:'Refresh'}).click();await page.getByText(/Refresh blocked/i).waitFor();assert.match(await page.locator('.CodeMirror').innerText(),/Draft/);
}));

test('conflict persistence does not overwrite newer draft from another tab', {timeout:15000},()=>run(async({page,data,open,base})=>{
  await page.addInitScript(()=>window.addEventListener('storage',event=>event.stopImmediatePropagation()));
  await open();await edit(page,'Tab A draft');const other=await page.context().newPage();await other.goto(base);
  const key=await other.evaluate(()=>Object.keys(localStorage).find(k=>k.startsWith('bounty-board-report-draft-v2:')));const newer=JSON.stringify({version:1,text:'Tab B draft',original:'Original',revision:'1'});
  await other.evaluate(({key,newer})=>localStorage.setItem(key,newer),{key,newer});data.programs[0].lanes[0].reports[0].content='Changed';
  await page.getByRole('button',{name:'Refresh'}).click();await page.getByText(/^Conflict:/).waitFor();
  assert.match(await page.locator('#report-status').innerText(),/conflict warning may not be saved/i);assert.match(await page.locator('#report-status').innerText(),/another tab/i);
  assert.equal(await other.evaluate(key=>localStorage.getItem(key),key),newer);assert.match(await page.locator('.CodeMirror').innerText(),/Tab A draft/);await other.close();
}));


test('late cross-tab event after root switch exposes the original draft for recovery', {timeout:45000},()=>run(async({page,data,open,base})=>{
  page.setDefaultTimeout(10000);
  const report=data.programs[0].lanes[0].reports[0];
  report.id='r</textarea><img src="/missing-id" onerror="window.pwned=1">';
  const original='Draft A\n</textarea><img src="/missing-text" onerror="window.pwned=2">\n& exact';
  await page.addInitScript(()=>{
    window.heldEvents=[];
    window.addEventListener('storage',event=>{
      if(event.key?.startsWith('bounty-board-report-draft-v2:') && !window.delivering){
        window.heldEvents.push({key:event.key,oldValue:event.oldValue,newValue:event.newValue,url:event.url});
        event.stopImmediatePropagation();
      }
    });
    window.deliverHeld=()=>{window.delivering=true;for(const event of window.heldEvents)window.dispatchEvent(new StorageEvent('storage',event));window.delivering=false;};
  });
  await open();await edit(page,original);
  const other=await page.context().newPage();await other.goto(base);
  const key=await page.evaluate(()=>Object.keys(localStorage).find(k=>k.startsWith('bounty-board-report-draft-v2:')));
  await other.evaluate(key=>localStorage.setItem(key,JSON.stringify({version:1,text:'Other tab',original:'Original',revision:'1'})),key);
  await page.waitForFunction(()=>window.heldEvents.length===1);
  data.root_identity='b'.repeat(64);data.programs[0].lanes[0].reports[0].content='Root B source';
  await page.getByRole('button',{name:'Refresh'}).click();
  await page.waitForFunction(()=>document.querySelector('#report-source')?.value==='Root B source');
  await page.evaluate(()=>window.deliverHeld());
  const recovery=page.locator('#draft-recovery');
  await recovery.waitFor({state:'visible'});
  assert.match(await recovery.innerText(),/recovery/i);
  assert.match(await recovery.innerText(),new RegExp('a'.repeat(64)));
  assert.match(await recovery.innerText(),/synthetic/);assert.match(await recovery.innerText(),/Web/);
  assert.ok((await recovery.innerText()).includes(report.id));
  const text=recovery.getByRole('textbox',{name:'Recover draft text'});assert.equal(await text.inputValue(),original);
  await text.focus();await page.keyboard.press('Control+A');assert.equal(await text.evaluate(el=>el.value.slice(el.selectionStart,el.selectionEnd)),original);
  await page.getByRole('button',{name:'Dashboard',exact:true}).click();assert.equal(await page.locator('#breadcrumb').innerText(),'Dashboard');
  assert.equal(await text.inputValue(),original);
  const [download]=await Promise.all([page.waitForEvent('download',{timeout:10000}),recovery.getByRole('button',{name:'Download draft'}).click({timeout:10000,noWaitAfter:true})]);
  let bytes='';for await(const chunk of await download.createReadStream())bytes+=chunk.toString();assert.equal(bytes,original);
  assert.equal(await recovery.locator('img').count(),0);assert.equal(await page.evaluate(()=>window.pwned),undefined);
  assert.equal(JSON.parse(await other.evaluate(key=>localStorage.getItem(key),key)).text,'Other tab');await other.close();
}));


test('multiple memory-only drafts remain selectable during unrelated storage events', {timeout:15000},()=>run(async({page,data,open})=>{
  data.programs[0].id='p<img src="/missing-program" onerror="window.pwned=1">';
  const lane=data.programs[0].lanes[0];lane.name='L<img src="/missing-lane" onerror="window.pwned=1">';
  lane.reports.push({id:'second',content:'Second original',revision:'1'});
  await page.addInitScript(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('bounty-board-report-draft-v2:'))throw new DOMException('quota','QuotaExceededError');return set.call(this,key,value);};});
  await open();await edit(page,'First only in memory');
  await page.locator('#report-select').selectOption('second');await edit(page,'Second only in memory');
  await page.getByRole('button',{name:'Dashboard',exact:true}).click();
  const recovery=page.locator('#draft-recovery'),cards=recovery.locator('.recovery-draft');assert.equal(await cards.count(),2);
  assert.ok((await cards.nth(0).innerText()).includes(data.programs[0].id));assert.ok((await cards.nth(0).innerText()).includes(lane.name));
  assert.ok((await cards.nth(1).innerText()).includes('second'));assert.ok((await cards.nth(0).innerText()).includes('a'.repeat(64)));
  const first=cards.nth(0).getByRole('textbox',{name:'Recover draft text'}), second=cards.nth(1).getByRole('textbox',{name:'Recover draft text'});
  assert.equal(await first.inputValue(),'First only in memory');assert.equal(await second.inputValue(),'Second only in memory');
  await first.focus();await page.keyboard.press('Control+A');
  await page.evaluate(()=>window.dispatchEvent(new StorageEvent('storage',{key:'unrelated'})));
  assert.equal(await first.evaluate(el=>document.activeElement===el && el.value.slice(el.selectionStart,el.selectionEnd)==='First only in memory'),true);
  assert.equal(await recovery.locator('img').count(),0);assert.equal(await page.evaluate(()=>window.pwned),undefined);
  await page.getByRole('button',{name:'Refresh'}).click();await page.getByText(/Refresh blocked/i).waitFor();
  assert.equal(await cards.count(),2);assert.equal(await second.inputValue(),'Second only in memory');
  await page.setViewportSize({width:375,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
}));
