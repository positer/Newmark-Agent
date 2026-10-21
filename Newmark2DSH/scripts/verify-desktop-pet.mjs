// Native acceptance: actual lease, hidden fixture, physical clicks/drag, fresh pixels.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url));
// Optional third argument exercises the actual unpacked npm artifact, not source.
const pkg=path.resolve(process.argv[3] || path.join(here,'../packages/newmark-core'));
const { runComputerUse, stopAll }=await import(pathToFileURL(path.join(pkg,'components/computeruse/lib/win32.js')));
const { desktopPetState }=await import(pathToFileURL(path.join(pkg,'components/computeruse/lib/desktop-pet.js')));
const out=path.resolve(process.argv[2] || path.join(here,'../archive/20261007-virtual-desktop-pet/evidence'));
process.env.NEWMARK_USER_ROOT=path.join(out,'user-root');
fs.mkdirSync(out,{recursive:true});
const checks=[];
const facts={};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function check(name,ok,detail) { checks.push({name,ok:!!ok,detail}); console.log(`${ok?'PASS':'FAIL'} ${name}`); }
async function until(fn,timeout=15000) { const start=Date.now(); while(Date.now()-start<timeout) { const result=fn(); if(result) return result; await sleep(100); } throw new Error('Condition timed out'); }
function drive(action,hwnd,extra=[]) { return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(here,'lib/desktop-pet-driver.ps1'),'-Action',action,'-HandleValue',String(hwnd),...extra],{encoding:'utf8',windowsHide:true,timeout:20000}).trim()); }
const call=async options=>JSON.parse(await runComputerUse({ownerId:'desktop-pet-acceptance',...options}));
const fixtureState=path.join(out,'fixture-state.json'), fixtureExe=path.join(out,'pet-probe.exe');
execFileSync(path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:winexe','/r:System.Drawing.dll','/r:System.Windows.Forms.dll','/r:System.Web.Extensions.dll',`/out:${fixtureExe}`,path.join(here,'lib/desktop-pet-probe.cs')],{windowsHide:true});
let petHwnd=0,viewerHwnd=0;
try {
  facts.foregroundBefore=drive('alive',0).foreground;
  facts.start=await call({action:'takeover_start',mouseMode:'virtual',desktop:'hidden',launch:`"${fixtureExe}" "${fixtureState}"`});
  check('production hidden virtual lease starts',facts.start.ok,facts.start);
  if(!facts.start.ok) throw new Error(facts.start.error);
  let state=await until(()=>{const s=desktopPetState();return s.running && s.window;},45000);
  facts.initial=state; petHwnd=state.hwnd;
  check('virtual mode creates pet instead of screen frame',state.kind==='virtual-desktop-pet' && !state.expanded && state.outline_active,state);
  facts.native=drive('probe',petHwnd);
  check('virtual startup does not activate a desktop window',facts.native.foreground===facts.foregroundBefore,{before:facts.foregroundBefore,after:facts.native.foreground});
  check('pet is layered, topmost, tool window and no-activate',(facts.native.style&0x08080088)===0x08080088,facts.native);
  check('transparent corner passes through',facts.native.corner_hit!==petHwnd,facts.native);
  drive('capture',petHwnd,['-OutputPath',path.join(out,'pet-collapsed-a.png')]);
  await sleep(730);
  drive('capture',petHwnd,['-OutputPath',path.join(out,'pet-collapsed-b.png')]);
  const before={...state.bounds};
  drive('drag',petHwnd,['-X',String(Math.floor(before.width/2)),'-Y',String(Math.floor(before.height/2)),'-Dx','-170','-Dy','-80']);
  state=await until(()=>{const s=desktopPetState().window;return s && s.bounds.x!==before.x && s;});
  facts.dragged=state;
  check('physical drag moves pet without expanding',state.bounds.x===before.x-170 && state.bounds.y===before.y-80 && !state.expanded,state);
  drive('click',petHwnd,['-X',String(Math.floor(state.bounds.width/2)),'-Y',String(Math.floor(state.bounds.height/2))]);
  state=await until(()=>{const s=desktopPetState().window;return s?.expanded && s.viewer_transition==='open' && s;});
  viewerHwnd=state.viewer_hwnd; facts.expanded=state;
  const native=drive('probe',viewerHwnd); facts.viewerNative=native;
  check('viewer covers pet monitor exactly',JSON.stringify(native.bounds)===JSON.stringify(facts.native.monitor),native);
  check('expanded state removes outline',!state.outline_active,state);
  state=await until(()=>{const s=desktopPetState().window;return s?.frames>0 && s;},18000);
  facts.live=state;
  check('hidden desktop capture produces live frames',state.frames>0 && !state.error,state);
  drive('capture',viewerHwnd,['-OutputPath',path.join(out,'viewer-live.png')]);
  drive('capture',petHwnd,['-OutputPath',path.join(out,'pet-expanded.png')]);
  const beforeInput=read(fixtureState);
  drive('click',viewerHwnd,['-X','200','-Y','200']);
  drive('key',viewerHwnd);
  await sleep(500);
  const afterInput=read(fixtureState);
  check('viewer absorbs physical mouse and keyboard',beforeInput.clicks===afterInput.clicks && beforeInput.keys===afterInput.keys,{beforeInput,afterInput});
  facts.fixtureBefore=beforeInput; facts.fixtureAfter=afterInput;
  const capturePid=desktopPetState().window.capture_pid;
  process.kill(capturePid);
  const failedFrame=await until(()=>{const s=desktopPetState().window;return s?.error && s;});
  check('capture worker failure is reported without closing viewer',failedFrame.expanded && !failedFrame.capture_pid,failedFrame);
  const recovered=await until(()=>{const s=desktopPetState().window;return s?.capture_pid && s.capture_pid!==capturePid && !s.error && s;});
  check('capture restarts after isolated worker failure',recovered.expanded && recovered.capture_pid!==capturePid,recovered);
  drive('escape',viewerHwnd);
  state=await until(()=>{const s=desktopPetState().window;return s && !s.expanded && s;});
  check('Escape collapses and restores outline',state.outline_active && !state.viewer_hwnd,state);
  check('viewer HWND is destroyed on collapse',!drive('alive',viewerHwnd).exists);
  drive('click',petHwnd,['-X',String(Math.floor(state.bounds.width/2)),'-Y',String(Math.floor(state.bounds.height/2))]);
  state=await until(()=>{const s=desktopPetState().window;return s?.expanded && s;});
  drive('click',petHwnd,['-X',String(Math.floor(state.bounds.width/2)),'-Y',String(Math.floor(state.bounds.height/2))]);
  state=await until(()=>{const s=desktopPetState().window;return s && !s.expanded && s;});
  check('second pet click collapses viewer',state.outline_active,state);
} catch(error) { check('native acceptance completes',false,error.stack); }
finally {
  facts.stop=await call({action:'takeover_stop'});
  stopAll();
  await sleep(2200);
  check('stop removes pet window',!petHwnd || !drive('alive',petHwnd).exists);
  check('stop releases the hidden desktop and every owned process',facts.stop.hidden_desktop?.desktop_gone && facts.stop.hidden_desktop?.all_processes_gone,facts.stop.hidden_desktop);
  fs.writeFileSync(path.join(out,'native-results.json'),JSON.stringify({checks,facts},null,2));
}
console.log(`${checks.filter(c=>c.ok).length}/${checks.length} passed`);
process.exitCode=checks.some(c=>!c.ok)?1:0;
