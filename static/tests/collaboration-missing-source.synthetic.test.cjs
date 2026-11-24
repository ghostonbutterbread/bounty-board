const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {chromium} = require('playwright');

test('recover a saved shared draft by its old path after source deletion or rename', {timeout:60000}, async () => {
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'ms-'));
  const root=path.join(tmp,'root'), store=path.join(tmp,'private');
  const report=path.join(root,'web_bounty/example/web/reports/example.md');
  fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'source\n');
  let proc, browser;
  const start=async()=>{
    proc=spawn('python3',['-B','-u','-c',"import sys,app; s=app.make_server(sys.argv[1],0,collaboration_dir=sys.argv[2]); print(s.server_port,flush=True); s.serve_forever()",root,store],{cwd:path.resolve(__dirname,'../..'),env:process.env,stdio:['ignore','pipe','ignore']});
    const [chunk]=await once(proc.stdout,'data');return `http://127.0.0.1:${Number(chunk.toString().trim())}`;
  };
  const stop=async()=>{if(proc && proc.exitCode===null && proc.signalCode===null){const done=once(proc,'exit');proc.kill();await done;}};
  try {
    const base=await start();browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN || '/usr/bin/google-chrome',args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const page=await browser.newPage();page.setDefaultTimeout(12000);
    async function open(){await page.goto(base);await page.getByRole('link',{name:'Programs',exact:true}).click();await page.getByRole('link',{name:'Reports',exact:true}).click();}
    await open();await page.getByText(/Shared draft ready/).waitFor();
    await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('stored draft\n');
    await page.getByText(/Shared draft ready/).waitFor();
    assert.equal(fs.readFileSync(report,'utf8'),'source\n');
    let release, arrived;const held=new Promise(resolve=>release=resolve), posted=new Promise(resolve=>arrived=resolve);
    const hold=async route=>{if(route.request().method()==='POST'){arrived();await held;}await route.continue();};
    await page.route('**/api/collaboration?*',hold);
    await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('pending local draft\n');
    await posted;fs.renameSync(report,report+'.renamed');release();
    await page.getByText(/Source unavailable.*not saved to the report/i).waitFor();
    assert.equal(await page.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'pending local draft\n');
    const savedPending=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('bounty-board-report-draft-v2:')).map(([,value])=>JSON.parse(value)).find(value=>value.pendingShared));
    assert.equal(savedPending.pendingShared.content,'pending local draft\n');
    await page.unroute('**/api/collaboration?*',hold);
    await open();
    await page.getByLabel('Original report path').fill('example.md');
    await page.getByRole('button',{name:'Find saved shared draft'}).click();
    await page.getByText(/Source unavailable.*not saved to the report/i).waitFor();
    assert.equal(await page.getByLabel('Recovered shared draft').inputValue(),'stored draft\n');
    assert.equal(await page.getByLabel('Recovered shared draft').getAttribute('readonly'),'');
    assert.equal(fs.existsSync(report),false);assert.equal(fs.readFileSync(report+'.renamed','utf8'),'source\n');
    await page.getByLabel('Original report path').fill('never.md');
    await page.getByRole('button',{name:'Find saved shared draft'}).click();
    await page.getByText(/No saved shared draft found or recovery is unavailable/i).waitFor();
    assert.equal(await page.getByLabel('Recovered shared draft').count(),0);
    fs.unlinkSync(report+'.renamed');
    await page.getByLabel('Original report path').fill('example.md');
    await page.getByRole('button',{name:'Find saved shared draft'}).click();
    assert.equal(await page.getByLabel('Recovered shared draft').inputValue(),'stored draft\n');
  } finally {if(browser)await browser.close();await stop();fs.rmSync(tmp,{recursive:true,force:true});}
});
