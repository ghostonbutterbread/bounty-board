const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

// A real local backend and real SQLite; all files and browser state are disposable.
async function waitForPortfolio(page) {
  await page.waitForFunction(()=>{
    const buttons=[...document.querySelectorAll('button')];
    const load=buttons.find(b=>b.textContent==='Load entire portfolio');
    return !load || load.parentElement.hidden || buttons.some(b=>b.textContent==='Apply loaded reports');
  },null,{timeout:5000});
  const apply=page.getByRole('button',{name:'Apply loaded reports'});
  if(await apply.isVisible())await apply.click();
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Load entire portfolio' && b.parentElement.hidden),null,{timeout:5000});
}
test('portfolio filtering, ledger and unassessed inventory end to end', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bdc-'));
  const repo=path.resolve(__dirname,'../..');
  const child=spawn('python3',['-u','tests/dashboard_browser_fixture.py',root],{cwd:repo,env:{...process.env,PYTHONPATH:repo},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(new Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    assert.ok(port);
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome'});
    const page=await browser.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${port}`);
    const filter=page.getByLabel('Dashboard program');
    await filter.waitFor({timeout:5000});
    await waitForPortfolio(page);
    const overview=page.locator('section').filter({has:page.getByRole('heading',{name:'Portfolio overview'})});
    const stat=label=>overview.locator('.stat').filter({hasText:label}).locator('strong');
    assert.equal(await stat('Programs loaded').innerText(),'2');
    assert.equal(await stat('Finding records').innerText(),'3');
    let submissions=page.getByRole('region',{name:'Submission records'});
    assert.match(await submissions.innerText(),/submitted\s+1/);
    assert.match(await submissions.innerText(),/nested\s+1/);
    assert.match(await submissions.innerText(),/draft\s+1/);
    assert.doesNotMatch(await submissions.innerText(),/ignored/);
    const severity=page.getByRole('region',{name:'Severity breakdown'});
    assert.match(await severity.innerText(),/LOW\s+2/);
    const classes=page.locator('section').filter({has:page.getByRole('heading',{name:'Finding classes'})});
    assert.match(await classes.innerText(),/idor\s+2/);
    await filter.selectOption('web_bounty/alpha');
    assert.equal(await stat('Programs loaded').innerText(),'1');
    await filter.selectOption('');
    await filter.focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await filter.inputValue(),'web_bounty/alpha');
    assert.equal(await filter.evaluate(el=>document.activeElement===el),true);
    assert.equal(await stat('Finding records').innerText(),'2');
    await page.keyboard.press('ArrowDown');
    assert.equal(await filter.inputValue(),'web_bounty/beta');
    assert.equal(await filter.evaluate(el=>document.activeElement===el),true);
    assert.equal(await stat('Finding records').innerText(),'1');
    await page.keyboard.press('ArrowUp');
    assert.equal(await filter.inputValue(),'web_bounty/alpha');
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button',{name:'Open workspace'}).evaluate(el=>document.activeElement===el),true);
    assert.equal(await stat('Programs loaded').innerText(),'1');
    assert.equal(await stat('Finding records').innerText(),'2');
    assert.match(await severity.innerText(),/LOW\s+1/);
    assert.match(await classes.innerText(),/idor\s+1/);
    assert.match(await submissions.innerText(),/duplicate\s+1/);
    assert.doesNotMatch(await submissions.innerText(),/draft\s+1/);
    await page.getByRole('button',{name:'Open workspace'}).click();
    assert.equal(await page.locator('#program-select').inputValue(),'web_bounty/alpha');
    await page.getByLabel('Filter severities').selectOption('HIGH');
    await page.getByLabel('Filter classes').selectOption('xss');
    await page.getByLabel('Filter statuses').selectOption('raw');
    assert.equal(await page.getByText('Alpha finding',{exact:true}).count(),1);
    assert.equal(await page.getByText('Second alpha',{exact:true}).count(),0);
    await page.getByRole('button',{name:'Coverage',exact:true}).click();
    assert.equal(await page.getByText('/<img src=x onerror=alert(1)>',{exact:true}).count(),1);
    assert.equal(await page.locator('#app img').count(),0);
    assert.match(await page.locator('#app').innerText(),/no_assessment/);
    await page.locator('#program-select').selectOption('web_bounty/beta');
    await page.getByRole('button',{name:'Findings',exact:true}).click();
    assert.equal(await page.getByText('Beta finding',{exact:true}).count(),1);
    assert.equal(await page.getByLabel('Filter severities').inputValue(),'');
    await page.getByRole('button',{name:'Dashboard',exact:true}).click();
    await page.getByLabel('Dashboard program').selectOption('');
    assert.equal(await stat('Finding records').innerText(),'3');
    fs.unlinkSync(path.join(root,'web_bounty/beta/web/ledgers/ledger.json'));
    await page.getByRole('button',{name:'Refresh'}).click();
    await page.waitForFunction(()=>[...document.querySelectorAll('.stat')].some(el=>el.textContent.includes('Finding records') && el.textContent.includes('Unknown')));
    await waitForPortfolio(page);
    assert.match(await page.locator('#app').innerText(),/incomplete|unavailable/i);
    await page.getByLabel('Dashboard program').selectOption('web_bounty/alpha');
    assert.equal(await stat('Finding records').innerText(),'2');
    assert.equal(await page.getByText('ledger_missing',{exact:true}).count(),0);
    fs.renameSync(path.join(root,'web_bounty/alpha'),path.join(root,'web_bounty/_removed'));
    await page.getByRole('button',{name:'Refresh'}).click();
    await page.waitForFunction(()=>document.querySelector('#dashboard-program')?.options.length===2);
    assert.equal(await page.getByLabel('Dashboard program').inputValue(),'');
    assert.equal(await stat('Finding records').innerText(),'Unknown');
    await page.close();
  } finally {
    if(browser)await browser.close();
    child.kill('SIGTERM'); await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null ? resolve() : child.once('exit',resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('same-name programs have distinguishable keyboard-accessible choices', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bdp-'));
  const repo=path.resolve(__dirname,'../..');
  const child=spawn('python3',['-u','tests/dashboard_browser_fixture.py',root],{cwd:repo,env:{...process.env,PYTHONPATH:repo},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(new Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    const lane=path.join(root,'binaries/alpha/apk');
    fs.mkdirSync(path.join(lane,'ledgers'),{recursive:true});
    fs.writeFileSync(path.join(lane,'ledgers/ledger.json'),JSON.stringify({findings:[{fid:'X1',title:'Binary alpha'}]}));
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome'});
    const page=await browser.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${port}`);
    const filter=page.getByLabel('Dashboard program');
    await filter.waitFor();
    await waitForPortfolio(page);
    const options=await filter.locator('option').evaluateAll(els=>els.map(el=>({value:el.value,label:el.textContent})));
    const web=options.find(o=>o.value==='web_bounty/alpha'), binary=options.find(o=>o.value==='binaries/alpha');
    assert.ok(web && binary);
    assert.notEqual(web.label,binary.label);
    assert.match(web.label,/web_bounty/); assert.match(binary.label,/binaries/);
    const overview=page.locator('section').filter({has:page.getByRole('heading',{name:'Portfolio overview'})});
    const stat=label=>overview.locator('.stat').filter({hasText:label}).locator('strong');
    assert.equal(await stat('Finding records').innerText(),'4');
    await filter.focus();
    for (const [value,count] of [['web_bounty/alpha','2'],['web_bounty/beta','1'],['binaries/alpha','1']]) {
      await page.keyboard.press('ArrowDown');
      assert.equal(await filter.inputValue(),value);
      assert.equal(await stat('Finding records').innerText(),count);
      assert.equal(await filter.evaluate(el=>document.activeElement===el),true);
    }
    await page.getByRole('button',{name:'Open workspace'}).click();
    const selector=page.locator('#program-select');
    assert.equal(await selector.inputValue(),'binaries/alpha');
    const workspace=await selector.locator('option').evaluateAll(els=>els.map(el=>({value:el.value,label:el.textContent})));
    assert.notEqual(workspace.find(o=>o.value===web.value).label,workspace.find(o=>o.value===binary.value).label);
    await selector.selectOption('web_bounty/alpha');
    assert.equal(await page.getByText('Alpha finding',{exact:true}).count(),1);
  } finally {
    if(browser)await browser.close();
    child.kill('SIGTERM'); await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null ? resolve() : child.once('exit',resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
