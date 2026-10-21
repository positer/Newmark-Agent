// Real Chromium process, isolated profile/site. CU supplies the input. The test
// HTTP server independently records delivery; capture pixels prove repainting.
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import {spawn,execFileSync} from 'node:child_process';import{pathToFileURL,fileURLToPath}from'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),out=path.resolve(process.argv[2]),pkg=path.resolve(process.argv[3]||path.join(here,'../packages/newmark-core'));fs.mkdirSync(out,{recursive:true});process.env.NEWMARK_USER_ROOT=path.join(out,'user-root');
const {runComputerUse,stopAll}=await import(pathToFileURL(path.join(pkg,'components/computeruse/lib/win32.js')));
const {desktopPetState}=await import(pathToFileURL(path.join(pkg,'components/computeruse/lib/desktop-pet.js')));
const exe=path.join(out,'window-probe.exe');execFileSync(path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/out:'+exe,'/r:System.Drawing.dll','/r:System.Windows.Forms.dll',path.join(here,'lib/desktop-browser-window-probe.cs')],{windowsHide:true});
const run=(...args)=>execFileSync(exe,args,{encoding:'utf8',windowsHide:true}).trim(),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const title='Browser Live QA '+process.pid;const events=[],checks=[];let seq=0,win,exported,lastObservation;
function check(name,ok,detail){checks.push({name,ok:!!ok,detail});console.log((ok?'PASS ':'FAIL ')+name);if(!ok)process.exitCode=1;}
const server=http.createServer((q,r)=>{if(q.url.startsWith('/event')){events.push({at:Date.now(),url:q.url});r.end('ok');return;}r.setHeader('content-type','text/html');r.end(`<title>${title}</title><style>body{margin:0;background:rgb(200,30,30)}button{position:absolute;inset:0;width:100%;height:75%;background:transparent;border:0;font-size:24px}input{position:absolute;top:80%;width:90%;height:50px}</style><button onclick="document.body.style.background='rgb('+(30+25*++clicks)+',180,'+(200-25*clicks)+')';fetch('/event?click='+clicks);net()">Isolated NewMate browser transfer test</button><input oninput="fetch('/event?text='+encodeURIComponent(this.value))"><script>let clicks=0;function net(){fetch('https://www.microsoft.com/?newmate='+Date.now(),{mode:'no-cors',cache:'no-store'}).then(()=>fetch('/event?https=ok')).catch(()=>fetch('/event?https=failed'))}net();setInterval(()=>fetch('/event?heartbeat='+Date.now()),700)</script>`);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url='http://127.0.0.1:'+server.address().port,edge=process.env.NEWMARK_TEST_EDGE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
// Diagnostic comparison only: never changes the installed browser/profile or
// the product's networking. Keep ordinary proxy baseline failures in evidence.
const networkArgs=process.env.NEWMARK_TEST_BROWSER_NETWORK==='direct'?['--no-proxy-server']:[];
const call=async args=>{const result=JSON.parse(await runComputerUse({ownerId:'browser-transfer-qa',mouseMode:'virtual',...args}));fs.writeFileSync(path.join(out,`${++seq}-${args.action}.json`),JSON.stringify(result,null,2));if(!result.ok)throw Error(JSON.stringify(result));return result;};
async function observe(handle,name,mouseMode='virtual'){const file=path.join(out,name+'.png');const result=await call({action:'app_observe',windowHandle:handle,observation:'full',imagePath:file,mouseMode});lastObservation=result;const actual=result.image_path||result.capture?.image_path||file;if(actual!==file)run('convert',actual,file);return run('pixel',actual,'100','250');}
async function interact(handle,name,mouseMode='virtual'){
 fs.writeFileSync(path.join(out,name+'-native-before.json'),run('state',handle));const before=await observe(handle,name+'-before',mouseMode);const count=events.filter(e=>e.url.includes('click=')).length,networkBefore=events.filter(e=>e.url.includes('https=ok')).length;
 await call({action:'app_click',windowHandle:handle,x:100,y:250,mouseMode});await sleep(1200);
 fs.writeFileSync(path.join(out,name+'-native-after.json'),run('state',handle));check(name+' click reaches original DOM and HTTP server',events.filter(e=>e.url.includes('click=')).length>count,events.slice(-6));
 const after=await observe(handle,name+'-after',mouseMode);check(name+' capture reflects new page pixels',before!==after,{before,after});
 const inputY=Math.round((lastObservation.app?.client_rect?.height||lastObservation.window?.client_rect?.height)*.9),text='NewMate-'+name;
 await call({action:'app_click',windowHandle:handle,x:100,y:inputY,mouseMode});await call({action:'app_type',windowHandle:handle,text,mouseMode});await sleep(500);
 check(name+' keyboard text reaches original DOM',events.some(e=>decodeURIComponent(e.url).includes('text=')&&decodeURIComponent(e.url).includes(text)),events.filter(e=>e.url.includes('text=')).slice(-1));
 for(let i=0;i<60&&events.filter(e=>e.url.includes('https=ok')).length<=networkBefore;i++)await sleep(200);check(name+' browser has HTTPS connectivity',events.filter(e=>e.url.includes('https=ok')).length>networkBefore,events.filter(e=>e.url.includes('https=')));
}
try{
 spawn(edge,[...networkArgs,'--user-data-dir='+path.join(out,'real-profile'),'--no-first-run','--no-default-browser-check','--new-window','--window-position=100,100','--window-size=800,600',url],{windowsHide:false,stdio:'ignore'});
 for(let i=0;i<100;i++){const text=run('find',title);if(text){win=JSON.parse(text);break;}await sleep(100);}if(!win)throw Error('test browser missing');await sleep(2000);
 await call({action:'app_activate',windowHandle:win.hwnd,mouseMode:'real'});
 for(let i=0;i<100&&!events.some(e=>e.url.includes('heartbeat='));i++)await sleep(100);
 if(!events.some(e=>e.url.includes('heartbeat=')))throw Error('Test browser DOM did not become ready before transfer');
 for(let i=0;i<60&&!events.some(e=>e.url.includes('https=ok'));i++)await sleep(200);check('browser HTTPS baseline before transfer',events.some(e=>e.url.includes('https=ok')),events.filter(e=>e.url.includes('https=')));
 await call({action:'takeover_start',desktop:'hidden'});const pulled=await call({action:'process_pull',windowHandle:win.hwnd});
 check('pull retains browser process',pulled.original_process_id===win.pid&&!pulled.original_process_restarted,pulled.original_process_id);
 await interact(pulled.window_handle,'imported');
 const petHandle='0x'+BigInt(desktopPetState().window.hwnd).toString(16);run('toggle',petHandle);await sleep(1800);
 check('preview is expanded for refresh test',desktopPetState().window.expanded,desktopPetState().window);
 await interact(pulled.window_handle,'imported-expanded');run('toggle',petHandle);await sleep(900);
 const returned=await call({action:'process_push',transferId:pulled.transfer_id});check('push restores original window',returned.window_handle.toLowerCase()===win.hwnd.toLowerCase(),returned.window_handle);
 await call({action:'takeover_stop'});
 await call({action:'app_activate',windowHandle:win.hwnd,mouseMode:'real'});
 await interact(win.hwnd,'restored','real');run('close',win.hwnd);win=null;await sleep(800);
 await call({action:'takeover_start',desktop:'hidden',launch:`"${edge}" ${networkArgs.join(' ')} --user-data-dir="${path.join(out,'hidden-profile')}" --no-first-run --no-default-browser-check --new-window --window-size=800,600 ${url}`});await sleep(3500);
 const apps=await call({action:'app_list'});const browser=(apps.applications||apps.windows||[]).find(w=>w.title?.startsWith(title));
 if(!browser)throw Error('hidden browser window missing: '+JSON.stringify(apps));
 await interact(browser.handle||browser.window_handle,'hidden-original');
 const pushed=await call({action:'process_push',windowHandle:browser.handle||browser.window_handle});
 check('hidden export retains original browser process',pushed.original_process_id===(browser.process_id||browser.pid),pushed);
 exported=pushed.window_handle;await call({action:'takeover_stop'});await interact(exported,'exported','real');
}finally{try{await call({action:'takeover_stop'});}catch{}stopAll();if(win)run('close',win.hwnd);if(exported)run('close',exported);server.close();fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({networkMode:networkArgs.length?'isolated-profile-direct':'system-default',checks,events},null,2));}
