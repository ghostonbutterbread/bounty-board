const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

const repo=path.resolve(__dirname,'../..');
async function withBoard(run){
  const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'bb-search-'));
  const child=spawn('python3',['-u','tests/search_browser_fixture.py',root],{cwd:repo,env:{...process.env,PYTHONPATH:repo},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',d=>resolve(Number(String(d).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const context=await browser.newContext({viewport:{width:1280,height:800}});
    await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
    const page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',d=>{errors.push('dialog:'+d.message());d.dismiss();});
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForSelector('#global-search-field');
    await page.waitForSelector('[data-open-program]');
    await run({page,root,errors,base:`http://127.0.0.1:${port}`});
    assert.deepEqual(errors,[]);
  } finally {
    if(browser)await browser.close();
    child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null||child.signalCode!==null?r():child.once('exit',r));
    fs.rmSync(root,{recursive:true,force:true});
  }
}
const palette=page=>page.locator('.search-dialog');
async function openPalette(page,query){
  await page.keyboard.press('Control+K');
  await palette(page).waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement.id),'global-search-input');
  if(query){await page.keyboard.type(query);await page.locator(`.search-results[data-results-for=${JSON.stringify(query.trim().replace(/\s+/g,' ').toLowerCase()===query?query:query)}]`).waitFor();await page.locator('.search-item').first().waitFor();}
}

test('palette keyboard flow: open, move, select a finding, open its report',{timeout:60000},async()=>{
  await withBoard(async({page})=>{
    await page.getByRole('button',{name:'Refresh'}).focus();
    await openPalette(page,'xss');
    assert.deepEqual(await page.locator('.search-group-title').allTextContents(),['Findings','Reports']);
    const first=page.locator('.search-item').first();
    assert.equal(await first.getAttribute('aria-selected'),'true');
    assert.match(await first.textContent(),/Stored XSS in profile bio/);
    assert.match(await first.textContent(),/HIGH/);
    assert.equal(await page.locator('.search-mark').first().textContent(),'XSS');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('.search-item').nth(1).getAttribute('aria-selected'),'true');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.locator('#global-search-input').getAttribute('aria-activedescendant'),'global-search-option-0');
    await page.keyboard.press('Enter');
    await palette(page).waitFor({state:'hidden'});
    assert.equal(await page.locator('#breadcrumb').textContent(),'Programs');
    assert.equal(await page.locator('#program-select').inputValue(),'web_bounty/acme');
    assert.equal(await page.locator('#lane-select').inputValue(),'web');
    const row=page.locator('tr[data-finding-id="AC-1"]');
    await row.waitFor();
    await page.waitForFunction(()=>document.querySelector('tr[data-finding-id="AC-1"]')?.classList.contains('highlight'));
    // Integrated navigation: the result updated the URL hash and history.
    assert.match(page.url(),/#\/programs\/web_bounty%2Facme\/web\/findings$/);
    await page.locator('.search-followup').getByRole('button',{name:'Open report'}).click();
    assert.equal(await page.locator('#report-select').inputValue(),'confirmed/xss-profile.md');
    assert.equal(await page.locator('[data-section="reports"]').getAttribute('aria-current'),'page');
    assert.match(page.url(),/\/reports\//);
    await page.goBack();
    await page.waitForFunction(()=>document.querySelector('[data-section="findings"]')?.getAttribute('aria-current')==='page');
    await page.goBack();
    await page.waitForFunction(()=>document.querySelector('#breadcrumb')?.textContent==='Dashboard');
  });
});

test('inline topbar field opens the palette on pointer focus and on typing',{timeout:60000},async()=>{
  await withBoard(async({page})=>{
    const field=page.locator('#global-search-field');
    assert.equal(await page.locator('#global-search-host').count(),1);
    // Pointer focus opens the palette; Esc returns to the field without reopening.
    await field.click();
    await palette(page).waitFor();
    assert.equal(await page.evaluate(()=>document.activeElement.id),'global-search-input');
    assert.equal(await field.getAttribute('aria-expanded'),'true');
    await page.keyboard.press('Escape');
    await palette(page).waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>document.activeElement.id),'global-search-field');
    assert.equal(await palette(page).isHidden(),true,'keyboard focus alone does not reopen');
    // Typing in the field opens the palette seeded with the text.
    await page.keyboard.type('xss');
    await palette(page).waitFor();
    assert.equal(await page.locator('#global-search-input').inputValue(),'xss');
    await page.locator('.search-results[data-results-for="xss"]').waitFor();
    assert.equal(await field.inputValue(),'');
    await page.keyboard.press('Escape');
  });
});

test('selecting a report opens Reports on it and offers the owning finding',{timeout:60000},async()=>{
  await withBoard(async({page})=>{
    await openPalette(page,'zebra');
    assert.deepEqual(await page.locator('.search-group-title').allTextContents(),['Reports']);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#report-select');
    assert.equal(await page.locator('#report-select').inputValue(),'raw/unowned.md');
    await openPalette(page,'profile xss');
    await page.locator('.search-item').filter({hasText:'confirmed/xss-profile.md'}).click();
    await page.waitForFunction(()=>document.querySelector('#report-select')?.value==='confirmed/xss-profile.md');
    await page.locator('.search-followup').getByRole('button',{name:'Show finding'}).click();
    await page.waitForFunction(()=>document.querySelector('tr[data-finding-id="AC-1"]')?.classList.contains('highlight'));
  });
});

test('palette is safe, restores focus on Esc, leaves an editor intact, keeps recents and program jumps',{timeout:60000},async()=>{
  await withBoard(async({page})=>{
    // Report text is rendered as text: the snippet contains markup that must stay inert.
    await openPalette(page,'onerror');
    assert.match(await page.locator('.search-snippet').first().textContent(),/<img src=x onerror=alert\(1\)>/);
    assert.equal(await palette(page).locator('img').count(),0);
    await page.keyboard.press('Escape');
    await palette(page).waitFor({state:'hidden'});
    // Esc restores the previously focused control.
    await page.getByRole('button',{name:'Refresh'}).focus();
    await openPalette(page);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'refresh');
    // Typing in the editor is not disturbed; the shortcut opens, Esc returns to the editor.
    await page.locator('[data-open-program]').first().click();
    await page.locator('#lane-select').selectOption('web');
    await page.locator('[data-section="reports"]').click();
    await page.locator('.CodeMirror textarea').focus();
    await page.keyboard.type('draft text');
    await openPalette(page);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>!!document.activeElement.closest('.CodeMirror')),true);
    assert.match(await page.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),/draft text/);
    // Recent search shown after use; program jump from an empty query.
    await openPalette(page,'redirect');
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('tr[data-finding-id="AC-3"]')?.classList.contains('highlight'));
    await openPalette(page);
    assert.ok((await page.locator('.search-group-title').allTextContents()).includes('Recent searches'));
    assert.ok((await page.locator('.search-item').allTextContents()).some(t=>t.startsWith('redirect')));
    await page.keyboard.type('globex');
    await page.locator('.search-results[data-results-for="globex"]').waitFor();
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('#program-select')?.value==='web_bounty/globex');
    assert.equal(await page.locator('#lane-select').inputValue(),'web');
    // Jump list for an empty query.
    await openPalette(page);
    await page.locator('.search-item').filter({hasText:'initech'}).first().click();
    await page.waitForFunction(()=>document.querySelector('#program-select')?.value==='binaries/initech');
  });
});

test('screenshot of the palette on synthetic data',{timeout:60000},async()=>{
  await withBoard(async({page})=>{
    await openPalette(page,'xss');
    await page.waitForTimeout(150);
    const out=path.join(process.env.SEARCH_SHOTS||os.tmpdir(),'search-palette.png');
    fs.mkdirSync(path.dirname(out),{recursive:true});
    await page.screenshot({path:out});
  });
});
