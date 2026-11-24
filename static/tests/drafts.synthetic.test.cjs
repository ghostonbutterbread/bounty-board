const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {chromium} = require('playwright');

// The theme switcher is a menu button; filters are multi-select popovers.
async function setTheme(page,name){await page.getByRole('button',{name:'Theme',exact:true}).click();await page.getByRole('menuitemradio',{name:name[0].toUpperCase()+name.slice(1),exact:true}).click();}
async function pickFilter(page,plural,value){await page.getByRole('button',{name:`Filter ${plural}`,exact:true}).click();await page.getByRole('checkbox',{name:value}).check();await page.keyboard.press('Escape');}

// All backend input and output is inside this newly created disposable root.
test('real EasyMDE saves a browser draft across reload without writing the source', {timeout:30000}, async () => {
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR || '/home/ryushe/.hermes/cache/scratch','board-draft-synthetic-'));
  const reports=path.join(tmp,'web_bounty','fictional','web','reports');
  fs.mkdirSync(reports,{recursive:true});
  const file=path.join(reports,'example.md'); fs.writeFileSync(file,'# Original synthetic report');
  const second=path.join(reports,'other.md'); fs.writeFileSync(second,'# Other synthetic report');
  const otherLane=path.join(tmp,'web_bounty','fictional','api','reports');fs.mkdirSync(otherLane,{recursive:true});fs.writeFileSync(path.join(otherLane,'example.md'),'# Other lane');
  const otherProgram=path.join(tmp,'web_bounty','different','web','reports');fs.mkdirSync(otherProgram,{recursive:true});fs.writeFileSync(path.join(otherProgram,'example.md'),'# Other program');
  const code='import sys, app; s=app.make_server(sys.argv[1],0); print(s.server_port,flush=True); s.serve_forever()';
  const proc=spawn('python3',['-B','-u','-c',code,tmp],{cwd:path.resolve(__dirname,'../..'),stdio:['ignore','pipe','pipe'],env:{...process.env,TMPDIR:tmp}});
  let browser;
  try {
    const [chunk]=await Promise.race([once(proc.stdout,'data'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('startup timeout')),5000))]);
    const base=`http://127.0.0.1:${Number(chunk.toString().trim())}`;
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN || '/usr/bin/google-chrome'});
    const page=await browser.newPage();page.setDefaultTimeout(4000);page.on('dialog',dialog=>dialog.accept());const external=[];const writes=[];
    await page.route('**/*',route=>route.request().url().startsWith(base+'/') ? route.continue() : route.abort());
    page.on('request',r=>{if(!r.url().startsWith(base+'/')) external.push(r.url()); if(!['GET','HEAD'].includes(r.method())) writes.push(r.url());});
    const open=async()=>{await page.getByRole('link',{name:'Programs',exact:true}).click();await page.getByLabel('Program').selectOption('web_bounty/fictional');await page.getByLabel('Lane').selectOption('web');await page.getByRole('link',{name:'Reports',exact:true}).click();await page.locator('.CodeMirror').waitFor();};
    await page.goto(base);await open();
    const editor=page.locator('.CodeMirror textarea');await editor.focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('# Synthetic edited draft');
    await page.waitForFunction(()=>document.querySelector('#report-status')?.textContent.includes('browser'));
    await page.reload();await open();
    assert.match(await page.locator('.CodeMirror').innerText(),/Synthetic edited draft/);
    assert.equal(await page.getByRole('textbox',{name:'Markdown source'}).count(),1);
    assert.equal(await page.getByRole('button',{name:'Save to report unavailable'}).isDisabled(),true);
    assert.match(await page.locator('#app').innerText(),/Older unscoped drafts/);
    await page.getByLabel('Lane').selectOption('api');await page.locator('.CodeMirror').waitFor();
    assert.match(await page.locator('.CodeMirror').innerText(),/Other lane/);
    await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('API draft');
    await page.getByLabel('Program').selectOption('web_bounty/different');await page.locator('.CodeMirror').waitFor();
    assert.match(await page.locator('.CodeMirror').innerText(),/Other program/);
    await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('Different program draft');
    await page.getByLabel('Program').selectOption('web_bounty/fictional');await page.getByLabel('Lane').selectOption('api');await page.locator('.CodeMirror').waitFor();
    assert.match(await page.locator('.CodeMirror').innerText(),/API draft/);
    await page.getByLabel('Lane').selectOption('web');await page.locator('.CodeMirror').waitFor();
    assert.match(await page.locator('.CodeMirror').innerText(),/Synthetic edited draft/);
    await page.locator('#report-select').selectOption('other.md');
    await page.locator('.CodeMirror').waitFor();
    await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('');
    await page.keyboard.press('Backspace');
    await page.getByRole('link',{name:'Coverage',exact:true}).click();await page.getByRole('link',{name:'Reports',exact:true}).click();
    assert.equal(await page.locator('#report-source').inputValue(),'');
    await page.locator('#report-select').selectOption('example.md');
    await page.locator('.CodeMirror').waitFor();
    assert.match(await page.locator('.CodeMirror').innerText(),/Synthetic edited draft/);
    fs.writeFileSync(file,'# Changed synthetic source');
    await page.getByRole('button',{name:'Refresh'}).click();
    await page.getByText(/^Conflict:/).waitFor();
    assert.match(await page.locator('.CodeMirror').innerText(),/Synthetic edited draft/);
    await page.reload();await open();await page.getByText(/^Conflict:/).waitFor();
    assert.match(await page.locator('.CodeMirror').innerText(),/Synthetic edited draft/);
    await page.locator('#report-select').selectOption('other.md');await page.locator('.CodeMirror').waitFor();
    assert.equal(await page.locator('#report-source').inputValue(),'');
    await page.locator('.CodeMirror textarea').focus();await page.keyboard.insertText('<img src="https://bad.invalid/a" onerror="window.pwned=1"> ![x](https://bad.invalid/b)');
    assert.equal(await page.locator('#report-preview img').count(),0);assert.equal(await page.evaluate(()=>window.pwned),undefined);
    await page.setViewportSize({width:375,height:800});
    for(const theme of ['light','dark','dusk']) {
      await setTheme(page,theme);
      assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.CodeMirror')).backgroundColor),await page.evaluate(()=>getComputedStyle(document.querySelector('.panel')).backgroundColor),theme);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,theme);
    }
    assert.equal(fs.readFileSync(file,'utf8'),'# Changed synthetic source');assert.equal(fs.readFileSync(second,'utf8'),'# Other synthetic report');
    assert.deepEqual(writes,[]);assert.deepEqual(external,[]);
    const bad=await browser.newPage();bad.setDefaultTimeout(4000);
    await bad.route('**/*',route=>route.request().url().startsWith(base+'/') ? route.continue() : route.abort());
    const identity=await page.evaluate(async()=> (await (await fetch('/api/data')).json()).root_identity);
    const key='bounty-board-report-draft-v2:'+JSON.stringify([identity,'web_bounty/fictional','web','example.md']);
    await bad.addInitScript(key=>localStorage.setItem(key,'{invalid'),key);
    await bad.goto(base);await bad.getByRole('link',{name:'Programs',exact:true}).click();await bad.getByLabel('Program').selectOption('web_bounty/fictional');await bad.getByLabel('Lane').selectOption('web');await bad.getByRole('link',{name:'Reports',exact:true}).click();
    await bad.getByText(/Browser draft data is invalid/).waitFor();
    await bad.locator('.CodeMirror textarea').focus();await bad.keyboard.insertText(' attempted edit');
    assert.equal(await bad.evaluate(key=>localStorage.getItem(key),key),'{invalid');
    assert.match(await bad.locator('#report-status').innerText(),/not overwritten/);
    await bad.close();
    const fail=await browser.newPage();fail.setDefaultTimeout(4000);
    await fail.route('**/*',route=>route.request().url().startsWith(base+'/') ? route.continue() : route.abort());
    await fail.addInitScript(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('bounty-board-report-draft-v2:'))throw new DOMException('quota','QuotaExceededError');return set.call(this,key,value);};});
    await fail.goto(base);await fail.getByRole('link',{name:'Programs',exact:true}).click();await fail.getByRole('link',{name:'Reports',exact:true}).click();
    await fail.locator('.CodeMirror textarea').focus();await fail.keyboard.insertText(' unsaved');
    assert.match(await fail.locator('#report-status').innerText(),/storage unavailable/i);
    assert.equal(await fail.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;}),true);
    await fail.close();
    const readFail=await browser.newPage();readFail.setDefaultTimeout(4000);
    await readFail.route('**/*',route=>route.request().url().startsWith(base+'/') ? route.continue() : route.abort());
    await readFail.addInitScript(()=>{const get=Storage.prototype.getItem;Storage.prototype.getItem=function(key){if(key.startsWith('bounty-board-report-draft-v2:'))throw new DOMException('blocked','SecurityError');return get.call(this,key);};});
    await readFail.goto(base);await readFail.getByRole('link',{name:'Programs',exact:true}).click();await readFail.getByRole('link',{name:'Reports',exact:true}).click();
    await readFail.locator('.CodeMirror textarea').focus();await readFail.keyboard.insertText(' must not overwrite');
    assert.match(await readFail.locator('#report-status').innerText(),/storage unavailable/i);
    assert.equal(await readFail.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('bounty-board-report-draft-v2:')).length),0);
    await readFail.close();
    const conflictFail=await browser.newPage();conflictFail.setDefaultTimeout(4000);
    await conflictFail.route('**/*',route=>route.request().url().startsWith(base+'/') ? route.continue() : route.abort());
    await conflictFail.addInitScript(key=>{localStorage.setItem(key,JSON.stringify({version:1,text:'conflicting draft',original:'old source',revision:'old revision'}));const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===key)throw new DOMException('quota','QuotaExceededError');return set.call(this,k,v);};},key);
    await conflictFail.goto(base);await conflictFail.getByRole('link',{name:'Programs',exact:true}).click();await conflictFail.getByLabel('Program').selectOption('web_bounty/fictional');await conflictFail.getByLabel('Lane').selectOption('web');await conflictFail.getByRole('link',{name:'Reports',exact:true}).click();
    await conflictFail.getByText(/^Conflict:/).waitFor();await conflictFail.locator('.CodeMirror textarea').focus();await conflictFail.keyboard.insertText(' newer');
    assert.match(await conflictFail.locator('#report-status').innerText(),/Conflict:/);assert.match(await conflictFail.locator('#report-status').innerText(),/storage unavailable/i);
    await conflictFail.close();
  } finally {if(browser)await browser.close();if(proc.exitCode===null && proc.signalCode===null){const done=once(proc,'exit');proc.kill('SIGTERM');await done;}fs.rmSync(tmp,{recursive:true,force:true});}
});
