"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { executeAction } = require("../src/app");
const { createCoreRuntimeAdapter, mergeProviderConfig } = require("../src/adapters/core-runtime-adapter");
const { createDesktopPreloadAdapter } = require("../src/adapters/desktop-preload-adapter");
const { createSnapshot } = require("../src/adapters/mock-newmark-adapter");
const { targetKey, validateSnapshot } = require("../src/adapters/newmark-contract");
const { render, stripAnsi, visibleLength, wrapText } = require("../src/render");
const {
  activateMenu,
  activateMemorySelection,
  applyConversationResult,
  createState,
  cycleConversationMode,
  enterConversation,
  filteredCommands,
  moveFocusHorizontal,
  moveMenuLevel,
  moveMenuSelection,
  moveSelection,
  markConversationRunning,
  rootMenuItems,
  returnToConversationSelection,
  requestConversationStop,
  selectConversationModel,
  selectFlowWorkflow,
  selectedMemoryDetail,
  switchView,
  toggleConversationPinned,
  toggleSelected,
  validateSelectedModel,
  workspaceMenuChildren
} = require("../src/state");

test("initial state is an isolated overview demo", () => {
  const state = createState();
  assert.equal(state.view, "home");
  assert.match(state.notice, /Demo mode/);
  assert.equal(state.messages.length, 2);
  assert.equal(state.adapterKind, "mock");
  assert.equal(targetKey(state.target), "workspace-newmark-agent-demo::release-readiness-review");
});

test("real core registers and selects the requested current-directory workspace", () => {
  const base = fs.mkdtempSync(path.join(__dirname, ".tmp-core-"));
  const runtimeRoot = path.join(base, "runtime");
  const workspacePath = path.join(base, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  try {
    const adapter = createCoreRuntimeAdapter({ root: runtimeRoot, workspacePath });
    const state = createState({ adapter });
    const selected = state.workspaces.find((item) => item.id === state.target.workspaceId);
    assert.equal(path.resolve(selected.path), path.resolve(workspacePath));
    assert.equal(state.adapterKind, "newmark-core");
    assert.match(state.notice, /Newmark core connected/);
    assert.ok(Array.isArray(state.snapshot.conversations));
    assert.ok(Array.isArray(state.automations));
    assert.equal(adapter.memoryLabVisualization().ok, true);
    adapter.close();
  } finally {
    const resolved = path.resolve(base);
    const allowed = `${path.resolve(__dirname)}${path.sep}`;
    assert.ok(resolved.startsWith(allowed), "temporary runtime must remain inside TUI/test");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test("real core persists the selected Flow on the conversation snapshot", () => {
  const base = fs.mkdtempSync(path.join(__dirname, ".tmp-flow-core-"));
  const runtimeRoot = path.join(base, "runtime");
  const workspacePath = path.join(base, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  try {
    let adapter = createCoreRuntimeAdapter({ root: runtimeRoot, workspacePath });
    const target = adapter.getInitialTarget();
    const workflow = {
      name: "tui-flow-persistence",
      components: [{ id: 1, type: "dialog", mode: "build", prompt: "Verify persistence." }]
    };
    fs.writeFileSync(
      path.join(runtimeRoot, "Flow", `${workflow.name}.Flow.json`),
      JSON.stringify(workflow, null, 2),
      "utf8"
    );
    const selected = adapter.selectConversationFlow(workflow.name, target);
    assert.deepEqual(selected.snapshot.flowSelection, { name: workflow.name, pc: 0 });
    adapter.close();
    adapter = createCoreRuntimeAdapter({ root: runtimeRoot, workspacePath });
    const restored = adapter.getState(target);
    assert.deepEqual(restored.flowSelection, { name: workflow.name, pc: 0 });
    assert.equal(adapter.readFlow(workflow.name).components[0].prompt, "Verify persistence.");
    adapter.close();
  } finally {
    const resolved = path.resolve(base);
    const allowed = `${path.resolve(__dirname)}${path.sep}`;
    assert.ok(resolved.startsWith(allowed), "temporary runtime must remain inside TUI/test");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test("sanitized provider edits preserve existing API keys", () => {
  const current = [{
    id: "provider-a",
    api_key: "secret-value",
    enabled: true,
    models: [{ name: "model-a", enabled: true, max_tokens: 8192 }]
  }];
  const incoming = [{
    id: "provider-a",
    api_key: "",
    has_api_key: true,
    enabled: true,
    models: [{ name: "model-a", enabled: false }]
  }];
  const [merged] = mergeProviderConfig(current, incoming);
  assert.equal(merged.api_key, "secret-value");
  assert.equal(merged.models[0].enabled, false);
  assert.equal(merged.models[0].max_tokens, 8192);
  assert.equal("has_api_key" in merged, false);
});

test("selection wraps in both directions", () => {
  const state = createState();
  moveSelection(state, -1);
  assert.equal(state.selected, 2);
  moveSelection(state, 1);
  assert.equal(state.selected, 0);
});

test("view switches reset transient composer state", () => {
  const state = createState();
  state.inputMode = true;
  state.input = "draft";
  switchView(state, "tools");
  assert.equal(state.view, "tools");
  assert.equal(state.inputMode, false);
  assert.equal(state.input, "");
});

test("entering a conversation establishes shared plan and subagent context", () => {
  const state = createState();
  switchView(state, "chat");
  state.selected = 2;
  assert.equal(enterConversation(state), true);
  assert.equal(state.lastConversation, "Provider routing audit");
  assert.equal(state.target.conversationId, "provider-routing-audit");
  assert.equal(state.inputMode, true);
  assert.ok(state.snapshot.subagents.every((agent) => agent.conversationId === "provider-routing-audit"));
  switchView(state, "plan");
  assert.match(stripAnsi(render(state, 100, 30)), /Provider routing audit.*Conversation plan/);
  switchView(state, "agents");
  assert.match(stripAnsi(render(state, 100, 30)), /Provider routing audit.*Conversation subagents/);
});

test("Tab leaves the conversation editor for conversation selection without discarding its draft", () => {
  const state = createState();
  switchView(state, "chat");
  state.selected = 1;
  enterConversation(state);
  state.input = "keep this draft";
  assert.equal(returnToConversationSelection(state), true);
  assert.equal(state.inputMode, false);
  assert.equal(state.input, "keep this draft");
  assert.equal(state.view, "chat");
  assert.equal(state.selected, 1);
});

test("running conversations keep an independent rotating left-edge marker", () => {
  const state = createState();
  switchView(state, "chat");
  markConversationRunning(state, state.target, true);
  for (const tick of [0, 1, 2, 3]) {
    state.tick = tick;
    const output = stripAnsi(render(state, 140, 32));
    assert.match(output, /[\\—/] Release readiness/);
  }
});

test("background completion never steals focus from the newly selected conversation", () => {
  const state = createState();
  const backgroundTarget = { ...state.target };
  markConversationRunning(state, backgroundTarget, true);
  switchView(state, "chat");
  state.selected = 1;
  enterConversation(state);
  const foregroundTarget = { ...state.target };
  const backgroundSnapshot = createSnapshot(backgroundTarget);
  backgroundSnapshot.chatMessages.push({
    messageId: "background-final",
    role: "assistant",
    content: "background complete",
    mode: "build",
    model: "auto",
    timestamp: "2026-07-29T10:00:00+08:00"
  });
  assert.equal(applyConversationResult(state, backgroundTarget, backgroundSnapshot), false);
  assert.deepEqual(state.target, foregroundTarget);
  assert.equal(state.messages.some((item) => item.messageId === "background-final"), false);
  assert.equal(state.runningConversationKeys.size, 0);
});

test("Esc stop is target-bound and escalates only on the second request", async () => {
  const state = createState();
  const calls = [];
  state.adapter.stopConversation = async (target, force) => {
    calls.push([{ ...target }, force]);
    return { action: force ? "force" : "graceful" };
  };
  markConversationRunning(state, state.target, true);
  assert.equal(await requestConversationStop(state), "graceful");
  assert.equal(await requestConversationStop(state), "force");
  assert.deepEqual(calls, [
    [{ ...state.target }, false],
    [{ ...state.target }, true]
  ]);
  markConversationRunning(state, state.target, false);
  assert.equal(await requestConversationStop(state), "not-running");
});

test("T pins the selected conversation and follows its id after reordering", () => {
  const state = createState();
  switchView(state, "chat");
  state.selected = 1;
  const id = state.snapshot.conversations[state.selected].id;
  assert.equal(state.snapshot.conversations[state.selected].pinned, false);
  assert.equal(toggleConversationPinned(state), true);
  assert.equal(state.snapshot.conversations[state.selected].id, id);
  assert.equal(state.snapshot.conversations[state.selected].pinned, true);
  assert.equal(state.selected, 0);
  assert.equal(toggleConversationPinned(state), true);
  assert.equal(state.snapshot.conversations[state.selected].id, id);
  assert.equal(state.snapshot.conversations[state.selected].pinned, false);
});

test("mock snapshot matches Newmark conversation contract", () => {
  const snapshot = createSnapshot({
    workspaceId: "workspace-newmark-agent-demo",
    conversationId: "memory-lab-performance"
  });
  assert.equal(validateSnapshot(snapshot), snapshot);
  assert.deepEqual(snapshot.target, {
    workspaceId: "workspace-newmark-agent-demo",
    conversationId: "memory-lab-performance"
  });
  assert.deepEqual(snapshot.conversationPlan.items.map((item) => item.status), [
    "done", "in_progress", "pending", "pending"
  ]);
});

test("every demo conversation owns distinct goal, plan, and subagents", () => {
  const state = createState();
  const seenGoals = new Set();
  const seenPlans = new Set();
  const seenAgentSets = new Set();
  let conversationCount = 0;
  for (const workspace of state.workspaces) {
    const conversations = require("../src/data").workspaceConversations[workspace.id];
    for (const conversation of conversations) {
      const snapshot = createSnapshot({ workspaceId: workspace.id, conversationId: conversation.id });
      seenGoals.add(snapshot.goal.objective);
      seenPlans.add(snapshot.conversationPlan.items.map((item) => item.text).join("|"));
      seenAgentSets.add(snapshot.subagents.map((agent) => agent.displayName).join("|"));
      assert.ok(snapshot.subagents.every((agent) => agent.conversationId === conversation.id));
      conversationCount += 1;
    }
  }
  assert.equal(seenGoals.size, conversationCount);
  assert.equal(seenPlans.size, conversationCount);
  assert.equal(seenAgentSets.size, conversationCount);
  assert.equal(conversationCount, 9);
});

test("conversation tracking views are workspace peers", () => {
  const state = createState();
  const workspaceChildren = workspaceMenuChildren(state, state.target.workspaceId);
  assert.deepEqual(workspaceChildren.map((item) => item.id), [
    "chat",
    "plan",
    "goal",
    "agents",
    "model"
  ]);
  assert.deepEqual(workspaceChildren.map((item) => item.label), [
    "Conversations",
    "Plan",
    "Goal",
    "Subagents",
    "Model"
  ]);
});

test("conversation tracking children appear only when the focused conversation has their content", () => {
  const state = createState();
  state.snapshot.conversationPlan.items = [];
  state.snapshot.goal = null;
  state.snapshot.subagents = [];
  assert.deepEqual(
    workspaceMenuChildren(state, state.target.workspaceId).map((item) => item.id),
    ["chat", "model"]
  );
  state.currentFlow = {
    name: "release-flow",
    components: [{ id: 1, type: "dialog", mode: "build", prompt: "Package" }]
  };
  assert.deepEqual(
    workspaceMenuChildren(state, state.target.workspaceId).map((item) => item.id),
    ["chat", "model", "flowbar", "flowlist", "flowtask"]
  );
});

test("Shift+Tab cycles work mode and forces workflow selection before Flow editing", () => {
  const state = createState();
  switchView(state, "chat");
  enterConversation(state);
  assert.equal(state.snapshot.mode, "build");
  assert.equal(cycleConversationMode(state), "plan");
  assert.equal(cycleConversationMode(state), "goal");
  assert.equal(cycleConversationMode(state), "flow");
  assert.equal(state.overlay, "flow-select");
  assert.equal(state.inputMode, false);
  assert.ok(state.flows.length >= 2);
  state.flowSelectionIndex = 1;
  assert.equal(selectFlowWorkflow(state), true);
  assert.equal(state.overlay, null);
  assert.equal(state.inputMode, true);
  assert.equal(state.snapshot.mode, "flow");
  assert.equal(state.currentFlow.name, state.flows[1]);
  assert.deepEqual(
    workspaceMenuChildren(state, state.target.workspaceId).slice(-3).map((item) => item.id),
    ["flowbar", "flowlist", "flowtask"]
  );
});

test("conversation model selection is persisted only for the focused conversation", () => {
  const state = createState();
  switchView(state, "chat");
  state.selected = 1;
  enterConversation(state);
  const focusedId = state.target.conversationId;
  switchView(state, "model");
  assert.equal(state.target.conversationId, focusedId);
  assert.equal(selectConversationModel(state, 2), true);
  assert.deepEqual(state.snapshot.modelSelection, {
    kind: "deployment",
    providerId: "provider-openai-hub",
    modelId: "gpt-5.6-mini"
  });
  switchView(state, "chat");
  state.selected = 0;
  enterConversation(state);
  assert.notDeepEqual(state.snapshot.modelSelection, {
    kind: "deployment",
    providerId: "provider-openai-hub",
    modelId: "gpt-5.6-mini"
  });
  switchView(state, "chat");
  state.selected = state.snapshot.conversations.findIndex((item) => item.id === focusedId);
  enterConversation(state);
  assert.deepEqual(state.snapshot.modelSelection, {
    kind: "deployment",
    providerId: "provider-openai-hub",
    modelId: "gpt-5.6-mini"
  });
});

test("workspace child views preserve the last entered conversation", () => {
  const state = createState();
  switchView(state, "chat");
  state.selected = 2;
  enterConversation(state);
  const focusedId = state.target.conversationId;
  const level = `workspace:${state.target.workspaceId}`;
  state.menuLevel = level;
  state.menuChildIndex[level] = 1;
  assert.equal(activateMenu(state), "plan");
  assert.equal(state.target.conversationId, focusedId);
  state.focusRegion = "menu";
  state.menuLevel = level;
  state.menuChildIndex[level] = 4;
  assert.equal(activateMenu(state), "model");
  assert.equal(state.target.conversationId, focusedId);
});

test("workspaces start collapsed and Enter toggles expansion", () => {
  const state = createState();
  assert.equal(state.workspaces.length, 3);
  assert.equal(state.expandedWorkspaceIds.size, 0);
  moveMenuSelection(state, 1);
  assert.equal(state.menuRootIndex, 1);
  assert.equal(activateMenu(state), "workspace-newmark-agent-demo");
  assert.equal(state.expandedWorkspaceIds.has("workspace-newmark-agent-demo"), true);
  moveMenuLevel(state, 1);
  assert.equal(state.menuLevel, "workspace:workspace-newmark-agent-demo");
  moveMenuLevel(state, -1);
  assert.equal(state.menuLevel, "root");
  assert.equal(activateMenu(state), "workspace-newmark-agent-demo");
  assert.equal(state.expandedWorkspaceIds.has("workspace-newmark-agent-demo"), false);
});

test("up and down traverse directly through expanded workspace children", () => {
  const state = createState();
  moveMenuSelection(state, 1);
  activateMenu(state);
  moveMenuSelection(state, 1);
  assert.equal(state.menuLevel, "workspace:workspace-newmark-agent-demo");
  assert.equal(state.menuChildIndex[state.menuLevel], 0);
  moveMenuSelection(state, 1);
  assert.equal(state.menuChildIndex[state.menuLevel], 1);
  moveMenuSelection(state, 1);
  assert.equal(state.menuChildIndex[state.menuLevel], 2);
  for (let index = 3; index < 5; index += 1) {
    moveMenuSelection(state, 1);
    assert.equal(state.menuChildIndex[state.menuLevel], index);
  }
  moveMenuSelection(state, 1);
  assert.equal(state.menuLevel, "root");
  assert.equal(rootMenuItems(state)[state.menuRootIndex].id, "workspace-condensed-lab-demo");
  moveMenuSelection(state, -1);
  assert.equal(state.menuLevel, "workspace:workspace-newmark-agent-demo");
  assert.equal(state.menuChildIndex[state.menuLevel], 4);
  for (let index = 0; index < 5; index += 1) moveMenuSelection(state, -1);
  assert.equal(state.menuLevel, "root");
  assert.equal(rootMenuItems(state)[state.menuRootIndex].id, "workspace-newmark-agent-demo");
});

test("left and right cross menu boundary only at the leftmost content column", () => {
  const state = createState();
  assert.equal(state.focusRegion, "menu");
  moveFocusHorizontal(state, 1);
  assert.equal(state.focusRegion, "content");
  switchView(state, "settings");
  moveFocusHorizontal(state, 1);
  assert.equal(state.contentColumn, 1);
  moveFocusHorizontal(state, -1);
  assert.equal(state.focusRegion, "content");
  assert.equal(state.contentColumn, 0);
  moveFocusHorizontal(state, -1);
  assert.equal(state.focusRegion, "menu");
});

test("workspace child activation switches target and snapshot", () => {
  const state = createState();
  moveMenuSelection(state, 2);
  assert.equal(activateMenu(state), "workspace-condensed-lab-demo");
  moveMenuLevel(state, 1);
  assert.equal(state.menuLevel, "workspace:workspace-condensed-lab-demo");
  assert.equal(activateMenu(state), "chat");
  assert.equal(state.target.workspaceId, "workspace-condensed-lab-demo");
  assert.equal(state.target.conversationId, "arc-literature-boundary");
  assert.equal(state.snapshot.goal.objective, "Block duplicate ARC directions before simulation");
});

test("operation entries remain direct root items", () => {
  const state = createState();
  const roots = rootMenuItems(state);
  assert.deepEqual(roots.slice(-5).map((item) => item.id), ["tools", "memory", "automation", "settings", "help"]);
  state.menuRootIndex = roots.findIndex((item) => item.id === "tools");
  assert.equal(activateMenu(state), "tools");
  assert.equal(state.view, "tools");
  assert.equal(state.menuLevel, "root");
});

test("Help is a direct Operation view documenting the active shortcut contract", () => {
  const state = createState();
  switchView(state, "help");
  const output = stripAnsi(render(state, 110, 34));
  for (const text of ["SHORTCUT GUIDE", "Shift+Tab", "Flow", "Esc again", "pin / unpin", "Tab"]) {
    assert.match(output, new RegExp(text.replace("+", "\\+"), "i"));
  }
});

test("prepared desktop adapter preserves existing preload call signatures", async () => {
  const target = { workspaceId: "workspace-newmark-agent-demo", conversationId: "release-readiness-review" };
  const snapshot = createSnapshot(target);
  const calls = [];
  const api = {
    getState: async (value) => (calls.push(["getState", value]), snapshot),
    selectWorkspace: async (id) => (calls.push(["selectWorkspace", id]), { ok: true }),
    activateConversation: async (value) => (calls.push(["activateConversation", value]), snapshot),
    setModel: async (value) => (calls.push(["setModel", value]), value),
    setConversationPinned: async (id, pinned) => (calls.push(["setConversationPinned", id, pinned]), pinned),
    setMode: async (value) => (calls.push(["setMode", value]), value),
    sendMessage: async (message, value) => (calls.push(["sendMessage", message, value]), { ok: true }),
    stopConversation: async (request) => (calls.push(["stopConversation", request]), { action: "graceful" }),
    setInputMode: async (mode, value) => (calls.push(["setInputMode", mode, value]), { ok: true }),
    getConversationPlan: async (id) => (calls.push(["getConversationPlan", id]), snapshot.conversationPlan),
    updateConversationPlan: async (plan, id) => (calls.push(["updateConversationPlan", plan, id]), plan),
    updateGoal: async (goal, value) => (calls.push(["updateGoal", goal, value]), snapshot.goal),
    toggleGoalPause: async (value) => (calls.push(["toggleGoalPause", value]), true),
    clearGoal: async (value) => (calls.push(["clearGoal", value]), true),
    listFlows: async () => (calls.push(["listFlows"]), ["release-readiness"]),
    readFlow: async (name) => (calls.push(["readFlow", name]), { ok: true, workflow: { name, components: [] } }),
    listAutomations: async () => (calls.push(["listAutomations"]), []),
    toggleAutomation: async (id) => (calls.push(["toggleAutomation", id]), { id }),
    createAutomation: async (input) => (calls.push(["createAutomation", input]), input),
    deleteAutomation: async (id) => (calls.push(["deleteAutomation", id]), true),
    memoryLabRead: async (selector) => (calls.push(["memoryLabRead", selector]), { ok: true }),
    memoryLabVisualization: async () => (calls.push(["memoryLabVisualization"]), { ok: true }),
    memoryLabReindex: async () => (calls.push(["memoryLabReindex"]), { ok: true }),
    setProviderEnabled: async (id, enabled) => (calls.push(["setProviderEnabled", id, enabled]), { ok: true }),
    validateModels: async (models) => (calls.push(["validateModels", models]), []),
    modelValidationStatus: async () => (calls.push(["modelValidationStatus"]), { running: false }),
    fuzzyInject: async (...args) => (calls.push(["fuzzyInject", ...args]), { ok: true }),
    saveConfig: async (config) => (calls.push(["saveConfig", config]), { ok: true }),
    saveSetting: async (...args) => (calls.push(["saveSetting", ...args]), { ok: true }),
    openGlobalConfig: async () => (calls.push(["openGlobalConfig"]), { ok: true }),
    reloadGlobalConfig: async () => (calls.push(["reloadGlobalConfig"]), { ok: true }),
    listArchives: async (scope) => (calls.push(["listArchives", scope]), []),
    updateVersion: async () => (calls.push(["updateVersion"]), { version: "demo" }),
    updateCheckGithub: async (input) => (calls.push(["updateCheckGithub", input]), { ok: true }),
    updateApplyGithub: async (input) => (calls.push(["updateApplyGithub", input]), { ok: true }),
    updateInstallLocal: async (input) => (calls.push(["updateInstallLocal", input]), { ok: true })
  };
  const adapter = createDesktopPreloadAdapter(api);
  await adapter.activateConversation(target);
  await adapter.setConversationModel({
    kind: "deployment",
    providerId: "provider-openai-hub",
    modelId: "gpt-5.6"
  }, target);
  await adapter.getConversationPlan(target);
  await adapter.sendMessage("hello", target);
  await adapter.memoryLabRead("release-gates");
  await adapter.setProviderEnabled("provider-openai-hub", false);
  await adapter.validateModels(["gpt-5.6"]);
  assert.deepEqual(calls, [
    ["activateConversation", target],
    ["activateConversation", target],
    ["setModel", "deployment:provider-openai-hub:gpt-5.6"],
    ["getState", target],
    ["getConversationPlan", target.conversationId],
    ["sendMessage", "hello", target],
    ["memoryLabRead", "release-gates"],
    ["setProviderEnabled", "provider-openai-hub", false],
    ["validateModels", ["gpt-5.6"]]
  ]);
});

test("Memory Lab detail uses the existing visualization result shape", () => {
  const state = createState();
  switchView(state, "memory");
  moveFocusHorizontal(state, 1);
  const detail = selectedMemoryDetail(state);
  assert.equal(state.memoryLab.index.version, 2);
  assert.equal(detail.tag, "arc");
  assert.deepEqual(detail.node.parents, ["research"]);
  assert.equal(detail.component.name, "ARC literature boundary");
  assert.match(detail.content, /Literature review blocks duplicate simulation/);
  const output = stripAnsi(render(state, 110, 34));
  assert.match(output, /Memory Lab.*Overview.*Detail/);
  assert.match(output, /Parent tags.*Selected tag.*Child tags/);
  assert.match(output, /Memory components.*Core memory/);
  assert.match(output, /SIMULATED.*no disk read/);
  moveFocusHorizontal(state, 1);
  moveFocusHorizontal(state, 1);
  moveFocusHorizontal(state, 1);
  assert.equal(state.contentColumn, 3);
  moveSelection(state, 1);
  assert.equal(selectedMemoryDetail(state).component.name, "Research closure");
  moveFocusHorizontal(state, -1);
  moveFocusHorizontal(state, -1);
  moveFocusHorizontal(state, -1);
  assert.equal(state.focusRegion, "content");
  assert.equal(state.contentColumn, 0);
  assert.equal(activateMemorySelection(state), true);
  assert.equal(selectedMemoryDetail(state).tag, "research");
});

test("provider and model settings are interactive mock integrations", () => {
  const state = createState();
  switchView(state, "settings");
  moveFocusHorizontal(state, 1);
  moveSelection(state, 3);
  assert.equal(state.settingsTab, "providers");
  moveFocusHorizontal(state, 1);
  assert.equal(state.contentColumn, 1);
  const providerEnabled = state.providers[0].enabled;
  toggleSelected(state);
  assert.equal(state.providers[0].enabled, !providerEnabled);
  assert.equal(state.providers[0].api_key, "");
  assert.equal(state.providers[0].has_api_key, true);
  moveFocusHorizontal(state, -1);
  moveSelection(state, 1);
  assert.equal(state.settingsTab, "models");
  moveFocusHorizontal(state, 1);
  validateSelectedModel(state);
  assert.match(state.validationNotice, /gpt-5\.6: verified\/extended/);
  const output = stripAnsi(render(state, 120, 34));
  assert.match(output, /\[V\] Providers/);
  assert.match(output, /\[M\] Models/);
  assert.match(output, /Models settings/);
  assert.match(output, /SIMULATED.*No provider request or config write/);
});

test("complete settings expose personalization, runtime, tools, archive, and updates", () => {
  const state = createState();
  switchView(state, "settings");
  moveFocusHorizontal(state, 1);
  const menu = stripAnsi(render(state, 126, 38));
  for (const label of ["General", "Personalization", "Runtime", "Providers", "Models", "Tools", "Archive", "Updates"]) {
    assert.match(menu, new RegExp(label));
  }
  moveSelection(state, 1);
  assert.equal(state.settingsTab, "personalization");
  moveFocusHorizontal(state, 1);
  moveSelection(state, 1);
  toggleSelected(state);
  assert.equal(state.settings.personalization.fontFamily, "Cascadia Mono");
  moveSelection(state, 1);
  toggleSelected(state);
  assert.equal(state.settings.personalization.fontColor, "#B7E4FF");
  moveSelection(state, 1);
  toggleSelected(state);
  assert.equal(state.settings.personalization.backgroundColor, "#111827");
  const output = stripAnsi(render(state, 126, 38));
  assert.match(output, /Live color preview/);
  assert.match(output, /contrast \d+\.\d+:1 (PASS|LOW)/);
  assert.match(output, /TUI EXTENSION/);
  assert.match(output, /cannot force the terminal host to change its font face/);
  const ansiOutput = render(state, 126, 38);
  assert.match(ansiOutput, /\u001b\[38;2;183;228;255m/);
  assert.match(ansiOutput, /\u001b\[48;2;17;24;39m/);
});

test("light theme replaces the dark canvas with a readable light palette", () => {
  const state = createState();
  executeAction(state, "theme");
  const output = render(state, 100, 32);
  assert.equal(state.theme, "light");
  assert.equal(state.settings.personalization.theme, "Light");
  assert.equal(state.settings.personalization.fontColor, "#1F2937");
  assert.equal(state.settings.personalization.backgroundColor, "#F0F2F8");
  assert.match(output, /\u001b\[38;2;31;41;55m/);
  assert.match(output, /\u001b\[48;2;240;242;248m/);
  assert.doesNotMatch(output, /\u001b\[48;2;10;10;26m/);
  const rows = stripAnsi(output).split("\n");
  assert.equal(rows.length, 32);
  assert.ok(rows.every((row) => visibleLength(row) === 100));
});

test("sidebar icons occupy one portable fixed-width cell", () => {
  const data = require("../src/data");
  assert.ok(data.navigation.every((item) => /^\[[A-Z]\]$/.test(item.icon)));
  assert.ok(data.workspaces.every((item) => /^\[[A-Z]\]$/.test(item.icon)));
});

test("tool toggle only mutates demo state", () => {
  const state = createState();
  switchView(state, "tools");
  const original = state.tools[0].enabled;
  toggleSelected(state);
  assert.equal(state.tools[0].enabled, !original);
  assert.match(state.notice, /demo only/);
});

test("command palette filters and executes commands", () => {
  const state = createState();
  state.paletteQuery = "settings";
  assert.equal(filteredCommands(state).length, 1);
  executeAction(state, filteredCommands(state)[0].action);
  assert.equal(state.view, "settings");
});

test("renderer includes safety boundary and supports compact layout", () => {
  const state = createState();
  switchView(state, "tools");
  const normal = stripAnsi(render(state, 110, 34));
  const compact = stripAnsi(render(state, 60, 24));
  assert.match(normal, /Safety boundary/);
  assert.match(normal, /No shell, file, browser/);
  assert.match(compact, /NEWMARK/);
  assert.match(compact, /Tools/);
});

test("CJK message wrapping stays inside the content partition", () => {
  const state = createState();
  switchView(state, "chat");
  state.messages = [{
    role: "assistant",
    content: "你好！我是 Newmark Agent，一个集成了编程、项目管理、文件操作、浏览器控制、桌面自动化能力的终端助手。这里继续使用很长的中文内容验证换行不会越过工作区分隔线。",
    meta: "真实终端宽度隔离检查"
  }];
  const output = render(state, 100, 32);
  const lines = stripAnsi(output).split("\n");
  for (const line of lines) {
    assert.ok(visibleLength(line) <= 100, `rendered row exceeds terminal width: ${visibleLength(line)}`);
  }
  const partitioned = lines.filter((line) => line.includes("│"));
  assert.ok(partitioned.length > 5);
  for (const line of partitioned) {
    assert.equal(visibleLength(line.slice(0, line.indexOf("│"))), 22);
  }
  const wrapped = wrapText("中文换行隔离测试中文换行隔离测试", 10);
  assert.ok(wrapped.length > 1);
  assert.ok(wrapped.every((line) => visibleLength(line) <= 10));
});

test("sidebar distinguishes workspace children from operations", () => {
  const state = createState();
  const output = stripAnsi(render(state, 100, 34));
  assert.match(output, /WORKSPACE/);
  assert.match(output, /▸ \[W\] Newmark Agent/);
  assert.match(output, /▸ \[W\] Condensed Lab/);
  assert.match(output, /▸ \[R\] push-lite/);
  assert.doesNotMatch(output, /Conversations/);
  assert.match(output, /OPERATIONS/);
  assert.match(output, /Tools/);
  assert.match(output, /Memory Lab/);
  assert.match(output, /Automations/);
  assert.match(output, /Settings/);
  assert.doesNotMatch(output, /Runtime & services/);
  assert.match(output, /ACTIVE CONVERSATION/);
  state.menuRootIndex = 1;
  activateMenu(state);
  assert.match(stripAnsi(render(state, 100, 34)), /Conversations/);
});

test("all primary views render without undefined output", () => {
  const state = createState();
  for (const view of ["home", "chat", "plan", "goal", "agents", "model", "flowbar", "flowlist", "flowtask", "tools", "memory", "automation", "settings", "help"]) {
    switchView(state, view);
    const output = stripAnsi(render(state, 100, 32));
    assert.doesNotMatch(output, /undefined|null/);
    assert.ok(output.length > 200);
  }
});

test("ANSI sequences remain valid across view and terminal size matrix", () => {
  const state = createState();
  for (const [columns, rows] of [[52, 20], [60, 24], [78, 28], [100, 32], [140, 40]]) {
    for (const view of ["home", "chat", "plan", "goal", "agents", "model", "flowbar", "flowlist", "flowtask", "tools", "memory", "automation", "settings", "help"]) {
      switchView(state, view);
      const output = render(state, columns, rows);
      assert.equal(stripAnsi(output).includes("\u001b"), false, `${view} at ${columns}x${rows}`);
    }
  }
});
