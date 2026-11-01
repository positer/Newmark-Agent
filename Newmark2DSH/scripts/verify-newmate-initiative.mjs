import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createNewMate} from '../packages/newmark-core/components/newmate/component.js';import {createShortMemory} from '../packages/newmark-core/components/memorylab/lib/short-memory.js';
import {MINUTE,HOUR,DAY,isQuiet,initiativeGate} from '../packages/newmark-core/components/newmate/lib/initiative.js';
import {PROACTIVE_STYLE} from '../packages/newmark-core/components/newmate/lib/proactive-message.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'newmate-initiative-'));const start=Date.parse('2026-10-12T01:00:00Z');let checks=0,serial=0;
const check=(name,value)=>{assert.ok(value,name);console.log(`ok ${++checks} - ${name}`);};
function fixture(options={}){let time=options.start??start;const env={ready:true,idleMs:2*MINUTE,...options.env};const calls=[],notices=[];const directory=path.join(root,String(++serial));
 const dependencies={root:directory,now:()=>time,agents:()=>null,environment:()=>env,onNotify:async m=>notices.push(m),tools:{execute:async call=>{calls.push(call);if(options.execute)return options.execute(call,calls.length);return{isError:false,value:{ok:true,result:call.arguments.output_schema?{structured:{notify:true,text:'轻量主动消息 '+calls.length,topic:'topic-'+calls.length}}:{output:'手动回复'}}};}}};
 const mate=createNewMate(dependencies);return{mate,env,calls,notices,root:directory,dependencies,time:()=>time,set:t=>time=t,advance:t=>time+=t,enable:()=>mate.configure({companion:true}),due:async()=>{time+=21*MINUTE;await mate.tick();}};}
const off=fixture();await off.due();check('companion off never schedules autonomous inference',off.calls.length===0);off.mate.stop();
const f=fixture();await f.enable();f.advance(19*MINUTE);await f.mate.tick();check('initial warmup does not immediately greet after install or enable',f.calls.length===0);f.advance(2*MINUTE);await f.mate.tick();
check('without user input, file changes or external tasks the agent activates itself',f.calls.length===1&&f.mate.state().messages[0].proactive);
check('automatic inference is bounded and cannot wake conversations or execute files',f.calls[0].arguments.max_steps===3&&f.calls[0].arguments.timeout_ms===45000&&!f.calls[0].arguments.tools.allow.some(n=>/newmate_task|shell|computer|delete/.test(n))&&!f.calls[0].arguments.tools.allow.includes('screen_capture'));
for(let i=0;i<200;i++)await f.mate.tick();check('fast worker ticks cannot repeat inference or interruption',f.calls.length===1&&f.notices.length===1);
check('unanswered message increases next interval to eight hours',f.mate.state().initiative.nextAttemptAt-f.time()===8*HOUR);
f.set(f.mate.state().initiative.nextAttemptAt);await f.mate.tick();check('a second quiet check-in is possible without requiring user initiation',f.calls.length===2&&f.mate.state().initiative.sent===2);
check('there is no daily message quota any more; only the cooldown (and quiet hours) hold',!['daily_message_budget','daily_reasoning_budget'].includes(f.mate.initiativeStatus().reason)&&f.calls.length===2);
check('ignored autonomous check-ins retain bubbles and never request OS notifications',f.notices[0].system===false&&f.notices[1].system===false&&f.notices[1].autonomous===true);
f.set(f.mate.state().initiative.nextAttemptAt);await f.mate.tick();check('ongoing nonresponse backs off but does not disable the companion forever',f.calls.length===3&&f.mate.state().initiative.nextAttemptAt-f.time()===DAY);
const before=f.mate.state();f.mate.stop();const restart=createNewMate(f.dependencies);f.advance(3*MINUTE);await restart.tick();check('restart keeps budget, unanswered count and cooldown without replay',restart.state().initiative.nextAttemptAt===before.initiative.nextAttemptAt&&f.calls.length===3);restart.stop();
const night=fixture({start:Date.parse('2026-10-12T15:00:00Z')});await night.enable();await night.due();check('23:00 to 08:00 Beijing time spends no inference',night.calls.length===0&&night.mate.initiativeStatus().reason==='quiet_hours');night.set(Date.parse('2026-10-13T00:01:00Z'));await night.mate.tick();check('quiet hours expire without a catch-up burst',night.calls.length===1);night.mate.stop();
for(const [key,value,reason]of [['idleMs',0,'typing'],['idleMs',91*MINUTE,'away'],['readerFocused',true,'reading'],['busy',true,'busy'],['ready',false,'runtime_unavailable']]){const v=fixture({env:{[key]:value}});await v.enable();await v.due();check(reason+' blocks autonomous spend',v.calls.length===0&&v.mate.initiativeStatus().reason===reason);v.env[key]=key==='idleMs'?2*MINUTE:key==='ready'?true:false;v.advance(MINUTE);await v.mate.tick();check(reason+' resumes with one check when the condition clears',v.calls.length===1);v.mate.stop();}
const recent=fixture();await recent.enable();recent.advance(21*MINUTE);recent.mate.chat('我正在聊');await recent.mate.tick();recent.advance(20*MINUTE);await recent.mate.tick();check('user conversation gets a 45-minute quiet window',recent.calls.length===1);recent.advance(26*MINUTE);await recent.mate.tick();check('user conversation clears ignored count and permits later companionship',recent.calls.length===2&&recent.mate.state().initiative.unanswered===1);recent.mate.stop();
const file=fixture();await file.enable();fs.writeFileSync(path.join(file.root,'event.txt'),'private file content must not enter prompt');for(let i=0;i<100;i++){fs.appendFileSync(path.join(file.root,'event.txt'),'x');file.mate.measure(file.root,'event.txt');}
check('file bursts coalesce locally without an immediate model request',file.calls.length===0&&file.mate.state().initiative.signals.length===1);await file.due();check('file signals share the scheduled budget and never inject file contents',file.calls.length===1&&file.mate.state().initiative.lastReason==='file-change'&&!file.calls[0].arguments.prompt.includes('private file content must not enter prompt'));file.mate.stop();
const memory=fixture();await memory.enable();createShortMemory(memory.root,memory.time).add({content:'今天想整理一个轻量计划。'});await memory.due();check('short-memory changes can drive a native proactive check',memory.calls.length===1&&memory.mate.state().initiative.lastReason==='memory-change');memory.mate.stop();
const longMemory=fixture();await longMemory.enable();fs.mkdirSync(path.join(longMemory.root,'Memory Lab'),{recursive:true});fs.writeFileSync(path.join(longMemory.root,'Memory Lab','index.json'),JSON.stringify({tags:{},components:{test:{content:'长期记忆发生变化，标签图不变'}}}));await longMemory.due();check('long-memory content changes trigger metadata measurement even with the same tag graph',longMemory.calls.length===1&&longMemory.mate.state().initiative.lastReason==='memory-change');longMemory.mate.stop();
const silent=fixture({execute:async()=>({isError:false,value:{ok:true,result:{structured:{notify:false,text:''}}}})});await silent.enable();await silent.due();for(let i=0;i<3;i++){silent.advance(4*HOUR);await silent.mate.tick();}check('non-actionable checks stay silent and are bounded by the gap, not by a daily judgement quota',silent.calls.length>=2&&silent.mate.state().messages.length===0&&!['daily_reasoning_budget','daily_message_budget'].includes(silent.mate.initiativeStatus().reason));silent.mate.stop();
const fail=fixture({execute:async()=>{throw Error('offline');}});await fail.enable();await fail.due();for(let i=0;i<100;i++)await fail.mate.tick();check('provider failure consumes a check and never automatically loops',fail.calls.length===1&&fail.mate.state().tasks[0].status==='failed');assert.throws(()=>fail.mate.retry(fail.mate.state().tasks[0].id));check('manual retry cannot bypass automatic reasoning budgets',true);fail.mate.stop();
const duplicate=fixture({execute:async()=>({isError:false,value:{ok:true,result:{structured:{notify:true,text:'同一话题',topic:'same-topic'}}}})});await duplicate.enable();await duplicate.due();duplicate.advance(8*HOUR);await duplicate.mate.tick();check('same text or topic is not repeated within 24 hours',duplicate.mate.state().messages.length===1&&duplicate.mate.state().initiative.lastOutcome==='duplicate_topic');duplicate.advance(16*HOUR);await duplicate.mate.tick();check('topic suppression expires rather than causing permanent absence',duplicate.mate.state().messages.length===2);duplicate.mate.stop();
const paused=fixture();await paused.enable();await paused.mate.configure({snoozeUntil:paused.time()+8*HOUR});await paused.due();check('user snooze suppresses automatic work',paused.calls.length===0);paused.advance(8*HOUR);await paused.mate.tick();check('snooze expiry resumes once without replay',paused.calls.length===1);await paused.mate.configure({initiative:false});paused.advance(DAY);await paused.mate.tick();check('independent initiative switch keeps chat available but stops automatic work',paused.calls.length===1);paused.mate.chat('主动陪伴关闭仍可聊天');await paused.mate.tick();check('manual chat works with initiative disabled',paused.calls.length===2);paused.mate.stop();
let resolve;const late=fixture({execute:()=>new Promise(r=>resolve=r)});await late.enable();late.advance(21*MINUTE);const work=late.mate.tick();await Promise.resolve();late.mate.createThread();resolve({isError:false,value:{ok:true,result:{structured:{notify:true,text:'旧线程结果',topic:'old'}}}});await work;check('late autonomous output cannot write or reactivate a closed history thread',late.mate.state().messages.length===0&&late.mate.state().initiative.lastOutcome==='history_closed');late.mate.stop();
let finish;const focused=fixture({execute:()=>new Promise(r=>finish=r)});await focused.enable();focused.advance(21*MINUTE);const active=focused.mate.tick();await Promise.resolve();focused.mate.presence(true,'reader',1);finish({isError:false,value:{ok:true,result:{structured:{notify:true,text:'不应打断阅读'}}}});await active;check('a user returning during inference prevents a late interruption',focused.mate.state().messages.length===0);focused.mate.stop();
let complete;const crossing=fixture({start:Date.parse('2026-10-12T13:00:00Z'),execute:()=>new Promise(r=>complete=r)});await crossing.enable();crossing.advance(110*MINUTE);const pending=crossing.mate.tick();await Promise.resolve();crossing.advance(11*MINUTE);complete({isError:false,value:{ok:true,result:{structured:{notify:true,text:'夜间不打扰'}}}});await pending;check('quiet hours are rechecked after model completion',crossing.mate.state().messages.length===0);crossing.mate.stop();
const abort=fixture({execute:call=>new Promise((_,reject)=>call.signal.addEventListener('abort',()=>reject(Error('aborted'))))});await abort.enable();abort.advance(21*MINUTE);const inflight=abort.mate.tick();await Promise.resolve();await abort.mate.configure({initiative:false});await inflight;check('disabling initiative aborts only the automatic run',abort.mate.state().tasks[0].status==='paused'&&abort.mate.state().messages.length===0);abort.mate.stop();
const burst=fixture();await burst.enable();await burst.mate.message('一',{id:'one'});await burst.mate.message('二',{id:'two'});await burst.mate.message('三',{id:'three'});check('external agent message bursts preserve inbox contents but emit one interruption',burst.mate.state().messages.length===3&&burst.notices.length===1);burst.advance(31*MINUTE);await burst.mate.message('四',{id:'four'});check('interruption cooldown expires after thirty minutes',burst.notices.length===2);await assert.rejects(burst.mate.configure({pace:'invalid'}));await assert.rejects(burst.mate.configure({quietStart:24}));await assert.rejects(burst.mate.configure({snoozeUntil:burst.time()+8*DAY}));check('invalid preferences cannot bypass limits',true);burst.mate.stop();
check('quiet hour boundary is exclusive at 08:00',!isQuiet({quietStart:23,quietEnd:8},Date.parse('2026-10-13T00:00:00Z')));
const present=fixture({execute:async()=>({isError:false,value:{ok:true,result:{structured:{notify:false,text:''}}}})});await present.enable();present.advance(25*HOUR);await present.mate.tick();check('after a full day without any meaningful message a local greeting avoids permanent absence without model spend',present.calls.length===0&&present.mate.state().messages.length===1&&present.mate.state().initiative.lastReason==='gentle-presence');present.advance(DAY);await present.mate.tick();check('fallback presence cannot repeat every day after the first greeting',present.mate.state().messages.length===1);present.advance(2*DAY);await present.mate.tick();check('long-term silent companionship allows a new local greeting after three days',present.mate.state().messages.length===2&&present.calls.length===1);present.mate.stop();
for(const [key,value]of [['busy',true],['ready',false],['idleMs',91*MINUTE]]){let done;const lateEnv=fixture({execute:()=>new Promise(r=>done=r)});await lateEnv.enable();lateEnv.advance(21*MINUTE);const task=lateEnv.mate.tick();await Promise.resolve();lateEnv.env[key]=value;done({isError:false,value:{ok:true,result:{structured:{notify:true,text:'应当延后'}}}});await task;check('completion rechecks '+key+' before creating a message',lateEnv.mate.state().messages.length===0);lateEnv.mate.stop();}
const read=fixture();await read.enable();await read.due();read.mate.markRead(read.mate.state().activeThreadId,true,'read',1);check('reading an autonomous message counts as interest without requiring a typed reply',read.mate.state().initiative.unanswered===0&&read.mate.state().initiative.nextAttemptAt-read.time()===4*HOUR);read.mate.stop();
const format=fixture({execute:async call=>({isError:false,value:call.arguments.prompt.includes('最终只输出一个合法 JSON 对象')?{ok:true,result:{structured:{notify:false,text:''}}}:{ok:false,code:'schema_violation',error:'provider answered prose'}})});await format.enable();await format.due();check('automatic inference requests explicit plain JSON even on providers without native response formatting',format.mate.state().tasks[0].status==='completed');format.mate.stop();
const badFormat=fixture({execute:async()=>({isError:false,value:{ok:true,result:{structured:{notify:'true',text:'不能接受非布尔判断'}}}})});await badFormat.enable();await badFormat.due();check('malformed structured judgements fail closed and consume the check budget',badFormat.mate.state().tasks[0].status==='failed'&&badFormat.mate.state().messages.length===0&&badFormat.mate.state().initiative.attempts===1);badFormat.mate.stop();
/**
 * EVIDENCE: consumed by a CONTACT, not by an attempt.
 *
 * probeInitiative used to clear initiative.signals (and advance the memory fingerprints) as soon as it
 * scheduled a check-in. Measured consequence: one file signal -> one silent run -> the signal is gone,
 * and the next probe falls back to reason 'check-in' even though the real change was never mentioned.
 * These assertions pin the fixed lifecycle: kept through a silent/failed attempt, spent by a delivered
 * contact, and bounded so evidence that is genuinely not worth mentioning expires instead of repeating
 * forever.
 */
{
  const silentKeep=fixture({execute:async()=>({isError:false,value:{ok:true,result:{structured:{notify:false,text:''}}}})});
  await silentKeep.enable();
  fs.writeFileSync(path.join(silentKeep.root,'kept.txt'),'x');
  silentKeep.mate.measure(silentKeep.root,'kept.txt');
  await silentKeep.due();
  check('a silent check-in keeps the evidence it was about instead of spending it', silentKeep.mate.state().initiative.signals.length===1 && silentKeep.mate.initiativeStatus().evidence.state==='pending');
  silentKeep.advance(4*HOUR);
  await silentKeep.mate.tick();
  check('the retry still names the same evidence instead of a generic check-in', silentKeep.calls.length===2 && silentKeep.mate.state().initiative.lastReason==='file-change');
  silentKeep.mate.stop();
}
{
  const spent=fixture();
  await spent.enable();
  fs.writeFileSync(path.join(spent.root,'done.txt'),'y');
  spent.mate.measure(spent.root,'done.txt');
  await spent.due();
  check('a delivered contact spends exactly the evidence it was about', spent.mate.state().initiative.signals.length===0 && spent.mate.initiativeStatus().evidence.state==='delivered' && spent.mate.state().messages.length===1);
  spent.mate.stop();
}
{
  const expires=fixture({execute:async()=>({isError:false,value:{ok:true,result:{structured:{notify:false,text:''}}}})});
  await expires.enable();
  fs.writeFileSync(path.join(expires.root,'stale.txt'),'z');
  expires.mate.measure(expires.root,'stale.txt');
  await expires.due();
  for(let i=0;i<2;i++){expires.advance(4*HOUR);await expires.mate.tick();}
  check('evidence that never became a contact expires after the bound and says so', expires.calls.length===3 && expires.mate.state().initiative.signals.length===0 && expires.mate.initiativeStatus().evidence.state==='expired');
  expires.advance(4*HOUR);
  await expires.mate.tick();
  check('after expiry the next check-in is generic again rather than repeating the old change', expires.mate.state().initiative.lastReason==='check-in');
  expires.mate.stop();
}
{
  const failed=fixture({execute:async()=>{throw Error('offline');}});
  await failed.enable();
  fs.writeFileSync(path.join(failed.root,'offline.txt'),'w');
  failed.mate.measure(failed.root,'offline.txt');
  await failed.due();
  check('a failed check-in neither claims the change was mentioned nor drops it', failed.mate.state().tasks[0].status==='failed' && failed.mate.state().initiative.signals.length===1 && failed.mate.initiativeStatus().evidence.state==='pending');
  failed.mate.stop();
}
{
  const persisted=fixture();
  await persisted.enable();
  await persisted.due();
  createShortMemory(persisted.root,persisted.time).add({content:'重启之前写下的变化'});
  persisted.advance(9*HOUR);
  const restarted=createNewMate(persisted.dependencies);
  persisted.advance(3*MINUTE);
  await restarted.tick();
  check('a memory change made between restarts is still evidence, because the fingerprint is persisted', persisted.calls.length===2 && restarted.state().initiative.lastReason==='memory-change');
  restarted.stop();persisted.mate.stop();
}

{
  /**
   * The subject of a proactive message is what the model named. It must NOT fall back to the trigger:
   * measured 2026-10-31, two completely different sentences were both tagged 'check-in' and the second
   * was rejected as duplicate_topic, so one topic-less message silenced every other for 24 hours.
   */
  let sentences=0;
  const untopiced=fixture({execute:async()=>({isError:false,value:{ok:true,result:{structured:{notify:true,text:'第'+(++sentences)+'条完全不同的事：'+'x'.repeat(sentences)}}}})});
  await untopiced.enable();
  await untopiced.due();
  untopiced.advance(9*HOUR);
  await untopiced.mate.tick();
  check('two different topic-less check-ins are both delivered, because a trigger is not a subject', untopiced.calls.length===2 && untopiced.mate.state().messages.length===2);
  untopiced.mate.stop();
}
{
  const sameText=fixture({execute:async()=>({isError:false,value:{ok:true,result:{structured:{notify:true,text:'同一句话原样重复'}}}})});
  await sameText.enable();
  await sameText.due();
  sameText.advance(9*HOUR);
  await sameText.mate.tick();
  check('a literal repeat is still suppressed as a duplicate without a topic', sameText.mate.state().messages.length===1 && sameText.mate.state().initiative.lastOutcome==='duplicate_topic');
  sameText.mate.stop();
}

{
  /**
   * SPECULATIVE DELIVERY (Super-agent: 投机执行). The expensive half of a proactive turn is the model
   * call; refusing a finished sentence because the person started typing throws that work away. A
   * message refused by the TIMING gate alone is kept and delivered by the next suitable tick, without a
   * second model call, inside a 30-minute window.
   */
  let typingEnv;
  const prepared=fixture({execute:async()=>{if(typingEnv)typingEnv.idleMs=20000;return{isError:false,value:{ok:true,result:{structured:{notify:true,text:'刚看到你把周报补完了，需要我核对一下数字吗？',topic:'周报数字'}}}};}});
  typingEnv=prepared.env;
  await prepared.enable();
  await prepared.due();
  check('a sentence refused only because the person started typing is kept, not discarded', prepared.mate.state().messages.length===0 && prepared.calls.length===1 && prepared.mate.initiativeStatus().lastOutcome==='prepared:typing' && prepared.mate.initiativeStatus().prepared!==null);
  prepared.env.idleMs=2*MINUTE;
  await prepared.mate.tick();
  check('the kept sentence is delivered when the moment fits, with no second model call', prepared.calls.length===1 && prepared.mate.state().messages.length===1 && prepared.mate.state().messages[0].preparedAt!==undefined && prepared.mate.initiativeStatus().prepared===null);
  check('delivering a kept sentence still counts as a contact, so the next window is spaced out', prepared.notices.length===1 && prepared.mate.state().initiative.lastMessageAt>0 && prepared.mate.state().initiative.sent>=1);
  prepared.mate.stop();
}
{
  let typingEnv;
  const stale=fixture({execute:async()=>{if(typingEnv)typingEnv.idleMs=20000;return{isError:false,value:{ok:true,result:{structured:{notify:true,text:'刚有变化，想和你说一句。'}}}};}});
  typingEnv=stale.env;
  await stale.enable();
  await stale.due();
  stale.advance(31*MINUTE);
  await stale.mate.tick();
  check('a kept sentence expires after half an hour and says so instead of arriving late', stale.mate.state().messages.length===0 && stale.mate.initiativeStatus().prepared===null && stale.mate.initiativeStatus().lastOutcome==='prepared_expired');
  stale.mate.stop();
}
{
  let typingEnv;
  const talked=fixture({execute:async()=>{if(typingEnv)typingEnv.idleMs=20000;return{isError:false,value:{ok:true,result:{structured:{notify:true,text:'刚看到一条值得说的变化。'}}}};}});
  typingEnv=talked.env;
  await talked.enable();
  await talked.due();
  talked.env.idleMs=2*MINUTE;
  talked.mate.markRead(talked.mate.state().activeThreadId,true,'read',1);
  await talked.mate.tick();
  check('a kept sentence is dropped when the person came back to the companion meanwhile', talked.mate.state().messages.length===0 && talked.mate.initiativeStatus().lastOutcome==='prepared_dropped:recent_conversation');
  talked.mate.stop();
}
{
  const report=fixture({execute:async()=>({isError:false,value:{ok:true,result:{structured:{notify:true,text:'我现在不能替你执行这件事。'}}}})});
  await report.enable();
  await report.due();
  check('content refusals are never kept for later delivery', report.mate.initiativeStatus().prepared===null && report.mate.initiativeStatus().lastOutcome==='unprompted_capability_report');
  report.mate.stop();
}

check('the proactive contract admits a sentence may go out up to half an hour later, and forbids "right now" phrasing', PROACTIVE_STYLE.includes('半小时内') && PROACTIVE_STYLE.includes('不要写「刚刚」'));
const week=fixture();await week.enable();for(let i=0;i<7*24*6;i++){week.advance(10*MINUTE);await week.mate.tick();}
const perDay={};for(const m of week.mate.state().messages){const d=new Date(m.at+8*HOUR).toISOString().slice(0,10);perDay[d]=(perDay[d]||0)+1;}
check('a week without user initiation stays present, bounded by the gap rather than by a daily quota',week.mate.state().messages.length>0&&Math.max(...Object.values(perDay))<=6&&week.calls.length<=7*6);
check('a week of unacknowledged companionship sends no OS notifications',week.notices.filter(n=>n.system).length===0);
const simulation={scenario:'7 days, no user input, continuously available desktop, deterministic useful model decisions',modelChecks:week.calls.length,messages:week.mate.state().messages.length,systemNotifications:week.notices.filter(n=>n.system).length,perDay};if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(simulation,null,2));console.log(JSON.stringify(simulation));week.mate.stop();
console.log(`PASS ${checks} NewMate autonomous activation, low-disturbance and budget checks`);
