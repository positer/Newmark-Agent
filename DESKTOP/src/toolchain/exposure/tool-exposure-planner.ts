import { RiskLevel, ToolExposurePlan } from '../../context/domain/types';
import { ToolRegistry } from '../registry/tool-registry';
import { CapabilityCatalog } from '../capabilities/capability-catalog';
import { BASE_TOOLSET_ID, PRESET_TOOLSETS } from './active-toolset';
import { sha256 } from '../../context/serializers/deterministic';

export interface ExposurePlannerInput {
  agentRunId: string;
  buildBlockId: string;
  userInput: string;
  objective: string;
  previousToolCalls: string[];
  toolUsageFrequency: Map<string, number>;
  permissionScope: string[];
  tokenBudget: number;
  /** provider tool count limit (0 = unlimited). */
  providerToolLimit: number;
}

export interface ExposurePlanResult {
  plan: ToolExposurePlan;
  baseToolIds: string[];
  activeToolIds: string[];
  suggestedCapabilityIds: string[];
}

const RISK_PREFERENCE: Record<RiskLevel, number> = { read: 0, write: 1, external: 2, destructive: 3 };

/**
 * Tool Exposure Planner — decides what is exposed each turn before the model
 * request, without relying on the Agent to ask. Strategy:
 * 1. Always expose the minimal base toolset.
 * 2. Load one stable preset toolset for the detected task domain.
 * 3. Add only highly relevant tools.
 * 4. Never randomly reorder; stable hash.
 * 5. When the token budget is exceeded, release least-used tools first.
 * 6. Write/external/destructive tools default to conservative.
 */
export class ToolExposurePlanner {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly catalog: CapabilityCatalog,
  ) {}

  plan(input: ExposurePlannerInput): ExposurePlanResult {
    const domain = detectDomain(input);
    const preset = PRESET_TOOLSETS[domain] || [];
    const baseToolIds = PRESET_TOOLSETS[BASE_TOOLSET_ID] || [];

    const active = new Set<string>(baseToolIds);
    for (const toolId of preset) {
      if (this.registry.get(toolId)) active.add(toolId);
    }

    // Task-relevant additions: match capability domains present in user input.
    const suggestedCapabilityIds: string[] = [];
    const intent = String(input.userInput || '').toLowerCase();
    // Mirrors the legacy selectTaskToolDefinitions intent semantics:
    // file/code context wins bare search to the web domain, and web wording
    // never pulls the code-search (core) domain in by itself.
    const fileContext = /\b(?:code|repo(?:sitory)?|workspace|files?|director(?:y|ies)|project)\b/i.test(intent)
      || /(?:代码|仓库|工作区|文件|目录|项目)/.test(intent);
    const webContext = /\b(?:web|internet|online|website|url|news)\b|https?:\/\//i.test(intent)
      || /(?:联网|网页|网站|新闻|网址|链接)/.test(intent);
    const bareSearch = /\b(?:search|lookup)\b/i.test(intent) || /(?:搜索|查找|搜一下)/.test(intent);
    const codeSearch = /\b(?:search|find|symbol|reference)\b/i.test(intent) || /(?:搜索|查找|搜一下)/.test(intent);
    const codingVerbs = /\b(?:implement|fix|debug|refactor|change|update|patch|error|bug)\b/i.test(intent)
      || /(?:实现|修复|调试|重构|改动|更新|排查|报错|错误|故障)/.test(intent);
    const domainSignals: Array<[boolean, string]> = [
      [/\b(git|commit|push|pull|pr|branch|diff)\b/.test(intent), 'vcs.inspect'],
      [/\b(?:build|compile|test|run)\b/.test(intent), 'test.run'],
      [codingVerbs || (fileContext && codeSearch), 'code.search'],
      [webContext || (!fileContext && bareSearch), 'web.search'],
      [/\b(?:automation|schedule|reminder|recurring)\b/.test(intent) || /(?:自动化|定时|提醒|周期任务)/.test(intent), 'automation.manage'],
      [/\b(?:workflow|flow)\b/.test(intent) || /(?:工作流|流程文件)/.test(intent), 'flow.manage'],
      [/\bmemory(?: lab)?\b/.test(intent) || /(?:记忆实验室|记忆库)/.test(intent), 'memory.manage'],
      [/\b(?:computer[ _-]?use|desktop|screen|mouse|keyboard|window|application)\b/.test(intent) || /(?:电脑操作|桌面|屏幕|鼠标|键盘|窗口|应用程序)/.test(intent), 'computer.manage'],
      [/\b(?:browser|webpage|click|login|form|chrome|edge)\b/.test(intent) || /(?:浏览器|页面|点击|登录|表单)/.test(intent), 'browser.manage'],
      [/\b(?:terminal takeover|interactive shell|interactive terminal)\b/.test(intent) || /(?:终端接管|交互式终端|交互式 shell)/.test(intent), 'terminal.manage'],
      [/\b(?:github|pull request|issue|fork)\b|\bpr\b/.test(intent) || /(?:拉取请求|议题)/.test(intent), 'github.manage'],
      [/\bssh\b/.test(intent) || /(?:远程主机|远程工作区)/.test(intent), 'ssh.manage'],
      [/\bskills?\b/.test(intent) || /(?:技能市场|安装技能)/.test(intent), 'skill.manage'],
      [/\b(?:linked plan|project plan)\b/.test(intent) || /(?:关联计划|项目计划)/.test(intent), 'plan.manage'],
      [/\b(?:(?:build|task|work) history|previous (?:build|task|work) details?|history details?)\b/.test(intent) || /(?:历史(?:任务|工作|构建).*(?:详情|细节|具体)|上个任务.*(?:具体|做了什么|改了什么)|之前.*(?:具体做了什么|工作内容)|查询.*Build Block)/.test(intent), 'history.query'],
      [/\b(?:display|show|present|embed)\b.{0,24}\b(?:image|diagram|illustration)\b|\b(?:image|diagram|illustration)\b.{0,24}\b(?:display|show|present|embed)\b/.test(intent) || /(?:显示|展示|嵌入|呈现).{0,16}(?:图片|图像|示意图|架构图)|(?:图片|图像|示意图|架构图).{0,16}(?:显示|展示|嵌入|呈现)/.test(intent), 'media.display'],
      [/\b(?:ask|question|clarify|confirm|multiple choice)\b/.test(intent) || /(?:询问|提问|确认|澄清|选择题|让我选择)/.test(intent), 'interaction.manage'],
    ];
    for (const [signal, capabilityId] of domainSignals) {
      if (signal) suggestedCapabilityIds.push(capabilityId);
    }
    // Add the implementation tools for suggested capabilities.
    for (const capabilityId of suggestedCapabilityIds) {
      for (const tool of this.registry.all()) {
        if (tool.capabilityId === capabilityId && this.registry.get(tool.toolId)?.enabled) {
          active.add(tool.toolId);
        }
      }
    }

    // Explicitly named tools from previous calls are retained (continuity).
    for (const toolId of input.previousToolCalls || []) {
      if (this.registry.get(toolId)?.enabled) active.add(toolId);
    }

    // Track omitted tools and reasons.
    const omittedToolIds: string[] = [];
    const omissionReasons: Record<string, string> = {};
    for (const tool of this.registry.all()) {
      if (!tool.enabled) {
        omittedToolIds.push(tool.toolId);
        omissionReasons[tool.toolId] = 'disabled';
        continue;
      }
      if (active.has(tool.toolId)) continue;
      if (RISK_PREFERENCE[tool.riskLevel] >= 3) {
        omittedToolIds.push(tool.toolId);
        omissionReasons[tool.toolId] = 'high_risk_not_auto_exposed';
        continue;
      }
      omittedToolIds.push(tool.toolId);
      omissionReasons[tool.toolId] = 'not_relevant';
    }

    // Provider tool count limit.
    if (input.providerToolLimit > 0) {
      const ordered = [...active].sort((a, b) => {
        const aFreq = input.toolUsageFrequency.get(a) || 0;
        const bFreq = input.toolUsageFrequency.get(b) || 0;
        return bFreq - aFreq;
      });
      const kept = new Set<string>();
      for (const toolId of ordered) {
        if (kept.size >= input.providerToolLimit) {
          if (!omittedToolIds.includes(toolId)) omittedToolIds.push(toolId);
          omissionReasons[toolId] = 'provider_tool_limit';
        } else {
          kept.add(toolId);
        }
      }
      active.clear();
      for (const toolId of kept) active.add(toolId);
    }

    // Token budget: release least-used tools (never the base core) until under.
    let schemaTokens = this.estimateSchemaTokens([...active]);
    let iteration = 0;
    while (schemaTokens > input.tokenBudget && iteration < 40) {
      iteration += 1;
      const removable = [...active]
        .filter(toolId => !baseToolIds.includes(toolId))
        .sort((a, b) => (input.toolUsageFrequency.get(a) || 0) - (input.toolUsageFrequency.get(b) || 0));
      if (!removable.length) break;
      const toolId = removable[0];
      active.delete(toolId);
      if (!omittedToolIds.includes(toolId)) omittedToolIds.push(toolId);
      omissionReasons[toolId] = 'schema_token_budget';
      schemaTokens = this.estimateSchemaTokens([...active]);
    }

    const activeToolIds = [...active];
    const plan: ToolExposurePlan = {
      planId: `plan-${sha256({ buildBlockId: input.buildBlockId, activeToolIds, suggestedCapabilityIds }).slice(0, 16)}`,
      agentRunId: input.agentRunId,
      buildBlockId: input.buildBlockId,
      baseToolsetId: BASE_TOOLSET_ID,
      activeToolIds,
      suggestedCapabilityIds: [...new Set(suggestedCapabilityIds)],
      omittedToolIds,
      omissionReasons,
      estimatedSchemaTokens: schemaTokens,
      stableToolsetHash: sha256({ activeToolIds, suggestedCapabilityIds }),
      createdAt: new Date().toISOString(),
    };
    return { plan, baseToolIds, activeToolIds, suggestedCapabilityIds: plan.suggestedCapabilityIds };
  }

  private estimateSchemaTokens(toolIds: string[]): number {
    return toolIds.reduce((sum, toolId) => {
      const tool = this.registry.get(toolId);
      return sum + (tool ? Math.ceil(JSON.stringify(tool.inputSchema).length / 4) : 0);
    }, 0);
  }
}

function detectDomain(input: ExposurePlannerInput): string {
  const text = String(input.userInput || input.objective || '').toLowerCase();
  if (/\b(git|github|commit|push|pull|pr|branch|diff)\b/.test(text)) return 'toolset-git-review';
  if (/\b(build|compile|test|run|code|coding)\b/.test(text)) return 'toolset-coding';
  if (/\b(search|research|lookup|web|find online)\b/.test(text)) return 'toolset-research';
  if (/\b(read|edit|write|refactor|change)\b/.test(text)) return 'toolset-file-edit';
  return 'toolset-coding';
}
