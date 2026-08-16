"use strict";

const data = require("./data");
const { createMockNewmarkAdapter } = require("./adapters/mock-newmark-adapter");
const { targetKey, validateSnapshot } = require("./adapters/newmark-contract");
const { SETTINGS_CATEGORIES, settingsRows } = require("./settings-schema");
const INTELLIGENCE_TIERS = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]);
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const THEME_APPEARANCE_DEFAULTS = Object.freeze({
  dark: Object.freeze({ fontColor: "#E6EAF2", backgroundColor: "#0A0A1A" }),
  light: Object.freeze({ fontColor: "#1F2937", backgroundColor: "#F0F2F8" })
});

function normalizedTheme(value) {
  return String(value || "dark").trim().toLowerCase() === "light" ? "light" : "dark";
}

function normalizedHexColor(value) {
  const candidate = String(value || "").trim();
  return HEX_COLOR_PATTERN.test(candidate) ? candidate.toUpperCase() : "";
}

function contrastRatio(foreground, background) {
  const luminance = (value) => {
    const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
      .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const foregroundLuminance = luminance(foreground.slice(1));
  const backgroundLuminance = luminance(background.slice(1));
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

/**
 * Resolve persisted appearance without allowing a legacy/mismatched color
 * pair to disable the whole terminal canvas. Explicit colors are retained
 * when readable; otherwise the closest theme-safe pair is used for rendering.
 */
function resolveThemeAppearance(theme, fontColor, backgroundColor) {
  const resolvedTheme = normalizedTheme(theme);
  const defaults = THEME_APPEARANCE_DEFAULTS[resolvedTheme];
  let foreground = normalizedHexColor(fontColor) || defaults.fontColor;
  let background = normalizedHexColor(backgroundColor) || defaults.backgroundColor;
  if (contrastRatio(foreground, background) < 4.5) {
    if (contrastRatio(defaults.fontColor, background) >= 4.5) {
      foreground = defaults.fontColor;
    } else if (contrastRatio(foreground, defaults.backgroundColor) >= 4.5) {
      background = defaults.backgroundColor;
    } else {
      foreground = defaults.fontColor;
      background = defaults.backgroundColor;
    }
  }
  return { theme: resolvedTheme, fontColor: foreground, backgroundColor: background };
}

function applySnapshot(state, snapshot) {
  const valid = validateSnapshot(snapshot);
  state.snapshot = valid;
  state.target = { ...valid.target };
  state.messages = valid.chatMessages.map((item) => ({ ...item }));
  state.expandedBuildRuns = new Set(
    (valid.workRuns || []).filter((run) => run.expanded).map((run) => run.runId)
  );
  if (typeof state.conversationScroll === "number") state.conversationScroll = 0;
  if (typeof state.conversationHistoryFocus === "boolean") state.conversationHistoryFocus = false;
  const row = valid.conversations.find((item) => item.id === valid.target.conversationId);
  state.lastConversation = row?.title || valid.target.conversationId;
  if (state.lastConversationByWorkspace) {
    state.lastConversationByWorkspace[valid.target.workspaceId] = valid.target.conversationId;
  }
  if (state.flowByConversation) {
    const storedFlow = state.flowByConversation[`${valid.target.workspaceId}::${valid.target.conversationId}`];
    const loadedFlow = !storedFlow && valid.flowSelection?.name && typeof state.adapter.readFlow === "function"
      ? state.adapter.readFlow(valid.flowSelection.name)
      : null;
    if (loadedFlow && typeof loadedFlow.then === "function") {
      throw new TypeError("The standalone TUI requires synchronous Flow reads");
    }
    state.currentFlow = storedFlow
      || (loadedFlow ? { ...loadedFlow, pc: valid.flowSelection.pc || 0 } : valid.flowSelection)
      || null;
  }
  if (state.trackingByWorkspace) {
    state.trackingByWorkspace[valid.target.workspaceId] = {
      plan: valid.conversationPlan.items.length > 0,
      goal: !!valid.goal,
      agents: valid.subagents.length > 0,
      flow: !!state.currentFlow
    };
  }
  if (state.runningConversationKeys) {
    state.busy = state.runningConversationKeys.has(targetKey(valid.target));
  }
  return state;
}

function applyThemeAppearance(state, selection) {
  const label = String(selection || "Dark").toLowerCase() === "light"
    ? "Light"
    : String(selection || "Dark").toLowerCase() === "system"
      ? "System"
      : "Dark";
  const appearance = resolveThemeAppearance(label, "", "");
  state.theme = appearance.theme;
  state.settings.personalization.theme = label;
  state.settings.personalization.fontColor = appearance.fontColor;
  state.settings.personalization.backgroundColor = appearance.backgroundColor;
  return {
    theme: label.toLowerCase(),
    fontColor: appearance.fontColor,
    backgroundColor: appearance.backgroundColor
  };
}

function createState(options = {}) {
  const adapter = options.adapter || createMockNewmarkAdapter();
  const target = typeof adapter.getInitialTarget === "function"
    ? adapter.getInitialTarget()
    : { workspaceId: data.workspace.id, conversationId: data.conversations[0].id };
  const snapshot = adapter.getState(target);
  const workspaces = typeof adapter.listWorkspaces === "function"
    ? adapter.listWorkspaces()
    : data.workspaces.map((item) => ({ ...item }));
  if (snapshot && typeof snapshot.then === "function") {
    throw new TypeError("The standalone demo requires a synchronous mock adapter");
  }
  const memoryLab = adapter.memoryLabVisualization();
  if (memoryLab && typeof memoryLab.then === "function") {
    throw new TypeError("The standalone demo requires synchronous mock Memory Lab data");
  }
  const flows = typeof adapter.listFlows === "function" ? adapter.listFlows() : [];
  if (flows && typeof flows.then === "function") {
    throw new TypeError("The standalone TUI requires synchronous Flow inventory");
  }
  const initialWorkflow = snapshot.flowSelection?.name && typeof adapter.readFlow === "function"
    ? adapter.readFlow(snapshot.flowSelection.name)
    : null;
  if (initialWorkflow && typeof initialWorkflow.then === "function") {
    throw new TypeError("The standalone TUI requires synchronous Flow reads");
  }
  const initialFlow = initialWorkflow
    ? { ...initialWorkflow, pc: snapshot.flowSelection.pc || 0 }
    : (snapshot.flowSelection || null);
  const workflowDetails = Object.fromEntries(flows.map((name) => {
    const workflow = typeof adapter.readFlow === "function" ? adapter.readFlow(name) : null;
    if (workflow && typeof workflow.then === "function") {
      throw new TypeError("The standalone TUI requires synchronous workflow inventory reads");
    }
    return [name, workflow || { name, components: [] }];
  }));
  const appearance = resolveThemeAppearance(snapshot.darkMode, snapshot.fontColor, snapshot.backgroundColor);
  return {
    adapter,
    adapterKind: adapter.kind,
    workspaces,
    target,
    snapshot,
    view: "chat",
    selected: 0,
    sidebar: 0,
    focusRegion: "menu",
    contentColumn: 0,
    menuLevel: "root",
    menuRootIndex: 0,
    menuChildIndex: {},
    menuScroll: 0,
    expandedWorkspaceIds: new Set(),
    lastConversationByWorkspace: { [target.workspaceId]: target.conversationId },
    trackingByWorkspace: {
      [target.workspaceId]: {
        plan: snapshot.conversationPlan.items.length > 0,
        goal: !!snapshot.goal,
        agents: snapshot.subagents.length > 0,
        flow: !!initialFlow
      }
    },
    flows: [...flows],
    workflowDetails,
    workflowExpandedName: "",
    agentHistoryExpandedId: "",
    workflowDraft: { name: "", mode: "build", prompt: "" },
    workflowFormIndex: 0,
    flowSelectionIndex: 0,
    flowSelectionScroll: 0,
    conversationListScroll: 0,
    flowByConversation: initialFlow ? { [`${target.workspaceId}::${target.conversationId}`]: initialFlow } : {},
    currentFlow: initialFlow,
    theme: appearance.theme,
    overlay: null,
    settingChoiceTab: "",
    settingChoiceKey: "",
    settingChoiceIndex: 0,
    paletteQuery: "",
    paletteIndex: 0,
    paletteScroll: 0,
    inputMode: false,
    input: "",
    inputCursor: 0,
    conversationScroll: 0,
    conversationMaxScroll: 0,
    contentScroll: 0,
    contentFocusLine: -1,
    conversationHistoryFocus: false,
    historySelectedIndex: -1,
    historySelectedImageIndex: -1,
    historyEventFocus: false,
    historyEventIndex: -1,
    collapsedBuildEvents: new Set(),
    historyVisibleRunIds: [],
    historyCursorDirection: 0,
    expandedBuildRuns: new Set(
      (snapshot.workRuns || []).filter((run) => run.expanded).map((run) => run.runId)
    ),
    lastConversation: snapshot.conversations.find((item) => item.id === target.conversationId)?.title || target.conversationId,
    notice: adapter.kind === "mock"
      ? "Demo mode · no real services connected"
      : `Newmark core connected · ${workspaces.find((item) => item.id === target.workspaceId)?.path || target.workspaceId}`,
    busy: false,
    runningConversationKeys: new Set(),
    sendQueueByConversation: new Map(),
    stopStageByConversation: new Map(),
    tick: 0,
    messages: snapshot.chatMessages.map((item) => ({ ...item })),
    memoryLab,
    memorySearchActive: false,
    memorySearchQuery: "",
    memorySelectedTag: Object.keys(memoryLab.index.tags || {}).sort().find(
      (tag) => (memoryLab.index.tags[tag].components || []).length > 0
    ) || Object.keys(memoryLab.index.tags || {}).sort()[0] || "",
    memoryColumnIndices: [0, 0, 0, 0],
    memoryComponentIndex: 0,
    providers: (snapshot.providers || []).map((provider) => ({
      ...provider,
      models: (provider.models || []).map((model) => ({ ...model }))
    })),
    settingsCategoryIndex: 0,
    settingsTab: "general",
    validationNotice: "",
    tools: snapshot.nativeTools
      ? Object.entries(snapshot.nativeTools).map(([name, enabled]) => ({ name, group: "Native", enabled: !!enabled, calls: 0 }))
      : data.tools.map((item) => ({ ...item })),
    automations: Array.isArray(snapshot.automations)
      ? snapshot.automations.map((item) => ({ ...item, name: item.name || item.prompt || item.id, schedule: item.condition || item.startAt || "Configured", enabled: item.active !== false, last: item.lastStatus || "—" }))
      : data.automations.map((item) => ({ ...item })),
    automationDraft: { prompt: "", condition: "once", intervalSec: "60", conversationMode: "existing" },
    automationFormIndex: 0,
    settings: {
      general: {
        language: { auto: "Auto", en: "English", zh: "中文" }[snapshot.language] || "Auto",
        inputBehavior: snapshot.inputMode === "next" ? "Next" : "Guide",
        dialogStyle: snapshot.dialogStyle === "friendly" ? "Friendly" : "Formal",
        feedbackLevel: { ask_more: "Ask more", ask_less: "Ask less", fully_autonomous: "Autonomous" }[snapshot.feedback] || "Default",
        closeBehavior: snapshot.closeBehavior === "minimize" ? "Minimize to tray" : "Close app",
        expandTools: snapshot.expandToolsDefault !== false,
        remoteTouch: snapshot.remoteTouchEnabled !== false
      },
      personalization: {
        theme: { light: "Light", system: "System", dark: "Dark" }[String(snapshot.darkMode || "dark").toLowerCase()] || "Dark",
        fontFamily: snapshot.fontFamily || "Terminal default",
        fontColor: appearance.fontColor,
        backgroundColor: appearance.backgroundColor,
        glassAlpha: Number(snapshot.glassAlpha || 0.85)
      },
      runtime: {
        backend: snapshot.configuredAgentBackend === "wsl" ? "WSL" : "Windows native",
        wslDistro: snapshot.wslDistro || "Ubuntu-24.04",
        terminalTimeout: Number(snapshot.terminalInterruptTimeoutMs || 0),
        defaultShell: { powershell: "PowerShell", cmd: "Command Prompt", wsl: "WSL Bash", bash: "WSL Bash" }[snapshot.defaultTerminalShell] || "PowerShell"
      },
      archive: {
        autoArchive: true,
        retentionDays: 90,
        includeMemory: true,
        exportFormat: "ZIP"
      },
      updates: {
        channel: "Prerelease",
        autoCheck: true,
        autoDownload: false,
        source: "GitHub"
      }
    }
  };
}

function itemCount(state) {
  const modelCount = state.providers.reduce((total, provider) => total + provider.models.length, 0);
  const counts = {
    home: 3,
    chat: state.inputMode ? 1 : state.snapshot.conversations.length,
    plan: state.snapshot.conversationPlan.items.length,
    goal: state.snapshot.goal ? 1 : 0,
    agents: state.snapshot.subagents.length,
    model: state.contentColumn === 0 ? INTELLIGENCE_TIERS.length : conversationModelOptions(state).length,
    flowbar: state.currentFlow ? 1 : 0,
    flowlist: state.flows.length,
    flowtask: state.currentFlow?.components?.length || 0,
    tools: state.tools.length,
    memory: memoryColumnItems(state, state.contentColumn).length,
    automation: state.automations.length + 1,
    workflow: state.flows.length + 1,
    settings: state.contentColumn === 0
      ? SETTINGS_CATEGORIES.length
      : state.settingsTab === "providers"
        ? state.providers.length
        : state.settingsTab === "models"
          ? modelCount
          : state.settingsTab === "tools"
            ? state.tools.length
            : settingsRows(state).length
  };
  return counts[state.view] || 1;
}

function moveSelection(state, delta) {
  const count = Math.max(1, itemCount(state));
  if (state.view === "memory") {
    const column = Math.min(3, Math.max(0, state.contentColumn));
    const current = state.memoryColumnIndices[column] || 0;
    state.memoryColumnIndices[column] = (current + delta + count) % count;
    if (column === 3) state.memoryComponentIndex = state.memoryColumnIndices[column];
    return;
  }
  if (state.view === "settings" && state.contentColumn === 0) {
    state.settingsCategoryIndex = (state.settingsCategoryIndex + delta + count) % count;
    state.settingsTab = SETTINGS_CATEGORIES[state.settingsCategoryIndex].id;
    state.selected = 0;
    state.notice = `Settings / ${state.settingsTab}`;
    return;
  }
  state.selected = (state.selected + delta + count) % count;
}

function contentColumnCount(state) {
  if (state.view === "memory") return 4;
  if (state.view === "settings") return 2;
  if (state.view === "model") return 2;
  return 1;
}

function moveFocusHorizontal(state, direction) {
  if (state.focusRegion === "menu") {
    if (direction > 0) {
      state.focusRegion = "content";
      state.contentColumn = 0;
      state.notice = "Content focus · column 1";
    }
    return;
  }
  if (direction < 0) {
    if (state.contentColumn > 0) {
      state.contentColumn -= 1;
      if (state.view === "model") state.selected = Math.max(0, INTELLIGENCE_TIERS.indexOf(state.snapshot.intelligence || "medium"));
      state.notice = `Content focus · column ${state.contentColumn + 1}`;
    } else {
      state.focusRegion = "menu";
      state.notice = "Menu focus";
    }
    return;
  }
  const lastColumn = contentColumnCount(state) - 1;
  if (state.contentColumn < lastColumn) {
    state.contentColumn += 1;
    if (state.view === "model") {
      const current = state.snapshot.modelSelection || { kind: "auto" };
      state.selected = Math.max(0, conversationModelOptions(state).findIndex((option) => option.selection.kind === current.kind
        && (current.kind === "auto" || (option.selection.providerId === current.providerId && option.selection.modelId === current.modelId))));
    }
    state.notice = `Content focus · column ${state.contentColumn + 1}`;
  }
}

function rootMenuItems(state) {
  return [
    ...state.workspaces.map((workspace) => ({ type: "workspace", id: workspace.id, label: workspace.name })),
    ...data.navigation
      .filter((item) => item.section === "operations")
      .map((item) => ({ type: "view", id: item.id, label: item.label }))
  ];
}

function workspaceIdFromLevel(level) {
  return String(level || "").startsWith("workspace:") ? String(level).slice("workspace:".length) : "";
}

function workspaceMenuChildren(state, workspaceId) {
  const tracking = workspaceId === state.target.workspaceId
    ? {
        plan: state.snapshot.conversationPlan.items.length > 0,
        goal: !!state.snapshot.goal,
        agents: state.snapshot.subagents.length > 0,
        flow: !!state.currentFlow
      }
    : (state.trackingByWorkspace?.[workspaceId] || {});
  return data.navigation.filter((item) => {
    if (item.section !== "workspace") return false;
    if (item.id === "chat" || item.id === "model") return true;
    if (item.id === "plan") return !!tracking.plan;
    if (item.id === "goal") return !!tracking.goal;
    if (item.id === "agents") return !!tracking.agents;
    if (item.id === "flowbar" || item.id === "flowlist" || item.id === "flowtask") return !!tracking.flow;
    return false;
  });
}

function menuChildren(state, level) {
  const workspaceId = workspaceIdFromLevel(level);
  return workspaceId ? workspaceMenuChildren(state, workspaceId) : [];
}

function rootItemExpanded(state, item) {
  if (item?.type === "workspace") return state.expandedWorkspaceIds.has(item.id);
  return false;
}

function childLevelForRootItem(item) {
  if (item?.type === "workspace") return `workspace:${item.id}`;
  return "";
}

function moveMenuSelection(state, delta) {
  const rootItems = rootMenuItems(state);
  if (state.menuLevel === "root") {
    const current = rootItems[state.menuRootIndex];
    if (delta > 0 && rootItemExpanded(state, current)) {
      const level = childLevelForRootItem(current);
      state.menuLevel = level;
      state.menuChildIndex[level] = 0;
      return;
    }
    const nextRoot = (state.menuRootIndex + delta + rootItems.length) % rootItems.length;
    const nextItem = rootItems[nextRoot];
    state.menuRootIndex = nextRoot;
    if (delta < 0 && rootItemExpanded(state, nextItem)) {
      const level = childLevelForRootItem(nextItem);
      const children = menuChildren(state, level);
      state.menuLevel = level;
      state.menuChildIndex[level] = Math.max(0, children.length - 1);
    }
    return;
  }
  const children = menuChildren(state, state.menuLevel);
  const current = state.menuChildIndex[state.menuLevel] || 0;
  if (delta > 0 && current < children.length - 1) {
    state.menuChildIndex[state.menuLevel] = current + 1;
    return;
  }
  if (delta < 0 && current > 0) {
    state.menuChildIndex[state.menuLevel] = current - 1;
    return;
  }
  const workspaceId = workspaceIdFromLevel(state.menuLevel);
  const parentIndex = rootItems.findIndex((item) => item.type === "workspace" && item.id === workspaceId);
  state.menuLevel = "root";
  state.menuRootIndex = delta > 0
    ? (parentIndex + 1) % rootItems.length
    : parentIndex;
}

function moveMenuLevel(state, direction) {
  if (direction > 0 && state.menuLevel === "root") {
    const item = rootMenuItems(state)[state.menuRootIndex];
    if (item?.type === "workspace" && state.expandedWorkspaceIds.has(item.id)) {
      state.menuLevel = `workspace:${item.id}`;
      state.menuChildIndex[state.menuLevel] ??= 0;
    }
  } else if (direction < 0 && state.menuLevel !== "root") {
    const workspaceId = workspaceIdFromLevel(state.menuLevel);
    const rootItems = rootMenuItems(state);
    state.menuRootIndex = rootItems.findIndex((item) => item.type === "workspace" && item.id === workspaceId);
    state.menuLevel = "root";
  }
}

function activateWorkspace(state, workspaceId) {
  if (typeof state.adapter.selectWorkspace === "function") {
    const selected = state.adapter.selectWorkspace(workspaceId);
    if (selected && typeof selected.then === "function") {
      throw new TypeError("Standalone workspace selection requires a synchronous adapter");
    }
    applySnapshot(state, selected);
    return true;
  }
  const conversations = data.workspaceConversations[workspaceId] || [];
  const rememberedId = state.lastConversationByWorkspace[workspaceId];
  const conversationId = conversations.some((item) => item.id === rememberedId)
    ? rememberedId
    : conversations[0]?.id;
  if (!conversationId) return false;
  const snapshot = state.adapter.getState({ workspaceId, conversationId });
  if (snapshot && typeof snapshot.then === "function") {
    throw new TypeError("Async adapters must await getState() before applySnapshot()");
  }
  applySnapshot(state, snapshot);
  return true;
}

function activateMenu(state) {
  if (state.menuLevel === "root") {
    const item = rootMenuItems(state)[state.menuRootIndex];
    if (item?.type === "view") {
      switchView(state, item.id);
      state.focusRegion = "content";
      state.contentColumn = 0;
      return item.id;
    }
    if (item?.type === "workspace") {
      if (state.expandedWorkspaceIds.has(item.id)) {
        state.expandedWorkspaceIds.delete(item.id);
        state.notice = `Collapsed workspace: ${item.label}`;
      } else {
        state.expandedWorkspaceIds.add(item.id);
        state.notice = `Expanded workspace: ${item.label}`;
      }
      return item.id;
    }
    return null;
  }
  const children = menuChildren(state, state.menuLevel);
  const item = children[state.menuChildIndex[state.menuLevel] || 0];
  if (!item) return null;
  const workspaceId = workspaceIdFromLevel(state.menuLevel);
  if (workspaceId && workspaceId !== state.target.workspaceId) activateWorkspace(state, workspaceId);
  switchView(state, item.id);
  state.focusRegion = "content";
  state.contentColumn = 0;
  return item.id;
}

function syncMenuToView(state, id) {
  const item = data.navigation.find((entry) => entry.id === id);
  if (!item || item.section === "root") {
    state.menuLevel = "root";
    state.menuRootIndex = 0;
    return;
  }
  if (item.section === "workspace") {
    const level = `workspace:${state.target.workspaceId}`;
    state.expandedWorkspaceIds.add(state.target.workspaceId);
    state.menuLevel = level;
    state.menuRootIndex = rootMenuItems(state).findIndex((entry) => entry.id === state.target.workspaceId);
    state.menuChildIndex[level] = menuChildren(state, level).findIndex((entry) => entry.id === id);
  } else {
    state.menuLevel = "root";
    state.menuRootIndex = rootMenuItems(state).findIndex((entry) => entry.type === "view" && entry.id === id);
  }
}

function switchView(state, id) {
  state.view = id;
  state.sidebar = Math.max(0, data.navigation.findIndex((item) => item.id === id));
  syncMenuToView(state, id);
  state.selected = 0;
  state.contentColumn = 0;
  state.inputMode = false;
  state.input = "";
  state.inputCursor = 0;
  if (id === "chat") state.conversationScroll = 0;
  state.contentScroll = 0;
  state.contentFocusLine = -1;
}

function normalizedAutomation(item) {
  return {
    ...item,
    name: item.name || item.prompt || item.id,
    schedule: item.condition || item.startAt || "Configured",
    enabled: item.active !== false,
    last: item.lastStatus || item.lastRunAt || "—"
  };
}

function beginAutomationCreate(state) {
  state.automationDraft = {
    prompt: "",
    condition: "once",
    intervalSec: "60",
    conversationMode: "existing"
  };
  state.automationFormIndex = 0;
  state.overlay = "automation-create";
  state.notice = "New automation · complete the form and choose Create";
  return true;
}

function createAutomationFromDraft(state) {
  const prompt = String(state.automationDraft?.prompt || "").trim();
  if (!prompt) throw new Error("Automation prompt is required");
  const condition = ["once", "loop", "schedule"].includes(state.automationDraft.condition)
    ? state.automationDraft.condition
    : "once";
  const conversationMode = state.automationDraft.conversationMode === "new" ? "new" : "existing";
  const workspace = state.workspaces.find((item) => item.id === state.target.workspaceId);
  const payload = {
    prompt,
    model: "",
    workspaceId: state.target.workspaceId,
    workspaceName: workspace?.name || state.target.workspaceId,
    conversationMode,
    conversationId: conversationMode === "existing" ? state.target.conversationId : "",
    condition,
    intervalSec: condition === "once" ? 0 : Math.max(1, Number(state.automationDraft.intervalSec) || 60),
    active: true
  };
  const result = state.adapter.createAutomation(payload);
  const apply = (created) => {
    if (!created || created.error) throw new Error(created?.error || "Automation creation failed");
    const row = normalizedAutomation(created);
    state.automations = [row, ...state.automations.filter((item) => item.id !== row.id)];
    state.selected = 1;
    state.overlay = null;
    state.notice = `Automation created: ${row.name} · ${state.adapterKind === "mock" ? "demo" : "persisted"}`;
    return created;
  };
  return result && typeof result.then === "function" ? result.then(apply) : apply(result);
}

function beginWorkflowCreate(state) {
  state.workflowDraft = { name: "", mode: "build", prompt: "" };
  state.workflowFormIndex = 0;
  state.overlay = "workflow-create";
  state.notice = "New workflow · define its first dialog component";
  return true;
}

function saveWorkflowFromDraft(state) {
  const name = String(state.workflowDraft?.name || "").trim();
  const prompt = String(state.workflowDraft?.prompt || "").trim();
  if (!name || name !== name.replace(/[<>:"/\\|?*]/g, "") || name === "." || name === "..") {
    throw new Error("A valid workflow name is required");
  }
  if (!prompt) throw new Error("The first workflow prompt is required");
  const mode = ["build", "plan", "goal"].includes(state.workflowDraft.mode)
    ? state.workflowDraft.mode
    : "build";
  const workflow = {
    name,
    components: [{ type: "dialog", id: 0, mode, prompt }]
  };
  const result = state.adapter.saveFlow(workflow);
  const apply = (savedResult) => {
    const saved = savedResult?.workflow || savedResult || workflow;
    if (savedResult?.error) throw new Error(savedResult.error);
    state.workflowDetails[name] = JSON.parse(JSON.stringify(saved));
    state.flows = [...new Set([...state.flows, name])].sort();
    state.selected = state.flows.indexOf(name) + 1;
    state.workflowExpandedName = name;
    state.overlay = null;
    state.notice = `WorkFlow created: ${name} · ${state.adapterKind === "mock" ? "demo" : "persisted"}`;
    return saved;
  };
  return result && typeof result.then === "function" ? result.then(apply) : apply(result);
}

function toggleWorkflowDetails(state) {
  const name = state.flows[state.selected - 1];
  if (!name) return false;
  state.workflowExpandedName = state.workflowExpandedName === name ? "" : name;
  state.notice = state.workflowExpandedName ? `WorkFlow details: ${name}` : `WorkFlow details collapsed: ${name}`;
  return true;
}

function toggleAgentHistory(state) {
  const agent = state.snapshot.subagents[state.selected];
  if (!agent) return false;
  const id = String(agent.id || agent.displayName || "");
  if (!id) return false;
  state.agentHistoryExpandedId = state.agentHistoryExpandedId === id ? "" : id;
  state.notice = state.agentHistoryExpandedId
    ? `${agent.displayName} history · latest at the bottom`
    : `${agent.displayName} history collapsed`;
  return true;
}

function enterConversation(state, index = state.selected) {
  const conversation = state.snapshot.conversations[index];
  if (!conversation) return false;
  const target = { workspaceId: state.target.workspaceId, conversationId: conversation.id };
  const snapshot = state.adapter.activateConversation(target);
  if (snapshot && typeof snapshot.then === "function") {
    throw new TypeError("Async adapters must await activateConversation() before applySnapshot()");
  }
  applySnapshot(state, snapshot);
  state.selected = index;
  state.inputMode = true;
  state.inputCursor = [...state.input].length;
  state.conversationScroll = 0;
  state.notice = `Entered conversation: ${conversation.title}`;
  return true;
}

function returnToConversationSelection(state) {
  if (state.view !== "chat" || !state.inputMode) return false;
  state.inputMode = false;
  state.notice = "Conversation selection · draft preserved";
  return true;
}

function scrollConversation(state, direction) {
  const maximum = Math.max(0, Number(state.conversationMaxScroll) || 0);
  state.conversationScroll = Math.max(0, Math.min(maximum, (Number(state.conversationScroll) || 0) + direction));
  state.notice = state.conversationScroll > 0
    ? `Conversation history · ${state.conversationScroll} row(s) above latest`
    : "Conversation history · latest messages";
  return state.conversationScroll;
}

function inputCharacterWidth(character) {
  const code = character.codePointAt(0) || 0;
  if (code === 0 || code < 0x20 || (code >= 0x7f && code < 0xa0) || /\p{Mark}|\u200d|\ufe0e|\ufe0f/u.test(character)) return 0;
  return code >= 0x1100 && (
    code <= 0x115f ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) ? 2 : 1;
}

function inputVisualLines(value, width) {
  const characters = [...String(value || "")];
  const limit = Math.max(1, Number(width) || 1);
  const rows = [];
  let start = 0;
  let columns = 0;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character === "\n") {
      rows.push({ start, end: index });
      start = index + 1;
      columns = 0;
      continue;
    }
    const nextWidth = inputCharacterWidth(character);
    if (index > start && columns + nextWidth > limit) {
      rows.push({ start, end: index });
      start = index;
      columns = 0;
    }
    columns += nextWidth;
  }
  rows.push({ start, end: characters.length });
  return { characters, rows };
}

function moveInputCursorVertical(state, direction) {
  const layout = inputVisualLines(state.input, state.inputWrapWidth || 72);
  const { characters, rows } = layout;
  const cursor = Math.max(0, Math.min(characters.length, Number(state.inputCursor) || 0));
  let rowIndex = 0;
  for (let index = 0; index < rows.length; index += 1) {
    if (cursor >= rows[index].start && cursor <= rows[index].end) rowIndex = index;
  }
  const row = rows[rowIndex];
  const column = characters.slice(row.start, cursor).reduce((total, character) => total + inputCharacterWidth(character), 0);
  const targetIndex = rowIndex + (direction < 0 ? -1 : 1);
  if (targetIndex >= 0 && targetIndex < rows.length) {
    const target = rows[targetIndex];
    let nextCursor = target.start;
    let nextColumn = 0;
    while (nextCursor < target.end) {
      const nextWidth = inputCharacterWidth(characters[nextCursor]);
      if (nextColumn + nextWidth > column) break;
      nextColumn += nextWidth;
      nextCursor += 1;
    }
    state.inputCursor = nextCursor;
    return "cursor";
  }
  if (direction < 0) {
    const runs = [...(state.snapshot.workRuns || [])].sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
    if (runs.length) {
      state.conversationHistoryFocus = true;
      state.historySelectedIndex = runs.length - 1;
      state.historySelectedImageIndex = -1;
      state.historyCursorDirection = -1;
      state.notice = `History focus · Build Block ${runs.length} · Enter expands`;
      return "history-focus";
    }
  }
  scrollConversation(state, direction < 0 ? 1 : -1);
  return "history";
}

function moveConversationHistoryCursor(state, direction) {
  const runs = [...(state.snapshot.workRuns || [])].sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  if (!state.conversationHistoryFocus || !runs.length) return "input";
  const current = Math.max(0, Math.min(runs.length - 1, Number(state.historySelectedIndex) || 0));
  const images = displayImagesForRun(runs[current]);
  const imageIndex = Number.isInteger(state.historySelectedImageIndex) ? state.historySelectedImageIndex : -1;
  if (direction < 0) {
    if (imageIndex >= 0) {
      state.historySelectedImageIndex = imageIndex - 1;
      state.notice = state.historySelectedImageIndex >= 0 ? `History focus · 示意图 ${state.historySelectedImageIndex + 1} · Enter opens` : `History focus · Build Block ${current + 1} · Enter expands`;
      return "history";
    }
    state.historySelectedIndex = Math.max(0, current - 1);
    state.historySelectedImageIndex = current > 0 ? displayImagesForRun(runs[current - 1]).length - 1 : -1;
    state.historyCursorDirection = -1;
    state.notice = `History focus · Build Block ${state.historySelectedIndex + 1} · Enter expands`;
    return "history";
  }
  if (imageIndex < images.length - 1) {
    state.historySelectedImageIndex = imageIndex + 1;
    state.notice = `History focus · 示意图 ${state.historySelectedImageIndex + 1} · Enter opens`;
    return "history";
  }
  if (current < runs.length - 1) {
    const next = current + 1;
    const nextRunId = runs[next]?.runId;
    if (state.historyVisibleRunIds.includes(nextRunId)) {
      state.historySelectedIndex = next;
      state.historySelectedImageIndex = -1;
      state.historyCursorDirection = 1;
      state.notice = `History focus · Build Block ${next + 1} · Enter expands`;
      return "history";
    }
  }
  state.conversationHistoryFocus = false;
  state.historySelectedImageIndex = -1;
  state.historyCursorDirection = 0;
  state.inputCursor = [...state.input].length;
  state.notice = "Input focus · Down at the final input row scrolls toward newer history";
  return "input";
}

function toggleSelectedBuildBlock(state) {
  if (!state.conversationHistoryFocus) return false;
  const runs = [...(state.snapshot.workRuns || [])].sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  const run = runs[state.historySelectedIndex];
  if (!run) return false;
  const selectedImage = displayImagesForRun(run)[state.historySelectedImageIndex];
  if (selectedImage) {
    state.notice = `Opening 示意图 · ${selectedImage.caption || selectedImage.name || ''}`;
    return state.adapter.openImageViewer(selectedImage);
  }
  const prior = state.expandedBuildRuns.has(run.runId);
  const expanded = !prior;
  if (expanded) state.expandedBuildRuns.add(run.runId);
  else state.expandedBuildRuns.delete(run.runId);
  run.expanded = expanded;
  state.notice = `${expanded ? "Expanded" : "Collapsed"} Build Block ${state.historySelectedIndex + 1}`;
  if (typeof state.adapter?.setWorkRunExpanded !== "function") return true;
  const rollback = (error) => {
    if (prior) state.expandedBuildRuns.add(run.runId);
    else state.expandedBuildRuns.delete(run.runId);
    run.expanded = prior;
    state.notice = `Build Block display update failed${error?.message ? `: ${error.message}` : ""}`;
    if (error) throw error;
    return false;
  };
  try {
    const result = state.adapter.setWorkRunExpanded(run.runId, expanded, state.target);
    if (result && typeof result.then === "function") {
      return result.then((saved) => saved === false ? rollback() : true).catch(rollback);
    }
    return result === false ? rollback() : true;
  } catch (error) {
    return rollback(error);
  }
}

function markConversationRunning(state, target, running) {
  const key = targetKey(target);
  if (running) state.runningConversationKeys.add(key);
  else {
    state.runningConversationKeys.delete(key);
    state.stopStageByConversation?.delete(key);
  }
  state.busy = state.runningConversationKeys.has(targetKey(state.target));
  return running;
}

async function requestConversationStop(state) {
  const key = targetKey(state.target);
  if (!state.runningConversationKeys.has(key) || typeof state.adapter.stopConversation !== "function") {
    state.notice = "The focused conversation is not running";
    return "not-running";
  }
  const force = state.stopStageByConversation.get(key) === "graceful";
  const result = await state.adapter.stopConversation({ ...state.target }, force);
  const action = force ? "force" : "graceful";
  state.stopStageByConversation.set(key, action);
  state.notice = force
    ? `Force-stop requested for ${state.lastConversation}`
    : `Stop requested for ${state.lastConversation} · Esc again to force-stop`;
  return String(result?.action || action) === "force" ? "force" : action;
}

function applyConversationResult(state, target, snapshot) {
  markConversationRunning(state, target, false);
  if (targetKey(target) !== targetKey(state.target)) {
    state.notice = `Background conversation completed: ${target.conversationId}`;
    return false;
  }
  applySnapshot(state, snapshot);
  state.notice = "Newmark Agent response complete · state persisted";
  return true;
}

function cycleConversationMode(state) {
  const modes = ["build", "plan", "goal", "flow"];
  const current = modes.includes(state.snapshot.mode) ? state.snapshot.mode : "build";
  const next = modes[(modes.indexOf(current) + 1) % modes.length];
  if (next === "flow") {
    state.flowSelectionIndex = Math.min(state.flowSelectionIndex || 0, Math.max(0, state.flows.length - 1));
    state.overlay = "flow-select";
    state.inputMode = false;
    state.notice = state.flows.length
      ? "Flow mode requires a workflow · ↑↓ select · Enter confirm"
      : "Flow mode requires a workflow, but no workflows are configured";
    return next;
  }
  if (typeof state.adapter.setConversationMode !== "function") return current;
  const snapshot = state.adapter.setConversationMode(next, state.target);
  if (snapshot && typeof snapshot.then === "function") {
    throw new TypeError("Async adapters must await setConversationMode() before applySnapshot()");
  }
  applySnapshot(state, snapshot);
  state.inputMode = true;
  state.notice = `${next[0].toUpperCase()}${next.slice(1)} mode · Shift+Tab switches mode`;
  return next;
}

function selectFlowWorkflow(state, index = state.flowSelectionIndex) {
  const name = state.flows[index];
  if (!name || typeof state.adapter.selectConversationFlow !== "function") return false;
  const result = state.adapter.selectConversationFlow(name, state.target);
  if (result && typeof result.then === "function") {
    throw new TypeError("Async adapters must await selectConversationFlow() before applySnapshot()");
  }
  const snapshot = result?.snapshot || result;
  const workflow = result?.workflow || snapshot?.flowSelection;
  applySnapshot(state, snapshot);
  state.currentFlow = workflow ? JSON.parse(JSON.stringify(workflow)) : { name, components: [] };
  state.flowByConversation[`${state.target.workspaceId}::${state.target.conversationId}`] = state.currentFlow;
  state.trackingByWorkspace[state.target.workspaceId].flow = true;
  state.flowSelectionIndex = index;
  state.overlay = null;
  state.inputMode = true;
  state.notice = `Flow mode · ${name} selected for ${state.lastConversation}`;
  return true;
}

function conversationModelOptions(state) {
  return [
    {
      selection: { kind: "auto" },
      label: "Auto",
      provider: "Newmark router",
      description: "Choose the best enabled deployment for each turn."
    },
    ...state.providers.flatMap((provider) => {
      if (provider.enabled === false) return [];
      return (provider.models || [])
        .filter((model) => model.enabled !== false)
        .map((model) => ({
          selection: {
            kind: "deployment",
            providerId: provider.id,
            modelId: model.name
          },
          label: model.display || model.name,
          provider: provider.name || provider.id,
          description: model.description || `${provider.name || provider.id} / ${model.name}`
        }));
    })
  ];
}

function selectConversationModel(state, index = state.selected) {
  const option = conversationModelOptions(state)[index];
  if (!option || typeof state.adapter.setConversationModel !== "function") return false;
  const snapshot = state.adapter.setConversationModel(option.selection, state.target);
  if (snapshot && typeof snapshot.then === "function") {
    throw new TypeError("Async adapters must await setConversationModel() before applySnapshot()");
  }
  applySnapshot(state, snapshot);
  state.selected = index;
  state.notice = `${option.label} selected for ${state.lastConversation} · Plan and Subagents inherit this conversation model`;
  return true;
}

function selectIntelligenceTier(state, index = state.selected) {
  const tier = INTELLIGENCE_TIERS[index];
  if (!tier || typeof state.adapter.setIntelligence !== "function") return false;
  const snapshot = state.adapter.setIntelligence(tier, state.target);
  if (snapshot && typeof snapshot.then === "function") {
    throw new TypeError("Async adapters must await setIntelligence() before applySnapshot()");
  }
  applySnapshot(state, snapshot);
  state.selected = index;
  state.notice = `Reasoning effort ${tier} · shared with GUI and future model requests`;
  return true;
}

function toggleConversationPinned(state, index = state.selected) {
  if (state.view !== "chat" || state.inputMode) return false;
  const conversation = state.snapshot.conversations[index];
  if (!conversation || typeof state.adapter.setConversationPinned !== "function") return false;
  const snapshot = state.adapter.setConversationPinned(conversation.id, !conversation.pinned, state.target);
  if (snapshot && typeof snapshot.then === "function") {
    throw new TypeError("Async adapters must await setConversationPinned() before applySnapshot()");
  }
  applySnapshot(state, snapshot);
  state.selected = Math.max(0, state.snapshot.conversations.findIndex((item) => item.id === conversation.id));
  state.notice = `${conversation.title} ${conversation.pinned ? "unpinned" : "pinned"} · selection followed the conversation`;
  return true;
}

function toggleSelected(state) {
  if (state.view === "tools") {
    const tool = state.tools[state.selected];
    if (!tool) return;
    tool.enabled = !tool.enabled;
    if (state.adapterKind !== "mock") {
      state.adapter.saveConfig({ nativeTools: Object.fromEntries(state.tools.map((item) => [item.name, item.enabled])) });
    }
    state.notice = `${tool.name} ${tool.enabled ? "enabled" : "disabled"} · ${state.adapterKind === "mock" ? "demo only" : "persisted"}`;
  } else if (state.view === "automation") {
    const job = state.automations[state.selected - 1];
    if (!job) return;
    if (state.adapterKind !== "mock" && typeof state.adapter.toggleAutomation === "function") {
      const result = state.adapter.toggleAutomation(job.id);
      if (result && typeof result.then === "function") throw new TypeError("Standalone automation adapter must be synchronous");
      if (!result) return;
      job.enabled = result.active !== false;
      job.status = result.status;
      state.notice = `${job.name} ${job.enabled ? "enabled" : "paused"} · persisted`;
    } else {
      job.enabled = !job.enabled;
      state.notice = `${job.name} ${job.enabled ? "enabled" : "paused"} · demo only`;
    }
  } else if (state.view === "settings") {
    if (state.settingsTab === "providers") {
      const provider = state.providers[state.selected];
      if (!provider) return;
      const result = state.adapter.setProviderEnabled(provider.id, !provider.enabled);
      if (result && typeof result.then === "function") throw new TypeError("Demo provider adapter must be synchronous");
      if (result.ok) {
        state.providers = result.providers;
        state.notice = `${provider.name} ${result.enabled ? "enabled" : "disabled"} · ${state.adapterKind === "mock" ? "mock" : "persisted"}`;
      }
      return;
    }
    if (state.settingsTab === "models") {
      const models = state.providers.flatMap((provider) => provider.models.map((model) => ({ provider, model })));
      const entry = models[state.selected];
      if (!entry) return;
      entry.model.enabled = entry.model.enabled === false;
      state.adapter.saveConfig({ providers: state.providers });
      state.notice = `${entry.model.display || entry.model.name} ${entry.model.enabled ? "enabled" : "disabled"} · ${state.adapterKind === "mock" ? "mock" : "persisted"}`;
      return;
    }
    if (state.settingsTab === "tools") {
      const tool = state.tools[state.selected];
      if (!tool) return;
      tool.enabled = !tool.enabled;
      const nativeTools = Object.fromEntries(state.tools.map((item) => [item.name, item.enabled]));
      state.adapter.saveConfig({ nativeTools });
      state.notice = `${tool.name} ${tool.enabled ? "enabled" : "disabled"} · ${state.adapterKind === "mock" ? "mock settings" : "persisted"}`;
      return;
    }
    const row = settingsRows(state)[state.selected];
    if (!row) return;
    if (row.action === "pair-mobile") {
      state.overlay = "pair";
      state.pairingQrLines = ["Loading pairing QR…"];
      state.pairingUrl = "";
      state.pairingTokenFile = "";
      if (typeof state.adapter.pairingQr !== "function") {
        state.pairingQrLines = ["Pairing QR is unavailable in this adapter."];
        return false;
      }
      return Promise.resolve(state.adapter.pairingQr()).then((pairing) => {
        state.pairingQrLines = String(pairing?.ascii || "").split(/\r?\n/);
        state.pairingUrl = String(pairing?.url || "");
        state.pairingTokenFile = String(pairing?.tokenFile || "");
        return true;
      }).catch((error) => {
        state.pairingQrLines = [`Pairing failed: ${error?.message || error}`];
        return false;
      });
    }
    if (state.settingsTab === "general" && row.key === "inputBehavior") {
      const current = row.choices.findIndex((value) => value === row.value);
      state.settingChoiceTab = state.settingsTab;
      state.settingChoiceKey = row.key;
      state.settingChoiceIndex = current >= 0 ? current : 0;
      state.overlay = "settings-choice";
      state.notice = "Choose the default Enter mode · Guide or Next";
      return true;
    }
    const current = row.choices.findIndex((value) => value === row.value);
    const next = row.choices[(current + 1 + row.choices.length) % row.choices.length];
    state.settings[state.settingsTab][row.key] = next;
    persistSetting(state, row, next);
    if (state.settingsTab === "personalization" && row.key === "theme") {
      const appearance = applyThemeAppearance(state, next);
      state.adapter.saveConfig(appearance);
    }
    state.notice = `${row.label}: ${formatSettingNotice(next)} · ${state.adapterKind === "mock" ? "mock" : "persisted"}`;
  }
}

function selectedSettingChoiceRow(state) {
  if (state.overlay !== "settings-choice" || !state.settingChoiceKey) return null;
  return settingsRows(state, state.settingChoiceTab)
    .find((row) => row.key === state.settingChoiceKey) || null;
}

function moveSettingChoiceSelection(state, delta) {
  const row = selectedSettingChoiceRow(state);
  if (!row?.choices?.length) return false;
  state.settingChoiceIndex = (
    Number(state.settingChoiceIndex || 0) + delta + row.choices.length
  ) % row.choices.length;
  return true;
}

function confirmSettingChoiceSelection(state) {
  const row = selectedSettingChoiceRow(state);
  if (!row?.choices?.length) return false;
  const index = Math.max(0, Math.min(row.choices.length - 1, Number(state.settingChoiceIndex) || 0));
  const value = row.choices[index];
  const apply = () => {
    state.settings[state.settingChoiceTab][row.key] = value;
    if (row.key === "inputBehavior") {
      state.snapshot.inputMode = serializedSettingValue(row, value);
    }
    state.overlay = null;
    state.settingChoiceTab = "";
    state.settingChoiceKey = "";
    state.settingChoiceIndex = 0;
    state.notice = `${row.label}: ${formatSettingNotice(value)} · ${state.adapterKind === "mock" ? "mock persisted" : "persisted"}`;
    return true;
  };
  const fail = (error) => {
    state.notice = `${row.label} update failed: ${error.message}`;
    throw error;
  };
  try {
    const result = persistSetting(state, row, value);
    if (result && typeof result.then === "function") return result.then(apply).catch(fail);
    if (result === false) throw new Error("Newmark rejected the setting");
    return apply();
  } catch (error) {
    return fail(error);
  }
}

function cycleSettingsTab(state, delta) {
  const tabs = SETTINGS_CATEGORIES.map((item) => item.id);
  const index = tabs.indexOf(state.settingsTab);
  state.settingsTab = tabs[(index + delta + tabs.length) % tabs.length];
  state.settingsCategoryIndex = tabs.indexOf(state.settingsTab);
  state.selected = 0;
  state.notice = `Settings / ${state.settingsTab}`;
}

function formatSettingNotice(value) {
  if (typeof value === "boolean") return value ? "On" : "Off";
  return String(value);
}

function serializedSettingValue(row, value) {
  if (row.key === "language") return { Auto: "auto", English: "en", "中文": "zh" }[value];
  if (row.key === "inputBehavior") return String(value).toLowerCase();
  if (row.key === "dialogStyle") return String(value).toLowerCase();
  if (row.key === "feedbackLevel") return value === "Autonomous" ? "fully_autonomous" : String(value).toLowerCase().replaceAll(" ", "_");
  if (row.key === "closeBehavior") return value === "Minimize to tray" ? "minimize" : "exit";
  if (row.key === "theme") return String(value).toLowerCase();
  if (row.key === "fontFamily") return value === "Terminal default" ? "" : value;
  if (row.key === "backend") return value === "WSL";
  if (row.key === "defaultShell") return { PowerShell: "powershell", "Command Prompt": "cmd", "WSL Bash": "bash" }[value];
  if (row.key === "channel" || row.key === "source" || row.key === "exportFormat") return String(value).toLowerCase().replaceAll(" ", "_");
  return value;
}

function persistSetting(state, row, value) {
  const [kind, first, second] = row.save;
  const serialized = serializedSettingValue(row, value);
  let result;
  if (kind === "config") {
    result = state.adapter.saveConfig({ [first]: serialized });
  } else if (kind === "setting") {
    result = state.adapter.saveSetting(first, second, serialized);
  } else if (kind === "inputMode") {
    result = state.adapter.setInputMode(serialized, state.target);
  } else if (kind === "runtimeBackend") {
    result = state.adapter.saveSetting("agent", "run_in_wsl", serialized);
    state.notice = `Runtime backend change requires restart · ${state.adapterKind === "mock" ? "mock" : "persisted"}`;
  }
  return result;
}

function runSettingsAction(state, action) {
  let result;
  if (action === "open-config") result = state.adapter.openGlobalConfig();
  else if (action === "reload-config") result = state.adapter.reloadGlobalConfig();
  else if (action === "list-archives") result = state.adapter.listArchives("all");
  else if (action === "check-updates") {
    const version = state.adapter.updateVersion();
    result = state.adapter.updateCheckGithub({ channel: state.settings.updates.channel.toLowerCase() });
    if ((result && typeof result.then === "function") || (version && typeof version.then === "function")) {
      state.notice = "Checking Newmark updates…";
      return Promise.all([version, result]).then(([resolvedVersion, resolvedResult]) => {
        state.notice = `Update check: ${resolvedResult.status || resolvedVersion.version}`;
        return resolvedResult;
      }).catch((error) => {
        state.notice = `Update check failed: ${error.message}`;
        throw error;
      });
    }
    state.notice = `Update check: ${result.status || version.version} · ${state.adapterKind === "mock" ? "mock" : "real"}`;
    return result;
  } else return null;
  if (result && typeof result.then === "function") {
    return result.then((resolved) => {
      state.notice = action === "reload-config" ? "Config refreshed from disk" : state.notice;
      return resolved;
    });
  }
  const archiveItems = Array.isArray(result) ? result : result.items || [];
  const mock = state.adapterKind === "mock";
  state.notice = action === "open-config"
    ? mock ? "Would open ~/.Newmark/config.json · mock" : `Opened ${result.path}`
    : action === "reload-config"
      ? mock ? "Config refresh simulated · no disk read" : "Config refreshed from disk"
      : `Archive inventory: ${archiveItems.length} items · ${mock ? "mock" : "real"}`;
  return result;
}

function selectedMemoryDetail(state) {
  const index = state.memoryLab?.index || { tags: {}, components: {} };
  const tags = Object.keys(index.tags || {}).sort();
  const firstTag = tags.find((name) => (index.tags[name].components || []).length > 0) || tags[0] || "";
  const tag = index.tags?.[state.memorySelectedTag] ? state.memorySelectedTag : firstTag;
  const componentSlugs = index.tags?.[tag]?.components || [];
  const slug = componentSlugs[state.memoryComponentIndex] || componentSlugs[0] || "";
  return {
    tag,
    node: index.tags?.[tag] || { parents: [], children: [], components: [] },
    componentSlugs,
    slug,
    component: index.components?.[slug],
    content: state.memoryLab?.componentContents?.[slug] || ""
  };
}

function memoryTagOptions(state) {
  const tags = Object.keys(state.memoryLab?.index?.tags || {}).sort();
  const query = String(state.memorySearchQuery || "").trim().toLocaleLowerCase();
  return query ? tags.filter((tag) => tag.toLocaleLowerCase().includes(query)) : tags;
}

function setMemorySearchQuery(state, query) {
  state.memorySearchQuery = String(query || "");
  const [first] = memoryTagOptions(state);
  state.memoryColumnIndices[0] = first ? 1 : 0;
  if (first) {
    state.memorySelectedTag = first;
    state.memoryColumnIndices[1] = 0;
    state.memoryColumnIndices[2] = 0;
    state.memoryColumnIndices[3] = 0;
    state.memoryComponentIndex = 0;
  }
  return first || "";
}

function memoryColumnItems(state, column) {
  const detail = selectedMemoryDetail(state);
  if (column === 0) return ["__overview__", ...memoryTagOptions(state)];
  if (column === 1) return detail.tag ? [detail.tag] : [];
  if (column === 2) return [...detail.node.children].sort();
  return detail.componentSlugs;
}

function activeConversationModelLabel(state) {
  const selection = state.snapshot?.modelSelection || { kind: "auto" };
  if (selection.kind === "deployment") {
    const provider = state.providers.find((item) => item.id === selection.providerId);
    const model = provider?.models?.find((item) => item.name === selection.modelId);
    return model?.display || model?.name || selection.modelId || "Model";
  }
  const resolved = String(state.snapshot?.activeModelName || "").trim();
  return resolved && resolved.toLowerCase() !== "auto" ? `Auto · ${resolved}` : "Auto";
}

function activateMemorySelection(state) {
  const column = Math.min(3, Math.max(0, state.contentColumn));
  const items = memoryColumnItems(state, column);
  const index = state.memoryColumnIndices[column] || 0;
  const value = items[index];
  if (!value) {
    state.notice = column === 2 ? "No child tags" : "No item in this column";
    return false;
  }
  if (column === 0 && value === "__overview__") {
    state.notice = "Opening Memory Lab Overview";
    return state.adapter.openMemoryOverview();
  }
  if (column < 3) {
    state.memorySelectedTag = value;
    state.memoryColumnIndices = [0, 0, 0, 0];
    state.memoryComponentIndex = 0;
    state.notice = `Memory tag: ${value} · Detail`;
  } else {
    state.memoryComponentIndex = index;
    state.notice = `Memory component: ${selectedMemoryDetail(state).component?.name || value}`;
  }
  return true;
}

function displayImagesForRun(run) {
  return (run?.events || []).map((event) => event?.displayImage).filter((image) => (
    image?.origin === "agent" && /^data:image\/(?:png|jpeg);base64,/i.test(String(image.dataUrl || ""))
  ));
}

function cycleMemoryComponent(state, delta) {
  const detail = selectedMemoryDetail(state);
  if (!detail.componentSlugs.length) return;
  state.memoryComponentIndex = (state.memoryComponentIndex + delta + detail.componentSlugs.length) % detail.componentSlugs.length;
  state.notice = `Memory component: ${selectedMemoryDetail(state).component?.name || selectedMemoryDetail(state).slug}`;
}

function validateSelectedModel(state) {
  const models = state.providers.flatMap((provider) => provider.models.map((model) => ({ provider, model })));
  const entry = models[state.selected];
  const selected = entry ? [entry.model.name] : [];
  const result = state.adapter.validateModels(selected);
  const apply = (rows) => {
    state.validationNotice = rows.map((item) => `${item.model}: ${item.status}/${item.level}`).join(", ");
    state.notice = `Model validation complete · ${state.adapterKind === "mock" ? "mock" : "real"}`;
    return rows;
  };
  if (result && typeof result.then === "function") {
    state.notice = "Validating model against provider…";
    return result.then(apply).catch((error) => {
      state.notice = `Model validation failed: ${error.message}`;
      throw error;
    });
  }
  return apply(result);
}

function filteredCommands(state) {
  const query = state.paletteQuery.trim().toLowerCase();
  if (!query) return data.commands;
  return data.commands.filter((command) => command.label.toLowerCase().includes(query));
}

function focusableEventsForRun(run) {
  return (run?.events || [])
    .filter((event) => {
      const type = String(event?.type || "").toLowerCase();
      return type && type !== "final_response" && !type.startsWith("guide");
    })
    .sort((left, right) => {
      const leftSeq = Number(left?.sequence);
      const rightSeq = Number(right?.sequence);
      if (Number.isFinite(leftSeq) && Number.isFinite(rightSeq) && leftSeq !== rightSeq) return leftSeq - rightSeq;
      const leftTime = new Date(left?.timestamp || left?.createdAt || "").getTime();
      const rightTime = new Date(right?.timestamp || right?.createdAt || "").getTime();
      return (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
    });
}

function buildEventKey(event, index) {
  return String(event?.id || event?.toolCallId || `${event?.type || "event"}:${event?.toolName || ""}:${index}`);
}

function selectedHistoryRun(state) {
  const runs = [...(state.snapshot.workRuns || [])].sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  return runs[Number(state.historySelectedIndex) || 0];
}

function enterHistoryEventFocus(state) {
  const run = selectedHistoryRun(state);
  const events = focusableEventsForRun(run);
  if (!run || !state.expandedBuildRuns?.has(run.runId) || !events.length) return false;
  state.historyEventFocus = true;
  state.historyEventIndex = 0;
  state.historySelectedImageIndex = -1;
  state.notice = `History focus · ${events.length} item(s) · Enter expand · ← back`;
  return true;
}

function exitHistoryEventFocus(state) {
  state.historyEventFocus = false;
  state.historyEventIndex = -1;
  state.notice = "History focus · Build Block · Enter expands";
  return true;
}

function moveHistoryEventCursor(state, direction) {
  const run = selectedHistoryRun(state);
  const events = focusableEventsForRun(run);
  if (!events.length) return false;
  const count = events.length;
  state.historyEventIndex = ((Number(state.historyEventIndex) || 0) + direction + count) % count;
  state.notice = `History focus · item ${state.historyEventIndex + 1}/${count} · Enter expand`;
  return true;
}

function toggleSelectedBuildEvent(state) {
  const run = selectedHistoryRun(state);
  const events = focusableEventsForRun(run);
  const index = Number(state.historyEventIndex) || 0;
  const event = events[index];
  if (!event) return false;
  const key = buildEventKey(event, index);
  if (state.collapsedBuildEvents.has(key)) {
    state.collapsedBuildEvents.delete(key);
    state.notice = "Event expanded";
  } else {
    state.collapsedBuildEvents.add(key);
    state.notice = "Event collapsed";
  }
  return true;
}

module.exports = {
  activeConversationModelLabel,
  INTELLIGENCE_TIERS,
  activateMenu,
  activateMemorySelection,
  applyThemeAppearance,
  resolveThemeAppearance,
  applySnapshot,
  applyConversationResult,
  beginAutomationCreate,
  beginWorkflowCreate,
  buildEventKey,
  conversationModelOptions,
  createAutomationFromDraft,
  createState,
  confirmSettingChoiceSelection,
  cycleConversationMode,
  cycleMemoryComponent,
  cycleSettingsTab,
  enterConversation,
  enterHistoryEventFocus,
  exitHistoryEventFocus,
  filteredCommands,
  focusableEventsForRun,
  itemCount,
  memoryColumnItems,
  memoryTagOptions,
  markConversationRunning,
  moveMenuLevel,
  moveMenuSelection,
  moveFocusHorizontal,
  moveConversationHistoryCursor,
  moveHistoryEventCursor,
  moveInputCursorVertical,
  moveSettingChoiceSelection,
  moveSelection,
  rootMenuItems,
  returnToConversationSelection,
  requestConversationStop,
  runSettingsAction,
  saveWorkflowFromDraft,
  scrollConversation,
  selectedMemoryDetail,
  setMemorySearchQuery,
  selectConversationModel,
  selectIntelligenceTier,
  selectFlowWorkflow,
  switchView,
  toggleAgentHistory,
  toggleWorkflowDetails,
  toggleSelected,
  toggleConversationPinned,
  toggleSelectedBuildBlock,
  toggleSelectedBuildEvent,
  validateSelectedModel,
  workspaceMenuChildren
};
