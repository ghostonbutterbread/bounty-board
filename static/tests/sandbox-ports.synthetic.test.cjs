// Sandbox preview ports UI on a synthetic fixture (tests/terminal_browser_fixture.py, mode "ports"):
// Board + terminal service with --preview-ports (test-only local shell, TEST-ONLY Tailscale alias
// 127.0.0.2) + a Serve-like front proxy + a fake agent that reports DIR/ports.json and forwards with
// the real agent's code to a synthetic "sandbox" HTTP server.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

const repo=path.resolve(__dirname,'../..');
const shots=process.env.TERMINAL_SCREENSHOT_DIR;
const REPORT='D1-sqli-login/example-com-sqli-D1.md';
const CLIP=['clipboard-read','clipboard-write'];

async function withFixture(mode,fn){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bp-'));
  const child=spawn('python3',['-u','tests/terminal_browser_fixture.py',dir,mode],{cwd:repo,env:{...process.env,PYTHONPATH:repo},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const info=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));let buf='';child.stdout.on('data',d=>{buf+=d;if(buf.includes('\n'))resolve(JSON.parse(buf.split('\n')[0]));});});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE 127.0.0.2']});
    const newPage=async(options={})=>{
      const context=await browser.newContext({viewport:{width:1280,height:900},...options});
      await context.route('**/*',route=>/^127\.0\.0\.\d+$/.test(new URL(route.request().url()).hostname)?route.continue():route.abort());
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

async function openReport(page,base){
  await page.goto(base);
  await page.getByRole('button',{name:'Open workspace'}).click();
  await page.getByRole('link',{name:'Reports',exact:true}).click();
  await page.locator('#report-select').selectOption(REPORT);
  await page.locator('#live-report-host .live-editor .CodeMirror').waitFor({timeout:15000});
}
async function openDrawer(page){
  if(await page.locator('#term-drawer').isHidden().catch(()=>true))await page.locator('[data-term-toggle]').click();
  await page.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
}
const get=url=>new Promise((resolve,reject)=>{http.get(url,res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({status:res.statusCode,body}));}).on('error',reject);});
async function shot(page,name){if(shots){fs.mkdirSync(shots,{recursive:true});await page.screenshot({path:path.join(shots,name)});}}
async function theme(page,value){await page.evaluate(v=>{localStorage.setItem('bounty-board-theme',v);document.documentElement.dataset.theme=v;},value);}
const pill=page=>page.locator('#term-drawer [data-term-slot="ports"] [data-ports-pill]');
const popover=page=>page.locator('[data-ports-popover]');
const rect=(page,selector)=>page.evaluate(s=>{const el=document.querySelector(s);if(!el)return null;const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom};},selector);
function setPorts(info,ports){fs.writeFileSync(info.ports_file,JSON.stringify(ports));}
async function openSettings(page){
  await page.locator('a[href="#/settings"]').first().click();
  await page.locator('[data-settings-section="terminal-ports"] [data-ports-tailscale],[data-settings-section="terminal-ports"] [data-ports-disabled]').first().waitFor({timeout:15000});
}
const section=page=>page.locator('[data-settings-section="terminal-ports"]');
const live=page=>page.locator('#term-drawer [data-term-strip="ports"] [data-ports-live]');
// Viewport position of the middle of buffer cells [col, col+len) on the first line that contains `needle`.
async function cellOf(page,needle,offset=0){
  return page.evaluate(([needle,offset])=>{
    const t=window.BoardTerminal.term,b=t.buffer.active;
    for(let i=b.length-1;i>=0;i--){
      const text=b.getLine(i).translateToString(true),col=text.indexOf(needle);
      if(col<0)continue;
      const r=document.querySelector('#term-drawer .xterm-screen').getBoundingClientRect();
      const w=r.width/t.cols,h=r.height/t.rows,row=i-b.viewportY;
      return {x:r.left+(col+offset+0.5)*w,y:r.top+(row+0.5)*h,w,h};
    }
    return null;
  },[needle,offset]);
}

test('ports pill and popover follow the sandbox; Tailscale switch round-trips through the server',{timeout:300000},async()=>{
  await withFixture('tailnet,ports',async info=>{
    const {base,newPage,sandbox_port:sandboxPort}=info;
    const page=await newPage({permissions:CLIP});
    await openReport(page,base);
    await openDrawer(page);
    assert.equal(await pill(page).count(),0,'no pill without ports');
    assert.equal(await page.locator('#term-drawer [data-term-slot="ports"]').isHidden(),true);

    // A server starts listening in the sandbox: the pill appears by push, no reload.
    setPorts(info,[sandboxPort]);
    await pill(page).waitFor({timeout:15000});
    assert.equal((await pill(page).textContent()).trim(),'1 port');
    const item=(await page.evaluate(()=>window.BoardPorts.ports))[0];
    const [lo,hi]=info.ports_range;
    assert.ok(item.host_port>=lo&&item.host_port<=hi,JSON.stringify(item));
    assert.equal(item.local_url,`http://127.0.0.1:${item.host_port}/`);
    assert.equal(item.tailscale_url,null);
    assert.match((await get(item.local_url)).body,/synthetic-preview-ok/,'the host port reaches the sandbox server');

    // Popover, Tailscale off: only the local URL plus the Settings hint.
    await pill(page).click();
    await popover(page).waitFor();
    assert.equal(await pill(page).getAttribute('aria-expanded'),'true');
    assert.equal(await popover(page).getAttribute('role'),'dialog');
    assert.equal((await popover(page).locator('.term-ports-port code').textContent()),`:${sandboxPort}`);
    assert.deepEqual(await popover(page).locator('[data-ports-url]').evaluateAll(as=>as.map(a=>a.textContent)),[item.local_url]);
    assert.equal(await popover(page).locator('.term-ports-where').count(),0);
    {
      const a=popover(page).locator('[data-ports-url]').first();
      assert.equal(await a.getAttribute('href'),item.local_url);
      assert.equal(await a.getAttribute('target'),'_blank');
      assert.equal(await a.getAttribute('rel'),'noopener noreferrer');
      assert.equal(await a.getAttribute('title'),'Ctrl+click to open, click to copy');
    }
    assert.equal(await popover(page).locator('button,[data-ports-open],[data-ports-copy]').count(),0,'no Open or Copy buttons');
    assert.equal((await popover(page).locator('[data-ports-note]').textContent()).trim(),'Only reachable on the server. Turn on Tailscale in Settings.');
    assert.equal(await popover(page).locator('[data-ports-settings]').getAttribute('href'),'#/settings');
    // Keyboard: focus starts inside, Esc closes and returns focus to the pill.
    assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('[data-ports-popover]')),true);
    // A plain click on the URL copies it and says so (no navigation, no new tab).
    let popups=0;page.context().on('page',()=>popups++);
    await popover(page).locator('[data-ports-url]').click();
    await popover(page).locator('[data-ports-copied]').filter({hasText:'Copied'}).waitFor({timeout:5000});
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),item.local_url);
    assert.equal(popups,0,'a plain click does not open');
    assert.equal(new URL(page.url()).origin,base);
    // The live line under the header, Tailscale off: the local URL and the Settings hint.
    await live(page).waitFor();
    assert.equal((await live(page).locator('.term-ports-live-text').textContent()).trim(),`Port ${sandboxPort} is live`);
    assert.equal(await live(page).locator('[data-ports-url]').getAttribute('href'),item.local_url);
    assert.equal((await live(page).locator('[data-ports-note]').textContent()).trim(),'Only reachable on the server. Turn on Tailscale in Settings.');
    assert.equal(await live(page).locator('[data-ports-settings]').getAttribute('href'),'#/settings');
    assert.equal(await live(page).locator('button').count(),0,'no Open or Copy buttons');
    for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(250);await shot(page,`ports-popover-bottom-off-${t}.png`);}
    await page.keyboard.press('Escape');
    await popover(page).waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>document.activeElement?.matches('[data-ports-pill]')),true,'focus back on the pill');
    // Click outside closes.
    await pill(page).click();await popover(page).waitFor();
    await page.mouse.click(640,120);
    await popover(page).waitFor({state:'detached'});

    // Settings: off, then on through the server.
    await openSettings(page);
    const sw=section(page).locator('[data-ports-tailscale]');
    assert.equal(await sw.isChecked(),false);
    assert.equal(await sw.getAttribute('role'),'switch');
    assert.match(await section(page).textContent(),/Saved on the server\./);
    assert.match(await section(page).locator('[data-ports-address]').textContent(),/detected when you turn this on/);
    assert.equal((await section(page).locator('[data-ports-acl]').textContent()).trim(),'While this is on, anyone on your tailnet allowed by your ACLs can open sandbox ports. They are plain http and can be on almost any port number, not only the range above.');
    assert.match(await section(page).textContent(),/on the same port number as in the sandbox when that number is free/);
    for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(250);await shot(page,`ports-settings-off-${t}.png`);}
    // No Tailscale address on the server: 409 with the plain message; the switch stays off.
    fs.writeFileSync(info.tailscale_file,'');
    await sw.click();
    await section(page).locator('[data-ports-settings-msg]').filter({hasText:'No Tailscale address found on the server.'}).waitFor({timeout:10000});
    assert.equal(await section(page).locator('[data-ports-tailscale]').isChecked(),false,'reflects the server, not a guess');
    fs.writeFileSync(info.tailscale_file,'127.0.0.2');
    await section(page).locator('[data-ports-tailscale]').click();
    await section(page).locator('[data-ports-address]').filter({hasText:'Tailscale address 127.0.0.2'}).waitFor({timeout:10000});
    assert.equal(await section(page).locator('[data-ports-tailscale]').isChecked(),true);
    const settings=await page.evaluate(async()=>(await fetch('/terminal/api/settings',{credentials:'same-origin'})).json());
    assert.equal(settings.ports_tailscale,true);
    for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(250);await shot(page,`ports-settings-on-${t}.png`);}

    // Back to the report: the Tailscale URL is the main one, the local one is "on the server".
    await openReport(page,base);
    await openDrawer(page);
    await pill(page).waitFor({timeout:15000});
    await page.waitForFunction(()=>window.BoardPorts.ports[0]?.tailscale_url);
    await pill(page).click();await popover(page).waitFor();
    // Same number on the Tailscale address (a loopback alias here) as in the sandbox; loopback keeps the range number.
    const tsUrl=`http://127.0.0.2:${sandboxPort}/`;
    const onItem=(await page.evaluate(()=>window.BoardPorts.ports))[0];
    assert.equal(onItem.tailscale_port,sandboxPort);
    assert.equal(onItem.host_port,item.host_port);
    assert.equal(onItem.local_url,item.local_url);
    assert.deepEqual(await popover(page).locator('[data-ports-url]').evaluateAll(as=>as.map(a=>a.textContent)),[tsUrl,item.local_url]);
    assert.equal((await popover(page).locator('.term-ports-url.secondary .term-ports-where').textContent()).trim(),'on the server');
    assert.equal(await popover(page).locator('[data-ports-note]').count(),0);
    assert.equal(await popover(page).locator('[data-ports-url]').first().getAttribute('href'),tsUrl);
    assert.match((await get(tsUrl)).body,/synthetic-preview-ok/,'reachable on the Tailscale address');
    await assert.rejects(get(`http://127.0.0.2:${item.host_port}/`),'no tailnet listener on the range number');
    await popover(page).locator('[data-ports-url]').first().click();
    await popover(page).locator('[data-ports-copied]').filter({hasText:'Copied'}).waitFor({timeout:5000});
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),tsUrl);
    for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(250);await shot(page,`ports-popover-bottom-on-${t}.png`);}
    // Ctrl+click on a popover URL opens it in a new tab.
    {
      const [opened]=await Promise.all([page.context().waitForEvent('page'),popover(page).locator('[data-ports-url]').first().click({modifiers:['Control']})]);
      await opened.waitForLoadState('domcontentloaded').catch(()=>{});
      assert.equal(opened.url(),tsUrl);
      await opened.close();
    }
    await page.keyboard.press('Escape');

    // Live line, Tailscale on: the Tailscale URL, "over Tailscale"; click copies, Ctrl+click and middle click open.
    await live(page).locator('[data-ports-url]').filter({hasText:tsUrl}).waitFor({timeout:10000});
    assert.equal((await live(page).locator('.term-ports-where').textContent()).trim(),'over Tailscale');
    assert.equal(await live(page).locator('[data-ports-note]').count(),0);
    await page.evaluate(()=>navigator.clipboard.writeText('-'));
    await live(page).locator('[data-ports-url]').click();
    await live(page).locator('[data-ports-copied]').filter({hasText:'Copied'}).waitFor({timeout:5000});
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),tsUrl);
    {
      const [opened]=await Promise.all([page.context().waitForEvent('page'),live(page).locator('[data-ports-url]').click({modifiers:['Control']})]);
      await opened.waitForLoadState('domcontentloaded').catch(()=>{});
      assert.equal(opened.url(),tsUrl,'Ctrl+click opens');
      assert.equal(await opened.evaluate(()=>window.opener),null,'noopener');
      await opened.close();
    }
    {
      const [opened]=await Promise.all([page.context().waitForEvent('page'),live(page).locator('[data-ports-url]').click({button:'middle'})]);
      assert.equal(opened.url(),tsUrl,'middle click opens natively');
      await opened.close();
    }
    // Copy blocked by the browser.
    await page.evaluate(()=>{window.__clip=navigator.clipboard.writeText;navigator.clipboard.writeText=()=>Promise.reject(new Error('blocked'));window.__exec=document.execCommand;document.execCommand=()=>false;});
    await live(page).locator('[data-ports-url]').click();
    await live(page).locator('[data-ports-copied]').filter({hasText:'Copy blocked by the browser'}).waitFor({timeout:5000});
    await page.evaluate(()=>{navigator.clipboard.writeText=window.__clip;document.execCommand=window.__exec;});
    await live(page).locator('[data-ports-copied]').waitFor({state:'detached',timeout:5000});

    // Terminal links: a printed loopback URL for the forwarded port opens the Tailscale URL, path kept.
    await page.locator('#term-drawer .xterm').click();
    await page.keyboard.type(`printf 'serving http://localhost:%s/poc/x.html?a=1#f, not http://127.0.0.1:%s/\\n' ${sandboxPort} 9\n`);
    const printed=`http://localhost:${sandboxPort}/poc/x.html?a=1#f`;
    const target=`http://127.0.0.2:${sandboxPort}/poc/x.html?a=1#f`;
    await page.waitForFunction(p=>{const b=window.BoardTerminal.term.buffer.active;for(let i=0;i<b.length;i++)if(b.getLine(i).translateToString(true).startsWith('serving '+p))return true;return false;},printed,{timeout:10000});
    const at=await cellOf(page,'serving '+printed,12);
    await page.mouse.move(at.x,at.y);
    const tip=page.locator('[data-ports-tip]');
    await tip.waitFor({timeout:5000});
    assert.equal(await tip.locator('.term-ports-tip-title').textContent(),'Opens over Tailscale');
    assert.equal(await tip.locator('.term-ports-tip-url').textContent(),target);
    assert.equal(await tip.locator('.term-ports-tip-hint').textContent(),'Ctrl+click to open, click to copy');
    for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(300);await page.mouse.move(at.x+1,at.y);await tip.waitFor();await shot(page,`ports-live-link-${t}.png`);}
    await page.evaluate(()=>navigator.clipboard.writeText('-'));
    await page.mouse.click(at.x,at.y);
    await tip.locator('.term-ports-tip-hint').filter({hasText:'Copied'}).waitFor({timeout:5000});
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),target,'a click copies the Tailscale URL');
    for(const key of ['Control','Meta']){
      const [opened]=await Promise.all([page.context().waitForEvent('page'),(async()=>{await page.keyboard.down(key);await page.mouse.click(at.x,at.y);await page.keyboard.up(key);})()]);
      await opened.waitForLoadState('domcontentloaded').catch(()=>{});
      assert.equal(opened.url(),target,`${key}+click opens the Tailscale URL with the path`);
      assert.equal(await opened.evaluate(()=>window.opener),null,'noopener');
      await opened.close();
    }
    assert.equal(await tip.evaluate(el=>el.querySelectorAll('*').length),3,'the tip holds text only');
    // Which printed text becomes a link, and where it goes.
    const P=sandboxPort,T=`http://127.0.0.2:${P}`;
    const cases=[
      [`http://localhost:${P}/`,`${T}/`],[`http://LOCALHOST:${P}`,`${T}/`],[`http://0.0.0.0:${P}/a`,`${T}/a`],
      [`http://127.5.6.7:${P}/x?q=1#h`,`${T}/x?q=1#h`],[`http://[::1]:${P}/p`,`${T}/p`],[`http://[::]:${P}/`,`${T}/`],
      [`http://localhost:${P}/x).`,`${T}/x`],[`https://localhost:${P}/s`,`https://127.0.0.2:${P}/s`],
      [`http://localhost:${P}/%3Cb%3E`,`${T}/%3Cb%3E`],[`http://localhost:${P}/../../etc`,`${T}/etc`],
      [`http://localhost:${P+1}/`,null],[`http://localhost/`,null],[`http://evil.example:${P}/`,null],[`http://10.0.0.1:${P}/`,null],
      [`http://127.0.0.1.evil.example:${P}/`,null],[`http://a@localhost:${P}/`,null],[`http://localhost:${P}@evil.example/`,null],
      [`http://127.0.0.999:${P}/`,null],[`http://[::2]:${P}/`,null],[`ftp://localhost:${P}/`,null],[`javascript:localhost:${P}`,null],
      [`http://localhost:${P}evil/`,null]];
    const got=await page.evaluate(list=>list.map(([text])=>window.BoardPorts.linkTarget(text)?.url??null),cases);
    assert.deepEqual(got,cases.map(c=>c[1]));
    // The port that is not forwarded is not a link.
    await page.mouse.move(0,0);await tip.waitFor({state:'detached',timeout:5000});
    const notLink=await cellOf(page,'http://127.0.0.1:9/',8);
    await page.mouse.move(notLink.x,notLink.y);await page.waitForTimeout(400);
    assert.equal(await tip.count(),0,'unforwarded port: no link');
    // Dragging across the link still selects text, and copy-on-select copies the selection.
    await page.evaluate(()=>navigator.clipboard.writeText('-'));
    const from=await cellOf(page,'serving '+printed,0);
    await page.mouse.move(from.x,from.y);await page.mouse.down();
    await page.mouse.move(at.x+from.w*6,at.y,{steps:8});await page.mouse.up();
    await page.waitForTimeout(300);
    const selected=await page.evaluate(()=>window.BoardTerminal.term.getSelection());
    assert.ok(selected.length>=15&&('serving '+printed).startsWith(selected),`a drag into the link selects text: ${selected}`);
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),selected,'copy-on-select still copies the selection');
    await page.evaluate(()=>window.BoardTerminal.term.clearSelection());

    // Another tab switches it off: this drawer's URLs update by push.
    const other=await page.context().newPage();
    await other.goto(`${base}/#/settings`);
    await section(other).locator('[data-ports-tailscale]').waitFor({timeout:15000});
    assert.equal(await section(other).locator('[data-ports-tailscale]').isChecked(),true);
    await section(other).locator('[data-ports-tailscale]').click();
    await section(other).locator('[data-ports-address]').filter({hasText:'detected when you turn this on'}).waitFor({timeout:10000});
    await page.waitForFunction(()=>window.BoardPorts.ports[0]&&window.BoardPorts.ports[0].tailscale_url===null&&window.BoardPorts.flags.ports_tailscale===false,null,{timeout:10000});
    await assert.rejects(get(tsUrl),'the tailnet listener is closed');
    await pill(page).click();await popover(page).waitFor();
    assert.equal(await popover(page).locator('[data-ports-note]').count(),1);
    await page.keyboard.press('Escape');
    await other.close();

    // Docks: the pill works left, right and top; dragging from it never starts a drag.
    for(const dock of ['right','left','top','bottom']){
      await page.locator(`[data-term-dock] [data-dock="${dock}"]`).click();
      await page.waitForFunction(d=>document.querySelector('#term-drawer').dataset.dock===d,dock);
      await pill(page).click();await popover(page).waitFor();
      const p=await rect(page,'[data-ports-popover]');
      assert.ok(p.left>=0&&p.top>=0&&p.right<=1280&&p.bottom<=900,`${dock}: popover inside the viewport ${JSON.stringify(p)}`);
      if(dock==='right')for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(250);await shot(page,`ports-popover-right-${t}.png`);}
      await page.keyboard.press('Escape');
      await popover(page).waitFor({state:'detached'});
      // The live line is visible inside the drawer in every dock and never starts a drag.
      const drawerBox=await page.locator('#term-drawer').boundingBox(),lineBox=await live(page).boundingBox();
      assert.ok(lineBox&&lineBox.height>0&&lineBox.x>=drawerBox.x-1&&lineBox.x+lineBox.width<=drawerBox.x+drawerBox.width+1,`${dock}: live line inside the drawer`);
      const text=live(page).locator('.term-ports-live-port,.term-ports-live-text').first();
      const tb=await text.boundingBox();
      await page.mouse.move(tb.x+4,tb.y+tb.height/2);await page.mouse.down();
      await page.mouse.move(tb.x-150,tb.y-150,{steps:6});
      const lineDrag=await page.evaluate(()=>document.documentElement.classList.contains('term-dragging')||!!document.querySelector('[data-term-drop-preview]:not([hidden])'));
      await page.mouse.up();
      assert.equal(lineDrag,false,`${dock}: no drag from the live line`);
      const box=await pill(page).boundingBox();
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
      await page.mouse.move(box.x+box.width/2-150,box.y+box.height/2-150,{steps:6});
      const dragging=await page.evaluate(()=>document.documentElement.classList.contains('term-dragging')||!!document.querySelector('[data-term-drop-preview]:not([hidden])'));
      await page.mouse.up();
      assert.equal(dragging,false,`${dock}: no drag from the pill`);
      assert.equal(await page.evaluate(()=>document.querySelector('#term-drawer').dataset.dock),dock,'dock unchanged');
    }

    // The server stops listening: the pill goes away by push.
    setPorts(info,[]);
    await pill(page).waitFor({state:'detached',timeout:15000});
    assert.equal(await page.locator('#term-drawer [data-term-slot="ports"]').isHidden(),true);
    assert.equal(await page.locator('#term-drawer [data-term-strip="ports"]').isHidden(),true,'no live line without ports');
    assert.deepEqual(page.errors,[]);
  });
});

test('phone sheet: the pill and popover fit',{timeout:120000},async()=>{
  await withFixture('tailnet,ports',async info=>{
    const page=await info.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2});
    await openReport(page,info.base);
    await openDrawer(page);
    setPorts(info,[info.sandbox_port]);
    await pill(page).waitFor({timeout:15000});
    await pill(page).tap();
    await popover(page).waitFor();
    const p=await rect(page,'[data-ports-popover]');
    assert.ok(p.left>=0&&p.right<=390&&p.top>=0&&p.bottom<=844,JSON.stringify(p));
    for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(250);await shot(page,`ports-phone-${t}.png`);}
    await page.keyboard.press('Escape');
    // Touch only: a tap on a URL opens it (no copy), in the live line too.
    assert.equal(await page.evaluate(()=>matchMedia('(any-pointer: fine)').matches),false,'touch-only emulation');
    await live(page).waitFor();
    const lb=await live(page).boundingBox();
    assert.ok(lb.x>=0&&lb.x+lb.width<=390,JSON.stringify(lb));
    const [opened]=await Promise.all([page.context().waitForEvent('page'),live(page).locator('[data-ports-url]').tap()]);
    assert.equal(opened.url(),(await page.evaluate(()=>window.BoardPorts.ports[0].local_url)));
    await opened.close();
    assert.deepEqual(page.errors,[]);
  });
});

test('popover links only http URLs to loopback or a Tailscale address on the host port (review P1)',{timeout:240000},async()=>{
  await withFixture('tailnet,ports',async info=>{
    const page=await info.newPage({permissions:CLIP});
    const reply={preview_ports:true,ports_tailscale:true,ports:[
      {port:8000,host_port:9100,state:'open',local_url:'javascript:document.title="pwned"//',tailscale_url:'http://evil.example/'},
      {port:8001,host_port:9101,state:'open',local_url:'http://127.0.0.1:9999/',tailscale_url:'http://100.64.1.2:9101/x?y'},
      {port:8002,host_port:9102,state:'open',local_url:'http://127.0.0.1:9102/',tailscale_url:'http://100.101.102.103:9102/'}]};
    await page.route('**/api/ports?**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(reply)}));
    await openReport(page,info.base);
    await openDrawer(page);
    await pill(page).waitFor({timeout:15000});
    await pill(page).click();
    await popover(page).waitFor();
    const hrefs=await popover(page).locator('a[href]').evaluateAll(as=>as.map(a=>a.getAttribute('href')).filter(h=>h!=='#/settings'));
    const valid=['http://100.101.102.103:9102/','http://127.0.0.1:9102/'];
    assert.deepEqual([...new Set(hrefs)].sort(),valid.sort(),'only the valid URLs are links');
    assert.equal(await popover(page).locator('[data-ports-copy],[data-ports-open]').count(),0);
    assert.equal(await popover(page).locator('[data-ports-invalid]').count(),4,'the four bad URLs are shown as text');
    assert.match(await popover(page).locator('[data-ports-invalid]').first().textContent(),/not linked/);
    assert.notEqual(await page.title(),'pwned');
    // Live line with several ports: two shown, bad URLs as text, "+1 more" opens the full list.
    await page.keyboard.press('Escape');
    await popover(page).waitFor({state:'detached'});
    assert.equal((await live(page).locator('.term-ports-live-text').textContent()).trim(),'3 ports live');
    assert.deepEqual(await live(page).locator('.term-ports-live-port code').allTextContents(),[':8000',':8001']);
    assert.equal(await live(page).locator('a[data-ports-url]').count(),0,'the two shown URLs are invalid: no links');
    assert.equal(await live(page).locator('[data-ports-invalid]').count(),2);
    await live(page).locator('[data-ports-more]').click();
    await popover(page).waitFor();
    assert.equal(await popover(page).locator('[data-ports-item]').count(),3);
    assert.deepEqual(page.errors,[]);
  });
});

test('preview ports off on the server: no pill, Settings says it is not enabled',{timeout:120000},async()=>{
  await withFixture('tailnet',async({base,newPage})=>{
    const page=await newPage();
    await openReport(page,base);
    await openDrawer(page);
    await page.waitForTimeout(1500);
    assert.equal(await pill(page).count(),0);
    assert.equal(await page.evaluate(()=>window.BoardPorts.flags.preview_ports),false);
    await openSettings(page);
    assert.equal((await section(page).locator('[data-ports-disabled]').textContent()).trim(),'Not enabled on this server. Start the terminal service with --preview-ports.');
    assert.equal(await section(page).locator('[data-ports-tailscale]').count(),0);
    assert.deepEqual(page.errors,[]);
  });
});

test('not signed in to the terminal: Settings links to the sign-in page with a same-origin next',{timeout:120000},async()=>{
  await withFixture('login,ports',async({base,newPage})=>{
    const page=await newPage();
    await page.goto(`${base}/#/settings`);
    const link=section(page).locator('[data-ports-login]');
    await link.waitFor({timeout:15000});
    assert.equal((await link.textContent()).trim(),'Sign in to the terminal');
    const href=new URL(await link.getAttribute('href'),base);
    assert.equal(href.origin,base);
    assert.equal(href.pathname,'/terminal/login');
    assert.equal(href.searchParams.get('next'),'/#/settings');
    assert.equal(await section(page).locator('[data-ports-tailscale]').count(),0);
    assert.deepEqual(page.errors,[]);
  });
});
