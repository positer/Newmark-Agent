import fs from 'node:fs';import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../packages/newmark-core/client.js',import.meta.url),'utf8');
const line=source.split('\n').find(l=>l.trimStart().startsWith('const matePreviewDocument=')),documentBuilder=new Function('return '+line.trim().slice('const matePreviewDocument='.length,-1))();
const h=(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity).filter(Boolean)});
function all(node){return[node,...(node.children||[]).flatMap(c=>typeof c==='object'?all(c):[])];}
let checks=0;const check=(name,value)=>{assert(value,name);console.log(`ok ${++checks} - ${name}`);};
const html='<button onclick="this.textContent=\'clicked\'">test</button>',ownedWindow={},messages={},copies=[];
function inline({expanded=false,code=false}={}){let state=0;const refs=[],updates=[],React={useState:()=>{const i=state++;return[[340,expanded,code][i],v=>updates.push({index:i,value:v})];},useRef:v=>{const ref={current:v===null?{contentWindow:ownedWindow}:v};refs.push(ref);return ref;},useEffect:fn=>fn()};
 const window={addEventListener:(k,fn)=>messages[k]=fn,removeEventListener:()=>{}};
 const start=source.indexOf('          function NewMateInteractive('),end=source.indexOf('          function NewMateReply(',start);
 const render=new Function('React','h','window','navigator','matePreviewDocument',source.slice(start,end)+'return NewMateInteractive;')(React,h,window,{clipboard:{writeText:v=>copies.push(v)}},documentBuilder);
 const nodes=all(render({html,index:0}));return{nodes,updates,token:refs[1].current};}
let ui=inline(),frame=ui.nodes.find(n=>n.type==='iframe');check('interactive HTML is embedded directly in a reply section',ui.nodes[0].type==='section'&&!!frame&&!ui.nodes.some(n=>n.type==='aside'));
check('inline scripts remain isolated from host and referrer',frame.props.sandbox==='allow-scripts'&&frame.props.referrerPolicy==='no-referrer');
check('resize script closes correctly and sandbox blocks external resources',frame.props.srcDoc.includes('})()</script>')&&!frame.props.srcDoc.includes('<</script>')&&frame.props.srcDoc.includes("connect-src &apos;none&apos;"));
messages.message({source:{},data:{type:'newmate-size',token:ui.token,height:800}});check('another frame cannot resize this reply',ui.updates.length===0);
messages.message({source:ownedWindow,data:{type:'newmate-size',token:ui.token,height:9000}});check('authenticated height changes are bounded',ui.updates.at(-1).value===1200);
ui.nodes.find(n=>n.type==='button'&&n.children[0]==='复制代码').props.onClick();check('copy writes the exact HTML',copies.at(-1)===html);
ui=inline({code:true});check('source view keeps the live iframe mounted',ui.nodes.some(n=>n.type==='pre'&&n.children[0]===html)&&ui.nodes.some(n=>n.type==='iframe'));
ui=inline({expanded:true});check('expand changes only inline frame geometry',ui.nodes.find(n=>n.type==='iframe').props.style.height==='70vh');ui.nodes.find(n=>n.type==='button'&&n.children[0]==='收起').props.onClick();check('collapse resets height instead of retaining expanded measurement',ui.updates.some(v=>v.index===0&&v.value===340));
const panelStart=source.indexOf('          function NewMatePanel()'),panelEnd=source.indexOf('          ctx.effect(()=>{',panelStart);
for(const history of [false,true]){let n=0;const values=[{file:{path:'C:/a.md',data:new Uint8Array(),version:'1'},title:'a',reveal:()=>{}},false,false,{activeThreadId:'current',messages:[],tasks:[],threads:[{id:'current',title:'current'},{id:'past',title:'past',updated:1}],settings:{companion:false}},'','',false,false,false,'',history,history?'past':null];
 const React={Fragment:'fragment',useState:i=>[values[n++]??i,()=>{}],useRef:i=>({current:i}),useEffect:()=>{}};
 const panel=new Function('React','h','window','NEWMATE_CHAT_CSS','NewmarkConfigPanel','NewMateReply','NewMateNativeDocument','NativeDocumentBoundary',source.slice(panelStart,panelEnd)+'return NewMatePanel;')(React,h,{__NEWMARK_NEWMATE_DRAFTS__:{}},'','config','reply','native-document','boundary');
 check((history?'history':'current chat')+' mounts its own native file sidebar',all(panel()).some(x=>x.type==='aside'&&x.props['aria-label']==='NewMate 原生文件预览'));}
const marker='          function NewMateNativeDocument(',bodyStart=source.indexOf(marker),bodyEnd=source.indexOf('          function NewMateInteractive(',bodyStart),component=()=>null,entry={component,locale:'native-markdown'},definition={id:'native',loading:'text-pages'};
const React={useRef:v=>({current:v}),useMemo:fn=>fn(),useEffect:()=>{}},ctx={get:n=>n==='locale'?{bind:()=>key=>key}:undefined};
const doc=new Function('React','h','ctx','nativeDocumentEntry','NativeDocumentBoundary',source.slice(bodyStart,bodyEnd)+'return NewMateNativeDocument;')(React,h,ctx,()=>({definition,entry}),'boundary');
const node=doc({file:{path:'C:\\Folder\\a.md',data:new TextEncoder().encode('a\nb'),version:'1'},reveal:()=>{}}),native=node.children[0];check('actual registered DSH component renders the file',native.type===component);
check('native text contract preserves line content and Windows path grammar',native.props.content.pages[0].lines===2&&native.props.resourceAddress.includes('/C%3A/Folder/a.md')&&!native.props.resourceAddress.includes('%5C'));
check('file integration never selects the DSH main conversation',!source.slice(source.indexOf('function nativeDocumentEntry'),bodyEnd).includes('selectPanel'));
console.log(`PASS ${checks} inline HTML, native document body and sandbox behavior checks`);
