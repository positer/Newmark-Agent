import { randomUUID } from 'crypto';
import type { Agent } from './agent';
import type { AgentWorkEvent } from './types';
import type { WorkspaceInfo } from './workspace';

/** Directory changes are workspace metadata, never a turn or selection command. */
export function conversationListEvent(agent: Pick<Agent, 'listWorkspaceConversationStates'>, workspace: WorkspaceInfo): AgentWorkEvent {
  return {
    id: randomUUID(), type: 'conversation_list', stateScope: 'workspace',
    workspaceId: String(workspace.id || workspace.path), conversationId: '',
    conversations: agent.listWorkspaceConversationStates(workspace),
    content: '', mode: '', model: '', timestamp: new Date().toISOString(),
  };
}
