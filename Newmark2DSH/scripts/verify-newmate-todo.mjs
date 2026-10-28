import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {createNewMate} from '../packages/newmark-core/components/newmate/component.js';
import {newMateCalls,createNewMateMcp} from '../packages/newmark-core/components/newmate/lib/mcp.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'newmate-todo-')),file=path.join(root,'newMate/state.json');let time=Date.parse('2026-10-13T10:00:00Z'),checks=0,calls=0;const notices=[];
const make=()=>reminderOnly(createNewMate({root,now:()=>time,onNotify:async m=>notices.push(m),tools:{execute(){calls++;throw Error('Reminder must not call a model');}},agents:()=>null}));
function reminderOnly(mate){const add=mate.todoAdd;mate.todoAdd=(input,...rest)=>add({...input,mode:'reminder'},...rest);return mate;}
const change=fn=>{const s=JSON.parse(fs.readFileSync(file));fn(s);fs.writeFileSync(file,JSON.stringify(s));};const check=(name,value)=>{assert(value,name);console.log('ok '+(++checks)+' - '+name);},future=ms=>new Date(time+ms).toISOString();
let mate=make();await mate.configure({companion:true,initiative:false,quietStart:0,quietEnd:0});
check('legacy state gains a durable empty todo list',Array.isArray(mate.state().todos));
for(const input of [{content:'',activateAt:future(1000)},{content:'a',activateAt:'2026-10-14T10:00'},{content:'a',activateAt:new Date(time).toISOString()},{content:'a',activateAt:1},{content:'a',activateAt:'2027-02-30T10:00:00Z'},{content:'a',activateAt:'2027-02-03T25:00:00Z'}])assert.throws(()=>mate.todoAdd(input));check('empty content, missing zone, past time and invalid calendar dates rejected',true);
const tools=newMateCalls(mate),add=tools.find(t=>t.name==='newmate_todo_add'),list=tools.find(t=>t.name==='newmate_todo_list'),cancel=tools.find(t=>t.name==='newmate_todo_cancel');
const scheduled=add.execute({content:'带上证件，准备出发。',activateAt:future(1000)},{agent:{session:{id:'other-conversation'}}}).todo;check('any DSH conversation may create a reminder',scheduled.origin==='dsh-session:other-conversation'&&list.execute().todos.length===1);
await mate.tick();check('future reminder remains pending without model spend',mate.state().todos[0].status==='pending'&&calls===0&&notices.length===0);
time+=1001;mate.presence(true,'reader',1);await Promise.all([mate.tick(),mate.tick(),mate.tick()]);
check('due content is delivered exactly into the protected current thread',mate.state().messages.at(-1).text===scheduled.content&&mate.state().messages.at(-1).threadId==='default'&&mate.state().todos[0].status==='delivered');check('overlapping ticks emit one durable message and one bubble',mate.state().messages.filter(m=>m.todoId===scheduled.id).length===1&&notices.length===1&&calls===0);
assert.throws(()=>cancel.execute({id:scheduled.id}));check('delivered reminders cannot be cancelled or reactivated',true);
mate.stop();mate=make();await mate.tick();check('restart never repeats a delivered message or notification',notices.length===1&&mate.state().messages.filter(m=>m.todoId===scheduled.id).length===1);
const cancelled=mate.todoAdd({content:'不用投递',activateAt:future(1000)}).todo;cancel.execute({id:cancelled.id});time+=2000;await mate.tick();check('cancellation retains audit data without sending',mate.state().todos.find(t=>t.id===cancelled.id).status==='cancelled'&&!mate.state().messages.some(m=>m.todoId===cancelled.id));
const paused=mate.todoAdd({content:'开启后补送',activateAt:future(1000)},undefined,'user').todo;await mate.configure({companion:false});time+=2000;await mate.tick();check('companion off preserves overdue reminder',mate.state().todos.find(t=>t.id===paused.id).status==='pending');check('companion off names its reason instead of waiting silently',mate.state().todos.find(t=>t.id===paused.id).deferred?.code==='companion_off'&&mate.state().todos.find(t=>t.id===paused.id).deferred.reason==='陪伴未开启');await mate.configure({companion:true});await mate.tick();check('enabling companion delivers overdue item once',mate.state().todos.find(t=>t.id===paused.id).status==='delivered');check('delivery clears the deferral record',!mate.state().todos.find(t=>t.id===paused.id).deferred);
const recovered=mate.todoAdd({content:'重启未落盘消息的待办',activateAt:future(1000)}).todo;mate.stop();change(s=>{s.todos.find(t=>t.id===recovered.id).status='delivering';});time+=2000;mate=make();await mate.tick();check('interrupted claim without message safely resumes once',mate.state().todos.find(t=>t.id===recovered.id).status==='delivered'&&mate.state().messages.filter(m=>m.todoId===recovered.id).length===1);
mate.stop();change(s=>{s.todos.find(t=>t.id===recovered.id).status='delivering';});const noticeCount=notices.length;mate=make();await mate.tick();check('crash after message persistence reconciles without repeating bubble',mate.state().todos.find(t=>t.id===recovered.id).status==='delivered'&&notices.length===noticeCount);
change(s=>{s.messages.push({id:'old-user',threadId:s.activeThreadId,role:'user',text:'之前聊过',at:time-2*86400000});s.threads.find(t=>t.id===s.activeThreadId).created=time-2*86400000;s.attention={};s.initiative.lastTopic='work';s.initiative.unanswered=2;});
const oldThread=mate.state().activeThreadId,rotating=mate.todoAdd({content:'新的日程提醒',activateAt:future(1000)}).todo;time+=2000;await mate.tick();check('absent interest uses existing handoff policy to create a new thread',mate.state().activeThreadId!==oldThread&&mate.state().threads.find(t=>t.id===oldThread).archived&&mate.state().todos.find(t=>t.id===rotating.id).threadId===mate.state().activeThreadId);
const activeThread=mate.state().activeThreadId;change(s=>{s.lastThreadRotation=null;s.threads.find(t=>t.id===activeThread).created=time-2*86400000;s.messages.push({id:'old-2',threadId:activeThread,role:'user',text:'旧话题',at:time-2*86400000});s.attention[activeThread]={draftUntil:time+86400000};});const drafted=mate.todoAdd({content:'保留草稿的提醒',activateAt:future(1000)}).todo;time+=2000;await mate.tick();check('draft attention prevents automatic thread rotation',mate.state().todos.find(t=>t.id===drafted.id).threadId===activeThread);
const delayed=mate.todoAdd({content:'用户回复结束后提醒',activateAt:future(1000)}).todo;change(s=>{s.tasks.push({id:'pending-chat',kind:'chat',status:'pending',threadId:activeThread,destination:'not-newmate',prompt:'fixture'});});time+=2000;await mate.tick();check('pending user chat takes priority over reminder delivery',mate.state().todos.find(t=>t.id===delayed.id).status==='pending');check('and that wait is named, not silent',mate.state().todos.find(t=>t.id===delayed.id).deferred?.code==='newmate_busy');change(s=>{s.tasks=s.tasks.filter(t=>t.id!=='pending-chat');});await mate.tick();check('due reminder continues after user chat finishes',mate.state().todos.find(t=>t.id===delayed.id).status==='delivered');
// --- the user's rule: a reminder waits only for the companion switch and NewMate's own idle ---
mate.stop();
const isoRoot=fs.mkdtempSync(path.join(os.tmpdir(),'newmate-todo-iso-')),isoFile=path.join(isoRoot,'newMate/state.json');
let isoTime=Date.parse('2026-10-28T06:00:00Z'),isoCalls=0;const isoNotices=[];
const isoEnv={ready:true,readerFocused:false,busy:false,idleMs:120000};
const isoMake=()=>reminderOnly(createNewMate({root:isoRoot,now:()=>isoTime,agents:()=>()=>({}),environment:()=>isoEnv,onNotify:async m=>isoNotices.push(m),tools:{execute(){isoCalls++;throw Error('Reminder must not call a model');}}}));
const isoCheck=(name,value)=>check(name,value);
let iso=isoMake();await iso.configure({companion:true,initiative:false,quietStart:0,quietEnd:0});
const due=()=>new Date(isoTime+1000).toISOString();

// 1) a DSH session running elsewhere is NOT NewMate working: the reminder must go out anyway
isoEnv.busy=true;isoEnv.idleMs=0;isoEnv.readerFocused=true;isoEnv.ready=false;
const busyHost=iso.todoAdd({content:'宿主忙也要发',activateAt:due()}).todo;isoTime+=2000;await iso.tick();
isoCheck('a host session, a reader, an unavailable desktop and a keystroke do not hold a reminder',iso.state().todos.find(t=>t.id===busyHost.id).status==='delivered');
isoCheck('reminder delivery still spends no model call',isoCalls===0&&isoNotices.filter(m=>m.text==='宿主忙也要发').length===1);

// 2) NewMate's own queue does hold it - and says so
isoEnv.busy=false;isoEnv.idleMs=120000;isoEnv.readerFocused=false;isoEnv.ready=true;
const queued=iso.todoAdd({content:'NewMate 自己的队列',activateAt:due()}).todo;
const isoChange=fn=>{const s=JSON.parse(fs.readFileSync(isoFile));fn(s);fs.writeFileSync(isoFile,JSON.stringify(s));};
isoChange(s=>{s.tasks.push({id:'iso-chat',kind:'chat',status:'pending',threadId:s.activeThreadId,destination:'newmate',prompt:'fixture'});});
isoTime+=2000;await iso.tick();
isoCheck('NewMate own pending chat holds the reminder',iso.state().todos.find(t=>t.id===queued.id).status==='pending'&&iso.state().todos.find(t=>t.id===queued.id).deferred?.code==='newmate_busy');
isoChange(s=>{s.tasks=s.tasks.filter(t=>t.id!=='iso-chat');});await iso.tick();
isoCheck('the reminder goes out the moment NewMate is idle again',iso.state().todos.find(t=>t.id===queued.id).status==='delivered'&&iso.state().messages.some(m=>m.todoId===queued.id&&m.text==='NewMate 自己的队列'));
isoCheck('a second reminder inside the 30-minute bubble cooldown is stored but does not pop up',isoNotices.filter(m=>m.text==='NewMate 自己的队列').length===0);

// 3) quiet hours keep the message and only mute the bubble - the reminder is still delivered
const quiet=iso.todoAdd({content:'静默时段照样到账',activateAt:due()}).todo;
await iso.configure({quietStart:Number(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(new Date(isoTime))),quietEnd:(Number(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(new Date(isoTime)))+1)%24});
isoTime+=2000;await iso.tick();
const quietRow=iso.state().todos.find(t=>t.id===quiet.id);
isoCheck('quiet hours do not delay the message itself',quietRow.status==='delivered');
isoCheck('quiet hours still suppress the bubble',isoNotices.filter(m=>m.text==='静默时段照样到账').length===0);
await iso.configure({quietStart:0,quietEnd:0});

// 4) the conversation mode keeps the full attention gate and names the blocker
iso.stop();const convRoot=fs.mkdtempSync(path.join(os.tmpdir(),'newmate-todo-conv-'));
const convEnv={ready:true,readerFocused:false,busy:false,idleMs:120000};
const conv=createNewMate({root:convRoot,now:()=>isoTime,agents:()=>()=>({}),environment:()=>convEnv,onNotify:async()=>{},tools:{execute:async()=>({isError:false,value:{ok:true,result:{output:'ok'}}})}});
await conv.configure({companion:true,initiative:false,quietStart:0,quietEnd:0});
const convTodo=conv.todoAdd({content:'激活一轮对话',activateAt:new Date(isoTime+1000).toISOString()}).todo;
isoTime+=2000;convEnv.busy=true;await conv.tick();
isolateConvBlocker: {
  const row=conv.state().todos.find(t=>t.id===convTodo.id);
  isoCheck('an activation still waits for the host (unchanged)',row.status==='pending'&&row.deferred?.code==='host_busy'&&row.deferred.reason==='宿主有会话在运行');
}
convEnv.busy=false;convEnv.readerFocused=true;await conv.tick();
isoCheck('the activation reports reading next',conv.state().todos.find(t=>t.id===convTodo.id).deferred?.code==='reading');
convEnv.readerFocused=false;await conv.tick();
isoCheck('and activates once nothing blocks it',conv.state().todos.find(t=>t.id===convTodo.id).status!=='pending');
conv.stop();
mate=make();

const mcp=createNewMateMcp({root,mate});const rpc=await mcp.rpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'newmate_todo_add',arguments:{content:'MCP 外部 Agent',activateAt:future(10000)}}});check('MCP exposes the same reminder creation implementation',rpc.result.structuredContent.todo.content==='MCP 外部 Agent');
check('all scheduled delivery and management spent zero model calls',calls===0);mate.stop();
let self;self=createNewMate({root:path.join(root,'self'),now:()=>time,agents:()=>null,tools:{execute:async call=>{assert(call.arguments.tools.allow.includes('newmate_todo_add'));newMateCalls(self).find(t=>t.name==='newmate_todo_add').execute({content:'NewMate 创建的待办',activateAt:future(60000)});return{isError:false,value:{ok:true,result:{output:'已经安排好了。'}}};}}});self.chat('请安排一个定时提醒');await self.tick();check('NewMate actual dispatch grants reminder creation and reaches the durable store',self.state().todos[0]?.content==='NewMate 创建的待办'&&self.state().messages.at(-1).text==='已经安排好了。');self.stop();console.log('PASS '+checks+' durable todo scheduling, attention, restart and MCP checks');
