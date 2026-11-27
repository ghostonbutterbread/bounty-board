// Distinguish bounded UI preference writes from any source/report write.
const assert = require('node:assert/strict');
const allowed = new Set(['bounty-board-theme','bounty-board-show-archived','bounty-board-sidebar-collapsed',
  'bounty-board-finding-sort','bounty-board-dashboard-work','bounty-board-class-group',
  'bounty-board-report-list-hide-na','bounty-board-report-list-open','bounty-board-recent-programs',
  'bounty-board-last-program','bounty-board-recent-panel-show-na',
  ...['copyOnSelect','ctrlCCopy','ctrlVPaste','shortcut','dock'].map(k=>`terminal.${k}`),
  ...['recent','submissions'].flatMap(n=>['window','order','nav','hideNa','programs','lanes','subs','sevs','classes'].map(k=>`list.${n}.${k}`))]);
function assertNoDraft(value, drafts) {
  const todo=[value], seen=new Set();
  while(todo.length) {
    const current=todo.pop();
    if(typeof current==='string') {
      for(const draft of drafts) if(draft.length>=4) assert.ok(!current.includes(draft),'draft text was sent in a preference');
      if(!seen.has(current)) {seen.add(current); try {todo.push(JSON.parse(current));} catch {}}
    } else if(current && typeof current==='object') for(const item of Object.values(current))todo.push(item);
  }
}
function assertPreferencesOnly(requests, base, drafts) {
  for (const request of requests) {
    assert.equal(request.method, 'POST', 'no report/source write');
    assert.equal(request.url, base+'/api/user-preferences', 'only the preferences endpoint may be written');
    const payload=JSON.parse(request.body);
    const action=Object.hasOwn(payload,'set')?'set':'migrate';
    assert.ok(['set','migrate'].includes(action));
    assert.deepEqual(Object.keys(payload).sort(),action==='set'?['expected','set']:['migrate']);
    const values=payload[action];
    assert.ok(values && typeof values==='object' && !Array.isArray(values));
    if(action==='set') { assert.deepEqual(Object.keys(payload.expected).sort(),Object.keys(values).sort()); for(const value of Object.values(payload.expected)) assert.ok(Number.isSafeInteger(value) && value>=0); }
    for (const [key,value] of Object.entries(values)) {
      assert.ok(allowed.has(key), `unexpected preference ${key}`);
      assert.equal(typeof value,'string');
      assertNoDraft(value,drafts);
    }
  }
}
module.exports={assertPreferencesOnly};
