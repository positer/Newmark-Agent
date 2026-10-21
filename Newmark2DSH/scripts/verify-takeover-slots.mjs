import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath,pathToFileURL} from 'node:url';
const {runComputerUse,stopAll}=await import(pathToFileURL(path.join(process.env.NEWMARK_TEST_PACKAGE_ROOT||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../packages/newmark-core'),'components/computeruse/lib/win32.js')));
const self=fileURLToPath(import.meta.url),out=path.resolve(path.dirname(self),'../archive/20261007-cu-transfer/evidence');
const call=async(action,ownerId,mouseMode,extra={})=>JSON.parse(await runComputerUse({action,ownerId,mouseMode,userRoot:path.join(out,'isolated-root'),...extra}));
if(process.argv[2]==='child'){
 try{const result=await call('takeover_start','cross-host',process.argv[3]);process.send(result);}finally{stopAll();process.disconnect();}
}else{
 const checks=[];const check=(name,value)=>{checks.push({name,ok:!!value});console.log(`${value?'PASS':'FAIL'} ${name}`);if(!value)throw Error(name);};
 const competing=mode=>new Promise((resolve,reject)=>{const proc=spawn(process.execPath,[self,'child',mode],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});const timer=setTimeout(()=>{proc.kill();reject(Error('Child timeout'));},20000);proc.once('message',m=>{clearTimeout(timer);resolve(m);});proc.once('error',reject);});
 try {
  check('real owner starts',(await call('takeover_start','owner-real','real')).ok);
  check('virtual owner starts beside real',(await call('takeover_start','owner-virtual','virtual')).ok);
  check('second real owner rejected',!(await call('takeover_start','competitor','real')).ok);
  check('second virtual owner rejected',!(await call('takeover_start','competitor','virtual')).ok);
  check('another host real rejected',!(await competing('real')).ok);
  check('another host virtual rejected',!(await competing('virtual')).ok);
  check('foreign owner cannot deliver physical input',(await call('key','competitor','real',{key:'A'})).error_code==='takeover_lease_occupied');
  check('dry_run cannot bypass ownership',(await call('key','competitor','real',{key:'A',dryRun:true})).error_code==='takeover_lease_occupied');
  check('foreign owner cannot inherit virtual route',(await call('app_key','competitor','virtual',{key:'A'})).error_code==='takeover_lease_occupied');
  const before=await call('mode_report','owner-virtual','virtual');check('report exposes both slots',before.takeover_slots.real?.owner_id==='owner-real'&&before.takeover_slots.virtual?.owner_id==='owner-virtual');
  check('real stop succeeds',(await call('takeover_stop','owner-real','real')).ok);
  const after=await call('mode_report','owner-virtual','virtual');check('real stop retains virtual slot',after.takeover_slots.virtual?.owner_id==='owner-virtual'&&after.takeover_slots.real===null);
  check('new real owner starts while virtual remains',(await call('takeover_start','new-real','real')).ok);
  check('virtual stop succeeds',(await call('takeover_stop','owner-virtual','virtual')).ok);
  check('virtual stop retains real slot',(await call('mode_report','new-real','real')).lease.owner_id==='new-real');
  check('final real stop succeeds',(await call('takeover_stop','new-real','real')).ok);
 }finally{stopAll();fs.writeFileSync(path.join(out,'slots-checks.json'),JSON.stringify({checks},null,2));}
}
