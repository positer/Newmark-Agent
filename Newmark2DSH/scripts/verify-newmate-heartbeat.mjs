import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mountCore } from './lib/mount-newmark-core.mjs';
import { inflateSync } from 'node:zlib';
import { createNewMate, NEWMATE_RUN_TOOLS } from '../packages/newmark-core/components/newmate/component.js';
import { createHeartBeat } from '../packages/newmark-core/components/heartbeat/component.js';
import { currentConversation, deliverConversation } from '../packages/newmark-core/lib/conversation-delivery.js';
import { admitImages, bmpToPng, visualToolContent } from '../packages/newmark-core/components/agent-api/lib/visual.js';
import { createAgentApi } from '../packages/newmark-core/components/agent-api/component.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-companion-test-'));
let passed = 0;
const check = (label, value) => { assert.ok(value, label); passed++; console.log(`ok ${passed} - ${label}`); };
const refused = async (label, run) => { await assert.rejects(run); passed++; console.log(`ok ${passed} - ${label}`); };
const selection = {provider:'fixture',model:'vision'};
const saved = [], requests = [];
const view = { attachments:{async saveImages(batch) {saved.push(...batch); return batch.map((b,i)=>({attachmentId:`image-${saved.length+i}`,mediaType:b.mediaType,bytes:b.data.length,width:1,height:1}));}},
 llm:{async listModels(){return [{id:'vision',provider:'fixture',inputModalities:['text','image']}];},stream(request){requests.push(request);return (async function*(){yield {type:'block-end',index:0,block:{type:'text',text:'Hello'}};yield {type:'finish',reason:{kind:'stop'}};})();}},
 core:{model:()=>selection}, tools:{schemas:()=>[{name:'memory_lab_query',parameters:{type:'object'}}],execute:async()=>({isError:false,value:{ok:true}})} };
const bmp=Buffer.alloc(58); bmp.write('BM');bmp.writeUInt32LE(58,2);bmp.writeUInt32LE(54,10);bmp.writeUInt32LE(40,14);bmp.writeInt32LE(1,18);bmp.writeInt32LE(1,22);bmp.writeUInt16LE(1,26);bmp.writeUInt16LE(24,28);bmp[54]=7;bmp[55]=19;bmp[56]=200;
const png=bmpToPng(bmp);
check('hidden BMP becomes actual PNG',png.subarray(0,8).toString('hex')==='89504e470d0a1a0a');
let offset=8, pixels;while(offset<png.length){const size=png.readUInt32BE(offset);if(png.toString('ascii',offset+4,offset+8)==='IDAT')pixels=inflateSync(png.subarray(offset+8,offset+8+size));offset+=size+12;}
check('BMP BGR and row encoding preserve pixels',pixels.toString('hex')==='00c81307');
await refused('malformed BMP rejected',async()=>bmpToPng(Buffer.from('BM')));
const image={data:png.toString('base64'),mediaType:'image/png'};
check('uploads become host attachment ImageBlocks',(await admitImages([image],view,selection))[0].attachment.attachmentId);
await refused('malformed base64 rejected',()=>admitImages([{...image,data:'!!!'}],view,selection));
await refused('too many images rejected',()=>admitImages(Array(5).fill(image),view,selection));
await refused('text-only model rejected',()=>admitImages([image],{...view,llm:{listModels:async()=>[{id:'vision',inputModalities:['text']}]}},selection));
await refused('absent attachment store rejected',()=>admitImages([image],{...view,attachments:null},selection));
const captureRoot=path.join(os.tmpdir(),'newmark2dsh-computer-use');fs.mkdirSync(captureRoot,{recursive:true});const capture=path.join(captureRoot,path.basename(root)+'.bmp');fs.writeFileSync(capture,bmp);
check('ComputerUse full capture delivers image alongside receipt',(await visualToolContent('screen_capture',{image_path:capture},view,selection)).length===2);
check('sparse measurement never pretends to be full observation',(await visualToolContent('screen_capture',{image_path:capture,must_reacquire_full_observation:true},view,selection)).length===1);
const outside=path.join(root,'outside.png');fs.writeFileSync(outside,png);
await refused('arbitrary path cannot become capture image',()=>visualToolContent('screen_capture',{image_path:outside},view,selection));
fs.utimesSync(capture,new Date(0),new Date(0));await refused('old capture rejected',()=>visualToolContent('screen_capture',{image_path:capture},view,selection));
const api=createAgentApi({root,services:()=>view}); const response=await api.tools().find(t=>t.name==='agent_api_send').execute({prompt:'See this',images:[image],tools:{allow:['memory_lab_query']}});
check('Agent API upload reaches actual model request',response.ok && requests[0].messages.some(m=>m.content.some(b=>b.type==='image'&&b.attachment.attachmentId)));
check('provider transport receives a nonempty run correlation ID',/^newmark-run-/.test(requests[0].sessionId));
check('ordinary Agent API does not receive native companion memory',!JSON.stringify(requests[0]).includes('NewMate 原生记忆背景'));
const actualMate=createNewMate({root:path.join(root,'actual-prefix'),agents:()=>null,tools:{execute:async call=>({isError:false,value:await api.tools().find(t=>t.name===call.name).execute(call.arguments)})}});actualMate.chat('Native memory first');await actualMate.tick();
check('real Agent API model request contains earliest native memory prefix',actualMate.state().tasks[0].status==='completed'&&JSON.stringify(requests[1]).includes('NewMate 原生记忆背景'));actualMate.stop();
const execution={agent:{session:{id:'own-session'}}};
check('conversation identity comes from host',currentConversation(execution)==='own-session');await refused('process without caller cannot create conversation task',async()=>currentConversation({}));
const calls=[];const tools={execute:async call=>{calls.push(call);return {isError:false,value:{ok:true,result:{output:'Remembered preference'}}};}};
const mate=createNewMate({root,tools,agents:()=>null});const task=mate.chat('Hello');check('task is durable before inference',createNewMate({root,tools,agents:()=>null}).state().tasks[0].id===task.id);
await mate.tick();check('companion completes durable task',mate.state().tasks[0].status==='completed');check('companion response persisted',mate.state().messages.at(-1).text==='Remembered preference');
check('native memory is available before inference without a recall tool',calls.length===1 && calls[0].name==='agent_api_send' && Array.isArray(mate.memoryContext().shortMemory));
// The allow list is checked by FAMILY, not by a frozen snapshot: 0.3.25 added compact_context to the
// group and a hardcoded copy of the list turned this gate red for a change that was correct. What
// must stay true is the contract - the required families are offered, nothing outside the group is,
// and an unbound companion run is not offered newmate_task.
const companionAllow=calls[0].arguments.tools.allow;
check('companion inference permits bounded memory, reminder and the two ComputerUse tools',['memory_lab_read','memory_lab_query','shortMemory_recall','newmate_todo_add','computer_use','screen_capture'].every(n=>companionAllow.includes(n))&&companionAllow.every(n=>NEWMATE_RUN_TOOLS.includes(n)));
check('no shell, deletion, recursive Agent API or out-of-group tool in companion tool set',!calls[0].arguments.tools.allow.some(n=>/delete|shell|agent_api/.test(n))&&!calls[0].arguments.tools.allow.includes('run_code'));
await mate.configure({companion:true});
const file=path.join(root,'work.txt');fs.writeFileSync(file,'a');check('file metadata change measured',mate.measure(root,'work.txt').path===file);check('unchanged measurement is silent',mate.measure(root,'work.txt')===undefined);check('traversal filename refused',mate.measure(root,'../work.txt')===undefined);
let quietTime=4000000;const quiet=createNewMate({root:path.join(root,'quiet'),now:()=>quietTime,agents:()=>null,tools:{execute:async call=>({isError:false,value:call.name==='memory_lab_query'?{ok:true,matches:[]}:{ok:true,result:{structured:{notify:false,text:''}}}})}});
await quiet.configure({companion:true});quiet.measure(root,'work.txt');fs.writeFileSync(file,'changed-size');quiet.measure(root,'work.txt');check('file event burst coalesces before spending any judgement',quiet.state().tasks.length===0&&quiet.state().initiative.signals.length===1);quietTime+=21*60000;await quiet.tick();check('nonactionable file change stays silent',quiet.state().messages.length===0&&quiet.state().tasks[0].status==='completed');
const failing=createNewMate({root:path.join(root,'failed'),tools:{execute:async()=>{throw Error('offline');}},agents:()=>null});const retry=failing.chat('retry');await failing.tick();check('failure retained for explicit retry',failing.state().tasks[0].status==='failed');failing.retry(retry.id);check('explicit retry queues existing task',failing.state().tasks[0].status==='pending');
const folder=path.join(root,'restart');fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'job.json'),JSON.stringify({owner:{path:'DSH',created:'old'}}));fs.writeFileSync(path.join(folder,'status.json'),JSON.stringify({state:'ready'}));
let commits=0;const controller={prepare:async()=>({ticket:'ticket'}),restart:async()=>({folder,commit:()=>commits++,cancel(){}})};
const preparedVersions=[];
const options={root,core:()=>({newMate:mate}),agents:()=>null,controller:{...controller,prepare:async v=>{preparedVersions.push(v);return{ticket:'ticket'};}},probe:async()=>({path:'DSH',created:'new'}),version:'0.3.0'};
const beat=createHeartBeat({...options,pid:100});const restartTaskId=beat.schedule('Follow up','own-session',execution).id;const helper=await beat.restart('ticket',true);
check('restart has no effect before response commits',commits===0);helper.commit();helper.commit();check('restart commit is idempotent',commits===1);check('tasks armed before global restart',beat.state().tasks.every(t=>t.status==='armed'));
const delivered=[];let flushes=0;const agent={options:{provider:'fixture-provider',model:'fixture-model'},ctx:{get:()=>({flush:async()=>{flushes++;return true;}})},session:{snapshotEvents:()=>delivered.map(message=>({type:'agent/inbox/spliced',data:{inserted:[message]}}))},followup:async message=>delivered.push(message)};
const resumed=createHeartBeat({...options,pid:200,agents:()=>({get:()=>agent})});await resumed.tick();check('not delivered until helper confirms readiness',delivered.length===0);
const preConsumption=JSON.stringify(beat.state());fs.writeFileSync(path.join(folder,'status.json'),JSON.stringify({state:'running'}));await resumed.tick();check('post-restart task delivered to real conversation',delivered[0].content[0].text==='Follow up');check('source is host runner, not impersonated human',delivered[0].source.kind==='cordis-host-runner');check('update restart task delegated to NewMate',mate.state().tasks.some(t=>t.prompt.includes('更新后')));await resumed.tick();check('repeated heartBeat does not duplicate delivered task',delivered.length===1);
check('successful heartbeat task is physically absent from active queue',beat.state().tasks.length===0&&beat.state().receipts.some(r=>r.id===restartTaskId)&&!JSON.stringify(beat.state().receipts).includes('Follow up'));
for(const boot of [300,400,500])await createHeartBeat({...options,pid:boot,agents:()=>({get:()=>agent})}).tick();check('three additional boots cannot redeliver consumed heartbeat',delivered.length===1);
fs.writeFileSync(path.join(root,'heartBeat','state.json'),preConsumption);await createHeartBeat({...options,pid:600,agents:()=>({get:()=>agent})}).tick();check('crash after durable delivery before consumption cannot append the same task again',delivered.length===1&&beat.state().tasks.length===0);
await deliverConversation({get:()=>agent},'own-session',{id:restartTaskId,prompt:'Follow up'});check('stable task message identity deduplicates retries',delivered.length===1);
check('conversation delivery crosses host durability barrier',flushes===3);
await refused('missing durability listener cannot report delivery',()=>deliverConversation({get:()=>({...agent,ctx:null})},'own-session',{id:restartTaskId,prompt:'Follow up'}));
// A restart performed OUTSIDE this component (manual relaunch / operator script) never runs the
// barrier's commit, so registered continuations stayed status:"waiting" forever and the user was told
// "已重启" while nothing continued — the measured 2026-10-26 complaint. The next boot adopts them.
// The barrier's auto registration and the update route both queue the SAME continuation for the same
// session. Measured 2026-10-26: two identical continuation messages woke one conversation twice.
const duplicateRoot=path.join(root,'duplicate-continuation');
const duplicateBeat=createHeartBeat({root:duplicateRoot,core:()=>({newMate:mate}),agents:()=>null,controller:{prepare:async()=>({ticket:'t'}),restart:async()=>({folder,commit(){},cancel(){}})},probe:async()=>({path:'DSH',created:'new'}),version:'0.3.0',pid:400});
const firstContinuation=duplicateBeat.schedule('同一条接续','own-session');
const secondContinuation=duplicateBeat.schedule('同一条接续','own-session');
const otherContinuation=duplicateBeat.schedule('另一条接续','own-session');
check('the same continuation is queued once per session, not once per registration',firstContinuation.id===secondContinuation.id&&duplicateBeat.state().tasks.length===2&&otherContinuation.id!==firstContinuation.id);

// A restart after "install the new package" must prepare the version ON DISK, not the one this
// process was built from; preparing the running version made the controller refuse every time
// (measured 2026-10-26 20:04: "安装版本未通过核验，不执行重启").
const diskVersion=JSON.parse(fs.readFileSync(new URL('../packages/newmark-core/package.json',import.meta.url),'utf8')).version;
const globalPrepared=[];
const globalBeat=createHeartBeat({root:path.join(root,'global-restart'),core:()=>({newMate:mate}),agents:()=>null,controller:{prepare:async v=>{globalPrepared.push(v);return{ticket:'global-ticket'};},restart:async()=>({folder,commit(){},cancel(){}})},probe:async()=>({path:'DSH',created:'new'}),version:'0.3.0',pid:300});
await globalBeat.globalRestart();
check('a restart prepares the installed version, not the version of the running process',globalPrepared.length===1&&globalPrepared[0]===diskVersion&&globalPrepared[0]!=='0.3.0');

const adoptRoot=path.join(root,'adopt');
fs.mkdirSync(path.join(adoptRoot,'heartBeat'),{recursive:true});
fs.writeFileSync(path.join(adoptRoot,'heartBeat','state.json'),JSON.stringify({schema:3,tasks:[{id:'stale-continuation',prompt:'继续刚才的工作',destination:'own-session',status:'waiting',created:Date.now()-120000,creatorPid:999}],receipts:[],terminated:[],intent:null,intents:[]}));
const adoptDelivered=[];
const adoptAgent={options:{provider:'fixture-provider',model:'fixture-model'},ctx:{get:()=>({flush:async()=>true})},session:{snapshotEvents:()=>adoptDelivered.map(message=>({type:'agent/inbox/spliced',data:{inserted:[message]}}))},followup:async message=>adoptDelivered.push(message)};
const adoptController={prepare:async()=>({ticket:'t'}),restart:async()=>({folder:'x',commit(){},cancel(){}})};
const adopted=createHeartBeat({root:adoptRoot,core:()=>({newMate:mate}),agents:()=>({get:()=>adoptAgent}),controller:adoptController,probe:async()=>({path:'DSH',created:'new'}),version:'0.3.0',pid:200});
check('a continuation registered by an earlier process is adopted on boot',adopted.state().tasks.length===1&&adopted.state().tasks[0].status==='armed'&&adopted.state().tasks[0].folder===null);
await adopted.tick();
check('the adopted continuation is delivered exactly once',adoptDelivered.length===1&&adoptDelivered[0].content[0].text==='继续刚才的工作'&&adopted.state().tasks.length===0&&adopted.state().receipts.some(receipt=>receipt.id==='stale-continuation'&&receipt.adopted===true));
const freshRoot=path.join(root,'adopt-fresh');
fs.mkdirSync(path.join(freshRoot,'heartBeat'),{recursive:true});
fs.writeFileSync(path.join(freshRoot,'heartBeat','state.json'),JSON.stringify({schema:3,tasks:[{id:'fresh',prompt:'x',destination:'own-session',status:'waiting',created:Date.now(),creatorPid:200}],receipts:[],terminated:[],intent:null,intents:[]}));
const fresh=createHeartBeat({root:freshRoot,core:()=>({newMate:mate}),agents:()=>({get:()=>adoptAgent}),controller:adoptController,probe:async()=>({path:'DSH',created:'new'}),version:'0.3.0',pid:200});
check('a continuation created by this same process is not stolen by adoption',fresh.state().tasks[0].status==='waiting');
// A wake (newmate_task) hands work back into a DSH conversation, and the host runs a turn there.
// That turn is the user's, so a conversation the user PAUSED must not be woken - the same rule
// heartbeat enforces for restart participants. The task stays pending with a marker instead of
// being delivered or failed, so resuming the goal releases it without a second request.
const woken=[];let paused=true;
const wakeTarget={options:{provider:'fixture-provider',model:'fixture-model'},ctx:{get:()=>({flush:async()=>true})},session:{snapshotEvents:()=>[]},followup:async message=>woken.push(message)};
const wakeMate=createNewMate({root:path.join(root,'wake-pause'),tools:{execute:async()=>({isError:false,value:{ok:true}})},agents:()=>({get:id=>id==='paused-session'?wakeTarget:undefined}),goals:()=>({get:()=>paused?{phase:'paused'}:{phase:'active'}})});
const wokenTask=wakeMate.wake('Hand the work back',{agent:{session:{id:'paused-session'}}}).id;
await wakeMate.tick();
check('a wake does not start a turn in a conversation the user paused',woken.length===0&&wakeMate.state().tasks[0].status==='pending'&&wakeMate.state().tasks[0].deferred==='target_paused');
paused=false;await wakeMate.tick();
check('resuming the goal releases the deferred wake exactly once',woken.length===1&&woken[0].id==='newmark-task:'+wokenTask&&wakeMate.state().tasks[0].status==='completed'&&wakeMate.state().tasks[0].deferred===undefined);
const openMate=createNewMate({root:path.join(root,'wake-open'),tools:{execute:async()=>({isError:false,value:{ok:true}})},agents:()=>({get:()=>wakeTarget})});
openMate.wake('No goal service anywhere',{agent:{session:{id:'paused-session'}}});await openMate.tick();
check('an absent goal service does not block a delivery the user asked for',woken.length===2&&openMate.state().tasks[0].status==='completed');
const legacyRoot=path.join(root,'legacy');fs.mkdirSync(path.join(legacyRoot,'heartBeat'),{recursive:true});fs.writeFileSync(path.join(legacyRoot,'heartBeat','state.json'),JSON.stringify({schema:1,tasks:[{id:'legacy',prompt:'Must not replay',status:'delivered',destination:'own-session'}]}));const legacy=createHeartBeat({...options,root:legacyRoot,pid:700});check('legacy delivered payload is truly retired on migration',legacy.state().tasks.length===0&&legacy.state().receipts[0].id==='legacy'&&!JSON.stringify(legacy.state()).includes('Must not replay'));legacy.stop();
const mounted=await mountCore({packagesDir:fileURLToPath(new URL('../packages/',import.meta.url)),root:path.join(root,'mount')});
check('both independent subcomponents are mounted',mounted.composed.includes('newMate')&&mounted.composed.includes('heartBeat'));
await refused('heartbeat cannot register without trusted caller',async()=>mounted.tools.get('heartbeat_after_restart').execute({prompt:'test',target:'other'}));
const registered=await mounted.tools.get('heartbeat_after_restart').execute({prompt:'test',target:'other'},execution);
const savedTask=JSON.parse(fs.readFileSync(path.join(root,'mount','heartBeat','state.json'))).tasks[0];check('caller-supplied target cannot redirect heartbeat task',savedTask.destination==='own-session');
check('no general scheduling or other-conversation tool exposed',!mounted.tools.has('heartbeat_send')&&!mounted.tools.has('heartbeat_target'));
await mounted.switch('newMate',false);check('NewMate switch disposes tools, global and chat route',!mounted.tools.has('newmate_task')&&!mounted.globals().newMate&&!mounted.routes.some(r=>r.path==='/newmark-newmate'));
check('NewMate switch leaves heartbeat active',mounted.tools.has('heartbeat_after_restart'));
await mounted.switch('newMate',true);check('NewMate can mount again',mounted.tools.has('newmate_task'));
await mounted.switch('heartBeat',false);check('heartBeat switch disposes restart and registration tools',!mounted.tools.has('heartbeat_restart')&&!mounted.tools.has('heartbeat_after_restart'));
check('heartBeat switch leaves companion active',mounted.tools.has('newmate_task'));
await mounted.switch('heartBeat',true);check('restart queue survives independent switch',mounted.provided.get('newmarkComponents').heartBeat.state().tasks[0].id===registered.id);
if(process.env.NEWMARK_HOST_WALKER){const {snapshotJsonValue}=await import(pathToFileURL(process.env.NEWMARK_HOST_WALKER).href);for(const definition of mounted.tools.values()){snapshotJsonValue(definition.parameters);snapshotJsonValue(definition.output?.schema);}snapshotJsonValue(mate.state());snapshotJsonValue(resumed.state());snapshotJsonValue(delivered[0]);snapshotJsonValue(await admitImages([image],view,selection));check('official installed DSH walker accepts tool schemas, tasks, followup and image blocks',true);}
/* --- pre-restart activity probe: 重启前必须先报告「还有谁在跑」 --- */
const ownAgent = { id: 'own-session', status: 'running', session: { id: 'own-session', title: 'here', lastActivityAt: 1 } };
const busyOther = { id: 'other', status: 'running', session: { id: 'other', title: 'other chat', lastActivityAt: 2 } };
const pausedOther = { id: 'paused', status: 'running', session: { id: 'paused', title: 'paused chat' } };
const idleOther = { id: 'idle', status: 'idle', session: { id: 'idle', title: 'idle chat' } };
const probeAgents = () => ({ roots: () => [ownAgent, busyOther, pausedOther, idleOther] });
const probeBeat = createHeartBeat({ ...options, root: path.join(root, 'probe-a'), agents: probeAgents, goals: () => ({ get: agent => (agent.id === 'paused' ? { phase: 'paused' } : null) }) });
const probe = probeBeat.activity(execution);
check('pre-restart probe counts only running, unpaused OTHER conversations', probe.ok === true && probe.count === 1 && probe.running.length === 1 && probe.running[0].sessionId === 'other', JSON.stringify(probe));
check('pre-restart probe reports the requester separately, never as a stranger', Boolean(probe.self) && probe.self.sessionId === 'own-session' && !probe.running.some(entry => entry.sessionId === 'own-session'));
check('pre-restart probe ignores a conversation the user paused', !probe.running.some(entry => entry.sessionId === 'paused'));
const blindBeat = createHeartBeat({ ...options, root: path.join(root, 'probe-b'), agents: () => null });
const blind = blindBeat.activity(execution);
check('probe without the agents service refuses to pretend nobody is running', blind.ok === false && blind.code === 'agents_unavailable');
check('heartbeat exposes a read-only activity tool', mounted.tools.has('heartbeat_activity'));
const probeTool = await mounted.tools.get('heartbeat_activity').execute({}, execution);
check('the activity tool answers with a report, or names why it cannot', Boolean(probeTool) && (Object.prototype.hasOwnProperty.call(probeTool, 'running') || probeTool.code === 'agents_unavailable'), JSON.stringify(probeTool).slice(0, 160));
const firstRestart = await mounted.tools.get('heartbeat_restart').execute({ reason: 'gate: probe first' }, execution);
check('a restart request without force does NOT restart, it reports activity first', firstRestart.ok === false && firstRestart.restarted === false && (firstRestart.code === 'confirmation_required' || firstRestart.code === 'activity_unavailable'), JSON.stringify(firstRestart).slice(0, 240));
const bothSteps = Array.isArray(firstRestart.next) && firstRestart.next.length === 2 && firstRestart.next.some(step => step.arguments && step.arguments.force === true) && firstRestart.next.some(step => step.arguments && step.arguments.broadcast === true);
check('the refusal names both next steps so the Agent can decide', firstRestart.code === 'activity_unavailable' ? /force/.test(String(firstRestart.guidance)) : bothSteps, JSON.stringify({ code: firstRestart.code, next: firstRestart.next, guidance: firstRestart.guidance }).slice(0, 240));
const heartbeatIndex = fs.readFileSync(new URL('../packages/newmark-core/components/heartbeat/index.js', import.meta.url), 'utf8');
check('the force path is explicit in the tool, not implied', heartbeatIndex.includes('a.force !== true') && heartbeatIndex.includes('forced: true'));
check('the restart tool description teaches the two-step protocol', /first call does NOT restart/i.test(heartbeatIndex));

await mounted.dispose();check('component teardown leaves no registrations',mounted.tools.size===0);
console.log(`PASS ${passed} companion, restart and visual assertions. Isolated fixtures: ${root}`);
