import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {createNewMate} from '../packages/newmark-core/components/newmate/component.js';import {createMemoryLab} from '../packages/newmark-core/components/memorylab/component.js';import {newMateContext} from '../packages/newmark-core/lib/newmate-context.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'newmate-write-')),lab=createMemoryLab({root}),registered=new Map(lab.tools().map(t=>[t.name,t]));let checks=0,dispatch,systemPrefix;
const check=(name,value)=>{assert(value,name);console.log(`ok ${++checks} - ${name}`);};
const mate=createNewMate({root,agents:()=>undefined,tools:{execute:async call=>{
 dispatch=call;systemPrefix=newMateContext()?.prefix||'';const allow=call.arguments.tools.allow;
 check('actual NewMate dispatch exposes short memory and long memory writes',allow.includes('shortMemory_add')&&allow.includes('memory_lab_update'));
 check('deletion and arbitrary execution remain outside the tool list, and desktop tools are inside it',!allow.includes('memory_lab_delete')&&!allow.includes('run_code')&&allow.includes('computer_use')&&allow.includes('screen_capture'));
 const short=await registered.get('shortMemory_add').execute({content:'隔离测试的短期项目'});check('short memory tool performs a durable write',short.ok===true&&short.total===1);
 const long=await registered.get('memory_lab_update').execute({name:'隔离写入验收',content:'仅在测试根目录保存。',tags:['#验收'],reason:'isolated test'});check('long memory tool returns a verified write receipt',long.ok===true&&long.receipt?.verified===true);
 return{isError:false,value:{ok:true,result:{output:'隔离写入完成'}}};
}}});mate.chat('验证记忆写入');await mate.tick();check('the actual companion task completed rather than swallowing a test assertion',mate.state().tasks.at(-1).status==='completed');check('initialization persona describes writes and forbids treating test data as facts',systemPrefix.includes('增量更新')&&systemPrefix.includes('临时验收')&&systemPrefix.startsWith('你是由 MemoryLab 驱动的定制陪伴 Agent NewMate'));
check('short and long writes reach the isolated native memory store',registered.get('shortMemory_size').execute({}).total===1&&JSON.stringify(await registered.get('memory_lab_query').execute({query:'隔离写入验收'})).includes('隔离写入验收'));
mate.stop();console.log(`PASS ${checks} actual NewMate permission and native MemoryLab write checks; isolated root only`);
