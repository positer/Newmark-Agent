"use strict";

/**
 * Lightweight terminal i18n for the Newmark TUI.
 *
 * The TUI chrome (navigation, section headers, view titles, and hints) is
 * rendered in the language chosen under Settings → General → Language. Model,
 * tool, provider, conversation, and workspace names are user data and stay
 * verbatim. Keys are the English source strings, so an untranslated string
 * silently falls back to English rather than dropping text.
 */

const ZH = Object.freeze({
  // Sidebar sections
  "WORKSPACES": "工作区",
  "OPERATIONS": "操作",
  "ACTIVE TARGET": "当前目标",
  "ACTIVE CONVERSATION": "当前对话",
  "Agent TUI": "Agent 终端",

  // Navigation labels (TUI/src/data.js)
  "Conversations": "对话",
  "Plan": "计划",
  "Goal": "目标",
  "Subagents": "子代理",
  "Model": "模型",
  "Flow Bar": "流程条",
  "Flow List": "流程列表",
  "Flow Task": "流程任务",
  "Tools": "工具",
  "Memory Lab": "记忆实验室",
  "Automations": "自动化",
  "WorkFlow": "工作流",
  "Settings": "设置",
  "Help": "帮助",

  // Conversation context
  "Conversation plan": "对话计划",
  "Conversation goal": "对话目标",
  "Conversation subagents": "对话子代理",
  "Model and reasoning effort": "模型与推理档位",
  "Flow bar": "流程条",
  "Flow list": "流程列表",
  "Flow task": "流程任务",

  // Model view
  "Reasoning effort": "推理档位",
  "Deployment": "部署",
  "Shared GUI/TUI request tier · ←/→ changes section": "GUI/TUI 共享请求档位 · ←/→ 切换区块",
  "Used by this conversation, including its Plan and Subagents": "当前对话使用（含计划与子代理）",
  "Enter applies the focused tier or deployment. Effort persists globally; deployments remain per conversation.":
    "Enter 应用当前档位或部署。档位全局持久化，部署按对话保存。",

  // Memory Lab
  "Tags": "标签",
  "Selected tag": "已选标签",
  "Child tags": "子标签",
  "Memory components": "记忆组件",
  "Core memory": "核心记忆",
  "No memory components": "无记忆组件",
  "No component selected": "未选择组件",
  "Overview": "总览",
  "Memory overview": "记忆总览",
  "Memory tag": "记忆标签",

  // Chat view
  "N new": "N 新建",
  "Workspace": "工作区",
  "Current": "当前",
  "Preview": "预览",
  "Current conversation": "当前对话",
  "Enter to open this conversation": "Enter 打开此对话",
  "Type a message · Shift+Enter newline · Enter send": "输入消息 · Shift+Enter 换行 · Enter 发送",
  "Select a conversation · Enter to edit": "选择对话 · Enter 编辑",

  // Settings categories
  "General": "通用",
  "Personalization": "个性化",
  "Runtime": "运行时",
  "Providers": "服务商",
  "Models": "模型",
  "Archive": "归档",
  "Updates": "更新",

  // Settings
  "Categories": "分类",
  "Language": "语言",
  "Input mode": "输入模式",
  "Conversation style": "对话风格",
  "Option feedback": "选项反馈",
  "Close behavior": "关闭行为",
  "Expand tool usage": "展开工具使用",
  "Theme": "主题",
  "Application font": "应用字体",
  "Font color": "字体颜色",
  "Background color": "背景颜色",
  "Glass intensity": "玻璃强度",
  "Agent backend": "Agent 后端",
  "WSL distribution": "WSL 发行版",
  "Terminal timeout cap": "终端超时上限",
  "Default shell": "默认 Shell",
  "Automatic archive": "自动归档",
  "Retention": "保留期",
  "Include Memory Lab": "包含记忆实验室",
  "Export format": "导出格式",
  "Update channel": "更新通道",
  "Automatic checks": "自动检查",
  "Automatic download": "自动下载",
  "Update source": "更新来源",
  "Live color preview": "实时颜色预览",

  // Plan / Goal / Agents
  "Linked Plan": "关联计划",
  "Next handoff": "下一交接",
  "Linked goal": "关联目标",
  "No active goal": "无活动目标",
  "RESULT": "结果",
  "No messages recorded yet.": "暂无消息记录。",
  "Records come from the active Newmark conversation": "记录来自当前 Newmark 对话",

  // Tools
  "Tools & connectors": "工具与连接器",
  "Live runtime": "实时运行时",
  "Safety boundary": "安全边界",

  // Automation / Workflow
  "[+] New automation": "[+] 新建自动化",
  "[+] New workflow": "[+] 新建工作流",
  "No workflows configured.": "未配置工作流。",

  // Help
  "SHORTCUT GUIDE": "快捷键指南",
  "Navigation": "导航",
  "Conversation editing": "对话编辑",
  "Running work": "运行中的工作",
  "Operation content": "操作内容",
  "Global": "全局"
});

function resolveLanguage(state) {
  const value = String(state?.settings?.general?.language || "Auto");
  return value === "中文" || value === "zh" ? "zh" : "en";
}

function tr(state, text) {
  const value = String(text ?? "");
  if (resolveLanguage(state) === "zh") return ZH[value] || value;
  return value;
}

module.exports = { resolveLanguage, tr };
