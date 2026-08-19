import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agentKernelRunnerInternals, routeToolSurfaceV2 } from '../core/agentKernelRunner';
import { ConfigManager } from '../core/config';
import { Agent } from '../core/agent';
import { defaultComputerUseSessionRegistry } from '../core/computerUseSession';
import { ToolExecutor } from '../tools';
import { stopComputerUsePowerShellHost } from '../tools/computerUsePowerShellHost';

function screenshotResidue(): string[] {
  const directory = path.join(os.tmpdir(), 'newmark-computer-use');
  try { return fs.readdirSync(directory).filter(name => /^(observe|app)-.*\.jpg$/i.test(name)); } catch { return []; }
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-screen-capture-independent-'));
  try {
    const tools = new ToolExecutor(root, new ConfigManager(root));
    tools.setHostProfile({ kind: 'desktop', platform: process.platform, electronBrowser: true, windowsComputerUse: process.platform === 'win32' });
    const definitions = tools.definitions('build') as any[];
    const surface = routeToolSurfaceV2({ shouldExposeToolInterface: () => true, runtimeActorId: 'screen-test', activeConversationId: 'screen-test', history: [] } as any, definitions, null, '主动截图');
    const initialNames = surface.definitions.map((definition: any) => definition.function?.name);
    assert.ok(!initialNames.includes('screen_capture'), 'screen_capture remains an advanced provision-only tool');
    assert.ok(!initialNames.includes('computer_use'), 'full computer_use remains provision-only');

    if (process.platform !== 'win32') {
      console.log('screen_capture independent native checks skipped outside Windows');
      return;
    }

    const context = {
      mode: 'build', workspacePath: root, workspaceId: 'screen-workspace', conversationId: 'screen-conversation', actorId: 'root', allowEphemeralVisionImage: true,
    };
    const stateBefore = defaultComputerUseSessionRegistry.state('workspace:screen-workspace::conversation:screen-conversation');
    const residueBefore = new Set(screenshotResidue());
    const elapsed: number[] = [];
    for (let index = 0; index < 20; index++) {
      const started = Date.now();
      const raw = await tools.execute('screen_capture', JSON.stringify({ target: 'desktop', capture_max_width: 1280, capture_max_height: 960 }), root, context);
      elapsed.push(Date.now() - started);
      const parsed = JSON.parse(raw) as Record<string, any>;
      assert.strictEqual(parsed.ok, true, `screen_capture iteration ${index} succeeds`);
      assert.strictEqual(parsed.action, 'observe');
      assert.ok(Number(parsed.image_width) > 0 && Number(parsed.image_width) <= 1280);
      assert.ok(Number(parsed.image_height) > 0 && Number(parsed.image_height) <= 960);
      const imagePath = String(parsed.vision_image_path || '');
      assert.ok(imagePath && fs.existsSync(imagePath), 'trusted vision capture retains one ephemeral frame');
      const visible = agentKernelRunnerInternals.sanitizeVisualToolText('screen_capture', raw);
      assert.ok(!visible.includes(imagePath) && !visible.includes('vision_image_path'), 'public result hides the ephemeral path');
      const input = agentKernelRunnerInternals.computerUseVisionImageInput({ activeModelConfig: () => ({ vision: true }) } as any, 'screen_capture', raw);
      assert.ok(input.image?.startsWith('data:image/jpeg;base64,'), 'frame becomes a standard one-use vision input');
      assert.ok(!fs.existsSync(imagePath), 'frame is deleted after model-input preparation');
      if (index === 0) {
        const agent = new Agent(root);
        agent.config.upsertProvider('VisionFixture', 'https://vision.invalid/v1', 'test-only', 'openai');
        agent.config.addModelToProvider('VisionFixture', 'vision-fixture', 'Vision Fixture', 'Test-only vision model');
        agent.config.updateModel('VisionFixture', 'vision-fixture', { vision: true, max_tokens: 4096 });
        agent.setModel('vision-fixture');
        const attachment = agent.registerCapturedImageInput(String(input.image), 'active-screenshot.jpg');
        assert.ok(attachment?.id.startsWith('user-image-'), 'captured frame enters the same content-addressed user-image channel');
        const info = JSON.parse(await agent.handleImageInspect(JSON.stringify({ action: 'source_info', attachment_id: attachment?.id })));
        assert.strictEqual(info.attachment_id, attachment?.id, 'image_inspect resolves the captured input by stable attachment id');
        const cropWidth = Math.max(1, Math.min(100, Math.floor(info.width / 2)));
        const cropHeight = Math.max(1, Math.min(100, Math.floor(info.height / 2)));
        const crop = JSON.parse(await agent.handleImageInspect(JSON.stringify({ action: 'crop', attachment_id: attachment?.id, x: 0, y: 0, width: cropWidth, height: cropHeight, scale: 4 })));
        assert.ok(String(crop.image_data_url).startsWith('data:image/png;base64,'), 'captured input supports second-stage crop and magnification');
        assert.ok(Number(crop.output?.scale) >= 1 && Number(crop.output?.scale) <= 4, 'magnification remains within the 1-4x contract');
      }
    }
    const stateAfter = defaultComputerUseSessionRegistry.state('workspace:screen-workspace::conversation:screen-conversation');
    assert.deepStrictEqual(stateAfter, stateBefore, 'screen_capture does not acquire or mutate the Computer Use lease');
    const leaked = screenshotResidue().filter(name => !residueBefore.has(name));
    assert.deepStrictEqual(leaked, [], '20-shot pressure leaves no temporary screenshot residue');
    // Windows Defender/process-start jitter can add roughly 1% while the full
    // release suite is saturating the host. Keep a strict bounded cold-start
    // gate with 20% scheduling headroom; the warm path remains capped at 2s.
    assert.ok(elapsed[0] < 12_000, `cold screen_capture remains bounded: ${JSON.stringify(elapsed)}`);
    assert.ok(Math.max(...elapsed.slice(1)) < 2_000, `warm screen_capture remains bounded: ${JSON.stringify(elapsed)}`);
    console.log(JSON.stringify({ ok: true, iterations: elapsed.length, elapsedMs: elapsed, coldMs: elapsed[0], warmMaxMs: Math.max(...elapsed.slice(1)), computerUseLeaseUnchanged: true, residue: leaked.length }));
  } finally {
    stopComputerUsePowerShellHost();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
