// Real Chromium pixels and trusted pointer input. The optical fixture uses
// production popup classes/gesture handlers; settings and command are real UI.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { PNG } = require('pngjs');
const { connect, targetAt } = require('./dev-uniform-popup-visuals.cjs');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const desktopRoot = path.resolve(__dirname, '..');
const argument = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
function pixelDelta(a, b, x, y) {
  const index = (y * a.width + x) * 4;
  return [0,1,2].reduce((sum,c)=>sum+Math.abs(a.data[index+c]-b.data[index+c]),0)/3;
}
function contour(frame, clear, rect, clip) {
  const cx=Math.round(rect.x+rect.width/2-clip.x), cy=Math.round(rect.y+rect.height/2-clip.y);
  const horizontal=x=>Array.from({length:11},(_,k)=>pixelDelta(frame,clear,x,cy+k-5)).reduce((a,b)=>a+b,0)/11>6;
  const vertical=y=>Array.from({length:11},(_,k)=>pixelDelta(frame,clear,cx+k-5,y)).reduce((a,b)=>a+b,0)/11>6;
  let left=0,right=frame.width-1,top=0,bottom=frame.height-1;
  while(left<cx&&!horizontal(left))left++;
  while(right>cx&&!horizontal(right))right--;
  while(top<cy&&!vertical(top))top++;
  while(bottom>cy&&!vertical(bottom))bottom--;
  return {left:left+clip.x,top:top+clip.y,right:right+clip.x+1,bottom:bottom+clip.y+1};
}
function expansion(base, value) { return {left:base.left-value.left,top:base.top-value.top,right:value.right-base.right,bottom:value.bottom-base.bottom}; }
function regionDifference(a,b,rect,clip,outerOnly=false) {
  let sum=0,count=0,changed=0;
  for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){
    const px=x+clip.x,py=y+clip.y;
    if(outerOnly&&px>=rect.x+3&&px<rect.x+rect.width-3&&py>=rect.y+3&&py<rect.y+rect.height-3)continue;
    const delta=pixelDelta(a,b,x,y);sum+=delta;count++;if(delta>3)changed++;
  }
  return {meanChannelDelta:sum/count,changedPixels:changed};
}
function fixedRegionDifference(a,b,rect,clip,dx,dy,radius=25) {
  let count=0,changedPixels=0,maxDelta=0;
  const band=radius+2;
  for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){
    const px=x+clip.x,py=y+clip.y;
    const horizontal=dx>0?px<rect.x+band:dx<0?px>=rect.x+rect.width-band:true;
    const vertical=dy>0?py<rect.y+band:dy<0?py>=rect.y+rect.height-band:true;
    if(!horizontal||!vertical)continue;
    const delta=pixelDelta(a,b,x,y);count++;maxDelta=Math.max(maxDelta,delta);if(delta>3)changedPixels++;
  }
  return{count,changedPixels,maxDelta};
}
function columnDeviation(frame,x,start,end) {
  const values=[];for(let y=start;y<end;y++){const i=(y*frame.width+x)*4;values.push((frame.data[i]+frame.data[i+1]+frame.data[i+2])/3);}
  const mean=values.reduce((a,b)=>a+b,0)/values.length;
  return Math.sqrt(values.reduce((a,b)=>a+(b-mean)**2,0)/values.length);
}
function rowDeviation(frame,y,start,end) {
  const values=[];for(let x=start;x<end;x++){const i=(y*frame.width+x)*4;values.push((frame.data[i]+frame.data[i+1]+frame.data[i+2])/3);}
  const mean=values.reduce((a,b)=>a+b,0)/values.length;
  return Math.sqrt(values.reduce((a,b)=>a+(b-mean)**2,0)/values.length);
}
async function main(){
  const diagnostic=process.argv.includes('--diagnostic');
  const output=path.resolve(argument('--output',path.join(desktopRoot,'../archive/20260905-222820-pc-8px-direction',diagnostic?'direction-before':'direction-after')));
  fs.mkdirSync(output,{recursive:true});
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'newmark-direction-'));
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({models:{providers:[]},general:{language:'en'},workspace:{auto_create_timestamp_workspace:true}}));
  const ui=fs.readFileSync(path.join(desktopRoot,'dist/ui/index.html'));
  const report={diagnostic,sourceSha256:crypto.createHash('sha256').update(ui).digest('hex'),cases:{},failures:[],errors:[]};
  fs.writeFileSync(path.join(output,'index.html'),ui);
  const port=Number(argument('--port',49443));
  const child=spawn(require('electron'),['.',`--remote-debugging-port=${port}`,'--allow-multiple-instances','--no-sandbox','--root',root],{cwd:desktopRoot,windowsHide:true,stdio:'ignore'});
  let cdp;
  try{
    cdp=connect(await targetAt(port));await cdp.ready;await waitForPromotedMainUi(cdp);
    await cdp.call('Emulation.setFocusEmulationEnabled',{enabled:true});
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
    const evaluate=async expression=>{const r=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
    let held=false;
    const mouse=async(type,p)=>{if(type==='mousePressed')held=true;if(type==='mouseReleased')held=false;await cdp.call('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:type==='mouseMoved'?'none':'left',buttons:held?1:0,clickCount:1});};
    await evaluate(`(()=>{
      window.__directionPointerEvents=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])addEventListener(type,e=>__directionPointerEvents.push({type,x:e.clientX,y:e.clientY,buttons:e.buttons,time:performance.now(),trusted:e.isTrusted}),true);window.__directionErrors=[];window.__directionLifecycle=[];addEventListener('error',e=>__directionErrors.push(String(e.error?.stack||e.message)));addEventListener('unhandledrejection',e=>__directionErrors.push(String(e.reason)));for(const event of ['blur','focus','pagehide'])addEventListener(event,()=>__directionLifecycle.push({event,time:performance.now()}));
      const mat=document.createElement('div');mat.id='direction-mat';mat.style.cssText='position:fixed;inset:0;z-index:190;background:#999;pointer-events:none';document.body.append(mat);
      const quiet=document.createElement('style');quiet.textContent='*,*::before,*::after,*::backdrop{box-shadow:none!important;text-shadow:none!important} .direction-probe > *{opacity:0!important}.direction-probe::-webkit-scrollbar{display:none!important} .direction-probe{border-color:transparent!important;--liquid-popup-rim:transparent;--liquid-popup-inner-rim:transparent}.direction-probe::after{border-color:transparent!important}';document.head.append(quiet);
      window.__directionState=()=>{const p=window.__directionPopup,r=n=>{const b=n.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height}};const s=getComputedStyle(p),f=p._liquidPopupFeedback,fs=f?getComputedStyle(f.surface):null;return{rect:r(p),filter:s.backdropFilter,marker:p.getAttribute('data-liquid-popup-feedback'),scrollTop:p.scrollTop,scrollHeight:p.scrollHeight,edgeX:parseFloat(s.getPropertyValue('--liquid-popup-edge-x'))||0,edgeY:parseFloat(s.getPropertyValue('--liquid-popup-edge-y'))||0,outset:parseFloat((fs||s).getPropertyValue('--liquid-popup-outset'))||0,pull:Object.fromEntries(['left','right','top','bottom'].map(k=>[k,parseFloat((fs||s).getPropertyValue('--liquid-popup-pull-'+k))||0])),radius:s.borderTopLeftRadius,feedback:f?{target:f.target,filter:fs.getPropertyValue('--liquid-feedback-filter'),native:f.nativePopover}:null,popover:p.matches(':popover-open'),options:[...p.querySelectorAll('button,input,label')].map(r)};};
    })()`);
    await evaluate(`(()=>{
      window.__directionRecord=()=>{window.__directionFrames=[];const generation=window.__directionRecordGeneration=(window.__directionRecordGeneration||0)+1;const base=__directionState(),end=performance.now()+4000;
        const delta=(a,b)=>Math.max(...['x','y','width','height'].map(k=>Math.abs(a[k]-b[k])));
        function frame(){if(generation!==window.__directionRecordGeneration)return;const state=__directionState();__directionFrames.push({time:performance.now(),outset:state.outset,edgeX:state.edgeX,edgeY:state.edgeY,rootDrift:delta(base.rect,state.rect),optionDrift:state.options.length===base.options.length?Math.max(0,...state.options.map((r,i)=>delta(r,base.options[i]))):null});if(performance.now()<end)requestAnimationFrame(frame)}requestAnimationFrame(frame);
      };
      window.__directionFinishRecord=()=>{window.__directionRecordGeneration++;return window.__directionFrames;};
    })()`);
    const kinds=argument('--kinds','popover,settings,command').split(',');
    const themes=argument('--themes','dark,light').split(',');
    const retries={};
    for(const theme of themes)for(let kindIndex=0;kindIndex<kinds.length;kindIndex++){
      const kind=kinds[kindIndex];
      const key=theme+'-'+kind;
      const prefix=key+'-attempt'+(retries[key]||0),failureStart=report.failures.length;
      await evaluate(`window.setTheme('${theme}')`);
      if(kind==='popover'){
        await evaluate(`(()=>{const p=document.createElement('div');p.id='direction-menu';p.className='model-select-menu liquid-glass liquid-glass-carrier liquid-glass-popup direction-probe';p.setAttribute('popover','manual');p.style.cssText='position:fixed;left:400px;top:280px;width:480px;height:320px;max-height:320px;margin:0;';p.innerHTML=Array.from({length:30},(_,i)=>'<button class="model-select-menu-option'+(i===0?' selected':'')+'" style="height:42px;min-height:42px">Option '+i+'</button>').join('');document.body.append(p);wireDirectLiquidMenuInteractionsV2(p);p.addEventListener('click',e=>{const b=e.target.closest('button');if(b){p.querySelectorAll('button').forEach(n=>n.classList.toggle('selected',n===b));wireDirectLiquidMenuInteractionsV2(p);}});p.showPopover();window.__directionPopup=p;})()`);
      }else if(kind==='settings'){
        await evaluate(`window.openSettings('general')`);
        let ready=false;for(let i=0;i<200;i++){ready=await evaluate(`!!document.querySelector('#sub-win-overlay.open #settings-glass-opacity')`);if(ready)break;await sleep(50);}if(!ready)throw Error('Settings content not ready');
        await evaluate(`window.__directionPopup=document.getElementById('sub-win');__directionPopup.classList.add('direction-probe')`);
      }else{
        await evaluate(`window.openCommandSurface('palette');window.__directionPopup=document.getElementById('command-surface');__directionPopup.classList.add('direction-probe')`);
      }
      // Keep the actual dialog open after releasing over its dimmed backdrop.
      // Only the unrelated click-away action is disabled; trusted pointer and
      // production popup gesture handlers remain untouched.
      if(kind!=='popover')await evaluate(`window.__directionOverlay=__directionPopup.parentElement;window.__directionDismiss=__directionOverlay.onclick;__directionOverlay.onclick=null`);
      await sleep(350);
      const lifecycleStart=await evaluate('__directionLifecycle.length');
      const baseline=await evaluate('__directionState()'),rect=baseline.rect;
      const clip={x:Math.max(0,Math.floor(rect.x)-16),y:Math.max(0,Math.floor(rect.y)-16),width:Math.ceil(rect.width)+32,height:Math.ceil(rect.height)+32,scale:1};
      const capture=async name=>{const r=await cdp.call('Page.captureScreenshot',{format:'png',clip,fromSurface:true},60000);const bytes=Buffer.from(r.data,'base64');fs.writeFileSync(path.join(output,prefix+'-'+name+'.png'),bytes);return PNG.sync.read(bytes);};
      await evaluate(`__directionPopup.style.visibility='hidden'`);const clear=await capture('clear');await evaluate(`__directionPopup.style.visibility=''`);await sleep(120);
      const idle=await capture('idle'),idleContour=contour(idle,clear,rect,clip);
      const p=kind==='popover'?await evaluate(`(()=>{const b=__directionPopup.querySelector('button'),r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`):{x:rect.x+6,y:rect.y+rect.height/2};
      await mouse('mouseMoved',p);await mouse('mousePressed',p);
      let press,pressContour;
      if(kind==='popover'){await sleep(35);await mouse('mouseReleased',p);}
      // Sample several real compositor frames rather than assuming one timer
      // delay lands inside the short press pulse.
      let pressArea=Infinity;
      for(let i=0;i<4;i++){const frame=await capture('press-'+i),bounds=contour(frame,clear,rect,clip),area=(bounds.right-bounds.left)*(bounds.bottom-bounds.top);if(area<pressArea){press=frame;pressContour=bounds;pressArea=area;}await sleep(8);}
      if(kind!=='popover')await mouse('mouseReleased',p);
      await sleep(400);
      await mouse('mouseMoved',p);await mouse('mousePressed',p);await sleep(620);
      // The first option is already at the upper endpoint. A held upward pull
      // exercises rail-boundary optics without scrolling to a synthetic target.
      const outward=kind==='popover'?{x:p.x,y:p.y-150}:{x:p.x-150,y:p.y};
      await mouse('mouseMoved',outward);
      const primarySettling=await evaluate(`(async()=>{const start=performance.now();while(performance.now()-start<4000){await new Promise(requestAnimationFrame);const s=__directionState();if(s.feedback?.target===4&&s.outset>=3.99)return{elapsed:performance.now()-start,outset:s.outset};}return{failed:true,state:__directionState()};})()`);
      const pull=await capture('pull'),pullState=await evaluate('__directionState()'),pullContour=contour(pull,clear,rect,clip);
      const entry={primarySettling,baseline,pullState,contours:{idle:idleContour,press:pressContour,pull:pullContour},pressExpansion:expansion(idleContour,pressContour),pullExpansion:expansion(idleContour,pullContour),pullBeyondRoot:expansion({left:rect.x,top:rect.y,right:rect.x+rect.width,bottom:rect.y+rect.height},pullContour)};
      const check=(condition,message)=>{if(!condition)report.failures.push(key+': '+message);};
      check(idleContour.right-idleContour.left>rect.width-6&&idleContour.bottom-idleContour.top>rect.height-6,'idle material must be visible and independently measurable');
      const pulledSide=kind==='popover'?'top':'left';
      check(entry.pullBeyondRoot[pulledSide]>0&&entry.pullBeyondRoot[pulledSide]<=4.5&&Object.keys(entry.pullExpansion).filter(k=>k!==pulledSide).every(k=>Math.abs(entry.pullExpansion[k])<=.5),'held pull must expand only the force side within 4px');
      entry.fixedOpposite= fixedRegionDifference(idle,pull,rect,clip,kind==='popover'?0:-1,kind==='popover'?-1:0,parseFloat(baseline.radius));
      entry.rawIdleToHeldOpposite=entry.fixedOpposite; // retain the existing shell/rim handoff separately
      check(kind!=='popover'||baseline.radius==='25px','list popup must use the unified 25px corner radius');
      check(Object.values(entry.pressExpansion).every(v=>v<=0)&&Object.values(entry.pressExpansion).some(v=>v<0),'click must move the material contour inward');
      check(JSON.stringify(pullState.rect)===JSON.stringify(baseline.rect)&&JSON.stringify(pullState.options)===JSON.stringify(baseline.options),'pull changed popup or content geometry');
      // A patterned real backdrop distinguishes a frosted outer fill from a
      // tinted outline/shadow. Sample the middle of the four-pixel outer band.
      await evaluate(`document.getElementById('direction-mat').style.background='repeating-linear-gradient(${kind==='popover'?90:0}deg,#000 0 3px,#fff 3px 6px)'`);await sleep(120);
      const stripePull=await capture('pull-stripes');
      entry.stripeState=await evaluate('__directionState()');
      const row=Math.round(rect.y-2-clip.y),start=Math.round(rect.x+60-clip.x),end=Math.round(rect.x+rect.width-60-clip.x);
      entry.outerStripeDeviation=kind==='popover'?rowDeviation(stripePull,row,start,end):columnDeviation(stripePull,Math.round(rect.x-2-clip.x),Math.round(rect.y+60-clip.y),Math.round(rect.y+rect.height-60-clip.y));
      check(entry.outerStripeDeviation<18,'outer added material must blur the real striped backdrop');
      await evaluate(`document.getElementById('direction-mat').style.background='#999'`);await sleep(120);
      if(kind==='popover'){
        const beforeWheel=await capture('pre-wheel');
        await cdp.call('Input.dispatchMouseEvent',{type:'mouseWheel',x:rect.x+rect.width/2,y:rect.y+rect.height/2,deltaX:0,deltaY:180});await sleep(180);
        const afterWheel=await capture('post-wheel');entry.scrollState=await evaluate('__directionState()');entry.scrollDifference=regionDifference(beforeWheel,afterWheel,rect,clip);
        check(entry.scrollState.scrollTop>100,'trusted wheel did not scroll the native popover');
        check(entry.scrollDifference.changedPixels===0,'held optical surface moves when its content scrolls');
        // Restore the same content/selection coordinates before testing release.
        await evaluate(`__directionPopup.scrollTop=0`);await sleep(100);
      }
      await mouse('mouseReleased',outward);
      entry.release=[];
      for(let i=0;i<5;i++){
        const frame=await capture('release-'+i),state=await evaluate('__directionState()');
        const bounds=contour(frame,clear,rect,clip),delta=expansion(idleContour,bounds);
        entry.release.push({bounds,delta,state});
        check(Object.values(delta).every(v=>v>=-.5),'drag release crosses idle into an unwanted press');
        await sleep(20);
      }
      await sleep(250);const restored=await capture('restored');entry.restoredDifference=regionDifference(idle,restored,rect,clip);
      check(entry.restoredDifference.changedPixels===0,'optical material did not restore exactly to idle');
      entry.restoredState=await evaluate('__directionState()');
      // Compare against the same held shell with a one-pixel-per-force-axis
      // outset. Integer pixel edges avoid raster-phase shifts in the reference. Idle uses the original shell; its rim handoff is kept in the
      // raw PNG but is not mistaken for opposite-edge movement.
      const opticalWait=async(value,dx,dy)=>evaluate(`(async()=>{setLiquidPopupOutset(__directionPopup,${value},${dx},${dy});const start=performance.now();let amount=0;do{await new Promise(requestAnimationFrame);const f=__directionPopup._liquidPopupFeedback;amount=f?parseFloat(getComputedStyle(f.surface).getPropertyValue('--liquid-popup-outset')):0;if(Math.abs(amount-Number((${value}).toFixed(3)))<.000001)return{elapsed:performance.now()-start,amount};}while(performance.now()-start<4000);throw Error('Optical shell did not settle: '+amount);})()`);
      await opticalWait(1,kind==='popover'?0:-1,kind==='popover'?-1:0);
      const heldReference=await capture('held-one-pixel-reference');
      entry.fixedOpposite=fixedRegionDifference(heldReference,pull,rect,clip,kind==='popover'?0:-1,kind==='popover'?-1:0,parseFloat(baseline.radius));
      check(entry.fixedOpposite.changedPixels===0,'trusted pull must preserve opposite held-shell edge including both corners');
      await evaluate('clearLiquidPopupOutset(__directionPopup,true)');await sleep(200);
      entry.trustedDirections=[];
      for(const [name,dx,dy] of (kind==='popover'?[['down-endpoint',0,1]]:[['right',1,0],['down',0,1]])){
        let origin=dx?{x:rect.x+rect.width-6,y:rect.y+rect.height/2}:{x:rect.x+rect.width/2,y:rect.y+rect.height-6};
        if(kind==='popover')origin=await evaluate(`(()=>{const m=__directionPopup,items=[...m.querySelectorAll('button')],item=items[items.length-1];items.forEach(n=>n.classList.toggle('selected',n===item));m.scrollTop=m.scrollHeight;wireDirectLiquidMenuInteractionsV2(m);const r=item.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        await sleep(300);
        const rest=await capture('trusted-'+name+'-idle');
        await opticalWait(1,dx,dy);const reference=await capture('trusted-'+name+'-held-reference');
        await evaluate('clearLiquidPopupOutset(__directionPopup,true)');await sleep(200);
        const before=await evaluate('__directionState()');await evaluate('__directionRecord()');
        await mouse('mouseMoved',origin);await mouse('mousePressed',origin);await sleep(620);
        const end={x:origin.x+dx*90,y:origin.y+dy*90};await mouse('mouseMoved',end);
        const settling=await evaluate(`(async()=>{const start=performance.now();while(performance.now()-start<4000){await new Promise(requestAnimationFrame);const s=__directionState();if(s.feedback?.target===4&&s.outset>=3.99)return{elapsed:performance.now()-start,outset:s.outset};}return{failed:true,state:__directionState()};})()`);
        const frame=await capture('trusted-'+name+'-pull'),state=await evaluate('__directionState()'),frames=await evaluate('__directionFinishRecord()');
        const bounds=contour(frame,clear,rect,clip),absolute=expansion({left:rect.x,top:rect.y,right:rect.x+rect.width,bottom:rect.y+rect.height},bounds);
        const expected={left:0,right:dx*4,top:0,bottom:dy*4},fixed=fixedRegionDifference(reference,frame,rect,clip,dx,dy,parseFloat(before.radius));
        check(!settling.failed&&Object.keys(expected).every(k=>Math.abs(absolute[k]-expected[k])<=.5),'trusted '+name+' must reach 4px only on its force side');
        check(fixed.changedPixels===0,'trusted '+name+' changes the opposite edge or its corners');
        check(frames.length>0&&frames.every(f=>f.rootDrift<=.02&&f.optionDrift!==null&&f.optionDrift<=.02&&f.outset<=4.01),'trusted '+name+' changes root/text geometry or exceeds 4px');
        await mouse('mouseReleased',end);await sleep(500);
        const restored=await capture('trusted-'+name+'-restored'),reset=regionDifference(rest,restored,rect,clip);
        check(reset.changedPixels===0,'trusted '+name+' did not restore idle material');
        entry.trustedDirections.push({name,dx,dy,input:'trusted CDP Input.dispatchMouseEvent',origin,end,before,state,frames,absolute,expected,fixed,reset,settling});
      }
      if(kind==='popover')await evaluate(`(()=>{const m=__directionPopup,items=[...m.querySelectorAll('button')];items.forEach((n,i)=>n.classList.toggle('selected',i===0));m.scrollTop=0;wireDirectLiquidMenuInteractionsV2(m);})()`);
      await sleep(300);
      entry.directions=[];
      for(const [name,dx,dy] of [['right',1,0],['left',-1,0],['up',0,-1],['down',0,1],['upper-left',-1,-1],['lower-right',1,1]]){
        // Native option gestures intentionally constrain the force to their
        // existing rail. This material matrix calls the real renderer helper
        // with explicit vectors; trusted rail gestures are checked above.
        await opticalWait(Math.hypot(dx,dy),dx,dy);
        const directionIdle=await capture('vector-'+name+'-held-reference'),directionBase=await evaluate('__directionState()');
        const directionIdleContour=contour(directionIdle,clear,rect,clip);
        await evaluate('__directionRecord()');
        const settling=await opticalWait(4,dx,dy);
        const frame=await capture('vector-'+name+'-pull'),state=await evaluate('__directionState()'),frames=await evaluate('__directionFinishRecord()');
        const bounds=contour(frame,clear,rect,clip),edges=expansion(directionIdleContour,bounds),distance=Math.hypot(dx,dy);
        const expected={left:Math.max(0,-dx)/distance*4,right:Math.max(0,dx)/distance*4,top:Math.max(0,-dy)/distance*4,bottom:Math.max(0,dy)/distance*4};
        const expectedDelta=Object.fromEntries(Object.entries(expected).map(([k,v])=>[k,v>0?v-1:0])),absoluteEdges=expansion({left:rect.x,top:rect.y,right:rect.x+rect.width,bottom:rect.y+rect.height},bounds);
        const fixed=fixedRegionDifference(directionIdle,frame,rect,clip,dx,dy,parseFloat(directionBase.radius));
        check(Object.keys(expected).every(k=>Math.abs(edges[k]-expectedDelta[k])<=.55&&Math.abs(absoluteEdges[k]-expected[k])<=.55),'optical '+name+' contour must follow the force vector and keep opposite sides fixed');
        check(Object.keys(expected).every(k=>Math.abs(state.pull[k]*state.outset-expected[k])<.02),'optical '+name+' vector must reach 4px without a wrong-side response');
        check(fixed.changedPixels===0,'optical '+name+' opposite edge/corner pixels changed');
        check(JSON.stringify(state.rect)===JSON.stringify(directionBase.rect)&&JSON.stringify(state.options)===JSON.stringify(directionBase.options),'optical '+name+' changed root/text geometry');
        check(frames.length>0&&frames.every(f=>f.rootDrift<=.02&&f.optionDrift!==null&&f.optionDrift<=.02&&f.outset<=4.01),'optical '+name+' frame exceeded geometry budget');
        await opticalWait(Math.hypot(dx,dy),dx,dy);
        const restored=await capture('vector-'+name+'-restored'),reset=regionDifference(directionIdle,restored,rect,clip);
        check(reset.changedPixels===0,'optical '+name+' did not restore held-reference material');
        entry.directions.push({name,dx,dy,input:'real setLiquidPopupOutset, preserving live CSS/RAF',referenceOutset:directionBase.outset,restoredState:await evaluate('__directionState()'),expected,expectedDelta,absoluteEdges,edges,state,frames,fixed,reset,settling});
        await evaluate('clearLiquidPopupOutset(__directionPopup,true)');await sleep(200);
      }
      // A bounded rendering lifecycle check exercises the exact same-amount
      // cache after reset. It supplements, rather than substitutes for, the
      // trusted-input/pixel direction checks above.
      entry.resetSameAmount=await evaluate(`(async()=>{setLiquidPopupOutset(__directionPopup,8,-1,0);await new Promise(r=>setTimeout(r,160));clearLiquidPopupOutset(__directionPopup,false);setLiquidPopupOutset(__directionPopup,8,-1,0);await new Promise(r=>setTimeout(r,160));const s=__directionState();clearLiquidPopupOutset(__directionPopup,true);return s;})()`);
      check(entry.resetSameAmount.outset===4&&entry.resetSameAmount.feedback?.target===4,'oversized request after reset must recreate the clamped 4px outward response');
      entry.screenshotPrefix=prefix;entry.lifecycle=await evaluate('__directionLifecycle.slice('+lifecycleStart+')');
      const interrupted=entry.lifecycle.some(e=>e.event==='blur'||e.event==='pagehide');
      if(interrupted&&(retries[key]||0)<3){report.interruptedAttempts??=[];report.interruptedAttempts.push({key,entry,failures:report.failures.splice(failureStart)});retries[key]=(retries[key]||0)+1;kindIndex--;process.stdout.write('Focus interrupted '+prefix+'; preserving evidence and retrying trusted gesture\n');}
      else{report.cases[key]=entry;process.stdout.write('Captured '+key+'\n');}
      if(!interrupted&&theme===themes.at(-1)&&kind===kinds.at(-1)){
        report.cancelCycles=[];
        for(const event of ['blur','pagehide']){
          await mouse('mouseMoved',p);await mouse('mousePressed',p);await sleep(620);await mouse('mouseMoved',outward);await sleep(170);
          const before=await evaluate('__directionState()');
          // Deliver the registered lifecycle event after a trusted held drag;
          // no production event listener or cancellation path is replaced.
          await evaluate(`dispatchEvent(new Event('${event}'))`);await sleep(30);
          const after=await evaluate('__directionState()');
          report.cancelCycles.push({event,before,after});
          check(before.outset===4&&after.outset===0&&after.feedback===null&&after.marker===null,event+' must remove the expanded surface and its frame tracking');
          await mouse('mouseReleased',p);await sleep(450);
        }
      }
      if(kind==='popover')await evaluate(`__directionPopup.hidePopover();__directionPopup.remove()`);
      else if(kind==='settings')await evaluate(`__directionOverlay.onclick=__directionDismiss;__directionPopup.classList.remove('direction-probe');window.closeSubWin()`);
      else await evaluate(`__directionOverlay.onclick=__directionDismiss;__directionPopup.classList.remove('direction-probe');window.closeCommandSurface()`);
      await sleep(280);
    }
    report.pointerEvents=await evaluate('__directionPointerEvents');report.lifecycle=await evaluate('__directionLifecycle');report.errors=await evaluate('__directionErrors');if(report.errors.length)report.failures.push('Uncaught renderer exceptions');
    report.ok=report.failures.length===0;fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({ok:report.ok,output,failures:report.failures,errors:report.errors}));if(!diagnostic&&!report.ok)process.exitCode=1;
  }finally{
    try{cdp?.socket.close();}catch{}
    if(child.pid)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:15000});
    for(let i=0;i<20;i++){try{fs.rmSync(root,{recursive:true,force:true});break;}catch{await sleep(250);}}
  }
}
module.exports={contour,expansion,regionDifference};
if(require.main===module)main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
