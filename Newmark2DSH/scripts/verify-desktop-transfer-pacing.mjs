import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
const out=path.resolve(process.argv[2]),pkg=path.resolve(process.argv[3]||'Newmark2DSH/packages/newmark-core');fs.mkdirSync(out,{recursive:true});
const lib=path.join(pkg,'components/computeruse/lib'),vendor=path.join(pkg,'components/computeruse/vendor/webview2');
const dlls=['Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll'];for(const n of dlls)fs.copyFileSync(path.join(vendor,n),path.join(out,n));
const exe=path.join(out,'pacing.exe');execFileSync(path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/platform:x64','/main:TransferPacingProbe','/r:System.Drawing.dll','/r:System.Windows.Forms.dll','/r:System.Web.Extensions.dll',...dlls.slice(0,2).map(n=>'/r:'+path.join(vendor,n)),'/out:'+exe,...['desktop-pet.cs','desktop-menu.cs','desktop-transfer.cs'].map(n=>path.join(lib,n)),path.resolve('Newmark2DSH/scripts/lib/desktop-transfer-pacing-probe.cs')],{windowsHide:true});
execFileSync(exe,[out],{windowsHide:true,stdio:'inherit',timeout:20000});
