import fs from 'node:fs';import path from 'node:path';import {pathToFileURL}from'node:url';import {execFileSync}from'node:child_process';
const out=path.resolve(process.argv[2]),pkg=path.resolve(process.argv[3]||'Newmark2DSH/packages/newmark-core');fs.mkdirSync(out,{recursive:true});
const {desktopTransfers,compileDesktopTransfer}=await import(pathToFileURL(path.join(pkg,'components/computeruse/lib/desktop-transfer.js')));
const exe=await compileDesktopTransfer(),start=execFileSync(exe,['--identity',String(process.pid)],{encoding:'utf8',windowsHide:true}).trim();
const dir=path.join(out,'mapping');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({id:'registry-test',sourcePid:process.pid}));
const checks=[];function check(name,ok){checks.push({name,ok});console.log((ok?'PASS ':'FAIL ')+name);if(!ok)process.exitCode=1;}
const status={state:'active',pid:process.pid,start,utc:new Date(Date.now()-60000).toISOString()};
function save(){fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(status));}
save();check('a live mapping remains addressable after delayed heartbeat',desktopTransfers(out).length===1);
status.start='1';save();check('a reused PID cannot revive an old mapping',desktopTransfers(out).length===0);status.start=start;
status.state='returned';save();check('a returned mapping is retired',desktopTransfers(out).length===0);
status.state='active';status.pid=2147483647;save();check('a dead broker is excluded',desktopTransfers(out).length===0);
fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(checks,null,2));
