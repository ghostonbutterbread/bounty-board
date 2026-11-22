const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

// No real backend, source directories, or writes: serve a fixed synthetic API.
const root=path.resolve(__dirname,'..');
const bad='<img src=x onerror="window.pwned=1">';
const lane=(name,warnings,extra={})=>({name,warnings,findings:[],coverage:[],map:[],gadgets:[],reports:[],...extra});
const fixture={warnings:['discovery_incomplete'],programs:[
  {id:'web_bounty/alpha',family:'web_bounty',name:'alpha',lanes:Array.from({length:8},(_,i)=>lane('web'+i,['map_missing','coverage_missing','ledger_missing','reports_missing','map_missing'],{findings:null,coverage:null,map:null,reports:null}))},
  {id:'binaries/alpha',family:'binaries',name:'alpha',lanes:[lane(bad,['ledger_unavailable_or_invalid','reports_unavailable_or_invalid','report_content_unavailable_or_invalid','odd_<script>'],{findings:null,reports:[{id:'x',title:'partial'}]}),lane('empty',[])]}
]};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/api/data'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(fixture));}
  const files={'/':'index.html','/app.js':'app.js','/api.js':'api.js','/style.css':'style.css'};
  const file=files[url.pathname];if(!file){res.writeHead(404);return res.end();}
  res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));
});

test('many lane warnings leave the portfolio visible and provide bounded availability',async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome'});
    const page=await browser.newPage({viewport:{width:1366,height:768}});
    const origin=`http://127.0.0.1:${server.address().port}`;
    await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
    await page.goto(origin);
    const overview=page.getByRole('heading',{name:'Portfolio overview'});await overview.waitFor();
    const y=(await overview.boundingBox()).y;
    assert.ok(y<768,`portfolio heading was at y=${y}`);
    const summary=page.getByRole('region',{name:'Data availability'});
    assert.equal(await summary.count(),1);
    assert.ok((await summary.boundingBox()).height<240);
    assert.match(await summary.innerText(),/9 lanes have/);
    assert.match(await summary.innerText(),/Missing: 8 lanes/);
    assert.match(await summary.innerText(),/Inaccessible or invalid: 1 lane/);
    assert.match(await summary.innerText(),/discovery is incomplete/i);
    const disclosure=summary.locator('summary');
    await disclosure.focus();await page.keyboard.press('Enter');
    assert.equal(await summary.locator('details').evaluate(el=>el.open),true);
    assert.match(await summary.innerText(),/Map missing\s*— 8 lanes/);
    assert.match(await summary.innerText(),/web_bounty \/ alpha \/ web0/);
    assert.match(await summary.innerText(),/binaries \/ alpha/);
    assert.match(await summary.innerText(),/Other warning: odd_<script>/);
    assert.equal(await page.locator('#app img, #app script').count(),0);
    assert.equal(await page.evaluate(()=>window.pwned),undefined);
    await page.keyboard.press('Space');
    assert.equal(await summary.locator('details').evaluate(el=>el.open),false);
    const filter=page.getByLabel('Dashboard program');
    await filter.selectOption('web_bounty/alpha');
    assert.match(await summary.innerText(),/8 lanes have/);
    assert.doesNotMatch(await summary.innerText(),/Inaccessible or invalid/);
    await filter.selectOption('binaries/alpha');
    assert.match(await summary.innerText(),/1 lane has/);
    assert.doesNotMatch(await summary.innerText(),/Missing:/);
    await filter.selectOption('');
    assert.match(await summary.innerText(),/9 lanes have/);
    // Partial report walks are unknown, even when the returned list is nonempty.
    fixture.warnings=['global_<svg onload=alert(1)>'];
    await page.getByRole('button',{name:'Refresh'}).click();
    await page.waitForFunction(()=>document.querySelector('#app')?.textContent.includes('Other global warnings'));
    const stat=label=>page.locator('.stat').filter({hasText:label}).locator('strong');
    assert.equal(await stat('Report records').innerText(),'Unknown');
    await page.getByLabel('Dashboard program').selectOption('binaries/alpha');
    await page.getByRole('button',{name:'Open workspace'}).click();
    const laneSelector=page.getByLabel('Lane');
    assert.equal(await laneSelector.inputValue(),bad);
    const workspaceSummary=page.getByRole('region',{name:'Data availability'});
    assert.match(await workspaceSummary.innerText(),/1 lane has/);
    assert.equal(await page.locator('.summary-line > div').filter({hasText:'Reports'}).locator('strong').innerText(),'Unknown');
    fixture.programs[1].lanes[0].reports=[];
    await page.getByRole('button',{name:'Refresh'}).click();
    await page.getByRole('button',{name:'Reports',exact:true}).click();
    assert.match(await page.locator('#app').innerText(),/report list is incomplete/i);
    assert.doesNotMatch(await page.locator('#app').innerText(),/No reports in this lane/);
    await laneSelector.selectOption('empty');
    assert.match(await workspaceSummary.innerText(),/No lane warnings reported/);
    assert.equal(await page.locator('.summary-line > div').filter({hasText:'Reports'}).locator('strong').innerText(),'0');
    await page.getByRole('button',{name:'Dashboard',exact:true}).click();
    await page.getByLabel('Dashboard program').selectOption('');
    await page.getByRole('region',{name:'Data availability'}).locator('summary').click();
    assert.match(await page.getByRole('region',{name:'Data availability'}).innerText(),/Global warning: global_<svg onload=alert\(1\)>/);
    assert.equal(await page.locator('#app svg, #app img').count(),0);
    fixture.warnings=['root_unavailable'];fixture.programs=[];
    await page.getByRole('button',{name:'Refresh'}).click();
    await page.getByRole('alert').getByText(/root unavailable/i).waitFor();
    assert.equal(await stat('Programs loaded').innerText(),'Unknown');
    await page.close();
    // Mobile retains overview and allows the rest of the aggregates to be reached.
    fixture.warnings=['discovery_incomplete'];fixture.programs=[{id:'web_bounty/alpha',family:'web_bounty',name:'alpha',lanes:Array.from({length:8},(_,i)=>lane('web'+i,['map_missing','coverage_missing','ledger_missing','reports_missing']))}];
    const mobile=await browser.newPage({viewport:{width:375,height:800}});
    await mobile.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
    await mobile.goto(origin);
    await mobile.getByRole('heading',{name:'Portfolio overview'}).waitFor();
    assert.ok((await mobile.getByRole('heading',{name:'Portfolio overview'}).boundingBox()).y<800);
    assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await mobile.getByRole('region',{name:'Submission records'}).scrollIntoViewIfNeeded();
    assert.equal(await mobile.getByRole('region',{name:'Submission records'}).isVisible(),true);
    await mobile.close();
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});

test('disposable real loader distinguishes empty, missing, corrupt and unreadable sources',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'board-availability-'));
  const repo=path.resolve(__dirname,'../..');
  const child=spawn('python3',['-u','tests/dashboard_browser_fixture.py',temp],{cwd:repo,env:{...process.env,PYTHONPATH:repo},stdio:['ignore','pipe','inherit']});
  let browser;
  try{
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(new Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    assert.ok(port);
    const alpha=path.join(temp,'web_bounty/alpha/web'), beta=path.join(temp,'web_bounty/beta/web');
    fs.mkdirSync(path.join(alpha,'recon/maps'),{recursive:true});
    fs.writeFileSync(path.join(alpha,'recon/maps/map.jsonl'),''); // valid empty source
    fs.writeFileSync(path.join(alpha,'ledgers/ledger.json'),'{broken');
    fs.writeFileSync(path.join(beta,'ledgers/surface_coverage.sqlite'),'not a database');
    fs.writeFileSync(path.join(beta,'reports/unreadable.md'),Buffer.from([0xff,0xfe]));
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome'});
    const page=await browser.newPage();const origin=`http://127.0.0.1:${port}`;
    await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
    await page.goto(origin);
    const summary=page.getByRole('region',{name:'Data availability'});await summary.waitFor();
    // A visible summary can still be the inventory/selected-lane snapshot.
    // Wait for the actual complete-snapshot transition, not a warning value.
    await page.waitForFunction(()=>{
      const buttons=[...document.querySelectorAll('button')];
      return buttons.some(b=>b.textContent==='Apply loaded reports') || buttons.some(b=>b.textContent==='Load entire portfolio' && b.parentElement.hidden);
    });
    const apply=page.getByRole('button',{name:'Apply loaded reports'});
    if(await apply.isVisible())await apply.click();
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Load entire portfolio' && b.parentElement.hidden));
    await summary.locator('summary').click();
    let text=await summary.innerText();
    assert.match(text,/Ledger inaccessible or invalid\s*— 1 lane/);
    assert.match(text,/Coverage inaccessible or invalid\s*— 1 lane/);
    assert.match(text,/Report content inaccessible or invalid\s*— 1 lane/);
    assert.match(text,/Map missing\s*— 1 lane/);
    await page.getByLabel('Dashboard program').selectOption('web_bounty/alpha');
    await summary.locator('summary').click();text=await summary.innerText();
    assert.doesNotMatch(text,/Map missing/);
    assert.match(text,/Ledger inaccessible or invalid/);
    const findingStat=page.locator('.stat').filter({hasText:'Finding records'}).locator('strong');
    assert.equal(await findingStat.innerText(),'Unknown');
    await page.close();
  }finally{
    if(browser)await browser.close();
    child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));
    fs.rmSync(temp,{recursive:true,force:true});
  }
});
