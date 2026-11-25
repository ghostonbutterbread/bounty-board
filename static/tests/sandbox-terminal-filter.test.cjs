// Unit test of the play-button control-character filter in static/modules/sandbox-terminal.js
// (review blocker 2: ESC[201~ inside a block ended bracketed paste and ran the rest).
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function loadModule(){
  const noop=()=>{};
  const window={addEventListener:noop,innerWidth:1280,innerHeight:900,registerBoardModule:noop};
  const sandbox={window,document:{addEventListener:noop},localStorage:{getItem:()=>null,setItem:noop},
    navigator:{},setInterval:noop,clearInterval:noop,setTimeout,clearTimeout,TextEncoder,console,URLSearchParams,getComputedStyle:()=>({getPropertyValue:()=>''})};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../modules/sandbox-terminal.js'),'utf8'),sandbox);
  return window.BoardTerminal;
}

test('control characters make a block untypeable',()=>{
  const {unsafeText}=loadModule();
  for(const bad of ['echo hi\x1b[201~\ntouch pwned','\x1b','a\x00b','a\x07','a\rb','a\x0bb','a\x0cb','a\x7f','a\x80','a\x9b31m','a\x9f']){
    assert.equal(unsafeText(bad),true,JSON.stringify(bad));
  }
  for(const ok of ['echo hi','for i in 1 2; do\n\techo $i\ndone','curl -s "https://x/?q=ä€"','printf "\\033[31m"','']){
    assert.equal(unsafeText(ok),false,JSON.stringify(ok));
  }
});

test('typed text never ends with a newline and console prompts are stripped',()=>{
  const {commandText}=loadModule();
  assert.equal(commandText('echo a\n\n',''),'echo a');
  assert.equal(commandText('$ echo a\na\n$ echo b\n','console'),'echo a\necho b');
});
