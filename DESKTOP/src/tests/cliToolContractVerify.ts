import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCliCommand } from '../cli-commands';
import { ConfigManager } from '../core/config';
import { createUtilityHostToolHandler } from '../core/utilityHostToolRouter';
import {
  configureWslHostToolWriter,
  requestWindowsHostTool,
  settleWslHostToolResult,
} from '../core/wslHostToolBridge';
import { ToolExecutor } from '../tools';

interface CliCapture {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function captureCli(root: string, args: string[]): Promise<CliCapture> {
  let stdout = '';
  let stderr = '';
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.exitCode = 0;
  (process.stdout.write as unknown as (chunk: unknown) => boolean) = (chunk: unknown) => {
    stdout += String(chunk);
    return true;
  };
  (process.stderr.write as unknown as (chunk: unknown) => boolean) = (chunk: unknown) => {
    stderr += String(chunk);
    return true;
  };
  try {
    await runCliCommand(root, args);
    return { stdout, stderr, exitCode: Number(process.exitCode || 0) };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    process.exitCode = 0;
  }
}

function parseEnvelope(capture: CliCapture): Record<string, any> {
  assert.strictEqual(capture.stderr, '', `tool command must keep stderr empty: ${capture.stderr}`);
  return JSON.parse(capture.stdout) as Record<string, any>;
}

function toolNames(definitions: unknown[]): string[] {
  return definitions.map((definition: any) => String(definition?.function?.name || '')).filter(Boolean);
}

async function verifyCliContract(root: string): Promise<void> {
  const invalidJson = await captureCli(root, ['tool', 'write', '{bad-json', '--root', root]);
  assert.strictEqual(invalidJson.exitCode, 2, 'malformed JSON is a validation error');
  assert.deepStrictEqual(
    { ok: parseEnvelope(invalidJson).ok, tool: parseEnvelope(invalidJson).tool },
    { ok: false, tool: 'write' },
  );

  const missingRequired = await captureCli(root, ['tool', 'write', JSON.stringify({ path: path.join(root, 'missing.txt') }), '--root', root]);
  assert.strictEqual(missingRequired.exitCode, 2, 'missing required fields are rejected before execution');
  assert.match(String(parseEnvelope(missingRequired).error || ''), /content|required/i);
  assert.ok(!fs.existsSync(path.join(root, 'missing.txt')));

  const wrongType = await captureCli(root, ['tool', 'write', JSON.stringify({ path: path.join(root, 'wrong.txt'), content: 7 }), '--root', root]);
  assert.strictEqual(wrongType.exitCode, 2, 'wrong JSON types are rejected');
  assert.match(String(parseEnvelope(wrongType).error || ''), /content|string/i);

  const unknownEnum = await captureCli(root, ['tool', 'terminal_takeover', JSON.stringify({ action: 'launch_missiles' }), '--root', root]);
  assert.strictEqual(unknownEnum.exitCode, 2, 'unknown enum values are rejected');
  assert.match(String(parseEnvelope(unknownEnum).error || ''), /action|enum/i);

  const additionalField = await captureCli(root, ['tool', 'pwd', JSON.stringify({ surprise: true }), '--root', root]);
  assert.strictEqual(additionalField.exitCode, 2, 'additional fields are rejected by closed tool schemas');
  assert.match(String(parseEnvelope(additionalField).error || ''), /surprise|additional/i);

  const planPath = path.join(root, 'plan-blocked.txt');
  const planWrite = await captureCli(root, ['tool', 'write', JSON.stringify({ path: planPath, content: 'blocked' }), '--mode', 'plan', '--root', root]);
  assert.strictEqual(planWrite.exitCode, 3, 'direct tools report Plan policy denial as exit 3');
  assert.match(String(parseEnvelope(planWrite).error || ''), /Plan mode|permission/i);
  assert.ok(!fs.existsSync(planPath), 'Plan mode policy runs before tool side effects');

  const success = await captureCli(root, ['tool', 'pwd', '{}', '--mode', 'build', '--root', root]);
  const successEnvelope = parseEnvelope(success);
  assert.strictEqual(success.exitCode, 0);
  assert.strictEqual(successEnvelope.ok, true);
  assert.strictEqual(successEnvelope.tool, 'pwd');
  assert.ok(successEnvelope.result, 'successful direct tool returns result in the common envelope');

  const unknown = await captureCli(root, ['tool', 'not_a_tool', '{}', '--root', root]);
  assert.strictEqual(unknown.exitCode, 2, 'unknown tools are unsupported, not successful execution');
  assert.match(String(parseEnvelope(unknown).error || ''), /unknown|unsupported|available/i);

  const browserUnavailable = await captureCli(root, ['tool', 'browser_open', JSON.stringify({ url: 'https://example.com' }), '--root', root]);
  assert.strictEqual(browserUnavailable.exitCode, 3, 'CLI-only Electron Browser capability is unavailable, not an unknown tool');
  assert.match(String(parseEnvelope(browserUnavailable).error || ''), /unsupported|available/i);

  if (process.platform === 'win32') {
    await captureCli(root, ['tool', 'computer_use', JSON.stringify({ action: 'takeover_stop' }), '--root', root]);
    const semanticFailure = await captureCli(root, ['tool', 'computer_use', JSON.stringify({ action: 'click', target_id: 'never-observed', dry_run: true }), '--root', root]);
    assert.strictEqual(semanticFailure.exitCode, 4, 'a tool result with ok:false exits 4');
    const semanticEnvelope = parseEnvelope(semanticFailure);
    assert.strictEqual(semanticEnvelope.ok, false);
    assert.strictEqual(semanticEnvelope.tool, 'computer_use');
    assert.ok(semanticEnvelope.error);
    await captureCli(root, ['tool', 'computer_use', JSON.stringify({ action: 'takeover_stop' }), '--root', root]);
  }
}

async function verifyCatalogFiltering(root: string): Promise<void> {
  const tools = new ToolExecutor(root, new ConfigManager(root));
  (tools as any).setHostProfile({ kind: 'cli', platform: 'win32', electronBrowser: false, windowsComputerUse: true });
  const cliNames = toolNames(tools.definitions('build'));
  assert.ok(!cliNames.some(name => name.startsWith('browser_')), 'pure CLI catalog hides Electron Browser tools');
  assert.ok(cliNames.includes('computer_use'), 'Windows CLI catalog retains native ComputerUse');

  (tools as any).setHostProfile({ kind: 'wsl', platform: 'linux', electronBrowser: false, windowsComputerUse: false });
  const wslNames = toolNames(tools.definitions('build'));
  assert.ok(!wslNames.some(name => name.startsWith('browser_')), 'WSL catalog hides Electron Browser tools');
  assert.ok(!wslNames.includes('computer_use'), 'WSL catalog hides Windows ComputerUse');

  (tools as any).setHostProfile({ kind: 'cli', platform: 'win32', electronBrowser: false, windowsComputerUse: true });
  const planComputer = (tools.definitions('plan') as any[]).find(tool => tool.function?.name === 'computer_use');
  assert.deepStrictEqual(planComputer?.function?.parameters?.properties?.action?.enum, ['observe', 'app_list', 'app_observe']);

  const cliList = await captureCli(root, ['tool', '--list', '--mode', 'build', '--root', root]);
  const listEnvelope = parseEnvelope(cliList);
  assert.strictEqual(cliList.exitCode, 0);
  assert.strictEqual(listEnvelope.ok, true);
  const listedNames = (listEnvelope.result?.tools || []).map((tool: any) => String(tool.name || ''));
  assert.ok(!listedNames.some((name: string) => name.startsWith('browser_')));
  if (process.platform !== 'win32') assert.ok(!listedNames.includes('computer_use'));
}

async function verifyToolExecutorValidation(root: string): Promise<void> {
  const tools = new ToolExecutor(root, new ConfigManager(root));
  const malformed = await tools.execute('write', '{bad-json', root, { mode: 'build', invocation: 'cli' });
  assert.match(malformed, /schema|JSON|argument/i, 'ToolExecutor itself rejects malformed JSON instead of using {}');
  const missing = await tools.execute('write', JSON.stringify({ path: path.join(root, 'executor-missing.txt') }), root, { mode: 'build', invocation: 'cli' });
  assert.match(missing, /schema|content|required/i, 'ToolExecutor itself validates required fields');
  assert.ok(!fs.existsSync(path.join(root, 'executor-missing.txt')));
}

async function verifyHostPolicy(root: string): Promise<void> {
  let windowsHostWrites = 0;
  configureWslHostToolWriter(value => {
    const envelope = value as { event?: string; data?: { requestId?: string } };
    if (envelope.event !== 'host_tool_request' || !envelope.data?.requestId) return;
    windowsHostWrites += 1;
    settleWslHostToolResult({ requestId: envelope.data.requestId, ok: true, result: { ok: true } });
  });
  try {
    await assert.rejects(
      requestWindowsHostTool('computer_use', { action: 'click', x: 1, y: 1 }, {
        conversationId: 'plan-conversation',
        workspaceId: 'plan-workspace',
        actorId: 'root',
        runtimeKey: 'plan-runtime',
        mode: 'plan',
      }),
      /Plan mode|permission/i,
    );
    assert.strictEqual(windowsHostWrites, 0, 'WSL bridge rejects hidden Plan actions before host dispatch');
  } finally {
    configureWslHostToolWriter(null);
  }

  let computerRuns = 0;
  const handler = createUtilityHostToolHandler({
    persistenceRoot: root,
    runAutomation: () => JSON.stringify({ ok: true }),
    runComputer: async options => {
      computerRuns += 1;
      return JSON.stringify({ ok: true, action: options.action });
    },
  });
  const target = {
    workspaceId: 'workspace-host-policy',
    conversationId: 'conversation-host-policy',
    runtimeKey: 'workspace:host-policy::conversation:host-policy',
    workspaceKey: 'workspace:host-policy',
    workspacePath: root,
  };
  const context = {
    conversationId: target.conversationId,
    workspaceId: target.workspaceId,
    actorId: '00000000-0000-4000-8000-000000000001',
    workspacePath: root,
    backend: 'utility',
    mode: 'plan',
    runtimeKey: target.runtimeKey,
  };
  await assert.rejects(
    handler({ requestId: 'host-policy-click', tool: 'computer_use', args: { action: 'click', x: 1, y: 1 }, context, target }),
    /Plan mode|permission/i,
  );
  assert.strictEqual(computerRuns, 0, 'Electron host repeats policy checks before native execution');
  const observed = await handler({ requestId: 'host-policy-observe', tool: 'computer_use', args: { action: 'observe' }, context, target });
  assert.match(String(observed), /"ok":true|"ok": true/);
  assert.strictEqual(computerRuns, 1, 'Plan observation remains available after host revalidation');
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-cli-tool-contract-'));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      workspace: {
        auto_create_timestamp_workspace: false,
        prompt_mode: 'global_only',
        access_permission: 'full_access',
      },
      models: { providers: [], default_model: '' },
    }, null, 2));
    await verifyCliContract(root);
    await verifyCatalogFiltering(root);
    await verifyToolExecutorValidation(root);
    await verifyHostPolicy(root);
    console.log(JSON.stringify({ ok: true, assertions: 32 }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  error => {
    console.error(error);
    process.exit(1);
  },
);
