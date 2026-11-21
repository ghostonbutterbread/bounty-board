const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

test('known portfolio is usable before the held report read completes', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bp-'));
  const repo=path.resolve(__dirname,'../..');
  const child=spawn('python3',['-u','tests/progressive_browser_fixture.py',root],{cwd:repo,env:{...process.env,PYTHONPATH:repo},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(new Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const page=await browser.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    const start=Date.now();
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(()=>document.querySelector('#app')?.textContent.includes('Loading workspace'));
    while(!fs.existsSync(path.join(root,'entered'))) {
      if(Date.now()-start>5000)throw new Error('report read barrier was not reached');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    await page.getByRole('heading',{name:'Portfolio overview'}).waitFor({timeout:2000});
    const overview=page.locator('section').filter({has:page.getByRole('heading',{name:'Portfolio overview'})});
    const stat=label=>overview.locator('.stat').filter({hasText:label}).locator('strong');
    assert.equal(await stat('Finding records').innerText(),'1');
    assert.match(await stat('Report records').innerText(),/loading/i);
    assert.equal(fs.existsSync(path.join(root,'release')),false);
    console.log(`held report: initial useful dashboard ${Date.now()-start}ms before release`);
    fs.writeFileSync(path.join(root,'release'),'release');
    await page.waitForFunction(()=>[...document.querySelectorAll('.stat')].some(e=>e.textContent.includes('Report records') && e.querySelector('strong')?.textContent==='1'),null,{timeout:5000});
  } finally {
    fs.writeFileSync(path.join(root,'release'),'release');
    if(browser)await browser.close();
    child.kill('SIGTERM'); await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null ? resolve() : child.once('exit',resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
