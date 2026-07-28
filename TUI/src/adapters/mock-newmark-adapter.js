"use strict";

const data = require("../data");
const { assertTarget, validateSnapshot } = require("./newmark-contract");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function scenarioPlan(scenario, conversationId) {
  return scenario.plan.map((text, index) => ({
    id: `${conversationId}-plan-${index + 1}`,
    text,
    status: index === 0 ? "done" : index === 1 ? "in_progress" : "pending",
    updatedAt: `2026-07-28T17:${String(10 + index).padStart(2, "0")}:00+08:00`
  }));
}

function scenarioAgents(scenario, conversationId) {
  return scenario.agents.map(([name, task, status], index) => ({
    id: `${conversationId}-agent-${index + 1}`,
    shortId: `${name.slice(0, 5)}-${index + 1}`,
    natureSlug: name,
    displayName: name,
    qualifiedName: `root/${name}`,
    name,
    conversationId,
    createdByAgentId: "root",
    prompt: task,
    model: "auto",
    inputMode: "next",
    agentMode: "build",
    status,
    queueSequence: status === "queued" ? index + 1 : undefined,
    messages: [],
    result: status === "completed" ? `${task} completed.` : null,
    createdAt: "2026-07-28T17:05:00+08:00",
    updatedAt: "2026-07-28T17:20:00+08:00",
    completedAt: status === "completed" ? "2026-07-28T17:20:00+08:00" : undefined,
    active: true,
    mode: "build",
    mailbox: { unread: status === "completed" ? 1 : 0, total: status === "completed" ? 1 : 0 },
    task,
    progress: status === "completed" ? 100 : status === "working" ? 64 + index * 7 : 0
  }));
}

function createSnapshot(target) {
  assertTarget(target);
  const selectedWorkspace = data.workspaces.find((item) => item.id === target.workspaceId) || data.workspaces[0];
  const conversations = data.workspaceConversations[selectedWorkspace.id] || [];
  const conversation = conversations.find((item) => item.id === target.conversationId) || conversations[0];
  const scenario = data.conversationScenarios[conversation.id];
  const snapshotTarget = { workspaceId: selectedWorkspace.id, conversationId: conversation.id };
  const plan = scenarioPlan(scenario, conversation.id);
  const subagents = scenarioAgents(scenario, conversation.id);
  const chatMessages = [
    {
      messageId: `${conversation.id}-user-1`,
      role: "user",
      content: `Continue work on: ${scenario.goal}`,
      mode: "build",
      model: "auto",
      timestamp: "2026-07-28T17:15:00+08:00"
    },
    {
      messageId: `${conversation.id}-assistant-1`,
      role: "assistant",
      content: `The current focus is “${plan[1]?.text || plan[0].text}”. I will keep all work bound to this conversation target.`,
      mode: "build",
      model: "auto",
      timestamp: "2026-07-28T17:15:02+08:00",
      meta: "Balanced · demo snapshot"
    }
  ];
  return validateSnapshot({
    target: snapshotTarget,
    workspaceId: snapshotTarget.workspaceId,
    conversationId: snapshotTarget.conversationId,
    conversations: clone(conversations),
    conversationPlan: { items: plan, updatedAt: "2026-07-28T17:20:00+08:00" },
    linkedPlan: {
      markdown: `# ${conversation.title}\n\n${scenario.goal}`,
      revision: 2 + plan.length,
      updatedAt: "2026-07-28T17:18:00+08:00",
      updatedBy: "root"
    },
    subagents,
    chatMessages,
    historyMessages: conversation.historyCount,
    workRuns: clone(data.workRuns).map((run) => ({
      ...run,
      target: { ...snapshotTarget },
      runtimeKey: `${snapshotTarget.workspaceId}::${snapshotTarget.conversationId}`,
      events: run.events.map((event) => ({ ...event, conversationId: snapshotTarget.conversationId }))
    })),
    continuations: [],
    modelSelection: { kind: "auto" },
    inputMode: "guide",
    mode: "build",
    goal: {
      objective: scenario.goal,
      changes: [],
      goalRounds: 2,
      verified: false,
      paused: false
    },
    queued: { steering: [], followUp: ["Validate Linux package after Windows smoke"] },
    status: "idle",
    runtime: null,
    runtimeDeferred: true
  });
}

function createMockNewmarkAdapter() {
  let target = { workspaceId: data.workspace.id, conversationId: data.conversations[0].id };
  let providers = clone(data.providers);
  let memoryLab = clone(data.memoryLab);
  const activeConversationByWorkspace = new Map([[target.workspaceId, target.conversationId]]);
  const modelSelections = new Map();
  const modes = new Map();
  const selectedFlows = new Map();
  const pinOverrides = new Map();
  const stateFor = (requested) => {
    const snapshot = createSnapshot(requested);
    const key = `${requested.workspaceId}::${requested.conversationId}`;
    snapshot.modelSelection = clone(modelSelections.get(key) || snapshot.modelSelection);
    snapshot.mode = modes.get(key) || snapshot.mode;
    snapshot.flowSelection = clone(selectedFlows.get(key) || null);
    snapshot.conversations = snapshot.conversations
      .map((item) => ({ ...item, ...(pinOverrides.get(`${requested.workspaceId}::${item.id}`) || {}) }))
      .sort((left, right) => {
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
        if (left.pinned && right.pinned) return String(right.pinnedAt || "").localeCompare(String(left.pinnedAt || ""));
        return Number(left.order || 0) - Number(right.order || 0);
      });
    snapshot.providers = clone(providers);
    snapshot.models = providers.flatMap((provider) => provider.models.map((model) => model.name));
    return snapshot;
  };
  return {
    kind: "mock",
    connected: false,
    getInitialTarget() {
      return { ...target };
    },
    listWorkspaces() {
      return clone(data.workspaces);
    },
    selectWorkspace(workspaceId) {
      const conversationId = activeConversationByWorkspace.get(workspaceId) || data.workspaceConversations[workspaceId]?.[0]?.id;
      if (!conversationId) throw new Error(`Unknown demo workspace: ${workspaceId}`);
      target = { workspaceId, conversationId };
      return stateFor(target);
    },
    getState(requested = target) {
      target = { ...assertTarget(requested) };
      return stateFor(target);
    },
    activateConversation(requested) {
      target = { ...assertTarget(requested) };
      activeConversationByWorkspace.set(target.workspaceId, target.conversationId);
      return stateFor(target);
    },
    setConversationModel(selection, requested = target) {
      target = { ...assertTarget(requested) };
      activeConversationByWorkspace.set(target.workspaceId, target.conversationId);
      modelSelections.set(`${target.workspaceId}::${target.conversationId}`, clone(selection));
      return stateFor(target);
    },
    setConversationPinned(conversationId, pinned, requested = target) {
      const key = `${requested.workspaceId}::${conversationId}`;
      pinOverrides.set(key, {
        pinned: !!pinned,
        pinnedAt: pinned ? new Date().toISOString() : ""
      });
      return stateFor(requested);
    },
    setConversationMode(mode, requested = target) {
      target = { ...assertTarget(requested) };
      modes.set(`${target.workspaceId}::${target.conversationId}`, mode);
      return stateFor(target);
    },
    listFlows() {
      return data.flows.map((workflow) => workflow.name);
    },
    readFlow(name) {
      const workflow = data.flows.find((item) => item.name === name);
      return workflow ? clone(workflow) : null;
    },
    selectConversationFlow(name, requested = target) {
      target = { ...assertTarget(requested) };
      const workflow = data.flows.find((item) => item.name === name);
      if (!workflow) throw new Error(`Unknown demo Flow: ${name}`);
      const key = `${target.workspaceId}::${target.conversationId}`;
      modes.set(key, "flow");
      selectedFlows.set(key, clone(workflow));
      return { snapshot: stateFor(target), workflow: clone(workflow) };
    },
    sendMessage() {
      return { demo: true };
    },
    stopConversation(_target, force = false) {
      return { action: force ? "force" : "graceful", demo: true };
    },
    setInputMode(mode) {
      return { ok: true, demo: true, mode };
    },
    getConversationPlan(requested = target) {
      return createSnapshot(requested).conversationPlan;
    },
    updateConversationPlan() {
      return { demo: true };
    },
    updateGoal() {
      return { demo: true };
    },
    toggleGoalPause() {
      return false;
    },
    clearGoal() {
      return true;
    },
    listAutomations() {
      return clone(data.automations);
    },
    toggleAutomation(id) {
      return { id, active: true, demo: true };
    },
    createAutomation(input) {
      return { id: `demo-${Date.now()}`, ...clone(input), demo: true };
    },
    deleteAutomation() {
      return true;
    },
    memoryLabRead(selector = "") {
      if (!selector) return clone(memoryLab);
      const meta = memoryLab.index.components[selector];
      return {
        ...clone(memoryLab),
        ok: !!meta,
        component: meta ? { slug: selector, meta: clone(meta), content: memoryLab.componentContents[selector] || "" } : undefined,
        error: meta ? undefined : `Memory component not found: ${selector}`
      };
    },
    memoryLabVisualization() {
      return clone(memoryLab);
    },
    memoryLabReindex() {
      memoryLab.loadedAt = new Date().toISOString();
      return { ...clone(memoryLab), rebuildReceipt: { operation: "reindex", completed: true, indexUpdatedAt: memoryLab.index.updatedAt, verifiedAt: memoryLab.loadedAt } };
    },
    setProviderEnabled(providerId, enabled) {
      const provider = providers.find((item) => item.id === providerId);
      if (!provider) return { ok: false, error: "Provider not found" };
      provider.enabled = !!enabled;
      return { ok: true, enabled: provider.enabled, providers: clone(providers), models: providers.flatMap((item) => item.models.map((model) => model.name)) };
    },
    validateModels(selected = []) {
      const names = selected.length ? selected : providers.flatMap((provider) => provider.models.map((model) => model.name));
      return providers.flatMap((provider) => provider.models)
        .filter((model) => names.includes(model.name))
        .map((model) => ({ model: model.name, status: model.validation?.status || "verified", level: model.validation?.level || "standard" }));
    },
    modelValidationStatus() {
      return { running: false, completed: true, total: providers.flatMap((provider) => provider.models).length };
    },
    fuzzyInject() {
      return { ok: true, demo: true, imported: 0, warning: "Mock adapter does not store credentials." };
    },
    saveConfig() {
      return { ok: true, demo: true };
    },
    saveSetting(section, key, value) {
      return { ok: true, demo: true, section, key, value };
    },
    openGlobalConfig() {
      return { ok: true, demo: true, path: "~/.Newmark/config.json" };
    },
    reloadGlobalConfig() {
      return { ok: true, demo: true, reloaded: false };
    },
    listArchives(scope = "all") {
      return { ok: true, demo: true, scope, items: ["2026-07-28-release-review", "2026-07-27-memory-lab"] };
    },
    updateVersion() {
      return { ok: true, demo: true, version: "0.1.6-demo", channel: "prerelease" };
    },
    updateCheckGithub(input = {}) {
      return { ok: true, demo: true, status: "up-to-date", input };
    },
    updateApplyGithub() {
      return { ok: true, demo: true, applied: false };
    },
    updateInstallLocal() {
      return { ok: true, demo: true, installed: false };
    }
  };
}

module.exports = { createMockNewmarkAdapter, createSnapshot };
