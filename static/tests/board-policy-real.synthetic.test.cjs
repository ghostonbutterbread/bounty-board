const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {chromium} = require('playwright');

// Real CLI, Chromium, backend policy and disposable Markdown; no response adapter.
test('real report policy allows owned and unregistered files but rejects generated navigation and preserves drafts', {timeout:90000}, async () => {
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'policy-'));
  const root=path.join(tmp,'root'), lane=path.join(root,'web_bounty/example/web');
  const reports=path.join(lane,'reports'), ledger=path.join(lane,'ledgers');
  fs.mkdirSync(reports,{recursive:true});fs.mkdirSync(ledger,{recursive:true});
  const contents={'registered.md':'registered original\n','unregistered.md':'unregistered original\n','evidence.md':'evidence original\n','navigation.md':'<!-- generated: bounty-core-report-navigation -->\n# Navigation\n'};
  for(const [name,text] of Object.entries(contents))fs.writeFileSync(path.join(reports,name),text);
  fs.writeFileSync(path.join(ledger,'ledger.json'),JSON.stringify({findings:[{fid:'SYN-1',title:'Synthetic',report_path:path.join(reports,'registered.md'),evidence_path:path.join(reports,'evidence.md')}]}));
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
  const base=`http://127.0.0.1:${port}`;
  const proc=spawn('python3',['-B','-u','app.py','--root',root,'--port',String(port),'--collaboration-dir',path.join(tmp,'private'),'--report-autosave'],{cwd:path.resolve(__dirname,'../..'),env:process.env,stdio:['ignore','ignore','ignore']});
  let browser;
  try {
    let data;
    for(let i=0;i<100;i++){try{const response=await fetch(base+'/api/data');if(response.ok){data=await response.json();break;}}catch{} await new Promise(r=>setTimeout(r,100));}
    assert.ok(data,'CLI server must become ready');
    const entries=Object.fromEntries(data.programs[0].lanes[0].reports.map(x=>[x.path,x]));
    assert.equal(entries['registered.md'].kind,'registered_report');assert.equal(entries['evidence.md'].kind,'generated_evidence');assert.equal(entries['unregistered.md'].kind,'unregistered');
    for(const name of ['registered.md','unregistered.md','evidence.md'])assert.equal(entries[name].editable,true,name);
    assert.equal(entries['navigation.md'].editable,false);
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const page=await browser.newPage();page.setDefaultTimeout(15000);await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();
    for(const name of ['registered.md','unregistered.md','evidence.md']){
      await page.locator('#report-select').selectOption(name);await page.getByText(/Shared draft ready/).waitFor();
      await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText(`saved ${name}\n`);
      await page.getByText(/Markdown file saved/).waitFor();assert.equal(fs.readFileSync(path.join(reports,name),'utf8'),`saved ${name}\n`);
    }
    await page.locator('#report-select').selectOption('navigation.md');await page.getByText(/read.only/i).waitFor();
    assert.equal(await page.evaluate(()=>document.querySelector('.CodeMirror')?.CodeMirror.getOption('readOnly') ?? document.querySelector('#report-source')?.readOnly),true);
    assert.equal(await page.locator('.editor-toolbar').count(),0);assert.equal(await page.getByRole('button',{name:'Save merged report'}).count(),0);
    const q=new URLSearchParams({family:'web_bounty',program:'example',lane:'web',path:'navigation.md',root_identity:data.root_identity});
    const state=await (await fetch(base+'/api/collaboration?'+q)).json();
    const denied=await fetch(base+'/api/collaboration?'+q,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'Bounty-Board',Origin:base},body:JSON.stringify({base:state.revision,content:'attack\n',request_id:'navigation-denied'})});
    assert.equal(denied.status,403);assert.equal(fs.readFileSync(path.join(reports,'navigation.md'),'utf8'),contents['navigation.md']);
    // Keep a real local draft, then change the source's policy before reloading.
    await page.locator('#report-select').selectOption('unregistered.md');await page.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror.getValue()==='saved unregistered.md\n');
    await page.route('**/api/collaboration?*',route=>route.request().method()==='POST'?route.abort():route.continue());
    await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('unsent local draft\n');
    await page.getByText(/Save outcome unconfirmed/).waitFor();
    fs.writeFileSync(path.join(reports,'unregistered.md'),contents['navigation.md']);
    await page.reload();await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();await page.locator('#report-select').selectOption('unregistered.md');
    await page.getByText(/read.only/i).waitFor();assert.equal(await page.locator('#report-source').inputValue(),'unsent local draft\n');assert.equal(await page.locator('#report-source').getAttribute('readonly'),'');
    assert.equal(fs.readFileSync(path.join(reports,'unregistered.md'),'utf8'),contents['navigation.md']);
  } finally {if(browser)await browser.close();if(proc.exitCode===null&&proc.signalCode===null){const done=once(proc,'exit');proc.kill();await done;}fs.rmSync(tmp,{recursive:true,force:true});}
});
