// Optional physical-input isolation for an owned Electron test process.
// No production pointer listener, timeout, renderer or gesture is replaced.
const fs=require('node:fs'),path=require('node:path');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function isolationEnabled(options={}){
  return options.enabled ?? process.env.NEWMARK_TEST_OFFSCREEN==='1';
}
function testElectronEntry(desktopRoot,runtime,inspectorPort,options){
  if(!isolationEnabled(options))return '.';
  const entry=path.join(runtime,'electron-isolated-entry.cjs');
  fs.writeFileSync(entry,`const request=require('node:module').createRequire(${JSON.stringify(path.join(desktopRoot,'package.json'))});global.__newmarkTestElectron=request('electron');global.__newmarkTestElectron.app.setAppPath(${JSON.stringify(desktopRoot)});process.argv[1]=${JSON.stringify(desktopRoot)};require('node:inspector').open(${inspectorPort},'127.0.0.1');request('./dist/main.js');`);
  return entry;
}
async function isolateTestWindow(child,inspectorPort,connect,options){
  if(!isolationEnabled(options))return null;
  let target;
  for(let i=0;i<40;i++){try{target=(await(await fetch('http://127.0.0.1:'+inspectorPort+'/json/list')).json())[0];if(target)break;}catch{}await sleep(100);}
  if(!target)throw Error('Own main inspector unavailable');
  const main=connect(target);await main.ready;
  try{
    const identity=await main.call('Runtime.evaluate',{expression:'process.pid',returnByValue:true});
    if(identity.result.value!==child.pid)throw Error('Refusing main inspector PID mismatch');
    const result=await main.call('Runtime.evaluate',{expression:`(()=>{const w=global.__newmarkTestElectron.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('index.html'));if(!w)throw Error('Own main window missing');const before=w.getBounds();w.setPosition(10000,10000,false);return{pid:process.pid,before,after:w.getBounds(),visible:w.isVisible(),url:w.webContents.getURL()};})()`,returnByValue:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result.value;
  }finally{main.socket.close();}
}
module.exports={testElectronEntry,isolateTestWindow};
