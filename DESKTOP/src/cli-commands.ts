import * as path from 'path';
import * as fs from 'fs';
import { Agent, AgentMode } from './core/agent';
import { ProviderProtocol, inferProviderProtocol } from './core/config';
import { fuzzyCandidateModels, fuzzyDiscoverWithoutGuide, providerNameFromUrl, tokenizeFuzzyProviderInput } from './core/fuzzy';
import { LLMProvider } from './llm/provider';
import { discoverAgentPresets, discoverOpenCodeTools, discoverPluginManifests, discoverPluginMarketplaces, runOpenCodeTool } from './core/compat';
import { MemoryLabManager } from './core/memoryLab';
import { applyGitHubUpdate, checkGitHubUpdate, currentAppVersion, installUpdate } from './core/installUpdate';

type JsonObject = Record<string, unknown>;
type FuzzyEnvDefaults = {
  name?: string;
  url?: string;
  key?: string;
  protocol?: ProviderProtocol;
  models?: string[];
};

export const CLI_COMMANDS = ['state', 'tool', 'send', 'validate-models', 'fuzzy-inject', 'skills-market', 'memory-lab', 'install-update', 'compat', 'compat-tool'] as const;

function argValue(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function pathArgValue(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  if (idx < 0 || idx + 1 >= args.length) return undefined;
  const parts: string[] = [];
  for (let i = idx + 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) break;
    parts.push(arg);
  }
  return parts.join(' ') || undefined;
}

function argValueFromEnv(args: string[], ...keys: string[]): string | undefined {
  for (const key of keys) {
    const direct = argValue(args, key);
    if (direct) return direct;
  }
  for (const key of keys.map(k => `${k}-env`)) {
    const envName = argValue(args, key);
    if (envName && process.env[envName]) return process.env[envName];
  }
  return undefined;
}

function positionalAfter(args: string[], commandName: string): string[] {
  const start = args.indexOf(commandName);
  if (start < 0) return [];
  const values: string[] = [];
  for (let i = start + 1; i < args.length; i++) {
    const arg = args[i];
    if ([
      '--root',
      '--input',
      '--input-env',
      '--input-file',
      '--mode',
      '--model',
      '--language',
      '--conversation',
      '--args',
      '--args-file',
      '--selected',
      '--models',
      '--name',
      '--url',
      '--key',
      '--api-key',
      '--endpoint',
      '--endpoint-env',
      '--url-env',
      '--key-env',
      '--api-key-env',
      '--env-file',
      '--env-file-env',
      '--claude-env-file',
      '--claude-env-file-env',
      '--anthropic-env-file',
      '--anthropic-env-file-env',
      '--candidate-models',
      '--protocol',
      '--query',
      '--type',
      '--path',
      '--source-id',
      '--remove-source',
      '--enable-source',
      '--disable-source',
      '--source',
      '--target',
      '--target-file',
      '--expected-version',
      '--preserve',
      '--repo',
      '--tag',
      '--asset',
      '--list',
    ].includes(arg)) { i++; continue; }
    if (!arg.startsWith('--')) values.push(arg);
  }
  return values;
}

function parseJsonObject(raw: string | undefined): { ok: true; value: JsonObject } | { ok: false; error: string } {
  if (!raw) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, value: parsed as JsonObject };
    return { ok: false, error: 'Expected a JSON object.' };
  } catch {
    return { ok: false, error: 'Invalid JSON object.' };
  }
}

function parseToolArgs(tokens: string[], rawInput: string | undefined): { ok: true; value: JsonObject } | { ok: false; error: string } {
  if (rawInput) return parseJsonObject(rawInput);
  const first = tokens[0];
  if (!first) return { ok: true, value: {} };
  if (first.trim().startsWith('{')) return parseJsonObject(first);

  const result: JsonObject = {};
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq <= 0) {
      return { ok: false, error: `Tool arguments must be JSON or key=value pairs. Bad token: ${token}` };
    }
    const key = token.slice(0, eq).trim();
    const value = token.slice(eq + 1);
    if (!key) return { ok: false, error: `Empty key in token: ${token}` };
    result[key] = value;
  }
  return { ok: true, value: result };
}

function argsAfterOption(args: string[], key: string): string[] {
  const idx = args.indexOf(key);
  if (idx < 0) return [];
  const values: string[] = [];
  for (let i = idx + 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--root') { i++; continue; }
    if (arg.startsWith('--')) break;
    values.push(arg);
  }
  return values;
}

function argValueFromFile(args: string[], key: string): string | undefined {
  const filePath = argValue(args, key);
  if (!filePath) return undefined;
  return fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
}

function printJson(value: unknown): void {
  safeStdout(`${JSON.stringify(value, null, 2)}\n`);
}

type CliToolExitCode = 0 | 2 | 3 | 4 | 130;

interface CliToolEnvelope {
  ok: boolean;
  tool: string;
  result?: unknown;
  error?: string;
  route?: string;
}

function emitCliToolEnvelope(envelope: CliToolEnvelope, exitCode: CliToolExitCode): void {
  printJson(envelope);
  process.exitCode = exitCode;
}

function parsedToolOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return output;
  try { return JSON.parse(trimmed); } catch { return output; }
}

function classifyCliToolOutput(tool: string, output: string): { envelope: CliToolEnvelope; exitCode: CliToolExitCode } {
  const result = parsedToolOutput(output);
  if (result && typeof result === 'object' && !Array.isArray(result) && (result as JsonObject).ok === false) {
    const error = String((result as JsonObject).error || `${tool} reported an unsuccessful result.`);
    return { envelope: { ok: false, tool, error, route: 'direct' }, exitCode: 4 };
  }
  const firstLine = output.trim().split(/\r?\n/, 1)[0] || `${tool} failed.`;
  if (/^\[(?:tool schema error|\?)]/i.test(firstLine)) {
    return { envelope: { ok: false, tool, error: firstLine, route: 'direct' }, exitCode: 2 };
  }
  if (/^\[tool unsupported]/i.test(firstLine)) {
    const unavailableHostCapability = tool === 'computer_use' || tool.startsWith('browser_');
    return { envelope: { ok: false, tool, error: firstLine, route: 'direct' }, exitCode: unavailableHostCapability ? 3 : 2 };
  }
  if (/^\[(?:tool disabled|permission|Subagent sandbox)]/i.test(firstLine)) {
    return { envelope: { ok: false, tool, error: firstLine, route: 'direct' }, exitCode: 3 };
  }
  if (/abort(?:ed|ing)?/i.test(firstLine)) {
    return { envelope: { ok: false, tool, error: firstLine, route: 'direct' }, exitCode: 130 };
  }
  if (/^\[[^\]]+ error]/i.test(firstLine)) {
    return { envelope: { ok: false, tool, error: firstLine, route: 'direct' }, exitCode: 4 };
  }
  return { envelope: { ok: true, tool, result, route: 'direct' }, exitCode: 0 };
}

let cliPipeGuardInstalled = false;
let stdoutBrokenPipe = false;
let stderrBrokenPipe = false;

function installCliPipeGuards(): void {
  if (cliPipeGuardInstalled) return;
  cliPipeGuardInstalled = true;
  process.stdout.on('error', (error) => {
    if (isBrokenPipe(error)) {
      stdoutBrokenPipe = true;
      return;
    }
    throw error;
  });
  process.stderr.on('error', (error) => {
    if (isBrokenPipe(error)) {
      stderrBrokenPipe = true;
      return;
    }
    throw error;
  });
}

function safeStdout(text: string): void {
  if (stdoutBrokenPipe) return;
  try {
    process.stdout.write(text, (error) => {
      if (error && isBrokenPipe(error)) stdoutBrokenPipe = true;
      else if (error) throw error;
    });
  } catch (error) {
    if (isBrokenPipe(error)) stdoutBrokenPipe = true;
    else throw error;
  }
}

function safeStderr(text: string): void {
  if (stderrBrokenPipe) return;
  try {
    process.stderr.write(text, (error) => {
      if (error && isBrokenPipe(error)) stderrBrokenPipe = true;
      else if (error) throw error;
    });
  } catch (error) {
    if (isBrokenPipe(error)) stderrBrokenPipe = true;
    else throw error;
  }
}

function isBrokenPipe(error: unknown): boolean {
  const err = error as { code?: string; message?: string };
  return err?.code === 'EPIPE' || String(err?.message || '').includes('EPIPE');
}

function cliDebug(message: string): void {
  if (process.env.NEWMARK_CLI_DEBUG === '1') {
    safeStderr(`[newmark-cli] ${message}\n`);
  }
}

function splitList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function unquoteEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return trimmed;
}

function parseEnvAssignments(filePath: string): Record<string, string> {
  const text = fs.readFileSync(path.resolve(filePath), 'utf-8').replace(/^\uFEFF/, '');
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:\$env:|export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (!match) continue;
    env[match[1]] = unquoteEnvValue(match[2]);
  }
  return env;
}

function uniqueList(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const item = String(value || '').trim();
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

function inferEnvProviderName(baseUrl: string): string {
  const marker = baseUrl.toLowerCase();
  if (marker.includes('deepseek')) return 'DeepSeekAnthropic';
  if (marker.includes('anthropic') || marker.includes('claude')) return 'ClaudeAnthropic';
  return providerNameFromUrl(baseUrl);
}

function parseFuzzyEnvFile(filePath: string | undefined): FuzzyEnvDefaults {
  if (!filePath) return {};
  const text = fs.readFileSync(path.resolve(filePath), 'utf-8').replace(/^\uFEFF/, '');
  const env = parseEnvAssignments(filePath);
  const url = env.ANTHROPIC_BASE_URL || env.CLAUDE_BASE_URL || env.NEWMARK_BASE_URL || env.NEWMARK_URL || env.BASE_URL || '';
  const key = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY || env.NEWMARK_API_KEY || env.API_KEY || '';
  const tokens = tokenizeFuzzyProviderInput(text, { baseUrl: url, apiKey: key });
  const models = uniqueList([
    env.ANTHROPIC_MODEL,
    env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    env.CLAUDE_CODE_SUBAGENT_MODEL,
    env.NEWMARK_MODEL,
  ]);
  const resolvedUrl = url || tokens.baseUrl;
  const resolvedKey = key || tokens.apiKey;
  const name = env.NEWMARK_PROVIDER || env.PROVIDER_NAME || env.ANTHROPIC_PROVIDER || env.CLAUDE_PROVIDER || (resolvedUrl ? inferEnvProviderName(resolvedUrl) : tokens.providerName);
  const explicitProtocol = (env.NEWMARK_PROTOCOL || env.PROVIDER_PROTOCOL || '').toLowerCase();
  const protocol = explicitProtocol === 'openai' ? 'openai' : explicitProtocol === 'anthropic' ? 'anthropic' : tokens.protocol;
  return {
    name,
    url: resolvedUrl,
    key: resolvedKey,
    protocol,
    models,
  };
}

function redactUrlSecret(value: string): string {
  return value.replace(/([?&](?:key|token|api_key|auth)=)[^&]+/gi, '$1<redacted>');
}

function filterSkillMarket(items: ReturnType<Agent['skills']['discoverMarket']>, query: string | undefined): ReturnType<Agent['skills']['discoverMarket']> {
  const q = (query || '').trim().toLowerCase();
  if (!q) return items;
  return items.filter(item => [
    item.name,
    item.description,
    item.source,
    item.path,
    item.url || '',
  ].some(value => String(value || '').toLowerCase().includes(q)));
}

function safeState(agent: Agent, root: string): JsonObject {
  const providers = agent.config.providers().map(p => ({
    name: p.name,
    base_url: p.base_url,
    protocol: p.protocol,
    model_count: (p.models || []).length,
  }));
  const toolDefs = agent.tools.definitions(agent.mode) as Array<{ function?: { name?: string } }>;
  const runtimeDefaultTerminalShell = process.platform === 'win32' ? 'powershell' : 'bash';
  const terminalShells = process.platform === 'win32' ? ['powershell', 'cmd', 'bash', 'pwsh'] : ['bash', 'sh', 'pwsh'];
  const configuredTerminalShell = agent.config.getStr('terminal', 'default_shell') || runtimeDefaultTerminalShell;
  const defaultTerminalShell = terminalShells.includes(configuredTerminalShell) ? configuredTerminalShell : runtimeDefaultTerminalShell;
  return {
    root,
    agentOnly: agent.agentOnly,
    platform: process.platform,
    defaultTerminalShell,
    runtimeDefaultTerminalShell,
    terminalShells,
    mode: agent.mode,
    model: agent.model,
    modelLabel: agent.modelLabel(),
    intelligence: agent.intelligence,
    language: agent.config.getStr('general', 'language') || 'auto',
    autoSwitch: agent.config.autoSwitchEnabled(),
    autoSwitchScope: agent.config.autoSwitchScope(),
    autoSwitchAnchorProvider: agent.config.autoSwitchAnchorProvider(),
    openAIApiMode: agent.config.openAIApiMode(),
    contextWindow: agent.contextWindow(),
    inputMode: agent.inputMode,
    conversationId: agent.activeConversationId,
    conversations: agent.listConversationStates(),
    conversationPlan: agent.getConversationPlan(),
    chatMessages: agent.chatMessages.length,
    historyMessages: agent.history.length,
    workspace: agent.workspace.current ? {
      name: agent.workspace.current.name,
      path: agent.workspace.current.path,
      isInternal: agent.workspace.current.isInternal,
    } : null,
    workspaces: {
      internal: agent.workspace.internal.length,
      external: agent.workspace.external.length,
    },
    providers,
    models: agent.allModelNames(),
    tools: toolDefs.map(t => t.function?.name).filter(Boolean),
    archives: agent.listArchives().map(a => a.name),
  };
}

function inferCandidateModels(providerName: string, baseUrl: string): string[] {
  return fuzzyCandidateModels(providerName, baseUrl);
}

async function discoverCliProviderModels(
  providerName: string,
  baseUrl: string,
  key: string,
  protocol?: ProviderProtocol
): Promise<{ models: string[]; source: 'models_endpoint' | 'heuristic'; warning?: string }> {
  try {
    const listed = await new LLMProvider(providerName, baseUrl, key, protocol || inferProviderProtocol(providerName, baseUrl)).listModels();
    if (listed.length) return { models: listed.slice(0, 12), source: 'models_endpoint' };
    return { models: [], source: 'heuristic', warning: 'Provider /models endpoint returned no model ids. Falling back to heuristic candidates.' };
  } catch {
    return { models: [], source: 'heuristic', warning: 'Provider /models endpoint could not be read. Falling back to heuristic candidates.' };
  }
}

function summarizeValidationFailure(
  validation: Array<{ name?: string; model?: string; status?: string; notes?: string }>,
  discoveryWarning?: string
): string {
  const statuses = validation
    .slice(0, 4)
    .map(v => `${v.model || v.name || 'model'}: ${v.status || 'unknown'}${v.notes ? ` (${v.notes})` : ''}`);
  const validationText = statuses.length ? ` Validation: ${statuses.join('; ')}.` : '';
  const discoveryText = discoveryWarning ? ` Discovery: ${discoveryWarning}` : '';
  return `Models were imported but none validated as available. Check endpoint, key, balance, or model names.${validationText}${discoveryText}`;
}

async function runCliFuzzyInject(
  agent: Agent,
  name: string,
  url: string,
  key: string,
  protocol?: ProviderProtocol,
  preferredModels?: string[]
): Promise<{ ok: boolean; provider?: string; models?: string[]; warning?: string }> {
  cliDebug('fuzzy: load config');
  const config = agent.config;
  cliDebug('fuzzy: check guiding models');
  const hasUsableModel = config.allModels().some(m =>
    (m.validation?.level === 'standard' || m.validation?.level === 'extended') &&
    (m.validation.status === 'verified' || m.validation.status === 'degraded')
  );
  const tokenizerInput = `${name} ${url} ${key}`;
  const tokens = tokenizeFuzzyProviderInput(tokenizerInput, {
    providerName: name,
    baseUrl: url,
    apiKey: key,
    protocol,
  });
  const providerName = tokens.providerName.trim();
  const existing = providerName ? config.providers().find(p => p.name === providerName) : undefined;
  let baseUrl = (tokens.baseUrl || existing?.base_url || '').trim();
  const apiKey = (tokens.apiKey || existing?.api_key || '').trim();

  let safeProtocol = tokens.protocol || existing?.protocol || inferProviderProtocol(providerName, baseUrl);
  const loginOnlyMarker = `${providerName} ${baseUrl}`.toLowerCase();
  if (safeProtocol === 'github_models' || loginOnlyMarker.includes('github') || loginOnlyMarker.includes('copilot') || loginOnlyMarker.includes('models.github.ai') || loginOnlyMarker.includes('api.githubcopilot.com')) {
    return {
      ok: false,
      provider: providerName || 'GitHub Copilot',
      models: [],
      warning: 'GitHub/Copilot providers require precise browser login from Models settings and are not supported by fuzzy injection.',
    };
  }
  let discovery: { models: string[]; source: 'models_endpoint' | 'suffix_probe' | 'heuristic'; warning?: string };
  if (!hasUsableModel) {
    cliDebug('fuzzy: no guiding model, use tokenizer suffix probing');
    const noGuide = await fuzzyDiscoverWithoutGuide(tokenizerInput, {
      providerName,
      baseUrl,
      apiKey,
      protocol: tokens.protocol || existing?.protocol,
    }, preferredModels);
    if (noGuide.warning && (!noGuide.baseUrl || !noGuide.apiKey || !noGuide.models.length)) {
      return { ok: false, provider: noGuide.providerName, models: noGuide.models, warning: noGuide.warning };
    }
    baseUrl = noGuide.baseUrl;
    safeProtocol = noGuide.protocol;
    discovery = { models: noGuide.models, source: noGuide.source, warning: noGuide.warning };
  } else {
    if (!providerName || !baseUrl) return { ok: false, warning: 'Provider name and API URL are required.' };
    if (!apiKey) return { ok: false, warning: 'API key is required for new providers or existing providers without a saved key.' };
    cliDebug('fuzzy: discover models');
    discovery = await discoverCliProviderModels(providerName, baseUrl, apiKey, safeProtocol);
  }
  cliDebug('fuzzy: upsert provider');
  config.upsertProvider(providerName, baseUrl, apiKey, safeProtocol);
  cliDebug(`fuzzy: discovered ${discovery.models.length} models from ${discovery.source}`);
  const candidates = discovery.models.length ? discovery.models : (preferredModels && preferredModels.length ? preferredModels : inferCandidateModels(providerName, baseUrl));
  cliDebug(`fuzzy: import ${candidates.length} candidates`);
  for (const model of candidates) {
    config.addModelToProvider(
      providerName,
      model,
      model,
      `${discovery.source === 'models_endpoint' ? 'Listed by provider /models endpoint' : discovery.source === 'suffix_probe' ? 'Discovered by fuzzy suffix probing' : 'Discovered by fuzzy injection'} for ${providerName}`
    );
  }
  cliDebug('fuzzy: save imported models');
  config.save();
  cliDebug('fuzzy: validate candidates');
  const validation = await agent.validateModels(candidates.map(m => `${providerName}/${m}`));
  cliDebug(`fuzzy: validation results ${validation.length}`);
  const ok = validation.some(v => v.status === 'verified' || v.status === 'degraded');
  return {
    ok,
    provider: providerName,
    models: candidates,
    warning: ok ? undefined : summarizeValidationFailure(validation, discovery.warning),
  };
}

export async function runCliCommand(root: string, args: string[]): Promise<boolean> {
  installCliPipeGuards();
  const command = args.find(a => (CLI_COMMANDS as readonly string[]).includes(a));
  if (!command) return false;

  const agent = new Agent(root, { agentOnly: args.includes('--agent-only') });
  agent.tools.setHostProfile({
    kind: 'cli',
    platform: process.platform,
    electronBrowser: false,
    windowsComputerUse: process.platform === 'win32',
  });
  const conversation = argValue(args, '--conversation');
  if (conversation) agent.setConversation(conversation);
  const language = argValue(args, '--language');
  if (language && ['auto', 'en', 'zh'].includes(language)) agent.config.set('general', 'language', language);
  const requestedMode = argValue(args, '--mode');
  if ((command === 'send' || command === 'tool') && requestedMode) {
    if (!['build', 'plan', 'goal', 'flow'].includes(requestedMode)) {
      if (command === 'tool') {
        const positional = positionalAfter(args, 'tool');
        emitCliToolEnvelope({ ok: false, tool: positional[0] || '', error: `Invalid mode: ${requestedMode}. Expected build, plan, goal, or flow.`, route: 'direct' }, 2);
      } else {
        safeStderr(`Invalid mode: ${requestedMode}. Expected build, plan, goal, or flow.\n`);
        process.exitCode = 2;
      }
      return true;
    }
    agent.setMode(requestedMode as AgentMode);
  }
  if (command === 'state') {
    printJson(safeState(agent, root));
    return true;
  }

  if (command === 'tool') {
    if (args.includes('--list')) {
      emitCliToolEnvelope({
        ok: true,
        tool: 'catalog',
        result: { mode: agent.mode, tools: agent.tools.canonicalDefinitions(agent.mode) },
        route: 'direct',
      }, 0);
      return true;
    }
    const positional = positionalAfter(args, 'tool');
    const toolName = positional[0] || '';
    if (!toolName) {
      emitCliToolEnvelope({ ok: false, tool: '', error: 'Tool name is required. Usage: Newmark.exe tool <tool-name> [json-args | key=value ... | --args-file path] [--mode build|plan|goal|flow] [--root <dir>]', route: 'direct' }, 2);
      return true;
    }
    const parsedArgs = parseToolArgs(
      positional.slice(1),
      argValue(args, '--args') || argValueFromFile(args, '--args-file') || argValue(args, '--input')
    );
    if (!parsedArgs.ok) {
      emitCliToolEnvelope({ ok: false, tool: toolName, error: parsedArgs.error, route: 'direct' }, 2);
      return true;
    }
    const toolArgs = parsedArgs.value;
    const wsDir = agent.workspace.current?.path || root;
    try {
      const result = await agent.tools.execute(toolName, JSON.stringify(toolArgs), wsDir, {
        mode: agent.mode,
        workspacePath: wsDir,
        invocation: 'cli',
      });
      const classified = classifyCliToolOutput(toolName, result);
      emitCliToolEnvelope(classified.envelope, classified.exitCode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = error instanceof Error && error.name === 'AbortError';
      emitCliToolEnvelope({ ok: false, tool: toolName, error: message, route: 'direct' }, aborted ? 130 : 4);
    }
    return true;
  }

  if (command === 'send') {
    const positional = positionalAfter(args, 'send');
    const prompt = argValueFromEnv(args, '--input') || argValueFromFile(args, '--input-file') || positional.join(' ').trim();
    if (!prompt) {
      safeStderr('Usage: Newmark.exe send <prompt> [--input-env ENV|--input-file path] [--mode build|plan|goal|flow] [--model <model>] [--language auto|en|zh] [--conversation <id>] [--agent-only] [--root <dir>]\n');
      process.exitCode = 1;
      return true;
    }
    const model = argValue(args, '--model');
    if (model) agent.setModel(model);
    const tokens = await agent.process(prompt);
    safeStdout(tokens.map(t => t.text || '').join(''));
    safeStdout('\n');
    return true;
  }

  if (command === 'validate-models') {
    const selected = splitList(pathArgValue(args, '--selected') || pathArgValue(args, '--models'));
    const result = await agent.validateModels(selected.length ? selected : undefined);
    printJson(result);
    return true;
  }

  if (command === 'fuzzy-inject') {
    const positional = positionalAfter(args, 'fuzzy-inject');
    const envDefaults = parseFuzzyEnvFile(argValueFromEnv(args, '--env-file', '--claude-env-file', '--anthropic-env-file'));
    const name = argValue(args, '--name') || positional[0] || envDefaults.name || '';
    const url = argValueFromEnv(args, '--endpoint', '--url') || positional[1] || envDefaults.url || '';
    const key = argValueFromEnv(args, '--key', '--api-key') || positional[2] || envDefaults.key || '';
    const protocol = argValue(args, '--protocol');
    const preferredModels = splitList(argValue(args, '--candidate-models')).concat(envDefaults.models || []);
    const inferredName = name || (url ? providerNameFromUrl(url) : '');
    if (!inferredName) {
      safeStderr('Usage: Newmark.exe fuzzy-inject [--name <provider>] [--env-file <PowerShell-or-dotenv-file>|--env-file-env <ENV_WITH_FILE_PATH>] [--endpoint-env <ENV_WITH_BASE_URL>] [--key-env <ENV_WITH_API_KEY>] [--protocol openai|anthropic] [--root <dir>]\n');
      process.exitCode = 1;
      return true;
    }
    const safeProtocol = protocol === 'anthropic' ? 'anthropic' : protocol === 'openai' ? 'openai' : envDefaults.protocol;
    if (args.includes('--preview-only')) {
      printJson({
        ok: !!(inferredName && url && (key || agent.config.providers().some(p => p.name === inferredName && p.api_key))),
        preview: true,
        provider: inferredName,
        base_url: redactUrlSecret(url),
        protocol: safeProtocol || inferProviderProtocol(inferredName, url),
        models: preferredModels,
        has_api_key: !!key,
        source: envDefaults.url || envDefaults.key || (envDefaults.models || []).length ? 'env_file' : 'args',
      });
      return true;
    }
    const result = await runCliFuzzyInject(agent, inferredName, url, key, safeProtocol, preferredModels);
    printJson(result);
    return true;
  }

  if (command === 'skills-market') {
    if (args.includes('--sources')) {
      printJson({ ok: true, sources: agent.skills.listMarketSources() });
      return true;
    }
    if (args.includes('--add-source')) {
      const name = argValue(args, '--name') || positionalAfter(args, 'skills-market')[0] || '';
      const type = argValue(args, '--type') as 'json' | 'skill-url' | 'local-dir' | undefined;
      const url = argValue(args, '--url');
      const sourcePath = argValue(args, '--path');
      const id = argValue(args, '--source-id');
      try {
        const source = agent.skills.addMarketSource({ id, name, type, url, path: sourcePath });
        printJson({ ok: true, source, sources: agent.skills.listMarketSources() });
      } catch (e) {
        printJson({ ok: false, error: e instanceof Error ? e.message : String(e) });
        process.exitCode = 1;
      }
      return true;
    }
    const removeSource = argValue(args, '--remove-source');
    if (removeSource) {
      const ok = agent.skills.removeMarketSource(removeSource);
      printJson({ ok, sources: agent.skills.listMarketSources() });
      if (!ok) process.exitCode = 1;
      return true;
    }
    const enableSource = argValue(args, '--enable-source');
    if (enableSource) {
      const ok = agent.skills.setMarketSourceEnabled(enableSource, true);
      printJson({ ok, sources: agent.skills.listMarketSources() });
      if (!ok) process.exitCode = 1;
      return true;
    }
    const disableSource = argValue(args, '--disable-source');
    if (disableSource) {
      const ok = agent.skills.setMarketSourceEnabled(disableSource, false);
      printJson({ ok, sources: agent.skills.listMarketSources() });
      if (!ok) process.exitCode = 1;
      return true;
    }
    const query = argValue(args, '--query') || positionalAfter(args, 'skills-market').join(' ');
    const all = await agent.skills.discoverMarketAsync();
    const filtered = filterSkillMarket(all, query);
    printJson({
      query: (query || '').trim(),
      total: all.length,
      count: filtered.length,
      items: filtered,
    });
    return true;
  }

  if (command === 'memory-lab') {
    const lab = new MemoryLabManager(root);
    if (args.includes('--update')) {
      const content = argValueFromFile(args, '--content-file') || argValue(args, '--content') || '';
      try {
        printJson(await agent.updateMemoryLab({
          name: argValue(args, '--name') || '',
          description: argValue(args, '--description') || '',
          tags: splitList(argValue(args, '--tags')),
          content,
          kind: args.includes('--folder') ? 'folder' : 'file',
        }));
      } catch (e) {
        printJson({ ...lab.read(), ok: false, error: e instanceof Error ? e.message : String(e) });
        process.exitCode = 1;
      }
      return true;
    }
    if (args.includes('--reindex')) {
      printJson(await agent.reindexMemoryLab());
      return true;
    }
    const component = argValue(args, '--component') || positionalAfter(args, 'memory-lab')[0] || '';
    if (args.includes('--read') || args.includes('--index') || component) {
      printJson(lab.read(component));
      return true;
    }
    printJson(lab.read());
    return true;
  }

  if (command === 'install-update') {
    const repo = argValue(args, '--repo');
    const tag = argValue(args, '--tag');
    const asset = argValue(args, '--asset');
    if (args.includes('--version')) {
      printJson({ ok: true, version: currentAppVersion() });
      return true;
    }
    if (args.includes('--check-github')) {
      printJson(await checkGitHubUpdate(repo, tag, asset));
      return true;
    }
    if (args.includes('--from-github')) {
      const result = await applyGitHubUpdate({
        repo,
        tag,
        asset,
        target: pathArgValue(args, '--target') || root,
        expectedVersion: argValue(args, '--expected-version'),
        dryRun: args.includes('--dry-run'),
      });
      printJson(result);
      if (!result.ok) process.exitCode = 1;
      return true;
    }
    const source = pathArgValue(args, '--source') || positionalAfter(args, 'install-update')[0] || '';
    const target = pathArgValue(args, '--target') || root;
    if (!source) {
      safeStderr('Usage: Newmark.exe install-update (--source <portable-exe-or-unpacked-dir>|--check-github|--from-github) [--repo owner/name] [--tag vX.Y.Z] [--asset name] [--target <dir>] [--target-file <path>] [--expected-version <version>] [--preserve csv] [--dry-run] [--root <dir>]\n');
      process.exitCode = 1;
      return true;
    }
    const result = installUpdate({
      source,
      target,
      targetFile: pathArgValue(args, '--target-file'),
      expectedVersion: argValue(args, '--expected-version'),
      preserve: splitList(argValue(args, '--preserve')),
      dryRun: args.includes('--dry-run'),
    });
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return true;
  }

  if (command === 'compat') {
    const target = (argValue(args, '--target') || positionalAfter(args, 'compat')[0] || 'all').toLowerCase();
    const canonicalTools = agent.tools.canonicalDefinitions(agent.mode);
    const plugins = discoverPluginManifests(root);
    const payload: JsonObject = {
      ok: true,
      root,
      target,
      compatibility: {
        tool_schemas: ['openai_chat_completions', 'openai_responses', 'anthropic_input_schema'],
        plugin_ecosystems: ['codex', 'claude-code', 'opencode', 'newmark'],
        marketplace_ecosystems: ['codex', 'claude-code', 'newmark'],
        plugin_execution: 'metadata-only by default; OpenCode JavaScript tools require explicit compat-tool invocation.',
        mcp_activation: 'discovered from plugin/config metadata but not auto-started.',
        subagent_return_contract: 'structured NewmarkSubagentRecord embedded in NewmarkToolResult while preserving legacy text output.',
      },
    };
    if (target === 'all' || target === 'tools') {
      payload.tools = {
        canonical: canonicalTools,
        openai_chat: agent.tools.openAIChatDefinitions(agent.mode),
        openai_responses: agent.tools.openAIResponsesDefinitions(agent.mode),
        anthropic: agent.tools.anthropicDefinitions(agent.mode),
      };
    }
    if (target === 'all' || target === 'plugins') {
      payload.plugins = plugins;
    }
    if (target === 'all' || target === 'marketplaces') {
      payload.marketplaces = discoverPluginMarketplaces(root);
    }
    if (target === 'all' || target === 'skills') {
      payload.skills = agent.skills.discoverMarket();
    }
    if (target === 'all' || target === 'agents') {
      payload.agents = discoverAgentPresets(root);
    }
    if (target === 'all' || target === 'subagents') {
      payload.subagent_schema = {
        status: ['idle', 'working', 'completed', 'closed', 'error'],
        record_fields: ['id', 'name', 'status', 'active', 'model', 'mode', 'inputMode', 'prompt', 'result', 'messages', 'error', 'startedAt', 'completedAt', 'closedAt', 'metadata'],
        tool_result_fields: ['ok', 'output', 'data', 'error', 'metadata'],
      };
      payload.subagents = agent.subagents.listAll().map(s => agent.subagents.toRecord(s.id));
    }
    printJson(payload);
    return true;
  }

  if (command === 'compat-tool') {
    if (args.includes('--list')) {
      printJson({ ok: true, tools: discoverOpenCodeTools(root) });
      return true;
    }
    const positional = positionalAfter(args, 'compat-tool');
    const name = argValue(args, '--name') || positional[0] || '';
    if (!name) {
      safeStderr('Usage: Newmark.exe compat-tool --list | --name <opencode-tool> [json-args | --args-file path] [--root <dir>]\n');
      process.exitCode = 1;
      return true;
    }
    const parsedArgs = parseToolArgs(
      argsAfterOption(args, '--name').length ? argsAfterOption(args, '--name') : positional.slice(1),
      argValue(args, '--args') || argValueFromFile(args, '--args-file') || argValue(args, '--input')
    );
    if (!parsedArgs.ok) {
      safeStderr(`CLI compat-tool argument error: ${parsedArgs.error}\n`);
      process.exitCode = 1;
      return true;
    }
    printJson(await runOpenCodeTool(root, name, parsedArgs.value));
    return true;
  }

  return false;
}

export function cliCommandUsage(): string {
  return [
    'Newmark CLI non-interactive commands:',
    '  Newmark.exe state [--root <dir>]',
    '  Newmark.exe tool <tool-name> [json-args | key=value ... | --args-file path] [--root <dir>]',
    '  Newmark.exe send <prompt> [--input-env ENV|--input-file path] [--mode build|plan|goal|flow] [--model <model>] [--language auto|en|zh] [--conversation <id>] [--agent-only] [--root <dir>]',
    '  Newmark.exe validate-models [--selected provider/model,model] [--root <dir>]',
    '  Newmark.exe fuzzy-inject [--name <provider>] [--env-file <PowerShell-or-dotenv-file>|--env-file-env <ENV_WITH_FILE_PATH>] [--endpoint-env <ENV_WITH_BASE_URL>] [--key-env <ENV_WITH_API_KEY>] [--protocol openai|anthropic] [--preview-only] [--root <dir>]',
    '  Newmark.exe skills-market [--query <text>|--sources|--add-source --name <name> (--url <url>|--path <path>) [--type json|skill-url|local-dir]|--remove-source <id>|--enable-source <id>|--disable-source <id>] [--root <dir>]',
    '  Newmark.exe memory-lab [--read|--component <name>|--update --name <name> --description <text> --tags <csv> --content-file <path> [--folder]|--reindex] [--root <dir>]',
    '  Newmark.exe install-update (--source <portable-exe-or-unpacked-dir>|--check-github|--from-github) [--repo owner/name] [--tag vX.Y.Z] [--asset name] [--target <dir>] [--target-file <path>] [--expected-version <version>] [--preserve csv] [--dry-run] [--root <dir>]',
    '  Newmark.exe compat [--target all|tools|plugins|marketplaces|skills|agents|subagents] [--root <dir>]',
    '  Newmark.exe compat-tool --list | --name <opencode-tool> [json-args | --args-file path] [--root <dir>]',
    `Working directory fallback: ${path.resolve('.')}`,
  ].join('\n');
}
