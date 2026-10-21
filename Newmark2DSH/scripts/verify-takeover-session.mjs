import fs from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const {createComputerUse}=await import(pathToFileURL(path.join(process.env.NEWMARK_TEST_PACKAGE_ROOT||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../packages/newmark-core'),'components/computeruse/component.js')));
const {stopAll}=await import(pathToFileURL(path.join(process.env.NEWMARK_TEST_PACKAGE_ROOT||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../packages/newmark-core'),'components/computeruse/lib/win32.js')));
const {withComputerUseCaller,computerUseCaller}=await import(pathToFileURL(path.join(process.env.NEWMARK_TEST_PACKAGE_ROOT||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../packages/newmark-core'),'lib/cu-caller.js')));
const out=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../archive/20261007-cu-transfer/evidence');
const core=createComputerUse({root:path.join(out,'session-root'),logger:{warn(){},error(){}}});
const tool=core.tools().find(t=>t.name==='computer_use');
const call=(action,session,owner_id)=>tool.execute({action,mouse_mode:'virtual',owner_id},{agent:{session:{id:session}}});
const checks=[];const check=(name,ok)=>{checks.push({name,ok:!!ok});console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)throw Error(name);};
try {
 const inherited=await Promise.all(['a','b'].map(id=>withComputerUseCaller({agent:{id}},async()=>{await new Promise(resolve=>setTimeout(resolve,5));return computerUseCaller({});})));
 check('parallel Agent API scope preserves independent callers',inherited[0]==='dsh-session:a'&&inherited[1]==='dsh-session:b');
 check('caller context does not leak outside its request',computerUseCaller({})===undefined);
 const first=await call('takeover_start','session-a','shared-model-label');check('host session owns lease instead of model label',first.ok&&first.lease.owner_id==='dsh-session:session-a');
 const second=await call('takeover_start','session-b','shared-model-label');check('another session cannot reuse the same model label',second.ok===false);
 check('failed start does not corrupt component lease mirror',core.leaseView().ownerId==='dsh-session:session-a');
 const stopOther=await call('takeover_stop','session-b','shared-model-label');check('another session cannot release the owner',stopOther.ok===false);
 check('failed stop does not clear component lease mirror',core.leaseView().held);
 const stopped=await call('takeover_stop','session-a','different-model-label');check('owner session can release despite changed model label',stopped.ok&&stopped.released_owner==='dsh-session:session-a');
 check('successful stop clears component mirror',!core.leaseView().held);
} finally {stopAll();fs.writeFileSync(path.join(out,'session-checks.json'),JSON.stringify({checks},null,2));}
