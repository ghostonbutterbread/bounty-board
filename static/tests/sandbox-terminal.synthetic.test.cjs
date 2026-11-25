// Sandbox terminal drawer on a synthetic fixture (tests/terminal_browser_fixture.py):
// Board + terminal service (test-only local shell) + a Serve-like front proxy.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

const repo=path.resolve(__dirname,'../..');
const shots=process.env.TERMINAL_SCREENSHOT_DIR;
const REPORT='D1-sqli-login/example-com-sqli-D1.md';

async function withFixture(mode,fn){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bt-'));
  const child=spawn('python3',['-u','tests/terminal_browser_fixture.py',dir,mode],{cwd:repo,env:{...process.env,PYTHONPATH:repo},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const info=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));let buf='';child.stdout.on('data',d=>{buf+=d;if(buf.includes('\n'))resolve(JSON.parse(buf.split('\n')[0]));});});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const newPage=async(options={})=>{
      const context=await browser.newContext({viewport:{width:1280,height:900},...options});
      await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
      const page=await context.newPage();
      page.errors=[];page.on('pageerror',e=>page.errors.push(String(e)));
      return page;
    };
    await fn({...info,base:`http://127.0.0.1:${info.port}`,newPage,dir});
  } finally {
    if(browser)await browser.close();
    child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

async function openReport(page,base,{live=true,report=REPORT}={}){
  await page.goto(base);
  await page.getByRole('button',{name:'Open workspace'}).click();
  await page.getByRole('link',{name:'Reports',exact:true}).click();
  await page.locator('#report-select').selectOption(report);
  if(live){
    await page.locator('#live-report-host .live-editor .CodeMirror').waitFor({timeout:15000});
    await page.locator('[data-live-status]').filter({hasText:/^(Saved|Read-only)$/}).waitFor({timeout:15000});
  }
}
async function sideBySide(page){
  await page.locator('#live-report-host .editor-toolbar button.side-by-side').click();
  await page.locator('#live-report-host .editor-preview-side pre').first().waitFor();
}
const screen=page=>page.evaluate(()=>{const b=window.BoardTerminal.term.buffer.active;const out=[];for(let i=0;i<b.length;i++)out.push(b.getLine(i).translateToString(true));return out;});
async function waitScreen(page,predicate,label){
  for(let i=0;i<100;i++){const lines=await screen(page);if(predicate(lines))return lines;await page.waitForTimeout(100);}
  throw new Error(`terminal never showed ${label}: ${JSON.stringify((await screen(page)).filter(Boolean).slice(-12))}`);
}
const bar=(page,i)=>page.locator('#live-report-host .editor-preview-side [data-term-controls]').nth(i);
const steps=page=>page.locator('[data-term-steps]').textContent();
async function shot(page,name){if(shots){fs.mkdirSync(shots,{recursive:true});await page.screenshot({path:path.join(shots,name)});}}
async function theme(page,value){await page.evaluate(v=>{localStorage.setItem('bounty-board-theme',v);document.documentElement.dataset.theme=v;},value);}

test('drawer connects; play, Run and checks work; nothing reaches the Markdown or the clipboard',{timeout:180000},async()=>{
  await withFixture('tailnet',async({base,newPage,keys,lane})=>{
    const reportFile=path.join(lane,'reports/D1-sqli-login/example-com-sqli-D1.md');
    const original=fs.readFileSync(reportFile,'utf8');
    const page=await newPage();
    await openReport(page,base);
    const toggle=page.locator('[data-term-toggle]');
    assert.equal(await toggle.count(),1);
    await toggle.click();
    await page.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
    assert.match(await page.locator('[data-term-meta]').textContent(),/Folder reports\/D1-sqli-login/);
    assert.doesNotMatch(await page.locator('[data-term-meta]').textContent(),/Pauses|removed/,'lifecycle timing stays out of the header');
    assert.equal(await page.locator('[data-term-status]').getAttribute('title'),'Pauses 5 min after the last viewer leaves and is removed after 4 hours. Files in the report folder are kept.');
    await waitScreen(page,l=>l.some(x=>x.includes('sandbox$')),'a prompt');
    await sideBySide(page);
    const bars=page.locator('#live-report-host .editor-preview-side [data-term-controls]');
    assert.equal(await bars.count(),6);
    assert.deepEqual(await bars.evaluateAll(bs=>bs.map(b=>b.dataset.key)),keys,'browser fingerprints match terminal_checks.block_keys');
    assert.deepEqual(await bars.evaluateAll(bs=>bs.map(b=>!!b.querySelector('[data-term-run]'))),[true,true,false,true,true,true]);
    // Play types without Enter.
    await bar(page,0).locator('[data-term-type]').click();
    let lines=await waitScreen(page,l=>l.some(x=>/sandbox\$ echo step-one-ok$/.test(x)),'typed text');
    assert.ok(!lines.some(x=>x.trim()==='step-one-ok'),'not executed yet');
    await page.keyboard.press('Enter');
    await waitScreen(page,l=>l.some(x=>x.trim()==='step-one-ok'),'output after Enter');
    // Run sends Enter; the shell runs in the real report folder.
    await bar(page,1).locator('[data-term-run]').click();
    await waitScreen(page,l=>l.some(x=>x.trim()==='poc.py'),'ls output');
    // Shift+click on a console block runs only its "$ " line.
    await bar(page,3).locator('[data-term-type]').click({modifiers:['Shift']});
    await waitScreen(page,l=>l.some(x=>/\$ echo console-ok$/.test(x))&&l.some(x=>x.trim()==='console-ok'),'console block');
    // A multi-line block arrives as one bracketed paste and runs as one command.
    await bar(page,5).locator('[data-term-run]').click();
    await waitScreen(page,l=>l.some(x=>x.trim()==='loop-1')&&l.some(x=>x.trim()==='loop-2'),'loop output');
    // A host-side edit (an agent improving the PoC) is visible immediately.
    fs.writeFileSync(path.join(lane,'reports/D1-sqli-login/poc.py'),'print("improved-by-agent")\n');
    await page.locator('[data-term-screen] textarea').focus();
    await page.keyboard.type('python3 poc.py\n');
    await waitScreen(page,l=>l.some(x=>x.trim()==='improved-by-agent'),'edited PoC output');

    // Check marks: stored by the service, shared and persistent.
    await bar(page,0).locator('[data-term-check]').check();
    await bar(page,2).locator('[data-term-check]').check();
    await page.waitForFunction(()=>document.querySelector('[data-term-steps]').textContent==='2 of 6 steps checked');
    const other=await newPage();
    await openReport(other,base);
    await other.locator('[data-term-toggle]').click();
    await other.locator('[data-term-steps]').filter({hasText:'2 of 6 steps checked'}).waitFor({timeout:10000});
    await sideBySide(other);
    assert.deepEqual(await other.locator('#live-report-host .editor-preview-side [data-term-check]').evaluateAll(cs=>cs.map(c=>c.checked)),[true,false,true,false,false,false]);
    // Both devices share one shell: output typed on one shows on the other.
    await other.locator('[data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
    await waitScreen(other,l=>l.some(x=>x.trim()==='improved-by-agent'),'scrollback on the second device');
    await bar(other,4).locator('[data-term-check]').check();
    await page.locator('[data-term-steps]').filter({hasText:'3 of 6 steps checked'}).waitFor({timeout:12000});
    assert.match(await page.locator('[data-term-meta]').textContent(),/2 viewers/);
    await page.reload();
    await openReport(page,base);
    await page.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
    await page.locator('[data-term-steps]').filter({hasText:'3 of 6 steps checked'}).waitFor({timeout:10000});
    await sideBySide(page);
    assert.deepEqual(await page.locator('#live-report-host .editor-preview-side [data-term-check]').evaluateAll(cs=>cs.map(c=>c.checked)),[true,false,true,false,true,false]);

    // Raw Markdown and copies stay clean.
    const editorText=await page.evaluate(()=>document.querySelector('#live-report-host .CodeMirror').CodeMirror.getValue());
    assert.equal(editorText,original);
    assert.equal(fs.readFileSync(reportFile,'utf8'),original);
    const copied=await page.evaluate(()=>{
      const preview=document.querySelector('#live-report-host .editor-preview-side');
      const range=document.createRange();range.selectNodeContents(preview);
      const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);
      const data=new DataTransfer();
      document.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));
      return {text:data.getData('text/plain'),html:data.getData('text/html')};
    });
    assert.match(copied.text,/echo step-one-ok/);
    assert.match(copied.text,/Synthetic finding/);
    assert.doesNotMatch(copied.text,/Checked|Run|Type into terminal/);
    assert.doesNotMatch(copied.html,/data-term|checkbox|fa-play/);

    // Save output as evidence: a new file in the real folder, shown in the artifacts panel.
    await page.locator('[data-term-evidence]').click();
    await page.locator('[data-term-note]').filter({hasText:/Saved reports\/D1-sqli-login\/validation\/terminal-\d{8}-\d{6}\.txt/}).waitFor({timeout:10000});
    const saved=fs.readdirSync(path.join(lane,'reports/D1-sqli-login/validation'));
    assert.equal(saved.length,1);
    const transcript=fs.readFileSync(path.join(lane,'reports/D1-sqli-login/validation',saved[0]),'utf8');
    assert.match(transcript,/improved-by-agent/);
    assert.doesNotMatch(transcript,/\x1b/);
    await page.locator(`#report-artifacts-host [data-artifact="reports/D1-sqli-login/validation/${saved[0]}"]`).waitFor({timeout:10000});

    // Ctrl+` toggles; the open state and height are remembered per browser.
    await page.locator('#live-report-host .CodeMirror textarea').focus();
    await page.keyboard.press('Control+Backquote');
    assert.equal(await page.locator('#term-drawer').isHidden(),true);
    await page.keyboard.press('Control+Backquote');
    await page.locator('#term-drawer').waitFor();
    const handle=page.locator('[data-term-resize]');
    const box=await handle.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+4);await page.mouse.down();await page.mouse.move(box.x+box.width/2,box.y-80,{steps:4});await page.mouse.up();
    const height=await page.evaluate(()=>JSON.parse(localStorage.getItem('bounty-board-terminal:v1')).height);
    assert.ok(height>390&&height<420,String(height));
    await page.reload();
    await openReport(page,base);
    await page.locator('#term-drawer').waitFor();
    assert.equal(Math.round((await page.locator('#term-drawer').boundingBox()).height),height);

    // Reset sandbox: two-step confirm, fresh shell in the same folder.
    await page.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
    await page.locator('[data-term-reset]').click();
    await page.getByRole('button',{name:'Confirm reset'}).click();
    await page.locator('[data-term-note]').filter({hasText:'Sandbox reset'}).waitFor({timeout:20000});
    await waitScreen(page,l=>l.some(x=>x.includes('sandbox$'))&&!l.some(x=>x.trim()==='improved-by-agent'),'fresh shell');

    // Screenshots: drawer open with play/check controls.
    await sideBySide(page);
    await bar(page,1).locator('[data-term-run]').click();
    await waitScreen(page,l=>l.some(x=>x.trim()==='poc.py'),'ls output');
    await theme(page,'light');await page.waitForTimeout(300);await shot(page,'report-terminal-light.png');
    await theme(page,'dark');await page.waitForTimeout(300);await shot(page,'report-terminal-dark.png');
    assert.deepEqual([...page.errors,...other.errors],[]);
  });
});

test('phone layout: full-width sheet',{timeout:90000},async()=>{
  await withFixture('tailnet',async({base,newPage})=>{
    const page=await newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2});
    await openReport(page,base);
    await page.locator('[data-term-toggle]').click();
    await page.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
    const box=await page.locator('#term-drawer').boundingBox();
    assert.equal(Math.round(box.x),0);
    assert.equal(Math.round(box.width),390);
    assert.ok(box.height>=450&&box.height<=520,String(box.height));
    await page.locator('[data-term-screen] textarea').focus();
    await page.keyboard.type('echo phone-$((3*3))\n');
    await waitScreen(page,l=>l.some(x=>x.trim()==='phone-9'),'phone output');
    await theme(page,'light');await page.waitForTimeout(300);await shot(page,'phone-terminal-light.png');
    await theme(page,'dark');await page.waitForTimeout(300);await shot(page,'phone-terminal-dark.png');
    assert.deepEqual(page.errors,[]);
  });
});

test('password sign-in when the tailnet identity is not allowlisted',{timeout:90000},async()=>{
  await withFixture('login,strip',async({base,newPage,password})=>{
    const page=await newPage();
    await openReport(page,base);
    await page.locator('[data-term-toggle]').click();
    await page.locator('[data-term-status]').filter({hasText:'Sign-in needed'}).waitFor({timeout:15000});
    const link=page.locator('[data-term-login]');
    assert.match(await link.getAttribute('href'),/^\/terminal\/login\?next=%2F%23/);
    await link.click();
    await page.getByRole('heading',{name:'Sign in to the terminal'}).waitFor();
    await theme(page,'light');await shot(page,'login-light.png');
    await theme(page,'dark');await shot(page,'login-dark.png');
    await page.getByLabel('Username').fill('ryushe');
    await page.getByLabel('Password').fill('wrong password');
    await page.getByRole('button',{name:'Sign in'}).click();
    await page.getByRole('alert').filter({hasText:'Wrong username or password.'}).waitFor();
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button',{name:'Sign in'}).click();
    await page.locator('#live-report-host .CodeMirror').waitFor({timeout:15000});
    const cookies=await page.context().cookies();
    const session=cookies.find(c=>c.name==='bbterm_session');
    assert.ok(session&&session.httpOnly&&session.secure&&session.sameSite==='Strict'&&session.path==='/terminal');
    await page.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
    await page.locator('[data-term-screen] textarea').focus();
    await page.keyboard.type('echo signed-in-$((4+4))\n');
    await waitScreen(page,l=>l.some(x=>x.trim()==='signed-in-8'),'output after sign-in');
    assert.deepEqual(page.errors,[]);
  });
});

test('non-live report view gets controls; Serve prefix stripping works',{timeout:90000},async()=>{
  await withFixture('tailnet,strip,nolive',async({base,newPage})=>{
    const page=await newPage();
    await openReport(page,base,{live:false});
    await page.locator('#report-preview [data-term-controls]').first().waitFor({timeout:15000});
    assert.equal(await page.locator('#report-preview [data-term-controls]').count(),6);
    assert.doesNotMatch(await page.locator('#report-source').inputValue(),/Checked/);
    await page.locator('#report-preview [data-term-controls] [data-term-run]').first().click();
    await page.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
    await waitScreen(page,l=>l.some(x=>x.trim()==='step-one-ok'),'run from non-live preview');
    assert.deepEqual(page.errors,[]);
  });
});

test('no terminal UI when the service is not configured; graceful when it is down',{timeout:90000},async()=>{
  await withFixture('noterm',async({base,newPage})=>{
    const page=await newPage();
    await openReport(page,base);
    await page.locator('#live-report-host .editor-toolbar button.side-by-side').click();
    await page.locator('#live-report-host .editor-preview-side pre').first().waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('[data-term-toggle]').count(),0);
    assert.equal(await page.locator('[data-term-controls]').count(),0);
    assert.equal(await page.locator('#term-drawer:visible').count(),0);
    await page.keyboard.press('Control+Backquote');
    assert.equal(await page.locator('#term-drawer:visible').count(),0);
    assert.deepEqual(page.errors,[]);
  });
  await withFixture('down',async({base,newPage})=>{
    const page=await newPage();
    await openReport(page,base);
    await page.locator('[data-term-toggle]').click();
    await page.locator('[data-term-status]').filter({hasText:'Service unavailable'}).waitFor({timeout:15000});
    await page.getByText('The terminal service is not running or not reachable.').waitFor();
    await sideBySide(page);
    assert.equal(await page.locator('#live-report-host .editor-preview-side [data-term-check]:disabled').count(),6);
    assert.equal(await page.locator('[data-live-status]').filter({hasText:/^Saved$/}).count(),1,'the editor keeps working');
    assert.deepEqual(page.errors,[]);
  });
});

test('a paused sandbox resumes with the same shell and a Resumed toast',{timeout:120000},async()=>{
  await withFixture('tailnet,fastpause',async({base,newPage})=>{
    const page=await newPage();
    await openReport(page,base);
    await page.locator('[data-term-toggle]').click();
    await page.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
    await page.locator('[data-term-screen] textarea').focus();
    await page.keyboard.type('export KEPT=still-here; mkdir -p sub; cd sub; sleep 600 & echo bg-started\n');
    await waitScreen(page,l=>l.some(x=>x.trim()==='bg-started'),'background job started');
    await page.locator('[data-term-close]').click();
    const query=new URLSearchParams({family:'web_bounty',program:'synthetic-term',lane:'web',path:REPORT}).toString();
    let paused=false;
    for(let i=0;i<80&&!paused;i++){paused=await page.evaluate(async q=>{const r=await fetch(`/terminal/api/session?${q}`);const d=await r.json();return !!(d.session&&d.session.paused);},query);if(!paused)await page.waitForTimeout(500);}
    assert.ok(paused,'sandbox paused after the last viewer left');
    await page.evaluate(()=>{window.__toasts=[];new MutationObserver(ms=>ms.forEach(m=>m.addedNodes.forEach(n=>n.classList?.contains('toast')&&window.__toasts.push(n.textContent.trim())))).observe(document.querySelector('#toasts'),{childList:true});});
    await page.locator('[data-term-toggle]').click();
    await page.waitForFunction(()=>window.__toasts.includes('Resumed'),null,{timeout:20000});
    await page.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
    await waitScreen(page,l=>l.some(x=>x.trim()==='bg-started'),'scrollback after resume');
    await page.locator('[data-term-screen] textarea').focus();
    await page.keyboard.type('echo "$KEPT in $(basename $PWD), jobs=$(jobs -r | wc -l)"\n');
    await waitScreen(page,l=>l.some(x=>x.trim()==='still-here in sub, jobs=1'),'same shell, cwd and background job');
    assert.equal(await page.locator('[data-term-note]').isHidden(),true,'no restart notice');
    assert.deepEqual(page.errors,[]);
  });
});

test('only reports in a finding folder get a terminal; legacy reports open their ledger packet',{timeout:120000},async()=>{
  await withFixture('tailnet',async({base,newPage,lane})=>{
    const page=await newPage();
    await openReport(page,base,{report:'active.md'});
    const toggle=page.locator('[data-term-toggle]');
    await page.waitForFunction(()=>document.querySelector('[data-term-toggle]')?.disabled===true,null,{timeout:15000});
    const reason='This report is not inside a finding folder (reports/<FID>-…/).';
    assert.equal(await toggle.getAttribute('title'),reason);
    assert.equal(await page.locator('[data-term-reason]').textContent(),reason);
    await page.keyboard.press('Control+Backquote');
    assert.equal(await page.locator('#term-drawer:visible').count(),0);
    assert.equal(fs.existsSync(path.join(lane,'reports/active')),false,'no folder is created');
    // A legacy report mapped through the ledger opens D10's packet and says so.
    await page.locator('#report-select').selectOption('findings/confirmed/D10 - HIGH - stored xss.md');
    await page.waitForFunction(()=>document.querySelector('[data-term-toggle]')?.disabled===false,null,{timeout:15000});
    assert.equal(await page.locator('[data-term-reason]').isHidden(),true);
    await toggle.click();
    await page.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
    await page.locator('[data-term-note]').filter({hasText:'Opened the finding folder reports/D10-xss/ (D10, from the ledger).'}).waitFor({timeout:10000});
    await page.locator('[data-term-screen] textarea').focus();
    await page.keyboard.type('basename "$PWD"; ls\n');
    await waitScreen(page,l=>l.some(x=>x.trim()==='D10-xss')&&l.some(x=>/EVIDENCE\.md/.test(x)),'packet root of D10');
    // Back to a navigation page: the drawer hides, the button is disabled again.
    await page.locator('#report-select').selectOption('index/all.md');
    await page.waitForFunction(()=>document.querySelector('[data-term-toggle]')?.disabled===true,null,{timeout:15000});
    assert.equal(await page.locator('#term-drawer:visible').count(),0);
    await theme(page,'light');await page.waitForTimeout(200);await shot(page,'not-in-packet-light.png');
    assert.deepEqual(page.errors,[]);
  });
});

test('blocks with control characters cannot be typed; sign-in never redirects off-origin',{timeout:150000},async()=>{
  await withFixture('tailnet',async({base,newPage,lane})=>{
    const page=await newPage();
    await openReport(page,base,{report:'D11-ctrl/example-com-ctrl-D11.md'});
    await page.locator('[data-term-toggle]').click();
    await page.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
    await sideBySide(page);
    const bars=page.locator('#live-report-host .editor-preview-side [data-term-controls]');
    await page.waitForFunction(()=>document.querySelectorAll('#live-report-host .editor-preview-side [data-term-unsafe]').length===1);
    const bad=bars.nth(1);
    assert.equal(await bad.locator('[data-term-unsafe]').textContent(),'This block contains control characters and cannot be typed; copy it manually after review.');
    assert.equal(await bad.locator('[data-term-type]').isDisabled(),true);
    assert.equal(await bad.locator('[data-term-run]').isDisabled(),true);
    assert.equal(await bars.nth(0).locator('[data-term-unsafe]').count(),0);
    // Even with the button forced on, the module refuses to send the text.
    await bad.evaluate(el=>{for(const b of el.querySelectorAll('button')){b.disabled=false;b.click();b.dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}));}});
    await page.waitForTimeout(1500);
    assert.equal(fs.existsSync(path.join(lane,'reports/D11-ctrl/pwned-marker')),false,'the hidden command never ran');
    assert.ok(!(await screen(page)).some(x=>/echo hi|pwned/.test(x)),'nothing was typed');
    // The safe block still types (without Enter) and runs.
    await bars.nth(0).locator('[data-term-type]').click();
    let lines=await waitScreen(page,l=>l.some(x=>/\$ echo safe-\$\(\(1\+1\)\)$/.test(x)),'typed safe block');
    assert.ok(!lines.some(x=>x.trim()==='safe-2'),'typing alone does not run');
    await page.keyboard.press('Control+U');
    await bars.nth(0).locator('[data-term-run]').click();
    await waitScreen(page,l=>l.some(x=>x.trim()==='safe-2'),'Run runs');
    assert.deepEqual(page.errors,[]);
  });
  await withFixture('login',async({base,newPage,password})=>{
    const page=await newPage();
    await page.goto(`${base}/terminal/login?next=${encodeURIComponent('/\t/evil.example/x')}`);
    await page.getByLabel('Username').fill('ryushe');
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button',{name:'Sign in'}).click();
    await page.waitForURL(url=>url.pathname==='/'||url.host!==new URL(base).host,{timeout:15000});
    assert.equal(new URL(page.url()).host,new URL(base).host,'stayed on the Board origin');
    assert.equal(new URL(page.url()).pathname,'/');
    assert.deepEqual(page.errors,[]);
  });
});
