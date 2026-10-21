import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { latestCore } from '../packages/newmark-core/lib/core-update.js';
let passed = 0;
const info = {name:'newmark2dsh','dist-tags':{latest:'0.2.34'},versions:{'0.2.34':{name:'newmark2dsh',version:'0.2.34',dist:{tarball:'https://registry.npmjs.org/newmark2dsh/-/newmark2dsh-0.2.34.tgz'}}}};
const good = await latestCore(async url=>{assert.ok(url.startsWith('https://registry.npmjs.org/'));return{ok:true,text:async()=>JSON.stringify(url.endsWith('/dist-tags')?info['dist-tags']:info.versions['0.2.34'])};});passed++;
assert.equal(good.latest,'0.2.34');passed++;
for(const metadata of [{...info,'dist-tags':{}},{...info,name:'another'}, {...info,versions:{'0.2.34':{...info.versions['0.2.34'],dist:{tarball:'https://example.com/x.tgz'}}}}]){
  await assert.rejects(latestCore(async url=>({ok:true,text:async()=>JSON.stringify(url.endsWith('/dist-tags')?metadata['dist-tags']:{...metadata.versions?.['0.2.34'],name:metadata.name})})));passed++;
}
let calls=0;await assert.rejects(latestCore(async()=>{calls++;return{ok:false,status:503};}));assert.equal(calls,1);passed++;
for(const scenario of ['success','restart-unavailable','restart-failed','cancel','dismiss','missing-modal','unavailable','install-failed','mismatch','current','missing-manager','network','empty','html','missing-route','unauthorized','newer-installed']){
  let spec, panel, installedVersion=scenario==='current'?'0.2.34':scenario==='newer-installed'?'0.2.35':'0.2.33', installCount=0, restartCount=0;
  const messages=[], states=[], refs=[]; let stateIndex=0, refIndex=0;
  globalThis.window={__ModuleLoader__:{load:value=>{spec=value;}},location:{pathname:'/'}};
  globalThis.fetch=async(_url,options)=>{if(options?.method==='POST'){const input=JSON.parse(options.body);if(input.action==='restart'){assert.equal(installedVersion,'0.2.34');assert.equal(installCount,1);restartCount++;}const ok=!(scenario==='restart-unavailable'&&input.action==='prepare')&&!(scenario==='restart-failed'&&input.action==='restart');return{ok,status:ok?200:502,text:async()=>JSON.stringify({ok,ticket:'test-ticket',error:ok?undefined:'restart error'})};}if(scenario==='network')throw Error('offline');return{ok:!['missing-route','unauthorized'].includes(scenario),status:scenario==='missing-route'?404:scenario==='unauthorized'?401:200,text:async()=>scenario==='empty'?'':scenario==='html'?'<html>shell</html>':JSON.stringify(good)};};
  const React={createElement:(type,props,...children)=>({type,props:props||{},children}),Fragment:'fragment',useState:value=>{const i=stateIndex++;if(!(i in states))states[i]=typeof value==='function'?value():value;return[states[i],v=>{states[i]=v;messages.push(v);}];},useRef:value=>{const i=refIndex++;return refs[i] ||= {current:value};},useMemo:fn=>fn(),useEffect:()=>{},useSyncExternalStore:(_s,get)=>get()};
  const manager={
    listBundles:async()=>({ok:true,value:[{name:'newmark2dsh',version:installedVersion}]}),
    installBundle:async(url,options)=>{
      installCount++;assert.equal(url,good.tarball);assert.equal(options.registry,good.registry);assert.equal(options.enabled,true);
      await new Promise(resolve=>setTimeout(resolve,5));
      if(scenario==='unavailable')return{ok:false,error:{message:'disconnected'}};
      if(scenario==='install-failed')return{ok:true,value:{application:'failed'}};
      if(scenario!=='mismatch')installedVersion='0.2.34';
      return{ok:true,value:{application:'restart-required'}};
    },
  };
  await import(pathToFileURL(path.resolve('Newmark2DSH/packages/newmark-core/client.js')).href+'?update-test='+scenario);
  spec.factory(name=>{if(name==='react')return React;if(name==='@deepseek-ai/dsh-client-ui-primitives'&&scenario!=='missing-modal')return{Modal:'OfficialModal',Button:'OfficialButton'};throw Error('optional');}).apply({
    plugin:child=>{if(scenario!=='missing-manager')child.apply({remote:{pluginManager:manager},effect:fn=>fn()});},
    effect:fn=>fn(),slots:{inject:(_key,fn)=>fn(),register:(opts,C)=>{if(opts.key==='newmark2dsh')panel=C;return{};}}
  });
  const tree=panel();const config=tree.children.flat().find(n=>n?.props?.['aria-label']==='配置');assert.ok(config);assert.equal(config.children.flat().at(-1).props['data-newmark-core-update'],'');passed+=2;let button;function walk(node){if(!node||typeof node!=='object')return;if(node.type==='button'&&node.children.includes('检查更新'))button=node;for(const c of node.children||[])Array.isArray(c)?c.forEach(walk):walk(c);}walk(tree);
  assert.ok(button);passed++;
  const running=Promise.all([button.props.onClick(),button.props.onClick()]);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(installCount,0);passed++;
  stateIndex=0;refIndex=0;const rendered=panel();
  const modal=rendered.children.find(n=>n?.type==='OfficialModal');
  if(modal){
    assert.equal(modal.props.open,true);passed++;
    if(scenario==='dismiss')modal.props.onClose();
    else modal.props.footer.children[scenario==='cancel'?0:1].props.onClick();
  }
  await running;
  assert.equal(installCount,['restart-unavailable','cancel','dismiss','missing-modal','current','missing-manager','network','empty','html','missing-route','unauthorized','newer-installed'].includes(scenario)?0:1);passed++;
  assert.equal(restartCount,['success','restart-failed'].includes(scenario)?1:0);passed++;
  const last=messages.filter(x=>typeof x==='string').at(-1);
  if(scenario==='success')assert.match(last,/已安装 0.2.34.*重启/);
  else if(scenario==='cancel'||scenario==='dismiss')assert.match(last,/已取消/);
  else if(scenario==='current')assert.match(last,/已安装最新版本/);
  else if(scenario==='newer-installed')assert.match(last,/未执行降级/);
  else assert.match(last,/更新失败|更新未确认/);
  passed++;
}
for (const text of ['', '<html>gateway</html>']) { await assert.rejects(latestCore(async()=>({ok:true,text:async()=>text})), /空响应|非 JSON/); passed++; }
console.log(`Core update: ${passed}/${passed} passed; official latest validation, exact tarball, one install per click, no fallback, failure and restart states.`);
