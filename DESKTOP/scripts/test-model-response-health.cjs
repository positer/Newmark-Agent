const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { Agent } = require('../dist/core/agent');
const { observeModelResponses, readModelResponseHealth, recordModelResponseHealth } = require('../dist/core/modelResponseHealth');
(async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-health-'));
 let failure = '', received = [], passed = 0;
 const check = (name, fn) => { fn(); passed++; console.log('PASS ' + name); };
 const server = http.createServer((req,res) => { let raw=''; req.on('data',c=>raw+=c); req.on('end',()=>{
  const body=JSON.parse(raw); received.push(body);
  res.setHeader('Content-Type','application/json');
  if(failure) { res.statusCode=400; res.end(JSON.stringify({error:{message:failure}})); }
  else res.end(JSON.stringify({id:'fixture',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}}));
 }); });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const identity={providerId:'fixture',modelId:'unchecked',endpoint:`http://127.0.0.1:${server.address().port}/v1`,protocol:'openai',credential:'fixture-secret'};
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({models:{providers:[{id:'fixture',name:'Fixture',protocol:'openai',base_url:identity.endpoint,api_key:identity.credential,enabled:true,models:[{name:'unchecked',enabled:true,vision:false,max_tokens:128000,validation:{level:'standard',status:'unavailable',capabilities:{text:false,vision:false,tools:false}}}]}],default_model:'deployment:fixture:unchecked',auto_switch:false,fallback_on_unavailable:false}}));
  const agent=new Agent(root,{agentOnly:true});
  check('abnormal model remains callable',()=>assert.equal(agent.modelIsUnavailable(agent.model),false));
  check('tools remain exposed despite failed probes',()=>assert.equal(agent.shouldExposeToolInterface(),true));
  const provider=agent.modelProvider(agent.activeModelConfig());
  const text=[{role:'user',content:'synthetic health test'}];
  const images=[{role:'user',content:[{type:'text',text:'synthetic image test'},{type:'image_url',image_url:{url:'data:image/png;base64,iVBORw0KGgo='}}]}];
  failure='image input is not supported';
  await assert.rejects(()=>provider.chat('unchecked',images,null,0,8));
  check('image is actually transmitted despite vision=false',()=>assert.ok(JSON.stringify(received.at(-1)).includes('data:image/png')));
  check('vision error only marks vision',()=>{const h=readModelResponseHealth(root,identity);assert.equal(h.vision.ok,false);assert.equal(h.text,undefined);});
  failure='';
  await provider.chat('unchecked',text,null,0,8);
  check('text success preserves abnormal vision',()=>{const h=readModelResponseHealth(root,identity);assert.equal(h.text.ok,true);assert.equal(h.vision.ok,false);});
  await provider.chat('unchecked',images,null,0,8);
  check('successful image retry immediately heals vision',()=>assert.equal(readModelResponseHealth(root,identity).vision.ok,true));
  failure='tools are not supported';
  await assert.rejects(()=>provider.chat('unchecked',text,null,0,8));
  check('tool rejection only marks tools',()=>{const h=readModelResponseHealth(root,identity);assert.equal(h.tools.ok,false);assert.equal(h.text.ok,true);});
  failure='';
  const fake={chat:async()=> 'OK', async *chatStreamWithTools(){yield {type:'text',text:'[LLM Error] is merely quoted text'};}};
  observeModelResponses(fake,u=>recordModelResponseHealth(root,identity,u));
  for await(const t of fake.chatStreamWithTools('unchecked',text,null,0,8,[{type:'function'}])){}
  check('valid tool-enabled response heals tools; quoted errors are not failures',()=>assert.equal(readModelResponseHealth(root,identity).tools.ok,true));
  for(let i=0;i<20;i++){recordModelResponseHealth(root,identity,{text:false});recordModelResponseHealth(root,identity,{text:true});assert.equal(readModelResponseHealth(root,identity).text.ok,true);}
  check('same-millisecond success wins over previous failure',()=>assert.equal(readModelResponseHealth(root,identity).text.ok,true));
  const workerPath=require.resolve('../dist/core/modelResponseHealth');delete require.cache[workerPath];const otherWorker=require(workerPath);
  otherWorker.recordModelResponseHealth(root,identity,{text:false});
  check('another worker invalidates the reader cache immediately',()=>assert.equal(readModelResponseHealth(root,identity).text.ok,false));
  recordModelResponseHealth(root,identity,{text:true});
  const edited=agent.config.providers();edited[0].models[0].enabled=false;agent.updateProviders(edited);
  recordModelResponseHealth(root,identity,{text:true,vision:true,tools:true});
  check('successful health does not re-enable a user-disabled model',()=>{assert.equal(agent.activeModelConfig().enabled,false);assert.equal(agent.allModelNames().length,0);});
  check('provider and credential isolation',()=>{assert.deepEqual(readModelResponseHealth(root,{...identity,providerId:'other'}),{});assert.deepEqual(readModelResponseHealth(root,{...identity,credential:'rotated'}),{});});
  const cold=new Agent(root,{agentOnly:true});
  check('cold config reads persisted facet state',()=>assert.equal(cold.activeModelConfig().response_health.vision.ok,true));
  const canceled=new AbortController();canceled.abort();
  const cancelFake={chat:async()=>{throw Object.assign(new Error('cancel'),{name:'AbortError'});},async *chatStreamWithTools(){}};
  observeModelResponses(cancelFake,()=>{throw new Error('must not mark canceled request');});
  await assert.rejects(()=>cancelFake.chat('unchecked',text,null,0,8,canceled.signal));
  check('receipt files contain no credentials or payloads',()=>{const dir=path.join(root,'Runtime','model-response-health');const content=fs.readdirSync(dir,{recursive:true}).filter(n=>n.endsWith('.json')).map(n=>fs.readFileSync(path.join(dir,n),'utf8')).join('');assert.ok(!content.includes(identity.credential));assert.ok(!content.includes('data:image'));});
  console.log(JSON.stringify({passed,requests:received.length}));
 } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
 process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
