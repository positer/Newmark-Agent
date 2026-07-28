"use strict";

const data = require("./data");
const { createMockNewmarkAdapter } = require("./adapters/mock-newmark-adapter");
const { targetKey, validateSnapshot } = require("./adapters/newmark-contract");
const { SETTINGS_CATEGORIES, settingsRows } = require("./settings-schema");

function applySnapshot(state, snapshot) {
  const valid = validateSnapshot(snapshot);
  state.snapshot = valid;
  state.target = { ...valid.target };
  state.messages = valid.chatMessages.map((item) => ({ ...item }));
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
  const resolvedTheme = label === "Light" ? "light" : "dark";
  state.theme = resolvedTheme;
  state.settings.personalization.theme = label;
  state.settings.personalization.fontColor = resolvedTheme === "light" ? "#1F2937" : "#E6EAF2";
  state.settings.personalization.backgroundColor = resolvedTheme === "light" ? "#F0F2F8" : "#0A0A1A";
  return {
    theme: label.toLowerCase(),
    fontColor: state.settings.personalization.fontColor,
    backgroundColor: state.settings.personalization.backgroundColor
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
  return {
    adapter,
    adapterKind: adapter.kind,
    workspaces,
    target,
    snapshot,
    view: "home",
    selected: 0,
    sidebar: 0,
    focusRegion: "menu",
    contentColumn: 0,
    menuLevel: "root",
    menuRootIndex: 0,
    menuChildIndex: {},
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
    flowSelectionIndex: 0,
    flowByConversation: initialFlow ? { [`${target.workspaceId}::${target.conversationId}`]: initialFlow } : {},
    currentFlow: initialFlow,
    theme: String(snapshot.darkMode || "dark").toLowerCase() === "light" ? "light" : "dark",
    overlay: null,
    paletteQuery: "",
    paletteIndex: 0,
    inputMode: false,
    input: "",
    lastConversation: snapshot.conversations.find((item) => item.id === target.conversationId)?.title || target.conversationId,
    notice: adapter.kind === "mock"
      ? "Demo mode · no real services connected"
      : `Newmark core connected · ${workspaces.find((item) => item.id === target.workspaceId)?.path || target.workspaceId}`,
    busy: false,
    runningConversationKeys: new Set(),
    stopStageByConversation: new Map(),
    tick: 0,
    messages: snapshot.chatMessages.map((item) => ({ ...item })),
    memoryLab,
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
    settings: {
      general: {
        language: { auto: "Auto", en: "English", zh: "中文" }[snapshot.language] || "Auto",
        inputBehavior: snapshot.inputMode === "next" ? "Next" : "Guide",
        dialogStyle: snapshot.dialogStyle === "friendly" ? "Friendly" : "Formal",
        feedbackLevel: { ask_more: "Ask more", ask_less: "Ask less", fully_autonomous: "Autonomous" }[snapshot.feedback] || "Default",
        closeBehavior: snapshot.closeBehavior === "minimize" ? "Minimize to tray" : "Close app",
        expandTools: snapshot.expandToolsDefault !== false
      },
      personalization: {
        theme: { light: "Light", system: "System", dark: "Dark" }[String(snapshot.darkMode || "dark").toLowerCase()] || "Dark",
        fontFamily: snapshot.fontFamily || "Terminal default",
        fontColor: snapshot.fontColor || "#E6EAF2",
        backgroundColor: snapshot.backgroundColor || (String(snapshot.darkMode).toLowerCase() === "light" ? "#F0F2F8" : "#0A0A1A"),
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
    model: conversationModelOptions(state).length,
    flowbar: state.currentFlow ? 1 : 0,
    flowlist: state.flows.length,
    flowtask: state.currentFlow?.components?.length || 0,
    tools: state.tools.length,
    memory: memoryColumnItems(state, state.contentColumn).length,
    automation: state.automations.length,
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
    state.notice = `Content focus · column ${state.contentColumn + 1}`;
  }
}

function rootMenuItems(state) {
  return [
    { type: "view", id: "home", label: "Overview" },
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
  state.notice = `Entered conversation: ${conversation.title}`;
  return true;
}

function returnToConversationSelection(state) {
  if (state.view !== "chat" || !state.inputMode) return false;
  state.inputMode = false;
  state.notice = "Conversation selection · draft preserved";
  return true;
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
    const job = state.automations[state.selected];
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
  if (result && typeof result.then === "function") throw new TypeError("Demo settings adapter must be synchronous");
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

function memoryColumnItems(state, column) {
  const detail = selectedMemoryDetail(state);
  const tags = Object.keys(state.memoryLab?.index?.tags || {}).sort();
  const roots = tags.filter((tag) => !(state.memoryLab.index.tags[tag].parents || []).length);
  if (column === 0) return detail.node.parents.length ? [...detail.node.parents].sort() : roots;
  if (column === 1) return detail.tag ? [detail.tag] : [];
  if (column === 2) return [...detail.node.children].sort();
  return detail.componentSlugs;
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

module.exports = {
  activateMenu,
  activateMemorySelection,
  applyThemeAppearance,
  applySnapshot,
  applyConversationResult,
  conversationModelOptions,
  createState,
  cycleConversationMode,
  cycleMemoryComponent,
  cycleSettingsTab,
  enterConversation,
  filteredCommands,
  itemCount,
  memoryColumnItems,
  markConversationRunning,
  moveMenuLevel,
  moveMenuSelection,
  moveFocusHorizontal,
  moveSelection,
  rootMenuItems,
  returnToConversationSelection,
  requestConversationStop,
  runSettingsAction,
  selectedMemoryDetail,
  selectConversationModel,
  selectFlowWorkflow,
  switchView,
  toggleSelected,
  toggleConversationPinned,
  validateSelectedModel,
  workspaceMenuChildren
};
