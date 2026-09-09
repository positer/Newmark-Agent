// Render a review gallery of unmodified application screenshots.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const root = path.resolve(process.argv[2]);
const folders = (process.argv[3] || 'final-pc,mobile-final-pixelcopy,glass,consistency').split(',');
const escape = text => text.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{});
app.whenReady().then(async () => {
  const all=[];
  for (const folder of folders) {
    const dir=path.join(root,folder);
    if(!fs.existsSync(dir)) continue;
    const files=fs.readdirSync(dir).filter(f=>f.endsWith('.png')).sort();
    all.push(...files.map(file=>({folder,file})));
    if(process.env.NEWMARK_GALLERY_ONLY==='1') continue;
    const portrait=folder.startsWith('mobile'),height=700,width=1280;
    const win=new BrowserWindow({width,height,useContentSize:true,show:false,webPreferences:{backgroundThrottling:false}});
    for(let i=0;i<files.length;i+=4) {
      const items=files.slice(i,i+4).map(file=>`<article><h2>${escape(folder+' / '+file)}</h2><img src="${pathToFileURL(path.join(dir,file)).href}"></article>`).join('');
      const html=`<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:12px;background:#dce1ec;font:14px system-ui;display:grid;grid-template-columns:1fr 1fr;gap:12px}article{margin:0;background:#fff;border-radius:10px;overflow:hidden}h2{font-size:14px;margin:0;padding:10px}img{display:block;width:100%;height:${280}px;object-fit:contain;object-position:top}</style>${items}`;
      const sheet=path.join(root,`sheet-${folder}-${String(i/4+1).padStart(2,'0')}.html`);
      fs.writeFileSync(sheet,html);
      await win.loadFile(sheet);
      await win.webContents.executeJavaScript('Promise.all(Array.from(document.images).map(img=>img.decode()))');
      // Synchronize a compositor frame as well as image decoding. A hidden
      // gallery can otherwise capture an unpainted tile under concurrent load.
      await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await win.webContents.capturePage({}, {stayHidden:true});
      await new Promise(resolve=>setTimeout(resolve,300));
      fs.writeFileSync(sheet.replace('.html','.png'),(await win.webContents.capturePage({}, {stayHidden:true})).toPNG());
    }
    win.destroy();
  }
  fs.writeFileSync(path.join(root,'gallery.html'),`<!doctype html><meta charset="utf-8"><title>Newmark full visual review</title><style>body{font:15px system-ui;background:#edf0f6;color:#172033;margin:24px}nav{position:sticky;top:0;background:#edf0f6;padding:12px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px}figure{margin:0;padding:12px;background:white;border-radius:12px}img{width:100%;max-height:620px;object-fit:contain}figcaption{padding:8px}button{padding:8px 16px;border:1px solid #aeb6ca;border-radius:24px;background:white}</style><h1>Newmark 双端全量视觉检查</h1><p>原始截图。点击图片查看原尺寸；页面覆盖与验证边界见 REPORT.md。</p><nav><button onclick="filter('')">全部</button> <button onclick="filter('dark')">暗色</button> <button onclick="filter('light')">亮色</button> <button onclick="filter('mobile')">移动端</button> <button onclick="filter('glass')">玻璃动态</button></nav><main>${all.map(({folder,file})=>`<figure data-key="${escape(folder+' '+file)}"><figcaption>${escape(folder+' / '+file)}</figcaption><a href="${folder}/${file}"><img loading="lazy" src="${folder}/${file}"></a></figure>`).join('')}</main><script>function filter(key){document.querySelectorAll('figure').forEach(e=>e.hidden=!e.dataset.key.includes(key))}</script>`);
  console.log(`Gallery: ${all.length} screenshots`);
  app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
