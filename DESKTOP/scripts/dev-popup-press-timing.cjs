// Trusted press -> threshold -> track -> constrained outset. Optical pixels
// and every compositor frame are observed independently of application timers.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const {PNG}=require('pngjs');
const {connect,targetAt}=require('./dev-uniform-popup-visuals.cjs');
const {contour,expansion}=require('./dev-popup-direction-regression.cjs');
const {waitForPromotedMainUi}=require('./cdp-main-ui-ready');
const {testElectronEntry,isolateTestWindow}=require('./cdp-test-window-isolation.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const desktopRoot=path.resolve(__dirname,'..');
const argument=(key,fallback)=>process.argv.includes(key)?process.argv[process.argv.indexOf(key)+1]:fallback;
async function main(){
  const diagnostic=process.argv.includes('--diagnostic');
  const output=path.resolve(argument('--output',path.join(desktopRoot,'../archive/20260905-232619-pc-press-timing',diagnostic?'before':'after')));
  fs.mkdirSync(output,{recursive:true});
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'newmark-press-timing-'));
  fs.writeFileSync(path.join(runtime,'config.json'),JSON.stringify({models:{providers:[]},general:{language:'en'},workspace:{auto_create_timestamp_workspace:true}}));
  const ui=fs.readFileSync(path.join(desktopRoot,'dist/ui/index.html'));
  const report={sourceSha256:crypto.createHash('sha256').update(ui).digest('hex'),diagnostic,cases:{},failures:[],interruptions:[]};
  fs.writeFileSync(path.join(output,'index.html'),ui);
  const port=Number(argument('--port',49447));
  const isolation={enabled:process.argv.includes('--offscreen')};
  const entry=testElectronEntry(desktopRoot,runtime,port+1,isolation);
  const appLog=fs.openSync(path.join(output,'electron.log'),'a');
  const child=spawn(require('electron'),[entry,`--remote-debugging-port=${port}`,'--allow-multiple-instances','--no-sandbox','--root',runtime],{cwd:desktopRoot,windowsHide:true,stdio:['ignore',appLog,appLog]});
  let cdp;
  try{
    cdp=connect(await targetAt(port));await cdp.ready;await waitForPromotedMainUi(cdp);
    await cdp.call('Emulation.setFocusEmulationEnabled',{enabled:true});
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
    report.windowIsolation=await isolateTestWindow(child,port+1,connect,isolation);
    const evaluate=async expression=>{const r=await cdp.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
    const baselineMenu=argument('--baseline-menu','');
    if(baselineMenu){
      const old=fs.readFileSync(path.resolve(baselineMenu),'utf8'),ts=require('typescript');let definition='';
      for(const script of old.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)){const ast=ts.createSourceFile('old-ui.js',script[1],ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);const declaration=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='wireDirectLiquidMenuInteractionsV2');if(declaration){definition=declaration.getText(ast);break;}}
      if(!definition)throw Error('Archived direct menu function not found');
      await evaluate(definition);const live=await evaluate('wireDirectLiquidMenuInteractionsV2.toString()');if(live!==definition)throw Error('Archived direct menu replacement differs');
      report.baselineMenu={path:path.resolve(baselineMenu),htmlSha256:crypto.createHash('sha256').update(old).digest('hex'),functionSha256:crypto.createHash('sha256').update(definition).digest('hex'),scope:'Only the archived direct-menu function is replayed in the isolated current Electron renderer; this is not an old package test.'};
      fs.writeFileSync(path.join(output,'archived-direct-menu.js'),definition);
    }
    let held=false;
    const mouse=async(type,p)=>{if(type==='mousePressed')held=true;if(type==='mouseReleased')held=false;await cdp.call('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:type==='mouseMoved'?'none':'left',buttons:held?1:0,clickCount:1});};
    await evaluate(`(()=>{
      window.__timingErrors=[];window.__timingEvents=[];window.__timingPointerEvents=[];
      addEventListener('error',e=>__timingErrors.push(String(e.error?.stack||e.message)));addEventListener('unhandledrejection',e=>__timingErrors.push(String(e.reason)));
      for(const name of ['blur','focus'])addEventListener(name,()=>__timingEvents.push({name,time:performance.now()}));
      for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])addEventListener(type,e=>__timingPointerEvents.push({type,time:performance.now(),elapsed:performance.now()-(window.__timingDown||0),x:e.clientX,y:e.clientY,buttons:e.buttons,pointerId:e.pointerId,pointerType:e.pointerType,trusted:e.isTrusted,target:e.target.className}),true);
      const mat=document.createElement('div');mat.style.cssText='position:fixed;inset:0;background:#999;z-index:190;pointer-events:none';document.body.append(mat);
      const css=document.createElement('style');css.textContent='*,*::before,*::after,*::backdrop{box-shadow:none!important;text-shadow:none!important}.press-timing-probe{border-color:transparent!important;--liquid-popup-rim:transparent;--liquid-popup-inner-rim:transparent}.press-timing-probe>*{opacity:0!important}.press-timing-probe::-webkit-scrollbar{display:none!important}';document.head.append(css);
      window.__timingState=()=>{const p=window.__timingPopup,s=getComputedStyle(p),b=p._liquidColorBlock,f=p._liquidPopupFeedback;const rect=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};return{time:performance.now(),elapsed:performance.now()-(window.__timingDown||0),rect:rect(p),options:[...p.querySelectorAll('button')].map(rect),block:rect(b),top:parseFloat(getComputedStyle(b).top),left:parseFloat(getComputedStyle(b).left),lifted:b.classList.contains('liquid-block-lifted'),edgeX:parseFloat(s.getPropertyValue('--liquid-popup-edge-x'))||0,edgeY:parseFloat(s.getPropertyValue('--liquid-popup-edge-y'))||0,clip:s.clipPath,outset:f?parseFloat(getComputedStyle(f.surface).getPropertyValue('--liquid-popup-outset'))||0:0,commits:__timingCommits.slice()};};
      addEventListener('pointerdown',e=>{if(!window.__timingPopup?.contains(e.target))return;window.__timingDown=performance.now();window.__timingFrames=[];window.__timingInitial=null;window.__timingHold=null;window.__timingObserver?.disconnect();const generation=window.__timingGeneration=(window.__timingGeneration||0)+1;queueMicrotask(()=>{if(generation===window.__timingGeneration)window.__timingCapturePhase=__timingState();});const block=__timingPopup._liquidColorBlock;window.__timingObserver=new MutationObserver(()=>{if(generation===window.__timingGeneration&&!window.__timingHold&&block.classList.contains('liquid-block-lifted'))__timingHold=__timingState();});__timingObserver.observe(block,{attributes:true,attributeFilter:['class']});const until=performance.now()+2400;function frame(){if(generation!==window.__timingGeneration)return;if(window.__timingPopup?.isConnected)__timingFrames.push(__timingState());if(performance.now()<until)requestAnimationFrame(frame);}requestAnimationFrame(frame);},true);
      window.__timingFixture=horizontal=>{const p=document.createElement('div');p.className='model-select-menu newmark-select-menu liquid-glass liquid-glass-carrier liquid-glass-popup press-timing-probe';p.style.cssText='position:fixed;display:block;left:340px;top:260px;width:440px;height:280px;max-height:none;margin:0;z-index:20000';p.innerHTML=[0,1,2,3].map(i=>'<button class="model-select-menu-option newmark-select-option'+(i===0?' selected':'')+'" data-index="'+i+'" style="height:54px;width:100%">Option '+i+'</button>').join('');if(horizontal){p.style.display='flex';p.style.width='600px';p.style.height='110px';p.querySelectorAll('button').forEach(b=>b.style.width='25%');}else p.setAttribute('popover','manual');document.body.append(p);wireDirectLiquidMenuInteractionsV2(p);p.addEventListener('pointerdown',e=>{if(e.button===0&&p===window.__timingPopup)window.__timingInitial=__timingState();},true);if(!horizontal)p.showPopover();if(p._liquidSyncSelectedBlock)p._liquidSyncSelectedBlock();window.__timingPopup=p;window.__timingCommits=[];p.addEventListener('click',e=>{const b=e.target.closest('button');if(b){__timingCommits.push({index:Number(b.dataset.index),time:performance.now()});p.querySelectorAll('button').forEach(n=>n.classList.toggle('selected',n===b));wireDirectLiquidMenuInteractionsV2(p);}});return [...p.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});};
    })()`);
    const themes=argument('--themes','dark,light').split(','),axes=argument('--axes','vertical,horizontal').split(','),retry={};
    for(const theme of themes)for(let ai=0;ai<axes.length;ai++){
      const axis=axes[ai],key=theme+'-'+axis,prefix=key+'-attempt'+(retry[key]||0),failureStart=report.failures.length;
      await evaluate(`window.setTheme('${theme}')`);const points=await evaluate(`__timingFixture(${axis==='horizontal'})`);await sleep(350);
      const eventsStart=await evaluate('__timingEvents.length'),pointerEventsStart=await evaluate('__timingPointerEvents.length'),baseline=await evaluate('__timingState()'),rect=baseline.rect;
      const clip={x:rect.x-16,y:rect.y-16,width:rect.width+32,height:rect.height+32,scale:1};
      const capture=async name=>{const timing=await evaluate('__timingState()');const r=await cdp.call('Page.captureScreenshot',{format:'png',clip,fromSurface:true});const bytes=Buffer.from(r.data,'base64');fs.writeFileSync(path.join(output,prefix+'-'+name+'.png'),bytes);return{image:PNG.sync.read(bytes),state:timing};};
      await evaluate(`__timingPopup.style.visibility='hidden'`);await sleep(100);const clear=(await capture('clear')).image;await evaluate(`__timingPopup.style.visibility=''`);await sleep(100);
      const idle=await capture('idle'),idleBounds=contour(idle.image,clear,rect,clip);
      const p=points[2];await mouse('mouseMoved',p);await mouse('mousePressed',p);await sleep(20);
      const early=await capture('early-press');
      const until=async elapsed=>{const current=await evaluate('performance.now()-__timingDown');if(current<elapsed)await sleep(elapsed-current);};
      await until(120);const late=await capture('after-activation');
      await until(240);const moving=await capture('pickup-optics-settled');
      await until(480);const settled=await capture('held-target');
      const inTrack=axis==='horizontal'?{x:p.x+12,y:p.y+70}:{x:p.x+70,y:p.y+12};
      await mouse('mouseMoved',inTrack);await sleep(160);const track=await capture('track');
      const outward=axis==='horizontal'?{x:points[3].x+170,y:p.y+70}:{x:p.x+70,y:points[3].y+170};
      await mouse('mouseMoved',outward);await sleep(170);const boundary=await capture('boundary');
      await mouse('mouseReleased',outward);await sleep(450);const landed=await capture('landed');
      const frames=await evaluate('__timingFrames'),events=await evaluate('__timingEvents.slice('+eventsStart+')');
      const initial=await evaluate('__timingInitial'),activation=await evaluate('__timingHold');
      const entry={baseline,initial,activation,frames,events,screenshotPrefix:prefix};
      for(const [name,value] of Object.entries({early,late,moving,settled,track,boundary,landed})){entry[name]={state:value.state,bounds:contour(value.image,clear,rect,clip)};entry[name].expansion=expansion(idleBounds,entry[name].bounds);}
      const check=(ok,message)=>{entry.checks=(entry.checks||0)+1;if(!ok)report.failures.push(key+': '+message);};
      const mainPos=s=>axis==='horizontal'?s.left:s.top;
      const firstMoving=frames.find(s=>Math.abs(mainPos(s)-mainPos(baseline))>.1);
      entry.firstMoving=firstMoving;
      check(initial&&initial.elapsed<80&&initial.edgeY>0&&!initial.lifted,'trusted pointerdown applies inward feedback before its 80ms hold');
      check(frames.some(s=>s.elapsed<75&&s.edgeY>0&&!s.lifted),'a real pre-activation frame retains inward feedback');
      // PNG capture may finish after 80ms; use actual pre-threshold RAF/state above, not capture request timing.
      check(activation&&activation.elapsed>=75&&activation.elapsed<160,'trusted held activation occurs around the requested 80ms threshold');
      check(activation&&activation.edgeX===0&&activation.edgeY===0&&activation.outset===0,'hold activation clears optical targets before pickup');
      check(firstMoving&&firstMoving.elapsed>=75&&firstMoving.elapsed<230,'source-to-target movement follows 80ms activation and the existing animation frame setup');
      check(firstMoving&&firstMoving.edgeX===0&&firstMoving.edgeY===0&&firstMoving.outset===0,'first moving frame clears inward and outward optical targets');
      check(Object.values(entry.moving.expansion).every(n=>n===0),'during pickup the actual glass contour has returned to idle');
      check(track.state.edgeX===0&&track.state.edgeY===0&&track.state.outset===0,'in-track movement retains rigid normal material');
      const physicalOutset=expansion({left:rect.x,top:rect.y,right:rect.x+rect.width,bottom:rect.y+rect.height},entry.boundary.bounds);entry.physicalOutset=physicalOutset;
      check(physicalOutset.left===0&&physicalOutset.top===0&&(axis==='horizontal'?physicalOutset.right===4&&physicalOutset.bottom===0:physicalOutset.right===0&&physicalOutset.bottom===4),'constrained rail endpoint paints 4px only along the accepted rail axis; cross-axis and opposite edges stay fixed');
      check(frames.every(s=>JSON.stringify(s.rect)===JSON.stringify(baseline.rect)&&JSON.stringify(s.options)===JSON.stringify(baseline.options)),'all text and root geometry remain fixed');
      check(landed.state.commits.length===1&&landed.state.commits[0].index===3,'held release retains exactly one destination commit');
      check(Object.values(entry.landed.expansion).every(n=>n===0),'landed material restores to idle');
      // A completed short tap owns a 120ms optical release timer. Begin a new
      // held press before that timer expires; it must not erase the new press.
      await evaluate('window.__timingCommits=[]');
      await mouse('mouseMoved',points[3]);await mouse('mousePressed',points[3]);await sleep(25);await mouse('mouseReleased',points[3]);await sleep(90);
      await mouse('mouseMoved',points[1]);await mouse('mousePressed',points[1]);await sleep(45);
      const repeated=await capture('rapid-repress-after-old-timer');await until(120);const repeatedLate=await capture('rapid-repress-after-activation');await until(240);const repeatedMoving=await capture('rapid-repress-pickup');
      await mouse('mouseReleased',points[1]);await sleep(450);const repeatedLanded=await evaluate('__timingState()');
      const rapidFrames=await evaluate('__timingFrames'),rapidInitial=await evaluate('__timingInitial'),rapidActivation=await evaluate('__timingHold');
      entry.rapidRepress={frames:rapidFrames,initial:rapidInitial,activation:rapidActivation,afterOldTimer:{state:repeated.state,expansion:expansion(idleBounds,contour(repeated.image,clear,rect,clip))},beforeThreshold:{state:repeatedLate.state,expansion:expansion(idleBounds,contour(repeatedLate.image,clear,rect,clip))},pickup:{state:repeatedMoving.state,expansion:expansion(idleBounds,contour(repeatedMoving.image,clear,rect,clip))},landed:repeatedLanded};
      const afterOldTimerFrames=rapidFrames.filter(s=>s.elapsed>=40&&s.elapsed<75);
      check(afterOldTimerFrames.length>0&&afterOldTimerFrames.every(s=>s.edgeY>0&&!s.lifted),'a previous tap release timer cannot erase the new press before its own 80ms activation');
      check(rapidInitial&&rapidInitial.edgeY>0&&rapidActivation&&rapidActivation.elapsed>=75&&rapidActivation.elapsed<160&&rapidActivation.edgeY===0,'rapid repeated press uses its own 80ms activation boundary');
      check(Object.values(entry.rapidRepress.pickup.expansion).every(n=>n===0),'rapid repeated pickup restores the normal material');
      check(repeatedLanded.commits.length===2&&repeatedLanded.commits[0].index===3&&repeatedLanded.commits[1].index===1,'rapid repeated gestures preserve one ordered commit each');
      entry.events=await evaluate('__timingEvents.slice('+eventsStart+')');
      entry.pointerEvents=await evaluate('__timingPointerEvents.slice('+pointerEventsStart+')');
      if(entry.events.some(e=>e.name==='blur')&&(retry[key]||0)<3){report.interruptions.push({key,entry,failures:report.failures.splice(failureStart)});retry[key]=(retry[key]||0)+1;ai--;console.log('Focus interrupted '+prefix+', retrying');}
      else{report.cases[key]=entry;console.log('Captured '+key);}
      await evaluate(`window.__timingObserver?.disconnect();window.__timingGeneration++;clearLiquidPopupOutset(__timingPopup,true);if(__timingPopup.matches(':popover-open'))__timingPopup.hidePopover();__timingPopup.remove();window.__timingPopup=null`);await sleep(200);
    }
    report.errors=await evaluate('__timingErrors');if(report.errors.length)report.failures.push('Renderer exception');report.ok=report.failures.length===0;
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,output,failures:report.failures}));if(!diagnostic&&!report.ok)process.exitCode=1;
  }finally{try{cdp?.socket.close();}catch{}if(child.pid)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:15000});fs.closeSync(appLog);for(let i=0;i<20;i++){try{fs.rmSync(runtime,{recursive:true,force:true});break;}catch{await sleep(250);}}}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
