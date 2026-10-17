// verify-desktop-pet-render.mjs - fail-able screen-render gate for the NewMate desktop pet.
//
// MEASURED DEFECT THIS GATE GUARDS (recorded 2026-10-17 in
// Newmark2DSH/archive/20261017-184543-pet-white-plate): the companion pet's layered
// surface could be left showing an opaque white rectangle over its whole window
// ("white block"). The defect investigation measured, on this host in physical
// pixels at DPI 192, healthy CopyFromScreen frames of the 178x153 pet rect with
// lumaMin 26-27, lumaMax 252-253, meanLuma 47-82 and 11-476 pixels at luma>=250,
// against a defect frame of 27234/27234 pixels at exactly luma 255. Root cause:
// the pet presented its layered surface only from Tick while it was moving, so
// one bad surface stayed on screen for as long as the pet stayed idle.
// This gate measures its own 338x289 companion canvas (size_multiplier 1, DPI 192)
// and records its own numbers in render-results.json; they are not those of the
// 178x153 reference rect.
//
// ASSERTIONS. Each one can fail; the exact numbers are in render-results.json.
//   1 presented_frames_are_not_a_uniform_block
//       guards "the sprite is what the user sees". Five CopyFromScreen frames of
//       the pet rectangle, 200 ms apart (capture start to capture start; the
//       observed completion-to-completion gaps are recorded as sincePreviousMs,
//       because a capture can itself cost more than the interval), over an opaque
//       luma-40 background window so the result cannot depend on the desktop
//       wallpaper. Every frame
//       must not be a single luma value and must contain dark (luma<=60) and
//       light (luma>=200) pixels - over the whole rectangle AND inside
//       paint_bounds (the sprite region), so neither an opaque white block nor an
//       empty transparent rectangle can pass. A second burst over the untouched
//       desktop is recorded as corroboration of what the user sees.
//   2 transparent_background_preserved
//       guards per-pixel alpha reaching the screen. The pet is captured over an
//       opaque background window of luma 40 and then of luma 235, and the pixels
//       of its transparent padding ring (outside paint_bounds) must follow that
//       background. Any opaque surface fails to follow it.
//   3 companion_idle_keeps_redrawing  (was: stale_presentation_self_heals)
//       guards the observed failure mode itself, in the mode it was observed in.
//       The gate asserts the precondition first - the pet must report cu:false and
//       pet_transition:"idle", i.e. no motion and no outline animation, because a
//       pet that is animating re-presents every frame and would hide the defect.
//       It also asserts the positive half (the pet presents a content frame while
//       idle with nothing injected). Then an opaque pure-white
//       UpdateLayeredWindow surface of exactly the pet rectangle (ULW_ALPHA,
//       AC_SRC_ALPHA, alpha 255) is injected into the pet's own hwnd, and the pet
//       must present a content frame again within 2500 ms. This is the mutation
//       proof: the unfixed snapshot never re-presents and fails here.
//   4 no_whole_block_flip
//       guards flip-flopping inside the burst: no adjacent captured pair may
//       have one side a uniform block (one luma value covering the rectangle).
//   6 no_opaque_white_plate
//       guards the defect's exact signature by pixel value, not by shape: the
//       fraction of pixels that are EXACTLY (255,255,255) must stay below 0.8 over
//       the pet rectangle and inside paint_bounds. Measured: the defect is 1.0
//       (27234/27234 and 97682/97682); healthy frames measured 0.0-0.001 here.
//   7 transparent_corner_matches_the_desktop
//       guards per-pixel transparency at the PIXEL level, which the older
//       hit-test check (WindowFromPoint) cannot see: after the burst, the gate
//       hides its own pet, captures the same rectangle, and requires each of the
//       four composited corners of the presented frame to equal that
//       desktop-under reference within 12 per channel - and requires the reference
//       itself not to be white, so the comparison cannot pass vacuously.
//   5 printwindow_digest_recorded
//       records the PrintWindow(hwnd,dc,2) luma min/max/distinct and sha256 as
//       EVIDENCE ONLY. Measured fact: PrintWindow cannot see an
//       UpdateLayeredWindow surface and renders the unpainted WinForms control
//       background, so it must never be the pass criterion. This check fails
//       only if the digest cannot be measured at all.
//
// Usage: node Newmark2DSH/scripts/verify-desktop-pet-render.mjs <evidenceDir> [pkgDir]
//   exit 1 if any assertion fails. Six checks normally run: the five assertions
//   above and pet_publishes_its_window (the pet must publish a status.json for the
//   pid this gate spawned, reported with its exit state and error.json when it
//   does not). A seventh, gate_runs_to_completion, is added only when the gate
//   itself throws.
//
// ISOLATION RULES. The gate compiles and launches its OWN pet on the DEFAULT
// desktop (never a hidden takeover desktop, which is not composited and cannot be
// seen by a screen BitBlt), records every newmark-desktop-pet process that was
// already running, moves only its own window clear of every visible topmost
// window that has a redirection surface, and kills only the pid it spawned.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const here=path.dirname(fileURLToPath(import.meta.url));
const out=path.resolve(process.argv[2]||path.join(here,'../archive/20261017-184543-pet-white-plate/baseline/render-evidence'));
const pkg=path.resolve(process.argv[3]||path.join(here,'../packages/newmark-core'));
const probeFile=path.join(here,'lib/desktop-pet-render-probe.ps1');
const POWERSHELL='powershell.exe';
const BACKGROUND_LUMA=40;
const BACKGROUND_LUMA_LIGHT=235;
const WAIT_STATUS_MS=15000;
const WAIT_SETTLE_MS=12000;
process.env.NEWMARK_USER_ROOT=path.join(out,'user-root');
fs.mkdirSync(out,{recursive:true});

const checks=[];
const facts={};
const startedAtUtc=new Date().toISOString();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha256File=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const quote=bounds=>[bounds.x,bounds.y,bounds.width,bounds.height].join(',');

function check(name,ok,detail){
  checks.push({name,ok:!!ok,detail:detail===undefined?null:detail});
  console.log((ok?'PASS ':'FAIL ')+name+(detail===undefined?'':' '+JSON.stringify(detail)));
}

/* Runs one probe action and returns its JSON object. The probe host is Windows
   PowerShell 5.1, the only host whose System.Drawing the embedded C# helper
   compiles against. Arguments go through execFile's argv array, so a config or
   evidence path containing spaces is passed to the child intact. */
function probe(args,options){
  const settings=options||{};
  let stdout='';
  try {
    stdout=execFileSync(POWERSHELL,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',probeFile,...args],{encoding:'utf8',windowsHide:true,timeout:settings.timeout||90000,maxBuffer:64*1024*1024});
  } catch(error){
    const stderr=String(error.stderr||'').slice(-800);
    const partial=String(error.stdout||'').slice(-800);
    throw new Error('probe '+args[0]+' '+args[1]+' failed: '+(error.message||'')+' stdout='+partial+' stderr='+stderr);
  }
  const lines=String(stdout).split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  for(let index=lines.length-1;index>=0;index--){
    if(lines[index].charAt(0)!=='{')continue;
    let value=null;
    try { value=JSON.parse(lines[index]); } catch (error) { continue; }
    if(value&&value.ok===false) throw new Error('probe '+args[0]+' '+args[1]+' reported '+JSON.stringify(value).slice(0,900));
    if(value) return value;
  }
  throw new Error('probe '+args[0]+' '+args[1]+' produced no JSON object; last output '+stdout.slice(-600));
}

/* The pet publishes status.json with File.Replace (temp file + rename), so a
   reader can catch the rename window. Node opens read handles with
   FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE - what FileShare.ReadWrite
   buys in .NET - and the retry covers the replace window itself. */
async function waitForJson(file,timeoutMs){
  const start=Date.now();
  let lastError='none';
  while(Date.now()-start<timeoutMs){
    try { return JSON.parse(fs.readFileSync(file,'utf8')); }
    catch(error){ lastError=error.code||error.message; }
    await sleep(100);
  }
  throw new Error(file+' was not readable and parsable within '+timeoutMs+' ms ('+lastError+')');
}

/* A pet is only measurable once its entrance squash has settled: paint_bounds is
   written from the live spring value, so a mid-animation read would mask the
   wrong sprite region. Two consecutive identical reads of an idle, full-scale
   pet are required. */
async function waitForSettledPet(file,timeoutMs){
  const start=Date.now();
  let previous=null;
  while(Date.now()-start<timeoutMs){
    let status=null;
    try { status=JSON.parse(fs.readFileSync(file,'utf8')); } catch (error) { status=null; }
    if(status&&status.pet_transition==='idle'&&status.pet_scale_x>=0.999&&status.pet_scale_y>=0.999&&status.hwnd&&status.bounds&&status.paint_bounds){
      if(previous&&JSON.stringify(previous.bounds)===JSON.stringify(status.bounds)&&JSON.stringify(previous.paint_bounds)===JSON.stringify(status.paint_bounds)) return status;
      previous=status;
    } else { previous=null; }
    await sleep(150);
  }
  throw new Error('pet never reported a settled idle surface at full scale within '+timeoutMs+' ms');
}

const intersects=(a,b)=>a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height;
const gapBetween=(a,b)=>Math.max(b.x-(a.x+a.width),a.x-(b.x+b.width),0)+Math.max(b.y-(a.y+a.height),a.y-(b.y+b.height),0);

/* Windows that can actually paint over the pet: visible, topmost, non-empty and
   carrying a redirection surface. A WS_EX_NOREDIRECTIONBITMAP window has no
   surface to composite (on this host the full-screen 'IslandWindow' XAML island),
   so it cannot hide the pet; it is excluded and reported instead of silently
   dropped. */
function selectKeepOut(environment,ourHwnd){
  const keep=[];
  const ignored=[];
  for(const window of environment.windows||[]){
    if(!window.Visible||!window.Topmost||window.Width<=0||window.Height<=0)continue;
    if(window.Hwnd===ourHwnd)continue;
    const rect={x:window.X,y:window.Y,width:window.Width,height:window.Height};
    const entry={hwnd:window.Hwnd,pid:window.Pid,className:window.ClassName,title:window.Title,rect:rect};
    if((window.ExStyle&0x00200000)!==0){ entry.reason='WS_EX_NOREDIRECTIONBITMAP: no surface to composite'; ignored.push(entry); continue; }
    keep.push(entry);
  }
  return {keep:keep,ignored:ignored};
}

function selectTargetRect(size,workArea,keep,step){
  const stride=step||8;
  let best=null;
  for(let y=workArea.y;y+size.height<=workArea.y+workArea.height;y+=stride){
    for(let x=workArea.x;x+size.width<=workArea.x+workArea.width;x+=stride){
      const candidate={x:x,y:y,width:size.width,height:size.height};
      let clear=true;
      let score=Infinity;
      for(const entry of keep){
        if(intersects(candidate,entry.rect)){ clear=false; break; }
        score=Math.min(score,gapBetween(candidate,entry.rect));
      }
      if(clear&&(best===null||score>best.score))best={score:score,rect:candidate};
    }
  }
  return best;
}

/* PowerShell 5.1 can collapse a one-element array to a bare object. */
const asArray=value=>value===undefined||value===null?[]:(Array.isArray(value)?value:[value]);

const frameSummary=frame=>({
  file:frame.file, atMs:frame.atMs, sha256:frame.sha256,
  pure255:frame.pure255, pure255Ratio:frame.pure255Ratio, corners:frame.corners, center:frame.center,
  width:frame.width, height:frame.height, pixels:frame.pixels,
  lumaMin:frame.lumaMin, lumaMax:frame.lumaMax, distinct:frame.distinct, modal:frame.modal,
  blockRatio:frame.blockRatio, meanLuma:frame.meanLuma, white250:frame.white250, dark60:frame.dark60, light200:frame.light200,
  inside:frame.inside, uniformBlock:frame.uniformBlock, content:frame.content, spriteContent:frame.spriteContent,
  hitAtPaintCentre:frame.hitAtPaintCentre, hitIsOurHandle:frame.hitIsOurHandle,
  startMs:frame.startMs===undefined?null:frame.startMs,
  sincePreviousStartMs:frame.sincePreviousStartMs===undefined?null:frame.sincePreviousStartMs,
  sincePreviousMs:frame.sincePreviousMs===undefined?null:frame.sincePreviousMs
});

/* Assertion 1's per-frame requirements, exactly as the gate header states them. */
function assertionOneFailures(frame){
  const reasons=[];
  if(!(frame.distinct>1))reasons.push('distinct='+frame.distinct+': the rectangle is a single luma value');
  if(!(frame.dark60>0))reasons.push('dark60=0: no pixel at luma<=60');
  if(!(frame.light200>0))reasons.push('light200=0: no pixel at luma>=200');
  if(!(frame.inside.dark60>0))reasons.push('inside.dark60=0: the sprite region has no dark pixel');
  if(!(frame.inside.light200>0))reasons.push('inside.light200=0: the sprite region has no light pixel');
  return reasons;
}

let child=null;
let petStatus=null;
let hwnd=0;
let keepOut={keep:[],ignored:[]};
let workArea={x:0,y:0,width:0,height:0};

function petProcessesFrom(environment){
  return (environment.petProcesses||[]).map(entry=>({id:entry.id,startTime:entry.startTime,path:entry.path}));
}

async function stopOurPet(){
  if(!child)return;
  const directory=petStatus&&petStatus.directory?petStatus.directory:null;
  if(child.exitCode===null&&child.signalCode===null&&directory){
    try { fs.writeFileSync(path.join(directory,'stop'),'render-gate-finished'); } catch (error) { /* fall through to kill */ }
  }
  for(let attempt=0;attempt<20&&child.exitCode===null&&child.signalCode===null;attempt++)await sleep(100);
  if(child.exitCode===null&&child.signalCode===null){
    try { child.kill(); } catch (error) { /* already gone */ }
    for(let attempt=0;attempt<10&&child.exitCode===null&&child.signalCode===null;attempt++)await sleep(100);
  }
  if(child.exitCode===null&&child.signalCode===null){
    try { execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}); } catch (error) { /* reported below */ }
    for(let attempt=0;attempt<20&&child.exitCode===null&&child.signalCode===null;attempt++)await sleep(100);
  }
}

try {
  if(!fs.existsSync(probeFile))throw new Error('probe missing: '+probeFile);
  if(!fs.existsSync(path.join(pkg,'components/computeruse/lib/desktop-pet.js')))throw new Error('package missing desktop-pet.js under '+pkg);

  // 1. Record the environment BEFORE anything is launched, including every pet
  //    process that is already running so it can be proven untouched later.
  const environment=probe(['-Action','environment'],{timeout:60000});
  fs.writeFileSync(path.join(out,'environment.json'),JSON.stringify(environment,null,2));
  const preExistingPets=petProcessesFrom(environment);
  workArea={x:environment.workArea[0],y:environment.workArea[1],width:environment.workArea[2],height:environment.workArea[3]};
  const surfaceWindows=(environment.windows||[]).filter(window=>window.Visible&&window.Topmost&&window.Width>0&&window.Height>0&&(window.ExStyle&0x00200000)===0);
  facts.environment={
    probePid:environment.probePid, probeHost:environment.probeHost, powerShell:environment.powerShell,
    dpi:environment.dpi, screen:environment.screen, virtualScreen:environment.virtualScreen, workArea:environment.workArea,
    cursor:environment.cursor, foreground:environment.foreground,
    windowCount:(environment.windows||[]).length,
    compositingTopmostWindows:surfaceWindows.map(window=>({hwnd:window.Hwnd,pid:window.Pid,className:window.ClassName,title:window.Title,rect:{x:window.X,y:window.Y,width:window.Width,height:window.Height}})),
    preExistingPetProcesses:preExistingPets
  };

  // 2. Build the pet's own session in the evidence directory and launch it with
  //    an argv array (never a hand-built command line: the evidence path can
  //    contain spaces).
  const petDirectory=path.join(out,'pet');
  fs.mkdirSync(petDirectory,{recursive:true});
  const prefsPath=path.join(out,'prefs.json');
  fs.writeFileSync(prefsPath,JSON.stringify({version:2,size_multiplier:1}));
  const configPath=path.join(petDirectory,'config.json');
  const config={
    ownerPid:process.pid,
    desktop:'Default',
    directory:petDirectory,
    settingsPath:prefsPath,
    menuThemePath:'',
    menuShellPath:path.join(pkg,'components/computeruse/lib/desktop-menu.html'),
    menuCachePath:path.join(out,'webview-cache'),
    asset:path.join(pkg,'components/computeruse/assets/desktop-pet.png')
  };
  fs.writeFileSync(configPath,JSON.stringify(config));
  fs.writeFileSync(path.join(petDirectory,'mode.json'),JSON.stringify({visible:true,companion:true,cu:false,outline:false,dshExe:'',readerUntil:0,bubbleDark:true,cuMode:'virtual',spacePreview:{}}));

  const desktopPetSource=path.join(pkg,'components/computeruse/lib/desktop-pet.cs');
  const { compileDesktopPet }=await import(pathToFileURL(path.join(pkg,'components/computeruse/lib/desktop-pet.js')));
  const executable=await compileDesktopPet();
  const statusFile=path.join(petDirectory,'status.json');
  child=spawn(executable,[configPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let petStdout='';
  let petStderr='';
  child.stdout.on('data',data=>{petStdout+=data;});
  child.stderr.on('data',data=>{petStderr+=data;});
  facts.pet={
    package:pkg, desktopPetSource:desktopPetSource, desktopPetSourceSha256:sha256File(desktopPetSource),
    executable:executable, executableSha256:sha256File(executable),
    spawnedPid:child.pid, config:config, configPath:configPath
  };

  // 3. Wait for the published window. A silent "window not found" is worthless
  //    evidence, so a timeout reports the exit state and the pet's own error file.
  let booted=null;
  try {
    booted=await waitForJson(statusFile,WAIT_STATUS_MS);
  } catch (error) {
    let errorFile=null;
    try { errorFile=fs.readFileSync(path.join(petDirectory,'error.json'),'utf8'); } catch (readError) { errorFile=null; }
    check('pet_publishes_its_window',false,{
      error:error.message,
      hasExited:child.exitCode!==null||child.signalCode!==null,
      exitCode:child.exitCode, signal:child.signalCode,
      petDirectory:petDirectory, errorFile:errorFile, petStdout:petStdout.slice(-600), petStderr:petStderr.slice(-600)
    });
    throw new Error('desktop pet did not publish status.json: '+error.message);
  }
  hwnd=booted.hwnd;
  check('pet_publishes_its_window',booted.pid===child.pid&&Number(hwnd)>0,{
    pid:booted.pid, spawnedPid:child.pid, hwnd:hwnd, desktop:booted.desktop,
    boundsAtFirstPublish:booted.bounds, paintBoundsAtFirstPublish:booted.paint_bounds,
    sizeMultiplier:booted.size_multiplier, petTransitionAtFirstPublish:booted.pet_transition, displaySyncAtFirstPublish:booted.display_sync,
    note:'first published status; measurement uses the settled read in facts.pet.status'
  });
  if(booted.pid!==child.pid)throw new Error('status.json belongs to pid '+booted.pid+', not the pid this gate spawned ('+child.pid+')');
  petStatus=await waitForSettledPet(statusFile,WAIT_SETTLE_MS);
  facts.pet.status=petStatus;
  fs.writeFileSync(path.join(out,'pet-status-settled.json'),JSON.stringify(petStatus,null,2));

  // 4. Move only our own window clear of every other compositing topmost window
  //    (the user's live pet sits in the same bottom-right corner). Measured: the
  //    presented surface follows SetWindowPos on both the fixed and the unfixed
  //    build, so the move does not re-present anything.
  keepOut=selectKeepOut(environment,hwnd);
  facts.keepOut=keepOut;
  const current={x:petStatus.bounds.x,y:petStatus.bounds.y,width:petStatus.bounds.width,height:petStatus.bounds.height};
  const blocked=keepOut.keep.filter(entry=>intersects(current,entry.rect));
  if(blocked.length>0){
    const choice=selectTargetRect({width:current.width,height:current.height},workArea,keepOut.keep,8);
    if(!choice)throw new Error('no free rectangle of '+current.width+'x'+current.height+' avoids every compositing topmost window');
    const move=probe(['-Action','move','-HandleValue',String(hwnd),'-TargetX',String(choice.rect.x),'-TargetY',String(choice.rect.y)],{timeout:30000});
    petStatus=await waitForSettledPet(statusFile,WAIT_SETTLE_MS);
    facts.move={blockedBy:blocked,chosen:choice,move:move,settledBounds:petStatus.bounds};
    if(Math.abs(petStatus.bounds.x-choice.rect.x)>2||Math.abs(petStatus.bounds.y-choice.rect.y)>2)throw new Error('pet did not settle at the requested rectangle');
  } else {
    facts.move={blockedBy:[],chosen:null,note:'current rectangle already clear of every compositing topmost window'};
  }

  const bounds={x:petStatus.bounds.x,y:petStatus.bounds.y,width:petStatus.bounds.width,height:petStatus.bounds.height};
  const paint={x:petStatus.paint_bounds.x,y:petStatus.paint_bounds.y,width:petStatus.paint_bounds.width,height:petStatus.paint_bounds.height};
  const boundsText=quote(bounds);
  const paintText=quote(paint);
  facts.measuredGeometry={window:bounds,paintBounds:paint,ringPixels:bounds.width*bounds.height-(paint.width+4)*(paint.height+4)};
  const remaining=keepOut.keep.filter(entry=>intersects(bounds,entry.rect));
  if(remaining.length>0)throw new Error('another compositing topmost window still covers the pet rectangle: '+JSON.stringify(remaining));

  // 5. Assertion 1 and 4 share one burst.
  const controlled=probe(['-Action','frames','-HandleValue',String(hwnd),'-EvidenceDirectory',out,'-Prefix','presented','-Count','5','-IntervalMs','200','-PaintBounds',paintText,'-StatusBounds',boundsText,'-BackgroundLuma',String(BACKGROUND_LUMA)],{timeout:60000});
  const life=probe(['-Action','frames','-HandleValue',String(hwnd),'-EvidenceDirectory',out,'-Prefix','life','-Count','5','-IntervalMs','200','-PaintBounds',paintText,'-StatusBounds',boundsText],{timeout:60000});
  const controlledFrames=asArray(controlled.frames);
  const lifeFrames=asArray(life.frames);
  const delta=controlled.boundsDelta||{};
  const geometryTrustworthy=['x','y','width','height'].every(key=>Math.abs(Number(delta[key]===undefined?99:delta[key]))<=2);
  const failures=[];
  for(const frame of controlledFrames){
    const reasons=assertionOneFailures(frame);
    if(reasons.length>0)failures.push({file:frame.file,reasons:reasons});
  }
  check('presented_frames_are_not_a_uniform_block',controlledFrames.length===5&&geometryTrustworthy&&failures.length===0,{
    frameCount:controlledFrames.length,
    statusBounds:controlled.statusBounds, probeWindow:controlled.window, boundsDelta:controlled.boundsDelta, geometryTrustworthy:geometryTrustworthy,
    backgroundWindow:controlled.background,
    failures:failures,
    frames:controlledFrames.map(frameSummary),
    corroboratingFramesOverTheUntouchedDesktop:lifeFrames.map(frameSummary)
  });

  const blockFlags=controlledFrames.map(frame=>frame.uniformBlock);
  const flips=[];
  for(let index=0;index+1<blockFlags.length;index++){
    if(blockFlags[index]!==blockFlags[index+1])flips.push({first:controlledFrames[index].file,second:controlledFrames[index+1].file,firstBlock:blockFlags[index],secondBlock:blockFlags[index+1]});
  }
  check('no_whole_block_flip',flips.length===0,{
    uniformBlockFlags:blockFlags,
    blockRatios:controlledFrames.map(frame=>frame.blockRatio),
    distinctValues:controlledFrames.map(frame=>frame.distinct),
    observedStartToStartIntervalsMs:controlledFrames.map(frame=>frame.sincePreviousStartMs===undefined?null:frame.sincePreviousStartMs),
    observedCompletionToCompletionMs:controlledFrames.map(frame=>frame.sincePreviousMs===undefined?null:frame.sincePreviousMs),
    flips:flips
  });

  // 6b. Assertion 6: the defect's exact pixel signature, reddened above 0.8.
  const WHITE_PLATE_RATIO=0.8;
  const plateViolations=[];
  for(const frame of controlledFrames.concat(lifeFrames)){
    if(Number(frame.pure255Ratio)>WHITE_PLATE_RATIO)plateViolations.push({file:frame.file,where:'rect',pure255:frame.pure255,pixels:frame.pixels,pure255Ratio:frame.pure255Ratio});
    const inside=frame.inside||{};
    if(Number(inside.pure255Ratio)>WHITE_PLATE_RATIO)plateViolations.push({file:frame.file,where:'paintBounds',pure255:inside.pure255,pixels:inside.pixels,pure255Ratio:inside.pure255Ratio});
  }
  check('no_opaque_white_plate',controlledFrames.length===5&&plateViolations.length===0,{
    threshold:WHITE_PLATE_RATIO,
    criterion:'the fraction of pixels that are exactly (255,255,255) must be <= 0.8 over the whole rectangle and inside paint_bounds; the measured defect is 1.0',
    violations:plateViolations,
    perFrame:controlledFrames.concat(lifeFrames).map(frame=>({file:frame.file,pure255:frame.pure255,pure255Ratio:frame.pure255Ratio,insidePure255:(frame.inside||{}).pure255,insidePure255Ratio:(frame.inside||{}).pure255Ratio,white250:frame.white250,meanLuma:frame.meanLuma}))
  });

  // 6. Assertion 2.
  const ring=probe(['-Action','ring','-HandleValue',String(hwnd),'-EvidenceDirectory',out,'-Prefix','ring','-PaintBounds',paintText,'-StatusBounds',boundsText,'-BackgroundLumaDark',String(BACKGROUND_LUMA),'-BackgroundLumaLight',String(BACKGROUND_LUMA_LIGHT),'-ChangeThreshold','20','-ColorTolerance','12'],{timeout:60000});
  const ringStats=ring.ring;
  const ringOk=ringStats.pixels>=1000&&ringStats.changedRatio>=0.5&&ringStats.meanAbsDelta>=30;
  check('transparent_background_preserved',ringOk,{
    ring:ringStats,
    backgroundWindow:ring.backgroundWindow,
    boundsDelta:ring.boundsDelta,
    frameOverDarkBackground:frameSummary(ring.frameDark),
    frameOverLightBackground:frameSummary(ring.frameLight),
    criterion:'ring pixels outside paint_bounds must follow the background: changedRatio>=0.5 and meanAbsDelta>=30 over >=1000 ring pixels'
  });
  facts.ring={darkFile:'ring-dark.png',lightFile:'ring-light.png'};

  // 7. Assertion 5: evidence only. PrintWindow cannot see a layered surface.
  let digest=null;
  let digestError='';
  try {
    digest=probe(['-Action','printwindow','-HandleValue',String(hwnd),'-EvidenceDirectory',out,'-Prefix','print','-PaintBounds',paintText],{timeout:20000});
  } catch (error) { digestError=error.message; }
  const digestRecorded=!!digest&&/^[0-9a-f]{64}$/.test(String(digest.sha256||''));
  check('printwindow_digest_recorded',digestRecorded,{
    digest:digest?{file:digest.file,width:digest.width,height:digest.height,pixels:digest.pixels,lumaMin:digest.lumaMin,lumaMax:digest.lumaMax,distinct:digest.distinct,meanLuma:digest.meanLuma,white250:digest.white250,dark60:digest.dark60,light200:digest.light200,sha256:digest.sha256,printed:digest.printed}:null,
    error:digestError,
    hazard:digest?digest.hazard:null,
    note:'evidence only: this check fails only when the digest cannot be measured, never as a pass criterion for the white-block defect'
  });
  if(digest&&controlledFrames.length>0){
    facts.printWindowBlindToLayeredSurface=(digest.distinct===1)&&(controlledFrames[0].distinct>1);
    facts.printWindowContrast={printWindowDistinct:digest.distinct,printWindowMeanLuma:digest.meanLuma,screenDistinct:controlledFrames[0].distinct,screenMeanLuma:controlledFrames[0].meanLuma};
  }

  // 8. Assertion 3: the idle-companion keep-alive. Precondition first: cu must be
  // false and the pet must be at rest, otherwise it is already re-presenting every
  // frame and the injection proves nothing. Then the positive half (idle content),
  // then the injection and the measured recovery.
  const idlePrecondition={cu:(petStatus?petStatus.cu:null),petTransition:(petStatus?petStatus.pet_transition:null),outlineActive:(petStatus?petStatus.outline_active:null),sizeMultiplier:(petStatus?petStatus.size_multiplier:null),source:'status.json settled read (facts.pet.status)'};
  const idlePreconditionHeld=idlePrecondition.cu===false&&idlePrecondition.petTransition==='idle';
  const idleContentFrames=controlledFrames.filter(frame=>frame.content&&frame.spriteContent).length;
  const idleContentHeld=idleContentFrames===controlledFrames.length&&controlledFrames.length===5;
  const watch=probe(['-Action','inject-watch','-HandleValue',String(hwnd),'-EvidenceDirectory',out,'-Prefix','inject','-TimeoutMs','2500','-PollMs','150','-PaintBounds',paintText],{timeout:120000});
  check('companion_idle_keeps_redrawing',!!(idlePreconditionHeld&&idleContentHeld&&watch.injection.ok&&watch.healed),{
    precondition:idlePrecondition,
    preconditionHeld:idlePreconditionHeld,
    prerequisite:'cu:false and pet_transition:"idle" - without it the pet re-presents every frame and the injection cannot prove keep-alive',
    idleContentFrames:idleContentFrames,
    idleContentHeld:idleContentHeld,
    idleContentNote:'positive half: with nothing injected, every idle frame already carries content, so the pet is presenting while at rest',
    injection:watch.injection,
    injectedObservedUniformWhite:watch.injectedObservedUniformWhite,
    injectedObservedAtMs:watch.injectedObservedAtMs,
    healed:watch.healed, healUpperBoundMs:watch.healUpperBoundMs, healFromCaptureStartMs:watch.healFromCaptureStartMs, lateContentAtMs:watch.lateContentAtMs,
    timeoutMs:watch.timeoutMs, pollMs:watch.pollMs, pollCount:watch.pollCount,
    contentFrame:watch.contentFrame?frameSummary(watch.contentFrame):null,
    polls:asArray(watch.polls).map(poll=>({file:poll.file,sinceInjectionStartedMs:poll.sinceInjectionStartMs,observedAtMs:poll.sinceInjectionMs,pollGapMs:poll.sincePreviousStartMs===undefined?null:poll.sincePreviousStartMs,sha256:poll.sha256,lumaMin:poll.lumaMin,lumaMax:poll.lumaMax,distinct:poll.distinct,blockRatio:poll.blockRatio,white250:poll.white250,pixels:poll.pixels,meanLuma:poll.meanLuma,content:poll.content,hitIsOurHandle:poll.hitIsOurHandle})),
    note:'passes when the injected opaque white surface is replaced by a content frame within the bounded window; the poll list shows the measured heal latency'
  });

  // 9. Assertion 7: pixel-level transparency against a desktop-under reference.
  // Runs LAST because it hides and re-shows our own window, which on the unfixed
  // build leaves the surface stale - nothing after it may depend on that surface.
  const CORNER_TOLERANCE=12;
  let under=null;
  let underError='';
  try { under=probe(['-Action','desktop-under','-HandleValue',String(hwnd),'-EvidenceDirectory',out,'-Prefix','under','-PaintBounds',paintText,'-BackgroundLuma',String(BACKGROUND_LUMA)],{timeout:30000}); }
  catch (error) { underError=error.message; }
  const presentedCorners=controlledFrames.length>0?asArray(controlledFrames[0].corners):[];
  const referenceCorners=under?asArray(under.corners):[];
  const cornerDelta=(a,b)=>Math.abs(((a>>16)&255)-((b>>16)&255))+Math.abs(((a>>8)&255)-((b>>8)&255))+Math.abs((a&255)-(b&255));
  const cornerFailures=[];
  if(referenceCorners.length===4&&presentedCorners.length===4){
    for(let index=0;index<4;index++){
      const delta=cornerDelta(Number(presentedCorners[index]),Number(referenceCorners[index]));
      if(delta>CORNER_TOLERANCE)cornerFailures.push({corner:index,presented:Number(presentedCorners[index]),desktop:Number(referenceCorners[index]),absChannelDelta:delta});
    }
  }
  const referenceIsWhite=referenceCorners.length===4&&referenceCorners.every(value=>Number(value)===0xFFFFFF);
  const cornerCheckRan=!!under&&presentedCorners.length===4&&referenceCorners.length===4&&!referenceIsWhite;
  check('transparent_corner_matches_the_desktop',cornerCheckRan&&cornerFailures.length===0,{
    tolerancePerChannel:CORNER_TOLERANCE,
    criterion:'each composited corner pixel of the presented frame must equal the same point captured with our window hidden (the desktop it is composited over), within 12 per channel; the reference must not itself be white or the comparison is vacuous',
    presentedCorners:presentedCorners, referenceCorners:referenceCorners, cornerFailures:cornerFailures,
    referenceIsWhite:referenceIsWhite,
    desktopUnder:under?{file:under.file,width:under.width,height:under.height,pixels:under.pixels,lumaMin:under.lumaMin,lumaMax:under.lumaMax,distinct:under.distinct,meanLuma:under.meanLuma,pure255:under.pure255,corners:asArray(under.corners),center:under.center,sha256:under.sha256,reshown:under.reshown}:null,
    error:underError,
    note:'a hit test (WindowFromPoint) answers whether a click passes through; only the pixel comparison answers whether the corner is TRANSPARENT, which is what the white plate abused'
  });
  facts.injection={white:255,acceptedFormat:'ULW_ALPHA, AC_SRC_ALPHA, alpha 255, DIB of exactly the pet rect'};
} catch (error) {
  check('gate_runs_to_completion',false,{error:error.message,stack:error.stack});
} finally {
  // Snapshot the live status before the graceful stop: the pet removes its own
  // session files as it exits.
  try {
    const finalStatus=JSON.parse(fs.readFileSync(path.join(out,'pet','status.json'),'utf8'));
    fs.writeFileSync(path.join(out,'pet-status-final.json'),JSON.stringify(finalStatus,null,2));
    if(facts.pet)facts.pet.statusFinal=finalStatus;
  } catch (error) { /* the pet may already have removed its session files */ }
  await stopOurPet();
  const stopped=child?(child.exitCode!==null||child.signalCode!==null):true;
  let after=null;
  try { after=probe(['-Action','environment'],{timeout:60000}); } catch (error) { after=null; }
  const postPets=after?petProcessesFrom(after):[];
  const preExistingIds=(facts.environment?facts.environment.preExistingPetProcesses:[]).map(entry=>entry.id);
  const stillRunning=preExistingIds.filter(id=>postPets.some(entry=>entry.id===id));
  facts.processSafety={
    spawnedPid:child?child.pid:null, spawnedPidStopped:stopped, spawnedExitCode:child?child.exitCode:null,
    preExistingPetIds:preExistingIds, postRunPetProcesses:postPets,
    preExistingPetsStillRunning:stillRunning,
    note:'the gate only ever killed the pid it spawned; no process was ever selected by name'
  };
  console.log('INFO process safety: spawned='+JSON.stringify(facts.processSafety.spawnedPid)+' stopped='+stopped+' preExistingPets='+JSON.stringify(preExistingIds)+' stillRunning='+JSON.stringify(stillRunning)+' postRunPets='+JSON.stringify(postPets.map(entry=>entry.id)));
  const passed=checks.filter(item=>item.ok).length;
  const verdict=checks.every(item=>item.ok)?'pass':'fail';
  const results={
    gate:'verify-desktop-pet-render.mjs',
    generatedAtUtc:new Date().toISOString(),
    startedAtUtc:startedAtUtc,
    evidenceDirectory:out,
    package:pkg,
    probeHostCommand:POWERSHELL+' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '+probeFile,
    verdict:verdict,
    passed:passed,
    total:checks.length,
    checks:checks,
    facts:facts
  };
  fs.writeFileSync(path.join(out,'render-results.json'),JSON.stringify(results,null,2));
  console.log(passed+'/'+checks.length+' passed');
  process.exitCode=verdict==='pass'?0:1;
}
