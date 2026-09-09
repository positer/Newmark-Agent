const {app,BrowserWindow,WebContentsView,nativeImage}=require('electron');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {ElectronBrowserUseHost}=require('../dist/core/electronBrowserUseHost');
const {NativeBrowserUsePageAdapter}=require('../dist/core/browserUsePageAdapter');
const {BrowserUseEngine}=require('../dist/core/browserUse');
const {readBrowserPdf}=require('../dist/core/browserPdf');
const {ToolExecutor}=require('../dist/tools');
app.setPath('userData',fs.mkdtempSync(path.join(require('os').tmpdir(),'newmark-browser-vision-')));
const out=path.resolve(__dirname,'../../archive/20260908-browser-vision-viewport');fs.mkdirSync(out,{recursive:true});
const watchdog=setTimeout(()=>{console.error('Fixture timed out');app.exit(1)},45000);
app.whenReady().then(async()=>{
 const windows=[];
 try {
  const win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{sandbox:true}});windows.push(win);
  await win.loadURL('data:text/html,<h1>Text priority fixture with enough readable content for the text layer</h1><button>Next</button><footer style="position:fixed;bottom:0;left:0;width:100%;height:16px;background:rgb(18,52,86)"></footer>');
  const host=new ElectronBrowserUseHost({resolveContents:async()=>win.webContents});
  const adapter=new NativeBrowserUsePageAdapter(s=>host.resolve(s));
  const scope={owner:'vision-test',runtimeKey:'vision-test',visible:true};
  const text=await adapter.observe(scope,{maxChars:12000,maxRefs:30,viewport:{width:800,height:600}});
  assert.equal(text.viewport.width,800);assert.equal(text.viewport.height,600);assert.ok(!text.visionImageDataUrl);
  const visual=await adapter.observe(scope,{maxChars:12000,maxRefs:30,visualMode:'vision',viewport:{width:390,height:844}});
  assert.equal(visual.viewport.width,390);assert.equal(visual.viewport.height,844);assert.ok(visual.visionImageDataUrl);
  fs.writeFileSync(path.join(out,'pc-viewport.jpg'),Buffer.from(visual.visionImageDataUrl.split(',')[1],'base64'));
  const captured=nativeImage.createFromDataURL(visual.visionImageDataUrl);assert.deepEqual(captured.getSize(),{width:390,height:844});
  console.log('capture metrics',await win.webContents.executeJavaScript('({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,footer:document.querySelector("footer").getBoundingClientRect().toJSON(),color:getComputedStyle(document.querySelector("footer")).backgroundColor})'));
  fs.writeFileSync(path.join(out,'pc-full-debug.png'),(await win.webContents.capturePage(undefined,{stayHidden:true})).toPNG());
  const pixel=(838*390+20)*4, pixels=captured.toBitmap();assert.ok(Math.abs(pixels[pixel+2]-18)<12 && Math.abs(pixels[pixel+1]-52)<12,'Bottom-of-viewport marker must not be cropped');
  const backgroundView=new BrowserWindow({show:false,skipTaskbar:true,focusable:false,width:1280,height:720,webPreferences:{sandbox:true,backgroundThrottling:false}});
  const backgroundHost=new ElectronBrowserUseHost({resolveContents:async()=>backgroundView.webContents,resizeContents:async(_contents,viewport)=>backgroundView.setContentSize(viewport.width,viewport.height)});
  try {
    await backgroundView.webContents.loadURL('data:text/html,<h1>Background visual fixture</h1>');
    const backgroundAdapter=new NativeBrowserUsePageAdapter(s=>backgroundHost.resolve(s));
    const background=await backgroundAdapter.observe({...scope,visible:false},{maxChars:12000,maxRefs:30,visualMode:'vision',viewport:{width:800,height:600}});
    assert.equal(background.viewport.width,800);assert.equal(background.viewport.height,600);assert.ok(background.visionImageDataUrl);
    fs.writeFileSync(path.join(out,'pc-background.jpg'),Buffer.from(background.visionImageDataUrl.split(',')[1],'base64'));
  }finally{backgroundHost.dispose();backgroundView.destroy()}
  let visionCalls=0,ocrCalls=0;
  const executor=Object.create(ToolExecutor.prototype);executor.localOcr={recognizeDataUrl:async()=>{ocrCalls++;return {ok:true,text:'OCR fixture'}}};
  const receipt={observationId:'fixture',vision_image_data_url:visual.visionImageDataUrl,observation:{text:'',url:'fixture'}};
  const success=await executor.decorateBrowserUseReceipt(receipt,{inspectBrowserImage:async image=>{visionCalls++;assert.ok(image.startsWith('data:image/'));return {text:'Visual fixture',model:'fixture'}}},'fixture');
  assert.equal(success.visual_analysis.text,'Visual fixture');assert.equal(ocrCalls,0);assert.ok(!success.vision_image_data_url);
  const fallback=await executor.decorateBrowserUseReceipt(receipt,{inspectBrowserImage:async()=>{throw Error('fixture failure')}},'fixture');
  assert.equal(fallback.local_ocr.text,'OCR fixture');assert.equal(ocrCalls,1);assert.ok(!fallback.vision_image_data_url);
  const cancel=new AbortController();cancel.abort();await assert.rejects(()=>executor.decorateBrowserUseReceipt(receipt,{signal:cancel.signal,inspectBrowserImage:async()=>{throw Error('aborted')}},'fixture'));assert.equal(ocrCalls,1);
  await win.loadURL('data:text/html,<h1>Compressed PDF binary text fixture contains enough readable content and survives extraction.</h1>');
  const textPdf=await win.webContents.printToPDF({});fs.writeFileSync(path.join(out,'text.pdf'),textPdf);
  const parsed=await readBrowserPdf(new Uint8Array(textPdf),12000,false);assert.ok(parsed.text.includes('Compressed PDF'));assert.ok(!parsed.imageDataUrl);
  await win.loadURL('data:text/html,<canvas id="c" width="600" height="300"></canvas><script>let x=c.getContext("2d");x.font="40px sans-serif";x.fillText("SCANNED PDF 12345",20,100)</script>');
  const scanPdf=await win.webContents.printToPDF({});fs.writeFileSync(path.join(out,'scan.pdf'),scanPdf);
  const scanned=await readBrowserPdf(new Uint8Array(scanPdf),12000,false);assert.ok(scanned.imageDataUrl);assert.equal(scanned.visualPage,1);
  fs.writeFileSync(path.join(out,'pc-pdf-render.jpg'),Buffer.from(scanned.imageDataUrl.split(',')[1],'base64'));
  await win.loadURL(require('url').pathToFileURL(path.join(out,'text.pdf')).href);
  const pdfObserved=await adapter.observe(scope,{maxChars:12000,maxRefs:30});assert.ok(pdfObserved.text.includes('Compressed PDF'),JSON.stringify(pdfObserved));assert.equal(pdfObserved.document.source,'pdf_binary');
  const extracted=await adapter.act(scope,{action:'extract',expectedPageToken:pdfObserved.pageToken,maxChars:12000});assert.ok(extracted.data.text.includes('Compressed PDF'));
  const forced=await adapter.act(scope,{action:'extract',expectedPageToken:pdfObserved.pageToken,visualMode:'vision',maxChars:12000});assert.ok(forced.visionImageDataUrl);
  let cookieRequests=0;
  const server=require('http').createServer((request,response)=>{
    if(request.headers.cookie?.includes('pdfFixture=yes'))cookieRequests++;
    response.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename=report.pdf'});response.end(textPdf);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const url='http://127.0.0.1:'+server.address().port+'/download?id=42';
    await win.webContents.session.cookies.set({url,name:'pdfFixture',value:'yes'});
    await win.loadURL(url).catch(()=>{});
    await new Promise(resolve=>setTimeout(resolve,300));
    const downloaded=await adapter.observe(scope,{maxChars:12000,maxRefs:30});
    assert.ok(downloaded.text.includes('Compressed PDF'),JSON.stringify(downloaded));assert.equal(downloaded.url,url);assert.ok(cookieRequests>=2);
  }finally{server.close()}
  let requestImage='';
  const modelServer=require('http').createServer((request,response)=>{
    let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
      const input=JSON.parse(body);requestImage=input.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).find(p=>p.type==='image_url')?.image_url.url;
      response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({choices:[{message:{role:'assistant',content:'Protocol visual fixture'},finish_reason:'stop'}]}));
    });
  });
  await new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve));
  try {
    const selected={name:'vision-fixture',provider:'Fixture',provider_id:'fixture',provider_url:'http://127.0.0.1:'+modelServer.address().port+'/v1',provider_protocol:'openai',api_key:'synthetic',enabled:true,vision:true};
    const fake={activeModelConfig:()=>({name:'text-only'}),config:{allModels:()=>[selected],openAIApiMode:()=> 'chat_completions',contextFlag:()=>false},modelThinkingTierMaps:()=>({}),providerProxyConfig:()=>({enabled:false})};
    const result=await require('../dist/core/agent').Agent.prototype.inspectBrowserImage.call(fake,visual.visionImageDataUrl,'Read fixture');
    assert.equal(result.text,'Protocol visual fixture');assert.equal(requestImage,visual.visionImageDataUrl);
  }finally{modelServer.close()}
  const engine=new BrowserUseEngine(adapter);
  const invalid=await engine.run({...scope,action:'observe',viewport:{width:0,height:100}});assert.equal(invalid.ok,false);assert.equal(invalid.code,'invalid_viewport');
  host.dispose();console.log('PASS browser vision ordering, failure/cancellation, real viewport, compressed PDF text, scanned PDF rendering, local PDF host integration');
 }finally{for(const win of windows)if(!win.isDestroyed())win.destroy();clearTimeout(watchdog);app.quit()}
}).catch(error=>{console.error(error);app.exit(1)});
