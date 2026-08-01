import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { Agent } from '../core/agent';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-display-image-'));
const root = path.join(base, 'runtime');
const workspace = path.join(base, 'workspace');
fs.mkdirSync(workspace, { recursive: true });

(async () => {
try {
  const png = new PNG({ width: 3, height: 2 });
  png.data.fill(255);
  fs.writeFileSync(path.join(workspace, 'architecture.png'), PNG.sync.write(png));

  const agent = new Agent(root);
  const selected = agent.addExternalWorkspace(workspace);
  assert.ok(selected, 'fixture workspace is selected');
  const definition = agent.tools.openAIChatDefinitions('build').find((item: any) => item.function?.name === 'image_display') as any;
  assert.deepStrictEqual(definition?.function?.parameters?.required, ['path'], 'image_display is an Agent-callable schema with required workspace path');

  const result = JSON.parse(agent.handleImageDisplay(JSON.stringify({ path: 'architecture.png', caption: 'Architecture diagram' })));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.image.origin, 'agent');
  assert.strictEqual(result.image.dataUrl, undefined, 'tool result exposes a durable reference rather than image bytes');
  const hydrated = agent.hydrateDisplayImage(result.image);
  assert.ok(hydrated?.dataUrl?.startsWith('data:image/png;base64,'));
  assert.strictEqual(hydrated?.width, 3);
  assert.strictEqual(hydrated?.height, 2);

  const visionCalls: Array<Record<string, unknown>> = [];
  const visionAgent = agent as any;
  visionAgent.activeModelConfig = () => ({ vision: true });
  visionAgent.activeModelName = () => 'validated-vision-model';
  visionAgent.activeDeployment = () => ({ providerId: 'vision-provider', modelId: 'validated-vision-model' });
  visionAgent.engineModel = () => ({
    chat: async (_model: string, messages: Array<Record<string, unknown>>) => {
      visionCalls.push(messages[0]);
      return '白色架构关系示意图';
    },
  });
  const described = JSON.parse(await agent.handleImageDisplayWithDescription(JSON.stringify({ path: 'architecture.png', caption: 'fallback hint' })));
  assert.strictEqual(described.image.caption, '白色架构关系示意图', 'validated vision generates the user-visible display title from image content');
  assert.strictEqual(described.caption_source, 'vision');
  assert.ok(Array.isArray((visionCalls[0] as any)?.content) && (visionCalls[0] as any).content.some((part: any) => part.type === 'image_url'), 'description request includes the actual displayed image');
  const describedAgain = JSON.parse(await agent.handleImageDisplayWithDescription(JSON.stringify({ path: 'architecture.png' })));
  assert.strictEqual(describedAgain.image.caption, '白色架构关系示意图');
  assert.strictEqual(visionCalls.length, 1, 'content-addressed display descriptions are cached per validated deployment');

  const runId = 'display-image-run';
  agent.emitWorkEvent({ type: 'start', content: 'start', runId });
  agent.emitWorkEvent({ type: 'tool_call', content: 'call', runId, toolName: 'image_display', toolCallId: 'display-call', toolArgs: JSON.stringify({ path: 'architecture.png' }) });
  agent.emitWorkEvent({ type: 'tool_result', content: 'done', runId, toolName: 'image_display', toolCallId: 'display-call', displayImage: hydrated });
  agent.emitWorkEvent({ type: 'done', content: 'complete', runId });
  const snapshot = agent.getConversationSnapshot();
  const event = snapshot.workRuns.find(run => run.runId === runId)?.events.find(item => item.displayImage);
  assert.ok(event?.displayImage?.dataUrl?.startsWith('data:image/png;base64,'), 'live snapshot hydrates the displayed image for GUI/TUI rendering');

  const diskState = fs.readFileSync(path.join(root, 'Work', 'State.json'), 'utf8');
  assert.ok(!diskState.includes('data:image/'), 'persisted conversation state stores only the content-addressed image reference');
  assert.match(agent.handleImageDisplay(JSON.stringify({ path: path.join(base, 'outside.png') })), /not found|inside the active workspace/i, 'display tool rejects paths outside the active workspace');

  const ui = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
  assert.ok(ui.includes('work-run-collapsed-images') && ui.includes('renderWorkDisplayImage') && ui.includes('normalizeWorkDisplayImage'), 'GUI renders inline and collapsed Build image surfaces');
  process.stdout.write('Display image verification passed.\n');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
