const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const log = message => console.log(`[release-ui-native-editor-smoke] ${message}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(message) { throw new Error(message); }
function getJson(url) { return new Promise((resolve, reject) => http.get(url, res => { let data=''; res.on('data', c => data += c); res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } }); }).on('error', reject)); }
async function waitTarget(port) { for (let i=0;i<60;i++) { try { const list=await getJson(`http://127.0.0.1:${port}/json/list`); const target=list.find(t=>t.webSocketDebuggerUrl&&String(t.url||'').includes('index.html')); if(target)return target; } catch {} await sleep(500); } fail('CDP target timeout'); }
function connect(target) { let id=1; const pending=new Map(); const ws=new WebSocket(target.webSocketDebuggerUrl); const ready=new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;ws.onmessage=e=>{const m=JSON.parse(e.data);if(!m.id||!pending.has(m.id))return;const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);};}); const call=(method,params={},timeout=20000)=>new Promise((resolve,reject)=>{const current=id++;pending.set(current,{resolve,reject});ws.send(JSON.stringify({id:current,method,params}));setTimeout(()=>{if(pending.delete(current))reject(new Error(`timeout ${method}`));},timeout);});return{ws,ready,call}; }
async function evalJs(cdp, expression) { const r=await cdp.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},30000);if(r.exceptionDetails)fail(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value; }
async function waitFor(cdp, expression, label) { for(let i=0;i<100;i++){try{if(await evalJs(cdp,expression))return;}catch{}await sleep(200);}fail(`timeout ${label}`); }

(async()=>{
  if(process.platform!=='win32')return;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'NewmarkNativeEditorSmoke-'));
  const workspace=path.join(root,'Work','editor-smoke');
  const port=49382;let child,cdp;
  try{
    child=spawn(exePath,[`--remote-debugging-port=${port}`,'--no-sandbox','--root',root],{stdio:'ignore',windowsHide:true});
    const target=await waitTarget(port);cdp=connect(target);await cdp.ready;await cdp.call('Runtime.enable');
    await waitFor(cdp,`document.readyState==='complete'&&window.api&&window.openFile`,'renderer');
    const created=await evalJs(cdp,`window.api.createWorkspace('editor-smoke')`);
    if(!created||created.error)fail(`workspace create failed: ${JSON.stringify(created)}`);
    const workspaceId=created.id||created.name||'editor-smoke';
    await evalJs(cdp,`window.api.selectWorkspace(${JSON.stringify(workspaceId)})`);
    await evalJs(cdp,`window.api.saveFile('sample.ts','const answer: number = 41;\\nfunction plusOne(n: number) {\\n  return n + 1;\\n}\\n')`);
    await evalJs(cdp,`window.openFile('sample.ts')`);
    try {
      await waitFor(cdp,`document.querySelector('#editor-highlight')?.innerHTML.includes('tok-keyword')&&document.querySelector('#editor-gutter')?.innerText.includes('4')`,'highlight and gutter');
    } catch (error) {
      const editorState=await evalJs(cdp,`({path:window.state.editorPath,name:document.querySelector('#editor-filename')?.textContent,value:document.querySelector('#editor-textarea')?.value,highlight:document.querySelector('#editor-highlight')?.innerHTML})`);
      fail(`${error.message}: ${JSON.stringify(editorState)}`);
    }
    await evalJs(cdp,`(() => { window.toggleEditorVim(); const ta=document.querySelector('#editor-textarea'); ta.setSelectionRange(0,0); const key=k=>window.handleEditorVimKey({key:k,preventDefault(){},ctrlKey:false}); key('d');key('d');key('u'); return ta.value.startsWith('const answer'); })()`);
    await waitFor(cdp,`document.querySelector('#editor-textarea').value.startsWith('const answer')&&window.state.editorVimMode==='normal'`,'vim undo');
    await evalJs(cdp,`(() => { window.requestEditorCompletion=async()=>{window.state.editorCompletionText='// predicted by model\\n';window.renderEditorGhostText();}; const ta=document.querySelector('#editor-textarea'); ta.setSelectionRange(ta.value.length,ta.value.length); window.toggleEditorPrediction(); window.scheduleEditorCompletion(); return true; })()`);
    await waitFor(cdp,`window.state.editorCompletionText.includes('predicted by model')&&document.querySelector('#editor-ghost .editor-ghost-text')?.textContent.includes('predicted by model')&&!document.querySelector('#editor-completion').classList.contains('open')`,'inline ghost completion');
    await evalJs(cdp,`(() => { const ta=document.querySelector('#editor-textarea'); ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})); return ta.value.includes('predicted by model')&&!window.state.editorCompletionText; })()`);
    await evalJs(cdp,`window.saveEditor()`);
    await waitFor(cdp,`window.api.readFile('sample.ts').then(r=>r.content.includes('predicted by model'))`,'completion saved');
    const result=await evalJs(cdp,`({language:document.querySelector('#editor-language').textContent,mode:document.querySelector('#editor-vim-mode').textContent,previewVisible:document.querySelector('#editor-md-toggle').classList.contains('visible'),saved:document.querySelector('#editor-textarea').value.includes('predicted by model')})`);
    if(result.language!=='typescript'||result.previewVisible||!result.saved)fail(JSON.stringify(result));
    log(`native editor ok ${JSON.stringify(result)}`);
  } finally { try{cdp?.ws.close();}catch{} try{child?.kill();}catch{} await sleep(800); fs.rmSync(root,{recursive:true,force:true}); }
})().catch(error=>{console.error(error.stack||error);process.exit(1);});
