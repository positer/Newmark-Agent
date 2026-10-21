import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath,pathToFileURL} from 'node:url';
const self=fileURLToPath(import.meta.url),childMode=process.argv[2]==='child';
const out=path.resolve(childMode?process.argv[3]:process.argv[2]||'Newmark2DSH/archive/20261007-cu-transfer/recovery');fs.mkdirSync(out,{recursive:true});
const pkg=path.resolve(childMode?process.argv[5]:process.argv[3]||'Newmark2DSH/packages/newmark-core');
const fixture=path.resolve('Newmark2DSH/archive/20261007-cu-transfer/integration-both-final/fixture.exe');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const read=file=>{try{return JSON.parse(fs.readFileSync(file));}catch{return null;}};
if(childMode){
 process.env.NEWMARK_USER_ROOT=path.join(out,'root');const {runComputerUse}=await import(pathToFileURL(path.join(pkg,'components/computeruse/lib/win32.js')));
 const mode=process.argv[4],state=path.join(out,'fixture.json');fs.rmSync(state+'.close',{force:true});
 const call=async args=>{const r=JSON.parse(await runComputerUse({ownerId:'recovery-'+mode,mouseMode:'virtual',...args}));if(!r.ok)throw Error(JSON.stringify(r));return r;};
 let real;if(mode==='import')real=spawn(fixture,[state],{windowsHide:false,detached:true,stdio:'ignore'});
 const start=await call({action:'takeover_start',desktop:'hidden',...(mode==='export'?{launch:`"${fixture}" "${state}"`}:{})});await sleep(1500);
 let original;for(let i=0;i<50;i++){original=read(state);if(original?.hwnd)break;await sleep(100);}if(!original?.hwnd)throw Error('Recovery fixture did not publish its window identity');
 const transfer=await call({action:mode==='export'?'process_push':'process_pull',windowHandle:'0x'+original.hwnd.toString(16)});
 fs.writeFileSync(path.join(out,'ready.json'),JSON.stringify({original,transfer,start},null,2));setInterval(()=>{},1000);
}else{
 const {desktopTransfers,inspectTransferSource}=await import(pathToFileURL(path.join(pkg,'components/computeruse/lib/desktop-transfer.js')));
 const checks=[];const check=(name,ok)=>{console.log(`${ok?'PASS':'FAIL'} ${name}`);checks.push({name,ok:!!ok});if(!ok)throw Error(name);};
 try{for(const mode of ['import','export']){
  const dir=path.join(out,mode);fs.mkdirSync(dir,{recursive:true});fs.rmSync(path.join(dir,'ready.json'),{force:true});const proc=spawn(process.execPath,[self,'child',dir,mode,pkg],{windowsHide:true,stdio:['ignore','ignore','pipe']});let errors='';proc.stderr.on('data',b=>errors+=b);
  try{let ready;for(let i=0;i<900;i++){ready=read(path.join(dir,'ready.json'));if(ready)break;if(proc.exitCode!==null)throw Error(errors);await sleep(100);}if(!ready)throw Error('Recovery fixture timed out');
   proc.kill();await sleep(3500);const t=ready.transfer,config={sourceDesktop:t.original_desktop,sourceHandle:t.original_window_handle,sourcePid:t.original_process_id};
   const inspected=await inspectTransferSource(config);check(mode+' retains original process identity after owner death',inspected.start===t.original_process_start);
   if(mode==='import')check('owner death restores imported real window on screen',inspected.visible&&inspected.x>-10000&&inspected.y>-10000);
   else {let record=desktopTransfers().find(r=>r.config.id===t.transfer_id);check('owner death retains exported presentation',record?.status.side==='real');process.kill(record.status.pid);await sleep(4500);record=desktopTransfers().find(r=>r.config.id===t.transfer_id);check('guardian recovers crashed exported presentation',record?.status.pid!==t.proxy_process_id&&record?.status.state==='active');const again=await inspectTransferSource(config);check('broker recovery never restarts original',again.start===t.original_process_start);}
  }finally{if(proc.exitCode===null)proc.kill();fs.writeFileSync(path.join(dir,'fixture.json.close'),'done');await sleep(1200);}
 }}finally{fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(checks,null,2));}
}
