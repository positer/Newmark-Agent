"use strict";

/**
 * TUI-facing subset of Newmark's existing renderer contract.
 *
 * Source of truth:
 * - DESKTOP/src/core/types.ts: ConversationTarget, ChatMessage, AgentWorkEvent
 * - DESKTOP/src/core/agent.ts: ConversationSnapshot, ConversationPlanState, LinkedPlanState
 * - DESKTOP/src/core/subagent.ts: NewmarkSubagentRecord, SubagentStatus
 * - DESKTOP/src/core/workspace.ts: WorkspaceInfo
 * - DESKTOP/src/preload.ts: renderer-callable API names
 */

const PLAN_STATUSES = new Set(["pending", "in_progress", "done"]);
const SUBAGENT_STATUSES = new Set(["idle", "queued", "working", "completed", "closed", "error"]);
const AGENT_MODES = new Set(["build", "plan", "goal", "flow"]);
const INPUT_MODES = new Set(["guide", "next"]);

function targetKey(target) {
  return `${String(target?.workspaceId || "")}::${String(target?.conversationId || "")}`;
}

function assertTarget(target) {
  if (!target || typeof target.workspaceId !== "string" || !target.workspaceId) {
    throw new TypeError("ConversationTarget.workspaceId is required");
  }
  if (typeof target.conversationId !== "string" || !target.conversationId) {
    throw new TypeError("ConversationTarget.conversationId is required");
  }
  return target;
}

function validateSnapshot(snapshot) {
  assertTarget(snapshot?.target);
  if (!Array.isArray(snapshot.conversations)) throw new TypeError("snapshot.conversations must be an array");
  if (!Array.isArray(snapshot.conversationPlan?.items)) throw new TypeError("snapshot.conversationPlan.items must be an array");
  if (typeof snapshot.linkedPlan?.markdown !== "string") throw new TypeError("snapshot.linkedPlan.markdown must be a string");
  if (!Number.isInteger(snapshot.linkedPlan?.revision)) throw new TypeError("snapshot.linkedPlan.revision must be an integer");
  if (!Array.isArray(snapshot.subagents)) throw new TypeError("snapshot.subagents must be an array");
  if (!Array.isArray(snapshot.chatMessages)) throw new TypeError("snapshot.chatMessages must be an array");
  if (!AGENT_MODES.has(snapshot.mode)) throw new TypeError(`unsupported AgentMode: ${snapshot.mode}`);
  if (!INPUT_MODES.has(snapshot.inputMode)) throw new TypeError(`unsupported InputMode: ${snapshot.inputMode}`);
  for (const item of snapshot.conversationPlan.items) {
    if (!PLAN_STATUSES.has(item.status)) throw new TypeError(`unsupported ConversationPlanItemStatus: ${item.status}`);
  }
  for (const agent of snapshot.subagents) {
    if (!SUBAGENT_STATUSES.has(agent.status)) throw new TypeError(`unsupported SubagentStatus: ${agent.status}`);
    if (agent.conversationId !== snapshot.target.conversationId) {
      throw new TypeError("subagent must belong to snapshot.target.conversationId");
    }
  }
  return snapshot;
}

const INTEGRATION_METHODS = Object.freeze([
  "getState",
  "selectWorkspace",
  "activateConversation",
  "setModel",
  "setConversationPinned",
  "setMode",
  "sendMessage",
  "stopConversation",
  "setInputMode",
  "getConversationPlan",
  "updateConversationPlan",
  "updateGoal",
  "toggleGoalPause",
  "clearGoal",
  "listFlows",
  "readFlow",
  "listAutomations",
  "toggleAutomation",
  "createAutomation",
  "deleteAutomation",
  "memoryLabRead",
  "memoryLabVisualization",
  "memoryLabReindex",
  "setProviderEnabled",
  "validateModels",
  "modelValidationStatus",
  "fuzzyInject",
  "saveConfig",
  "saveSetting",
  "openGlobalConfig",
  "reloadGlobalConfig",
  "listArchives",
  "updateVersion",
  "updateCheckGithub",
  "updateApplyGithub",
  "updateInstallLocal"
]);

module.exports = {
  AGENT_MODES,
  INPUT_MODES,
  INTEGRATION_METHODS,
  PLAN_STATUSES,
  SUBAGENT_STATUSES,
  assertTarget,
  targetKey,
  validateSnapshot
};
