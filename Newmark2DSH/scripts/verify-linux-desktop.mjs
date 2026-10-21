import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const base = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = process.env.NEWMARK_TEST_PACKAGE_ROOT || path.join(base, '../packages/newmark-core');
const backendUrl = pathToFileURL(path.join(packageRoot,'components/computeruse/lib/linux.js'));
const { runComputerUse, stopAll } = await import(backendUrl);
const out = path.resolve(process.argv[2] || path.join(base, '../archive/20261008-linux-wsl/evidence'));
fs.mkdirSync(out, { recursive:true });
process.env.NEWMARK_LINUX_LOG = path.join(out, 'native.log');
const fixture = path.join(base, 'lib/linux-desktop-fixture.py');
const receipts = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function readyState(file) {
  for (let i=0;i<50;i++) {
    try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { await sleep(100); }
  }
  throw Error(`Fixture did not create its ready state: ${file}`);
}
async function call(action, args={}) {
  const result = JSON.parse(await runComputerUse({ action, ownerId:'linux-wsl-qa', mouseMode:'virtual', ...args }));
  receipts.push({ action, args, result });
  fs.writeFileSync(path.join(out, 'receipts.json'), JSON.stringify(receipts,null,2));
  return result;
}
const checks=[];
function check(name, condition) { checks.push({name,pass:!!condition}); console.log(`${condition?'PASS':'FAIL'} ${name}`); assert.ok(condition, name); }
let real;
try {
  let r = await call('takeover_start');
  check('authenticated private Xvfb starts', r.ok && r.hidden_desktop.display !== process.env.DISPLAY);
  await sleep(700);
  r = await call('app_list'); check('default startup has zero applications', r.ok && r.applications.length === 0);
  r = await call('observe'); check('empty desktop capture', r.ok && r.width ===1280 && r.height===720);
  fs.copyFileSync(r.image_path, path.join(out,'empty.png'));
  const extrema=execFileSync('python3',['-c','from PIL import Image; import sys; print(Image.open(sys.argv[1]).getextrema())',r.image_path],{encoding:'utf8'}).trim();
  check('empty desktop is pixel-exact black',extrema==='((0, 0), (0, 0), (0, 0))');
  const pointer = () => execFileSync('xdotool',['getmouselocation','--shell'],{encoding:'utf8'}).split('\n').slice(0,2).join('\n');
  const before = pointer();
  r=await call('move',{x:620,y:380}); check('virtual input delivered',r.ok);
  check('real pointer unchanged',pointer()===before);
  r=await call('move',{x:30,y:30,dryRun:true}); check('dry run does not deliver',r.ok && r.action_executed===false && pointer()===before);
  r=await call('observe',{observation:'sparse',sparseWaitMs:200}); check('sparse observation keeps baseline',r.ok && r.baseline_present && !r.changed);
  r=await call('wait_for',{text:'absent application',timeoutMs:100}); check('wait_for times out without launching',r.ok && !r.matched);
  r=await call('takeover_start',{mouseMode:'real'}); check('real and virtual slots coexist',r.ok);
  r=await call('app_list',{mouseMode:undefined}); check('dual-slot actions require explicit mode',r.error_code==='mouse_mode_required');
  r=await call('takeover_stop',{mouseMode:'real'}); check('stopping real preserves virtual',r.ok);
  r=await call('app_list'); check('virtual survives real stop',r.ok && r.applications.length===0);
  r=await call('takeover_start',{mouseMode:'real',ownerId:'different-real-session'}); check('another session may own independent real slot',r.ok);
  r=await call('process_push',{windowHandle:'1'}); check('crossing is blocked by another real owner',r.error_code==='takeover_lease_occupied');
  await call('takeover_stop',{mouseMode:'real',ownerId:'different-real-session'});
  r=await call('takeover_start',{ownerId:'other-session'}); check('same-host owner exclusion',!r.ok && r.error_code==='takeover_lease_occupied');
  const moduleUrl = backendUrl.href;
  const challenger=spawn(process.execPath,['--input-type=module','-e',`import {runComputerUse,stopAll} from ${JSON.stringify(moduleUrl)}; console.log(await runComputerUse({action:'takeover_start',mouseMode:'virtual',ownerId:'other-host'}));stopAll();`],{stdio:['ignore','pipe','pipe']});
  let text=''; challenger.stdout.on('data',b=>text+=b); await new Promise(r=>challenger.on('exit',r));
  check('cross-host kernel exclusion',JSON.parse(text).error_code==='takeover_lease_occupied');
  const vState=path.join(out,'virtual-fixture.json');
  fs.rmSync(vState,{force:true});
  r=await call('takeover_start',{launch:`python3 ${JSON.stringify(fixture)} ${JSON.stringify(vState)}`}); check('explicit launch only',r.ok);
  await sleep(800);
  let state=await readyState(vState); const initial={...state};
  await call('wait_for',{windowHandle:String(state.xid),timeoutMs:5000});
  r=await call('wait_for',{text:'isolation fixture',timeoutMs:100}); check('wait_for detects live X11 title',r.ok && r.matched);
  r=await call('app_click',{windowHandle:String(state.xid),x:-1,y:100}); check('out-of-client input refused',!r.ok);
  r=await call('app_click',{windowHandle:String(state.xid),x:120,y:100}); check('virtual app_click',r.ok);
  await sleep(150); state=JSON.parse(fs.readFileSync(vState)); check('fixture observes virtual click',state.clicks===1);
  r=await call('app_key',{windowHandle:String(state.xid),key:'a'}); check('virtual app_key',r.ok);
  await sleep(150); state=JSON.parse(fs.readFileSync(vState)); check('fixture observes virtual key',state.keys>=1);
  r=await call('process_push',{windowHandle:String(state.xid)}); check('push preserves process identity',r.ok && r.process_id===initial.pid);
  const exported=r;
  await sleep(500);
  state=JSON.parse(fs.readFileSync(vState)); check('push preserves source XID and state',state.xid===initial.xid && state.clicks===1);
  r=await call('process_pull',{transferId:exported.transfer_id}); check('return exported source without restart',r.ok && Number(r.window_handle)===initial.xid);
  const realState=path.join(out,'real-fixture.json');
  fs.rmSync(realState,{force:true});
  real=spawn('python3',[fixture,realState],{stdio:'ignore'});
  await sleep(2200); const original=await readyState(realState);
  r=await call('process_pull',{windowHandle:String(original.xid)}); check('pull existing WSLg window preserves PID',r.ok && r.process_id===original.pid);
  const imported=r;
  await sleep(500);
  r=await call('app_click',{windowHandle:imported.window_handle,x:150,y:120}); check('click imported presentation',r.ok);
  await sleep(400); state=JSON.parse(fs.readFileSync(realState)); check('original real process receives mapped click',state.clicks===1 && state.xid===original.xid);
  r=await call('observe'); if(r.ok)fs.copyFileSync(r.image_path,path.join(out,'imported.png'));
  r=await call('takeover_stop'); check('stop restores real imports',r.ok && !r.retained_exported_applications);
  check('real application remains alive',real.exitCode===null);
  await sleep(600);
  const visible = xid => execFileSync('python3',['-c',
    'from Xlib import display; import sys; d=display.Display(); print(d.create_resource_object("window",int(sys.argv[1])).get_attributes().map_state)',String(xid)],{encoding:'utf8'}).trim()==='2';
  check('restored source is viewable on WSLg',visible(original.xid));
  r=await call('takeover_start'); check('new session is reusable',r.ok);
  r=await call('process_pull',{windowHandle:String(original.xid)}); check('import for crash recovery',r.ok);
  r=await call('mode_report'); const helperPid=r.host_pid;
  process.kill(helperPid,'SIGKILL');
  await sleep(1600);
  check('SaveSet restores source after helper SIGKILL',visible(original.xid) && real.exitCode===null);
  r=await call('takeover_start'); check('kernel slot released after helper crash',r.ok);
  r=await call('app_list'); check('crash recovery starts empty',r.ok && r.applications.length===0);
  await call('takeover_stop');
  const {createComputerUse}=await import(pathToFileURL(path.join(packageRoot,'components/computeruse/component.js')));
  const core=createComputerUse({root:path.join(out,'component-root'),captionDir:out,logger:{warn(){},error(){}}});
  const tool=core.tools().find(t=>t.name==='computer_use');
  const session={agent:{session:{id:'linux-real-host-session'}}};
  r=await tool.execute({action:'takeover_start',mouse_mode:'virtual',owner_id:'model-spoof'},session);
  check('DSH component binds trusted session identity on Linux',r.ok && r.lease.owner_id==='dsh-session:linux-real-host-session');
  r=await tool.execute({action:'takeover_start',mouse_mode:'virtual',owner_id:'model-spoof'},{agent:{session:{id:'different'}}});
  check('DSH model owner_id cannot steal Linux slot',!r.ok);
  r=await tool.execute({action:'takeover_stop',mouse_mode:'virtual',owner_id:'changed'},session);
  check('DSH component releases original session',r.ok && !core.leaseView().held);
  fs.rmSync(vState,{force:true});
  r=await call('takeover_start',{launch:`python3 ${JSON.stringify(fixture)} ${JSON.stringify(vState)}`});
  state=await readyState(vState);
  r=await call('wait_for',{windowHandle:String(state.xid),timeoutMs:5000}); check('export fixture became viewable',r.ok && r.matched);
  r=await call('process_push',{windowHandle:String(state.xid)}); check('export for lifetime check',r.ok);
  r=await call('takeover_stop'); check('explicit export survives virtual stop',r.ok && r.retained_exported_applications);
  process.kill(state.pid,0); check('exported source PID still running',true);
  r=await call('takeover_start'); check('retained export cannot contaminate a new session',r.error_code==='retained_exports_active');
  process.kill(state.pid,'SIGTERM'); await sleep(1000);
  r=await call('mode_report'); check('closing last export reclaims private server',r.ok && r.virtual_display===null && r.desktop_transfers.length===0);
} finally {
  await call('takeover_stop').catch(()=>{});
  real?.kill(); stopAll();
  fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(checks,null,2));
}
