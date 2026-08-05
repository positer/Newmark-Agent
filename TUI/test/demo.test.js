"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createPaintScheduler, executeAction } = require("../src/app");
const { createCoreRuntimeAdapter, mergeProviderConfig } = require("../src/adapters/core-runtime-adapter");
const { createDesktopPreloadAdapter } = require("../src/adapters/desktop-preload-adapter");
const { createMockNewmarkAdapter, createSnapshot } = require("../src/adapters/mock-newmark-adapter");
const { targetKey, validateSnapshot } = require("../src/adapters/newmark-contract");
const { render, stripAnsi, visibleLength, wrapText } = require("../src/render");
const {
  activateMenu,
  activateMemorySelection,
  activeConversationModelLabel,
  applyConversationResult,
  beginAutomationCreate,
  beginWorkflowCreate,
  createAutomationFromDraft,
  createState,
  cycleConversationMode,
  confirmSettingChoiceSelection,
  enterConversation,
  filteredCommands,
  moveFocusHorizontal,
  moveConversationHistoryCursor,
  moveInputCursorVertical,
  moveMenuLevel,
  moveMenuSelection,
  moveSettingChoiceSelection,
  moveSelection,
  markConversationRunning,
  memoryTagOptions,
  rootMenuItems,
  returnToConversationSelection,
  requestConversationStop,
  selectConversationModel,
  selectIntelligenceTier,
  selectFlowWorkflow,
  saveWorkflowFromDraft,
  selectedMemoryDetail,
  setMemorySearchQuery,
  switchView,
  toggleConversationPinned,
  toggleSelectedBuildBlock,
  toggleSelected,
  validateSelectedModel,
  workspaceMenuChildren
} = require("../src/state");

test("initial state opens the real conversation surface without an overview placeholder", () => {
  const state = createState();
  assert.equal(state.view, "chat");
  assert.equal(rootMenuItems(state).some((item) => item.id === "home" || item.label === "Overview"), false);
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
    const automation = adapter.createAutomation({
      prompt: "Verify persisted TUI automation",
      workspaceId: state.target.workspaceId,
      workspaceName: selected.name,
      conversationMode: "existing",
      conversationId: state.target.conversationId,
      condition: "once"
    });
    assert.equal(adapter.listAutomations().some((item) => item.id === automation.id), true);
    const workflow = adapter.saveFlow({
      name: "tui-created-workflow",
      components: [{ id: 0, type: "dialog", mode: "build", prompt: "Verify persisted TUI workflow" }]
    });
    assert.equal(workflow.name, "tui-created-workflow");
    assert.equal(adapter.listFlows().includes(workflow.name), true);
    assert.equal(adapter.readFlow(workflow.name).components[0].prompt, "Verify persisted TUI workflow");
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

test("real core persists the default Enter mode and restores Guide or Next from shared config", () => {
  const base = fs.mkdtempSync(path.join(__dirname, ".tmp-input-mode-core-"));
  const runtimeRoot = path.join(base, "runtime");
  const workspacePath = path.join(base, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  try {
    let adapter = createCoreRuntimeAdapter({ root: runtimeRoot, workspacePath });
    const target = adapter.getInitialTarget();
    assert.equal(adapter.getState(target).inputMode, "guide");
    assert.equal(adapter.setInputMode("next", target), "next");
    assert.equal(adapter.getState(target).inputMode, "next");
    adapter.close();

    adapter = createCoreRuntimeAdapter({ root: runtimeRoot, workspacePath });
    assert.equal(adapter.getState(adapter.getInitialTarget()).inputMode, "next");
    assert.equal(adapter.setInputMode("guide", adapter.getInitialTarget()), "guide");
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
  assert.equal(state.selected, state.snapshot.conversations.length - 1);
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

test("TUI Model exposes and stress-switches the six shared reasoning effort tiers", () => {
  const state = createState();
  switchView(state, "model");
  state.focusRegion = "content";
  const tiers = ["low", "medium", "high", "xhigh", "max", "ultra"];
  for (let round = 0; round < 50; round++) {
    for (let index = 0; index < tiers.length; index++) {
      assert.equal(selectIntelligenceTier(state, index), true);
      assert.equal(state.snapshot.intelligence, tiers[index]);
    }
  }
  const output = stripAnsi(render(state, 120, 40));
  assert.match(output, /Reasoning effort/);
  assert.match(output, /low[\s\S]*medium[\s\S]*high[\s\S]*xhigh[\s\S]*max[\s\S]*ultra/);
  assert.match(output, /Deployment/);
  moveFocusHorizontal(state, 1);
  assert.equal(state.contentColumn, 1);
  assert.equal(selectConversationModel(state, 0), true);
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
  assert.equal(state.menuRootIndex, 0);
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
  state.menuRootIndex = rootMenuItems(state).findIndex((item) => item.id === "workspace-condensed-lab-demo");
  assert.equal(activateMenu(state), "workspace-condensed-lab-demo");
  moveMenuLevel(state, 1);
  assert.equal(state.menuLevel, "workspace:workspace-condensed-lab-demo");
  assert.equal(activateMenu(state), "chat");
  assert.equal(state.target.workspaceId, "workspace-condensed-lab-demo");
  assert.equal(state.target.conversationId, "arc-literature-boundary");
  assert.equal(state.snapshot.goal.objective, "Block duplicate ARC directions before simulation");
});

test("operation entries remain flat root items including WorkFlow", () => {
  const state = createState();
  const roots = rootMenuItems(state);
  assert.deepEqual(roots.slice(-6).map((item) => item.id), ["tools", "memory", "automation", "workflow", "settings", "help"]);
  state.menuRootIndex = roots.findIndex((item) => item.id === "tools");
  assert.equal(activateMenu(state), "tools");
  assert.equal(state.view, "tools");
  assert.equal(state.menuLevel, "root");
  state.menuRootIndex = roots.findIndex((item) => item.id === "workflow");
  assert.equal(activateMenu(state), "workflow");
  assert.equal(state.view, "workflow");
  assert.equal(state.menuLevel, "root");
  assert.equal(state.expandedWorkspaceIds.has("workflow"), false);
});

test("long flat menus scroll to keep the selected Operation visible", () => {
  const state = createState();
  state.workspaces.push(...Array.from({ length: 12 }, (_, index) => ({
    id: `workspace-long-${index}`,
    name: `Long workspace ${String(index + 1).padStart(2, "0")}`,
    path: `C:\\demo\\long-${index}`,
    icon: "[W]"
  })));
  const roots = rootMenuItems(state);
  state.menuRootIndex = roots.findIndex((item) => item.id === "help");
  const output = stripAnsi(render(state, 100, 20));
  assert.match(output, /Help/);
  assert.match(output, /ACTIVE CONVERSATION/);
  assert.ok(state.menuScroll > 0);
});

test("conversation editor scrolls history only beyond the input area's top or bottom", () => {
  const state = createState();
  switchView(state, "chat");
  state.inputMode = true;
  state.input = "first input line\nsecond input line";
  state.inputCursor = [...state.input].length;
  state.messages = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `history-row-${String(index + 1).padStart(2, "0")}`
  }));
  state.snapshot.workRuns = [{
    runId: "scroll-build",
    status: "completed",
    sequence: 1,
    startedAt: "2026-07-29T10:00:00.000Z",
    endedAt: "2026-07-29T10:00:01.000Z",
    events: [],
    guides: []
  }];
  let output = stripAnsi(render(state, 100, 20));
  assert.match(output, /history-row-24/);
  assert.doesNotMatch(output, /history-row-01/);
  assert.match(output, /> first input line/);
  assert.match(output, /second input line/);
  assert.equal(output.split("\n").length, 20);
  assert.equal(moveInputCursorVertical(state, -1), "cursor");
  assert.equal(state.conversationScroll, 0);
  assert.equal(moveInputCursorVertical(state, -1), "history-focus");
  assert.equal(state.conversationHistoryFocus, true);
  assert.equal(moveConversationHistoryCursor(state, 1), "input");
  state.conversationScroll = Math.min(10, state.conversationMaxScroll);
  state.inputCursor = [...state.input].length;
  for (let index = 0; index < 80; index += 1) moveInputCursorVertical(state, 1);
  output = stripAnsi(render(state, 100, 20));
  assert.match(output, /history-row-24/);
  assert.equal(state.conversationScroll, 0);
});

test("input-top Up enters Build Block history and Enter expands duration, progress, and tools", () => {
  const state = createState();
  switchView(state, "chat");
  state.inputMode = true;
  state.input = "draft";
  state.inputCursor = 0;
  state.snapshot.workRuns = Array.from({ length: 5 }, (_, index) => ({
    runId: `build-${index + 1}`,
    status: "completed",
    sequence: index + 1,
    startedAt: `2026-07-29T10:0${index}:00.000Z`,
    endedAt: `2026-07-29T10:0${index}:02.500Z`,
    events: index === 4
      ? [
          { type: "text", content: "Checking the release boundary." },
          { type: "tool_call", toolName: "bash", content: "npm test" },
          { type: "tool_result", toolName: "bash", content: "42 tests passed" }
        ]
      : [],
    guides: []
  }));
  render(state, 100, 20);
  assert.equal(moveInputCursorVertical(state, -1), "history-focus");
  assert.equal(state.conversationHistoryFocus, true);
  assert.equal(state.historySelectedIndex, 4);
  let output = stripAnsi(render(state, 100, 20));
  assert.match(output, /Build Block 5/);
  assert.match(output, /2\.5s/);
  assert.doesNotMatch(output, /Checking the release boundary/);
  assert.equal(toggleSelectedBuildBlock(state), true);
  output = stripAnsi(render(state, 100, 20));
  assert.match(output, /Checking the release boundary/);
  assert.match(output, /bash.*npm test/i);
  assert.match(output, /42 tests passed/);
  for (let index = 0; index < 4; index += 1) {
    assert.equal(moveConversationHistoryCursor(state, -1), "history");
    render(state, 100, 20);
  }
  assert.equal(state.historySelectedIndex, 0);
  output = stripAnsi(render(state, 100, 20));
  assert.match(output, /Build Block 1/);
  assert.ok(state.conversationScroll > 0);
});

test("conversation timeline keeps each collapsible Build Block immediately before its always-visible summary", () => {
  const state = createState();
  switchView(state, "chat");
  state.inputMode = true;
  state.input = "";
  state.inputCursor = 0;
  state.messages = [
    { role: "user", content: "Run alpha", runId: "run-alpha" },
    { role: "assistant", content: "ALPHA SUMMARY", runId: "run-alpha" },
    { role: "user", content: "Run beta", runId: "run-beta" }
  ];
  state.snapshot.workRuns = [
    {
      runId: "run-alpha",
      status: "completed",
      sequence: 1,
      startedAt: "2026-07-29T10:00:00.000Z",
      endedAt: "2026-07-29T10:00:02.500Z",
      events: [
        { type: "text", content: "ALPHA BUILD DETAIL" },
        { type: "tool_call", toolName: "bash", content: "npm test" },
        { type: "final_response", content: "ALPHA SUMMARY" }
      ],
      guides: []
    },
    {
      runId: "run-beta",
      status: "completed",
      sequence: 2,
      startedAt: "2026-07-29T10:01:00.000Z",
      endedAt: "2026-07-29T10:01:03.000Z",
      events: [
        { type: "text", content: "BETA BUILD DETAIL" },
        { type: "final_response", content: "BETA RECOVERED SUMMARY" }
      ],
      guides: []
    }
  ];

  let output = stripAnsi(render(state, 140, 40));
  assert.match(output, /▸ Build Block 1\s+completed · 2\.5s/);
  assert.match(output, /▸ Build Block 2\s+completed · 3\.0s/);
  assert.doesNotMatch(output, /ALPHA BUILD DETAIL|BETA BUILD DETAIL|npm test/);
  assert.equal((output.match(/ALPHA SUMMARY/g) || []).length, 1);
  assert.equal((output.match(/BETA RECOVERED SUMMARY/g) || []).length, 1);

  const collapsedAlphaBlock = output.indexOf("Build Block 1");
  const collapsedAlphaSummary = output.indexOf("ALPHA SUMMARY");
  const collapsedBetaBlock = output.indexOf("Build Block 2");
  const collapsedBetaSummary = output.indexOf("BETA RECOVERED SUMMARY");
  assert.ok(
    collapsedAlphaBlock < collapsedAlphaSummary
      && collapsedAlphaSummary < collapsedBetaBlock
      && collapsedBetaBlock < collapsedBetaSummary,
    "collapsed timeline must preserve run-alpha block → alpha summary → run-beta block → beta summary"
  );

  state.conversationHistoryFocus = true;
  state.historySelectedIndex = 0;
  assert.equal(toggleSelectedBuildBlock(state), true);
  output = stripAnsi(render(state, 140, 40));
  assert.match(output, /▾ Build Block 1\s+completed · 2\.5s/);
  assert.match(output, /ALPHA BUILD DETAIL/);
  assert.match(output, /bash.*npm test/i);
  assert.equal((output.match(/ALPHA SUMMARY/g) || []).length, 1);
  assert.equal((output.match(/BETA RECOVERED SUMMARY/g) || []).length, 1);

  const expandedAlphaBlock = output.indexOf("Build Block 1");
  const expandedAlphaProgress = output.indexOf("ALPHA BUILD DETAIL");
  const expandedAlphaSummary = output.indexOf("ALPHA SUMMARY");
  const expandedBetaBlock = output.indexOf("Build Block 2");
  const expandedBetaSummary = output.indexOf("BETA RECOVERED SUMMARY");
  assert.ok(
    expandedAlphaBlock < expandedAlphaProgress
      && expandedAlphaProgress < expandedAlphaSummary
      && expandedAlphaSummary < expandedBetaBlock
      && expandedBetaBlock < expandedBetaSummary,
    "expansion may reveal run details but must keep each summary outside and directly after its owning Build Block"
  );
});

test("Build image display stays visible when collapsed and Enter opens its dedicated viewer", () => {
  const state = createState();
  switchView(state, "chat");
  state.inputMode = true;
  const image = {
    id: "display-image-fixture", origin: "agent", name: "diagram.png", caption: "Release architecture",
    mimeType: "image/png", dataUrl: "data:image/png;base64,aW1hZ2U="
  };
  state.snapshot.workRuns = [{
    runId: "image-run", status: "completed", sequence: 1,
    startedAt: "2026-08-01T10:00:00.000Z", endedAt: "2026-08-01T10:00:01.000Z",
    events: [
      { type: "tool_call", toolName: "image_display", toolCallId: "image-call", content: "Using tool image_display." },
      { type: "tool_result", toolName: "image_display", toolCallId: "image-call", content: "Tool image_display completed.", displayImage: image }
    ], guides: []
  }];
  let opened = null;
  state.adapter.openImageViewer = (value) => { opened = value; return { ok: true }; };
  let output = stripAnsi(render(state, 120, 30));
  assert.match(output, /\[示意图\]/);
  assert.doesNotMatch(output, /Release architecture|Enter 打开/);
  state.conversationHistoryFocus = true;
  state.historySelectedIndex = 0;
  state.historySelectedImageIndex = 0;
  output = stripAnsi(render(state, 120, 30));
  assert.match(output, /\[示意图\].*Release architecture.*Enter 打开/);
  assert.deepEqual(toggleSelectedBuildBlock(state), { ok: true });
  assert.equal(opened.id, image.id);
  state.historySelectedImageIndex = -1;
  assert.equal(toggleSelectedBuildBlock(state), true);
  output = stripAnsi(render(state, 120, 30));
  assert.match(output, /TOOL image_display[\s\S]*\[示意图\]/);
  assert.doesNotMatch(output, /Release architecture|Enter 打开/);
});

test("Build input and Guide placement follows the GUI run timeline in collapsed and expanded states", () => {
  const state = createState();
  switchView(state, "chat");
  state.inputMode = true;
  state.input = "";
  state.inputCursor = 0;
  state.messages = [
    { role: "user", content: "PRIMARY BUILD INPUT", runId: "run-guided" },
    { role: "assistant", content: "GUIDED FINAL SUMMARY", runId: "run-guided" }
  ];
  state.snapshot.workRuns = [{
    runId: "run-guided",
    status: "completed",
    sequence: 1,
    primaryPrompt: "PRIMARY BUILD INPUT",
    startedAt: "2026-07-29T11:00:00.000Z",
    endedAt: "2026-07-29T11:00:04.000Z",
    events: [
      {
        type: "guide",
        content: "GUIDE SECOND",
        sequence: 20,
        timestamp: "2026-07-29T11:00:03.000Z",
        guide: {
          clientMessageId: "guide-second",
          content: "GUIDE SECOND",
          status: "applied",
          createdAt: "2026-07-29T11:00:03.000Z"
        }
      },
      {
        type: "text",
        content: "DETAIL BEFORE GUIDES",
        sequence: 10,
        timestamp: "2026-07-29T11:00:01.000Z"
      },
      {
        type: "guide",
        content: "GUIDE FIRST",
        sequence: 20,
        timestamp: "2026-07-29T11:00:02.000Z",
        guide: {
          clientMessageId: "guide-first",
          content: "GUIDE FIRST",
          status: "accepted",
          createdAt: "2026-07-29T11:00:02.000Z"
        }
      },
      {
        type: "guide",
        content: "GUIDE FIRST",
        sequence: 20,
        timestamp: "2026-07-29T11:00:02.000Z",
        guide: {
          clientMessageId: "guide-first",
          content: "GUIDE FIRST",
          status: "applied",
          createdAt: "2026-07-29T11:00:02.000Z"
        }
      },
      {
        type: "tool_call",
        toolName: "bash",
        content: "npm test",
        sequence: 30,
        timestamp: "2026-07-29T11:00:03.500Z"
      },
      {
        type: "final_response",
        content: "GUIDED FINAL SUMMARY",
        sequence: 40,
        timestamp: "2026-07-29T11:00:04.000Z"
      }
    ],
    guides: []
  }];

  let output = stripAnsi(render(state, 140, 40));
  assert.doesNotMatch(output, /DETAIL BEFORE GUIDES|npm test/);
  assert.equal((output.match(/PRIMARY BUILD INPUT/g) || []).length, 1);
  assert.equal((output.match(/GUIDE FIRST/g) || []).length, 1);
  assert.equal((output.match(/GUIDE SECOND/g) || []).length, 1);
  assert.equal((output.match(/GUIDED FINAL SUMMARY/g) || []).length, 1);

  const collapsedInput = output.indexOf("PRIMARY BUILD INPUT");
  const collapsedBlock = output.indexOf("Build Block 1");
  const collapsedFirstGuide = output.indexOf("GUIDE FIRST");
  const collapsedSecondGuide = output.indexOf("GUIDE SECOND");
  const collapsedSummary = output.indexOf("GUIDED FINAL SUMMARY");
  assert.ok(
    collapsedInput < collapsedBlock
      && collapsedBlock < collapsedFirstGuide
      && collapsedFirstGuide < collapsedSecondGuide
      && collapsedSecondGuide < collapsedSummary,
    "collapsed GUI order must be primary input → Build header → deduplicated Guides → final summary"
  );

  state.conversationHistoryFocus = true;
  state.historySelectedIndex = 0;
  assert.equal(toggleSelectedBuildBlock(state), true);
  output = stripAnsi(render(state, 140, 40));
  assert.equal((output.match(/PRIMARY BUILD INPUT/g) || []).length, 1);
  assert.equal((output.match(/GUIDE FIRST/g) || []).length, 1);
  assert.equal((output.match(/GUIDE SECOND/g) || []).length, 1);
  assert.equal((output.match(/GUIDED FINAL SUMMARY/g) || []).length, 1);

  const expandedInput = output.indexOf("PRIMARY BUILD INPUT");
  const expandedBlock = output.indexOf("Build Block 1");
  const expandedDetail = output.indexOf("DETAIL BEFORE GUIDES");
  const expandedFirstGuide = output.indexOf("GUIDE FIRST");
  const expandedSecondGuide = output.indexOf("GUIDE SECOND");
  const expandedTool = output.indexOf("npm test");
  const expandedSummary = output.indexOf("GUIDED FINAL SUMMARY");
  assert.ok(
    expandedInput < expandedBlock
      && expandedBlock < expandedDetail
      && expandedDetail < expandedFirstGuide
      && expandedFirstGuide < expandedSecondGuide
      && expandedSecondGuide < expandedTool
      && expandedTool < expandedSummary,
    "expanded GUI order must keep sequence/timestamp-sorted Guides inside the Build body before the final summary"
  );
});

test("Build expansion hydrates from and persists through the shared Newmark run state", () => {
  const adapter = createMockNewmarkAdapter();
  const originalGetState = adapter.getState.bind(adapter);
  const originalActivateConversation = adapter.activateConversation.bind(adapter);
  const persisted = [];
  const expandFirstRun = (snapshot) => {
    snapshot.workRuns[0].expanded = true;
    return snapshot;
  };
  adapter.getState = (target) => expandFirstRun(originalGetState(target));
  adapter.activateConversation = (target) => expandFirstRun(originalActivateConversation(target));
  adapter.setWorkRunExpanded = (runId, expanded, target) => {
    persisted.push({ runId, expanded, target: { ...target } });
    return true;
  };

  const state = createState({ adapter });
  switchView(state, "chat");
  state.inputMode = true;
  state.conversationHistoryFocus = true;
  state.historySelectedIndex = 0;
  const runId = state.snapshot.workRuns[0].runId;
  assert.equal(state.expandedBuildRuns.has(runId), true);
  assert.equal(toggleSelectedBuildBlock(state), true);
  assert.deepEqual(persisted, [{
    runId,
    expanded: false,
    target: { ...state.target }
  }]);
  assert.equal(state.snapshot.workRuns[0].expanded, false);
  assert.equal(state.expandedBuildRuns.has(runId), false);
});

test("Automation content starts with a real create action", () => {
  const state = createState();
  switchView(state, "automation");
  assert.equal(beginAutomationCreate(state), true);
  assert.equal(state.overlay, "automation-create");
  state.automationDraft.prompt = "Run the release health check";
  state.automationDraft.condition = "loop";
  state.automationDraft.intervalSec = "300";
  state.automationDraft.conversationMode = "existing";
  const created = createAutomationFromDraft(state);
  assert.equal(created.prompt, "Run the release health check");
  assert.equal(created.workspaceId, state.target.workspaceId);
  assert.equal(created.conversationId, state.target.conversationId);
  assert.equal(created.condition, "loop");
  assert.equal(created.intervalSec, 300);
  assert.equal(state.overlay, null);
  assert.equal(state.automations[0].id, created.id);
});

test("WorkFlow content creates and immediately manages a persisted workflow", () => {
  const saved = [];
  const adapter = createMockNewmarkAdapter();
  adapter.saveFlow = (workflow) => {
    saved.push(structuredClone(workflow));
    return structuredClone(workflow);
  };
  const state = createState({ adapter });
  switchView(state, "workflow");
  assert.equal(beginWorkflowCreate(state), true);
  assert.equal(state.overlay, "workflow-create");
  state.workflowDraft.name = "tui-release-check";
  state.workflowDraft.mode = "goal";
  state.workflowDraft.prompt = "Verify the complete release and report evidence.";
  const workflow = saveWorkflowFromDraft(state);
  assert.deepEqual(workflow, {
    name: "tui-release-check",
    components: [{
      type: "dialog",
      id: 0,
      mode: "goal",
      prompt: "Verify the complete release and report evidence."
    }]
  });
  assert.deepEqual(saved, [workflow]);
  assert.ok(state.flows.includes("tui-release-check"));
  assert.equal(state.workflowDetails["tui-release-check"].components.length, 1);
  assert.equal(state.overlay, null);
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
    setIntelligence: async (value) => (calls.push(["setIntelligence", value]), value),
    setConversationPinned: async (id, pinned) => (calls.push(["setConversationPinned", id, pinned]), pinned),
    setWorkRunExpanded: async (request) => (calls.push(["setWorkRunExpanded", request]), true),
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
    saveFlow: async (workflow) => (calls.push(["saveFlow", workflow]), { ok: true, workflow }),
    listAutomations: async () => (calls.push(["listAutomations"]), []),
    toggleAutomation: async (id) => (calls.push(["toggleAutomation", id]), { id }),
    createAutomation: async (input) => (calls.push(["createAutomation", input]), input),
    deleteAutomation: async (id) => (calls.push(["deleteAutomation", id]), true),
    memoryLabRead: async (selector) => (calls.push(["memoryLabRead", selector]), { ok: true }),
    memoryLabVisualization: async () => (calls.push(["memoryLabVisualization"]), { ok: true }),
    memoryLabReindex: async () => (calls.push(["memoryLabReindex"]), { ok: true }),
    openImageViewer: async (input) => (calls.push(["openImageViewer", input]), { ok: true }),
    openMemoryOverview: async () => (calls.push(["openMemoryOverview"]), { ok: true }),
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
  await adapter.setWorkRunExpanded("run-release-review", false, target);
  await adapter.setConversationModel({
    kind: "deployment",
    providerId: "provider-openai-hub",
    modelId: "gpt-5.6"
  }, target);
  await adapter.setIntelligence("xhigh", target);
  await adapter.getConversationPlan(target);
  await adapter.sendMessage("hello", target);
  await adapter.setInputMode("next", target);
  await adapter.memoryLabRead("release-gates");
  await adapter.setProviderEnabled("provider-openai-hub", false);
  await adapter.validateModels(["gpt-5.6"]);
  assert.deepEqual(calls, [
    ["activateConversation", target],
    ["setWorkRunExpanded", { target, runId: "run-release-review", expanded: false }],
    ["activateConversation", target],
    ["setModel", "deployment:provider-openai-hub:gpt-5.6"],
    ["getState", target],
    ["activateConversation", target],
    ["setIntelligence", "xhigh"],
    ["getState", target],
    ["getConversationPlan", target.conversationId],
    ["sendMessage", "hello", target],
    ["setInputMode", "next", target],
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
  assert.match(output, /Memory Lab.*search tags/);
  assert.match(output, /Overview · 示意图/);
  assert.doesNotMatch(output, /Reindex|Rindex/);
  assert.match(output, /Tags.*Selected tag.*Child tags/);
  assert.match(output, /Memory components.*Core memory/);
  assert.doesNotMatch(output, /SIMULATED|no disk read/);
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
  assert.equal(activateMemorySelection(state).type, "memory-overview");
  state.memoryColumnIndices[0] = 1;
  assert.equal(activateMemorySelection(state), true);
  assert.equal(selectedMemoryDetail(state).tag, "arc");
});

test("Memory Lab tag search filters live tags and follows the first result", () => {
  const state = createState();
  switchView(state, "memory");
  state.memorySearchActive = true;
  assert.equal(setMemorySearchQuery(state, "wsl"), "wsl");
  assert.deepEqual(memoryTagOptions(state), ["wsl"]);
  assert.equal(selectedMemoryDetail(state).tag, "wsl");
  const output = stripAnsi(render(state, 100, 32));
  assert.match(output, /\/ wsl/);
  assert.doesNotMatch(output, /> arc|> research/);
  setMemorySearchQuery(state, "missing-tag");
  assert.deepEqual(memoryTagOptions(state), []);
  assert.match(stripAnsi(render(state, 100, 32)), /— none —/);
});

test("conversation title shows its current model selection", () => {
  const state = createState();
  assert.equal(activeConversationModelLabel(state), "Auto · gpt-5.6");
  let output = stripAnsi(render(state, 100, 32));
  assert.match(output, /Release readiness review\s+Auto · gpt-5\.6/);
  selectConversationModel(state, 2);
  assert.equal(activeConversationModelLabel(state), "GPT-5.6 Mini");
  switchView(state, "chat");
  output = stripAnsi(render(state, 100, 32));
  assert.match(output, /Release readiness review\s+GPT-5\.6 Mini/);
});

test("paint scheduler coalesces bursts and suppresses identical frames", async () => {
  const state = createState();
  const writes = [];
  const paint = createPaintScheduler(state, { write: (frame) => writes.push(frame) }, (value) => `${value.view}:${value.notice}`);
  paint();
  paint();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1);
  paint();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1);
  state.notice = "changed";
  paint();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 2);
});

test("General Input mode opens a Guide or Next picker and persists the confirmed target mode", () => {
  const adapter = createMockNewmarkAdapter();
  const calls = [];
  const persistInputMode = adapter.setInputMode.bind(adapter);
  adapter.setInputMode = (mode, target) => {
    calls.push([mode, { ...target }]);
    return persistInputMode(mode, target);
  };
  const state = createState({ adapter });
  switchView(state, "settings");
  state.focusRegion = "content";
  state.contentColumn = 1;
  state.settingsTab = "general";
  state.settingsCategoryIndex = 0;
  state.selected = 1;
  assert.equal(state.settings.general.inputBehavior, "Guide");
  assert.equal(state.snapshot.inputMode, "guide");

  toggleSelected(state);
  assert.equal(state.overlay, "settings-choice");
  assert.equal(state.settingChoiceIndex, 0);
  assert.deepEqual(calls, [], "opening the picker must not persist a mode");
  let output = stripAnsi(render(state, 120, 34));
  assert.match(output, /Input mode/);
  assert.match(output, /›\s+Guide/);
  assert.match(output, /\bNext\b/);

  assert.equal(moveSettingChoiceSelection(state, 1), true);
  assert.equal(state.settingChoiceIndex, 1);
  output = stripAnsi(render(state, 120, 34));
  assert.match(output, /›\s+Next/);
  assert.equal(moveSettingChoiceSelection(state, -1), true);
  assert.equal(state.settingChoiceIndex, 0);
  assert.equal(moveSettingChoiceSelection(state, 1), true);
  assert.equal(state.settingChoiceIndex, 1);
  assert.deepEqual(calls, [], "moving within the picker must not persist a mode");

  assert.equal(confirmSettingChoiceSelection(state), true);
  assert.deepEqual(calls, [["next", state.target]]);
  assert.equal(state.overlay, null);
  assert.equal(state.snapshot.inputMode, "next");
  assert.equal(state.settings.general.inputBehavior, "Next");

  const restored = createState({ adapter });
  assert.equal(restored.target.workspaceId, state.target.workspaceId);
  assert.equal(restored.target.conversationId, state.target.conversationId);
  assert.equal(restored.snapshot.inputMode, "next");
  assert.equal(restored.settings.general.inputBehavior, "Next");
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
  assert.doesNotMatch(output, /ROOT/);
  assert.match(output, /OPERATIONS/);
  assert.match(output, /Tools/);
  assert.match(output, /Memory Lab/);
  assert.match(output, /Automations/);
  assert.match(output, /WorkFlow/);
  assert.match(output, /Settings/);
  assert.doesNotMatch(output, /Runtime & services/);
  assert.match(output, /ACTIVE CONVERSATION/);
  state.menuRootIndex = 0;
  activateMenu(state);
  assert.match(stripAnsi(render(state, 100, 34)), /Conversations/);
});

test("all primary views render without undefined output", () => {
  const state = createState();
  for (const view of ["chat", "plan", "goal", "agents", "model", "flowbar", "flowlist", "flowtask", "tools", "memory", "automation", "workflow", "settings", "help"]) {
    switchView(state, view);
    const output = stripAnsi(render(state, 100, 32));
    assert.doesNotMatch(output, /undefined|null/);
    assert.ok(output.length > 200);
  }
});

test("ANSI sequences remain valid across view and terminal size matrix", () => {
  const state = createState();
  for (const [columns, rows] of [[52, 20], [60, 24], [78, 28], [100, 32], [140, 40]]) {
    for (const view of ["chat", "plan", "goal", "agents", "model", "flowbar", "flowlist", "flowtask", "tools", "memory", "automation", "workflow", "settings", "help"]) {
      switchView(state, view);
      const output = render(state, columns, rows);
      assert.equal(stripAnsi(output).includes("\u001b"), false, `${view} at ${columns}x${rows}`);
    }
  }
});
