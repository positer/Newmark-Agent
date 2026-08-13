import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { redactCliSecrets, runCliCommand } from '../cli-commands';
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

async function verifyCommandHelp(root: string): Promise<void> {
  const commands = ['state', 'tool', 'send', 'validate-models', 'fuzzy-inject', 'skills-market', 'memory-lab', 'install-update', 'compat', 'compat-tool'];
  const configBefore = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
  for (const command of commands) {
    const started = performance.now();
    const capture = await captureCli(root, [command, '--help', '--root', root]);
    const elapsedMs = performance.now() - started;
    assert.strictEqual(capture.exitCode, 0, `${command} --help exits successfully`);
    assert.strictEqual(capture.stderr, '', `${command} --help is silent on stderr`);
    assert.match(capture.stdout, new RegExp(`Usage: Newmark\\.exe ${command.replace('-', '\\-')}`), `${command} --help prints command usage`);
    assert.match(capture.stdout, /--help, -h/, `${command} --help documents its terminating help flag`);
    assert.ok(elapsedMs < 250, `${command} --help is local and fast (${Math.round(elapsedMs)}ms)`);
  }
  assert.strictEqual(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), configBefore, 'command help does not mutate the runtime config');
}

function parseEnvelope(capture: CliCapture): Record<string, any> {
  assert.strictEqual(capture.stderr, '', `tool command must keep stderr empty: ${capture.stderr}`);
  return JSON.parse(capture.stdout) as Record<string, any>;
}

function toolNames(definitions: unknown[]): string[] {
  return definitions.map((definition: any) => String(definition?.function?.name || '')).filter(Boolean);
}

async function verifyCliContract(root: string): Promise<void> {
  const unknownArgument = await captureCli(root, ['state', '--definitely-unknown', '--root', root]);
  assert.strictEqual(unknownArgument.exitCode, 2, 'unknown CLI flags fail closed instead of starting a long-lived surface');
  assert.match(unknownArgument.stderr, /Invalid Newmark argument|definitely-unknown/i);

  const missingValue = await captureCli(root, ['state', '--root']);
  assert.strictEqual(missingValue.exitCode, 2, 'missing CLI option values fail closed instead of falling back to the user root');
  assert.match(missingValue.stderr, /requires a value|--root/i);

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

  const contextStatus = await captureCli(root, ['tool', 'context_history_manage', JSON.stringify({ action: 'status' }), '--root', root]);
  const contextStatusEnvelope = parseEnvelope(contextStatus);
  assert.strictEqual(contextStatus.exitCode, 0, 'direct context_history_manage status uses the Agent-owned context handler');
  assert.strictEqual(contextStatusEnvelope.ok, true);
  assert.strictEqual(contextStatusEnvelope.result?.action, 'status');

  const emptyCompression = await captureCli(root, ['tool', 'context_compress', JSON.stringify({ force: true }), '--root', root]);
  const emptyCompressionEnvelope = parseEnvelope(emptyCompression);
  assert.strictEqual(emptyCompression.exitCode, 4, 'direct context_compress reports an Agent context failure instead of Unknown tool');
  assert.strictEqual(emptyCompressionEnvelope.ok, false);
  assert.match(String(emptyCompressionEnvelope.error || ''), /context_compress|No context/i);

  const unknown = await captureCli(root, ['tool', 'not_a_tool', '{}', '--root', root]);
  assert.strictEqual(unknown.exitCode, 2, 'unknown tools are unsupported, not successful execution');
  assert.match(String(parseEnvelope(unknown).error || ''), /unknown|unsupported|available/i);

  const emptyProviderSend = await captureCli(root, ['send', 'send must fail without a configured provider', '--agent-only', '--root', root]);
  assert.strictEqual(emptyProviderSend.exitCode, 1, 'send reports an Agent error as a non-zero CLI exit');
  assert.match(emptyProviderSend.stdout, /No LLM configured/i, 'send keeps the actionable missing-provider diagnostic in stdout');

  const invalidModelConfig = new ConfigManager(root);
  const invalidModelProvider = invalidModelConfig.upsertProvider(
    'CLI invalid-model fixture',
    'http://127.0.0.1:9/v1',
    'fixture-key-not-a-secret',
    'openai',
  );
  assert.ok(
    invalidModelConfig.addModelToProvider(
      invalidModelProvider,
      'valid-fixture-model',
      'Valid Fixture Model',
      'Deterministic CLI contract model',
    ),
    'invalid-model fixture registers a configured fallback model',
  );
  invalidModelConfig.set('models', 'fallback_on_unavailable', false);
  const invalidModelSend = await captureCli(root, [
    'send',
    'invalid model must fail closed',
    '--agent-only',
    '--model',
    'MissingProvider/missing-model',
    '--root',
    root,
  ]);
  assert.strictEqual(invalidModelSend.exitCode, 1, 'an explicitly unavailable model returns a non-zero CLI exit');
  assert.match(
    invalidModelSend.stdout,
    /unavailable|not configured|MissingProvider\/missing-model/i,
    'invalid model keeps a machine-visible diagnostic',
  );

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

  const compatAll = await captureCli(root, ['compat', '--target', 'all', '--root', root]);
  assert.strictEqual(compatAll.exitCode, 0, 'compatibility discovery succeeds from an isolated root');
  assert.ok(
    !/\bsk-[A-Za-z0-9_.-]{8,}\b/i.test(compatAll.stdout)
      && !/\bBearer\s+[A-Za-z0-9_.=:/+_-]{8,}/i.test(compatAll.stdout),
    'compatibility discovery redacts provider credentials from third-party metadata',
  );
  const compatTools = await captureCli(root, ['compat-tool', '--list', '--root', root]);
  assert.ok(
    !/\bsk-[A-Za-z0-9_.-]{8,}\b/i.test(compatTools.stdout)
      && !/\bBearer\s+[A-Za-z0-9_.=:/+_-]{8,}/i.test(compatTools.stdout),
    'compatibility tool listing redacts provider credentials',
  );

  const nestedCredential = redactCliSecrets({
    plugins: [{ rawManifest: { provider: { deepseek: { options: { apiKey: 'sk-test-secret-12345678' } } } } }],
    authorization: 'Bearer test-token-12345678',
    endpoint: 'https://example.test/v1?api_key=test-token-12345678',
  }) as any;
  assert.strictEqual(nestedCredential.plugins[0].rawManifest.provider.deepseek.options.apiKey, '[REDACTED]');
  assert.strictEqual(nestedCredential.authorization, '[REDACTED]');
  assert.strictEqual(nestedCredential.endpoint, 'https://example.test/v1?api_key=<redacted>');
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
    await verifyCommandHelp(root);
    await verifyCliContract(root);
    await verifyCatalogFiltering(root);
    await verifyToolExecutorValidation(root);
    await verifyHostPolicy(root);
    console.log(JSON.stringify({ ok: true, assertions: 46 }));
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
