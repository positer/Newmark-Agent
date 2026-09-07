const fs=require('fs'),path=require('path'),os=require('os');
const {Agent}=require('../dist/core/agent');const {ConversationKernel}=require('../dist/core/conversationKernel');
(async()=>{
 const source=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.Newmark','config.json'),'utf8'));
 const all=source.models.providers.value||source.models.providers;
 const wanted=process.env.NEWMARK_LIVE_DEEPSEEK_ONLY==='1' ? [['DeepSeek','deepseek-v4-pro']] : [['DeepSeek','deepseek-v4-pro'],['APInebula','gpt-5.6-terra']];let failures=0;
 for(const [label,name] of wanted){
  const p=all.find(p=>p.name.toLowerCase()===label.toLowerCase());const m=p?.models.find(m=>m.name===name);
  if(!p||!m){console.log(JSON.stringify({provider:label,result:'configured deployment not found'}));failures++;continue;}
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'newmark-live-pc-'));
  const choice=`deployment:${encodeURIComponent(p.id)}:${encodeURIComponent(name)}`;
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({models:{providers:[{...p,models:[{...m,validation:{level:'standard',status:'unavailable',capabilities:{}}}]}],default_model:choice,auto_switch:false,fallback_on_unavailable:false},general:{language:'en'},proxy:source.proxy}));
  let agent;
  try{
   agent=new Agent(root,{agentOnly:true});
   const originalModelProvider=agent.modelProvider.bind(agent);
   agent.modelProvider=(...args)=>{const provider=originalModelProvider(...args);const originalChat=provider.chat.bind(provider);provider.chat=async(...params)=>{try{return await originalChat(...params);}catch(error){console.log(JSON.stringify({provider:label,stage:'chat',error:String(error.message||error).split(p.api_key).join('[REDACTED]').slice(0,700)}));throw error;}};return provider;};
   const ws=agent.createInternalWorkspace('synthetic-pc-check');const kernel=new ConversationKernel(root,agent,null,{createRunner:()=>agent});
   const started=Date.now();const result=await kernel.prompt('Reply exactly NEWMARK_PC_OK. Do not use tools.',{workspaceId:ws.id,conversationId:agent.activeConversationId},{model:choice,mode:'build',intelligence:'low',inputMode:'guide',engine:'builtin'},'steer');
   const ok=result.tokens.some(t=>t.type==='text'&&t.text?.includes('NEWMARK_PC_OK'));
   console.log(JSON.stringify({provider:label,model:name,success:ok,durationMs:Date.now()-started,selectionPreserved:result.model===choice,textHealth:agent.activeModelConfig()?.response_health?.text?.ok}));if(!ok)failures++;
  }catch(error){const msg=String(error.message||error).split(p.api_key).join('[REDACTED]').slice(0,600);console.log(JSON.stringify({provider:label,model:name,success:false,error:msg}));failures++;}
  finally{agent?.abortActiveKernelRun('synthetic test complete');}
 }
 process.exit(failures?1:0);
})().catch(e=>{console.error(String(e.message));process.exit(1);});
