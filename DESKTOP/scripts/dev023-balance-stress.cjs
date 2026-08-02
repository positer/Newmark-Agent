const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Agent } = require('../dist/core/agent.js');

function model(name) {
  return { name, display: name, description: 'dev-0.2.3 stress fixture', max_tokens: 128000, vision: false, thinking: false, image_output: false, enabled: true, speed_rating: 'fast', capability_rating: 'high', evaluation: { status: 'degraded' }, validation: { level: 'standard', status: 'degraded', checked_at: new Date().toISOString(), capabilities: { text_input: true, text_output: true, tool_use: true } }, capabilities: ['text_input','text_output','tool_use'], intelligence_tiers: { low:{description:''}, medium:{description:''}, high:{description:''}, xhigh:{description:''}, max:{description:''} } };
}
function provider(id, modelName) {
  return { id, name: id, base_url: 'https://stress.invalid/v1', api_key: 'stress-key', protocol: 'openai', enabled: true, models: [model(modelName)] };
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-dev023-balance-'));
  let calls = 0;
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ models: { providers: { value: [provider('stress-provider', 'stress-model'), provider('stress-provider-2', 'stress-model-2')] }, default_model:{value:'stress-model'}, fallback_on_unavailable:{value:false}, auto_switch:{value:false} }, workspace:{auto_create_timestamp_workspace:{value:false}} }, null, 2));
    const agent = new Agent(root, { agentOnly:true, workspaceRegistryMode:'detached', conversationId:'stress' });
    agent.workspace.current = null;
    agent.config.clearWorkspaceOverrides();
    agent.forcedProvider = { intelligenceConfig: () => ({ temperature:0, maxTokens:32 }), async *chatStreamWithTools(){ calls++; yield { type:'text', text: agent.activeModelName() === 'stress-model' ? '[LLM Error: 402] {"error":{"message":"Insufficient Balance"}}' : 'ok' }; }, async chat(){ return ''; } };
    await assert.rejects(() => agent.process('first'), /Insufficient Balance/);
    assert.equal(calls, 1);
    await assert.rejects(() => agent.process('second'), /balance exhausted/i);
    assert.equal(calls, 1);
    agent.setModel('stress-model-2');
    await agent.process('third');
    assert.equal(calls, 2);
    console.log(JSON.stringify({ ok:true, calls, blockedFollowUp:true, switchedProviderUnblocked:true, cooldownMs:300000 }));
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
}
main().catch(error => { console.error(error); process.exit(1); });
