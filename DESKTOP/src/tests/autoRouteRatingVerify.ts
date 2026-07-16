import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Agent } from '../core/agent';

let assertions = 0;
function ok(value: unknown, message: string): void {
  assert.ok(value, message);
  assertions += 1;
  console.log(`PASS: ${message}`);
}

function model(name: string, cost: number) {
  return {
    name,
    display: name,
    description: '',
    cost_per_1k_input: cost,
    cost_per_1k_output: cost,
    max_tokens: 128000,
    vision: false,
    thinking: false,
    image_output: false,
    speed_rating: 'fast',
    capability_rating: 'high',
    capabilities: ['text_input', 'text_output', 'tool_use', 'json_schema'],
    validation: {
      level: 'standard',
      status: 'verified',
      checked_at: new Date().toISOString(),
      capabilities: { text_input: true, text_output: true, tool_use: true, json_schema: true },
    },
    intelligence_tiers: { low: { description: 'Quick' }, medium: { description: 'Balanced' }, high: { description: 'Deep' } },
  };
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-auto-rating-'));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      models: {
        providers: { value: [
          {
            id: 'rating-provider',
            name: 'Rating Provider',
            base_url: 'https://rating.invalid/v1',
            api_key: 'rating-secret-key',
            protocol: 'openai',
            enabled: true,
            models: [model('rated-model', 0.2)],
          },
        ] },
        default_model: { value: 'rated-model' },
        auto_switch: { value: true },
        auto_switch_preference: { value: 'balanced' },
        auto_switch_scope: { value: 'all' },
        fallback_on_unavailable: { value: true },
      },
      workspace: { auto_create_timestamp_workspace: { value: false } },
    }, null, 2));

    const agent = new Agent(root, { agentOnly: true, conversationId: 'rating-contract' });
    const fixedRating = agent.rateActiveAutoRoute(1);
    ok(!fixedRating.ok && fixedRating.reason === 'no_active_auto_route',
      'fixed model selections cannot create explicit Auto feedback');

    agent.setModel('auto');
    await agent.evaluateAndSwitch('Write TypeScript code with a validated tool. prompt-body-must-not-be-logged');
    const routeId = String(agent.lastRouteDecision?.routeId || '');
    ok(!!routeId && agent.activeDeployment()?.providerId === 'rating-provider',
      'an active Auto decision exposes a stable route id for stale-click protection');

    const invalid = agent.rateActiveAutoRoute(0, routeId);
    ok(!invalid.ok && invalid.reason === 'invalid_score', 'ratings accept only exact thumbs up/down scores');
    const stale = agent.rateActiveAutoRoute(1, 'stale-route-id');
    ok(!stale.ok && stale.reason === 'stale_route', 'a control from an older route cannot rate the active route');

    const originalSave = agent.config.save.bind(agent.config);
    let ratingSaves = 0;
    agent.config.save = () => {
      ratingSaves += 1;
      originalSave();
    };
    const positiveTaskClasses = [...(agent.lastRouteDecision?.taskClasses || [])];
    const accepted = agent.rateActiveAutoRoute(1, routeId);
    ok(accepted.ok && accepted.score === 1 && accepted.routeId === routeId,
      'the active Auto route accepts one explicit rating');
    const positiveQuality = agent.config.findDeployment({ providerId: 'rating-provider', modelId: 'rated-model' })?.quality_by_task || {};
    ok(positiveTaskClasses.length > 0
      && positiveTaskClasses.every(taskClass => positiveQuality[taskClass]?.attempts === 1
        && positiveQuality[taskClass]?.successes === 1)
      && ratingSaves === 1,
    'thumbs up records one successful quality observation per routed task class in one save');

    const feedbackPath = path.join(root, 'routing', 'feedback.jsonl');
    const firstLines = fs.readFileSync(feedbackPath, 'utf-8').split(/\r?\n/).filter(Boolean);
    const events = firstLines.map(line => JSON.parse(line) as Record<string, unknown>);
    ok(events.length === (agent.lastRouteDecision?.taskClasses.length || 0)
      && events.every(event => event.source === 'explicit_rating' && event.score === 1),
    'one metrics-only explicit feedback event is recorded per routed task class');
    ok(firstLines.every(line => !line.includes('prompt-body-must-not-be-logged') && !line.includes('rating-secret-key'))
      && events.every(event => Object.keys(event).every(key => ['deployment', 'taskClass', 'score', 'source', 'at'].includes(key))),
    'explicit feedback never stores prompt text, credentials, tool arguments, or file content');

    const duplicate = agent.rateActiveAutoRoute(-1, routeId);
    const secondLines = fs.readFileSync(feedbackPath, 'utf-8').split(/\r?\n/).filter(Boolean);
    const qualityAfterDuplicate = agent.config.findDeployment({ providerId: 'rating-provider', modelId: 'rated-model' })?.quality_by_task || {};
    ok(!duplicate.ok && duplicate.reason === 'already_rated' && duplicate.score === 1 && secondLines.length === firstLines.length,
      'repeated clicks cannot bias learned preference with duplicate feedback');
    ok(positiveTaskClasses.every(taskClass => qualityAfterDuplicate[taskClass]?.attempts === 1
      && qualityAfterDuplicate[taskClass]?.successes === 1) && ratingSaves === 1,
    'repeated clicks do not duplicate quality observations or configuration saves');

    agent.resetAutoRoute();
    await agent.evaluateAndSwitch('Explain the result concisely.');
    const negativeRouteId = String(agent.lastRouteDecision?.routeId || '');
    const negativeTaskClasses = [...(agent.lastRouteDecision?.taskClasses || [])];
    const qualityBeforeNegative = JSON.parse(JSON.stringify(
      agent.config.findDeployment({ providerId: 'rating-provider', modelId: 'rated-model' })?.quality_by_task || {},
    )) as Record<string, { attempts?: number; successes?: number }>;
    const rejected = agent.rateActiveAutoRoute(-1, negativeRouteId);
    const negativeQuality = agent.config.findDeployment({ providerId: 'rating-provider', modelId: 'rated-model' })?.quality_by_task || {};
    ok(rejected.ok && rejected.score === -1 && negativeTaskClasses.length > 0
      && negativeTaskClasses.every(taskClass => negativeQuality[taskClass]?.attempts === (qualityBeforeNegative[taskClass]?.attempts || 0) + 1
        && negativeQuality[taskClass]?.successes === (qualityBeforeNegative[taskClass]?.successes || 0))
      && ratingSaves === 2,
    'thumbs down records one failed quality observation per routed task class without increasing successes');

    const cwd = process.cwd();
    const source = (relative: string): string => fs.readFileSync(path.join(cwd, relative), 'utf-8');
    const utilityProtocol = source('src/core/utilityAgentProtocol.ts');
    const wslProtocol = source('src/core/wslAgentProtocol.ts');
    const mainSource = source('src/main.ts');
    const preloadSource = source('src/preload.ts');
    const uiSource = source('src/ui/index.html');
    ok(utilityProtocol.includes("method: 'rate_auto_route'") && wslProtocol.includes("method: 'rate_auto_route'")
      && source('src/conversation-utility-host.ts').includes('kernel.rateAutoRoute(')
      && source('src/wsl-agent-host.ts').includes('kernel.rateAutoRoute('),
    'Electron Utility and WSL host protocols both deliver ratings to the target ConversationKernel');
    ok(mainSource.includes("ipcMain.handle('agent:rateAutoRoute'")
      && preloadSource.includes("ipcRenderer.invoke('agent:rateAutoRoute', request)"),
    'main and preload expose a target-bound desktop rating IPC');
    ok(uiSource.includes("iconSvg(score > 0 ? 'thumbs-up' : 'thumbs-down'")
      && uiSource.includes('target: currentConversationTarget()')
      && uiSource.includes('routeId: routeId'),
    'the assistant response renders compact accessible thumbs bound to a route id and conversation target');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`auto route rating verification passed (${assertions} assertions)`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
