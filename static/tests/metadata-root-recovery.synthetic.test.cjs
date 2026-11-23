const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');

const root = path.resolve(__dirname,'..');
let instance='a'.repeat(64), writes=[];
const data=()=>({root_identity:'f'.repeat(64),root_instance:instance,programs:[{id:'p',name:'Program',family:'test',lanes:[{name:'web',findings:[{id:'same',title:'Finding',severity:'LOW',severity_rationale:'source',metadata_revision:'1'.repeat(64)}],coverage:[],reports:[],map:[],gadgets:[],warnings:[]}]}],capabilities:{findingMetadata:{enabled:true,method:'PATCH',url:'/api/meta',options:{severity:['LOW','HIGH']},textFields:['severity_rationale']}},warnings:[]});
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/api/data'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(data()));}
  if(pathname==='/api/meta') {let body='';req.on('data',c=>body+=c);return req.on('end',()=>{const parsed=JSON.parse(body);writes.push(parsed);res.setHeader('content-type','application/json');if(JSON.stringify(Object.keys(parsed).sort())!==JSON.stringify(['field','findingId','lane','programId','value'].sort())){res.statusCode=400;return res.end('{}');}res.end(JSON.stringify({value:parsed.value}));});}
  const file=path.join(root,pathname==='/'?'index.html':pathname.slice(1));
  if(!file.startsWith(root+path.sep)){res.statusCode=403;return res.end();}
  fs.readFile(file,(err,bytes)=>{if(err){res.statusCode=404;return res.end();}res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'text/plain');res.end(bytes);});
});
let browser, base;
test.before(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--no-sandbox','--disable-dev-shm-usage']});});
after(async()=>{await browser?.close();await new Promise(r=>server.close(r));});
const editor=p=>p.getByRole('textbox',{name:'Severity rationale for Finding'});
const copy=p=>p.getByLabel('Pending severity rationale — copy before leaving');
async function open(p){await p.goto(base);await p.getByRole('button',{name:'Programs',exact:true}).click();}
async function refresh(p){await p.getByRole('button',{name:'Refresh'}).click();await p.waitForFunction(()=>!document.querySelector('#refresh').disabled);}

test('a hidden and replaced-root rationale remains copyable without becoming a new-root editor',async()=>{
  instance='a'.repeat(64);const p=await browser.newPage();await open(p);
  await p.getByRole('button',{name:'Edit severity rationale for Finding'}).click();const text='</textarea><img src=x onerror="window.pwned=1">';await editor(p).fill(text);
  await p.getByLabel('Search findings').fill('absent');assert.equal(await copy(p).inputValue(),text);assert.equal(await p.evaluate(()=>window.pwned),undefined);
  await p.getByLabel('Search findings').fill('');assert.equal(await editor(p).inputValue(),text);
  instance='b'.repeat(64);await refresh(p);assert.equal(await copy(p).inputValue(),text);assert.equal(await editor(p).count(),0);
  await p.getByRole('button',{name:'Edit severity rationale for Finding'}).click();assert.equal(await editor(p).inputValue(),'source');await p.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await copy(p).inputValue(),text);
  instance='a'.repeat(64);await refresh(p);assert.equal(await editor(p).inputValue(),text);assert.equal(await copy(p).count(),0);await p.close();
});

test('replacement at the same logical root never attaches the old draft to the new row',async()=>{
  instance='a'.repeat(64);const p=await browser.newPage();await open(p);
  await p.getByRole('button',{name:'Edit severity rationale for Finding'}).click();await editor(p).fill('original root draft');
  instance='b'.repeat(64);await refresh(p);assert.equal(await editor(p).count(),0);assert.equal(await copy(p).inputValue(),'original root draft');await p.close();
});

test('strict legacy writer receives exactly the documented own keys',async()=>{
  instance='a'.repeat(64);writes=[];const p=await browser.newPage();await open(p);await p.getByLabel('severity for Finding').selectOption('HIGH');await p.waitForFunction(()=>!document.querySelector('[data-metadata=severity]')?.disabled);assert.deepEqual(writes,[{programId:'p',lane:'web',findingId:'same',field:'severity',value:'HIGH'}]);assert.equal(await p.getByLabel('severity for Finding').inputValue(),'HIGH');await p.close();
});

for(const unidentified of [null,'malformed']) test(`unidentified instance ${unidentified} becomes copy-only after refresh`,async()=>{
  instance=unidentified;writes=[];const p=await browser.newPage();await open(p);
  await p.getByRole('button',{name:'Edit severity rationale for Finding'}).click();await editor(p).fill('unknown origin');
  await p.getByRole('button',{name:'Dashboard',exact:true}).click();assert.equal(await copy(p).inputValue(),'unknown origin');
  await p.getByRole('button',{name:'Programs',exact:true}).click();assert.equal(await editor(p).inputValue(),'unknown origin');
  await refresh(p);assert.equal(await editor(p).count(),0);assert.equal(await copy(p).inputValue(),'unknown origin');assert.equal(writes.length,0);
  await p.getByRole('button',{name:'Edit severity rationale for Finding'}).click();await p.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await copy(p).inputValue(),'unknown origin');await p.close();
});

test('program and lane navigation with identical finding IDs keeps the origin draft separate',async()=>{
  instance='a'.repeat(64);const p=await browser.newPage();const fixture=data();
  const original=fixture.programs[0].lanes[0];fixture.programs[0].lanes.push({...structuredClone(original),name:'api'});
  fixture.programs.push({...structuredClone(fixture.programs[0]),id:'q',name:'Other program'});
  await p.route('**/api/data*',route=>route.fulfill({json:fixture}));await open(p);
  await p.getByRole('button',{name:'Edit severity rationale for Finding'}).click();await editor(p).fill('web p draft');
  await p.getByLabel('Lane').selectOption('api');assert.equal(await editor(p).count(),0);assert.equal(await copy(p).inputValue(),'web p draft');
  await p.getByRole('button',{name:'Edit severity rationale for Finding'}).click();await p.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await copy(p).inputValue(),'web p draft');
  await p.locator('#program-select').selectOption('q');assert.equal(await editor(p).count(),0);assert.equal(await copy(p).inputValue(),'web p draft');
  await p.locator('#program-select').selectOption('p');assert.equal(await editor(p).inputValue(),'web p draft');assert.equal(await copy(p).count(),0);await p.close();
});

test('storage failure, focused search and navigation retain the in-tab rationale',async()=>{
  instance='a'.repeat(64);const p=await browser.newPage();
  await p.addInitScript(()=>{for(const name of ['getItem','setItem','removeItem'])Object.defineProperty(Storage.prototype,name,{value(){throw new Error('blocked');}});});
  await open(p);await p.getByRole('button',{name:'Edit severity rationale for Finding'}).click();await editor(p).fill('only in tab');
  const search=p.getByLabel('Search findings');await search.fill('not found');assert.equal(await search.evaluate(el=>document.activeElement===el),true);assert.equal(await copy(p).inputValue(),'only in tab');
  await p.getByRole('button',{name:'Dashboard',exact:true}).click();assert.equal(await copy(p).inputValue(),'only in tab');
  await p.getByRole('button',{name:'Programs',exact:true}).click();await p.getByLabel('Search findings').fill('');assert.equal(await editor(p).inputValue(),'only in tab');await p.close();
});
