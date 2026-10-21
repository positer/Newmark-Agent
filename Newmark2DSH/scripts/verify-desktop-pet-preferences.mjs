// Read persisted size through the production backend, with isolated user roots.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const out=path.resolve(process.argv[2]);
const pkg=path.resolve(process.argv[3] || path.join(here,'../packages/newmark-core'));
const explicitRoot=path.join(out,'explicit-root'), envRoot=path.join(out,'env-root');
process.env.NEWMARK_USER_ROOT=envRoot;
const {runComputerUse,stopAll}=await import(pathToFileURL(path.join(pkg,'components/computeruse/lib/win32.js')));
const {desktopPetState}=await import(pathToFileURL(path.join(pkg,'components/computeruse/lib/desktop-pet.js')));
const file=root=>path.join(root,'computer-use/desktop-pet.json');
for(const root of [explicitRoot,envRoot])fs.mkdirSync(path.dirname(file(root)),{recursive:true});
fs.writeFileSync(file(explicitRoot),JSON.stringify({version:1,size_multiplier:1.25}));
fs.writeFileSync(file(envRoot),JSON.stringify({version:1,size_multiplier:2}));
const checks=[];
function check(name,ok,detail){checks.push({name,ok:!!ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}`);}
const call=async args=>JSON.parse(await runComputerUse({ownerId:'pet-preferences-acceptance',...args}));
async function start(userRoot){
  const result=await call({action:'takeover_start',mouseMode:'virtual',userRoot});
  if(!result.ok)throw Error(JSON.stringify(result));
  // The lease returns while its native indicator is still starting.
  for(let i=0;i<150;i++){
    const state=desktopPetState();if(state.running && state.window)return state.window;
    if(state.error)throw Error(state.error);await new Promise(r=>setTimeout(r,100));
  }
  throw Error('Native preference state did not become ready');
}
async function stop(){const result=await call({action:'takeover_stop'});if(!result.ok)throw Error(JSON.stringify(result));}
try {
  let state=await start(explicitRoot);
  check('explicit host root wins over environment root through the production backend',Math.abs(state.size_multiplier-1.25/.75)<1e-9,state.size_multiplier);
  await stop();
  state=await start();
  check('environment root restores its own last size',Math.abs(state.size_multiplier-2/.75)<1e-9,state.size_multiplier);
  await stop();
  fs.writeFileSync(file(explicitRoot),'{invalid preference');
  state=await start(explicitRoot);
  check('corrupt preference falls back to 100 percent and reports the issue',state.size_multiplier===1 && !!state.settings_error,state.settings_error);
  check('starting does not silently overwrite a corrupt preference',fs.readFileSync(file(explicitRoot),'utf8')==='{invalid preference');
  await stop();
  fs.writeFileSync(file(explicitRoot),JSON.stringify({version:1,size_multiplier:99}));
  state=await start(explicitRoot);
  check('out-of-range saved size cannot create an oversized pet',state.size_multiplier===1 && !!state.settings_error,state.size_multiplier);
} finally {
  await stop();stopAll();
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks},null,2));
}
console.log(`${checks.filter(c=>c.ok).length}/${checks.length} passed`);
if(checks.some(c=>!c.ok))process.exitCode=1;
