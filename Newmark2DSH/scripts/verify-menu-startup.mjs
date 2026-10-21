import assert from 'node:assert/strict';
import { startDshMenuThemeBridge } from '../packages/newmark-core/components/computeruse/lib/desktop-menu-client.js';

const posts=[];let interval, disconnected=false;
const originalInterval=globalThis.setInterval,originalClear=globalThis.clearInterval;
globalThis.setInterval=fn=>{interval=fn;return 1;};globalThis.clearInterval=()=>{};
const menu={cloneNode:()=>({setAttribute(){},removeAttribute(){},querySelector:()=>true,querySelectorAll:()=>[],attributes:[],outerHTML:'<div role="menu"><button data-newmate-action="stop-companion">退出伴随</button><button data-newmate-action="settings">打开设置</button></div>'})};
const sheet={cssRules:[{type:1,cssText:'.dsh-menu{color:white}'}]};
const element=()=>({attributes:[],append(){},style:{},setAttribute(){},remove(){},querySelector:()=>menu});
globalThis.document={head:element(),body:element(),documentElement:element(),createElement:element,styleSheets:[sheet],adoptedStyleSheets:[],baseURI:'http://localhost/',addEventListener(){},removeEventListener(){}};
globalThis.location={origin:'http://localhost'};
globalThis.getComputedStyle=()=>Object.assign([],{getPropertyValue:()=>''});
globalThis.MutationObserver=class{observe(){}disconnect(){disconnected=true;}};
globalThis.fetch=async(_url,opts)=>{posts.push(JSON.parse(opts.body));return{ok:true};};
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setTimeout(r,1));};
try {
  const stop=startDshMenuThemeBridge({React:{createElement(){}},createRoot:()=>({render(){},unmount(){}}),Menu(){},renderSlider(){},sliderCss:'',connection:{path:'/theme',token:'test'}});
  await settle();assert.equal(posts.length,1);assert.match(posts[0].css,/color:white/);
  await interval();assert.equal(posts.length,1);
  sheet.cssRules[0].cssText='.dsh-menu{color:black}';
  await interval();assert.equal(posts.length,2);assert.match(posts[1].css,/color:black/);
  sheet.disabled=true;
  await interval();assert.equal(posts[2].css,'');
  sheet.disabled=false;
  document.adoptedStyleSheets.push({cssRules:[{type:1,cssText:'.dsh-menu{font-size:22px}'}]});
  await interval();assert.match(posts[3].css,/color:black[\s\S]*font-size:22px/);
  stop();await interval();assert.equal(posts.length,4);assert.equal(disconnected,true);
  console.log('Menu startup: 9/9 passed; unchanged CSS deduplication, CSSOM override, disabled sheets, adopted sheet order, disposal.');
} finally { globalThis.setInterval=originalInterval;globalThis.clearInterval=originalClear; }
