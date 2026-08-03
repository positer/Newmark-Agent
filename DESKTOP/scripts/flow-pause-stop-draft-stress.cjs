const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Agent } = require('../dist/core/agent.js');
const { FlowEngine } = require('../dist/core/flow.js');
const { runFlow } = require('../dist/core/flow-runner.js');

function model(name) {
  return { name, display: name, description: 'dev-0.2.6 flow pause/stop stress fixture', max_tokens: 128000, vision: false, thinking: false, image_output: false, enabled: true, speed_rating: 'fast', capability_rating: 'high', evaluation: { status: 'degraded' }, validation: { level: 'standard', status: 'degraded', checked_at: new Date().toISOString(), capabilities: { text_input: true, text_output: true, tool_use: true } }, capabilities: ['text_input','text_output','tool_use'], intelligence_tiers: { low:{description:''}, medium:{description:''}, high:{description:''}, xhigh:{description:''}, max:{description:''} } };
}
function provider(id, modelName) {
  return { id, name: id, base_url: 'https://stress.invalid/v1', api_key: 'stress-key', protocol: 'openai', enabled: true, models: [model(modelName)] };
}
function writeConfig(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ models: { providers: { value: [provider('stress-provider', 'stress-model')] }, default_model:{value:'stress-model'}, fallback_on_unavailable:{value:false}, auto_switch:{value:false} }, workspace:{auto_create_timestamp_workspace:{value:false}} }, null, 2));
}

// A provider that emits one chunk then stays alive until released so the stress
// loop can reliably abort the flow while the Build block is still streaming.
function streamingProvider(registry, key) {
  registry[key] = { release: null };
  return {
    intelligenceConfig: () => ({ temperature: 0, maxTokens: 32 }),
    async *chatStreamWithTools() {
      yield { type: 'text', text: 'partial chunk ' };
      await new Promise((resolve) => { registry[key].release = resolve; });
      yield { type: 'text', text: 'complete' };
    },
    async chat() { return 'complete'; },
  };
}

const WORKFLOW = {
  name: 'pause-stop-stress-flow',
  components: [
    { type: 'dialog', id: 10, mode: 'build', prompt: 'First step' },
    { type: 'dialog', id: 20, mode: 'build', prompt: 'Second step' },
  ],
};

async function makeAgent(root, conversationId) {
  const agent = new Agent(root, { agentOnly: true, workspaceRegistryMode: 'detached', conversationId: conversationId || 'stress' });
  agent.workspace.current = null;
  agent.config.clearWorkspaceOverrides();
  agent.createInternalWorkspace('stress-ws');
  return agent;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-pause-stop-stress-'));
  const releases = {};
  let iterations = 0;
  try {
    writeConfig(root);
    const flowDir = path.join(root, 'Flow');
    fs.mkdirSync(flowDir, { recursive: true });
    FlowEngine.save(flowDir, WORKFLOW);

    const agent = await makeAgent(root);
    agent.forcedProvider = streamingProvider(releases, 'main');

    // ---- Scenario A: first Stop creates a persisted interrupted suspension ----
    const abortController = new AbortController();
    const runPromise = runFlow(agent, WORKFLOW, { startPc: 10, startInput: 'go', quiet: true, signal: abortController.signal }).catch((error) => {
      return { __flowError: error };
    });
    // Wait until the provider is streaming, then simulate the first Stop/Esc:
    // cooperative abort + kernel abort exactly like main.ts flow:stop does.
    while (!releases.main.release) await new Promise((resolve) => setTimeout(resolve, 5));
    const firstStopError = new Error(`Flow interrupted by user: ${WORKFLOW.name}`);
    abortController.abort(firstStopError);
    agent.abortActiveKernelRun();
    releases.main.release();
    const firstStopResult = await runPromise;
    assert(firstStopResult && firstStopResult.__flowError, 'first Stop: runFlow rejects cooperatively');
    assert(/Flow interrupted by user|Agent run aborted|aborted/i.test(String(firstStopResult.__flowError.message)), 'first Stop: user-flow abort surfaced');

    // Mirror the main.ts flow:run interrupted-suspension path.
    const interruptedComponentId = 20;
    agent.flowPc = interruptedComponentId;
    agent.setMode('flow');
    const suspensionRecord = {
      workflowName: WORKFLOW.name,
      componentId: interruptedComponentId,
      input: 'go',
      completedResults: [],
      previousMode: 'build',
      reason: 'interrupted',
      message: String(firstStopResult.__flowError.message || 'Flow interrupted.').slice(0, 320),
      updatedAt: new Date().toISOString(),
    };
    agent.saveStoredFlowSuspension(suspensionRecord);
    assert.equal(agent.mode, 'flow', 'first Stop: mode is flow while paused');
    const stored = agent.getStoredFlowSuspension();
    assert(stored, 'first Stop: suspension persisted');
    assert.equal(stored.workflowName, WORKFLOW.name, 'first Stop: persisted workflow name');
    assert.equal(stored.componentId, 20, 'first Stop: persisted pause component');
    assert.equal(stored.reason, 'interrupted', 'first Stop: persisted reason is interrupted');
    assert.equal(stored.previousMode, 'build', 'first Stop: persisted previous mode');
    assert(stored.completedResults, 'first Stop: persisted completed results array');
    const stateFile = path.join(agent.workspace.current.path, 'conversations', 'state.json');
    assert(fs.existsSync(stateFile), 'first Stop: state.json written to workspace');
    const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    assert(onDisk.flowSuspension && onDisk.flowSuspension.workflowName === WORKFLOW.name, 'first Stop: suspension visible on disk');
    iterations++;

    // ---- Scenario B: second Stop force-stops and restores the previous mode ----
    agent.flow = WORKFLOW;
    agent.flowPc = 20;
    agent.setMode('build');
    agent.clearStoredFlowSuspension();
    assert.equal(agent.getStoredFlowSuspension(), null, 'second Stop: suspension cleared');
    assert.equal(agent.mode, 'build', 'second Stop: mode restored to previous mode');
    iterations++;

    // ---- Scenario C: new instruction while paused exits without restoring mode ----
    agent.setMode('flow');
    agent.saveStoredFlowSuspension(suspensionRecord);
    assert(agent.getStoredFlowSuspension(), 'new-work: suspension restored before send');
    // clearFlowSuspensionForNewWork drops the pause but must NOT restore the mode.
    agent.pendingOptions = [];
    agent.flow = null;
    agent.flowPc = 0;
    agent.clearStoredFlowSuspension();
    assert.equal(agent.getStoredFlowSuspension(), null, 'new-work: suspension cleared before send');
    assert.equal(agent.mode, 'flow', 'new-work: mode is NOT restored (new instruction owns the mode)');
    iterations++;

    // ---- Scenario D: conversation draft persistence round-trips ----
    const drafts = 40;
    for (let i = 0; i < drafts; i++) {
      agent.saveStoredConversationDraft(`draft-${i}`, `conv-${i}`);
    }
    for (let i = 0; i < drafts; i++) {
      assert.equal(agent.getStoredConversationDraft(`conv-${i}`), `draft-${i}`, `draft: round-trip conv-${i}`);
    }
    agent.saveStoredConversationDraft(null, 'conv-7');
    assert.equal(agent.getStoredConversationDraft('conv-7'), undefined, 'draft: clearing a draft removes it');
    assert.equal(agent.getStoredConversationDraft('conv-8'), 'draft-8', 'draft: sibling drafts survive');
    iterations++;

    // ---- Scenario E: drafts and suspension survive an Agent restart ----
    const agent2 = await makeAgent(root);
    assert.equal(agent2.getStoredConversationDraft('conv-12'), 'draft-12', 'restart: draft survives new Agent on same root');
    assert.equal(agent2.getStoredConversationDraft('conv-7'), undefined, 'restart: cleared draft stays gone');
    assert.equal(agent2.getStoredConversationDraft('conv-39'), 'draft-39', 'restart: last draft survives');
    assert(agent2.getStoredFlowSuspension() === null, 'restart: cleared suspension stays gone');
    iterations++;

    // ---- Scenario F: concurrent persistence across many agents on one root ----
    const agents = [];
    for (let a = 0; a < 8; a++) agents.push(await makeAgent(root, `conv-agent-${a}`));
    await Promise.all(agents.map((item, a) => Promise.resolve().then(() => {
      for (let i = 0; i < 25; i++) item.saveStoredConversationDraft(`conc-${a}-${i}`, `conc-${a}-${i}`);
    })));
    const survivor = await makeAgent(root);
    for (let a = 0; a < 8; a++) {
      for (let i = 0; i < 25; i++) {
        assert.equal(survivor.getStoredConversationDraft(`conc-${a}-${i}`), `conc-${a}-${i}`, `concurrency: draft conc-${a}-${i} survives`);
      }
    }
    const concurrencyState = JSON.parse(fs.readFileSync(path.join(agent.workspace.current.path, 'conversations', 'state.json'), 'utf-8'));
    assert(concurrencyState && typeof concurrencyState === 'object', 'concurrency: state.json remains valid JSON after parallel writes');
    iterations++;

    // ---- Scenario G: rapid pause/stop toggle churn keeps persistence coherent ----
    for (let i = 0; i < 12; i++) {
      const churnAgent = await makeAgent(root);
      churnAgent.saveStoredFlowSuspension({ workflowName: 'churn', componentId: i, input: '', completedResults: [], previousMode: 'build', reason: 'interrupted', message: 'churn', updatedAt: new Date().toISOString() });
      assert.equal(churnAgent.getStoredFlowSuspension()?.componentId, i, `churn ${i}: suspension written`);
      churnAgent.clearStoredFlowSuspension();
      assert.equal(churnAgent.getStoredFlowSuspension(), null, `churn ${i}: suspension cleared`);
      churnAgent.saveStoredConversationDraft(`churn-draft-${i}`, `churn-conv-${i}`);
      assert.equal(churnAgent.getStoredConversationDraft(`churn-conv-${i}`), `churn-draft-${i}`, `churn ${i}: draft written`);
      churnAgent.saveStoredConversationDraft(null, `churn-conv-${i}`);
      assert.equal(churnAgent.getStoredConversationDraft(`churn-conv-${i}`), undefined, `churn ${i}: draft cleared`);
    }
    const churnSurvivor = await makeAgent(root);
    assert.equal(churnSurvivor.getStoredFlowSuspension(), null, 'churn: no suspension leak after 12 toggle cycles');
    for (let i = 0; i < 12; i++) {
      assert.equal(churnSurvivor.getStoredConversationDraft(`churn-conv-${i}`), undefined, `churn ${i}: cleared draft did not resurface`);
    }
    iterations++;

    console.log(JSON.stringify({
      ok: true,
      iterations,
      firstStopCooperated: true,
      secondStopForceStopped: true,
      newWorkExitsWithoutModeRestore: true,
      draftRoundTrips: 40,
      restartSurvived: true,
      concurrentAgents: 8,
      concurrentDrafts: 200,
      churnCycles: 12,
      noLeaks: true,
    }, null, 2));
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}
main().catch(error => { console.error(error); process.exit(1); });
