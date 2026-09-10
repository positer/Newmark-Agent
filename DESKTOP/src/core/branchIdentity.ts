/**
 * Branch conversation identity (dev-0.6.4).
 *
 * A conversation owns a tree of branch nodes. Every node is its own full
 * conversation: the provider-side session sequence id, the folded-history
 * archive and every local transcript cache are scoped by the node id, so
 * sibling pages can never read each other's remote session or cached history.
 *
 * The user's pagination edits and the experimental branch-communication
 * branches are created by the same `Agent.branchConversation` transaction, so
 * both kinds of branch must share this single identity function. Never derive
 * the identity from "the branch that happens to be active" at request time.
 */

export const BRANCH_IDENTITY_SEPARATOR = '::branch:';

/** The full conversation id of one branch node: `<conversationId>::branch:<branchNodeId>`. */
export function branchConversationIdentity(conversationId: string, branchNodeId: string): string {
  const conversation = String(conversationId || '').trim() || 'default';
  const branch = String(branchNodeId || '').trim();
  return branch ? `${conversation}${BRANCH_IDENTITY_SEPARATOR}${branch}` : conversation;
}

/** True when a value already carries a branch node identity. */
export function isBranchConversationIdentity(value: string): boolean {
  return String(value || '').includes(BRANCH_IDENTITY_SEPARATOR);
}

/**
 * Workspace-wide cache scope for one branch. Used by caches that must never be
 * shared across sibling branches (compression history, provider payloads).
 */
export function branchCacheScopeKey(workspaceId: string, conversationId: string, branchNodeId: string): string {
  const workspace = String(workspaceId || '').trim() || 'none';
  return `${workspace}::${branchConversationIdentity(conversationId, branchNodeId)}`;
}

/**
 * A branch may never reuse the identity of another node. Callers that mint a
 * new page assert this before the node becomes reachable.
 */
export function assertFreshBranchIdentity(conversationId: string, branchNodeId: string, existing: Iterable<string>): void {
  const branch = String(branchNodeId || '').trim();
  if (!branch) throw new Error('Branch conversation identity requires a branch node id.');
  for (const known of existing) {
    if (String(known || '') === branch) {
      throw new Error(`Branch conversation identity ${branchConversationIdentity(conversationId, branch)} is already in use.`);
    }
  }
}
