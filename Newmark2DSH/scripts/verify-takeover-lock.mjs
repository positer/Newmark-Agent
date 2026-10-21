import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath,pathToFileURL} from 'node:url';
const {acquireTakeoverLock}=await import(pathToFileURL(path.join(process.env.NEWMARK_TEST_PACKAGE_ROOT||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../packages/newmark-core'),'components/computeruse/lib/takeover-lock.js')));
const self=fileURLToPath(import.meta.url);
if(process.argv[2]==='child'){
  const lock=await acquireTakeoverLock(process.argv[3]);process.send({ok:lock.ok,code:lock.error_code||null});
  process.on('message',async message=>{if(message==='release'){lock.release?.();await lock.closed;process.exit(0);}});
  if(!lock.ok)process.exit(0);
} else {
  const results=[],children=[],locks=[];const check=(name,ok)=>{results.push({name,ok:!!ok});console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)throw new Error(name);};
  const child=mode=>new Promise((resolve,reject)=>{
    const proc=spawn(process.execPath,[self,'child',mode],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});children.push(proc);let errors='';proc.stderr.on('data',b=>errors+=b);
    const timer=setTimeout(()=>reject(new Error('Child lock timeout '+errors)),15000);
    proc.once('message',result=>{clearTimeout(timer);resolve({proc,result});});proc.once('error',reject);proc.once('exit',code=>{if(code){clearTimeout(timer);reject(new Error(errors));}});
  });
  try {
    const real=await acquireTakeoverLock('real');locks.push(real);check('first real lease acquired',real.ok);
    const virtual=await acquireTakeoverLock('virtual');locks.push(virtual);check('one real and one virtual may coexist',virtual.ok);
    check('another process cannot acquire real',(await child('real')).result.ok===false);
    check('another process cannot acquire virtual',(await child('virtual')).result.ok===false);
    const duplicate=await acquireTakeoverLock('real');locks.push(duplicate);check('another module call in same process cannot acquire occupied slot',!duplicate.ok);
    real.release();await real.closed;
    const next=await child('real');check('explicit release permits the next owner',next.result.ok);
    next.proc.kill();await new Promise(resolve=>next.proc.once('exit',resolve));
    let recovered;for(let i=0;i<20;i++){recovered=await acquireTakeoverLock('real');if(recovered.ok)break;await new Promise(r=>setTimeout(r,100));}
    locks.push(recovered);check('owner process death releases kernel slot',recovered.ok);
    check('other mode remains held after real owner death',!(await child('virtual')).result.ok);
  }finally{
    for(const lock of locks)lock.release?.();for(const proc of children)if(proc.exitCode===null)proc.kill();await Promise.all(locks.map(lock=>lock.closed));
    const out=path.resolve(path.dirname(self),'../archive/20261007-cu-transfer/evidence/lock-checks.json');fs.writeFileSync(out,JSON.stringify({results},null,2));
  }
}
