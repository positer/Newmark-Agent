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
    fs.mkdirSync(workspace,{recursive:true});
    fs.writeFileSync(path.join(workspace,'sample.ts'),'const answer: number = 41;\nfunction plusOne(n: number) {\n  return n + 1;\n}\n','utf8');
    await evalJs(cdp,`window.openFile('sample.ts')`);
    try {
      await waitFor(cdp,`document.querySelector('#editor-highlight')?.innerHTML.includes('tok-keyword')&&document.querySelector('#editor-gutter')?.innerText.includes('4')`,'highlight and gutter');
    } catch (error) {
      const editorState=await evalJs(cdp,`({path:window.state.editorPath,name:document.querySelector('#editor-filename')?.textContent,value:document.querySelector('#editor-textarea')?.value,highlight:document.querySelector('#editor-highlight')?.innerHTML})`);
      fail(`${error.message}: ${JSON.stringify(editorState)}`);
    }
    const toolbar=await evalJs(cdp,`(() => { const buttons=Array.from(document.querySelectorAll('.editor-toolbar .et-btn')); const visible=buttons.filter(b=>getComputedStyle(b).display!=='none'); const copilot=document.querySelector('#editor-copilot-toggle'); const ghost=document.querySelector('#editor-ghost'); const highlight=document.querySelector('#editor-highlight'); return {count:buttons.length,visible:visible.length,sizes:visible.map(b=>{const br=b.getBoundingClientRect(),ir=b.querySelector('.nm-icon').getBoundingClientRect();return {w:br.width,h:br.height,text:b.textContent.trim(),iconW:ir.width,iconH:ir.height,contained:ir.left>=br.left&&ir.top>=br.top&&ir.right<=br.right&&ir.bottom<=br.bottom};}),copilotActive:copilot.classList.contains('active'),pressed:copilot.getAttribute('aria-pressed'),highlight:highlight.innerHTML,highlightVisible:getComputedStyle(highlight).display!=='none'&&highlight.textContent.includes('const answer'),ghostDisplay:getComputedStyle(ghost).display,ghostText:ghost.textContent}; })()`);
    if(toolbar.count!==4||toolbar.visible!==3||toolbar.sizes.some(item=>item.w!==30||item.h!==30||item.text||item.iconW!==15||item.iconH!==15||!item.contained)||!toolbar.copilotActive||toolbar.pressed!=='true'||!toolbar.highlightVisible||toolbar.ghostDisplay!=='none'||toolbar.ghostText||!toolbar.highlight.includes('tok-keyword')||!toolbar.highlight.includes('tok-type')||toolbar.highlight.includes('<span <span'))fail(`toolbar/highlight failed: ${JSON.stringify(toolbar)}`);
    await evalJs(cdp,`(() => { window.toggleEditorVim(); const ta=document.querySelector('#editor-textarea'); ta.setSelectionRange(0,0); const key=k=>window.handleEditorVimKey({key:k,preventDefault(){},ctrlKey:false}); key('d');key('d');key('u'); return ta.value.startsWith('const answer'); })()`);
    await waitFor(cdp,`document.querySelector('#editor-textarea').value.startsWith('const answer')&&window.state.editorVimMode==='normal'`,'vim undo');
    await evalJs(cdp,`(() => { window.requestEditorCompletion=async()=>{const ta=document.querySelector('#editor-textarea');window.state.editorCompletionAnchor={path:window.state.editorPath,value:ta.value,start:ta.selectionStart,end:ta.selectionEnd};window.state.editorCompletionText='// predicted by model\\n';window.renderEditorGhostText();}; const ta=document.querySelector('#editor-textarea'); const pos=ta.value.indexOf('return'); ta.setSelectionRange(pos,pos); window.state.editorCaretSignature=window.editorCaretSignature(); window.scheduleEditorCompletion(); return true; })()`);
    await waitFor(cdp,`window.state.editorCompletionText.includes('predicted by model')&&document.querySelector('#editor-ghost').classList.contains('visible')&&getComputedStyle(document.querySelector('#editor-ghost')).display==='block'&&document.querySelector('#editor-ghost .editor-ghost-text')?.textContent.includes('predicted by model')&&!document.querySelector('#editor-completion').classList.contains('open')`,'inline ghost completion');
    const moved=await evalJs(cdp,`(() => { const ta=document.querySelector('#editor-textarea'); const next=Math.min(ta.value.length,ta.selectionStart+4); ta.setSelectionRange(next,next); window.handleEditorCaretChange(); const ghost=document.querySelector('#editor-ghost'); const highlight=document.querySelector('#editor-highlight'); return {text:window.state.editorCompletionText,anchor:window.state.editorCompletionAnchor,timer:!!window.state.editorCompletionTimer,ghost:ghost.textContent,ghostDisplay:getComputedStyle(ghost).display,highlightVisible:getComputedStyle(highlight).display!=='none'&&highlight.textContent.includes('const answer')}; })()`);
    if(moved.text||moved.anchor||!moved.timer||moved.ghost||moved.ghostDisplay!=='none'||!moved.highlightVisible)fail(`caret movement did not invalidate and restart completion: ${JSON.stringify(moved)}`);
    await waitFor(cdp,`window.state.editorCompletionText.includes('predicted by model')&&window.editorCompletionAnchorIsCurrent()`,'caret-moved completion');
    await evalJs(cdp,`(() => { const ta=document.querySelector('#editor-textarea'); ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})); return ta.value.includes('predicted by model')&&!window.state.editorCompletionText; })()`);
    const pasteCount=await evalJs(cdp,`(async()=>{const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZrGQAAAAASUVORK5CYII='),c=>c.charCodeAt(0));const file=new File([bytes],'image.png',{type:'image/png',lastModified:1});const transfer={items:[{kind:'file',type:'image/png',getAsFile:()=>file}],files:[file]};window.state.promptAttachments=[];await attachPromptImagesFromDataTransfer(transfer);return window.state.promptAttachments.length;})()`);
    if(pasteCount!==1)fail(`duplicate paste attachment count=${pasteCount}`);
    await evalJs(cdp,`window.saveEditor()`);
    await waitFor(cdp,`window.api.openWorkspaceFile('sample.ts').then(r=>r.kind==='editor'&&r.content.includes('predicted by model'))`,'completion saved');
    const result=await evalJs(cdp,`({language:document.querySelector('#editor-language').textContent,mode:document.querySelector('#editor-vim-mode').textContent,previewVisible:document.querySelector('#editor-md-toggle').classList.contains('visible'),saved:document.querySelector('#editor-textarea').value.includes('predicted by model')})`);
    if(result.language!=='typescript'||result.previewVisible||!result.saved)fail(JSON.stringify(result));
    log(`native editor ok ${JSON.stringify(result)}`);
  } finally { try{cdp?.ws.close();}catch{} try{child?.kill();}catch{} await sleep(800); fs.rmSync(root,{recursive:true,force:true}); }
})().catch(error=>{console.error(error.stack||error);process.exit(1);});
