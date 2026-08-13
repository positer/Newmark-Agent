import { Agent } from './agent';
import { FlowEngine, FlowWorkflow } from './flow';
import { AgentMode } from './types';
import { randomUUID } from 'crypto';

export interface FlowRunnerOptions {
  startInput?: string;
  startPc?: number;
  resumePrompt?: string;
  completedResults?: FlowCompletedResult[];
  quiet?: boolean;
  signal?: AbortSignal;
}

export interface FlowCompletedResult {
  componentId: number;
  result: string;
}

export class FlowQuestionPendingError extends Error {
  public completedResults: FlowCompletedResult[] = [];
  constructor(public readonly componentId: number) {
    super(`Flow component #${componentId} is waiting for explicit user input.`);
    this.name = 'FlowQuestionPendingError';
  }
}

const MAX_VISITS = 300;

interface FlowBuildOptions {
  workflowName: string;
  componentId: number;
  componentType: 'dialog' | 'logic' | 'goal-verification';
  visibleUserInput: string;
  activityVisibility: 'full' | 'result-only';
  finalize?: (tokens: Awaited<ReturnType<Agent['process']>>, runId: string) => string | undefined;
  signal?: AbortSignal;
}

function nestedProviderMessage(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
  for (const key of ['error', 'detail', 'response']) {
    const nested = nestedProviderMessage(record[key]);
    if (nested) return nested;
  }
  return '';
}

class FlowBuildExecutionError extends Error {
  public completedResults: FlowCompletedResult[] = [];
  constructor(message: string, public readonly componentId: number) {
    super(message);
    this.name = 'FlowBuildExecutionError';
  }
}

function flowBuildFailure(error: unknown, componentId: number): Error {
  if (error instanceof FlowBuildExecutionError) return error;
  const raw = error instanceof Error ? error.message : String(error || 'Flow component failed.');
  const status = raw.match(/\[(?:LLM Error|Error)(?::\s*(\d{3}))?[^\]]*\]/i)?.[1]
    || raw.match(/\bHTTP\s+(\d{3})\b/i)?.[1]
    || '';
  let providerMessage = '';
  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try { providerMessage = nestedProviderMessage(JSON.parse(raw.slice(jsonStart))); } catch { /* use bounded fallback */ }
  }
  if (!providerMessage) {
    providerMessage = raw
      .replace(/^\s*\[(?:LLM Error|Error)(?::[^\]]*)?\]\s*/i, '')
      .replace(/^\s*Flow component #\d+ returned an abnormal model response\.?\s*$/i, 'Model provider returned an unsuccessful response.')
      .trim();
  }
  const concise = providerMessage.replace(/\s+/g, ' ').slice(0, 320) || 'Model provider returned an unsuccessful response.';
  const providerFailure = /^\s*\[(?:LLM Error|Error)(?::|\])/i.test(raw) || !!status || jsonStart >= 0;
  return new FlowBuildExecutionError(`Flow component #${componentId} ${providerFailure ? 'model request failed' : 'failed'}${status ? ` (HTTP ${status})` : ''}: ${concise}`, componentId);
}

async function runFlowBuild(agent: Agent, prompt: string, options: FlowBuildOptions) {
  const supportsWorkRuns = Array.isArray(agent.workRuns)
    && typeof agent.beginConversationWorkRun === 'function'
    && typeof agent.finishConversationWorkRun === 'function';
  if (supportsWorkRuns && agent.workRuns.some(run => run.status === 'running')) {
    throw new Error(`Flow component #${options.componentId} cannot start before the previous Build block has terminated.`);
  }
  const runId = supportsWorkRuns ? randomUUID() : '';
  if (supportsWorkRuns) {
    agent.beginConversationWorkRun(runId, undefined, undefined, true);
    agent.setConversationWorkRunFlowMetadata(runId, {
      name: options.workflowName,
      componentId: options.componentId,
      componentType: options.componentType,
      activityVisibility: options.activityVisibility,
    });
    // Flow bypasses ConversationKernel.prompt(), so publish the component
    // boundary before provider setup to make its live Build state visible.
    if (typeof agent.emitWorkEvent === 'function') {
      agent.emitWorkEvent({
        type: 'start',
        content: `Flow component #${options.componentId} is preparing.`,
        runId,
      });
    }
  }
  let workRunFinished = false;
  try {
    throwIfFlowAborted(options.signal);
    const tokens = await agent.process(supportsWorkRuns ? {
      text: prompt,
      visibleUserInput: options.visibleUserInput,
      visibleMode: 'flow-user-input',
      runId,
    } : prompt);
    throwIfFlowAborted(options.signal);
    const text = tokens.map(token => token.text || '').join('');
    if (typeof agent.isLlmErrorText === 'function' && agent.isLlmErrorText(text)) {
      throw flowBuildFailure(text, options.componentId);
    }
    const finalResponse = options.finalize?.(tokens, runId);
    if (supportsWorkRuns && finalResponse !== undefined) {
      agent.replaceConversationWorkRunFinalResponse(runId, finalResponse);
    }
    if (supportsWorkRuns) {
      agent.finishConversationWorkRun(runId, 'completed');
      agent.flushWorkspaceConversationState();
      workRunFinished = true;
    }
    if (Array.isArray(agent.pendingOptions) && agent.pendingOptions.length > 0) {
      throw new FlowQuestionPendingError(options.componentId);
    }
    return tokens;
  } catch (error) {
    if (error instanceof FlowQuestionPendingError) throw error;
    const reportedError = options.signal?.aborted
      ? (error instanceof Error ? error : new Error(String(error || 'Flow run aborted')))
      : flowBuildFailure(error, options.componentId);
    if (supportsWorkRuns && !workRunFinished) {
      if (!options.signal?.aborted && typeof agent.emitWorkEvent === 'function') {
        agent.emitWorkEvent({ type: 'error', content: reportedError.message, runId });
      }
      agent.finishConversationWorkRun(
        runId,
        options.signal?.aborted ? 'interrupted' : 'error',
        undefined,
        options.signal?.aborted ? '' : reportedError.message,
      );
      agent.flushWorkspaceConversationState();
    }
    throw reportedError;
  }
}

async function evaluateReadOnlyBuild(
  agent: Agent,
  workflowName: string,
  componentId: number,
  componentType: 'logic' | 'goal-verification',
  title: string,
  condition: string,
  completedResults: Array<{ componentId: number; result: string }>,
  gotoTrue: number,
  gotoFalse: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const previousMode = agent.mode;
  let decision: boolean | undefined;
  try {
    // Plan policy makes the evaluator strictly read-only. The orchestration
    // wrapper is internal; the transcript shows only the actual basis and the
    // deterministic decision/jump receipt.
    agent.setMode('plan');
    agent.recordWorkStatus?.(`[Flow logic] ${title}`);
    await runFlowBuild(agent, [
      '## Read-only Build Logic Evaluation',
      'Inspect the current workspace, conversation evidence, and completed Build results only as needed.',
      'Do not modify files, applications, services, workflows, memory, or external state.',
      completedResults.length
        ? `Completed Flow component results:\n${completedResults.map(item => `- #${item.componentId}: ${item.result.slice(0, 1200)}`).join('\n')}`
        : 'No earlier Flow component result is available.',
      condition,
      'Return one final line exactly: FLOW_DECISION=true or FLOW_DECISION=false.',
    ].join('\n\n'), {
      workflowName,
      componentId,
      componentType,
      visibleUserInput: condition,
      activityVisibility: 'result-only',
      signal,
      finalize: tokens => {
        const text = tokens.map(token => token.text || '').join('');
        const matches = Array.from(text.matchAll(/FLOW_DECISION\s*=\s*(true|false)/gi));
        if (!matches.length) throw new Error(`Flow logic component did not return a valid decision: ${text.slice(-240)}`);
        decision = String(matches.at(-1)?.[1]).toLowerCase() === 'true';
        const next = decision ? gotoTrue : gotoFalse;
        return `Flow 判定：${decision ? 'true' : 'false'}\nFlow 跳转：${next < 0 ? '完成 Flow' : `#${next}`}`;
      },
    });
    if (decision === undefined) throw new Error(`Flow logic component #${componentId} did not settle a decision.`);
    return decision;
  } finally {
    agent.setMode(previousMode);
  }
}

function throwIfFlowAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || 'Flow run aborted'));
}

export async function runFlow(
  agent: Agent,
  workflow: FlowWorkflow,
  options: FlowRunnerOptions = {}
): Promise<void> {
  const startInput = options.startInput || '';
  const orderedComponents = [...workflow.components];
  const firstComponentId = orderedComponents[0]?.id;
  let cur: number | null = options.startPc === undefined
    ? (firstComponentId ?? null)
    : (workflow.components.some(component => component.id === options.startPc) ? options.startPc : null);
  const quiet = options.quiet ?? false;

  let totalChars = 0;
  const startTime = Date.now();
  const visitCounts = new Map<number, number>();
  const completedResults = options.completedResults || [];
  let resumePending = String(options.resumePrompt || '').trim();
  const nextComponentId = (componentId: number): number | null => {
    const index = orderedComponents.findIndex(component => component.id === componentId);
    return index >= 0 && index + 1 < orderedComponents.length ? orderedComponents[index + 1].id : null;
  };

  if (!quiet) {
    console.log(`\n=== Flow: ${workflow.name} ===`);
    console.log(`Components: ${workflow.components.length}`);
    console.log(`Starting at: component ${cur}\n`);

    const cycleWarnings = FlowEngine.getCycleWarnings(workflow);
    if (cycleWarnings.length > 0) {
      for (const w of cycleWarnings) {
        console.log(`  ${w}`);
      }
      console.log();
    }
  }

  while (cur !== null) {
    throwIfFlowAborted(options.signal);
    const cid = cur;
    const visits = (visitCounts.get(cid) || 0) + 1;
    visitCounts.set(cid, visits);

    if (visits > MAX_VISITS) {
      if (!quiet) console.log(`[Flow] Cycle detected: component ${cid} visited ${visits} times, stopping.`);
      break;
    }

    const component = workflow.components.find(item => item.id === cur);
    if (!component) {
      if (!quiet) console.log('[Flow] No more steps \u2014 complete.');
      break;
    }

    if (component.type === 'logic') {
      const basis = component.prompt.replace(/\{#prompt#\}/g, startInput);
      if (!quiet) console.log(`\n[Logic #${component.id}] ${basis}`);
      const cond = await evaluateReadOnlyBuild(
        agent,
        workflow.name,
        component.id,
        'logic',
        `Logic #${component.id}`,
        basis,
        completedResults,
        component.goto_true,
        component.goto_false,
        options.signal,
      );
      const nextGoto = FlowEngine.resolveGoto(workflow, component.id, cond);
      completedResults.push({ componentId: component.id, result: `FLOW_DECISION=${cond}; goto #${nextGoto}` });
      if (!quiet) console.log(`  \u2192 FLOW_DECISION=${cond} (goto ${nextGoto})`);
      cur = nextGoto;
      continue;
    }

    const prompt = resumePending || FlowEngine.buildDialogPrompt(component, startInput);
    resumePending = '';
    if (!quiet) console.log(`\n[Dialog #${component.id}] Mode: ${component.mode}`);
    const targetMode = (component.mode.toLowerCase() === 'plan' ? 'plan' : component.mode.toLowerCase() === 'goal' ? 'goal' : 'build') as AgentMode;
    agent.setMode(targetMode);
    let resultTokens;
    try {
      resultTokens = await runFlowBuild(agent, prompt, {
        workflowName: workflow.name,
        componentId: component.id,
        componentType: 'dialog',
        visibleUserInput: prompt,
        activityVisibility: 'full',
        signal: options.signal,
      });
    } catch (error) {
      if (error instanceof FlowQuestionPendingError) error.completedResults = [...completedResults];
      if (error instanceof FlowBuildExecutionError) error.completedResults = [...completedResults];
      throw error;
    }
    const resultText = resultTokens.map(token => token.text || '').join('');
    totalChars += resultText.length;
    completedResults.push({ componentId: component.id, result: resultText });
    const sequentialNext = nextComponentId(component.id);

    if (component.mode.toLowerCase() === 'goal') {
      const checkPrompt = `Is the following goal achieved?\nGoal: ${prompt.slice(0, 1200)}\nCompleted result: ${resultText.slice(0, 2400)}`;
      const achieved = await evaluateReadOnlyBuild(
        agent,
        workflow.name,
        component.id,
        'goal-verification',
        `Goal verification #${component.id}`,
        checkPrompt,
        completedResults,
        sequentialNext ?? -1,
        component.id,
        options.signal,
      );
      if (!achieved) {
        cur = component.id;
        continue;
      }
    }
    cur = sequentialNext;
  }

  if (!quiet) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n=== Flow Complete (${elapsed}s, ${totalChars} chars) ===`);
  }
}
