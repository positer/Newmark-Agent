import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url)),out=path.resolve(process.argv[2]);fs.mkdirSync(out,{recursive:true});
const root=path.join(process.env.NEWMARK_TEST_PACKAGE_ROOT||path.resolve(here,'../packages/newmark-core'),'components/computeruse'),lib=path.join(root,'lib'),vendor=path.join(root,'vendor/webview2');
const runner=path.join(out,'meter.exe');
for(const name of ['Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll'])fs.copyFileSync(path.join(vendor,name),path.join(out,name));
execFileSync(path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/platform:x64','/main:AnimationMeter','/out:'+runner,'/r:System.Drawing.dll','/r:System.Windows.Forms.dll','/r:System.Web.Extensions.dll','/r:'+path.join(vendor,'Microsoft.Web.WebView2.Core.dll'),'/r:'+path.join(vendor,'Microsoft.Web.WebView2.WinForms.dll'),path.resolve(process.argv[3]||path.join(lib,'desktop-pet.cs')),path.join(lib,'desktop-menu.cs'),path.join(here,'lib/desktop-animation-meter.cs')],{windowsHide:true});
const file=path.join(out,'config.json');fs.writeFileSync(file,JSON.stringify({desktop:'Default',asset:path.join(root,'assets/desktop-pet.png'),directory:out,settingsPath:path.join(out,'prefs.json')}));
execFileSync(runner,[file],{windowsHide:true,timeout:20000});console.log(fs.readFileSync(path.join(out,'animation-metrics.json'),'utf8'));
