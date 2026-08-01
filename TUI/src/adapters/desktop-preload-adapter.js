"use strict";

const { INTEGRATION_METHODS, assertTarget, validateSnapshot } = require("./newmark-contract");

/**
 * Prepared adapter for Newmark's existing Electron preload surface.
 * The demo never constructs this adapter. A future integrated TUI host can inject
 * the same API object exposed by DESKTOP/src/preload.ts.
 */
function createDesktopPreloadAdapter(api) {
  if (!api || typeof api !== "object") throw new TypeError("Newmark preload API is required");
  for (const method of INTEGRATION_METHODS) {
    if (typeof api[method] !== "function") throw new TypeError(`Newmark preload API is missing ${method}()`);
  }
  return {
    kind: "desktop-preload",
    connected: true,
    async getState(target) {
      assertTarget(target);
      return validateSnapshot(await api.getState(target));
    },
    async selectWorkspace(workspaceId) {
      await api.selectWorkspace(workspaceId);
      return api.getState({ workspaceId });
    },
    async activateConversation(target) {
      assertTarget(target);
      return validateSnapshot(await api.activateConversation(target));
    },
    async setConversationModel(selection, target) {
      assertTarget(target);
      await api.activateConversation(target);
      const value = selection?.kind === "deployment"
        ? `deployment:${encodeURIComponent(selection.providerId)}:${encodeURIComponent(selection.modelId)}`
        : "auto";
      await api.setModel(value);
      return validateSnapshot(await api.getState(target));
    },
    async setIntelligence(tier, target) {
      assertTarget(target);
      await api.activateConversation(target);
      await api.setIntelligence(tier);
      return validateSnapshot(await api.getState(target));
    },
    async setConversationPinned(conversationId, pinned, target) {
      assertTarget(target);
      await api.activateConversation(target);
      await api.setConversationPinned(conversationId, !!pinned);
      return validateSnapshot(await api.getState(target));
    },
    async setWorkRunExpanded(runId, expanded, target) {
      assertTarget(target);
      return api.setWorkRunExpanded({ target, runId, expanded: !!expanded });
    },
    async setConversationMode(mode, target) {
      assertTarget(target);
      await api.activateConversation(target);
      await api.setMode(mode);
      return validateSnapshot(await api.getState(target));
    },
    async listFlows() {
      return api.listFlows();
    },
    async readFlow(name) {
      const result = await api.readFlow(name);
      return result?.workflow || null;
    },
    async saveFlow(workflow) {
      const result = await api.saveFlow(workflow);
      if (result?.error) throw new Error(result.error);
      return result?.workflow || workflow;
    },
    async selectConversationFlow(name, target) {
      assertTarget(target);
      await api.activateConversation(target);
      await api.setMode("flow");
      const result = await api.readFlow(name);
      if (!result?.workflow) throw new Error(result?.error || `Flow workflow not found: ${name}`);
      return { snapshot: validateSnapshot(await api.getState(target)), workflow: result.workflow };
    },
    async sendMessage(message, target) {
      assertTarget(target);
      return api.sendMessage(message, target);
    },
    async stopConversation(target, force = false) {
      assertTarget(target);
      return api.stopConversation({ target, force });
    },
    async setInputMode(mode, target) {
      assertTarget(target);
      return api.setInputMode(mode, target);
    },
    async getConversationPlan(target) {
      assertTarget(target);
      return api.getConversationPlan(target.conversationId);
    },
    async updateConversationPlan(plan, target) {
      assertTarget(target);
      return api.updateConversationPlan(plan, target.conversationId);
    },
    async updateGoal(objective, target) {
      assertTarget(target);
      return api.updateGoal(objective, target);
    },
    async toggleGoalPause(target) {
      assertTarget(target);
      return api.toggleGoalPause(target);
    },
    async clearGoal(target) {
      assertTarget(target);
      return api.clearGoal(target);
    },
    async listAutomations() {
      return api.listAutomations();
    },
    async toggleAutomation(id) {
      return api.toggleAutomation(id);
    },
    async createAutomation(input) {
      return api.createAutomation(input);
    },
    async deleteAutomation(id) {
      return api.deleteAutomation(id);
    },
    async memoryLabRead(selector = "") {
      return api.memoryLabRead(selector);
    },
    async memoryLabVisualization() {
      return api.memoryLabVisualization();
    },
    async memoryLabReindex() {
      return api.memoryLabReindex();
    },
    async openImageViewer(image) {
      return api.openImageViewer({ type: "image", title: image?.caption || image?.name || "示意图", dataUrl: image?.dataUrl || "" });
    },
    async openMemoryOverview() {
      return api.openMemoryOverview();
    },
    async setProviderEnabled(providerId, enabled) {
      return api.setProviderEnabled(providerId, enabled);
    },
    async validateModels(selected = []) {
      return api.validateModels(selected);
    },
    async modelValidationStatus() {
      return api.modelValidationStatus();
    },
    async fuzzyInject(name, url, key, protocol = "openai") {
      return api.fuzzyInject(name, url, key, protocol);
    },
    async saveConfig(config) {
      return api.saveConfig(config);
    },
    async saveSetting(section, key, value) {
      return api.saveSetting(section, key, value);
    },
    async openGlobalConfig() {
      return api.openGlobalConfig();
    },
    async reloadGlobalConfig() {
      return api.reloadGlobalConfig();
    },
    async listArchives(scope = "all") {
      return api.listArchives(scope);
    },
    async updateVersion() {
      return api.updateVersion();
    },
    async updateCheckGithub(input = {}) {
      return api.updateCheckGithub(input);
    },
    async updateApplyGithub(input = {}) {
      return api.updateApplyGithub(input);
    },
    async updateInstallLocal(input = {}) {
      return api.updateInstallLocal(input);
    }
  };
}

module.exports = { createDesktopPreloadAdapter };
