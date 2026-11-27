// Report agent UI on a synthetic fixture (tests/report_agent_browser_fixture.py): Board +
// terminal service (test-only local backend) with the fake CLI as "claude", a fake TLS model
// upstream and a fake Herdr. Never a real CLI, login, Herdr or Anthropic.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

const repo=path.resolve(__dirname,'../..');
const shots=process.env.REPORT_AGENT_SCREENSHOT_DIR;
const REPORT='D1-sqli-login/example-com-sqli-D1.md';
const UNSAFE_MESSAGE='This block contains control characters and cannot be typed; copy it manually after review.';

async function withFixture(mode,fn){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ra-'));
  const child=spawn('python3',['-u','tests/report_agent_browser_fixture.py',dir,mode],{cwd:repo,env:{...process.env,PYTHONPATH:repo},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const info=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));let buf='';child.stdout.on('data',d=>{buf+=d;if(buf.includes('\n'))resolve(JSON.parse(buf.split('\n')[0]));});});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const newPage=async(options={})=>{
      const context=await browser.newContext({viewport:{width:1280,height:900},...options});
      await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
      const page=await context.newPage();
      page.errors=[];page.on('pageerror',e=>page.errors.push(String(e)));
      page.starts=[];page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/agent/start'))page.starts.push(JSON.parse(r.postData()));});
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
const tabText=(page,id)=>page.evaluate(id=>{const t=window.BoardReportAgent.tabTerm(id);if(!t)return '';const b=t.buffer.active;const out=[];for(let i=0;i<b.length;i++)out.push(b.getLine(i).translateToString(true));return out.join('\n');},id);
async function waitTab(page,id,re,label){
  for(let i=0;i<150;i++){const text=await tabText(page,id);if(re.test(text))return text;await page.waitForTimeout(100);}
  throw new Error(`tab ${id} never showed ${label}: ${JSON.stringify((await tabText(page,id)).split('\n').filter(Boolean).slice(-12))}`);
}
async function typeInTab(page,id,text){await page.locator(`[data-term-tab-screen="${id}"] textarea`).focus();await page.keyboard.type(text);}
const agentButton=page=>page.locator('[data-agent-toggle]');
// Puts the report bar near the top, as when working on a report, so the popover opens below at full height.
const barToTop=page=>page.evaluate(()=>{const b=document.querySelector('[data-agent-toggle]');window.scrollBy(0,b.getBoundingClientRect().top-80);});
const popover=page=>page.locator('[data-agent-popover]');
async function shot(page,name,locator){if(!shots)return;fs.mkdirSync(shots,{recursive:true});const file=path.join(shots,`report-agent-ui-${name}.png`);if(locator)await locator.screenshot({path:file});else await page.screenshot({path:file});}
// Toasts ("Reports loaded") sit over the Settings card; dismiss them before a screenshot (review U5).
async function dismissToasts(page){
  await page.waitForLoadState('networkidle').catch(()=>{});
  let quiet=0;
  for(let i=0;i<60&&quiet<5;i++){
    const b=page.locator('#toasts .toast button');
    if(await b.count()){quiet=0;await b.first().click().catch(()=>{});}else quiet++;
    await page.waitForTimeout(150);
  }
}
// Every hint in the Agent section fits on one line at the screenshot width (review U5).
async function oneLineHints(page){
  const wrapped=await page.evaluate(()=>[...document.querySelectorAll('[data-settings-section="agent"] .hint')].filter(e=>e.offsetParent&&e.textContent.trim()).map(e=>({t:e.textContent,h:e.getBoundingClientRect().height,lh:parseFloat(getComputedStyle(e).lineHeight)||18})).filter(x=>x.h>x.lh*1.5));
  assert.deepEqual(wrapped,[],'hints wrap');
}
// One capture of everything the page saw, and one scan for a token in all of it (review U4):
// request URLs, headers and bodies; response headers and bodies; console messages; page errors;
// the DOM and every field value; local and session storage; the URL. `allowed` lists the request
// bodies that may carry a token (the login POSTs), each exactly once.
// WebSocket frames, sent and received, come from CDP (Network.webSocketFrameSent/Received, review rv2 V7).
async function tokenCapture(page){
  const cap={requests:[],responses:[],console:[],errors:[],pending:[],frames:[],unreadable:[]};
  page.on('request',r=>cap.requests.push({url:r.url(),body:r.postData()||'',headers:JSON.stringify(r.headers())}));
  page.on('response',r=>cap.pending.push((async()=>{let body='';try{body=await r.text();}catch{cap.unreadable.push(`${r.status()} ${r.url()}`);}cap.responses.push({url:r.url(),body,headers:JSON.stringify(await r.allHeaders().catch(()=>({})))});})()));
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated',e=>cap.frames.push({dir:'created',data:e.url}));
  cdp.on('Network.webSocketFrameSent',e=>cap.frames.push({dir:'sent',data:e.response.payloadData}));
  cdp.on('Network.webSocketFrameReceived',e=>cap.frames.push({dir:'received',data:e.response.payloadData}));
  page.on('console',m=>cap.console.push(m.text()));
  page.on('pageerror',e=>cap.errors.push(String(e)));
  cap.scan=async(label,mark,allowed=[])=>{
    await Promise.all(cap.pending);
    const page_=await page.evaluate(()=>({dom:document.documentElement.outerHTML,values:[...document.querySelectorAll('input,textarea')].map(i=>i.value).join('|'),
      local:JSON.stringify({...localStorage}),session:JSON.stringify({...sessionStorage}),url:location.href}));
    for(const [where,text] of Object.entries(page_))assert.doesNotMatch(text,mark,`${label}: token in ${where}`);
    for(const r of cap.responses)assert.doesNotMatch(r.url+r.body+r.headers,mark,`${label}: token in the response of ${r.url}`);
    assert.doesNotMatch(cap.console.join('\n'),mark,`${label}: token in the console`);
    assert.doesNotMatch(cap.errors.join('\n'),mark,`${label}: token in a page error`);
    for(const f of cap.frames)assert.doesNotMatch(f.data,mark,`${label}: token in a WebSocket frame (${f.dir})`);
    // A body Playwright cannot read is said, not skipped silently; the Board's and the service's API bodies must be readable.
    assert.deepEqual(cap.unreadable.filter(u=>/\/api\//.test(u)),[],`${label}: unreadable API response bodies`);
    const carrying=cap.requests.filter(r=>mark.test(r.url+r.body+r.headers));
    assert.deepEqual(carrying.map(r=>r.body).sort(),allowed.map(a=>JSON.stringify(a)).sort(),`${label}: only the login POST bodies carry a token`);
    for(const r of carrying){assert.match(r.url,/\/terminal\/api\/agent\/login$/);assert.doesNotMatch(r.url+r.headers,mark);}
    return {requests:cap.requests.length,responses:cap.responses.length,console:cap.console.length,frames:cap.frames.length,unreadable:cap.unreadable.length};
  };
  return cap;
}
async function theme(page,value){await page.evaluate(v=>{localStorage.setItem('bounty-board-theme',v);document.documentElement.dataset.theme=v;},value);}
async function noWrap(page,selector,label){
  const bad=await page.evaluate(sel=>[...document.querySelectorAll(sel)].filter(el=>el.offsetParent!==null).map(el=>{const r=el.getBoundingClientRect();const lh=parseFloat(getComputedStyle(el).lineHeight)||18;return {text:el.textContent,h:r.height,lh,cut:el.scrollWidth>el.clientWidth+1&&getComputedStyle(el).textOverflow!=='ellipsis'};}).filter(x=>x.h>x.lh*1.6+6||x.cut),selector);
  assert.deepEqual(bad,[],`${label}: wrapped or cut`);
}
async function insideViewport(page,locator,label){
  const box=await locator.boundingBox();const vp=page.viewportSize();
  assert.ok(box&&box.x>=0&&box.y>=0&&box.x+box.width<=vp.width+1&&box.y+box.height<=vp.height+1,`${label} is inside the window: ${JSON.stringify(box)}`);
}

test('settings: Agent section loads and saves the CLI and model; login and connect status',{timeout:180000},async()=>{
  await withFixture('',async({base,newPage,dir})=>{
    const page=await newPage();
    await page.goto(`${base}/#/settings`);
    const section=page.locator('[data-settings-group="terminal"] [data-settings-section="agent"]');
    await section.locator('select[name="set-agent-cli"]').waitFor({timeout:15000});
    assert.equal(await section.locator('h3').textContent(),'Agent');
    const options=await section.locator('select[name="set-agent-cli"] option').evaluateAll(os=>os.map(o=>({v:o.value,t:o.textContent,d:o.disabled})));
    assert.deepEqual(options.map(o=>o.v),['claude','codex','omp','opencode'],'every CLI is listed');
    assert.equal(options[0].d,false);
    for(const o of options.slice(1)){assert.equal(o.d,true,`${o.v} disabled`);assert.match(o.t,/Needs a sandbox login on Hoster/);}
    assert.deepEqual(await section.locator('select[name="set-agent-model"] option').evaluateAll(os=>os.map(o=>o.value)),['default','opus','sonnet','haiku','__custom']);
    assert.equal(await section.locator('[data-agent-login]').textContent(),'Sandbox login ready');
    assert.equal(await section.locator('[data-agent-connect-flag]').textContent(),'Connect to running agents: on');
    assert.match(await section.textContent(),/every device/,'host-wide setting says so');
    assert.equal(await section.locator('input[type="checkbox"]').count(),0,'connect is a service flag: no toggle');
    const save=section.locator('[data-agent-save]');
    assert.equal(await save.isDisabled(),true,'nothing to save yet');
    await section.locator('select[name="set-agent-model"]').selectOption('opus');
    await save.click();
    await section.locator('[data-agent-settings-msg]').filter({hasText:'Saved for every device.'}).waitFor();
    const stored=()=>JSON.parse(fs.readFileSync(path.join(dir,'term-state','agent-settings.json'),'utf8'));
    assert.equal(stored().report_agent_model,'opus');
    // Custom model: validated before saving.
    await section.locator('select[name="set-agent-model"]').selectOption('__custom');
    const custom=section.locator('input[name="set-agent-custom"]');
    await custom.fill('Bad_Model');
    assert.equal(await save.isDisabled(),true);
    assert.match(await section.locator('[data-agent-settings-msg]').textContent(),/lowercase letters/);
    assert.equal(await custom.getAttribute('aria-invalid'),'true');
    await custom.fill('claude-synthetic-9');
    assert.equal(await save.isDisabled(),false);
    await save.click();
    await section.locator('[data-agent-settings-msg]').filter({hasText:'Saved for every device.'}).waitFor();
    assert.equal(stored().report_agent_model,'claude-synthetic-9');
    await page.reload();
    await section.locator('input[name="set-agent-custom"]').waitFor({timeout:15000});
    assert.equal(await section.locator('select[name="set-agent-model"]').inputValue(),'__custom');
    assert.equal(await section.locator('input[name="set-agent-custom"]').inputValue(),'claude-synthetic-9');
    assert.doesNotMatch(await section.textContent(),/sk-ant/,'never a token');
    assert.equal(await section.locator('.ra-login-controls [data-agent-login]').count(),1,'login pill right-aligned with the controls');
    await oneLineHints(page);
    await dismissToasts(page);
    assert.equal(await page.locator('#toasts .toast').count(),0,'no toast over the card');
    for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(150);await shot(page,`settings-${t}`,page.locator('[data-settings-group="terminal"]'));}
    await noWrap(page,'[data-settings-section="agent"] .badge','settings badges');
    assert.deepEqual(page.errors,[]);
  });
  for(const [mode,check] of [
    ['nologin',async section=>{
      assert.equal(await section.locator('[data-agent-login]').textContent(),'No sandbox login on Hoster yet');
      assert.match(await section.locator('[data-agent-login-help]').textContent(),/Run claude setup-token on Hoster and paste the token here/);
    }],
    ['agentoff,noconnect',async section=>{
      assert.match(await section.locator('[data-agent-settings-off]').textContent(),/The report agent is off on this Board/);
      assert.equal(await section.locator('select').count(),0);
      assert.equal(await section.locator('[data-agent-connect-flag]').textContent(),'Connect to running agents: off');
    }],
  ]){
    await withFixture(mode,async({base,newPage})=>{
      const page=await newPage();
      await page.goto(`${base}/#/settings`);
      const section=page.locator('[data-settings-section="agent"]');
      await section.locator('[data-agent-connect-flag]').waitFor({timeout:15000});
      await page.waitForFunction(()=>!/Loading/.test(document.querySelector('[data-settings-section="agent"]').textContent));
      await check(section);
      assert.deepEqual(page.errors,[]);
    });
  }
});

test('settings: sandbox login saved from Settings; Replace, Remove; the token never stays in the page',{timeout:240000},async()=>{
  const SENTINEL='sk-ant-oat01-SENTINELbrowserZ8q-FAKEFAKEFAKE_0123456789';
  const SENTINEL2='sk-ant-oat01-SENTINELreplaceW3k-FAKEFAKEFAKE_9876543210';
  const MARK=/SENTINEL|FAKEFAKEFAKE|Z8q|W3k/;
  await withFixture('nologin',async({base,newPage,token})=>{
    const page=await newPage();
    const cap=await tokenCapture(page);
    const requests=cap.requests;
    await page.goto(`${base}/#/settings`);
    const row=page.locator('[data-agent-login-row]');
    await row.waitFor({timeout:15000});
    assert.equal(await row.locator('.set-label').textContent(),'Sandbox login (Claude)');
    assert.equal(await page.locator('[data-agent-login-help]').textContent(),"Run claude setup-token on Hoster and paste the token here. It is stored on Hoster only, readable by the Board's user.");
    const input=row.locator('input[name="set-agent-token"]');
    // Not a password field (Chrome offers to save formless password fields, review U1): a text field
    // masked by CSS, with every password manager's ignore attribute.
    // The section repaints once its config loads; read the connected field until its style settles (review U1).
    const fieldState=()=>page.evaluate(()=>{const i=document.querySelector('input[name="set-agent-token"]');return i&&{type:i.type,autocomplete:i.getAttribute('autocomplete'),spellcheck:i.spellcheck,inForm:!!i.closest('form'),
      mask:getComputedStyle(i).getPropertyValue('-webkit-text-security'),ignore:['data-1p-ignore','data-lpignore','data-bwignore','data-form-type'].map(a=>i.getAttribute(a))};}).catch(()=>null);
    let field=null;
    for(let i=0;i<50;i++){field=await fieldState();if(field?.mask==='disc')break;await page.waitForTimeout(200);}
    assert.deepEqual(field,
    {type:'text',autocomplete:'off',spellcheck:false,inForm:false,mask:'disc',ignore:['','true','','other']});
    assert.equal(await page.locator('input[type="password"]').count(),0,'no password input on the page');
    assert.equal(await row.locator('[data-agent-login]').textContent(),'No sandbox login on Hoster yet');
    assert.equal(await row.locator('.ra-login-controls [data-agent-login]').count(),1,'the pill sits with the controls, right-aligned');
    await dismissToasts(page);
    await oneLineHints(page);
    for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(150);await shot(page,`login-field-${t}`,page.locator('[data-agent-login-block]'));}
    await theme(page,'light');
    // A value that is not a setup token is refused in the page: nothing sent, field cleared.
    await input.fill('hunter2-not-a-token');
    await row.locator('[data-agent-login-action="save"]').click();
    await page.locator('[data-agent-login-msg]').filter({hasText:'not a Claude setup token'}).waitFor();
    assert.equal(await input.inputValue(),'');
    assert.equal(requests.filter(r=>r.url.endsWith('/api/agent/login')).length,0);
    // Save.
    await input.fill(SENTINEL);
    await row.locator('[data-agent-login-action="save"]').click();
    await page.locator('[data-agent-login-msg]').filter({hasText:'Saved on Hoster.'}).waitFor({timeout:15000});
    assert.equal(fs.readFileSync(token,'utf8'),SENTINEL+'\n');
    assert.equal(fs.statSync(token).mode&0o777,0o600);
    assert.equal(await row.locator('[data-agent-login]').textContent(),'Sandbox login ready');
    assert.match(await row.locator('[data-agent-login-saved]').textContent(),/^Saved (under a minute|\d+ min) ago$/);
    assert.equal(await row.locator('input[name="set-agent-token"]').count(),0,'the field is gone once saved');
    assert.equal(await row.locator('.ra-login-controls [data-agent-login]').count(),1);
    await oneLineHints(page);
    await dismissToasts(page);
    for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(150);await shot(page,`login-saved-${t}`,page.locator('[data-agent-login-block]'));}
    await theme(page,'light');
    const first=await cap.scan('after Save',MARK,[{cli:'claude',token:SENTINEL}]);
    assert.ok(first.responses>0&&first.requests>0,'the capture saw traffic');
    // Replace opens the field again; Cancel keeps the saved login; a second Save replaces it.
    await row.locator('[data-agent-login-action="replace"]').click();
    await row.locator('input[name="set-agent-token"]').waitFor();
    await row.locator('[data-agent-login-action="cancel"]').click();
    assert.equal(await row.locator('[data-agent-login]').textContent(),'Sandbox login ready');
    await row.locator('[data-agent-login-action="replace"]').click();
    await row.locator('input[name="set-agent-token"]').fill(SENTINEL2);
    await row.locator('[data-agent-login-action="save"]').click();
    await page.locator('[data-agent-login-msg]').filter({hasText:'Saved on Hoster.'}).waitFor({timeout:15000});
    assert.equal(fs.readFileSync(token,'utf8'),SENTINEL2+'\n');
    await cap.scan('after Replace',MARK,[{cli:'claude',token:SENTINEL},{cli:'claude',token:SENTINEL2}]);
    // Remove asks first.
    await row.locator('[data-agent-login-action="remove"]').click();
    const dialog=page.locator('dialog.ledger-dialog');
    await dialog.waitFor();
    assert.equal(await dialog.locator('h2').textContent(),'Remove the sandbox login?');
    await dialog.getByRole('button',{name:'Cancel'}).click();
    assert.equal(fs.existsSync(token),true,'Cancel keeps it');
    await row.locator('[data-agent-login-action="remove"]').click();
    await dialog.getByRole('button',{name:'Remove login'}).click();
    await page.locator('[data-agent-login-msg]').filter({hasText:'Login removed.'}).waitFor({timeout:15000});
    assert.equal(fs.existsSync(token),false);
    assert.equal(await row.locator('[data-agent-login]').textContent(),'No sandbox login on Hoster yet');
    await cap.scan('after Remove',MARK,[{cli:'claude',token:SENTINEL},{cli:'claude',token:SENTINEL2}]);
    await row.locator('input[name="set-agent-token"]').waitFor();
    assert.deepEqual(page.errors,[]);
  });
  await withFixture('notokenflag',async({base,newPage})=>{
    const page=await newPage();
    await page.goto(`${base}/#/settings`);
    const section=page.locator('[data-settings-section="agent"]');
    await section.locator('[data-agent-login-hint]').waitFor({timeout:15000});
    assert.match(await section.locator('[data-agent-login-hint]').textContent(),/claude setup-token.*report-agent\.token.*0600/);
    assert.equal(await section.locator('input[type="password"]').count(),0,'not editable: the manual hint instead of the field');
    assert.deepEqual(page.errors,[]);
  });
});

test('Agent button: disabled only when neither the agent nor connect can be used; outside a packet it offers running agents only',{timeout:300000},async()=>{
  const reasonOf=async page=>{
    const button=agentButton(page);
    await button.waitFor({timeout:15000});
    await page.waitForFunction(()=>{const b=document.querySelector('[data-agent-toggle]');return b&&!/Checking/.test(b.title);},null,{timeout:15000});
    return {disabled:await button.isDisabled(),title:await button.getAttribute('title'),text:(await page.locator('[data-agent-reason]').textContent())||'',hidden:await page.locator('[data-agent-reason]').isHidden()};
  };
  await withFixture('noconnect',async({base,newPage})=>{
    const page=await newPage();
    await openReport(page,base,{report:'active.md'});
    await page.locator('[data-term-toggle]').waitFor();
    // Next to the Terminal button.
    assert.equal(await page.evaluate(()=>{const t=document.querySelector('[data-term-toggle]');return t.nextElementSibling.matches('[data-term-reason]')&&t.nextElementSibling.nextElementSibling.matches('[data-agent-toggle]');}),true);
    await page.waitForFunction(()=>document.querySelector('[data-agent-toggle]')?.disabled&&/finding folder/.test(document.querySelector('[data-agent-toggle]').title));
    const r=await reasonOf(page);
    assert.equal(r.disabled,true);
    assert.equal(r.title,'This report is not inside a finding folder (reports/<FID>-…/).','reuses the terminal /api/mount message');
    assert.equal(r.text,r.title);assert.equal(r.hidden,false);
    // The non-live view gets the button too.
    await openReport(page,base,{report:REPORT});
    await page.waitForFunction(()=>document.querySelector('[data-agent-toggle]')&&!document.querySelector('[data-agent-toggle]').disabled,null,{timeout:15000});
    assert.deepEqual(page.errors,[]);
  });
  // Outside a finding packet, with connect on: enabled; the popover has only the running agents.
  await withFixture('',async({base,newPage})=>{
    const page=await newPage();
    await openReport(page,base,{report:'active.md'});
    await page.waitForFunction(()=>{const b=document.querySelector('[data-agent-toggle]');return b&&!b.disabled&&/finding folder/.test(b.title);},null,{timeout:20000});
    assert.equal(await page.locator('[data-agent-reason]').isHidden(),true);
    assert.equal(await page.locator('[data-term-toggle]').isDisabled(),true,'the Terminal button stays disabled');
    await barToTop(page);
    await agentButton(page).click();
    const pop=popover(page);
    await pop.locator('[data-agent-list] .ra-row').first().waitFor({timeout:15000});
    assert.equal(await pop.locator('[data-agent-start-off]').textContent(),'This report is not inside a finding folder (reports/<FID>-…/).');
    assert.equal(await pop.locator('[data-agent-format], textarea, [data-agent-action="start"]').count(),0,'no chips, ask box or Start');
    assert.deepEqual(await pop.locator('.ra-row').evaluateAll(rs=>rs.map(r=>r.dataset.agentPane)),['w1:p2','w1:p4','w1:p1'],'matched by the report\'s lane and program');
    await pop.locator('[data-agent-action="show-all"]').waitFor();
    for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(150);await shot(page,`popover-outside-packet-${t}`,pop);}
    await theme(page,'light');
    await pop.locator('.ra-row[data-agent-pane="w1:p1"]').click();
    const id=await page.evaluate(()=>window.BoardTerminal.activeTab());
    assert.match(id,/^connect-/);
    await waitTab(page,id,/ATTACHED w1:p1/,'the attach from a report outside a packet');
    assert.equal(await page.locator('[data-term-tab-select="terminal"]').isDisabled(),true,'no shell outside a packet');
    assert.equal(await page.evaluate(()=>window.BoardTerminal.status),'idle');
    await page.locator(`[data-term-tab-close="${id}"]`).click();
    await page.waitForFunction(()=>!window.BoardTerminal.open,null,{timeout:5000});
    assert.deepEqual(page.errors,[]);
  });
  // No login, connect on: enabled, the popover says why it cannot start.
  await withFixture('nologin',async({base,newPage})=>{
    const page=await newPage();
    await openReport(page,base);
    await page.waitForFunction(()=>{const b=document.querySelector('[data-agent-toggle]');return b&&!b.disabled&&/No sandbox login/.test(b.title);},null,{timeout:20000});
    await agentButton(page).click();
    await popover(page).locator('[data-agent-start-off]').filter({hasText:'No sandbox login on Hoster yet.'}).waitFor();
    assert.deepEqual(page.errors,[]);
  });
  for(const [mode,reason] of [['nologin,noconnect','No sandbox login on Hoster yet.'],['agentoff,noconnect','The report agent is off on this Board.'],['down','Terminal service unavailable.']]){
    await withFixture(mode,async({base,newPage})=>{
      const page=await newPage();
      await openReport(page,base);
      await page.waitForFunction(r=>document.querySelector('[data-agent-toggle]')?.title===r,reason,{timeout:20000});
      const r=await reasonOf(page);
      assert.equal(r.disabled,true,`${mode}: disabled`);
      assert.equal(r.text,reason,`${mode}: visible reason`);
      if(mode==='nologin,noconnect')await shot(page,'disabled-nologin-light',page.locator('#live-report-host .live-bar'));
      assert.deepEqual(page.errors,[]);
    });
  }
  await withFixture('nolive',async({base,newPage})=>{
    const page=await newPage();
    await openReport(page,base,{live:false});
    await page.waitForFunction(()=>document.querySelector('[data-agent-toggle]')&&!document.querySelector('[data-agent-toggle]').disabled,null,{timeout:20000});
    assert.equal(await page.evaluate(()=>{const t=document.querySelector('[data-term-toggle]');const r=t.nextElementSibling;return !document.getElementById('live-report-host')&&r.matches('[data-term-reason]')&&r.nextElementSibling.matches('[data-agent-toggle]');}),true,'non-live view: next to the Terminal button');
    assert.deepEqual(page.errors,[]);
  });
  await withFixture('noconnect',async({base,newPage})=>{
    const page=await newPage();
    await openReport(page,base);
    await page.waitForFunction(()=>document.querySelector('[data-agent-toggle]')&&!document.querySelector('[data-agent-toggle]').disabled,null,{timeout:15000});
    await agentButton(page).click();
    await popover(page).locator('[data-agent-connect-off]').waitFor();
    assert.equal(await popover(page).locator('[data-agent-connect-off]').textContent(),'Connecting to running agents is off on this Board.');
    assert.equal(await popover(page).locator('[data-agent-list],.ra-row').count(),0);
    assert.deepEqual(page.errors,[]);
  });
});

test('popover start, Agent tab output and typing through the filter, status dot, Stop with confirm, ask',{timeout:240000},async()=>{
  await withFixture('',async({base,newPage,dir})=>{
    const marker=path.join(dir,'pasted-marker');
    const page=await newPage();
    const wsCap=await tokenCapture(page);
    await openReport(page,base);
    const button=agentButton(page);
    await page.waitForFunction(()=>document.querySelector('[data-agent-toggle]')&&!document.querySelector('[data-agent-toggle]').disabled,null,{timeout:15000});
    await barToTop(page);
    await button.click();
    const pop=popover(page);
    await pop.waitFor();
    assert.deepEqual(await pop.locator('[data-agent-format]').allTextContents(),['Python','curl','Browser JS','Raw HTTP','Best fit']);
    await pop.locator('[data-agent-list] .ra-row').first().waitFor({timeout:15000});
    await insideViewport(page,pop,'popover');
    await noWrap(page,'[data-agent-popover] .badge, [data-agent-popover] .ra-chip, [data-agent-popover] .ra-row-title, [data-agent-popover] .ra-row-sub','popover pills and rows');
    for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(150);await shot(page,`popover-${t}`,pop);}
    await theme(page,'light');
    const start=pop.locator('[data-agent-action="start"]');
    assert.equal(await start.isDisabled(),true,'nothing picked yet');
    assert.equal(await pop.locator('select[name="agent-cli"]').inputValue(),'claude','defaults to the Settings choice');
    assert.equal(await pop.locator('select[name="agent-model"]').inputValue(),'default');
    // Unsafe question text is refused before sending.
    await pop.locator('textarea[name="agent-ask"]').fill('why ‮ this');
    assert.match(await pop.locator('[data-agent-hint]').textContent(),/control or invisible characters/);
    assert.equal(await start.isDisabled(),true);
    await pop.locator('textarea[name="agent-ask"]').fill('');
    await pop.locator('[data-agent-format="python"]').click();
    assert.equal(await pop.locator('[data-agent-format="python"]').getAttribute('aria-pressed'),'true');
    assert.match(await start.textContent(),/Convert to Python/);
    // Under a picked chip the textarea is optional extra instructions, sent as note.
    assert.equal(await pop.locator('[data-agent-area-label]').textContent(),'Anything else? (optional)');
    await pop.locator('textarea[name="agent-ask"]').fill('Keep the curl as a fallback.');
    assert.match(await start.textContent(),/Convert to Python/);
    await pop.locator('select[name="agent-model"]').selectOption('opus');   // per-run override
    await start.click();
    await page.locator('#term-drawer [data-term-tabs]').waitFor({timeout:15000});
    assert.deepEqual(page.starts[0],{selector:{family:'web_bounty',program:'synthetic-term',lane:'web',path:REPORT},task:{kind:'poc_format',format:'python',note:'Keep the curl as a fallback.'},cli:'claude',model:'opus'});
    assert.equal(await pop.count(),0,'popover closes after start');
    // Drawer on the Agent tab.
    assert.deepEqual(await page.locator('[data-term-tab-select]').allTextContents(),['Terminal','Agent']);
    assert.equal(await page.locator('[data-term-tab-select="agent"]').getAttribute('aria-selected'),'true');
    let text=await waitTab(page,'agent',/READY/,'the fake CLI start');
    assert.match(text,/FAKE-CLI-START/);
    assert.match(text,/ARGV .*"--model", ?"opus"/);
    assert.match(text,/standalone Python PoC/,'the rendered task reached the CLI');
    assert.match(text,/Ryu's extra instructions for this change[^]*Keep the curl as a fallback\./,'the note reached the task');
    assert.match(text,/TOKEN_IS_DUMMY True/);
    assert.match(text,/MODEL-REPLY FAKE-REPLY-OK/,'model calls go through the relay to the fake upstream');
    assert.equal(await page.evaluate(()=>window.BoardTerminal.status),'idle','the shell is not attached while only the Agent tab was shown');
    // Typing goes to the agent.
    await typeInTab(page,'agent','hello-agent\n');
    await waitTab(page,'agent',/ECHO hello-agent/,'typed input');
    // The token scan's WebSocket capture sees the terminal frames both ways (review rv2 V7).
    assert.ok(wsCap.frames.some(f=>f.dir==='sent'&&/"t":"in"/.test(f.data)),'sent frames captured');
    assert.ok(wsCap.frames.some(f=>f.dir==='received'),'received frames captured');
    // The paste guard applies: unsafe clipboard text is refused, nothing reaches the CLI.
    const refused=await page.evaluate(marker=>{
      const area=document.querySelector('[data-term-tab-screen="agent"] textarea');
      const data=new DataTransfer();data.setData('text/plain',`echo hi\u001b[201~\ntouch ${marker}\n`);
      const event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});
      area.dispatchEvent(event);return event.defaultPrevented;
    },marker);
    assert.equal(refused,true);
    assert.equal(await page.locator('[data-term-note]').textContent(),'Paste refused: the clipboard text contains control characters.');
    await page.waitForTimeout(400);
    assert.doesNotMatch(await tabText(page,'agent'),/pasted-marker/);
    // Status dot: quiet -> Waiting for you; output -> Working.
    await page.locator('[data-agent-state]').filter({hasText:'Waiting for you'}).waitFor({timeout:20000});
    assert.equal(await page.locator('[data-term-status]').textContent(),'Waiting for you','the drawer pill follows the Agent tab');
    await typeInTab(page,'agent','spam\n');
    await page.locator('[data-agent-state]').filter({hasText:'Working'}).waitFor({timeout:15000});
    await page.locator('[data-term-tab-select="agent"] .term-tab-dot[data-state="working"]').waitFor({timeout:5000});
    // Another device sees the running agent and joins the same session (scrollback included).
    const other=await newPage();
    await openReport(other,base);
    await other.locator('[data-agent-state]').filter({hasText:/Working|Waiting for you/}).waitFor({timeout:15000});
    assert.deepEqual(await other.evaluate(()=>window.BoardTerminal.tabs()),['agent']);
    await agentButton(other).click();
    await other.locator('[data-agent-action="stop"]').waitFor();
    assert.equal(await popover(other).locator('[data-agent-action="start"]').count(),0,'no second start while one runs');
    await waitTab(other,'agent',/ECHO hello-agent/,'scrollback on the second device');
    await other.close();
    for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(150);await shot(page,`drawer-tabs-${t}`);}
    await theme(page,'light');
    await noWrap(page,'.term-tab-btn, [data-agent-state], .term-pill','tabs and status pills');
    // Switching tabs keeps the Agent tab attached (scrollback stays, no reattach).
    await page.locator('[data-term-tab-select="terminal"]').click();
    await page.locator('#term-drawer [data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:20000});
    assert.equal(await page.locator('[data-term-reset]').isVisible(),true);
    await page.locator('[data-term-tab-select="agent"]').click();
    assert.match(await tabText(page,'agent'),/ECHO hello-agent/);
    assert.equal(await page.locator('[data-term-reset]').isVisible(),false,'shell actions hide on the Agent tab');
    // Stop asks first; Cancel keeps it running.
    await page.locator('[data-agent-state]').filter({hasText:/Waiting for you|Working/}).waitFor();
    await button.click();
    await pop.locator('[data-agent-action="stop"]').click();
    const dialog=page.locator('dialog.ledger-dialog');
    await dialog.waitFor();
    assert.equal(await dialog.locator('h2').textContent(),'Stop the agent?');
    await dialog.getByRole('button',{name:'Cancel'}).click();
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(()=>window.BoardReportAgent.session.state!=='none'),true,'still running after Cancel');
    if(await pop.count()===0)await button.click();
    await pop.locator('[data-agent-action="stop"]').click();
    await dialog.getByRole('button',{name:'Stop agent'}).click();
    await page.waitForFunction(()=>!window.BoardTerminal.tabs().includes('agent'),null,{timeout:20000});
    assert.equal(await page.locator('[data-agent-state]').isHidden(),true);
    assert.equal(await page.evaluate(()=>window.BoardReportAgent.session.state),'none');
    // Ask: the question is the task; no override when the Settings choice is kept.
    await button.click();
    await pop.locator('[data-agent-format="python"]').waitFor();
    await pop.locator('select[name="agent-model"]').selectOption('default');
    await pop.locator('textarea[name="agent-ask"]').fill('Which header does poc.py need?\r\nThanks');
    assert.equal(await pop.locator('[data-agent-action="start"]').isDisabled(),false);
    await pop.locator('[data-agent-action="start"]').click();
    await page.waitForFunction(()=>window.BoardTerminal.activeTab()==='agent',null,{timeout:15000});
    assert.deepEqual(page.starts[1].task,{kind:'ask',text:'Which header does poc.py need?\nThanks'},'LF line ends');
    assert.equal('cli' in page.starts[1],false);
    text=await waitTab(page,'agent',/READY/,'second start');
    assert.match(text,/Which header does poc\.py need\?/);
    // Exit: the button and the tab say so.
    await typeInTab(page,'agent','quit\n');
    await page.locator('[data-agent-state]').filter({hasText:'Exited'}).waitFor({timeout:15000});
    await page.locator('[data-term-meta]').filter({hasText:'exit code 7'}).waitFor({timeout:5000});
    assert.equal(fs.existsSync(marker),false);
    assert.deepEqual(page.errors,[]);
  });
});

test('Convert on code blocks: starts with task.block; report and editor stay byte-identical; copies clean; unsafe block disabled',{timeout:240000},async()=>{
  await withFixture('',async({base,newPage,lane})=>{
    const reportFile=path.join(lane,'reports/D1-sqli-login/example-com-sqli-D1.md');
    const original=fs.readFileSync(reportFile,'utf8');
    const page=await newPage();
    await openReport(page,base);
    await sideBySide(page);
    const bars=page.locator('#live-report-host .editor-preview-side [data-term-controls]');
    await page.waitForFunction(()=>document.querySelectorAll('#live-report-host .editor-preview-side [data-term-action="agent-convert"]').length===6,null,{timeout:15000});
    // Convert sits in the Board-only bar, before Checked.
    assert.equal(await bars.nth(2).evaluate(b=>b.querySelector('[data-term-action="agent-convert"]').nextElementSibling.matches('.term-check')),true);
    await bars.nth(2).locator('[data-term-action="agent-convert"]').click();
    const menu=page.locator('[data-agent-convert-menu]');
    await menu.waitFor();
    assert.deepEqual(await menu.locator('[data-agent-format]').allTextContents(),['Python','curl','Browser JS','Raw HTTP','Best fit']);
    await insideViewport(page,menu,'convert menu');
    await noWrap(page,'[data-agent-convert-menu] .ra-chip','convert chips');
    for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(150);await shot(page,`convert-menu-${t}`);}
    await theme(page,'light');
    await menu.locator('[data-agent-format="curl"]').click();
    await page.waitForFunction(()=>window.BoardTerminal.activeTab()==='agent',null,{timeout:15000});
    assert.deepEqual(page.starts[0].task,{kind:'poc_format',format:'curl',block:{text:'print("hello from python")\n',lang:'python',index:2}});
    const text=await waitTab(page,'agent',/READY/,'the fake CLI start');
    assert.match(text,/block 3, language `python`/);
    assert.match(text,/hello from python/);
    // While it runs, Convert is disabled with the reason.
    await page.waitForFunction(()=>document.querySelector('#live-report-host .editor-preview-side [data-term-action="agent-convert"]').disabled);
    assert.match(await bars.nth(0).locator('[data-term-action="agent-convert"]').getAttribute('title'),/already running/);
    // The report and the editor are untouched; copies of the preview carry no control text.
    assert.equal(await page.evaluate(()=>document.querySelector('#live-report-host .CodeMirror').CodeMirror.getValue()),original);
    assert.equal(fs.readFileSync(reportFile,'utf8'),original);
    const copied=await page.evaluate(()=>{
      const preview=document.querySelector('#live-report-host .editor-preview-side');
      const range=document.createRange();range.selectNodeContents(preview);
      const s=window.getSelection();s.removeAllRanges();s.addRange(range);
      const data=new DataTransfer();
      document.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));
      return {text:data.getData('text/plain'),html:data.getData('text/html')};
    });
    assert.match(copied.text,/hello from python/);
    assert.doesNotMatch(copied.text,/Convert|Checked/);
    assert.doesNotMatch(copied.html,/agent-convert|fa-exchange|data-term/);
    assert.equal(await bars.nth(2).locator('[data-term-action="agent-convert"]').evaluate(b=>getComputedStyle(b.closest('[data-term-controls]')).userSelect),'none');
    // A block that fails the typing filter: Convert disabled with the same message.
    await openReport(page,base,{report:'D11-ctrl/example-com-ctrl-D11.md'});
    await sideBySide(page);
    await page.waitForFunction(()=>document.querySelector('#live-report-host .editor-preview-side [data-term-unsafe]'),null,{timeout:15000});
    await page.waitForFunction(()=>[...document.querySelectorAll('#live-report-host .editor-preview-side [data-term-controls]')].some(b=>b.querySelector('[data-term-unsafe]')&&b.querySelector('[data-term-action="agent-convert"]')),null,{timeout:15000});
    const unsafeConvert=await page.evaluate(()=>{const b=[...document.querySelectorAll('#live-report-host .editor-preview-side [data-term-controls]')].find(x=>x.querySelector('[data-term-unsafe]')).querySelector('[data-term-action="agent-convert"]');return {disabled:b.disabled,title:b.title};});
    assert.deepEqual(unsafeConvert,{disabled:true,title:UNSAFE_MESSAGE});
    assert.deepEqual(page.errors,[]);
  });
});

test('connect list: lane matches first, Show all, escaped strings; a connect tab attaches and takes input',{timeout:240000},async()=>{
  await withFixture('',async({base,newPage,herdr_log})=>{
    const page=await newPage();
    await openReport(page,base);
    await page.waitForFunction(()=>document.querySelector('[data-agent-toggle]')&&!document.querySelector('[data-agent-toggle]').disabled,null,{timeout:15000});
    await barToTop(page);
    await agentButton(page).click();
    const pop=popover(page);
    await pop.locator('[data-agent-list] .ra-row').first().waitFor({timeout:15000});
    assert.equal(await pop.locator('.ra-connect h3').textContent(),'Running agents on this program');
    assert.match(await pop.locator('.ra-connect').textContent(),/real sessions on Hoster.*What you type goes straight to the agent/);
    const rows=()=>pop.locator('.ra-row').evaluateAll(rs=>rs.map(r=>({pane:r.dataset.agentPane,match:r.dataset.agentMatch,title:r.querySelector('.ra-row-title').textContent,sub:r.querySelector('.ra-row-sub').textContent,kind:r.querySelector('[data-agent-kind]').textContent,status:r.querySelector('[data-agent-status]').textContent,unsafe:!!r.querySelector('[data-agent-unsafe]')})));
    let list=await rows();
    assert.deepEqual(list.map(r=>r.pane),['w1:p2','w1:p4','w1:p1'],'lane matches first, then program');
    assert.deepEqual(list[0],{pane:'w1:p2',match:'lane',title:'Lane hunter on D1',sub:'web_bounty/synthetic-term/web/reports/D1-sqli-login',kind:'OMP',status:'working',unsafe:false});
    assert.equal(list[1].title,'evil\\x1b]0;x\\x07\\u202etitle','escaped value shown as text');
    assert.equal(list[1].unsafe,true);
    assert.equal(await page.evaluate(()=>document.querySelector('[data-agent-popover]').innerHTML.includes('‮')),false);
    // Show all reloads with all=1 and includes agents outside Shared.
    await pop.locator('[data-agent-action="show-all"]').click();
    await pop.locator('.ra-connect h3').filter({hasText:'All running agents'}).waitFor();
    await page.waitForFunction(()=>[...document.querySelectorAll('.ra-row')].some(r=>r.dataset.agentPane==='w1:p3'),null,{timeout:15000});
    list=await rows();
    const outside=list.find(r=>r.pane==='w1:p3');
    assert.equal(outside.sub,'outside Shared');
    assert.equal(outside.match,'');
    assert.deepEqual(list.map(r=>r.pane),['w1:p2','w1:p4','w1:p1','w1:p3'],'Show all keeps lane, then program matches first; the rest last');
    for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(150);await shot(page,`connect-list-${t}`,pop);}
    await theme(page,'light');
    await noWrap(page,'.ra-row .badge, .ra-row-title, .ra-row-sub','connect rows');
    // Connect to the lane agent: a closable tab, attached over kind=connect.
    await pop.locator('.ra-row[data-agent-pane="w1:p2"]').click();
    const id=await page.evaluate(()=>window.BoardTerminal.activeTab());
    assert.match(id,/^connect-[0-9a-f]{12}$/);
    assert.equal(await page.locator(`[data-term-tab-select="${id}"]`).textContent(),'OMP · Lane hunter on D1');
    await waitTab(page,id,/ATTACHED w1:p2/,'the fake Herdr attach');
    await page.locator('[data-term-status]').filter({hasText:'Connected'}).waitFor({timeout:10000});
    assert.match(await page.locator('[data-term-meta]').textContent(),/Real session on Hoster/);
    assert.equal(await page.locator('#term-drawer .term-title-text').textContent(),'Hoster','not called a sandbox');
    await typeInTab(page,id,'hello-herdr\n');
    await waitTab(page,id,/AGENT-ECHO hello-herdr/,'typed input');
    const log=fs.readFileSync(herdr_log,'utf8').split('\n').filter(Boolean).map(JSON.parse);
    const attach=log.find(e=>e.argv&&e.argv.includes('attach'));
    assert.deepEqual(attach.argv,['--session','test-session','agent','attach','w1:p2'],'no --takeover');
    for(const t of ['light','dark']){await theme(page,t);await page.waitForTimeout(150);await shot(page,`connect-tab-${t}`);}
    await theme(page,'light');
    // Closing the tab detaches it.
    await page.locator(`[data-term-tab-close="${id}"]`).click();
    assert.equal(await page.locator(`[data-term-tab-select="${id}"]`).count(),0);
    assert.equal(await page.evaluate(()=>window.BoardTerminal.activeTab()),'terminal');
    assert.deepEqual(page.errors,[]);
  });
});
