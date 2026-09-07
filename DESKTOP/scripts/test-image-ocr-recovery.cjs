const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),http=require('http');
const {spawnSync}=require('child_process');
const {Agent}=require('../dist/core/agent');
const {ConversationKernel}=require('../dist/core/conversationKernel');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'newmark-ocr-recovery-'));const file=path.join(root,'ocr.png');
 const ps=`Add-Type -AssemblyName System.Drawing
 $bitmap=New-Object System.Drawing.Bitmap 900,180
 $g=[System.Drawing.Graphics]::FromImage($bitmap)
 $g.Clear([System.Drawing.Color]::White)
 $font=New-Object System.Drawing.Font('Arial',42)
 $g.DrawString('Build Next 12345',$font,[System.Drawing.Brushes]::Black,20,40)
 $bitmap.Save('${file.replace(/'/g,"''")}',[System.Drawing.Imaging.ImageFormat]::Png)
 $g.Dispose(); $font.Dispose(); $bitmap.Dispose()
 Write-Output 'OCR fixture generated'`;
 const generated=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{encoding:'utf8',windowsHide:true});assert.equal(generated.status,0,generated.stderr);
 const image='data:image/png;base64,'+fs.readFileSync(file).toString('base64');let imageCalls=0,correctionCalls=0,acceptImages=false,ocrTask='';
 const server=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const body=JSON.parse(raw);const visual=raw.includes('data:image');res.setHeader('Content-Type','application/json');if(visual){imageCalls++;if(!acceptImages){res.statusCode=400;res.end(JSON.stringify({error:{message:'image input is not supported'}}));return;}}
 if(raw.includes('OCR evidence:')){correctionCalls++;ocrTask=raw;}
 res.end(JSON.stringify({id:'fixture',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:raw.includes('OCR evidence:')?'Build Next 12345':visual?'VISION_RECOVERED':'Title'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:4,total_tokens:8}}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({models:{providers:[{id:'fixture',name:'Fixture',protocol:'openai',base_url:`http://127.0.0.1:${server.address().port}/v1`,api_key:'fixture',enabled:true,models:[{name:'model',vision:false,enabled:true,max_tokens:128000,validation:{level:'standard',status:'unavailable',capabilities:{vision:false}}},{name:'alternate-vision',vision:true,enabled:true,max_tokens:128000}]}],default_model:'deployment:fixture:model',auto_switch:false,fallback_on_unavailable:false}}));
 const agent=new Agent(root,{agentOnly:true});const workspace=agent.createInternalWorkspace('ocr-recovery');const kernel=new ConversationKernel(root,agent,null,{createRunner:()=>agent});const target={workspaceId:workspace.id,conversationId:agent.activeConversationId};const options={model:'deployment:fixture:model',mode:'build',intelligence:'low',inputMode:'guide',engine:'builtin'};
 const result=await kernel.prompt({text:'Read the exact text and number in this image.',images:[{dataUrl:image,name:'ocr.png'}]},target,options,'steer');
 assert.ok(imageCalls>0,'attempt real image first');assert.equal(correctionCalls,1,'OCR text correction request follows visual refusal');assert.match(ocrTask,/Read the exact text and number/);assert.match(ocrTask,/12345/);assert.ok(result.tokens.some(t=>t.text?.includes('mini_ocr_llm')&&t.text.includes('Build Next 12345')),JSON.stringify(result.tokens));assert.equal(agent.activeModelConfig().response_health.vision.ok,false,'text-only correction does not heal vision');
 assert.ok(agent.history.some(m=>m.role==='assistant'&&String(m.content).includes('mini_ocr_llm')));assert.ok(agent.chatMessages.some(m=>m.role==='assistant'&&String(m.content).includes('Build Next 12345')));
 console.log('PASS real image refusal -> built-in OCR -> same-model text correction with original task');
 acceptImages=true;const before=imageCalls;
 const recovered=await kernel.prompt({text:'Read this image again.',images:[{dataUrl:image,name:'ocr.png'}]},target,options,'steer');
 assert.ok(imageCalls>before,'next attached image is retried');assert.ok(recovered.tokens.some(t=>t.text?.includes('VISION_RECOVERED')));assert.equal(agent.activeModelConfig().response_health.vision.ok,true);assert.equal(correctionCalls,1,'successful vision does not call OCR again');
 console.log('PASS next image request retries original model and heals vision');console.log(JSON.stringify({imageCalls,correctionCalls}));
 }finally{server.closeAllConnections();server.close();}process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
