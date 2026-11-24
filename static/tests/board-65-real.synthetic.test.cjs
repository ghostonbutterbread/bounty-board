const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium}=require('playwright');

test('65 real browser publications with polls leave the next editor save able to reach Markdown', {timeout:180000}, async()=>{
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'many-'));
  const root=path.join(tmp,'root'), report=path.join(root,'web_bounty/example/web/reports/report.md');
  fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'initial\n');
  const start=port=>spawn('python3',['-B','-u','-c',"import sys,app; s=app.make_server(sys.argv[1],int(sys.argv[3]),collaboration_dir=sys.argv[2],report_autosave=True); print(s.server_port,flush=True); s.serve_forever()",root,path.join(tmp,'private'),String(port)],{cwd:path.resolve(__dirname,'../..'),env:process.env,stdio:['ignore','pipe','ignore']});
  let proc=start(0);
  let browser;
  try {
    const [chunk]=await once(proc.stdout,'data');const base=`http://127.0.0.1:${Number(String(chunk).trim())}`;
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const page=await browser.newPage();page.setDefaultTimeout(30000);
    // Drive polls explicitly at the intended barrier, avoiding interval races.
    await page.addInitScript(()=>{const every=window.setInterval;window.setInterval=(fn,ms,...args)=>ms===2000 ? 0 : every(fn,ms,...args);});
    await page.goto(base);
    const result=await page.evaluate(async()=>{
      const data=await (await fetch('/api/data')).json();
      const q=new URLSearchParams({family:'web_bounty',program:'example',lane:'web',path:'report.md',root_identity:data.root_identity});
      const url='/api/collaboration?'+q;
      async function get(){const r=await fetch(url);if(!r.ok)throw new Error('GET '+r.status);return r.json();}
      let state=await get(), max=0;
      for(let n=0;n<65;n++){
        const payload={base:state.revision,content:`version ${n}\n`,request_id:`browser-many-${n}`};
        const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'Bounty-Board'},body:JSON.stringify(payload)});
        const body=await response.json();if(response.status!==200||body.publication?.state!=='published')throw new Error(JSON.stringify({n,status:response.status,body}));
        max=Math.max(max,body.reconciliation?.scanned||0);
        state=await get();max=Math.max(max,state.reconciliation?.scanned||0);
        if(state.reconciliation?.state==='backlog'){state=await get();max=Math.max(max,state.reconciliation?.scanned||0);}
      }
      return {max,content:state.content};
    });
    assert.ok(result.max<=64);assert.equal(result.content,'version 64\n');assert.equal(fs.readFileSync(report,'utf8'),'version 64\n');
    await page.getByRole('link',{name:'Programs',exact:true}).click();await page.getByRole('link',{name:'Reports',exact:true}).click();await page.getByText(/Shared draft ready/).waitFor();
    // A restart resets the server's scan cursor without fabricating retained operations.
    let done=once(proc,'exit');proc.kill();await done;proc=start(Number(new URL(base).port));await once(proc.stdout,'data');
    let release,arrive,reject;const gate=new Promise(r=>release=r),backlogged=new Promise((r,j)=>{arrive=r;reject=j});const posts=[],responses=[];
    const intercept=async route=>{
      if(route.request().method()!=='POST')return route.continue();
      posts.push(route.request().postDataJSON());
      if(posts.length!==1){const response=await route.fetch(),body=await response.json();responses.push({status:response.status(),body});return route.fulfill({response,json:body});}
      try {
        const response=await route.fetch(),body=await response.json();
        assert.equal(response.status(),503);assert.equal(body.error,'retained_scan_backlog');
        arrive({url:route.request().url(),body});await gate;await route.fulfill({response,json:body});
      } catch(error) {reject(error);await route.abort().catch(()=>{});}
    };
    try {
      await page.route('**/api/collaboration?*',intercept);
      await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('editor after 65\n');
      let barrierTimeout;
      const blocked=await Promise.race([backlogged,new Promise((_,reject)=>{barrierTimeout=setTimeout(()=>reject(new Error('Timed out waiting for the first backend backlog response')),15000);})]).finally(()=>clearTimeout(barrierTimeout));
      assert.equal(fs.readFileSync(report,'utf8'),'version 64\n');
      await page.keyboard.press('Control+A');await page.keyboard.insertText('newer edit\n');
      const retained=await page.evaluate(()=>Object.values(localStorage).map(v=>{try{return JSON.parse(v)}catch{return null}}).find(v=>v?.pendingShared));
      assert.equal(retained.pendingShared.content,'editor after 65\n');assert.equal(retained.text,'newer edit\n');
      assert.doesNotMatch(await page.locator('#report-status').innerText(),/Markdown file saved/);
      const recovery=new URL(blocked.url);recovery.pathname+='/recovery';recovery.searchParams.set('request_id',posts[0].request_id);
      const notObserved=await page.request.get(recovery.toString());assert.equal(notObserved.status(),404);assert.equal((await notObserved.json()).error,'not_observed');
      const poll=await page.request.get(blocked.url);assert.equal(poll.status(),200);assert.equal((await poll.json()).reconciliation.state,'backlog');
      release();
      await page.waitForFunction(()=>document.querySelector('#report-status')?.textContent.includes('Markdown file saved') && document.querySelector('.CodeMirror').CodeMirror.getValue()==='newer edit\n',null,{timeout:20000});
      assert.ok(posts.length>=3);assert.deepEqual(posts[1],posts[0]);assert.equal(responses[0].status,200);assert.equal(responses[0].body.publication.state,'published');assert.notEqual(posts[2].request_id,posts[0].request_id);assert.equal(posts[2].content,'newer edit\n');
      assert.equal(fs.readFileSync(report,'utf8'),'newer edit\n');
    } finally {release();}
  } finally {if(browser)await browser.close();if(proc.exitCode===null&&proc.signalCode===null){const done=once(proc,'exit');proc.kill();await done;}fs.rmSync(tmp,{recursive:true,force:true});}
});
