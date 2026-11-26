// Review U4: the browser sentinel-token scan in report-agent.synthetic.test.cjs must cover request
// and response bodies and headers, console messages, page errors, the DOM, storage and the URL, through
// one shared helper, and run again after Replace and Remove. Static check of the test source.
const test=require('node:test'), assert=require('node:assert'), fs=require('node:fs'), path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'report-agent.synthetic.test.cjs'),'utf8');
test('the token scan covers every capture and runs after Save, Replace and Remove',()=>{
  const helper=src.slice(src.indexOf('function tokenCapture('),src.indexOf('async function theme('));
  assert.ok(helper.length>100,'one shared capture and scan helper (tokenCapture)');
  for(const [what,re] of [['requests',/page\.on\('request'/],['responses',/page\.on\('response'/],['response bodies',/r\.text\(\)/],
    ['response headers',/allHeaders\(\)/],['console',/page\.on\('console'/],['page errors',/page\.on\('pageerror'/],
    ['DOM',/outerHTML/],['field values',/input,textarea/],['localStorage',/localStorage/],['sessionStorage',/sessionStorage/],['URL',/location\.href/]])
    assert.match(helper,re,`the scan covers ${what}`);
  const body=src.slice(src.indexOf("test('settings: sandbox login saved"),src.indexOf("withFixture('notokenflag'"));
  for(const label of ['after Save','after Replace','after Remove'])assert.match(body,new RegExp(`cap\\.scan\\('${label}'`),`a scan ${label}`);
  assert.doesNotMatch(body,/const leaks=await page\.evaluate/,'no second, partial scan');
});
