const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');const {once}=require('node:events');const {chromium}=require('playwright');
test('reload during backlog backoff retains request without promising a retry', {timeout:25000},async()=>{
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'reload-')),root=path.join(tmp,'root'),report=path.join(root,'web_bounty/example/web/reports/report.md');
  fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'original\n');
  const proc=spawn('python3',['-B','-u','-c',"import sys,app; s=app.make_server(sys.argv[1],0,collaboration_dir=sys.argv[2],report_autosave=True); print(s.server_port,flush=True); s.serve_forever()",root,path.join(tmp,'private')],{cwd:path.resolve(__dirname,'../..'),env:process.env,stdio:['ignore','pipe','ignore']});let browser;
  try {
    const [chunk]=await once(proc.stdout,'data');const base=`http://127.0.0.1:${Number(String(chunk).trim())}`;
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const page=await browser.newPage();await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();await page.getByText(/Shared draft ready/).waitFor();let posts=0;
    await page.route('**/api/collaboration?*',route=>{if(route.request().method()!=='POST')return route.continue();posts++;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"retained_scan_backlog"}'});});
    await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('draft\n');await page.getByText(/Retrying the exact request/).waitFor();
    await page.reload();await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();
    await page.getByRole('button',{name:'Inspect original save'}).waitFor();assert.match(await page.locator('#report-status').innerText(),/retry stopped.*inspect/i);
    await page.waitForTimeout(1200);assert.equal(posts,1);assert.equal(await page.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'draft\n');assert.equal(fs.readFileSync(report,'utf8'),'original\n');
  }finally{if(browser)await browser.close();if(proc.exitCode===null&&proc.signalCode===null){const done=once(proc,'exit');proc.kill();await done;}fs.rmSync(tmp,{recursive:true,force:true});}
});
