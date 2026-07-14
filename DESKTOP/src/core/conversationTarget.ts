import { createHash } from 'crypto';
import * as path from 'path';
import { ConversationTarget } from './types';

export type { ConversationTarget } from './types';

export interface ConversationTargetWorkspace {
  id: string;
  name: string;
  path: string;
  isInternal: boolean;
  kind?: string;
  workspaceKey?: string;
}

export interface ConversationRuntimeTarget extends ConversationTarget {
  workspace?: ConversationTargetWorkspace | null;
  workspaceKey?: string;
  runtimeKey?: string;
}

export interface NormalizedConversationTarget extends ConversationRuntimeTarget {
  workspace: ConversationTargetWorkspace | null;
  workspaceKey: string;
  runtimeKey: string;
}

const SAFE_KEY = /^[A-Za-z0-9_.:-]{1,200}$/;

export function safeConversationId(value: string): string {
  return String(value || 'default').trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'default';
}

export function canonicalWorkspacePath(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    return path.win32.normalize(raw.replace(/\//g, '\\')).replace(/[\\/]+$/, '').toLowerCase();
  }
  const normalized = path.posix.normalize(raw.replace(/\\/g, '/'));
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}

export function conversationWorkspaceKey(target: ConversationRuntimeTarget): string {
  const supplied = String(target.workspaceKey || target.workspace?.workspaceKey || '').trim();
  if (SAFE_KEY.test(supplied)) return supplied;
  if (!target.workspace) {
    const workspaceId = String(target.workspaceId || 'none').trim() || 'none';
    const digest = createHash('sha256').update(`id\0${workspaceId}`).digest('hex').slice(0, 24);
    return `workspace:id:${digest}`;
  }
  const canonical = canonicalWorkspacePath(target.workspace.path);
  const kind = target.workspace.isInternal ? 'internal' : (target.workspace.kind === 'ssh' ? 'ssh' : 'external');
  const digest = createHash('sha256').update(`${kind}\0${canonical}`).digest('hex').slice(0, 24);
  return `workspace:${kind}:${digest}`;
}

export function conversationRuntimeKey(target: ConversationRuntimeTarget): string {
  const normalized = normalizeConversationTarget(target);
  return normalized.runtimeKey;
}

export function normalizeConversationTarget(target: ConversationRuntimeTarget): NormalizedConversationTarget {
  const conversationId = safeConversationId(target?.conversationId || 'default');
  const workspace = target?.workspace ? {
    ...target.workspace,
    id: String(target.workspace.id || target.workspace.name || target.workspace.path || 'workspace'),
    name: String(target.workspace.name || target.workspace.id || target.workspace.path || 'Workspace'),
    path: String(target.workspace.path || ''),
    isInternal: !!target.workspace.isInternal,
  } : null;
  const workspaceKey = conversationWorkspaceKey({ ...target, workspace, conversationId });
  return {
    workspaceId: String(target.workspaceId || workspace?.id || workspace?.name || 'none'),
    workspace: workspace ? { ...workspace, workspaceKey } : null,
    conversationId,
    workspaceKey,
    runtimeKey: `${workspaceKey}::conversation:${conversationId}`,
  };
}

export function sameConversationTarget(a: ConversationRuntimeTarget, b: ConversationRuntimeTarget): boolean {
  return conversationRuntimeKey(a) === conversationRuntimeKey(b);
}

export function sameTargetWorkspace(a: ConversationRuntimeTarget, b: ConversationRuntimeTarget): boolean {
  return conversationWorkspaceKey(a) === conversationWorkspaceKey(b);
}
