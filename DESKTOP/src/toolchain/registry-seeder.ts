import { sha256 } from '../context/serializers/deterministic';
import { RiskLevel } from '../context/domain/types';
import { ToolchainCore, createToolchainCore } from './index';
import { ToolDescriptorInput } from './registry/tool-registry';
import { CapabilityDescriptorInput } from './capabilities/capability-catalog';

/**
 * Legacy OpenAI-style function definition as produced by
 * ToolExecutor.definitions(mode): { type: 'function', function: { name,
 * description, parameters } }.
 */
export interface FunctionToolDefinition {
  type?: 'function';
  function?: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ToolAnnotations {
  readOnly?: boolean;
  destructive?: boolean;
  requiresApproval?: boolean;
  sideEffects?: string[];
}

/** NewmarkToolDefinition-compatible shape accepted by the seeder. */
export interface SeededToolDefinition {
  name: string;
  description: string;
  inputSchema?: unknown;
  annotations?: ToolAnnotations;
}

export interface SeededToolchain {
  core: ToolchainCore;
  toolIds: string[];
  capabilities: string[];
}

export interface RegistrySeedOptions {
  namespace?: string;
  version?: string;
}

const DOMAIN_PREFIXES: ReadonlyArray<[RegExp, string]> = [
  [/^git_/, 'git'],
  [/^memory_lab_/, 'memory'],
  [/^automation_/, 'automation'],
  [/^flow_/, 'flow'],
  [/^subagent_/, 'subagent'],
  [/^browser_/, 'browser'],
  [/^web_/, 'web'],
  [/^computer_use$/, 'computer'],
  [/^(image_|ocr_|pdf_)/, 'media'],
  [/^(bash|pwd|read|write|edit|glob|grep)$/, 'core'],
];

const READ_TOOL_PATTERN = /^(pwd|read|glob|grep|git_status|git_log|git_diff|git_branch|git_show|memory_lab_read|memory_lab_query|skill|linked_plan|build_history_query|subagent_read|subagent_result|subagent_list|subagent_progress|question|image_inspect|image_display|ocr_read|pdf_read|automation_list|automation_status)$/;

const DESTRUCTIVE_PATTERN = /destroy|delete|erase|remove|rm\s|force|shutdown|kill|terminate|drop\s|prune/;

/** Best-effort domain classification used to derive capability ids. */
export function inferDomain(name: string): string {
  for (const [pattern, domain] of DOMAIN_PREFIXES) {
    if (pattern.test(name)) return domain;
  }
  if (name === 'question') return 'interaction';
  if (name === 'skill') return 'skills';
  if (name === 'task') return 'subagent';
  if (/^(linked_plan|build_history_query)$/.test(name)) return 'plan';
  return 'general';
}

/**
 * Best-effort risk classification. Destructive beats external beats write
 * beats read. An explicit destructive annotation always wins; readOnly
 * annotation forces read unless destructive was declared.
 */
export function inferRiskLevel(name: string, description: string, annotations?: ToolAnnotations): RiskLevel {
  if (annotations?.destructive) return 'destructive';
  if (annotations?.readOnly) return 'read';
  const text = `${name} ${description || ''}`.toLowerCase();
  if (name === 'git_push') return 'destructive';
  if (DESTRUCTIVE_PATTERN.test(text)) return 'destructive';
  if (/^(web_|browser_|ssh_|gh_)/.test(name) || /^git_(clone|pull|fetch)$/.test(name)) return 'external';
  if (READ_TOOL_PATTERN.test(name)) return 'read';
  return 'write';
}

function inferIdempotency(name: string): 'idempotent' | 'conditionally_idempotent' | 'non_idempotent' | undefined {
  if (/^(bash|computer_use|browser_use|run|exec|execute|task)$/.test(name)) return 'non_idempotent';
  if (/^(write|edit|append|send|save|create|update|set|put|register|patch)/.test(name)) return 'conditionally_idempotent';
  return undefined;
}

function resolveDefinition(definition: unknown): { name: string; description: string; parameters?: unknown; annotations?: ToolAnnotations } | null {
  if (!definition || typeof definition !== 'object') return null;
  const record = definition as Record<string, unknown>;
  const fn = record.function as Record<string, unknown> | undefined;
  if (fn && typeof fn.name === 'string') {
    return {
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: fn.parameters ?? { type: 'object', properties: {}, required: [] },
    };
  }
  if (typeof record.name === 'string') {
    return {
      name: record.name,
      description: typeof record.description === 'string' ? record.description : '',
      parameters: record.inputSchema,
      annotations: record.annotations as ToolAnnotations | undefined,
    };
  }
  return null;
}

/**
 * Seed an empty ToolchainCore from the legacy tool definition list produced
 * by ToolExecutor.definitions(mode). One capability is registered per
 * inferred domain with the domain's tools listed as operations; each tool is
 * registered against that capability. Deterministic and idempotent only on a
 * fresh core — callers must not seed the same core twice with different
 * definitions.
 */
export function seedToolchainFromDefinitions(
  definitions: unknown[],
  options?: RegistrySeedOptions,
): SeededToolchain {
  const core = createToolchainCore();
  const namespace = options?.namespace ?? 'newmark';
  const version = options?.version ?? '1.0.0';
  const toolIds: string[] = [];
  const capabilities: string[] = [];
  const byDomain = new Map<string, { input: CapabilityDescriptorInput; resolved: Array<{ name: string; riskLevel: RiskLevel; parameters?: unknown }> }>();

  const definitions_ = (definitions || [])
    .map(resolveDefinition)
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  for (const definition of definitions_) {
    const domain = inferDomain(definition.name);
    const riskLevel = inferRiskLevel(definition.name, definition.description, definition.annotations);
    let entry = byDomain.get(domain);
    if (!entry) {
      entry = {
        input: {
          capabilityId: `cap.${domain}`,
          domain,
          name: `capability.${domain}`,
          shortDescription: `${domain} domain capability`,
          detailedDescription: `Legacy tools grouped into the ${domain} domain by the registry seeder.`,
          operations: [],
          riskLevel,
          sideEffectClass: riskLevel === 'read' ? 'none' : undefined,
          loadPolicy: riskLevel === 'read' ? 'on_demand' : undefined,
          discoverability: 'task_relevant',
        },
        resolved: [],
      };
      byDomain.set(domain, entry);
    }
    entry.input.operations.push(definition.name);
    if (riskLevel === 'destructive' || (riskLevel === 'external' && entry.input.riskLevel !== 'destructive')) {
      entry.input.riskLevel = riskLevel;
    }
    entry.resolved.push({ name: definition.name, riskLevel, parameters: definition.parameters });
  }

  for (const [domain, entry] of byDomain) {
    const requiredPermissions = entry.input.riskLevel === 'destructive'
      ? ['destructive']
      : entry.input.riskLevel === 'external'
        ? ['network']
        : entry.input.riskLevel === 'write'
          ? ['workspace_write']
          : [];
    const capability = core.catalog.register({
      ...entry.input,
      operations: [...entry.input.operations].sort(),
      requiredPermissions,
    });
    capabilities.push(capability.capabilityId);
    for (const tool of entry.resolved) {
      const idempotency = inferIdempotency(tool.name);
      const required = tool.riskLevel === 'destructive'
        ? ['destructive']
        : tool.riskLevel === 'external'
          ? ['network']
          : tool.riskLevel === 'write'
            ? ['workspace_write']
            : [];
      const input: ToolDescriptorInput = {
        toolId: tool.name,
        capabilityId: capability.capabilityId,
        namespace,
        name: tool.name,
        version,
        shortDescription: tool.name,
        fullDescription: `${tool.name} (${domain})`,
        inputSchema: tool.parameters ?? { type: 'object', properties: {}, required: [] },
        riskLevel: tool.riskLevel,
        idempotency,
        requiredPermissions: required,
        implementationHash: sha256(tool.name),
      };
      core.registry.register(input);
      toolIds.push(tool.name);
    }
  }

  return { core, toolIds, capabilities: capabilities.sort() };
}
