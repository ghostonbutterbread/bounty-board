const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

test('capacity receipt reports unsaved Markdown and retains the original request',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
  const start=source.indexOf('  function handleAutosaveReceipt(');
  const end=source.indexOf('  function scheduleSharedSave(',start);
  assert.ok(start>=0 && end>start);
  const context={persistDraft:()=>true,applyShared:()=>{throw Error('must not acknowledge publication');}};
  vm.createContext(context);
  vm.runInContext(source.slice(start,end),context);
  const pending={content:'draft',request_id:'id'};
  const draft={text:'draft',pendingShared:pending};
  context.handleAutosaveReceipt(draft,pending,{status:'saved',revision:'r',incoming_revision:'r',content:'draft'}, {state:'capacity',reasons:['retention_capacity']});
  assert.match(draft.publicationNotice,/Markdown (?:file )?was not saved/i);
  assert.match(draft.publicationNotice,/increase.*capacity|manage.*backup/i);
  assert.doesNotMatch(draft.publicationNotice,/Markdown file saved/i);
  assert.equal(draft.pendingShared,pending);
});
