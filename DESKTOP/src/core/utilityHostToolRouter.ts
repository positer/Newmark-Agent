import { BrowserControl } from './browserControl';
import * as fs from 'fs';
import { bindBrowserUseRequest, BrowserUse, BrowserUseReceipt, BrowserUseRequest } from './browserUse';
import { evaluateToolPolicy } from './toolPolicy';
import { UtilityHostToolRequest } from './utilityAgentProtocol';
import { runComputerUse } from '../tools/computerUse';
import {
  ROOT_TERMINAL_ACTOR_ID,
  runTerminalTakeover,
  stopTerminalTakeoverSession,
  terminalTakeoverState,
  terminalTakeoverWorkspaceId,
} from '../tools/terminalTakeover';

const ROOT_AGENT_ACTOR_ID = '00000000-0000-4000-8000-000000000001';
const AUTOMATION_TOOLS = new Set([
  'automation_list',
  'automation_create',
  'automation_update',
  'automation_toggle',
  'automation_delete',
]);

export interface UtilityHostToolRouterOptions {
  persistenceRoot: string;
  runAutomation(tool: string, payload: string, signal?: AbortSignal): string | Promise<string>;
  isToolEnabled?(toolName: string): boolean;
  runBrowser?: typeof BrowserControl.run;
  runBrowserUse?(request: BrowserUseRequest, signal?: AbortSignal): Promise<BrowserUseReceipt>;
  cancelBrowserUseTarget?(runtimeKey: string): void;
  runComputer?: typeof runComputerUse;
  runTerminal?: typeof runTerminalTakeover;
}

interface ComputerUseLease {
  owner: string;
  runtimeKey: string;
  workspacePath: string;
  updatedAt: number;
}

export type RoutedUtilityHostToolHandler = ((request: UtilityHostToolRequest, signal?: AbortSignal) => Promise<unknown>) & {
  cancelTarget(runtimeKey: string): void;
};

/**
 * Routes every desktop-global capability in the Electron main process.
 * One handler instance is shared by all utility runtimes, so Computer Use has
 * one authoritative owner lock rather than one lock per child process.
 */
export function createUtilityHostToolHandler(options: UtilityHostToolRouterOptions): RoutedUtilityHostToolHandler {
  let computerUseLease: ComputerUseLease | null = null;
  const terminalOwners = new Map<string, {
    backend: string;
    workspaceId: string;
    conversationId: string;
  }>();
  const ephemeralScreenshots = new Map<string, Set<string>>();
  const lockTtlMs = 10 * 60 * 1000;

  const handler = async (request: UtilityHostToolRequest, signal?: AbortSignal): Promise<unknown> => {
    throwIfAborted(signal);
    validateTargetContext(request);
    const policy = evaluateUtilityHostToolPolicy(request);
    if (!policy.allowed) throw new Error(policy.reason || `Electron host policy blocked ${request.tool}`);
    const nativeToolName = request.tool === 'automation'
      ? String((request.args as { tool?: string }).tool || '')
      : request.tool;
    if (request.tool !== 'browser_control' && options.isToolEnabled && !options.isToolEnabled(nativeToolName)) {
      throw new Error(`[permission] ${nativeToolName || request.tool} is disabled in Native Tools settings`);
    }
    if (request.tool === 'browser_control') {
      if (request.args.action === 'use') throw new Error('Isolated Browser-Use must use the target-bound browser_use host RPC');
      const result = await (options.runBrowser || BrowserControl.run.bind(BrowserControl))(request.args, signal);
      throwIfAborted(signal);
      return result;
    }

    if (request.tool === 'browser_use') {
      if (request.context.runtimeKey !== request.target.runtimeKey) throw new Error('Electron Browser-Use runtime target/context mismatch');
      const bound = bindBrowserUseRequest(request.args, {
        runtimeKey: request.target.runtimeKey,
        actorId: request.context.actorId,
      });
      const result = await (options.runBrowserUse || (async (value, abortSignal) => await BrowserUse.run(value, abortSignal)))(bound, signal);
      throwIfAborted(signal);
      return result;
    }

    if (request.tool === 'automation') {
      const tool = String(request.args.tool || '').trim();
      if (!AUTOMATION_TOOLS.has(tool)) throw new Error(`Automation host tool is not allowed: ${tool || '(missing)'}`);
      const result = await options.runAutomation(tool, request.args.payload, signal);
      throwIfAborted(signal);
      return result;
    }

    if (request.tool === 'terminal_takeover') {
      const args = request.args || {};
      const owner = {
        backend: process.platform === 'win32' ? 'windows' : process.platform,
        workspaceId: terminalTakeoverWorkspaceId(request.target.workspacePath),
        conversationId: request.target.conversationId,
        actorId: String(request.context.actorId || ROOT_TERMINAL_ACTOR_ID),
      };
      terminalOwners.set(request.target.runtimeKey, owner);
      const result = (options.runTerminal || runTerminalTakeover)({
        action: String(args.action || ''),
        name: String(args.name || ''),
        shell: String(args.shell || ''),
        command: String(args.command || ''),
        cwd: request.target.workspacePath,
        maxChars: Number(args.max_chars || args.maxChars || 12_000),
        cols: Number(args.cols || 0),
        rows: Number(args.rows || 0),
        owner,
        persistenceRoot: options.persistenceRoot,
      });
      throwIfAborted(signal);
      return result;
    }

    const args = request.args || {};
    const action = String(args.action || '').trim().toLowerCase();
    const trustedComputerUseContext = request.context as typeof request.context & {
      allowEphemeralVisionImage?: boolean;
    };
    const owner = `${request.target.runtimeKey}:${String(request.context.actorId || ROOT_TERMINAL_ACTOR_ID)}`;
    const now = Date.now();
    if (computerUseLease && now - computerUseLease.updatedAt > lockTtlMs) computerUseLease = null;
    if (action === 'takeover_stop') {
      if (computerUseLease && computerUseLease.owner !== owner) {
        return computerUseLockError(action, owner, computerUseLease.owner);
      }
    } else if (computerUseLease && computerUseLease.owner !== owner) {
      return computerUseLockError(action, owner, computerUseLease.owner);
    } else {
      computerUseLease = { owner, runtimeKey: request.target.runtimeKey, workspacePath: request.target.workspacePath, updatedAt: now };
    }

    let retainedScreenshotPath = '';
    try {
      const result = await (options.runComputer || runComputerUse)({
        action,
        x: Number(args.x),
        y: Number(args.y),
        scrollX: Number(args.scroll_x || args.scrollX || 0),
        scrollY: Number(args.scroll_y || args.scrollY || 0),
        targetId: String(args.target_id || args.targetId || ''),
        button: String(args.button || ''),
        text: String(args.text || ''),
        key: String(args.key || ''),
        appTarget: String(args.app_target || args.appTarget || ''),
        windowHandle: String(args.window_handle || args.windowHandle || ''),
        durationMs: Number(args.duration_ms || args.durationMs || 0),
        maxChars: Number(args.max_chars || args.maxChars || 30_000),
        dryRun: args.dry_run === true || args.dryRun === true,
        captureMaxWidth: Number(args.capture_max_width || args.captureMaxWidth),
        captureMaxHeight: Number(args.capture_max_height || args.captureMaxHeight),
        gradientColors: Array.isArray(args.gradient_colors) ? args.gradient_colors as string[] : undefined,
        gradientSpeed: Number(args.gradient_speed || 0) || undefined,
        gradientWidth: Number(args.gradient_width || 0) || undefined,
        includeRawUi: args.include_raw_ui === true || args.includeRawUi === true,
        // Retaining a one-use image until provider-input preparation is a
        // host/runtime capability. Model-authored args must never enable it.
        allowEphemeralVisionImage: trustedComputerUseContext.allowEphemeralVisionImage === true,
        steps: Array.isArray(args.steps) ? args.steps.slice(0, 3).map(raw => {
          const step = raw as Record<string, unknown>;
          return {
            action: String(step.action || '') as 'move' | 'click' | 'scroll' | 'wait' | 'app_activate',
            x: Number(step.x),
            y: Number(step.y),
            scrollX: Number(step.scroll_x || step.scrollX || 0),
            scrollY: Number(step.scroll_y || step.scrollY || 0),
            button: String(step.button || 'left'),
            targetId: String(step.target_id || step.targetId || ''),
            appTarget: String(step.app_target || step.appTarget || ''),
            windowHandle: String(step.window_handle || step.windowHandle || ''),
            durationMs: Number(step.duration_ms || step.durationMs || 0),
          };
        }) : undefined,
        workspacePath: request.target.workspacePath,
        invocation: 'agent',
        ownerId: owner,
      });
      try {
        const parsed = typeof result === 'string' ? JSON.parse(result) as Record<string, unknown> : result as unknown as Record<string, unknown>;
        retainedScreenshotPath = String(parsed?.vision_image_path || '');
        if (retainedScreenshotPath) {
          const active = ephemeralScreenshots.get(request.target.runtimeKey) || new Set<string>();
          for (const existing of active) if (!fs.existsSync(existing)) active.delete(existing);
          active.add(retainedScreenshotPath);
          while (active.size > 32) {
            const oldest = active.values().next().value as string;
            active.delete(oldest);
            try { fs.unlinkSync(oldest); } catch {}
          }
          ephemeralScreenshots.set(request.target.runtimeKey, active);
        }
      } catch {}
      throwIfAborted(signal);
      return result;
    } finally {
      if (signal?.aborted && retainedScreenshotPath) {
        try { fs.unlinkSync(retainedScreenshotPath); } catch {}
      }
      if (action === 'takeover_stop' && (!computerUseLease || computerUseLease.owner === owner)) computerUseLease = null;
      else if (computerUseLease?.owner === owner) computerUseLease.updatedAt = Date.now();
    }
  };

  handler.cancelTarget = (runtimeKey: string): void => {
    options.cancelBrowserUseTarget?.(runtimeKey);
    const screenshots = ephemeralScreenshots.get(runtimeKey);
    ephemeralScreenshots.delete(runtimeKey);
    for (const screenshot of screenshots || []) {
      try { fs.unlinkSync(screenshot); } catch {}
    }
    const terminalOwner = terminalOwners.get(runtimeKey);
    terminalOwners.delete(runtimeKey);
    if (terminalOwner) {
      for (const session of terminalTakeoverState(terminalOwner, options.persistenceRoot)) {
        if (session.active) stopTerminalTakeoverSession(session.id, terminalOwner, 'runtime-force-restart');
      }
    }
    if (computerUseLease?.runtimeKey === runtimeKey) {
      const lease = computerUseLease;
      computerUseLease = null;
      void (options.runComputer || runComputerUse)({
        action: 'takeover_stop',
        workspacePath: lease.workspacePath,
        invocation: 'agent',
        ownerId: lease.owner,
      }).catch(() => undefined);
    }
  };

  return handler;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(String(reason || 'Host tool call aborted'));
}

function validateTargetContext(request: UtilityHostToolRequest): void {
  if (!request.target.runtimeKey || !request.target.workspaceKey) throw new Error('Electron host tool target is incomplete');
  if (!request.target.workspacePath) throw new Error('Electron host tool target workspace path is missing');
  if ('context' in request) {
    if (request.context.workspaceId !== request.target.workspaceId
      || request.context.conversationId !== request.target.conversationId) {
      throw new Error('Electron host tool target/context mismatch');
    }
  }
}

function evaluateUtilityHostToolPolicy(request: UtilityHostToolRequest) {
  const rawArgs = request.args as unknown as Record<string, unknown>;
  const context = 'context' in request ? request.context : undefined;
  let name: string = request.tool;
  let args = rawArgs;
  if (request.tool === 'automation') {
    name = String(rawArgs.tool || '');
    try {
      const parsed = JSON.parse(String(rawArgs.payload || '{}'));
      args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      args = {};
    }
  } else if (request.tool === 'browser_control') {
    const action = String(rawArgs.action || '').toLowerCase();
    const mapped: Record<string, string> = {
      open: 'browser_open',
      snapshot: 'browser_snapshot',
      click: 'browser_click',
      type: 'browser_type',
      eval: 'browser_eval',
      back: 'browser_back',
      forward: 'browser_forward',
      reload: 'browser_reload',
      cdp: 'browser_cdp',
    };
    name = mapped[action] || 'browser_use';
    args = action === 'use' ? rawArgs : {};
  }
  return evaluateToolPolicy({
    name,
    mode: context?.mode || 'build',
    isSubagent: !!context && context.actorId !== ROOT_AGENT_ACTOR_ID,
    args,
  });
}

function computerUseLockError(action: string, requestedOwner: string, activeOwner: string): string {
  return JSON.stringify({
    ok: false,
    action,
    error: `Computer Use is already active in ${activeOwner}. Stop it with computer_use takeover_stop or wait before another conversation takes control.`,
    lock_owner: activeOwner,
    requested_owner: requestedOwner,
  }, null, 2);
}
