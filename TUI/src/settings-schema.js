"use strict";

const SETTINGS_CATEGORIES = Object.freeze([
  { id: "general", icon: "[G]", label: "General", source: "getState / saveConfig / saveSetting" },
  { id: "personalization", icon: "[P]", label: "Personalization", source: "ui.* / TUI appearance extension" },
  { id: "runtime", icon: "[R]", label: "Runtime", source: "agent.* / terminal.*" },
  { id: "providers", icon: "[V]", label: "Providers", source: "models.providers" },
  { id: "models", icon: "[M]", label: "Models", source: "models.providers[].models" },
  { id: "tools", icon: "[T]", label: "Tools", source: "tools.enabled" },
  { id: "archive", icon: "[A]", label: "Archive", source: "archive API / archive.*" },
  { id: "updates", icon: "[U]", label: "Updates", source: "update API / updates.*" }
]);

const FONT_CHOICES = Object.freeze(["Terminal default", "Cascadia Mono", "JetBrains Mono", "Consolas", "Noto Sans Mono"]);
const FONT_COLOR_CHOICES = Object.freeze(["#E6EAF2", "#B7E4FF", "#C7F9CC", "#FFD6A5", "#F8B4D9"]);
const BACKGROUND_COLOR_CHOICES = Object.freeze(["#0A0A1A", "#111827", "#172554", "#1F2937", "#F0F2F8"]);

function settingsRows(state, tab = state.settingsTab) {
  const s = state.settings;
  if (tab === "general") return [
    { key: "language", label: "Language", value: s.general.language, choices: ["Auto", "English", "中文"], save: ["setting", "general", "language"] },
    { key: "inputBehavior", label: "Input mode", value: s.general.inputBehavior, choices: ["Guide", "Next"], save: ["inputMode"] },
    { key: "dialogStyle", label: "Conversation style", value: s.general.dialogStyle, choices: ["Formal", "Friendly"], save: ["config", "dialogStyle"] },
    { key: "feedbackLevel", label: "Option feedback", value: s.general.feedbackLevel, choices: ["Default", "Ask more", "Ask less", "Autonomous"], save: ["config", "feedbackLevel"] },
    { key: "closeBehavior", label: "Close behavior", value: s.general.closeBehavior, choices: ["Close app", "Minimize to tray"], save: ["setting", "general", "close_behavior"] },
    { key: "expandTools", label: "Expand tool usage", value: s.general.expandTools, choices: [true, false], save: ["setting", "general", "expand_tools"] },
    { key: "remoteTouch", label: "Mobile remote-touch", value: s.general.remoteTouch, choices: [true, false], save: ["setting", "remote", "touch_enabled"] }
  ];
  if (tab === "personalization") return [
    { key: "theme", label: "Theme", value: s.personalization.theme, choices: ["Dark", "Light", "System"], save: ["config", "theme"] },
    { key: "fontFamily", label: "Application font", value: s.personalization.fontFamily, choices: FONT_CHOICES, save: ["config", "fontFamily"] },
    { key: "fontColor", label: "Font color", value: s.personalization.fontColor, choices: FONT_COLOR_CHOICES, save: ["config", "fontColor"], extension: true },
    { key: "backgroundColor", label: "Background color", value: s.personalization.backgroundColor, choices: BACKGROUND_COLOR_CHOICES, save: ["config", "backgroundColor"] },
    { key: "glassAlpha", label: "Glass intensity", value: s.personalization.glassAlpha, choices: [0.65, 0.75, 0.85, 0.95], save: ["config", "glassAlpha"] }
  ];
  if (tab === "runtime") return [
    { key: "backend", label: "Agent backend", value: s.runtime.backend, choices: ["Windows native", "WSL"], save: ["runtimeBackend"] },
    { key: "wslDistro", label: "WSL distribution", value: s.runtime.wslDistro, choices: ["Ubuntu-24.04", "Ubuntu-22.04", "Debian"], save: ["setting", "agent", "wsl_distro"] },
    { key: "terminalTimeout", label: "Terminal timeout cap", value: s.runtime.terminalTimeout, choices: [0, 30000, 60000, 120000], save: ["setting", "terminal", "interrupt_timeout_ms"] },
    { key: "defaultShell", label: "Default shell", value: s.runtime.defaultShell, choices: ["PowerShell", "Command Prompt", "WSL Bash"], save: ["setting", "terminal", "default_shell"] }
  ];
  if (tab === "archive") return [
    { key: "autoArchive", label: "Automatic archive", value: s.archive.autoArchive, choices: [true, false], save: ["setting", "archive", "automatic"] },
    { key: "retentionDays", label: "Retention", value: s.archive.retentionDays, choices: [30, 90, 180, 365], save: ["setting", "archive", "retention_days"] },
    { key: "includeMemory", label: "Include Memory Lab", value: s.archive.includeMemory, choices: [true, false], save: ["setting", "archive", "include_memory_lab"] },
    { key: "exportFormat", label: "Export format", value: s.archive.exportFormat, choices: ["JSON", "Markdown", "ZIP"], save: ["setting", "archive", "export_format"] }
  ];
  if (tab === "updates") return [
    { key: "channel", label: "Update channel", value: s.updates.channel, choices: ["Stable", "Prerelease"], save: ["setting", "updates", "channel"] },
    { key: "autoCheck", label: "Automatic checks", value: s.updates.autoCheck, choices: [true, false], save: ["setting", "updates", "auto_check"] },
    { key: "autoDownload", label: "Automatic download", value: s.updates.autoDownload, choices: [false, true], save: ["setting", "updates", "auto_download"] },
    { key: "source", label: "Update source", value: s.updates.source, choices: ["GitHub", "Local package"], save: ["setting", "updates", "source"] }
  ];
  return [];
}

function displaySettingValue(value) {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number" && value <= 1 && value > 0) return `${Math.round(value * 100)}%`;
  if (typeof value === "number" && value >= 1000) return `${value / 1000}s`;
  if (value === 0) return "Unlimited";
  return String(value);
}

module.exports = {
  BACKGROUND_COLOR_CHOICES,
  FONT_CHOICES,
  FONT_COLOR_CHOICES,
  SETTINGS_CATEGORIES,
  displaySettingValue,
  settingsRows
};
