import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const client = path.resolve(process.argv[2] || 'Newmark2DSH/packages/newmark-core/client.js');
let passed = 0;
for (const available of [true, false]) {
  let module, panel, current;
  const effects = [], requests = [];
  globalThis.window = { __ModuleLoader__: { load(value) { module = value; } }, location: { pathname: '/' } };
  const fresh = { ok:true, root:'fixture', index:{components:[],tags:{}}, contents:{}, relationshipVersion:'fresh-host' };
  globalThis.fetch = async url => {
    requests.push(String(url));
    return {ok:available, status:available?200:503, json:async()=>fresh, text:async()=>''};
  };
  const React = {
    createElement:(type, props, ...children)=>({type,props,children}), Fragment:'fragment',
    useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],
    useRef:initial=>({current:initial}), useMemo:fn=>fn(),
    useEffect:fn=>effects.push(fn),
    useSyncExternalStore:(_subscribe,get)=>{current=get();return current;},
  };
  await import(pathToFileURL(client).href+'?first-open='+available+'-'+Date.now());
  module.factory(name=>{if(name==='react')return React;throw Error('optional module unavailable');}).apply({
    effect:fn=>fn(),
    slots:{inject:(_name,fn)=>fn(),register:(options,Component)=>{if(options.key==='memory-lab')panel=Component;return{};}}
  });
  assert.equal(typeof panel,'function'); passed++;
  panel(); for(const fn of effects.splice(0))fn();
  await new Promise(resolve=>setTimeout(resolve,20)); panel();
  assert.equal(requests[0],'/newmark-memorylab/snapshot'); passed++;
  assert.ok(requests.every(url=>!url.includes('reindex=1'))); passed++;
  if(available){
    assert.equal(current.phase,'ready');
    assert.equal(current.relationshipVersion,'fresh-host');
    assert.equal(window.__NEWMARK_MEMORYLAB__,fresh);
    passed+=3;
  }else{
    assert.equal(current.phase,'error');
    assert.ok(current.error); passed+=2;
  }
}
console.log(`MemoryLab first-open: ${passed}/${passed} passed (missing page globals, current host read, no rebuild, failure preserved).`);
