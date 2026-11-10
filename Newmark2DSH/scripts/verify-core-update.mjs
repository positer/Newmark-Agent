import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { latestCore } from '../packages/newmark-core/lib/core-update.js';
// The page polls a route with an interval; a gate has no clock to spare and nothing to poll.
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
globalThis.setTimeout = globalThis.setTimeout;
/** Every string a rendered tree carries, in document order — how a gate reads what the page says. */
const textOf = node => Array.isArray(node)
  ? node.map(textOf).join(' ')
  : node && typeof node === 'object'
    ? textOf(node.children || [])
    : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
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
  const messages=[], states=[], refs=[], posts=[]; let stateIndex=0, refIndex=0;
  globalThis.window={__ModuleLoader__:{load:value=>{spec=value;}},location:{pathname:'/'}};
  /**
   * The page's two channels, stubbed. The components read is answered with the shape the Host
   * actually sends — including the auto-update block the 版本管理 switch renders — because a page
   * whose switch reads "unknown" here could not be tested for its write at all.
   */
  /** A response the page can read BOTH ways it reads one: `.text()` and `.json()`. */
  const reply=(ok,status,body)=>({ok,status,text:async()=>body,json:async()=>JSON.parse(body)});
  const componentsBody=JSON.stringify({ok:true,components:[{name:'memoryLab',mounted:true},{name:'computerUse',mounted:true},{name:'agentApi',mounted:true},{name:'newMate',mounted:true},{name:'heartBeat',mounted:true}],compose:true,model:{ok:false,error:'catalog_unavailable',models:[],groups:[]},update:{autoUpdate:false,editable:true,state:{outcome:'installed_current',latest:'0.2.34',checkedAt:'2026-11-10T12:00:00.000Z'}}});
  globalThis.fetch=async(_url,options)=>{if(options?.method==='POST'){const input=JSON.parse(options.body);posts.push(input);if(input.action==='restart'){assert.equal(installedVersion,'0.2.34');assert.equal(installCount,1);restartCount++;}const ok=!(scenario==='restart-unavailable'&&input.action==='prepare')&&!(scenario==='restart-failed'&&input.action==='restart');return reply(ok,ok?200:502,JSON.stringify({ok,ticket:'test-ticket',error:ok?undefined:'restart error'}));}if(String(_url).includes('/newmark-core/components'))return reply(true,200,componentsBody);if(scenario==='network')throw Error('offline');return reply(!['missing-route','unauthorized'].includes(scenario),scenario==='missing-route'?404:scenario==='unauthorized'?401:200,scenario==='empty'?'':scenario==='html'?'<html>shell</html>':JSON.stringify(good));};
  const React={createElement:(type,props,...children)=>({type,props:props||{},children}),Fragment:'fragment',useState:value=>{const i=stateIndex++;if(!(i in states))states[i]=typeof value==='function'?value():value;return[states[i],v=>{states[i]=v;messages.push(v);}];},useRef:value=>{const i=refIndex++;return refs[i] ||= {current:value};},useMemo:fn=>fn(),useEffect:effect=>{try{return effect();}catch{return undefined;}},useSyncExternalStore:(_s,get)=>get()};
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
  /* The page, rendered the way the shell renders it: function components are CALLED, not left as
   * unexpanded elements. The previous version of this gate walked raw children, which stopped
   * meaning anything in 0.3.68 when the panel became one `ConfigSurface` selected from a
   * catalogue — the walk found nothing and the assertion that used to hold could no longer be
   * reached at all. A gate that cannot render the page cannot measure the card on it. */
  function expand(element, out = [], depth = 0) {
    if (element === null || element === undefined || element === false || element === true) return out;
    if (Array.isArray(element)) { for (const child of element) expand(child, out, depth); return out; }
    if (typeof element === 'string' || typeof element === 'number') return out;
    if (typeof element.type === 'function') {
      if (depth > 40) return out;
      // React hands a component its children on `props.children`; this stub keeps them beside the
      // props, so they are put back where the component expects them. Without this the sections
      // render but their contents do not, and every assertion about a card would be vacuous.
      // One child is passed AS the child (that is what React does with `props.children`), so a
      // component that forwards `children` forwards a string rather than an array holding it.
      const own = element.children || [];
      const children = own.length <= 1 ? own[0] : own;
      expand(element.type({ ...(element.props || {}), children }), out, depth + 1);
      return out;
    }
    // This stub keeps an element's children in `children`; a caller may also have built one with
    // `props.children`. Both are the same thing to a walker, so both are followed.
    const kids = element.children !== undefined ? element.children : element.props.children;
    if (element.type === 'fragment') { expand(kids, out, depth); return out; }
    out.push(element);
    expand(kids, out, depth);
    return out;
  }
  /* The page's reads start on its first render and land on a later tick, exactly as they do in a
   * browser. Asserting after one render would measure the loading state and call it the page. */
  stateIndex=0;refIndex=0;expand(panel());
  await new Promise(resolve=>setTimeout(resolve,15));
  stateIndex=0;refIndex=0;const tree=expand(panel());
  const updateCard=tree.find(n=>n?.props?.['aria-label']==='Newmark Core');
  assert.ok(updateCard);passed++;
  const controlButtons=node=>['button','OfficialButton'].includes(node.type)&&(node.children||[]).includes('检查更新');
  let button=tree.find(controlButtons);
  assert.ok(button);passed++;
  /* -------------------------------------------------------------- the 版本管理 card --- */
  /* The card the user pointed at: the manual check, and the switch beside it. Both live in ONE
   * card because they are the same subject — the bundle's own version — and the switch is what
   * makes the check unnecessary at boot. */
  const autoSwitch=tree.find(n=>n?.type==='button'&&n.props?.['id']==='nmc-auto-update');
  assert.ok(autoSwitch);passed++;
  assert.equal(autoSwitch.props['aria-label'],'启动时自动更新');passed++;
  assert.equal(autoSwitch.props['aria-checked'],false);passed++;
  assert.ok(!autoSwitch.props.disabled);passed++;
  assert.match(textOf(updateCard),/不重启/);passed++;
  assert.match(textOf(updateCard),/重启 DSH 后生效|下次重启/);passed++;
  const running=Promise.all([button.props.onClick(),button.props.onClick()]);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(installCount,0);passed++;
  await new Promise(resolve=>setTimeout(resolve,15));
  stateIndex=0;refIndex=0;const rendered=expand(panel());
  /* The switch writes through the same route the model selector uses, as one boolean. */
  const postsBeforeSwitch=posts.length;
  autoSwitch.props.onClick();
  await new Promise(resolve=>setTimeout(resolve,15));
  const switchWrite=posts.slice(postsBeforeSwitch).find(post=>post&&post.component==='update');
  assert.ok(switchWrite);passed++;
  assert.equal(switchWrite.autoUpdate,true);passed++;
  assert.equal(installCount,0);passed++;
  stateIndex=0;refIndex=0;const afterSwitchText=textOf(expand(panel()));
  assert.ok(afterSwitchText.includes('上次启动检查'));passed++;
  const modal=rendered.find(n=>n?.type==='OfficialModal');
  if(modal){
    assert.equal(modal.props.open,true);passed++;
    if(scenario==='dismiss')modal.props.onClose();
    else modal.props.footer.children[scenario==='cancel'?0:1].props.onClick();
  }
  await running;
  assert.equal(installCount,['restart-unavailable','cancel','dismiss','missing-modal','current','missing-manager','network','empty','html','missing-route','unauthorized','newer-installed'].includes(scenario)?0:1);passed++;
  assert.equal(restartCount,['success','restart-failed'].includes(scenario)?1:0);passed++;
  /* What the CARD says, read from the page the user would be looking at. Reading the raw state
   * setters instead would also collect every other card's state — the companion surface writes
   * its own error into the same array — so the assertion is made on the rendered 版本管理 card. */
  stateIndex=0;refIndex=0;
  const finalText=textOf(expand(panel()).find(n=>n?.props?.['aria-label']==='Newmark Core'));
  if(scenario==='success')assert.match(finalText,/已安装 0.2.34.*重启/);
  else if(scenario==='cancel'||scenario==='dismiss')assert.match(finalText,/已取消/);
  else if(scenario==='current')assert.match(finalText,/已安装最新版本/);
  else if(scenario==='newer-installed')assert.match(finalText,/未执行降级/);
  else assert.match(finalText,/更新失败|更新未确认/);
  passed++;
}
for (const text of ['', '<html>gateway</html>']) { await assert.rejects(latestCore(async()=>({ok:true,text:async()=>text})), /空响应|非 JSON/); passed++; }
console.log(`Core update: ${passed}/${passed} passed; official latest validation, exact tarball, one install per click, no fallback, failure and restart states.`);
