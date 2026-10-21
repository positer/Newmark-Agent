import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, fork } from 'node:child_process';
import { startDesktopPet, stopDesktopPet, desktopPetState } from '../packages/newmark-core/components/computeruse/lib/desktop-pet.js';
const here=path.dirname(fileURLToPath(import.meta.url));
const out=path.resolve(process.argv[2]);
process.env.NEWMARK_USER_ROOT=path.join(out,'user-root');
fs.mkdirSync(out,{recursive:true});
const checks=[], facts={};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function check(name,ok,detail) { checks.push({name,ok:!!ok,detail}); console.log(`${ok?'PASS':'FAIL'} ${name}`); }
async function until(fn,ms=10000) { const start=Date.now(); while(Date.now()-start<ms) {const result=await fn(); if(result)return result; await sleep(100);}throw Error('Condition timed out'); }
function drive(action,hwnd,args=[]) {return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(here,'lib/desktop-pet-driver.ps1'),'-Action',action,'-HandleValue',String(hwnd),...args],{encoding:'utf8',windowsHide:true,timeout:20000}));}
function click(state) {drive('click',state.hwnd,['-X',String(state.bounds.width>>1),'-Y',String(state.bounds.height>>1)]);}
function alive(pid) {try {process.kill(pid,0);return true;}catch{return false;}}
let child;
function childState() {return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owner did not reply')),5000);child.once('message',m=>{clearTimeout(timer);resolve(m.state);});child.send('state');});}
try {
  // Cancellation during compilation must not create a late orphan window.
  const pending=startDesktopPet(); await stopDesktopPet('cancel-pending'); await pending;
  check('stop during startup prevents a late pet',!desktopPetState().running,desktopPetState());
  await startDesktopPet();
  let first=desktopPetState().window; facts.first=first;
  drive('drag',first.hwnd,['-X',String(first.bounds.width>>1),'-Y',String(first.bounds.height>>1),'-Dx','-420','-Dy','-100']);
  await sleep(400);
  child=fork(path.join(here,'lib/desktop-pet-owner.mjs'),[],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Child startup timed out')),20000);child.once('message',m=>{clearTimeout(timer);resolve(m.state);});});
  facts.second=ready;
  check('independent owner creates a second pet',ready.running,ready);
  first=desktopPetState().window; click(first);
  await until(()=>desktopPetState().window?.expanded);
  const other=await until(async()=>{const s=await childState();return s.window?.outline_active===false && s;});
  check('any expanded viewer disables the other pet outline',!other.window.expanded && !other.window.outline_active,other);
  drive('escape',desktopPetState().window.viewer_hwnd);
  await until(()=>!desktopPetState().window?.expanded);
  const restored=await until(async()=>{const s=await childState();return s.window?.outline_active && s;});
  check('closing last viewer restores other pet outline',restored.window.outline_active,restored);
  click(restored.window);
  const expanded=await until(async()=>{const s=await childState();return s.window?.expanded && s.window.capture_pid && s;});
  facts.beforeOwnerDeath=expanded;
  child.kill();
  await until(()=>!alive(expanded.pid) && !alive(expanded.window.capture_pid),8000);
  check('owner death removes pet and capture processes',!alive(expanded.pid) && !alive(expanded.window.capture_pid),expanded);
  check('owner death destroys read-only viewer',!drive('alive',expanded.window.viewer_hwnd).exists);
  await until(()=>desktopPetState().window?.outline_active);
  check('surviving pet restores outline after other owner dies',desktopPetState().window.outline_active);
} catch(error) {check('lifecycle suite completes',false,error.stack);}
finally {if(child && child.exitCode===null)child.kill();await stopDesktopPet();fs.writeFileSync(path.join(out,'lifecycle-results.json'),JSON.stringify({checks,facts},null,2));}
console.log(`${checks.filter(c=>c.ok).length}/${checks.length} passed`);
process.exitCode=checks.some(c=>!c.ok)?1:0;
