import fs from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {execFileSync,spawn} from 'node:child_process';
// argv[2] is the evidence directory and argv[3] the package under test, and BOTH have a
// default: a bare `node verify-desktop-pet-gpu.mjs` used to throw
// `TypeError [ERR_INVALID_ARG_TYPE]: paths[0] must be string, received undefined` out of
// `path.resolve(undefined)` before it compiled or ran anything. The default mirrors the
// sibling acceptance gate (verify-desktop-pet.mjs) and lands in its own subdirectory, so a
// bare run cannot overwrite the acceptance gate's evidence.
const here=path.dirname(fileURLToPath(import.meta.url)),out=path.resolve(process.argv[2]||path.join(here,'../archive/20261007-virtual-desktop-pet/evidence-gpu')),pkg=path.resolve(process.argv[3]||path.join(here,'../packages/newmark-core'));
fs.mkdirSync(out,{recursive:true});process.env.NEWMARK_USER_ROOT=path.join(out,'user-root');
const {runComputerUse,stopAll}=await import(pathToFileURL(path.join(pkg,'components/computeruse/lib/win32.js')));const {stopDesktopPet}=await import(pathToFileURL(path.join(pkg,'components/computeruse/lib/desktop-pet.js')));
const lib=path.join(pkg,'components/computeruse/lib'),vendor=path.join(pkg,'components/computeruse/vendor/webview2'),compiler=path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const fixture=path.join(out,'fixture.exe'),runner=path.join(out,'gpu-probe.exe');
const refs=['/nologo','/r:System.Drawing.dll','/r:System.Windows.Forms.dll','/r:System.Web.Extensions.dll'];
execFileSync(compiler,[...refs,'/target:winexe','/out:'+fixture,path.join(here,'lib/desktop-pet-probe.cs')],{windowsHide:true});
for(const name of ['Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll'])fs.copyFileSync(path.join(vendor,name),path.join(out,name));
execFileSync(compiler,[...refs,'/platform:x64','/main:GpuProbe','/out:'+runner,'/r:'+path.join(vendor,'Microsoft.Web.WebView2.Core.dll'),'/r:'+path.join(vendor,'Microsoft.Web.WebView2.WinForms.dll'),path.join(lib,'desktop-pet.cs'),path.join(lib,'desktop-menu.cs'),path.join(here,'lib/desktop-pet-gpu-probe.cs')],{windowsHide:true});
const call=async args=>JSON.parse(await runComputerUse({ownerId:'newmate-gpu-qa',...args}));
try{const start=await call({action:'takeover_start',mouseMode:'virtual',desktop:'hidden',launch:process.env.NEWMARK_TEST_EMPTY_DESKTOP?'':'"'+fixture+'" "'+path.join(out,'fixture.json')+'"'});fs.writeFileSync(path.join(out,'start.json'),JSON.stringify(start,null,2));if(!start.ok)throw Error(JSON.stringify(start));await new Promise(r=>setTimeout(r,1200));await stopDesktopPet('GPU integration owns indicator');
 const config={ownerPid:process.pid,desktop:start.target_desktop,asset:path.join(pkg,'components/computeruse/assets/desktop-pet.png'),directory:out,settingsPath:path.join(out,'prefs.json'),menuThemePath:path.join(out,'theme.json'),menuShellPath:path.join(lib,'desktop-menu.html'),menuCachePath:path.join(out,'webview-cache')};fs.writeFileSync(config.settingsPath,JSON.stringify({version:2,size_multiplier:1}));const file=path.join(out,'config.json');fs.writeFileSync(file,JSON.stringify(config));
 const code=await new Promise((resolve,reject)=>{const child=spawn(runner,[file],{windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);const timer=setTimeout(()=>{child.kill();reject(Error('GPU native fixture timeout'));},60000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);resolve(code);});});if(code!==0)process.exitCode=1;
}finally{fs.writeFileSync(path.join(out,'stop.json'),JSON.stringify(await call({action:'takeover_stop'}),null,2));stopAll();}
