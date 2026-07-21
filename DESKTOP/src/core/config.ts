import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { defaultNativeToolEnabled, normalizeNativeToolEnabled } from '../tools/nativeTools';

export interface JsonValue {
  [key: string]: unknown;
}

export interface ConfigEntry {
  _description?: string;
  _type?: string;
  _values?: string[];
  _min?: number;
  _max?: number;
  value: unknown;
}

export type ProviderProtocol = 'openai' | 'anthropic' | 'github_models';

const USER_LEVEL_CONFIG_KEYS = new Set([
  'models.providers',
  'ui.left_panel_collapsed',
  'ui.right_panel_collapsed',
  'ui.bottom_panel_collapsed',
  'ui.secondary_panel_collapsed',
  'ui.dark_mode',
  'ui.background_color',
  'ui.font_family',
]);

export interface ProviderConfig {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  protocol: ProviderProtocol;
  enabled: boolean;
  models: ModelConfig[];
}

export interface ModelConfig {
  name: string;
  display: string;
  description: string;
  cost_per_1k_input?: number;
  cost_per_1k_output?: number;
  max_tokens: number;
  vision: boolean;
  thinking?: boolean;
  image_output?: boolean;
  enabled?: boolean;
  preview?: boolean;
  logical_model_group_id?: string;
  privacy?: Array<'default' | 'no_training' | 'zdr'>;
  data_regions?: string[];
  supported_parameters?: string[];
  route_preference?: number;
  capabilities?: string[];
  fallback_only?: boolean;
  quality_by_task?: Partial<Record<'chat' | 'coding' | 'reasoning' | 'long_context' | 'vision' | 'image_generation' | 'tool_use' | 'computer_use', { successes: number; attempts: number }>>;
  validation?: ModelValidationSummary;
  speed_rating: string;
  capability_rating: string;
  evaluation?: ModelEvaluation;
  intelligence_tiers: {
    low: { description: string };
    medium: { description: string };
    high: { description: string };
  };
}

export interface ModelEvaluation {
  status: string;
  latency: number;
  checked_at: string;
  text_input: boolean;
  text_output: boolean;
  vision_input: boolean;
  image_output: boolean;
  cost_rating: string;
  performance_rating: string;
  speed_rating: string;
  notes: string;
}

export class ConfigManager {
  public rootPath: string;
  private config: Record<string, Record<string, ConfigEntry>>;
  private workspaceOverrides: Map<string, unknown>;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.workspaceOverrides = new Map();
    this.config = this.load();
  }

  reload(): void {
    this.config = this.load();
    this.workspaceOverrides.clear();
  }

  private load(): Record<string, Record<string, ConfigEntry>> {
    const cp = path.join(this.rootPath, 'config.json');
    if (fs.existsSync(cp)) {
      try {
        const raw = JSON.parse(readJsonText(cp));
        const normalized = normalizeConfigShape(raw, true);
        if (isCorruptConfig(raw, normalized)) {
          this.backupConfig(cp, 'invalid-shape');
          return this.writeRecoveredConfig(cp);
        }
        if (migrateProviderIdsInConfig(normalized)) {
          // Provider ids are routing identities, so legacy/malformed catalogs must
          // not wait for an unrelated settings save before becoming collision-safe.
          try {
            fs.writeFileSync(cp, JSON.stringify(normalized, null, 2), 'utf-8');
          } catch {
            // A read-only root may still be used for this process. The normalized
            // in-memory catalog remains safe even when the migration cannot persist.
          }
        }
        return normalized;
      } catch {
        this.backupConfig(cp, 'invalid-json');
        return this.writeRecoveredConfig(cp);
      }
    }
    return defaultConfig();
  }

  get<T = unknown>(section: string, key: string): T | undefined {
    const wsKey = `${section}.${key}`;
    if (this.workspaceOverrides.has(wsKey)) {
      return this.workspaceOverrides.get(wsKey) as T;
    }
    const sec = this.config[section];
    if (!sec) return undefined;
    const entry = sec[key];
    if (!entry) return undefined;
    return entry.value as T;
  }

  private getGlobal<T = unknown>(section: string, key: string): T | undefined {
    const entry = this.config[section]?.[key];
    return entry?.value as T | undefined;
  }

  getStr(section: string, key: string): string {
    return (this.get<string>(section, key)) || '';
  }

  getBool(section: string, key: string): boolean {
    return !!this.get<boolean>(section, key);
  }

  getNum(section: string, key: string): number {
    return (this.get<number>(section, key)) || 0;
  }

  set(section: string, key: string, value: unknown): void {
    if (!this.config[section]) {
      this.config[section] = {};
    }
    const normalizedValue = section === 'models' && key === 'providers' && Array.isArray(value)
      ? assignUniqueProviderIds(value).providers
      : value;
    this.config[section][key] = { value: normalizedValue };
  }

  save(): void {
    const j = JSON.stringify(this.config, null, 2);
    fs.writeFileSync(path.join(this.rootPath, 'config.json'), j, 'utf-8');
  }

  saveTo(targetPath: string): void {
    const j = JSON.stringify(this.config, null, 2);
    fs.writeFileSync(targetPath, j, 'utf-8');
  }

  loadWorkspaceConfig(wsPath: string): void {
    this.workspaceOverrides.clear();
    const cfgPath = path.join(wsPath, 'config.json');
    if (fs.existsSync(cfgPath)) {
      try {
        const wsCfg: Record<string, Record<string, ConfigEntry>> = normalizeConfigShape(JSON.parse(readJsonText(cfgPath)), false);
        for (const [sectionName, section] of Object.entries(wsCfg)) {
          for (const [k, entry] of Object.entries(section)) {
            // Credentials/catalogs and application layout belong to the user root,
            // not to stale workspace templates copied between Newmark versions.
            if (USER_LEVEL_CONFIG_KEYS.has(`${sectionName}.${k}`)) continue;
            if (entry.value !== undefined) {
              this.workspaceOverrides.set(`${sectionName}.${k}`, entry.value);
            }
          }
        }
      } catch { /* ignore */ }
    }
  }

  clearWorkspaceOverrides(): void {
    this.workspaceOverrides.clear();
  }

  providers(): ProviderConfig[] {
    return this.normalizeProviders((this.getGlobal<ProviderConfig[]>('models', 'providers')) || []);
  }

  allModels(): Array<ModelConfig & { provider: string; provider_id: string; provider_url: string; api_key: string; provider_protocol: ProviderProtocol }> {
    const models: Array<ModelConfig & { provider: string; provider_id: string; provider_url: string; api_key: string; provider_protocol: ProviderProtocol }> = [];
    for (const p of this.providers()) {
      if (p.enabled === false) continue;
      for (const m of p.models || []) {
        models.push({
          ...m,
          provider: p.name,
          provider_id: p.id,
          provider_url: p.base_url,
          api_key: p.api_key,
          provider_protocol: p.protocol,
        });
      }
    }
    return models;
  }

  findModel(name: string): (ModelConfig & { provider: string; provider_id: string; provider_url: string; api_key: string; provider_protocol: ProviderProtocol }) | undefined {
    const matches = this.allModels().filter(model => model.name === name);
    return matches.length === 1 ? matches[0] : undefined;
  }

  findDeployment(ref: { providerId: string; modelId: string }): (ModelConfig & { provider: string; provider_id: string; provider_url: string; api_key: string; provider_protocol: ProviderProtocol }) | undefined {
    const matches = this.allModels().filter(model => model.provider_id === ref.providerId && model.name === ref.modelId);
    return matches.length === 1 ? matches[0] : undefined;
  }

  findProvider(providerIdOrLegacyName: string): ProviderConfig | undefined {
    const reference = String(providerIdOrLegacyName || '').trim();
    if (!reference) return undefined;
    const providers = this.providers();
    const byId = providers.find(provider => provider.id === reference);
    if (byId) return byId;
    const byName = providers.filter(provider => provider.name === reference);
    return byName.length === 1 ? byName[0] : undefined;
  }

  modelsForSelections(selected?: string[]): ReturnType<ConfigManager['allModels']> {
    const models = this.allModels();
    if (!selected?.length) return models;
    const resolved = new Map<string, ReturnType<ConfigManager['allModels']>[number]>();
    for (const rawSelection of selected) {
      const selection = String(rawSelection || '').trim();
      if (!selection) continue;
      const deployment = parseDeploymentSelectionValue(selection);
      if (deployment) {
        const model = this.findDeployment(deployment);
        if (model) resolved.set(`${model.provider_id}\u0000${model.name}`, model);
        continue;
      }
      const idQualified = models.filter(model => `${model.provider_id}/${model.name}` === selection);
      if (idQualified.length === 1) {
        const model = idQualified[0];
        resolved.set(`${model.provider_id}\u0000${model.name}`, model);
        continue;
      }
      const legacyQualified = models.filter(model => `${model.provider}/${model.name}` === selection);
      const uniqueLegacyProviderName = legacyQualified.length === 1
        && this.providers().filter(provider => provider.name === legacyQualified[0].provider).length === 1;
      if (uniqueLegacyProviderName) {
        const model = legacyQualified[0];
        resolved.set(`${model.provider_id}\u0000${model.name}`, model);
        continue;
      }
      const legacyBare = models.filter(model => model.name === selection);
      if (legacyBare.length === 1) {
        const model = legacyBare[0];
        resolved.set(`${model.provider_id}\u0000${model.name}`, model);
      }
    }
    return [...resolved.values()];
  }

  upsertProvider(name: string, baseUrl: string, apiKey: string, protocol?: ProviderProtocol, providerId = ''): string {
    const ps = this.providers();
    const existingIndex = providerMutationIndex(ps, providerId || name);
    const existing = existingIndex >= 0 ? ps[existingIndex] : undefined;
    const selectedProtocol = protocol || existing?.protocol || inferProviderProtocol(name, baseUrl || existing?.base_url || '');
    const resolvedBaseUrl = baseUrl || existing?.base_url || defaultProviderBaseUrl(selectedProtocol) || '';
    const resolvedApiKey = apiKey || existing?.api_key || '';
    const next = {
      id: existing?.id || validExplicitProviderId(providerId) || stableProviderId(name, resolvedBaseUrl, selectedProtocol),
      name,
      base_url: resolvedBaseUrl,
      api_key: resolvedApiKey,
      protocol: selectedProtocol,
      enabled: existing?.enabled !== false,
      models: existing?.models || [],
    };
    if (existingIndex >= 0) ps[existingIndex] = next;
    else ps.push(next);
    this.set('models', 'providers', ps);
    const saved = this.providers();
    if (existing) return existing.id;
    for (let index = saved.length - 1; index >= 0; index -= 1) {
      const provider = saved[index];
      if (provider.name === name && provider.base_url === resolvedBaseUrl && provider.protocol === selectedProtocol) return provider.id;
    }
    return next.id;
  }

  setProviderEnabled(providerIdOrLegacyName: string, enabled: boolean): boolean {
    const providers = this.providers();
    const providerIndex = providerMutationIndex(providers, providerIdOrLegacyName);
    if (providerIndex < 0) return false;
    providers[providerIndex].enabled = !!enabled;
    this.set('models', 'providers', providers);
    return true;
  }

  addModelToProvider(providerIdOrLegacyName: string, modelName: string, display: string, description: string): boolean {
    const ps = this.providers();
    const providerIndex = providerMutationIndex(ps, providerIdOrLegacyName);
    if (providerIndex < 0) return false;
    const provider = ps[providerIndex];
    const matches = provider.models.filter(model => model.name === modelName);
    if (matches.length > 1) return false;
    if (matches.length === 1) {
      matches[0].display = display || matches[0].display || modelName;
      matches[0].description = description || matches[0].description || '';
    } else {
      provider.models.push(defaultModelConfig(modelName, display, description));
    }
    this.set('models', 'providers', ps);
    return true;
  }

  updateModel(providerIdOrLegacyName: string, modelName: string, patch: Partial<ModelConfig>): boolean {
    const ps = this.providers();
    const providerIndex = providerMutationIndex(ps, providerIdOrLegacyName);
    if (providerIndex < 0) return false;
    return this.updateModelByDeployment(ps[providerIndex].id, modelName, patch);
  }

  updateModelByDeployment(providerId: string, modelId: string, patch: Partial<ModelConfig>): boolean {
    const ps = this.providers();
    const providerIndex = ps.findIndex(provider => provider.id === String(providerId || '').trim());
    if (providerIndex < 0) return false;
    const matches = ps[providerIndex].models.filter(model => model.name === modelId);
    if (matches.length !== 1) return false;
    Object.assign(matches[0], patch);
    this.set('models', 'providers', ps);
    return true;
  }

  engine(): string { return this.getStr('models', 'agent_engine'); }
  autoSwitchEnabled(): boolean { return this.getBool('models', 'auto_switch'); }
  autoSwitchPreference(): string {
    const value = this.getStr('models', 'auto_switch_preference');
    if (value === 'performance') return 'quality';
    if (value === 'cheap_save') return 'cost';
    if (value === 'speed') return 'speed';
    return value === 'quality' || value === 'cost' || value === 'balanced' ? value : 'balanced';
  }
  autoSwitchScope(): string { return this.getStr('models', 'auto_switch_scope') || 'all'; }
  autoSwitchAnchorProvider(): string { return this.getStr('models', 'auto_switch_anchor_provider'); }
  openAIApiMode(): 'chat_stream' | 'chat' | 'responses' {
    const mode = this.getStr('models', 'openai_api_mode');
    if (mode === 'chat' || mode === 'responses' || mode === 'chat_stream') return mode;
    return this.getBool('models', 'openai_streaming') === false ? 'chat' : 'chat_stream';
  }

  nativeToolEnabled(): Record<string, boolean> {
    return normalizeNativeToolEnabled(this.get<Record<string, boolean>>('tools', 'enabled'));
  }

  private normalizeProviders(rawProviders: unknown[]): ProviderConfig[] {
    const providers: ProviderConfig[] = [];
    const identifiedProviders = assignUniqueProviderIds(rawProviders || []).providers;
    for (const raw of identifiedProviders) {
      const src = raw as Record<string, unknown>;
      const name = String(src.name || '').trim();
      if (!name) continue;
      const rawModels = Array.isArray(src.models) ? src.models : [];
      const baseUrl = String(src.base_url || src.endpoint || src.url || '');
      const protocol = normalizeProviderProtocol(src.protocol, name, baseUrl);
      providers.push({
        id: String(src.id || stableProviderId(name, baseUrl, protocol)),
        name,
        base_url: baseUrl,
        api_key: String(src.api_key || src.key || ''),
        protocol,
        enabled: src.enabled !== false,
        models: rawModels.map(m => {
          if (typeof m === 'string') return defaultModelConfig(m, m, '');
          const model = m as Partial<ModelConfig>;
          const normalized: ModelConfig = {
            ...defaultModelConfig(String(model.name || ''), String(model.display || model.name || ''), String(model.description || '')),
            ...model,
            name: String(model.name || ''),
            display: String(model.display || model.name || ''),
            description: String(model.description || ''),
          };
          normalized.validation = normalizeModelValidation(normalized, !!model.validation);
          return normalized;
        }).filter(m => !!m.name),
      });
    }
    return providers;
  }

  private writeRecoveredConfig(configPath: string): Record<string, Record<string, ConfigEntry>> {
    const config = loadExampleConfig();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return config;
  }

  private backupConfig(configPath: string, reason: string): void {
    try {
      if (!fs.existsSync(configPath)) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(path.dirname(configPath), `config.broken-${reason}-${stamp}.json`);
      fs.copyFileSync(configPath, backupPath);
    } catch {
      // Recovery should still proceed even if the backup cannot be written.
    }
  }
}

export interface ModelValidationSummary {
  level: 'discovered' | 'legacy_basic' | 'basic' | 'standard' | 'extended';
  status: 'verified' | 'degraded' | 'unavailable' | 'auth_error' | 'rate_limited' | 'invalid_config';
  checked_at: string;
  expires_at?: string;
  capabilities?: Record<string, boolean>;
  error?: { code: string; message: string };
}

export function ensureRootConfig(rootPath: string): void {
  const configPath = path.join(rootPath, 'config.json');
  if (fs.existsSync(configPath)) {
    new ConfigManager(rootPath);
    return;
  }
  new ConfigManager(rootPath).save();
}

function normalizeConfigShape(raw: unknown, withDefaults: boolean): Record<string, Record<string, ConfigEntry>> {
  const base: Record<string, Record<string, ConfigEntry>> = withDefaults ? defaultConfig() : {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const incoming = raw as Record<string, unknown>;
  for (const [sectionName, sectionValue] of Object.entries(incoming)) {
    if (!sectionValue || typeof sectionValue !== 'object' || Array.isArray(sectionValue)) continue;
    if (!base[sectionName]) base[sectionName] = {};
    const section = sectionValue as Record<string, unknown>;
    for (const [key, rawEntry] of Object.entries(section)) {
      if (isConfigEntry(rawEntry)) {
        base[sectionName][key] = rawEntry;
      } else {
        base[sectionName][key] = { ...(base[sectionName][key] || {}), value: rawEntry };
      }
    }
  }
  return base;
}

function isConfigEntry(value: unknown): value is ConfigEntry {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'value');
}

function readJsonText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
}

function loadExampleConfig(): Record<string, Record<string, ConfigEntry>> {
  const examplePath = findConfigExamplePath();
  if (examplePath && fs.existsSync(examplePath)) {
    try {
      return normalizeConfigShape(JSON.parse(readJsonText(examplePath)), true);
    } catch {
      // Fall through to compiled defaults if the bundled template is damaged.
    }
  }
  return defaultConfig();
}

function findConfigExamplePath(): string {
  const candidates = [
    path.join(process.cwd(), 'config.example.json'),
    path.join(__dirname, '..', '..', 'config.example.json'),
    path.join(__dirname, '..', '..', '..', 'config.example.json'),
    path.join(path.dirname(process.execPath || ''), 'config.example.json'),
    path.join(path.dirname(process.execPath || ''), 'resources', 'app.asar', 'config.example.json'),
  ];
  return candidates.find(p => p && fs.existsSync(p)) || candidates[0];
}

function isCorruptConfig(raw: unknown, normalized: Record<string, Record<string, ConfigEntry>>): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return true;
  const incoming = raw as Record<string, unknown>;
  const models = incoming.models as Record<string, unknown> | undefined;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return true;
  const providerEntry = (models as Record<string, unknown>).providers;
  if (providerEntry === undefined) return false;
  const rawProviders = isConfigEntry(providerEntry) ? providerEntry.value : providerEntry;
  if (!Array.isArray(rawProviders)) return true;
  if (rawProviders.length > 0 && ((normalized.models?.providers?.value as unknown[]) || []).length === 0) return true;
  for (const rawProvider of rawProviders) {
    if (!rawProvider || typeof rawProvider !== 'object' || Array.isArray(rawProvider)) return true;
    const provider = rawProvider as Record<string, unknown>;
    const name = String(provider.name || '').trim();
    if (!name) return true;
    const modelsValue = provider.models;
    if (modelsValue !== undefined && !Array.isArray(modelsValue)) return true;
    if (Array.isArray(modelsValue)) {
      for (const model of modelsValue) {
        if (typeof model === 'string') continue;
        if (!model || typeof model !== 'object' || Array.isArray(model)) return true;
        if (!String((model as Record<string, unknown>).name || '').trim()) return true;
      }
    }
  }
  return false;
}
export function inferProviderProtocol(name: string, baseUrl: string): ProviderProtocol {
  const marker = (name + ' ' + baseUrl).toLowerCase();
  if (marker.includes('github models') || marker.includes('github copilot') || marker.includes('models.github.ai') || marker.includes('api.githubcopilot.com')) return 'github_models';
  if (marker.includes('anthropic') || marker.includes('/anthropic') || marker.includes('claude')) return 'anthropic';
  return 'openai';
}

export function normalizeProviderProtocol(value: unknown, name: string, baseUrl: string): ProviderProtocol {
  const raw = String(value || '').toLowerCase().trim();
  if (raw === 'anthropic' || raw === 'claude') return 'anthropic';
  if (raw === 'github_models' || raw === 'github-models' || raw === 'github' || raw === 'copilot' || raw === 'github-copilot') return 'github_models';
  if (raw === 'openai' || raw === 'openai-compatible') return 'openai';
  return inferProviderProtocol(name, baseUrl);
}

export function defaultProviderBaseUrl(protocol: ProviderProtocol): string {
  if (protocol === 'github_models') return 'https://models.github.ai';
  return '';
}

export function inferModelVisionCapability(
  modelName: string,
  display = '',
  description = '',
  providerName = '',
  protocol?: ProviderProtocol
): boolean {
  const name = String(modelName || '').toLowerCase().trim();
  const compactName = name.replace(/[\s_-]+/g, '');
  const text = `${name} ${display || ''} ${description || ''} ${providerName || ''} ${protocol || ''}`.toLowerCase();
  const compactText = text.replace(/[\s_-]+/g, '');

  // Known frontier chat model families are multimodal even when imported
  // provider metadata lacks a vision flag or carries stale text-only notes.
  if (/^gpt(?:-)?(?:4o|4\.1|4\.5|5(?:\.\d+)?)(?:$|[^a-z0-9])/.test(name) || /^gpt(?:4o|4\.1|4\.5|5(?:\.\d+)?)(?:$|[^a-z0-9])/.test(compactName)) return true;
  if (/^o(?:3|4)(?:$|[-_a-z0-9.])/.test(name)) return true;
  if (/(claude3|claude4|claude-3|claude-4|sonnet|opus|gemini|qwen-vl|qwenvl|glm-4v|glm4v)/.test(compactText)) return true;
  if (/(vision|multimodal|multi-modal|image input|image-input|视觉|多模态|图像输入|图片输入)/.test(text)) return true;

  if (/(embedding|embed|rerank|moderation|whisper|tts|speech|audio-only|audio only|transcrib|text-only|text only|纯文本)/.test(text)) return false;
  return false;
}

export function sanitizeProvidersForState(providers: ProviderConfig[]): Array<Omit<ProviderConfig, 'api_key'> & { api_key: string; has_api_key: boolean }> {
  return providers.map(provider => ({
    ...provider,
    api_key: '',
    has_api_key: !!provider.api_key,
  }));
}

export function mergeProviderSecrets(incomingProviders: unknown, existingProviders: ProviderConfig[]): unknown[] {
  if (!Array.isArray(incomingProviders)) return [];
  const existingById = groupProviders(existingProviders, provider => provider.id);
  const existingByName = groupProviders(existingProviders, provider => normalizeProviderIdentityName(provider.name));
  const incomingIdCounts = countIncomingProviderReferences(incomingProviders, 'id');
  const incomingLegacyNameCounts = countIncomingProviderReferences(incomingProviders, 'legacy_name');
  const claimedProviderIds = new Set<string>();
  return incomingProviders.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const provider = raw as Record<string, unknown>;
    const name = String(provider.name || '').trim();
    const previousName = String(provider.previous_name || provider._previous_name || '').trim();
    const incomingKey = String(provider.api_key || provider.key || '');
    const shouldPreserve = !incomingKey || /^(\*+|sk-redacted|sk-\*\*\*REDACTED\*\*\*)$/i.test(incomingKey);
    if (!shouldPreserve) return provider;
    const rawId = provider.id;
    const incomingId = validExplicitProviderId(rawId);
    const hasSuppliedIdentity = rawId !== undefined && rawId !== null && String(rawId).trim() !== '';
    let existing: ProviderConfig | undefined;
    if (incomingId && incomingIdCounts.get(incomingId) === 1) {
      existing = uniqueUnclaimedProvider(existingById.get(incomingId), claimedProviderIds);
    } else if (!hasSuppliedIdentity) {
      const legacyName = previousName || name;
      const normalizedLegacyName = normalizeProviderIdentityName(legacyName);
      if (incomingLegacyNameCounts.get(normalizedLegacyName) === 1) {
        existing = uniqueUnclaimedProvider(existingByName.get(normalizedLegacyName), claimedProviderIds);
      }
    }
    if (!existing?.api_key) return provider;
    claimedProviderIds.add(existing.id);
    const { previous_name, _previous_name, ...cleanProvider } = provider;
    void previous_name;
    void _previous_name;
    return { ...cleanProvider, api_key: existing.api_key };
  });
}

function countIncomingProviderReferences(
  incomingProviders: unknown[],
  kind: 'id' | 'legacy_name',
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of incomingProviders) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const provider = raw as Record<string, unknown>;
    const rawId = provider.id;
    const incomingId = validExplicitProviderId(rawId);
    const hasSuppliedIdentity = rawId !== undefined && rawId !== null && String(rawId).trim() !== '';
    const key = kind === 'id'
      ? incomingId
      : hasSuppliedIdentity
        ? undefined
        : normalizeProviderIdentityName(String(provider.previous_name || provider._previous_name || provider.name || ''));
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function groupProviders(
  providers: ProviderConfig[],
  keyOf: (provider: ProviderConfig) => string,
): Map<string, ProviderConfig[]> {
  const grouped = new Map<string, ProviderConfig[]>();
  for (const provider of providers) {
    const key = keyOf(provider);
    const values = grouped.get(key) || [];
    values.push(provider);
    grouped.set(key, values);
  }
  return grouped;
}

function uniqueUnclaimedProvider(
  providers: ProviderConfig[] | undefined,
  claimedProviderIds: Set<string>,
): ProviderConfig | undefined {
  if (!providers || providers.length !== 1) return undefined;
  return claimedProviderIds.has(providers[0].id) ? undefined : providers[0];
}

export function defaultModelConfig(modelName: string, display = modelName, description = ''): ModelConfig {
  return {
    name: modelName,
    display: display || modelName,
    description,
    max_tokens: 8192,
    vision: false,
    thinking: false,
    image_output: false,
    enabled: true,
    preview: /(?:^|[-_.])(preview|experimental|beta)(?:$|[-_.])/i.test(modelName),
    privacy: ['default'],
    capabilities: ['text_input', 'text_output'],
    fallback_only: false,
    validation: {
      level: 'discovered',
      status: 'unavailable',
      checked_at: '',
      capabilities: {},
    },
    speed_rating: 'unknown',
    capability_rating: 'unknown',
    intelligence_tiers: {
      low: { description: 'Quick' },
      medium: { description: 'Balanced' },
      high: { description: 'Deep' },
    },
  };
}

export function stableProviderId(name: string, baseUrl: string, protocol: ProviderProtocol): string {
  const normalizedName = normalizeProviderIdentityName(name);
  const normalizedUrl = normalizeProviderIdentityEndpoint(baseUrl);
  const digest = providerIdentityDigest(protocol, normalizedName, normalizedUrl);
  return `provider-${digest}`;
}

function migrateProviderIdsInConfig(config: Record<string, Record<string, ConfigEntry>>): boolean {
  const entry = config.models?.providers;
  if (!entry || !Array.isArray(entry.value)) return false;
  const migrated = assignUniqueProviderIds(entry.value);
  if (migrated.changed) entry.value = migrated.providers;
  return migrated.changed;
}

function assignUniqueProviderIds(rawProviders: unknown[]): { providers: unknown[]; changed: boolean } {
  const explicitOwners = new Map<string, number>();
  for (let index = 0; index < rawProviders.length; index += 1) {
    const raw = rawProviders[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const explicitId = validExplicitProviderId((raw as Record<string, unknown>).id);
    if (explicitId && !explicitOwners.has(explicitId)) explicitOwners.set(explicitId, index);
  }

  const used = new Set<string>();
  let changed = false;
  const providers = rawProviders.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const provider = raw as Record<string, unknown>;
    const name = String(provider.name || '').trim();
    if (!name) return raw;
    const baseUrl = String(provider.base_url || provider.endpoint || provider.url || '');
    const protocol = normalizeProviderProtocol(provider.protocol, name, baseUrl);
    const explicitId = validExplicitProviderId(provider.id);
    const ownsExplicitId = !!explicitId && explicitOwners.get(explicitId) === index;
    let resolvedId = ownsExplicitId ? explicitId : stableProviderId(name, baseUrl, protocol);

    if (!ownsExplicitId && (used.has(resolvedId) || explicitOwners.has(resolvedId))) {
      let discriminator = 2;
      do {
        resolvedId = duplicateProviderId(name, baseUrl, protocol, discriminator);
        discriminator += 1;
      } while (used.has(resolvedId) || explicitOwners.has(resolvedId));
    }

    used.add(resolvedId);
    if (provider.id !== resolvedId) {
      changed = true;
      return { ...provider, id: resolvedId };
    }
    return raw;
  });
  return { providers, changed };
}

function validExplicitProviderId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  if (!id || id.length > 256) return undefined;
  for (const character of id) {
    const code = character.codePointAt(0) || 0;
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return id;
}

function providerMutationIndex(providers: ProviderConfig[], providerIdOrLegacyName: string): number {
  const reference = String(providerIdOrLegacyName || '').trim();
  if (!reference) return -1;
  const byId = providers.findIndex(provider => provider.id === reference);
  if (byId >= 0) return byId;
  const byName: number[] = [];
  for (let index = 0; index < providers.length; index += 1) {
    if (providers[index].name === reference) byName.push(index);
  }
  return byName.length === 1 ? byName[0] : -1;
}

function parseDeploymentSelectionValue(value: string): { providerId: string; modelId: string } | null {
  const marker = String(value || '').trim();
  if (!marker.startsWith('deployment:')) return null;
  const parts = marker.slice('deployment:'.length).split(':');
  if (parts.length < 2) return null;
  try {
    const providerId = decodeURIComponent(parts.shift() || '').trim();
    const modelId = decodeURIComponent(parts.join(':')).trim();
    return providerId && modelId ? { providerId, modelId } : null;
  } catch {
    return null;
  }
}

function normalizeProviderIdentityName(name: string): string {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeProviderIdentityEndpoint(baseUrl: string): string {
  const value = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    const pathName = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathName}${parsed.search}`;
  } catch {
    return value.toLowerCase();
  }
}

function duplicateProviderId(name: string, baseUrl: string, protocol: ProviderProtocol, discriminator: number): string {
  const digest = providerIdentityDigest(
    protocol,
    normalizeProviderIdentityName(name),
    normalizeProviderIdentityEndpoint(baseUrl),
    `duplicate-${discriminator}`,
  );
  return `provider-${digest}`;
}

function providerIdentityDigest(
  protocol: ProviderProtocol,
  normalizedName: string,
  normalizedEndpoint: string,
  discriminator = '',
): string {
  return createHash('sha256')
    .update(`${protocol}\u0000${normalizedName}\u0000${normalizedEndpoint}\u0000${discriminator}`)
    .digest('hex')
    .slice(0, 16);
}

function normalizeModelValidation(model: ModelConfig, hasExplicitValidation = true): ModelValidationSummary {
  const raw = model.validation as ModelValidationSummary | undefined;
  const levels = new Set<ModelValidationSummary['level']>(['discovered', 'legacy_basic', 'basic', 'standard', 'extended']);
  const statuses = new Set<ModelValidationSummary['status']>(['verified', 'degraded', 'unavailable', 'auth_error', 'rate_limited', 'invalid_config']);
  if (hasExplicitValidation && raw && levels.has(raw.level) && statuses.has(raw.status)) {
    return {
      ...raw,
      checked_at: String(raw.checked_at || ''),
      capabilities: { ...(raw.capabilities || {}) },
    };
  }
  const legacyStatus = String(model.evaluation?.status || '').toLowerCase();
  const status: ModelValidationSummary['status'] = legacyStatus === 'available'
    ? 'verified'
    : legacyStatus.includes('auth') || legacyStatus.includes('401') || legacyStatus.includes('403')
      ? 'auth_error'
      : legacyStatus.includes('rate') || legacyStatus.includes('429')
        ? 'rate_limited'
        : legacyStatus.includes('config') || legacyStatus.includes('400')
          ? 'invalid_config'
          : 'unavailable';
  return {
    level: legacyStatus === 'available' ? 'legacy_basic' : 'discovered',
    status,
    checked_at: String(model.evaluation?.checked_at || ''),
    capabilities: {
      text_input: !!model.evaluation?.text_input,
      text_output: !!model.evaluation?.text_output,
      image_input: !!model.evaluation?.vision_input,
      image_output: !!model.evaluation?.image_output,
    },
  };
}

export function defaultConfig(): Record<string, Record<string, ConfigEntry>> {
  const defaultShell = process.platform === 'win32' ? 'powershell' : 'bash';
  return JSON.parse(JSON.stringify({
    general: {
      tone: { _description: "Conversation style", _type: "choice", _values: ["strict_simple","casual_friendly"], value: "strict_simple" },
      language: { _description: "Default language", _type: "choice", _values: ["en","zh","auto"], value: "auto" },
      close_behavior: { _description: "Close behavior", _type: "choice", _values: ["minimize","exit"], value: "minimize" },
      default_input: { _description: "Default input mode", _type: "choice", _values: ["guide","next"], value: "guide" },
      auto_archive_on_close: { _description: "Auto archive on close", _type: "boolean", value: true },
    },
    models: {
      providers: { _description: "LLM providers", _type: "array", value: [] },
      default_model: { _description: "Default model", _type: "string", value: "" },
      default_intelligence: { _description: "Default intelligence tier", _type: "choice", _values: ["low","medium","high"], value: "medium" },
      agent_engine: { _description: "Agent engine", _type: "choice", _values: ["builtin","codex","opencode"], value: "builtin" },
      auto_switch: { _description: "Auto-switch models", _type: "boolean", value: false },
      auto_switch_preference: { _description: "Auto route policy", _type: "choice", _values: ["quality","balanced","cost","speed"], value: "balanced" },
      auto_switch_scope: { _description: "Auto-switch scope", _type: "choice", _values: ["all","provider"], value: "all" },
      auto_switch_anchor_provider: { _description: "Stable provider id anchor for provider-scoped Auto routing", _type: "string", value: "" },
      auto_switch_subset: { _description: "Explicit deployment allowlist for Auto; new catalog models are never added automatically", _type: "array", value: [] },
      auto_allow_preview: { _description: "Allow preview or experimental deployments in Auto", _type: "boolean", value: false },
      auto_privacy: { _description: "Required Auto privacy policy", _type: "choice", _values: ["default","no_training","zdr"], value: "default" },
      auto_data_region: { _description: "Required Auto data region; empty disables the region filter", _type: "string", value: "" },
      auto_required_protocol_parameters: { _description: "Protocol parameters every Auto candidate must support", _type: "array", value: [] },
      auto_max_expected_cost_usd: { _description: "Hard expected request cost ceiling; 0 disables the ceiling", _type: "number", value: 0 },
      fallback_on_unavailable: { _description: "Fallback when model unavailable", _type: "boolean", value: true },
      openai_api_mode: { _description: "OpenAI-compatible API mode", _type: "choice", _values: ["chat_stream","chat","responses"], value: "chat_stream" },
      openai_streaming: { _description: "Legacy streaming flag for OpenAI-compatible chat completions", _type: "boolean", value: true },
      fuzzy_injection: { _description: "Fuzzy model injection", _type: "boolean", value: false },
    },
    agent: {
      default_mode: { _description: "Default mode", _type: "choice", _values: ["build","plan","goal","flow"], value: "build" },
      run_in_wsl: { _description: "Run the Agent backend in WSL on Windows", _type: "boolean", value: false },
      wsl_distro: { _description: "WSL distribution used by the Agent backend", _type: "string", value: "Ubuntu-24.04" },
      option_feedback: { _description: "Option feedback level", _type: "choice", _values: ["default","ask_more","ask_less","fully_autonomous"], value: "default" },
      auto_adjust_settings: { _description: "Agent can adjust settings", _type: "boolean", value: false },
      process_timeout_ms: { _description: "Optional outer timeout for one desktop conversation turn in milliseconds; 0 means no extra conversation-kernel timeout", _type: "integer", value: 0 },
      goal_max_continuations: { _description: "Maximum automatic Goal continuations per user turn before pausing with a visible warning; 0 means unlimited", _type: "integer", value: 25 },
      custom_prompt: { _description: "Custom system prompt", _type: "string", value: "" },
    },
    workspace: {
      access_permission: { _description: "File access scope", _type: "choice", _values: ["full_access","outside_readonly","no_outside_access"], value: "full_access" },
      on_permission_violation: { _description: "On permission violation", _type: "choice", _values: ["ask_user","deny"], value: "ask_user" },
      prompt_mode: { _description: "Prompt loading mode", _type: "choice", _values: ["global_only","workspace_only","both"], value: "both" },
      auto_create_timestamp_workspace: { _description: "Auto-create timestamp workspace", _type: "boolean", value: true },
    },
    skills: {
      auto_download: { _description: "Auto-download skills", _type: "choice", _values: ["aggressive","conservative","disabled"], value: "conservative" },
    },
    ui: {
      gradient_colors: { _description: "Gradient colors (hex)", _type: "array", value: ["#00ff88","#00ccff","#aa44ff","#ff4488"] },
      gradient_speed: { _description: "Animation speed 1-5", _type: "range", _min:1, _max:5, value: 2 },
      gradient_width: { _description: "Border width", _type: "integer", _min:1, _max:4, value: 2 },
      glass_alpha: { _description: "Glass opacity", _type: "range", _min:0, _max:1, value: 0.85 },
      show_mode_label: { _description: "Show mode on hover", _type: "boolean", value: true },
      left_panel_collapsed: { _description: "Left panel collapsed", _type: "boolean", value: false },
      right_panel_collapsed: { _description: "Right panel collapsed", _type: "boolean", value: false },
      bottom_panel_collapsed: { _description: "Bottom terminal panel collapsed", _type: "boolean", value: false },
      secondary_panel_collapsed: { _description: "Workspace secondary sidebar collapsed", _type: "boolean", value: true },
      dark_mode: { _description: "Dark/light mode", _type: "choice", _values: ["dark","light","system"], value: "dark" },
      background_color: { _description: "Optional application background color (#RRGGBB)", _type: "string", value: "" },
      font_family: { _description: "Optional local application font family", _type: "string", value: "" },
      minimize_to_tray: { _description: "Minimize to tray", _type: "boolean", value: true },
    },
    proxy: {
      enabled: { _description: "Enable HTTP proxy", _type: "boolean", value: false },
      url: { _description: "Proxy URL (e.g. http://127.0.0.1:7890)", _type: "string", value: "http://127.0.0.1:7890" },
      auth: { _description: "Proxy auth user:pass (optional)", _type: "string", value: "" },
    },
    web: {
      search_enabled: { _description: "Web search enabled", _type: "boolean", value: true },
      fetch_enabled: { _description: "Web fetch enabled", _type: "boolean", value: true },
      default_search_engine: { _description: "Search engine", _type: "choice", _values: ["duckduckgo","google","bing"], value: "duckduckgo" },
    },
    git: {
      auto_pull: { _description: "Auto-pull", _type: "boolean", value: false },
      auto_push: { _description: "Auto-push", _type: "boolean", value: false },
      github_login: { _description: "GitHub token", _type: "string", value: "" },
    },
    terminal: {
      default_shell: { _description: "Default shell", _type: "choice", _values: ["powershell","pwsh","bash","sh","cmd"], value: defaultShell },
      interrupt_timeout_ms: { _description: "Upper cap for Agent bash timeout_ms and terminal forced interruption in milliseconds; 0 means no cap/no forced timeout", _type: "integer", value: 0 },
    },
    tools: {
      enabled: { _description: "Native built-in Agent tool switches", _type: "object", value: defaultNativeToolEnabled() },
    },
    context: {
      auto_compress: { _description: "Auto-compress history", _type: "boolean", value: true },
      compress_threshold_chars: { _description: "Compression threshold", _type: "integer", value: 80000 },
      keep_recent_messages: { _description: "Keep recent messages", _type: "integer", value: 10 },
    },
    automation: {
      schedules: { _description: "Automation schedules", _type: "array", value: [] },
    },
  }));
}
