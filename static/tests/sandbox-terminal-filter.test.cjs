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

test('bidi and invisible characters make a block untypeable (review N3)',()=>{
  const {unsafeText,commandText}=loadModule();
  // Reviewer repro bidi.cjs: isolates make the preview read "echo hi#..." as a comment while Run executes touch.
  const RLI='\u2067',LRI='\u2066',PDI='\u2069';
  const trojan=`echo hi${RLI}${LRI}; touch BIDI-PWNED; ${PDI}${LRI}#${PDI}${PDI}`;
  assert.equal(unsafeText(commandText(trojan,'bash')),true);
  for(const [name,ch] of [['LS','\u2028'],['PS','\u2029'],['ZWSP','\u200b'],['ZWNJ','\u200c'],['ZWJ','\u200d'],['LRM','\u200e'],['RLM','\u200f'],
    ['LRE','\u202a'],['RLE','\u202b'],['PDF','\u202c'],['LRO','\u202d'],['RLO','\u202e'],['WJ','\u2060'],['LRI','\u2066'],['RLI','\u2067'],
    ['FSI','\u2068'],['PDI','\u2069'],['ALM','\u061c'],['BOM','\ufeff'],['SHY','\u00ad']]){
    assert.equal(unsafeText('a'+ch+'b'),true,name);
  }
  for(const ok of ['echo "naïve café"','grep -P "\\u202e" file','echo שלום','echo مرحبا']) assert.equal(unsafeText(ok),false,ok);
});

test('typed text never ends with a newline and console prompts are stripped',()=>{
  const {commandText}=loadModule();
  assert.equal(commandText('echo a\n\n',''),'echo a');
  assert.equal(commandText('$ echo a\na\n$ echo b\n','console'),'echo a\necho b');
});

test('pastes use the same filter; CRLF line ends are newlines, a lone CR is refused',()=>{
  const {unsafePaste,unsafeText}=loadModule();
  assert.equal(unsafePaste('echo a\r\necho b\r\n'),false);
  assert.equal(unsafeText('echo a\r\necho b'),true,'the typing filter itself is unchanged');
  for(const bad of ['echo a\rtouch x','echo hi\x1b[201~\ntouch x\n','echo ⁧x⁩','a‮b','a\x9bb','a\x00']) assert.equal(unsafePaste(bad),true,JSON.stringify(bad));
  for(const ok of ['echo hi','for i in 1 2; do\n\techo $i\ndone','echo "naïve café"','']) assert.equal(unsafePaste(ok),false,JSON.stringify(ok));
});

test('toggle shortcut: browser and terminal combos are refused with a reason',()=>{
  const {shortcutProblem,shortcutLabel}=loadModule();
  const s=(label)=>{const parts=label.split('+'),key=parts.pop();const code=/^[A-Z]$/.test(key)?`Key${key}`:/^\d$/.test(key)?`Digit${key}`:key;return {ctrl:parts.includes('Ctrl'),alt:parts.includes('Alt'),shift:parts.includes('Shift'),code};};
  for(const ok of ['Ctrl+E','Ctrl+Shift+E'.replace('E','Y'),'Alt+T','Alt+Shift+T','Ctrl+G','Ctrl+B','Ctrl+Shift+1']) assert.equal(shortcutProblem(s(ok)),'',ok);
  for(const bad of ['Ctrl+T','Ctrl+W','Ctrl+N','Ctrl+Q','Ctrl+L','Ctrl+R','Ctrl+Shift+C','Ctrl+C','Ctrl+V','Ctrl+D','Ctrl+Z','Ctrl+K','Ctrl+1','Ctrl+Shift+T','Ctrl+Shift+I','Ctrl+H','Ctrl+M','Ctrl+Alt+E','Shift+E','E','Alt+4'])
    assert.notEqual(shortcutProblem(s(bad)),'',bad);
  assert.notEqual(shortcutProblem({ctrl:true,alt:false,shift:false,code:'Tab'}),'','Ctrl+Tab');
  assert.notEqual(shortcutProblem({ctrl:true,alt:false,shift:false,code:'Backquote'}),'','Ctrl+` is the fixed one');
  assert.notEqual(shortcutProblem({ctrl:true,alt:false,shift:false,code:'F5'}),'');
  assert.notEqual(shortcutProblem(null),'');
  assert.equal(shortcutLabel({ctrl:true,alt:false,shift:true,code:'KeyE'}),'Ctrl+Shift+E');
  assert.equal(shortcutLabel({ctrl:false,alt:true,shift:false,code:'Slash'}),'Alt+/');
});
