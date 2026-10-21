import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
import {createLlmStreamFn,collectAssistant,toRequestMessage} from '../packages/newmark-core/components/agent-api/lib/llm-seam.js';
import {verifyModelAvailable} from '../packages/newmark-core/components/agent-api/lib/core-model.js';
import {requireVision} from '../packages/newmark-core/components/agent-api/lib/visual.js';
const require=createRequire(process.env.DSH_TEST_PROFILE||'C:/Users/12252/.dsh/profiles/desktop/package.json');
const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const {LlmRuntime,LlmAdapter,BlockAssembler}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
let count=0;const check=(name,value)=>{assert.ok(value,name);console.log(`ok ${++count} - ${name}`);};
const ctx=new Context(),llm=new LlmRuntime(ctx),calls=[];
class PluginFixture extends LlmAdapter {
 constructor(route){super();this.route=route;this.preparations=0;}
 listModels(){return Promise.resolve([]);}
 resolveModel(provider,model){return Promise.resolve({provider,id:model,name:model,inputModalities:['text','image'],defaultMaxTokens:4096,reasoning:{efforts:[{id:'high',name:'High'}],defaultEffort:'high'}});}
 async prepareCall(provider,model,signal){this.preparations++;return super.prepareCall(provider,model,signal);}
 async *stream(request){calls.push(request);const index=calls.filter(c=>c.provider===this.route).length;if(index===1){yield{type:'block-end',index:0,block:{type:'tool-call',id:'call-'+this.route,name:'read_fixture',arguments:'{"value":"quoted 中文"}'}};yield{type:'finish',reason:{kind:'tool-calls'},replayState:{opaque:{signature:'fixture-signature',continuation:'fixture-id'},provider:this.route}};}else{yield{type:'text-delta',index:0,text:'完成'};yield{type:'finish',reason:{kind:'stop'},replayState:{opaque:{next:true}}};}}
}
const a=new PluginFixture('route-a'),b=new PluginFixture('route-b');const disposeA=llm.registerAdapter(['route-a'],a),disposeB=llm.registerAdapter(['route-b'],b);
const selection={ok:true,provider:'route-a',model:'same-name'};
check('exact DSH resolver accepts an authorised model absent from advisory catalog',(await verifyModelAvailable(llm,selection)).verified===true);
await requireVision({llm,attachments:{saveImages(){}}},selection);check('vision reads exact plugin-owned modalities rather than guessing from model name',true);
const stream=createLlmStreamFn(llm,selection,{BlockAssembler,retry:{maxAttempts:1}});
const first=[...await (async()=>{const result=[];for await(const e of await stream(selection,{messages:[{role:'user',content:[{type:'text',text:'检查'}]}],tools:[{name:'read_fixture',description:'test',parameters:{type:'object'}}]}))result.push(e);return result;})()];
const assistant=first.at(-1).message;
check('DSH prepared resolver applies adapter-owned defaults',calls[0].reasoningEffort==='high'&&calls[0].maxTokens===4096);
check('native conversation parser retains opaque adapter replay state',assistant.replayState.opaque.signature==='fixture-signature');
check('tool arguments stay JSON text in provider history',typeof assistant.content[0].arguments==='string');
const request=toRequestMessage(assistant,selection);check('opaque replay survives the exact provider/model pair',request.source.replayState===assistant.replayState);
check('same-name model in another provider never receives opaque replay',toRequestMessage(assistant,{provider:'route-b',model:'same-name'}).source.replayState===undefined);
const second=[];for await(const e of await stream(selection,{messages:[{role:'user',content:[{type:'text',text:'检查'}]},assistant,{role:'toolResult',toolCallId:assistant.content[0].id,content:[{type:'text',text:'工具结果'}]}]}))second.push(e);
check('native parser handles delta-only text without requiring block-end',second.at(-1).message.content[0].text==='完成');
check('continuation preserves signed history and call-result pairing',calls[1].messages[1].source.replayState.opaque.signature==='fixture-signature'&&calls[1].messages[2].toolCallId===assistant.content[0].id);
check('each turn receives a new single-use prepared call',a.preparations===2&&b.preparations===0);
const native=await collectAssistant((async function*(){yield{type:'reasoning-delta',index:0,text:'思考'};yield{type:'text-delta',index:1,text:'回答'};yield{type:'finish',reason:{kind:'stop'},replayState:{providerState:'opaque'}}})(),selection,undefined,{BlockAssembler});
check('DSH parser preserves mixed reasoning/text order',native.content[0].type==='reasoning'&&native.content[1].text==='回答');
const refused=createLlmStreamFn({stream(){throw Error('must not dispatch')},prepareCall:async()=>({config:{provider:'route-b',model:'same-name'},stream(){throw Error('must not dispatch')}})},selection,{retry:{maxAttempts:1}});const errors=[];for await(const e of await refused(selection,{messages:[]}))errors.push(e);check('resolver cannot redirect to a same-name foreign route',errors.at(-1).error.failureCode==='INVALID_PREPARED_CALL');
disposeA();disposeB();console.log(`PASS ${count} actual DSH resolver/parser checks; in-memory adapter fixtures only, no credentials or provider HTTP calls`);
