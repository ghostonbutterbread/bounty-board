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
    // One report per packet (feat/board-one-report-per-packet): the legacy copy is an
    // Older copies packet file of D10's main report, so it is opened by its link, not the picker.
    await page.evaluate(()=>{location.hash=location.hash.replace(/\/reports\/.*$/,'/reports/'+encodeURIComponent('findings/confirmed/D10 - HIGH - stored xss.md'));});
    await page.locator('[data-packet-note]').waitFor();
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

// ---- Terminal UX (feat/board-terminal-ux): clipboard, toggle shortcut, docks, Settings ----
const CLIP=['clipboard-read','clipboard-write'];
const STORE='bounty-board-terminal:v1';
async function sibling(page){
  const other=await page.context().newPage();
  other.errors=[];other.on('pageerror',e=>other.errors.push(String(e)));
  return other;
}
async function openDrawer(page){
  await page.locator('[data-term-toggle]').click();
  await page.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
  await waitScreen(page,l=>l.some(x=>x.includes('sandbox$')),'a prompt');
}
// Viewport point of the first cell of the last terminal line whose text is exactly `text`.
async function cellOf(page,text,offset=1){
  const pos=await page.evaluate(t=>{const term=window.BoardTerminal.term,b=term.buffer.active;for(let y=b.length-1;y>=0;y--){const s=b.getLine(y).translateToString(true);if(s.trim()===t)return {row:y-b.viewportY,col:s.indexOf(t),rows:term.rows,cols:term.cols};}return null;},text);
  assert.ok(pos&&pos.row>=0&&pos.row<pos.rows,`line ${text} is on screen: ${JSON.stringify(pos)}`);
  const box=await page.locator('#term-drawer .xterm-screen').boundingBox();
  return {x:box.x+(pos.col+offset+0.5)*box.width/pos.cols,y:box.y+(pos.row+0.5)*box.height/pos.rows};
}
const clipboard=page=>page.evaluate(()=>navigator.clipboard.readText());
const setClipboard=(page,text)=>page.evaluate(t=>navigator.clipboard.writeText(t),text);
async function typeLine(page,text){await page.locator('[data-term-screen] textarea').focus();await page.keyboard.type(text);await page.keyboard.press('Enter');}
const rect=(page,selector)=>page.evaluate(s=>{const el=document.querySelector(s);if(!el)return null;const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};},selector);
const overlaps=(a,b)=>a.left<b.right-0.5&&b.left<a.right-0.5&&a.top<b.bottom-0.5&&b.top<a.bottom-0.5;
const stored=page=>page.evaluate(k=>JSON.parse(localStorage.getItem(k)||'{}'),STORE);

test('clipboard: copy on select, Ctrl+C copies or interrupts, Ctrl+V pastes, unsafe pastes are refused',{timeout:240000},async()=>{
  await withFixture('tailnet',async({base,newPage,lane})=>{
    const page=await newPage({permissions:CLIP});
    await openReport(page,base);
    await openDrawer(page);
    await typeLine(page,'echo copy-me-$((6*7))');
    await waitScreen(page,l=>l.some(x=>x.trim()==='copy-me-42'),'output to copy');
    // Copy on select (default on): a double click selects the word and copies it.
    await setClipboard(page,'sentinel-0');
    let at=await cellOf(page,'copy-me-42');
    await page.mouse.dblclick(at.x,at.y);
    await page.waitForFunction(()=>window.BoardTerminal.term.getSelection()==='copy-me-42');
    await page.locator('[data-term-flash]').filter({hasText:'Copied'}).waitFor({timeout:5000});
    assert.equal(await clipboard(page),'copy-me-42');
    // A drag selection copies too.
    await setClipboard(page,'sentinel-1');
    at=await cellOf(page,'copy-me-42',0);
    await page.mouse.move(at.x-3,at.y);await page.mouse.down();await page.mouse.move(at.x+40,at.y,{steps:5});await page.mouse.move(at.x+200,at.y,{steps:5});await page.mouse.up();
    await page.waitForFunction(()=>window.BoardTerminal.term.getSelection().startsWith('copy-me-42'));
    await page.waitForFunction(async()=>(await navigator.clipboard.readText()).startsWith('copy-me-42'),null,{timeout:5000});
    await shot(page,'drawer-copied-bottom-light.png');

    // Turning copy on select off in Settings (another tab) applies live here.
    const settings=await sibling(page);
    await settings.goto(`${base}/#/settings`);
    const copyBox=settings.getByRole('switch',{name:'Copy on select'});
    await copyBox.waitFor({timeout:15000});
    assert.equal(await copyBox.isChecked(),true);
    await copyBox.uncheck();
    await page.waitForFunction(k=>window.BoardTerminal.prefs.copyOnSelect===false,STORE);
    await page.bringToFront();
    await setClipboard(page,'sentinel-2');
    at=await cellOf(page,'copy-me-42');
    await page.mouse.dblclick(at.x,at.y);
    await page.waitForFunction(()=>window.BoardTerminal.term.getSelection()==='copy-me-42');
    await page.waitForTimeout(400);
    assert.equal(await clipboard(page),'sentinel-2','copy on select is off');

    // Ctrl+C with a selection copies and sends no ^C: the running list finishes.
    await page.locator('[data-term-screen] textarea').focus();
    await page.keyboard.type('sleep 3; echo SURVIVED-$((1+1))');await page.keyboard.press('Enter');
    at=await cellOf(page,'copy-me-42');
    await page.mouse.dblclick(at.x,at.y);
    await page.waitForFunction(()=>window.BoardTerminal.term.hasSelection());
    await page.keyboard.press('Control+C');
    assert.equal(await page.evaluate(()=>window.BoardTerminal.term.hasSelection()),false,'selection cleared');
    assert.equal(await clipboard(page),'copy-me-42');
    await waitScreen(page,l=>l.some(x=>x.trim()==='SURVIVED-2'),'no interrupt while copying');
    // Ctrl+C without a selection interrupts.
    await typeLine(page,'sleep 30; echo NOT-INTERRUPTED');
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+C');
    await typeLine(page,'echo after-int-$((2+3))');
    let lines=await waitScreen(page,l=>l.some(x=>x.trim()==='after-int-5'),'prompt back after ^C');
    assert.ok(!lines.some(x=>x.trim()==='NOT-INTERRUPTED'));

    // Ctrl+V pastes the clipboard (not ^V).
    await setClipboard(page,'echo pasted-$((5*5))');
    await page.locator('[data-term-screen] textarea').focus();
    await page.keyboard.press('Control+V');
    await waitScreen(page,l=>l.some(x=>/sandbox\$ echo pasted-\$\(\(5\*5\)\)$/.test(x)),'pasted text');
    await page.keyboard.press('Enter');
    await waitScreen(page,l=>l.some(x=>x.trim()==='pasted-25'),'pasted command ran');

    // Unsafe clipboards are refused before xterm sees them (nothing is sent).
    await page.evaluate(()=>{window.__sent=[];window.BoardTerminal.term.onData(d=>window.__sent.push(d));});
    const marker=path.join(lane,'reports/D1-sqli-login/paste-marker');
    for(const [label,text] of [['ESC[201~',`echo hi\x1b[201~\ntouch paste-marker\n`],['bidi isolate','echo hi⁧; touch paste-marker; ⁩\n'],['lone CR','echo a\rtouch paste-marker\r']]){
      await setClipboard(page,text);
      await page.locator('[data-term-screen] textarea').focus();
      await page.keyboard.press('Control+V');
      await page.locator('[data-term-note]').filter({hasText:'Paste refused: the clipboard text contains control characters.'}).waitFor({timeout:5000});
      await page.waitForTimeout(800);
      assert.deepEqual(await page.evaluate(()=>window.__sent),[],`${label}: nothing sent`);
      assert.equal(fs.existsSync(marker),false,`${label}: no marker`);
      await page.evaluate(()=>{document.querySelector('[data-term-note]').hidden=true;});
    }
    // Other paste routes (context menu, middle click) fire the same paste event.
    const routed=await page.evaluate(()=>{
      const area=document.querySelector('[data-term-screen] textarea');
      const fire=text=>{const data=new DataTransfer();data.setData('text/plain',text);const ev=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});area.dispatchEvent(ev);return ev.defaultPrevented;};
      window.__sent=[];
      const bad=fire('echo x‮; touch paste-marker\n');const sentBad=window.__sent.length;
      fire('echo crlf-$((1+2))\r\n');
      return {bad,sentBad,sent:window.__sent.join('')};
    });
    assert.equal(routed.bad,true);
    assert.equal(routed.sentBad,0,'xterm never received the unsafe paste');
    assert.match(routed.sent,/echo crlf-\$\(\(1\+2\)\)/);
    // Bracketed paste: the pasted line waits for Enter, as one line.
    await waitScreen(page,l=>l.some(x=>/sandbox\$ echo crlf-\$\(\(1\+2\)\)$/.test(x)),'CRLF paste typed as one line');
    await page.locator('[data-term-screen] textarea').focus();
    await page.keyboard.press('Enter');
    await waitScreen(page,l=>l.some(x=>x.trim()==='crlf-3'),'CRLF paste runs');
    assert.equal(fs.existsSync(marker),false);
    assert.deepEqual([...page.errors,...settings.errors],[]);
  });
});

test('toggle shortcut: Ctrl+E everywhere, configurable, focus returns, slot and events API',{timeout:240000},async()=>{
  await withFixture('tailnet',async({base,newPage,lane})=>{
    const page=await newPage();
    await openReport(page,base);
    const drawer=page.locator('#term-drawer');
    await page.evaluate(()=>{window.__events=[];window.__types=[];
      const slot=window.BoardTerminal.slot('ports');window.__slotSame=slot===window.BoardTerminal.slot('ports');
      window.BoardTerminal.on('session',e=>window.__events.push(e.session?{folder:e.session.folder,path:e.selector.path}:e));
      window.BoardTerminal.on('message',m=>window.__types.push(m.type));});
    assert.equal(await page.locator('[data-term-toggle]').getAttribute('title'),'Sandbox terminal (Ctrl+E)');
    // From the editor: opens and focuses the terminal.
    const editor=page.locator('#live-report-host .CodeMirror textarea');
    const before=await page.evaluate(()=>document.querySelector('#live-report-host .CodeMirror').CodeMirror.getValue());
    await editor.focus();
    await page.keyboard.press('Control+E');
    await drawer.waitFor();
    await page.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
    await page.waitForFunction(()=>document.activeElement===window.BoardTerminal.term.textarea,null,{timeout:10000});
    assert.equal(await page.locator('[data-term-close]').getAttribute('title'),'Close terminal (Ctrl+E)');
    // Slot: stable, in the header between the status text and the dock picker, hidden while empty.
    assert.equal(await page.evaluate(()=>window.__slotSame),true);
    const slotInfo=await page.evaluate(()=>{const s=document.querySelector('#term-drawer [data-term-slot="ports"]');const head=s.closest('.term-head');
      const order=[...head.querySelectorAll('[data-term-status],[data-term-slot="ports"],[data-term-dock]')].map(e=>e.matches('[data-term-slot]')?'slot':e.matches('[data-term-dock]')?'dock':'status');
      const hidden=getComputedStyle(s).display==='none';s.innerHTML='<span class="term-pill">8000</span>';return {order,hidden,shown:getComputedStyle(s).display!=='none'};});
    assert.deepEqual(slotInfo,{order:['status','slot','dock'],hidden:true,shown:true});
    await page.waitForFunction(()=>window.__events.length>=1);
    assert.deepEqual(await page.evaluate(()=>window.__events[0]),{folder:'reports/D1-sqli-login',path:REPORT},'session event on attach');
    assert.ok((await page.evaluate(()=>window.__types)).includes('hello'),'message event for every server message');
    assert.equal((await page.evaluate(()=>window.BoardTerminal.session()))?.folder,'reports/D1-sqli-login');
    // From inside the terminal: closes; focus goes back to the editor.
    await page.keyboard.press('Control+E');
    await drawer.waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#live-report-host .CodeMirror textarea')),true,'focus returned to the editor');
    assert.equal(await page.evaluate(()=>document.querySelector('#live-report-host .CodeMirror').CodeMirror.getValue()),before,'nothing typed into the report');
    assert.deepEqual(await page.evaluate(()=>window.__events.at(-1)),{selector:null,session:null},'closing emits a null session');
    assert.equal(await page.evaluate(()=>window.BoardTerminal.session()),null);
    // Ctrl+` still works, both ways.
    await page.keyboard.press('Control+Backquote');
    await drawer.waitFor();
    await page.keyboard.press('Control+Backquote');
    await drawer.waitFor({state:'hidden'});
    // The close button returns focus to the element focused before opening.
    await page.locator('[data-term-toggle]').focus();
    await page.keyboard.press('Control+E');
    await drawer.waitFor();
    await page.locator('[data-term-close]').click();
    await drawer.waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>document.activeElement?.matches('[data-term-toggle]')),true);
    // On the dashboard the shortcut does nothing.
    await page.locator('.sidebar a[data-view="dashboard"]').click();
    await page.keyboard.press('Control+E');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#term-drawer:visible').count(),0);
    await page.goBack();
    await page.locator('#live-report-host .CodeMirror').waitFor({timeout:15000});

    // Settings (another tab): refused combos, then Alt+T.
    const settings=await sibling(page);
    await settings.goto(`${base}/#/settings`);
    const recorder=settings.locator('[data-shortcut-recorder]');
    await recorder.waitFor({timeout:15000});
    assert.equal((await recorder.textContent()).trim(),'Ctrl+E');
    await recorder.click();
    const msg=settings.locator('[data-shortcut-msg]');
    for(const [keys,text] of [['Control+T','Ctrl+T is not available. Browsers open a new tab with it.'],['Control+Shift+C','Ctrl+Shift+C is not available. The terminal copies with it.'],
      ['Control+D','Ctrl+D is not available. The terminal needs it to end input.'],['Control+Alt+K','Ctrl+Alt+K is not available. Use Ctrl or Alt, not both (Ctrl+Alt is AltGr on many keyboards).'],['Shift+K','Shift+K is not available. Hold Ctrl or Alt with the key.']]){
      await settings.keyboard.press(keys);
      assert.equal(await msg.textContent(),text);
    }
    await settings.keyboard.press('Alt+T');
    assert.equal(await msg.textContent(),'Saved. Alt+T now opens and closes the terminal. Ctrl+E goes to the shell again.');
    assert.equal((await recorder.textContent()).trim(),'Alt+T');
    assert.deepEqual((await stored(settings)).shortcut,{ctrl:false,alt:true,shift:false,code:'KeyT'});
    // Applied live in the report tab.
    await page.bringToFront();
    await page.waitForFunction(()=>document.querySelector('[data-term-toggle]').title==='Sandbox terminal (Alt+T)');
    await page.locator('#live-report-host .CodeMirror textarea').focus();
    await page.keyboard.press('Control+E');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#term-drawer:visible').count(),0,'Ctrl+E no longer toggles');
    await page.keyboard.press('Alt+T');
    await drawer.waitFor();
    await page.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
    assert.equal(await page.locator('[data-term-close]').getAttribute('title'),'Close terminal (Alt+T)');
    // Ctrl+E reaches the shell (end of line): Q lands after the text.
    await page.locator('[data-term-screen] textarea').focus();
    await page.keyboard.type('echo xyz');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Control+E');
    await page.keyboard.type('Q');
    await page.keyboard.press('Enter');
    await waitScreen(page,l=>l.some(x=>x.trim()==='xyzQ'),'Ctrl+E moved to the end of the line');
    await page.keyboard.press('Alt+T');
    await drawer.waitFor({state:'hidden'});
    // Reset to Ctrl+E.
    await settings.bringToFront();
    await settings.getByRole('button',{name:'Reset to Ctrl+E'}).click();
    await page.bringToFront();
    await page.waitForFunction(()=>document.querySelector('[data-term-toggle]').title==='Sandbox terminal (Ctrl+E)');
    await page.keyboard.press('Control+E');
    await drawer.waitFor();
    assert.deepEqual([...page.errors,...settings.errors],[]);
  });
});

test('docks: each side reserves its space, sizes persist per orientation, maximize, phone sheet',{timeout:300000},async()=>{
  await withFixture('tailnet',async({base,newPage})=>{
    const page=await newPage({permissions:CLIP});
    await openReport(page,base);
    await openDrawer(page);
    const drawerBox=()=>rect(page,'#term-drawer');
    const vw=await page.evaluate(()=>document.documentElement.clientWidth), vh=900;
    const sidebar=await rect(page,'.app > .sidebar');
    const picker=page.locator('[data-term-dock]');
    assert.deepEqual(await picker.locator('[data-dock]').evaluateAll(bs=>bs.map(b=>[b.dataset.dock,b.getAttribute('aria-pressed'),b.title])),
      [['left','false','Dock left'],['bottom','true','Dock bottom'],['top','false','Dock top'],['right','false','Dock right']]);
    for(const dock of ['right','left','top','bottom']){
      await picker.locator(`[data-dock="${dock}"]`).click();
      assert.equal(await picker.locator(`[data-dock="${dock}"]`).getAttribute('aria-pressed'),'true');
      await page.waitForTimeout(250);
      const d=await drawerBox();
      if(dock==='right'){assert.ok(Math.abs(d.right-vw)<=1&&d.top===0&&Math.abs(d.bottom-vh)<=1,JSON.stringify(d));}
      if(dock==='left'){assert.ok(Math.abs(d.left-sidebar.right)<=1&&d.top===0&&Math.abs(d.bottom-vh)<=1,JSON.stringify(d));}
      if(dock==='top'){assert.ok(d.top===0&&Math.abs(d.left-sidebar.right)<=1&&Math.abs(d.right-vw)<=1,JSON.stringify(d));}
      if(dock==='bottom'){assert.ok(Math.abs(d.bottom-vh)<=1&&Math.abs(d.left-sidebar.right)<=1&&Math.abs(d.right-vw)<=1,JSON.stringify(d));}
      // The report content never sits under the drawer (bottom: scrolled to the end; top: at the start).
      await page.evaluate(dk=>window.scrollTo(0,dk==='bottom'?document.documentElement.scrollHeight:0),dock);
      await page.waitForTimeout(100);
      const host=await rect(page,'#live-report-host');
      assert.ok(host.width>300,`content keeps its width: ${JSON.stringify(host)}`);
      assert.equal(overlaps(host,await drawerBox()),false,`${dock}: content ${JSON.stringify(host)} vs drawer ${JSON.stringify(await drawerBox())}`);
      assert.equal(overlaps(await rect(page,'.topbar'),await drawerBox()),false,`${dock}: topbar is clear`);
      await shot(page,`dock-${dock}-light.png`);
      await page.evaluate(()=>window.scrollTo(0,0));
    }
    // EasyMDE full screen side by side stays usable for every dock.
    await sideBySide(page);
    for(const dock of ['right','left','top','bottom']){
      await picker.locator(`[data-dock="${dock}"]`).click();
      await page.waitForTimeout(250);
      const d=await drawerBox(), cm=await rect(page,'#live-report-host .CodeMirror-fullscreen'), pv=await rect(page,'#live-report-host .editor-preview-side'), tb=await rect(page,'#live-report-host .editor-toolbar.fullscreen');
      for(const [name,box] of [['editor',cm],['preview',pv],['toolbar',tb]]){
        assert.ok(box.width>150&&box.height>30,`${dock} ${name} ${JSON.stringify(box)}`);
        assert.equal(overlaps(box,d),false,`${dock}: ${name} ${JSON.stringify(box)} vs drawer ${JSON.stringify(d)}`);
      }
      assert.equal(overlaps(cm,pv),false,`${dock}: editor and preview side by side`);
      await shot(page,`side-by-side-${dock}-light.png`);
    }
    await page.locator('#live-report-host .editor-toolbar button.side-by-side').click();
    await page.locator('#live-report-host .CodeMirror textarea').focus();
    await page.keyboard.press('Escape');   // EasyMDE leaves full screen on Esc
    await page.waitForFunction(()=>!document.querySelector('.CodeMirror-fullscreen'));

    // Width (left/right) and height (top/bottom) are separate; drag and arrow keys resize.
    await picker.locator('[data-dock="right"]').click();
    const handle=page.locator('[data-term-resize]');
    assert.equal(await handle.getAttribute('aria-orientation'),'vertical');
    let hb=await handle.boundingBox();
    const w0=(await drawerBox()).width;
    // Default side width: min(520, 40% of the 1048 px content column) = 419.
    assert.ok(Math.abs(w0-419)<=1,`default side width ${w0}`);
    await page.mouse.move(hb.x+hb.width/2,hb.y+hb.height/2);await page.mouse.down();await page.mouse.move(hb.x+hb.width/2+60,hb.y+hb.height/2,{steps:5});await page.mouse.up();
    const width=(await stored(page)).width;
    assert.ok(Math.abs(width-(w0-60))<=3,`width ${width} after drag from ${w0}`);
    await handle.focus();await page.keyboard.press('ArrowLeft');
    assert.equal((await stored(page)).width,width+32);
    // The new size reaches the shell (refit sends it to the server).
    // Let the refit settle (it runs on the next frame), then compare with what the shell sees.
    const termSize=()=>page.evaluate(()=>`${window.BoardTerminal.term.rows} ${window.BoardTerminal.term.cols}`);
    let size=await termSize();
    for(let i=0;i<20;i++){await page.waitForTimeout(150);const next=await termSize();if(next===size)break;size=next;}
    await typeLine(page,'stty size');
    await waitScreen(page,l=>l.some(x=>x.trim()===size),`stty size ${size}`);
    await picker.locator('[data-dock="bottom"]').click();
    assert.equal(Math.round((await drawerBox()).height),320,'height is separate from width');
    await handle.focus();await page.keyboard.press('ArrowUp');
    assert.equal((await stored(page)).height,352);
    await picker.locator('[data-dock="left"]').click();
    assert.equal(Math.round((await drawerBox()).width),width+32);
    await handle.focus();await page.keyboard.press('ArrowRight');
    assert.equal((await stored(page)).width,width+64);
    await page.reload();
    await openReport(page,base);
    await page.locator('#term-drawer').waitFor();
    let d=await drawerBox();
    assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('bounty-board-terminal-dock:v1')).dock),'left','the current dock is kept for this tab');
    assert.ok(Math.round(d.width)===width+64&&Math.abs(d.left-sidebar.right)<=1,`left dock restored ${JSON.stringify(d)}`);
    await picker.locator('[data-dock="top"]').click();
    assert.equal(Math.round((await drawerBox()).height),352);
    // Maximize fills the content column (the sidebar stays) and restores the previous dock.
    await picker.locator('[data-dock-max]').click();
    assert.equal(await picker.locator('[data-dock-max]').getAttribute('aria-pressed'),'true');
    assert.equal(await picker.locator('[data-dock-max]').getAttribute('title'),'Restore');
    d=await drawerBox();
    assert.ok(Math.abs(d.left-sidebar.right)<=1&&d.top===0&&Math.abs(d.right-vw)<=1&&Math.abs(d.bottom-vh)<=1,JSON.stringify(d));
    assert.equal(await page.locator('.app > .sidebar').isVisible(),true);
    assert.equal(await handle.isHidden(),true);
    await picker.locator('[data-dock-max]').click();
    d=await drawerBox();
    assert.ok(d.top===0&&Math.round(d.height)===352,`restored to top ${JSON.stringify(d)}`);

    // Screenshots: docked right with a selection just copied; the dock picker.
    await picker.locator('[data-dock="right"]').click();
    await typeLine(page,'echo copy-me-$((6*7))');
    await waitScreen(page,l=>l.some(x=>x.trim()==='copy-me-42'),'output');
    for(const t of ['light','dark']){
      await theme(page,t);await page.waitForTimeout(300);
      const at=await cellOf(page,'copy-me-42');
      await page.mouse.dblclick(at.x,at.y);
      await page.locator('[data-term-flash]').filter({hasText:'Copied'}).waitFor({timeout:5000});
      await shot(page,`drawer-right-copied-${t}.png`);
      if(shots)await picker.screenshot({path:path.join(shots,`dock-picker-${t}.png`)});
      if(shots)await page.locator('#term-drawer .term-head').screenshot({path:path.join(shots,`drawer-head-right-${t}.png`)});
    }
    await picker.locator('[data-dock="bottom"]').click();
    assert.deepEqual(page.errors,[]);

    // Phones: always the bottom sheet, whatever the setting; the picker hides.
    const phone=await newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2});
    await phone.addInitScript(k=>{if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');localStorage.setItem(k,JSON.stringify({dock:'right',maximized:true,width:600}));}},STORE);
    await openReport(phone,base);
    await phone.locator('[data-term-toggle]').click();
    await phone.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
    const pb=await phone.locator('#term-drawer').boundingBox();
    assert.equal(Math.round(pb.x),0);assert.equal(Math.round(pb.width),390);
    assert.equal(Math.round(pb.y+pb.height),844);
    assert.ok(pb.height>=450&&pb.height<=520,String(pb.height));
    assert.equal(await phone.locator('[data-term-dock]').isHidden(),true);
    await theme(phone,'light');await phone.waitForTimeout(300);await shot(phone,'phone-sheet-light.png');
    await theme(phone,'dark');await phone.waitForTimeout(300);await shot(phone,'phone-sheet-dark.png');
    assert.deepEqual(phone.errors,[]);
  });
});

test('settings page: sidebar link, tab title, persistence, live apply across tabs, registered sections',{timeout:180000},async()=>{
  await withFixture('tailnet',async({base,newPage})=>{
    const page=await newPage();
    await page.goto(base);
    const link=page.locator('.sidebar a[data-view="settings"]');
    assert.equal(await link.evaluate(a=>a.tagName),'A');
    assert.equal(await link.getAttribute('href'),'#/settings');
    await link.click();
    await page.waitForFunction(()=>location.hash==='#/settings');
    await page.locator('[data-settings-group="terminal"]').waitFor({timeout:15000});
    assert.equal(await page.title(),'Settings · Bounty Board');
    assert.equal(await page.locator('#breadcrumb').textContent(),'Settings');
    assert.equal(await link.getAttribute('aria-current'),'page');
    const card=page.locator('[data-settings-group="terminal"]');
    assert.equal(await card.locator('h2').textContent().then(t=>t.trim()),'Terminal');
    await card.locator('.settings-note').filter({hasText:'Saved in this browser.'}).waitFor();
    for(const name of ['Copy on select','Ctrl+C copies a selection','Ctrl+V pastes'])assert.equal(await page.getByRole('switch',{name}).isChecked(),true,name);
    // Middle click opens Settings in a new tab (a real link).
    const [popup]=await Promise.all([page.context().waitForEvent('page'),link.click({button:'middle'})]);
    await popup.waitForLoadState();
    assert.match(popup.url(),/#\/settings$/);
    await popup.close();
    // A registered section renders inside the Terminal card, after the built-in controls; re-registering replaces it.
    await page.evaluate(()=>{window.__cleaned=0;window.BoardSettings.register({id:'fake-ports',group:'terminal',title:'Ports',order:50,render(h){h.innerHTML='<p data-fake>Fake ports section</p>';return ()=>{window.__cleaned++;};}});});
    await card.locator('[data-fake]').waitFor();
    assert.equal(await card.locator('[data-settings-section="fake-ports"] h3').textContent(),'Ports');
    assert.equal(await page.evaluate(()=>!!(document.querySelector('[data-settings-section="terminal"]').compareDocumentPosition(document.querySelector('[data-fake]'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
    await page.evaluate(()=>window.BoardSettings.register({id:'other-group',group:'zz-demo',title:'Demo group',order:5,render(h){h.textContent='demo';}}));
    await page.locator('[data-settings-group="zz-demo"] h2').filter({hasText:'Demo group'}).waitFor();
    assert.equal(await page.evaluate(()=>window.__cleaned),1,'cleanup ran on re-render');
    // Persistence across reload.
    await page.getByRole('switch',{name:'Ctrl+V pastes'}).uncheck();
    await page.locator('[data-set-dock="left"]').click();
    assert.equal(await page.locator('[data-set-dock="left"]').getAttribute('aria-pressed'),'true');
    await page.reload();
    await page.getByRole('switch',{name:'Ctrl+V pastes'}).waitFor({timeout:15000});
    assert.equal(await page.getByRole('switch',{name:'Ctrl+V pastes'}).isChecked(),false);
    assert.equal(await page.getByRole('switch',{name:'Copy on select'}).isChecked(),true);
    assert.equal(await page.locator('[data-set-dock="left"]').getAttribute('aria-pressed'),'true');
    const saved=await stored(page);
    assert.equal(saved.ctrlVPaste,false);assert.equal(saved.dock,'left');
    // A new tab opens at the default. Changing the default does not move an open drawer in another tab,
    // and the drawer's picker (current dock, this tab only) does not change the default.
    const report=await sibling(page);
    await openReport(report,base);
    await openDrawer(report);
    assert.equal(await report.locator('#term-drawer').getAttribute('data-dock'),'left');
    await page.bringToFront();
    await page.locator('[data-set-dock="top"]').click();
    await report.waitForFunction(()=>window.BoardTerminal.prefs.dock==='top');
    assert.equal(await report.locator('#term-drawer').getAttribute('data-dock'),'left','the open drawer stays');
    await report.locator('[data-term-dock] [data-dock="right"]').click();
    assert.equal(await report.locator('#term-drawer').getAttribute('data-dock'),'right');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('[data-set-dock="top"]').getAttribute('aria-pressed'),'true','the default is unchanged');
    assert.equal((await stored(page)).dock,'top');
    await page.getByRole('switch',{name:'Ctrl+V pastes'}).check();
    await report.waitForFunction(()=>window.BoardTerminal.prefs.ctrlVPaste===true);
    // Corrupt stored values fall back to the defaults.
    await page.evaluate(k=>localStorage.setItem(k,'{"dock":"diagonal","height":"tall","shortcut":{"ctrl":true,"code":"KeyT"},"copyOnSelect":"yes"}'),STORE);
    await page.reload();
    await page.locator('[data-shortcut-recorder]').waitFor({timeout:15000});
    assert.equal((await page.locator('[data-shortcut-recorder]').textContent()).trim(),'Ctrl+E');
    assert.equal(await page.locator('[data-set-dock="bottom"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.getByRole('switch',{name:'Copy on select'}).isChecked(),true);
    for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(300);await shot(page,`settings-${t}.png`);}
    assert.deepEqual([...page.errors,...report.errors],[]);
  });
  await withFixture('noterm',async({base,newPage})=>{
    const page=await newPage();
    await page.goto(`${base}/#/settings`);
    await page.locator('[data-settings-group="terminal"] .settings-off').filter({hasText:'The sandbox terminal is not enabled on this Board.'}).waitFor({timeout:15000});
    assert.equal(await page.locator('[data-shortcut-recorder]').count(),0);
    assert.equal(await page.title(),'Settings · Bounty Board');
    assert.deepEqual(page.errors,[]);
  });
});

// ---- Review round 1 (f2b969e): F1 topbar in side docks, F2 input-event insertions, session events ----
const topbarState=page=>page.evaluate(()=>{
  const box=el=>{if(!el)return null;const r=el.getBoundingClientRect();return r.width&&r.height?{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}:null;};
  const kbd=document.querySelector('#global-search-host .search-kbd');
  const crumb=document.querySelector('.topbar .breadcrumb'),cb=crumb.getBoundingClientRect();
  const last=[...document.querySelectorAll('#breadcrumb, #breadcrumb-trail .crumb-current')].at(-1),lb=last.getBoundingClientRect();
  const trail=document.querySelector('#breadcrumb-trail').getBoundingClientRect();
  const visibleRight=Math.min(lb.right,cb.right,trail.width?trail.right:Infinity);
  return {kbd:box(kbd),kbdLimit:kbd?parseFloat(getComputedStyle(kbd).fontSize)*2:0,lastText:last.textContent,lastWidth:lb.width,lastVisible:Math.max(0,visibleRight-lb.left),
    controls:[['breadcrumb',crumb],['search',document.querySelector('#global-search-field')],['theme',document.querySelector('#theme-button')],['refresh',document.querySelector('#refresh')]].map(([n,el])=>[n,box(el)]).filter(([,b])=>b),
    body:Math.round(document.querySelector('.app > .body').getBoundingClientRect().width),dock:document.querySelector('#term-drawer')?.dataset.dock,
    rightTitle:document.querySelector('#term-drawer [data-dock="right"]')?.title};
});
test('side docks keep the topbar intact at 1024, 1280 and 1440 wide (review F1)',{timeout:600000},async()=>{
  await withFixture('tailnet',async({base,newPage})=>{
    const problems=[];
    for(const width of [1024,1280,1440]){
      const page=await newPage({viewport:{width,height:900}});
      await page.goto(base);
      for(const dock of ['left','right'])for(const size of ['default','max']){
        await page.evaluate(([k,d,w])=>localStorage.setItem(k,JSON.stringify({open:true,dock:d,...(w?{width:w}:{})})),[STORE,dock,size==='max'?5000:0]);
        await openReport(page,base);
        await page.locator('#term-drawer').waitFor();
        await page.evaluate(()=>window.scrollTo(0,0));await page.waitForTimeout(400);
        const t=await topbarState(page),where=`${width} ${dock} ${size}`;
        if(width===1024){
          // Too narrow for 560 px of content beside a 320 px drawer: the bottom dock is used and the picker says so.
          if(t.dock!=='bottom')problems.push(`${where}: expected the bottom fallback, got ${t.dock}`);
          if(!/needs a wider window; using the bottom dock/.test(t.rightTitle||''))problems.push(`${where}: tooltip ${t.rightTitle}`);
        } else {
          if(t.dock!==dock)problems.push(`${where}: dock ${t.dock}`);
          if(t.body<559)problems.push(`${where}: content column ${t.body}px`);
        }
        if(t.kbd&&t.kbd.height>t.kbdLimit)problems.push(`${where}: chip wraps (${t.kbd.height}px)`);
        const refresh=t.controls.find(([n])=>n==='refresh')[1];
        if(t.kbd&&overlaps(t.kbd,refresh))problems.push(`${where}: chip overlaps Refresh`);
        if(t.lastVisible<Math.min(t.lastWidth,40))problems.push(`${where}: breadcrumb "${t.lastText}" clipped to ${Math.round(t.lastVisible)}px`);
        for(let i=0;i<t.controls.length;i++)for(let j=i+1;j<t.controls.length;j++)if(overlaps(t.controls[i][1],t.controls[j][1]))problems.push(`${where}: ${t.controls[i][0]} overlaps ${t.controls[j][0]}`);
        if(width===1280)for(const th of ['light','dark']){await theme(page,th);await page.waitForTimeout(250);await shot(page,`topbar-1280-${dock}-${size}-${th}.png`);
          if(shots)await page.locator('.topbar').screenshot({path:path.join(shots,`topbar-strip-1280-${dock}-${size}-${th}.png`)});}
        await theme(page,'light');
      }
      assert.deepEqual(page.errors,[]);
      await page.context().close();
    }
    assert.deepEqual(problems,[]);
  });
});

test('typing filter: multi-character input-event insertions are refused unless safe and single-line (review F2)',{timeout:180000},async()=>{
  await withFixture('tailnet',async({base,newPage,lane})=>{
    const page=await newPage();
    await openReport(page,base);
    await openDrawer(page);
    await page.evaluate(()=>{window.__sent=[];window.BoardTerminal.term.onData(d=>window.__sent.push(d));});
    const marker=path.join(lane,'reports/D1-sqli-login/input-marker');
    const ESC='echo hi\x1b[201~\ntouch input-marker\n';
    const CONTROL='Paste refused: the clipboard text contains control characters.',MULTI='Multi-line text must be pasted with Ctrl+V.';
    for(const [inputType,data,viaTransfer,message=CONTROL] of [['insertText',ESC],['insertFromPaste','echo hi\u2067; touch input-marker; \u2069'],['insertReplacementText','echo a\ntouch input-marker\n',false,MULTI],
      ['insertText','echo a\rtouch input-marker'],['insertFromDrop',ESC,true],['insertText','echo a\r\necho b',false,MULTI]]){
      const result=await page.evaluate(([inputType,data,viaTransfer])=>{
        const area=window.BoardTerminal.term.textarea;area.focus();
        const init=viaTransfer?(()=>{const dt=new DataTransfer();dt.setData('text/plain',data);return {inputType,dataTransfer:dt};})():{inputType,data};
        const before=new InputEvent('beforeinput',{...init,bubbles:true,cancelable:true});area.dispatchEvent(before);
        area.dispatchEvent(new InputEvent('input',{...init,bubbles:true}));
        return {cancelled:before.defaultPrevented,sent:window.__sent.splice(0)};
      },[inputType,data,!!viaTransfer]);
      assert.equal(result.cancelled,true,`${inputType} ${JSON.stringify(data)}: beforeinput cancelled`);
      assert.deepEqual(result.sent,[],`${inputType} ${JSON.stringify(data)}: nothing reached xterm`);
      await page.waitForFunction(m=>{const n=document.querySelector('[data-term-note]');return !n.hidden&&n.textContent===m;},message,{timeout:5000});
      await page.evaluate(()=>{document.querySelector('[data-term-note]').hidden=true;});
    }
    await page.waitForTimeout(800);
    assert.equal(fs.existsSync(marker),false,'no marker file');
    // Single characters still type.
    const single=await page.evaluate(()=>{const area=window.BoardTerminal.term.textarea;area.dispatchEvent(new InputEvent('input',{inputType:'insertText',data:'z',bubbles:true}));return window.__sent.splice(0);});
    assert.deepEqual(single,['z']);
    await page.keyboard.press('Backspace');
    // A composed multi-character safe string without newline (an IME commit) reaches the shell.
    await page.locator('[data-term-screen] textarea').focus();
    await page.keyboard.insertText('echo composed-$((3+4))');
    await waitScreen(page,l=>l.some(x=>/sandbox\$ echo composed-\$\(\(3\+4\)\)$/.test(x)),'composed text typed');
    await page.keyboard.press('Enter');
    await waitScreen(page,l=>l.some(x=>x.trim()==='composed-7'),'composed command ran');
    assert.equal(await page.locator('[data-term-note]').isHidden(),true,'no refusal for safe composed text');
    assert.deepEqual(page.errors,[]);
  });
});

test('typing filter: composition commits and keyCode 229 textarea reads cannot deliver unsafe or multi-line text (review G1)',{timeout:180000},async()=>{
  await withFixture('tailnet',async({base,newPage,lane})=>{
    const page=await newPage();
    await openReport(page,base);
    await openDrawer(page);
    await page.evaluate(()=>{window.__sent=[];window.BoardTerminal.term.onData(d=>window.__sent.push(d));});
    const marker=path.join(lane,'reports/D1-sqli-login/comp-marker');
    const CONTROL='Paste refused: the clipboard text contains control characters.',MULTI='Multi-line text must be pasted with Ctrl+V.';
    const routes={
      // IME / phone keyboard commit: xterm reads the textarea on compositionend.
      composition:p=>{const a=window.BoardTerminal.term.textarea;a.focus();
        a.dispatchEvent(new CompositionEvent('compositionstart',{data:'',bubbles:true}));
        a.value=p;a.dispatchEvent(new InputEvent('input',{data:p,inputType:'insertCompositionText',bubbles:true,isComposing:true}));
        a.dispatchEvent(new CompositionEvent('compositionend',{data:p,bubbles:true}));},
      // Android-style keydown 229: xterm diffs the textarea a moment later.
      key229:p=>{const a=window.BoardTerminal.term.textarea;a.focus();a.value='';
        const k=new KeyboardEvent('keydown',{key:'Unidentified',bubbles:true,cancelable:true});Object.defineProperty(k,'keyCode',{get:()=>229});a.dispatchEvent(k);
        a.value=p;a.dispatchEvent(new InputEvent('input',{data:null,inputType:'insertCompositionText',bubbles:true}));},
    };
    for(const [route,payload,message] of [['composition','echo hi\x1b[201~\ntouch comp-marker\n',CONTROL],['composition','echo a\ntouch comp-marker\n',MULTI],
      ['key229','echo hi\u2067; touch comp-marker; \u2069',CONTROL],['key229','echo a\ntouch comp-marker\n',MULTI]]){
      await page.evaluate(new Function('args',`const [p]=args;(${routes[route].toString()})(p);`),[payload]);
      await page.waitForTimeout(400);
      const sent=await page.evaluate(()=>window.__sent.splice(0));
      assert.deepEqual(sent.filter(d=>/[\x1b\r\n\u2067\u2069]/.test(d)||d.includes('touch')),[],`${route} ${JSON.stringify(payload)} delivered text: ${JSON.stringify(sent)}`);
      await page.waitForFunction(m=>{const n=document.querySelector('[data-term-note]');return !n.hidden&&n.textContent===m;},message,{timeout:5000});
      await page.evaluate(()=>{document.querySelector('[data-term-note]').hidden=true;});
    }
    await page.waitForTimeout(800);
    assert.equal(fs.existsSync(marker),false,'no marker file');
    // A safe composition commit still reaches the shell.
    await page.evaluate(new Function('args',`const [p]=args;(${routes.composition.toString()})(p);`),['echo ime-ok']);
    await waitScreen(page,l=>l.some(x=>/sandbox\$ echo ime-ok$/.test(x)),'safe composition typed');
    assert.equal(await page.locator('[data-term-note]').isHidden(),true,'no refusal for a safe composition');
    assert.deepEqual(page.errors,[]);
  });
});

test('BoardTerminal session events across report switches: D1, D10, then a report without a packet',{timeout:240000},async()=>{
  await withFixture('tailnet',async({base,newPage})=>{
    const page=await newPage();
    await openReport(page,base);
    await page.evaluate(()=>{window.__ev=[];
      window.BoardTerminal.on('session',e=>window.__ev.push(e.selector?`session:${e.selector.path}:${e.session.folder}`:null));
      window.BoardTerminal.on('message',m=>{if(m.type==='hello')window.__ev.push('hello:'+window.BoardTerminal.selector().path);});});
    await openDrawer(page);
    assert.equal((await page.evaluate(()=>window.BoardTerminal.session()))?.folder,'reports/D1-sqli-login');
    await page.locator('#report-select').selectOption('findings/confirmed/D10 - HIGH - stored xss.md');
    await page.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:30000});
    await page.waitForFunction(()=>window.BoardTerminal.session()?.folder==='reports/D10-xss',null,{timeout:20000});
    assert.equal(await page.evaluate(()=>window.BoardTerminal.selector().path),'findings/confirmed/D10 - HIGH - stored xss.md');
    await page.locator('#report-select').selectOption('active.md');
    await page.waitForFunction(()=>document.querySelector('[data-term-toggle]')?.disabled===true,null,{timeout:15000});
    await page.waitForTimeout(2000);
    assert.equal(await page.evaluate(()=>window.BoardTerminal.session()),null);
    assert.equal(await page.evaluate(()=>window.BoardTerminal.selector()?.path),'active.md','the selector follows the report even without a terminal');
    assert.deepEqual(await page.evaluate(()=>window.__ev),[
      `session:${REPORT}:reports/D1-sqli-login`,`hello:${REPORT}`,null,
      'session:findings/confirmed/D10 - HIGH - stored xss.md:reports/D10-xss','hello:findings/confirmed/D10 - HIGH - stored xss.md',null]);
    assert.deepEqual(page.errors,[]);
  });
});

// ---- Drag to dock (follow-up): header drag, preview, current vs default dock, two-line side header ----
const headerLines=page=>page.evaluate(()=>{
  const tops=[...document.querySelectorAll('#term-drawer .term-head :is(.term-grip,.term-title,[data-term-status],[data-term-dock],[data-term-sub],.term-actions)')]
    .filter(e=>e.getBoundingClientRect().height>0).map(e=>{const r=e.getBoundingClientRect();return r.top+r.height/2;});
  const rows=[];for(const t of tops.sort((a,b)=>a-b))if(!rows.some(r=>Math.abs(r-t)<8))rows.push(t);
  return rows.length;
});
async function headerDrag(page,to,{steps=8,release=true}={}){
  const b=await page.locator('#term-drawer .term-title').boundingBox();
  const from={x:b.x+b.width/2,y:b.y+b.height/2};
  await page.mouse.move(from.x,from.y);await page.mouse.down();
  await page.mouse.move(to.x,to.y,{steps});
  if(release)await page.mouse.up();
}
test('drag to dock: the header docks the drawer on each edge with a preview; clicks, buttons, Esc, the dead zone and outside drops do not move it',{timeout:300000},async()=>{
  await withFixture('tailnet',async({base,newPage})=>{
    const page=await newPage({permissions:CLIP});
    await openReport(page,base);
    await openDrawer(page);
    const grip=page.locator('#term-drawer .term-grip');
    assert.equal(await grip.getAttribute('aria-label'),'Drag to move the terminal');
    assert.equal(await grip.isVisible(),true);
    await typeLine(page,'echo drag-ok');
    await waitScreen(page,l=>l.some(x=>x.trim()==='drag-ok'),'output');
    await page.locator('[data-term-screen] textarea').focus();
    await setClipboard(page,'sentinel-drag');
    const vw=await page.evaluate(()=>document.documentElement.clientWidth),vh=900;
    const left=(await rect(page,'.app > .sidebar')).right;
    const dockOf=()=>page.locator('#term-drawer').getAttribute('data-dock');
    const preview=page.locator('[data-term-drop-preview]'),edge=page.locator('[data-term-drop-edge]');
    const targets={right:{x:vw-12,y:450},left:{x:left+12,y:450},top:{x:(left+vw)/2,y:12},bottom:{x:(left+vw)/2,y:vh-12}};
    const termFocused=()=>page.evaluate(()=>document.activeElement===window.BoardTerminal.term.textarea);
    const cols0=await page.evaluate(()=>window.BoardTerminal.term.cols);
    for(const dock of ['right','top','bottom','left']){
      await headerDrag(page,targets[dock],{release:false});
      assert.equal(await preview.isVisible(),true,`${dock}: preview visible`);
      assert.equal(await preview.getAttribute('data-dock'),dock);
      assert.equal(await edge.getAttribute('data-edge'),dock);
      await page.waitForTimeout(350);   // the preview animates between targets
      const p=await rect(page,'[data-term-drop-preview]');
      if(dock==='right')assert.ok(Math.abs(p.right-vw)<=1&&p.top===0,JSON.stringify(p));
      if(dock==='left')assert.ok(Math.abs(p.left-left)<=1&&p.top===0,JSON.stringify(p));
      if(dock==='top')assert.ok(p.top===0&&Math.abs(p.left-left)<=1,JSON.stringify(p));
      if(dock==='bottom')assert.ok(Math.abs(p.bottom-vh)<=1,JSON.stringify(p));
      assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('term-dragging')),true);
      if(dock==='right')for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(250);await shot(page,`drag-preview-right-${t}.png`);}
      await page.mouse.up();
      assert.equal(await dockOf(),dock,`${dock}: docked`);
      assert.equal(await preview.isHidden(),true);
      await page.waitForTimeout(250);
      const d=await rect(page,'#term-drawer');
      if(dock==='right')assert.ok(Math.abs(d.right-vw)<=1&&d.top===0,JSON.stringify(d));
      if(dock==='left')assert.ok(Math.abs(d.left-left)<=1&&d.top===0,JSON.stringify(d));
      if(dock==='top')assert.ok(d.top===0,JSON.stringify(d));
      if(dock==='bottom')assert.ok(Math.abs(d.bottom-vh)<=1,JSON.stringify(d));
      await page.evaluate(dk=>window.scrollTo(0,dk==='bottom'?document.documentElement.scrollHeight:0),dock);
      assert.equal(overlaps(await rect(page,'#live-report-host'),await rect(page,'#term-drawer')),false,`${dock}: content not covered`);
      await page.evaluate(()=>window.scrollTo(0,0));
      assert.equal(await termFocused(),true,`${dock}: focus stays in the terminal`);
      if(dock==='right'){
        await page.waitForFunction(c=>window.BoardTerminal.term.cols!==c,cols0,{timeout:5000});   // refit after the drop
        for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(250);await shot(page,`drag-result-right-${t}.png`);}
        await theme(page,'light');
      }
      if(dock==='left'||dock==='right')assert.ok(await headerLines(page)<=2,`${dock}: header at most two lines`);
    }
    // Side headers stay on two lines down to 360 px; screenshots of both sides.
    const handle=page.locator('[data-term-resize]');
    for(const side of ['left','right']){
      await page.locator(`[data-term-dock] [data-dock="${side}"]`).click();
      const w=(await rect(page,'#term-drawer')).width,hb=await handle.boundingBox();
      await page.mouse.move(hb.x+hb.width/2,hb.y+hb.height/2);await page.mouse.down();
      await page.mouse.move(hb.x+hb.width/2+(side==='right'?1:-1)*(w-360),hb.y+hb.height/2,{steps:4});await page.mouse.up();
      assert.ok(Math.abs((await rect(page,'#term-drawer')).width-360)<=2);
      assert.ok(await headerLines(page)<=2,`${side} at 360 px: header at most two lines`);
      assert.equal(await page.locator('[data-term-reset]').getAttribute('title'),'Reset sandbox');
      for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(250);
        if(shots)await page.locator('#term-drawer .term-head').screenshot({path:path.join(shots,`drawer-head-${side}-360-${t}.png`)});
        await shot(page,`dock-${side}-360-${t}.png`);}
      await theme(page,'light');
    }
    await page.locator('[data-term-dock] [data-dock="left"]').click();
    await page.locator('[data-term-screen] textarea').focus();
    // A click on the header, or a move under 6 px, is not a drag.
    await page.locator('#term-drawer .term-title').click();
    let b=await page.locator('#term-drawer .term-title').boundingBox();
    await page.mouse.move(b.x+5,b.y+5);await page.mouse.down();await page.mouse.move(b.x+8,b.y+7,{steps:2});
    assert.equal(await preview.isHidden(),true,'no preview under the threshold');
    await page.mouse.up();
    assert.equal(await dockOf(),'left');
    // Pressing a header button and dragging does not start a drag.
    const btn=await page.locator('[data-term-evidence]').boundingBox();
    await page.mouse.move(btn.x+btn.width/2,btn.y+btn.height/2);await page.mouse.down();await page.mouse.move(targets.right.x,targets.right.y,{steps:6});
    assert.equal(await preview.isHidden(),true,'no drag from a button');
    await page.mouse.up();
    assert.equal(await dockOf(),'left');
    // Esc mid-drag cancels.
    await headerDrag(page,targets.right,{release:false});
    assert.equal(await preview.isVisible(),true);
    await page.keyboard.press('Escape');
    assert.equal(await preview.isHidden(),true);
    await page.mouse.up();
    assert.equal(await dockOf(),'left','Esc cancelled');
    // A window blur mid-drag (Alt+Tab without pointercancel) ends the drag (review G2).
    await headerDrag(page,targets.right,{release:false});
    assert.equal(await preview.isVisible(),true);
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    assert.equal(await preview.isHidden(),true,'blur hides the preview');
    assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('term-dragging')),false,'blur ends the drag');
    await page.mouse.move(targets.right.x-20,targets.right.y,{steps:3});
    assert.equal(await preview.isHidden(),true,'no drag after blur');
    await page.mouse.up();
    assert.equal(await dockOf(),'left','blur cancelled');
    // The middle dead zone keeps the dock (the preview shows the current place, no edge).
    await headerDrag(page,{x:(left+vw)/2+100,y:450},{release:false});
    assert.equal(await preview.getAttribute('data-dock'),'left');
    assert.equal(await edge.isHidden(),true);
    await page.mouse.up();
    assert.equal(await dockOf(),'left','dead zone keeps the dock');
    // Releasing outside the content area (over the sidebar) cancels.
    await headerDrag(page,{x:40,y:450},{release:false});
    assert.equal(await preview.isHidden(),true);
    await page.mouse.up();
    assert.equal(await dockOf(),'left');
    // No terminal selection or clipboard write came from the drags.
    assert.equal(await page.evaluate(()=>window.BoardTerminal.term.hasSelection()),false);
    assert.equal(await clipboard(page),'sentinel-drag');
    assert.equal(await page.evaluate(()=>window.getSelection().toString()),'');

    // Current dock: kept on reload in this tab; a new tab opens at the default; a new default does not move this tab.
    await headerDrag(page,targets.right);
    assert.equal(await dockOf(),'right');
    await page.reload();
    await openReport(page,base);
    await page.locator('#term-drawer').waitFor();
    assert.equal(await dockOf(),'right','reload keeps the current dock');
    const fresh=await sibling(page);
    await openReport(fresh,base);   // the drawer opens by itself (open is remembered)
    await fresh.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
    assert.equal(await fresh.locator('#term-drawer').getAttribute('data-dock'),'bottom','a new tab opens at the default');
    const settings=await sibling(page);
    await settings.goto(`${base}/#/settings`);
    await settings.locator('[data-set-dock="top"]').click();
    await page.waitForFunction(()=>window.BoardTerminal.prefs.dock==='top');
    await fresh.waitForFunction(()=>window.BoardTerminal.prefs.dock==='top');
    assert.equal(await dockOf(),'right','the dragged tab stays');
    assert.equal(await fresh.locator('#term-drawer').getAttribute('data-dock'),'bottom','an open drawer in another tab stays');
    const another=await sibling(page);
    await openReport(another,base);   // the drawer opens by itself (open is remembered)
    await another.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
    assert.equal(await another.locator('#term-drawer').getAttribute('data-dock'),'top','new tabs use the new default');
    assert.deepEqual([...page.errors,...fresh.errors,...settings.errors,...another.errors],[]);
  });
});

test('drag to dock: narrow windows offer no side zones; phones have no grip and no drag',{timeout:180000},async()=>{
  await withFixture('tailnet',async({base,newPage})=>{
    const page=await newPage({viewport:{width:1024,height:800}});
    await openReport(page,base);
    await openDrawer(page);
    const vw=await page.evaluate(()=>document.documentElement.clientWidth);
    await headerDrag(page,{x:vw-12,y:400},{release:false});
    assert.equal(await page.locator('[data-term-drop-edge]').isHidden(),true,'no right zone');
    assert.equal(await page.locator('[data-term-drop-preview]').getAttribute('data-dock'),'bottom');
    await page.mouse.up();
    assert.equal(await page.locator('#term-drawer').getAttribute('data-dock'),'bottom');
    await headerDrag(page,{x:(vw+232)/2,y:12},{release:false});
    assert.equal(await page.locator('[data-term-drop-edge]').getAttribute('data-edge'),'top','top is still offered');
    await page.keyboard.press('Escape');await page.mouse.up();
    assert.deepEqual(page.errors,[]);
    const phone=await newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2});
    await openReport(phone,base);
    await openDrawer(phone);
    assert.equal(await phone.locator('#term-drawer .term-grip').isHidden(),true,'no grip on phones');
    const t=await phone.locator('#term-drawer .term-title').boundingBox();
    await phone.mouse.move(t.x+5,t.y+5);await phone.mouse.down();await phone.mouse.move(380,40,{steps:6});
    assert.equal(await phone.locator('[data-term-drop-preview]').count(),0,'no drag preview on phones');
    await phone.mouse.up();
    const pb=await phone.locator('#term-drawer').boundingBox();
    assert.equal(Math.round(pb.x),0);assert.equal(Math.round(pb.y+pb.height),844);
    assert.equal(await phone.locator('#term-drawer').getAttribute('data-dock'),'bottom');
    assert.deepEqual(phone.errors,[]);
  });
});
