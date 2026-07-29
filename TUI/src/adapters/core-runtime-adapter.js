"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { assertTarget, validateSnapshot } = require("./newmark-contract");

function resolveDesktopDist(options = {}) {
  const candidates = [
    options.desktopDist,
    process.env.NEWMARK_DESKTOP_DIST,
    path.join(__dirname, "..", "..", "..", "DESKTOP", "dist"),
    path.join(__dirname, "..", "..", "..")
  ].filter(Boolean).map((candidate) => path.resolve(candidate));
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "core", "agent.js"))) || candidates[0];
}

function sanitizeProviders(providers) {
  return (providers || []).map((provider) => ({
    ...provider,
    api_key: "",
    has_api_key: !!provider.api_key,
    models: (provider.models || []).map((model) => ({ ...model }))
  }));
}

function ensureRuntimeRoot(root, configModule) {
  fs.mkdirSync(root, { recursive: true });
  configModule.ensureRootConfig(root);
  const promptPath = path.join(root, "agent.md");
  if (!fs.existsSync(promptPath)) {
    fs.writeFileSync(promptPath, "# Newmark Agent\n\nYou are a powerful coding assistant.\n", "utf8");
  }
  for (const directory of ["Work", "Flow", "skills", "archive"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
}

function workspaceIdentity(workspace, root) {
  if (!workspace) {
    return {
      id: "runtime-root",
      name: "Newmark",
      path: root,
      isInternal: false,
      hostBinding: "local",
      icon: "[W]",
      kind: "local",
      status: "active"
    };
  }
  return {
    ...workspace,
    id: String(workspace.id || workspace.path || workspace.name),
    icon: workspace.kind === "ssh" || workspace.sshConnectionId ? "[R]" : "[W]",
    kind: workspace.kind === "ssh" || workspace.sshConnectionId ? "ssh" : "local",
    status: "active"
  };
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(String(value || "")).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function mergeProviderConfig(currentProviders, incomingProviders) {
  return (incomingProviders || []).map((incoming) => {
    const current = (currentProviders || []).find((provider) => provider.id === incoming.id);
    const models = (incoming.models || []).map((incomingModel) => ({
      ...((current?.models || []).find((model) => model.name === incomingModel.name) || {}),
      ...incomingModel
    }));
    const merged = { ...(current || {}), ...incoming, models };
    delete merged.has_api_key;
    if (current?.api_key) merged.api_key = current.api_key;
    return merged;
  });
}

function createCoreRuntimeAdapter(options = {}) {
  const desktopDist = resolveDesktopDist(options);
  const agentPath = path.join(desktopDist, "core", "agent.js");
  if (!fs.existsSync(agentPath)) {
    throw new Error(`Newmark compiled core was not found: ${agentPath}. Run npm.cmd run build in DESKTOP.`);
  }
  const configModule = require(path.join(desktopDist, "core", "config.js"));
  const { Agent } = require(agentPath);
  const { MemoryLabManager } = require(path.join(desktopDist, "core", "memoryLab.js"));
  const { AutomationManager } = require(path.join(desktopDist, "core", "automation.js"));
  const { FlowEngine } = require(path.join(desktopDist, "core", "flow.js"));
  const installUpdate = require(path.join(desktopDist, "core", "installUpdate.js"));
  const root = path.resolve(options.root || path.join(os.homedir(), ".Newmark"));
  const workspacePath = path.resolve(options.workspacePath || process.cwd());
  ensureRuntimeRoot(root, configModule);

  const agent = new Agent(root);
  const knownWorkspace = [...(agent.workspace.internal || []), ...(agent.workspace.external || [])]
    .find((workspace) => samePath(workspace.path, workspacePath));
  const selectedWorkspace = knownWorkspace
    ? agent.selectWorkspaceFromStorage(knownWorkspace.id)
    : agent.addExternalWorkspace(workspacePath);
  if (!selectedWorkspace) {
    throw new Error(
      `The current folder cannot be registered as a Newmark workspace: ${workspacePath}. ` +
      `Choose a folder outside the runtime root (${root}).`
    );
  }
  const memoryLab = new MemoryLabManager(root, agent.config.getStr("general", "language") || "auto");
  const automation = new AutomationManager(agent.config, async () => {
    throw new Error("Automation execution is owned by the Newmark host runtime.");
  });
  const conversationRuntimes = new Map();

  const workspaces = () => {
    const rows = [...(agent.workspace.internal || []), ...(agent.workspace.external || [])]
      .map((workspace) => workspaceIdentity(workspace, root));
    const current = workspaceIdentity(agent.workspace.current, root);
    return rows.some((workspace) => workspace.id === current.id) ? rows : [current, ...rows];
  };

  const currentTarget = () => ({
    workspaceId: workspaceIdentity(agent.workspace.current, root).id,
    conversationId: String(agent.activeConversationId || agent.listConversationStates()[0]?.id || "default")
  });

  const stateFields = () => ({
    providers: sanitizeProviders(agent.config.providers()),
    models: agent.allModelNames(),
    nativeTools: agent.config.nativeToolEnabled(),
    automations: automation.list(),
    darkMode: agent.config.getStr("ui", "dark_mode") || "dark",
    backgroundColor: agent.config.getStr("ui", "background_color") || "",
    fontFamily: agent.config.getStr("ui", "font_family") || "",
    fontColor: agent.config.getStr("ui", "font_color") || "",
    glassAlpha: agent.config.getNum("ui", "glass_alpha") || 0.85,
    language: agent.config.getStr("general", "language") || "auto",
    feedback: agent.config.getStr("agent", "option_feedback") || "default",
    closeBehavior: agent.config.getStr("general", "close_behavior") || "close",
    expandToolsDefault: agent.config.getBool("general", "expand_tools"),
    configuredAgentBackend: agent.config.getBool("agent", "run_in_wsl") ? "wsl" : "windows",
    wslDistro: agent.config.getStr("agent", "wsl_distro") || "Ubuntu-24.04",
    terminalInterruptTimeoutMs: agent.config.getNum("terminal", "interrupt_timeout_ms"),
    defaultTerminalShell: agent.config.getStr("terminal", "default_shell") || (process.platform === "win32" ? "powershell" : "bash"),
    status: agent.status,
    connected: true,
    runtimeRoot: root
  });

  const snapshotFor = (requested = currentTarget()) => {
    assertTarget(requested);
    const target = currentTarget();
    const raw = agent.getConversationSnapshot(requested.conversationId || target.conversationId);
    return validateSnapshot({
      ...raw,
      target: {
        workspaceId: workspaceIdentity(agent.workspace.current, root).id,
        conversationId: raw.conversationId
      },
      workspaceId: workspaceIdentity(agent.workspace.current, root).id,
      ...stateFields()
    });
  };

  const runtimeKey = (target) => `${target.workspaceId}::${target.conversationId}`;
  const runnerFor = (requested) => {
    assertTarget(requested);
    const key = runtimeKey(requested);
    let runner = conversationRuntimes.get(key);
    if (!runner) {
      runner = new Agent(root, { agentOnly: true, conversationId: requested.conversationId });
      runner.selectWorkspaceFromStorage(requested.workspaceId);
      runner.setConversationFromStorage(requested.conversationId);
      conversationRuntimes.set(key, runner);
    }
    return runner;
  };
  const snapshotFromRunner = (runner, requested) => {
    const raw = runner.getConversationSnapshot(requested.conversationId);
    return validateSnapshot({
      ...raw,
      target: { ...requested },
      workspaceId: requested.workspaceId,
      ...stateFields()
    });
  };

  const applyConfig = (config) => {
    for (const [key, value] of Object.entries(config || {})) {
      switch (key) {
        case "theme": agent.config.set("ui", "dark_mode", value); break;
        case "backgroundColor": agent.config.set("ui", "background_color", value); break;
        case "fontFamily": agent.config.set("ui", "font_family", value); break;
        case "fontColor": agent.config.set("ui", "font_color", value); break;
        case "glassAlpha": agent.config.set("ui", "glass_alpha", value); break;
        case "feedbackLevel": agent.config.set("agent", "option_feedback", value); break;
        case "dialogStyle": agent.config.set("ui", "dialog_style", value); break;
        case "nativeTools": agent.config.set("tools", "enabled", value); break;
        case "providers": agent.updateProviders(mergeProviderConfig(agent.config.providers(), value)); break;
        default: agent.config.set("ui", key, value);
      }
    }
    agent.config.save();
    return { ok: true };
  };

  return {
    kind: "newmark-core",
    connected: true,
    root,
    getInitialTarget: currentTarget,
    listWorkspaces: workspaces,
    selectWorkspace(workspaceId) {
      agent.selectWorkspaceFromStorage(workspaceId);
      const rows = agent.listConversationStates();
      const conversationId = agent.activeConversationId || rows[0]?.id || "default";
      agent.setConversationFromStorage(conversationId);
      return snapshotFor(currentTarget());
    },
    getState(requested = currentTarget()) {
      if (requested.workspaceId !== currentTarget().workspaceId) agent.selectWorkspaceFromStorage(requested.workspaceId);
      return snapshotFor(requested);
    },
    activateConversation(requested) {
      assertTarget(requested);
      if (requested.workspaceId !== currentTarget().workspaceId) agent.selectWorkspaceFromStorage(requested.workspaceId);
      agent.setConversationFromStorage(requested.conversationId);
      agent.persistActiveConversationSelection(requested.conversationId);
      return snapshotFor(currentTarget());
    },
    setConversationModel(selection, requested = currentTarget()) {
      this.activateConversation(requested);
      const value = selection?.kind === "deployment"
        ? `deployment:${encodeURIComponent(selection.providerId)}:${encodeURIComponent(selection.modelId)}`
        : "auto";
      agent.setModel(value, true);
      return snapshotFor(currentTarget());
    },
    setConversationPinned(conversationId, pinned, requested = currentTarget()) {
      this.activateConversation(requested);
      agent.setConversationPinned(conversationId, !!pinned);
      return snapshotFor(currentTarget());
    },
    setWorkRunExpanded(runId, expanded, requested = currentTarget()) {
      assertTarget(requested);
      const runner = runnerFor(requested);
      return runner.setConversationWorkRunExpanded(String(runId || ""), !!expanded);
    },
    setConversationMode(mode, requested = currentTarget()) {
      this.activateConversation(requested);
      agent.setMode(mode);
      agent.saveWorkspaceConversationState(true);
      return snapshotFor(currentTarget());
    },
    listFlows() {
      return FlowEngine.listAll(path.join(root, "Flow"));
    },
    readFlow(name) {
      return FlowEngine.load(path.join(root, "Flow"), String(name || ""));
    },
    saveFlow(workflow) {
      const candidate = {
        name: String(workflow?.name || "").trim(),
        components: Array.isArray(workflow?.components) ? workflow.components : []
      };
      if (!candidate.name || candidate.name !== path.basename(candidate.name) || /[<>:"/\\|?*]/.test(candidate.name)) {
        throw new Error("Invalid workflow name");
      }
      const errors = FlowEngine.validate(candidate);
      if (errors.length) throw new Error(errors.map((item) => item.message).join("; "));
      FlowEngine.save(path.join(root, "Flow"), candidate);
      return candidate;
    },
    selectConversationFlow(name, requested = currentTarget()) {
      this.activateConversation(requested);
      const workflow = FlowEngine.load(path.join(root, "Flow"), String(name || ""));
      if (!workflow) throw new Error(`Flow workflow not found: ${name}`);
      if (typeof agent.setConversationFlow === "function") agent.setConversationFlow(workflow.name);
      else {
        agent.setMode("flow");
        agent.flow = workflow;
        agent.flowPc = 0;
        agent.saveWorkspaceConversationState(true);
      }
      return { snapshot: snapshotFor(currentTarget()), workflow };
    },
    createConversation() {
      const conversationId = `conversation-${Date.now().toString(36)}`;
      agent.setConversation(conversationId);
      agent.persistActiveConversationSelection(conversationId);
      return snapshotFor(currentTarget());
    },
    async sendMessage(message, requested) {
      const runner = runnerFor(requested);
      await runner.process(String(message || ""));
      return snapshotFromRunner(runner, requested);
    },
    stopConversation(requested, force = false) {
      assertTarget(requested);
      const runner = conversationRuntimes.get(runtimeKey(requested));
      const stopped = runner ? runner.abortActiveKernelRun() : false;
      return {
        action: force ? "force" : (stopped ? "graceful" : "not_running"),
        target: { ...requested }
      };
    },
    setInputMode(mode, requested = currentTarget()) {
      assertTarget(requested);
      const persisted = agent.setInputMode(mode);
      const runner = conversationRuntimes.get(runtimeKey(requested));
      if (runner) runner.setInputMode(persisted);
      return persisted;
    },
    getConversationPlan(requested = currentTarget()) {
      return agent.getConversationPlan(requested.conversationId);
    },
    updateConversationPlan(plan, requested = currentTarget()) {
      return agent.updateConversationPlan(plan, requested.conversationId);
    },
    updateGoal(objective) {
      agent.updateGoal(objective);
      return agent.goal;
    },
    toggleGoalPause() {
      return agent.toggleGoalPause();
    },
    clearGoal() {
      agent.clearGoal();
      return true;
    },
    listAutomations() {
      return automation.list();
    },
    toggleAutomation(id) {
      return automation.toggle(id);
    },
    createAutomation(input) {
      return automation.create(input);
    },
    deleteAutomation(id) {
      return automation.delete(id);
    },
    memoryLabRead(selector = "") {
      return memoryLab.read(selector);
    },
    memoryLabVisualization() {
      return memoryLab.visualizationSnapshot();
    },
    memoryLabReindex() {
      return memoryLab.reindex();
    },
    setProviderEnabled(providerId, enabled) {
      const providers = agent.config.providers();
      const provider = providers.find((item) => item.id === providerId);
      if (!provider) return { ok: false, error: "Provider not found" };
      provider.enabled = !!enabled;
      agent.updateProviders(providers);
      agent.config.save();
      return { ok: true, enabled: provider.enabled, providers: sanitizeProviders(agent.config.providers()), models: agent.allModelNames() };
    },
    validateModels(selected = []) {
      return agent.validateModels(selected.length ? selected : undefined);
    },
    modelValidationStatus() {
      return { running: false, completed: true };
    },
    fuzzyInject(name, url, key, protocol = "openai") {
      return agent.fuzzyInject(name, url, key, protocol);
    },
    saveConfig: applyConfig,
    saveSetting(section, key, value) {
      agent.config.set(section, key, value);
      agent.config.save();
      return { ok: true, section, key, value };
    },
    openGlobalConfig() {
      const configPath = path.join(root, "config.json");
      if (process.platform === "win32") {
        const child = spawn("cmd.exe", ["/d", "/s", "/c", "start", "", configPath], { detached: true, stdio: "ignore", windowsHide: true });
        child.unref();
      }
      return { ok: true, path: configPath };
    },
    reloadGlobalConfig() {
      agent.config.reload();
      if (agent.workspace.current) agent.config.loadWorkspaceConfig(agent.workspace.current.path);
      return { ok: true, path: path.join(root, "config.json") };
    },
    listArchives(scope = "all") {
      return agent.listArchives(scope === "workspace" ? "workspace" : "all");
    },
    updateVersion() {
      return { version: installUpdate.currentAppVersion(), root };
    },
    updateCheckGithub(input = {}) {
      return installUpdate.checkGitHubUpdate(input.repo, input.tag, input.asset, input.token);
    },
    updateApplyGithub(input = {}) {
      return installUpdate.applyGitHubUpdate(input);
    },
    updateInstallLocal(input = {}) {
      return installUpdate.installUpdate(input);
    },
    close() {
      for (const runner of conversationRuntimes.values()) runner.abortActiveKernelRun();
      conversationRuntimes.clear();
      automation.stop();
      return true;
    }
  };
}

module.exports = { createCoreRuntimeAdapter, mergeProviderConfig, resolveDesktopDist, samePath, sanitizeProviders };
