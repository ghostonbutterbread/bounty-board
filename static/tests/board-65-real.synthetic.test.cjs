const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium}=require('playwright');

test('65 real browser publications with polls leave the next editor save able to reach Markdown', {timeout:420000}, async()=>{
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'many-'));
  const root=path.join(tmp,'root'), report=path.join(root,'web_bounty/example/web/reports/report.md');
  fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'initial\n');
  const proc=spawn('python3',['-B','-u','-c',"import sys,app; s=app.make_server(sys.argv[1],0,collaboration_dir=sys.argv[2],report_autosave=True); print(s.server_port,flush=True); s.serve_forever()",root,path.join(tmp,'private')],{cwd:path.resolve(__dirname,'../..'),env:process.env,stdio:['ignore','pipe','ignore']});
  let browser;
  try {
    const [chunk]=await once(proc.stdout,'data');const base=`http://127.0.0.1:${Number(String(chunk).trim())}`;
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const page=await browser.newPage();page.setDefaultTimeout(30000);await page.goto(base);
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
    await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();await page.getByText(/Shared draft ready/).waitFor();
    await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('editor after 65\n');
    await page.getByText(/Markdown file saved/).waitFor({timeout:60000});assert.equal(fs.readFileSync(report,'utf8'),'editor after 65\n');
  } finally {if(browser)await browser.close();if(proc.exitCode===null&&proc.signalCode===null){const done=once(proc,'exit');proc.kill();await done;}fs.rmSync(tmp,{recursive:true,force:true});}
});
