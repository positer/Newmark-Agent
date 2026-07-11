const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const http = require('http');

const repoRoot = path.resolve(__dirname, '..', '..');
const exe = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const sourceConfig = path.join(repoRoot, '_local', 'real-ui-user-test', 'config.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw new Error(message); };
function createVisionFixture(root) {
  const output = path.join(root, 'vision-shapes-and-text.png');
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    `$p=${JSON.stringify(output)}`,
    '$bmp=New-Object System.Drawing.Bitmap 6000,4000',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    "$g.SmoothingMode='AntiAlias'",
    '$g.Clear([System.Drawing.Color]::White)',
    "$font=New-Object System.Drawing.Font('Arial',48,[System.Drawing.FontStyle]::Bold)",
    "$g.DrawString('NEWMARK 42',$font,[System.Drawing.Brushes]::Black,2600,80)",
    '$g.FillEllipse([System.Drawing.Brushes]::DodgerBlue,450,900,700,700)',
    '$g.FillRectangle([System.Drawing.Brushes]::LimeGreen,2700,1050,600,600)',
    '$points=[System.Drawing.Point[]]@((New-Object System.Drawing.Point 5100,800),(New-Object System.Drawing.Point 4650,1700),(New-Object System.Drawing.Point 5550,1700))',
    '$g.FillPolygon([System.Drawing.Brushes]::Crimson,$points)',
    "$small=New-Object System.Drawing.Font('Consolas',32,[System.Drawing.FontStyle]::Bold)",
    "$g.DrawString('CROP-7391',$small,[System.Drawing.Brushes]::Black,5250,3400)",
    '$g.Dispose()',
    '$bmp.Save($p,[System.Drawing.Imaging.ImageFormat]::Png)',
    '$bmp.Dispose()',
  ].join('; ');
  const generated = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (generated.status !== 0 || !fs.existsSync(output)) fail(`vision fixture generation failed: ${generated.stderr || generated.stdout}`);
  return `data:image/png;base64,${fs.readFileSync(output).toString('base64')}`;
}
function getJson(url) { return new Promise((resolve,reject)=>http.get(url,res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});}).on('error',reject)); }
async function target(port){for(let i=0;i<100;i++){try{const list=await getJson(`http://127.0.0.1:${port}/json/list`);const found=list.find(x=>x.webSocketDebuggerUrl&&String(x.url||'').includes('index.html'));if(found)return found;}catch{}await sleep(300);}fail('CDP timeout');}
function connect(target){let id=0;const pending=new Map();const ws=new WebSocket(target.webSocketDebuggerUrl);const ready=new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;ws.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);};});const call=(method,params={},timeout=240000)=>new Promise((resolve,reject)=>{const current=++id;pending.set(current,{resolve,reject});ws.send(JSON.stringify({id:current,method,params}));setTimeout(()=>{if(pending.delete(current))reject(new Error(`timeout ${method}`));},timeout);});return{ws,ready,call};}
async function evaluate(cdp,expression){const r=await cdp.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)fail(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
function stop(){spawnSync('powershell.exe',['-NoProfile','-Command',"Get-Process 'Newmark Agent' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force"],{windowsHide:true});}

(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'NewmarkRealVision-'));
  const image=createVisionFixture(root);
  const config=JSON.parse(fs.readFileSync(sourceConfig,'utf8'));
  config.agent=config.agent||{}; config.agent.run_in_wsl={value:false};
  config.models.default_model={value:'gpt-5.4-mini'};
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(config,null,2));
  let child,cdp;
  try{
    stop();
    child=spawn(exe,['--remote-debugging-port=49418','--no-sandbox',`--user-data-dir=${path.join(root,'electron-profile')}`,'--root',root],{stdio:'ignore',windowsHide:true});
    cdp=connect(await target(49418));await cdp.ready;await cdp.call('Runtime.enable');
    const prompt='You must call image_inspect with action=source_info first. Then call image_inspect with action=crop, image_index=1, x=5000, y=3150, width=800, height=600, scale=3. Read the tiny code in that crop and inspect the full image. Reply in this exact field format using only what you actually see: TEXT=<heading>; LEFT=<color shape>; CENTER=<color shape>; RIGHT=<color shape>; CODE=<tiny code>';
    const result=await evaluate(cdp,`window.api.sendMessage({text:${JSON.stringify(prompt)},images:[{dataUrl:${JSON.stringify(image)},name:'vision-shapes-and-text.png',type:'image/png'}]},'real-vision')`);
    const content=(result.chatMessages||[]).filter(m=>m.role==='assistant').map(m=>String(m.content||'')).join('\n');
    const user=(result.chatMessages||[]).find(m=>m.role==='user');
    const normalized=content.toUpperCase().replace(/\s+/g,' ').trim();
    for(const expected of ['TEXT=NEWMARK 42','LEFT=BLUE CIRCLE','CENTER=GREEN SQUARE','RIGHT=RED TRIANGLE','CODE=CROP-7391']) {
      if(!normalized.includes(expected)) fail(`real vision failed (${expected} missing): ${content.slice(0,500)}`);
    }
    const backendEvents=await evaluate(cdp,`window.api.getState('real-vision').then(s=>(s.workEvents||[]).map(e=>({type:e.type,name:e.toolName,args:e.toolArgs,content:e.content})))`);
    const events=Array.isArray(backendEvents)?backendEvents:[];
    const inspectCalls=(events||[]).filter(e=>e.type==='tool_call'&&e.name==='image_inspect');
    if(!inspectCalls.some(e=>String(e.args||'').includes('source_info'))||!inspectCalls.some(e=>String(e.args||'').includes('"crop"')))fail(`real model did not execute both image_inspect actions: ${JSON.stringify(inspectCalls)}`);
    if(!String(user?.content||'').includes('[1 image attachment]')||String(user?.content||'').includes('data:image'))fail('visible conversation did not safely summarize the attachment');
    console.log(`[release-real-vision-attachment-smoke] PASS model=${result.model} imageInspectCalls=${inspectCalls.length} text+geometry+color+position+crop-code recognized`);
  }finally{try{cdp?.ws.close();}catch{}try{child?.kill();}catch{}stop();fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error.stack||error);stop();process.exit(1);});
