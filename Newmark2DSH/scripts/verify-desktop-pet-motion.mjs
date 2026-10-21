import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url));
const out=path.resolve(process.argv[2]);
process.env.NEWMARK_USER_ROOT=path.join(out,'user-root');
const pkg=path.resolve(process.argv[3] || path.join(here,'../packages/newmark-core'));
const {runComputerUse,stopAll}=await import(pathToFileURL(path.join(pkg,'components/computeruse/lib/win32.js')));
const {compileDesktopPet,stopDesktopPet}=await import(pathToFileURL(path.join(pkg,'components/computeruse/lib/desktop-pet.js')));
fs.mkdirSync(out,{recursive:true});
const framework=path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319');
const compile=(source,exe,extra=[])=>execFileSync(path.join(framework,'csc.exe'),['/nologo','/r:System.Drawing.dll','/r:System.Windows.Forms.dll','/r:System.Web.Extensions.dll',...extra,`/out:${exe}`,source],{windowsHide:true});
const fixture=path.join(out,'fixture.exe'), runner=path.join(out,'motion-probe.exe');
compile(path.join(here,'lib/desktop-pet-probe.cs'),fixture,['/target:winexe']);
compile(path.join(here,'lib/desktop-pet-motion-probe.cs'),runner,['/r:'+path.join(framework,'WPF/UIAutomationClient.dll'),'/r:'+path.join(framework,'WPF/UIAutomationTypes.dll'),'/r:'+path.join(framework,'WPF/WindowsBase.dll')]);
const call=async args=>JSON.parse(await runComputerUse({ownerId:'motion-acceptance',...args}));
let driver;
try {
  const start=await call({action:'takeover_start',mouseMode:'virtual',desktop:'hidden',launch:`"${fixture}" "${path.join(out,'fixture.json')}"`});
  fs.writeFileSync(path.join(out,'start.json'),JSON.stringify(start,null,2));
  if(!start.ok)throw Error(JSON.stringify(start));
  // The production lease owns the hidden fixture. The recorder starts the same
  // shipped native pet itself so it can capture the first entrance frames.
  await new Promise(r=>setTimeout(r,1600));
  await stopDesktopPet('motion-recorder-owns-indicator');
  const exe=await compileDesktopPet();
  const code=await new Promise((resolve,reject)=>{
    driver=spawn(runner,[exe,start.target_desktop,path.join(pkg,'components/computeruse/assets/desktop-pet.png'),out],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    driver.stdout.pipe(process.stdout);driver.stderr.pipe(process.stderr);
    const deadline=setTimeout(()=>{driver.kill();reject(Error('Motion recorder timed out'));},90000);
    driver.once('error',reject);driver.once('exit',c=>{clearTimeout(deadline);resolve(c);});
  });
  if(code!==0)process.exitCode=1;
} finally {
  if(driver && driver.exitCode===null)driver.kill();
  const stop=await call({action:'takeover_stop'});fs.writeFileSync(path.join(out,'stop.json'),JSON.stringify(stop,null,2));stopAll();
}
