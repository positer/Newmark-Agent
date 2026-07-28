import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { Agent } from '../core/agent';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`GUI/TUI/CLI shared-backend stress failed: ${message}`);
}

function startMockProvider(): Promise<{
  server: http.Server;
  port: number;
  requests: string[];
}> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push(body);
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'shared-backend-stress-model' }] }));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      let parsed: { messages?: Array<{ role?: string; content?: unknown }> } = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const lastUser = [...(parsed.messages || [])].reverse().find(message => message.role === 'user');
      const text = typeof lastUser?.content === 'string'
        ? lastUser.content
        : JSON.stringify(lastUser?.content || '');
      const marker = (text.match(/SURFACE_[A-Z]+_[A-Z0-9_-]+/) || ['SURFACE_UNKNOWN'])[0];
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `REPLY_${marker}` } }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0, requests });
    });
  });
}

function writeRuntime(root: string, port: number): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'agent.md'), '# Stress Agent\n\nReturn the requested marker without tools.\n', 'utf8');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: {
      providers: [{
        id: 'provider-shared-backend-stress',
        name: 'Shared Backend Stress',
        base_url: `http://127.0.0.1:${port}/v1`,
        api_key: 'local-mock-key',
        protocol: 'openai',
        enabled: true,
        api_mode: 'chat',
        models: [{
          name: 'shared-backend-stress-model',
          display: 'Shared Backend Stress Model',
          enabled: true,
          max_tokens: 8192,
        }],
      }],
      default_model: 'shared-backend-stress-model',
      auto_switch: false,
      fallback_on_unavailable: false,
      agent_engine: 'builtin',
    },
    agent: {
      default_mode: 'build',
      option_feedback: 'fully_autonomous',
    },
    general: {
      language: 'en',
      default_input: 'guide',
    },
    workspace: {
      auto_create_timestamp_workspace: false,
      access_permission: 'full_access',
      on_permission_violation: 'deny',
    },
  }, null, 2), 'utf8');
}

function runCli(distRoot: string, root: string, conversationId: string, marker: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(distRoot, 'launcher.js'),
      'send',
      marker,
      '--root', root,
      '--conversation', conversationId,
      '--agent-only',
    ], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timeout for ${conversationId}`));
    }, 90_000);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`CLI ${conversationId} exited ${code}: ${stderr}`));
      else resolve(stdout);
    });
  });
}

async function main(): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-gui-tui-cli-stress-'));
  const root = path.join(base, 'runtime');
  const workspacePath = path.join(base, 'workspace');
  const distRoot = path.resolve(__dirname, '..');
  const tuiAdapterPath = path.resolve(distRoot, 'tui', 'src', 'adapters', 'core-runtime-adapter.js');
  fs.mkdirSync(workspacePath, { recursive: true });
  const provider = await startMockProvider();
  writeRuntime(root, provider.port);
  let tui: {
    getInitialTarget(): { workspaceId: string; conversationId: string };
    sendMessage(message: string, target: { workspaceId: string; conversationId: string }): Promise<Record<string, unknown>>;
    getState(target: { workspaceId: string; conversationId: string }): any;
    setConversationModel(selection: Record<string, unknown>, target: { workspaceId: string; conversationId: string }): any;
    close(): void;
  } | null = null;
  try {
    const { createCoreRuntimeAdapter } = require(tuiAdapterPath) as {
      createCoreRuntimeAdapter(options: Record<string, unknown>): typeof tui;
    };
    tui = createCoreRuntimeAdapter({ root, workspacePath, desktopDist: distRoot });
    assert(tui, 'TUI adapter did not initialize');
    const initial = tui.getInitialTarget();
    const workspaceId = initial.workspaceId;
    const perSurface = 6;
    const expected = new Map<string, string>();

    const tuiRuns = Array.from({ length: perSurface }, (_, index) => {
      const conversationId = `stress-tui-${index}`;
      const marker = `SURFACE_TUI_${index}`;
      expected.set(conversationId, marker);
      return tui!.sendMessage(marker, { workspaceId, conversationId });
    });

    const guiRuns = Array.from({ length: perSurface }, async (_, index) => {
      const conversationId = `stress-gui-${index}`;
      const marker = `SURFACE_GUI_${index}`;
      expected.set(conversationId, marker);
      const guiAgent = new Agent(root, { agentOnly: true, conversationId });
      guiAgent.selectWorkspaceFromStorage(workspaceId);
      guiAgent.setConversationFromStorage(conversationId);
      await guiAgent.process(marker);
      guiAgent.flushConversationState();
    });

    const cliRuns = Array.from({ length: perSurface }, (_, index) => {
      const conversationId = `stress-cli-${index}`;
      const marker = `SURFACE_CLI_${index}`;
      expected.set(conversationId, marker);
      return runCli(distRoot, root, conversationId, marker, workspacePath);
    });

    await Promise.all([...tuiRuns, ...guiRuns, ...cliRuns]);

    const audit = new Agent(root, { agentOnly: true });
    audit.selectWorkspaceFromStorage(workspaceId);
    for (const [conversationId, marker] of expected) {
      const snapshot = audit.getConversationSnapshot(conversationId);
      const transcript = snapshot.chatMessages.map(message => String(message.content || '')).join('\n');
      assert(transcript.includes(marker), `${conversationId} lost its user marker`);
      assert(transcript.includes(`REPLY_${marker}`), `${conversationId} lost its provider reply`);
      assert(![...expected.entries()].some(([otherId, otherMarker]) =>
        otherId !== conversationId && transcript.includes(otherMarker)
      ), `${conversationId} leaked another conversation marker`);
    }

    const sharedId = 'stress-shared-roundtrip';
    const sharedTarget = { workspaceId, conversationId: sharedId };
    const guiShared = new Agent(root, { agentOnly: true, conversationId: sharedId });
    guiShared.selectWorkspaceFromStorage(workspaceId);
    guiShared.setConversationFromStorage(sharedId);
    await guiShared.process('SURFACE_GUI_SHARED');
    await runCli(distRoot, root, sharedId, 'SURFACE_CLI_SHARED', workspacePath);
    await tui.sendMessage('SURFACE_TUI_SHARED', sharedTarget);

    const sharedSnapshot = tui.getState(sharedTarget);
    const sharedTranscript = sharedSnapshot.chatMessages.map((message: { content?: unknown }) => String(message.content || '')).join('\n');
    for (const marker of ['SURFACE_GUI_SHARED', 'SURFACE_CLI_SHARED', 'SURFACE_TUI_SHARED']) {
      assert(sharedTranscript.includes(marker), `shared conversation lost ${marker}`);
      assert(sharedTranscript.includes(`REPLY_${marker}`), `shared conversation lost REPLY_${marker}`);
    }

    const modelTarget = { workspaceId, conversationId: 'stress-model-fixed' };
    const autoTarget = { workspaceId, conversationId: 'stress-model-auto' };
    tui.setConversationModel({
      kind: 'deployment',
      providerId: 'provider-shared-backend-stress',
      modelId: 'shared-backend-stress-model',
    }, modelTarget);
    tui.setConversationModel({ kind: 'auto' }, autoTarget);
    assert(tui.getState(modelTarget).modelSelection.kind === 'deployment', 'fixed conversation model was not persisted');
    assert(tui.getState(autoTarget).modelSelection.kind === 'auto', 'auto conversation model was not isolated');

    const statePath = path.join(workspacePath, 'conversations', 'state.json');
    const stored = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { conversations?: Record<string, unknown> };
    assert(Object.keys(stored.conversations || {}).length >= expected.size + 3, 'durable state did not retain the stress conversation count');
    assert(provider.requests.length >= expected.size + 3, 'mock provider did not observe all surface requests');

    process.stdout.write(
      `GUI/TUI/CLI shared-backend stress: ${expected.size} parallel isolated conversations + 3-surface shared roundtrip + model isolation passed (${provider.requests.length} provider requests)\n`
    );
  } finally {
    try { tui?.close(); } catch {}
    await new Promise<void>(resolve => provider.server.close(() => resolve()));
    let cleanupRoot = base;
    const renamedCleanupRoot = `${base}-cleanup-${process.pid}`;
    try {
      fs.renameSync(base, renamedCleanupRoot);
      cleanupRoot = renamedCleanupRoot;
    } catch {}
    let cleanupError: unknown = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        fs.rmSync(cleanupRoot, { recursive: true, force: true });
        cleanupError = null;
        break;
      } catch (error) {
        cleanupError = error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    if (cleanupError) throw cleanupError;
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
