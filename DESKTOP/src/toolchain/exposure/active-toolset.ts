import { ActiveToolManifestEntry } from '../../context/domain/types';
import { ToolRegistry } from '../registry/tool-registry';
import { sha256 } from '../../context/serializers/deterministic';

/**
 * Preset toolsets. Preset order and schema serialization are stable so the
 * prompt cache is not destroyed by arbitrary tool combinations.
 */
export const BASE_TOOLSET_ID = 'toolset-core';
export const PRESET_TOOLSETS: Record<string, string[]> = {
  'toolset-core': [
    'capability.search',
    'capability.inspect',
    'tool.schema.load',
    'tool.schema.release',
    'toolset.status',
    'build_history.read',
    'task.list',
    'plan.read',
  ],
  'toolset-coding': ['file.read', 'file.search', 'file.edit', 'terminal.exec', 'vcs.inspect'],
  'toolset-research': ['web.search', 'web.fetch', 'code.search'],
  'toolset-git-review': ['vcs.diff', 'vcs.status', 'vcs.log'],
  'toolset-file-edit': ['file.read', 'file.write', 'file.edit', 'file.glob'],
  'toolset-subagent-readonly': ['file.read', 'code.search', 'test.inspect'],
  'toolset-subagent-coding': ['file.read', 'file.write', 'file.edit', 'code.search', 'test.run'],
  'toolset-recovery': ['build_history.read', 'plan.read', 'task.list', 'toolset.status'],
};

export interface ActiveToolset {
  toolsetId: string;
  version: number;
  entries: ActiveToolManifestEntry[];
  schemaTokens: number;
  /** Stable hash across the manifest (not the schemas). */
  manifestHash: string;
}

/**
 * Active Toolset Manifest — layer 2. Injected every turn as a short directory
 * of the currently-loaded tools, without repeating full schemas.
 */
export class ActiveToolsetService {
  constructor(private readonly registry: ToolRegistry) {}

  build(toolIds: string[], options?: { toolsetId?: string; version?: number }): ActiveToolset {
    const toolsetId = options?.toolsetId || 'toolset-core';
    const version = options?.version ?? 1;
    const entries: ActiveToolManifestEntry[] = toolIds.map(toolId => {
      const tool = this.registry.get(toolId);
      if (!tool) {
        return {
          toolId,
          capabilityId: '',
          shortDescription: '(unregistered)',
          riskLevel: 'read',
          availability: 'temporarily_unavailable',
          schemaLoaded: false,
        };
      }
      return {
        toolId: tool.toolId,
        capabilityId: tool.capabilityId,
        shortDescription: tool.shortDescription,
        riskLevel: tool.riskLevel,
        availability: tool.enabled ? 'ready' : 'temporarily_unavailable',
        schemaLoaded: true,
      };
    });
    const schemaTokens = toolIds.reduce((sum, toolId) => {
      const tool = this.registry.get(toolId);
      return sum + (tool ? Math.ceil(JSON.stringify(tool.inputSchema).length / 4) : 0);
    }, 0);
    return {
      toolsetId,
      version,
      entries,
      schemaTokens,
      manifestHash: sha256({ toolsetId, version, entries }),
    };
  }

  render(active: ActiveToolset): string {
    const lines = active.entries.map(entry =>
      `- ${entry.toolId}: ${entry.riskLevel}, ${entry.schemaLoaded ? 'schema loaded' : 'schema not loaded'}, ${entry.availability}`);
    return [
      `<active_toolset id="${active.toolsetId}" version="${active.version}">`,
      ...lines,
      '</active_toolset>',
    ].join('\n');
  }
}
