import * as path from 'path';
import * as fs from 'fs';
import { Agent, AgentMode } from './core/agent';
import { ConfigManager, ModelEvaluation, ProviderProtocol, inferProviderProtocol } from './core/config';
import { fuzzyCandidateModels, fuzzyDiscoverWithoutGuide, providerNameFromUrl, tokenizeFuzzyProviderInput } from './core/fuzzy';
import { LLMProvider } from './llm/provider';

type JsonObject = Record<string, unknown>;
type FuzzyEnvDefaults = {
  name?: string;
  url?: string;
  key?: string;
  protocol?: ProviderProtocol;
  models?: string[];
};

export const CLI_COMMANDS = ['state', 'tool', 'send', 'validate-models', 'fuzzy-inject', 'skills-market'] as const;

function argValue(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  return idx >= 0 ? args[idx + 1] : undefined;
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

function argValueFromFile(args: string[], key: string): string | undefined {
  const filePath = argValue(args, key);
  if (!filePath) return undefined;
  return fs.readFileSync(filePath, 'utf-8');
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function cliDebug(message: string): void {
  if (process.env.NEWMARK_CLI_DEBUG === '1') {
    process.stderr.write(`[newmark-cli] ${message}\n`);
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
  return {
    root,
    mode: agent.mode,
    model: agent.model,
    modelLabel: agent.modelLabel(),
    intelligence: agent.intelligence,
    language: agent.config.getStr('general', 'language') || 'auto',
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

function speedRating(latency: number, ok: boolean): string {
  if (!ok || latency < 0) return 'unknown';
  if (latency <= 1.5) return 'fast';
  if (latency <= 5) return 'medium';
  return 'slow';
}

function costRating(input = 0, output = 0): string {
  const total = input + output;
  if (total <= 0) return 'free';
  if (total <= 0.005) return 'cheap';
  if (total <= 0.05) return 'standard';
  return 'expensive';
}

function performanceRating(name: string, existing?: string): string {
  if (existing && existing !== 'unknown') return existing;
  const n = name.toLowerCase();
  if (/(opus|gpt-4\.1|gpt-4o|o3|r1|deepseek-v3|70b|120b)/.test(n)) return 'high';
  if (/(mini|haiku|flash|8b|7b|3b)/.test(n)) return 'medium';
  return 'medium';
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

async function validateCliModels(config: ConfigManager, selectedNames?: string[]): Promise<Array<ModelEvaluation & { name: string; provider: string; model: string; display: string }>> {
  const selected = new Set(selectedNames || []);
  const results: Array<ModelEvaluation & { name: string; provider: string; model: string; display: string }> = [];
  for (const m of config.allModels()) {
    if (selected.size && !selected.has(m.name) && !selected.has(`${m.provider}/${m.name}`)) continue;
    const base = {
      name: `${m.provider}/${m.name}`,
      provider: m.provider,
      model: m.name,
      display: m.display || m.name,
      status: 'unavailable',
      latency: -1,
      checked_at: new Date().toISOString(),
      text_input: false,
      text_output: false,
      vision_input: !!m.vision,
      image_output: !!m.image_output,
      cost_rating: costRating(m.cost_per_1k_input, m.cost_per_1k_output),
      performance_rating: performanceRating(m.name, m.capability_rating),
      speed_rating: 'unknown',
      notes: '',
    };
    if (!m.provider_url || !m.api_key) {
      const result = { ...base, notes: 'Missing provider URL or API key' };
      results.push(result);
      config.updateModel(m.provider, m.name, { evaluation: result, speed_rating: result.speed_rating, capability_rating: result.performance_rating });
      continue;
    }
    const provider = new LLMProvider(m.provider, m.provider_url, m.api_key, m.provider_protocol);
    try {
      const { ok, latency } = await provider.validate(m.name);
      const result = {
        ...base,
        status: ok ? 'available' : 'unavailable',
        latency,
        text_input: ok,
        text_output: ok,
        speed_rating: speedRating(latency, ok),
        notes: ok ? 'Text chat validation succeeded' : 'Provider returned no usable text output',
      };
      results.push(result);
      config.updateModel(m.provider, m.name, { evaluation: result, speed_rating: result.speed_rating, capability_rating: result.performance_rating });
    } catch (e) {
      const result = {
        ...base,
        status: `error: ${e instanceof Error ? e.message : String(e)}`,
        notes: 'Validation request failed',
      };
      results.push(result);
      config.updateModel(m.provider, m.name, { evaluation: result, speed_rating: result.speed_rating, capability_rating: result.performance_rating });
    }
  }
  config.save();
  return results;
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
  root: string,
  name: string,
  url: string,
  key: string,
  protocol?: ProviderProtocol,
  preferredModels?: string[]
): Promise<{ ok: boolean; provider?: string; models?: string[]; warning?: string }> {
  cliDebug('fuzzy: load config');
  const config = new ConfigManager(root);
  cliDebug('fuzzy: check guiding models');
  const hasUsableModel = config.allModels().some(m => (m.evaluation?.status || 'available') === 'available');
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
  const validation = await validateCliModels(config, candidates.map(m => `${providerName}/${m}`));
  cliDebug(`fuzzy: validation results ${validation.length}`);
  const ok = validation.some(v => v.status === 'available');
  return {
    ok,
    provider: providerName,
    models: candidates,
    warning: ok ? undefined : summarizeValidationFailure(validation, discovery.warning),
  };
}

export async function runCliCommand(root: string, args: string[]): Promise<boolean> {
  const command = args.find(a => (CLI_COMMANDS as readonly string[]).includes(a));
  if (!command) return false;

  const agent = new Agent(root);
  const conversation = argValue(args, '--conversation');
  if (conversation) agent.setConversation(conversation);
  const language = argValue(args, '--language');
  if (language && ['auto', 'en', 'zh'].includes(language)) agent.config.set('general', 'language', language);
  if (command === 'state') {
    printJson(safeState(agent, root));
    return true;
  }

  if (command === 'tool') {
    const positional = positionalAfter(args, 'tool');
    const toolName = positional[0] || '';
    if (!toolName) {
      process.stderr.write('Usage: Newmark.exe tool <tool-name> [json-args | key=value ... | --args-file path] [--root <dir>]\n');
      process.exitCode = 1;
      return true;
    }
    const parsedArgs = parseToolArgs(
      positional.slice(1),
      argValue(args, '--args') || argValueFromFile(args, '--args-file') || argValue(args, '--input')
    );
    if (!parsedArgs.ok) {
      process.stderr.write(`CLI tool argument error: ${parsedArgs.error}\n`);
      process.exitCode = 1;
      return true;
    }
    const toolArgs = parsedArgs.value;
    const wsDir = agent.workspace.current?.path || root;
    const result = await agent.tools.execute(toolName, JSON.stringify(toolArgs), wsDir, {
      mode: agent.mode,
      workspacePath: wsDir,
    });
    process.stdout.write(`${result}\n`);
    return true;
  }

  if (command === 'send') {
    const positional = positionalAfter(args, 'send');
    const prompt = argValueFromEnv(args, '--input') || argValueFromFile(args, '--input-file') || positional.join(' ').trim();
    if (!prompt) {
      process.stderr.write('Usage: Newmark.exe send <prompt> [--input-env ENV|--input-file path] [--mode build|plan|goal|flow] [--model <model>] [--language auto|en|zh] [--conversation <id>] [--root <dir>]\n');
      process.exitCode = 1;
      return true;
    }
    const mode = argValue(args, '--mode');
    if (mode && ['build', 'plan', 'goal', 'flow'].includes(mode)) agent.setMode(mode as AgentMode);
    const model = argValue(args, '--model');
    if (model) agent.setModel(model);
    const tokens = await agent.process(prompt);
    process.stdout.write(tokens.map(t => t.text || '').join(''));
    process.stdout.write('\n');
    return true;
  }

  if (command === 'validate-models') {
    const selected = splitList(argValue(args, '--selected') || argValue(args, '--models'));
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
      process.stderr.write('Usage: Newmark.exe fuzzy-inject [--name <provider>] [--env-file <PowerShell-or-dotenv-file>|--env-file-env <ENV_WITH_FILE_PATH>] [--endpoint-env <ENV_WITH_BASE_URL>] [--key-env <ENV_WITH_API_KEY>] [--protocol openai|anthropic] [--root <dir>]\n');
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
    const result = await runCliFuzzyInject(root, inferredName, url, key, safeProtocol, preferredModels);
    printJson(result);
    return true;
  }

  if (command === 'skills-market') {
    const query = argValue(args, '--query') || positionalAfter(args, 'skills-market').join(' ');
    const all = agent.skills.discoverMarket();
    const filtered = filterSkillMarket(all, query);
    printJson({
      query: (query || '').trim(),
      total: all.length,
      count: filtered.length,
      items: filtered,
    });
    return true;
  }

  return false;
}

export function cliCommandUsage(): string {
  return [
    'Newmark CLI non-interactive commands:',
    '  Newmark.exe state [--root <dir>]',
    '  Newmark.exe tool <tool-name> [json-args | key=value ... | --args-file path] [--root <dir>]',
    '  Newmark.exe send <prompt> [--input-env ENV|--input-file path] [--mode build|plan|goal|flow] [--model <model>] [--language auto|en|zh] [--conversation <id>] [--root <dir>]',
    '  Newmark.exe validate-models [--selected provider/model,model] [--root <dir>]',
    '  Newmark.exe fuzzy-inject [--name <provider>] [--env-file <PowerShell-or-dotenv-file>|--env-file-env <ENV_WITH_FILE_PATH>] [--endpoint-env <ENV_WITH_BASE_URL>] [--key-env <ENV_WITH_API_KEY>] [--protocol openai|anthropic] [--preview-only] [--root <dir>]',
    '  Newmark.exe skills-market [--query <text>] [--root <dir>]',
    `Working directory fallback: ${path.resolve('.')}`,
  ].join('\n');
}
