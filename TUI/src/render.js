"use strict";

const data = require("./data");
const { filteredCommands, rootMenuItems, selectedMemoryDetail } = require("./state");
const { SETTINGS_CATEGORIES, displaySettingValue, settingsRows } = require("./settings-schema");

const ESC = "\u001b[";
const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;
const ANSI_TOKEN_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]|[\s\S]/gu;
const stripAnsi = (text) => String(text).replace(ANSI_PATTERN, "");
const ZERO_WIDTH_PATTERN = /\p{Mark}|\u200d|\ufe0e|\ufe0f/u;
const isWideCodePoint = (code) => (
  code >= 0x1100 && (
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
  )
);
const characterWidth = (character) => {
  const code = character.codePointAt(0) || 0;
  if (code === 0 || code < 0x20 || (code >= 0x7f && code < 0xa0) || ZERO_WIDTH_PATTERN.test(character)) return 0;
  return isWideCodePoint(code) ? 2 : 1;
};
const visibleLength = (text) => [...stripAnsi(text)].reduce((total, character) => total + characterWidth(character), 0);
const truncate = (text, width) => {
  const value = String(text);
  if (visibleLength(value) <= width) return value;
  const target = Math.max(0, width - 1);
  let visible = 0;
  let output = "";
  for (const token of value.match(ANSI_TOKEN_PATTERN) || []) {
    if (token.startsWith("\u001b[")) {
      output += token;
    } else if (visible + characterWidth(token) <= target) {
      output += token;
      visible += characterWidth(token);
    } else {
      break;
    }
  }
  return `${output}…${ESC}0m`;
};
const pad = (text, width) => {
  const value = truncate(text, width);
  return value + " ".repeat(Math.max(0, width - visibleLength(value)));
};

function wrapText(text, width) {
  const limit = Math.max(1, width);
  const rows = [];
  for (const sourceLine of String(text ?? "").split(/\r?\n/)) {
    if (!sourceLine) {
      rows.push("");
      continue;
    }
    let row = "";
    let rowWidth = 0;
    for (const character of sourceLine) {
      const nextWidth = characterWidth(character);
      if (row && rowWidth + nextWidth > limit) {
        rows.push(row);
        row = "";
        rowWidth = 0;
      }
      row += character;
      rowWidth += nextWidth;
    }
    rows.push(row);
  }
  return rows.length ? rows : [""];
}

function palette(state) {
  const dark = {
    reset: `${ESC}0m`, dim: `${ESC}2m`, bold: `${ESC}1m`, cyan: `${ESC}38;5;81m`,
    green: `${ESC}38;5;114m`, amber: `${ESC}38;5;221m`, red: `${ESC}38;5;203m`,
    text: `${ESC}38;5;252m`, muted: `${ESC}38;5;245m`, panel: `${ESC}48;5;235m`,
    selected: `${ESC}48;5;238m`, brand: `${ESC}38;5;159m`
  };
  const light = {
    reset: `${ESC}0m`, dim: `${ESC}2m`, bold: `${ESC}1m`, cyan: `${ESC}38;5;24m`,
    green: `${ESC}38;5;28m`, amber: `${ESC}38;5;130m`, red: `${ESC}38;5;160m`,
    text: `${ESC}38;5;235m`, muted: `${ESC}38;5;243m`, panel: `${ESC}48;5;254m`,
    selected: `${ESC}48;5;250m`, brand: `${ESC}38;5;25m`
  };
  const colors = state.theme === "light" ? light : dark;
  const appearance = state.settings?.personalization;
  if (!appearance || contrastRatio(appearance.fontColor, appearance.backgroundColor) < 4.5) {
    return { ...colors, paint: "", final: `${ESC}0m` };
  }
  const [fr, fg, fb] = hexRgb(appearance.fontColor);
  const [br, bg, bb] = hexRgb(appearance.backgroundColor);
  const paint = `${ESC}38;2;${fr};${fg};${fb}m${ESC}48;2;${br};${bg};${bb}m`;
  return {
    ...colors,
    text: `${ESC}38;2;${fr};${fg};${fb}m`,
    panel: paint,
    reset: `${ESC}0m${paint}`,
    paint,
    final: `${ESC}0m`
  };
}

function progress(value, width = 16) {
  const filled = Math.round((value / 100) * width);
  return `${"━".repeat(filled)}${"─".repeat(width - filled)}`;
}

function statusIcon(state, p) {
  if (state === "done" || state === "completed" || state === "passed") return `${p.green}✓${p.reset}`;
  if (state === "in_progress" || state === "working") return `${p.cyan}●${p.reset}`;
  if (state === "idle" || state === "queued" || state === "pending") return `${p.amber}○${p.reset}`;
  if (state === "error") return `${p.red}!${p.reset}`;
  return `${p.muted}–${p.reset}`;
}

function card(lines, width, p, title) {
  const inner = Math.max(8, width - 4);
  const output = [`${p.muted}┌─ ${p.bold}${title}${p.reset}${p.muted} ${"─".repeat(Math.max(0, inner - visibleLength(title) - 2))}┐${p.reset}`];
  for (const line of lines) output.push(`${p.muted}│${p.reset} ${pad(line, inner)} ${p.muted}│${p.reset}`);
  output.push(`${p.muted}└${"─".repeat(inner + 2)}┘${p.reset}`);
  return output;
}

function renderSidebar(state, height, width, p) {
  const lines = [`${p.brand}${p.bold}  NEWMARK${p.reset}`, `${p.muted}  Agent TUI · concept${p.reset}`, ""];
  const isFocused = (level, index) => state.focusRegion === "menu"
    && state.menuLevel === level
    && (level === "root" ? state.menuRootIndex : state.menuChildIndex[level]) === index;
  const addItem = (item, indent = 0, level = "root", index = 0, activeOverride) => {
    const active = activeOverride ?? state.view === item.id;
    const marker = active ? `${p.cyan}▌${p.reset}` : " ";
    const style = isFocused(level, index) ? `${p.selected}${p.bold}` : active ? p.bold : "";
    const prefix = " ".repeat(indent);
    lines.push(`${marker}${style} ${prefix}${item.icon}  ${pad(item.label, width - 7 - indent)}${p.reset}`);
  };
  const addGroup = (label, level, rootIndex, expanded, active, icon = "") => {
    const focused = isFocused("root", rootIndex);
    const marker = active ? `${p.cyan}▌${p.reset}` : " ";
    const style = focused ? `${p.selected}${p.bold}` : active ? p.bold : "";
    const chevron = expanded ? "▾" : "▸";
    lines.push(`${marker}${style} ${chevron} ${icon ? `${icon} ` : ""}${pad(label, width - 6 - (icon ? 2 : 0))}${p.reset}`);
  };
  const rootItems = rootMenuItems(state);
  lines.push(`${p.muted}  ROOT${p.reset}`);
  addItem(data.navigation[0], 0, "root", 0);
  lines.push("");
  lines.push(`${p.muted}  WORKSPACES${p.reset}`);
  state.workspaces.forEach((workspace, workspaceIndex) => {
    const rootIndex = workspaceIndex + 1;
    const level = `workspace:${workspace.id}`;
    const expanded = state.expandedWorkspaceIds.has(workspace.id);
    const active = state.target.workspaceId === workspace.id;
    addGroup(workspace.name, level, rootIndex, expanded, active, workspace.icon);
    if (expanded) {
      require("./state").workspaceMenuChildren(state, workspace.id)
        .forEach((item, index) => addItem(item, 2, level, index, active && state.view === item.id));
    }
  });
  lines.push("");
  lines.push(`${p.muted}  OPERATIONS${p.reset}`);
  const operations = data.navigation.filter((item) => item.section === "operations");
  operations.forEach((item, index) => {
    const rootIndex = 1 + state.workspaces.length + index;
    addItem(item, 0, "root", rootIndex);
  });
  while (lines.length < height - 6) lines.push("");
  const activeWorkspace = state.workspaces.find((item) => item.id === state.target.workspaceId);
  lines.push(`${p.muted}  ACTIVE TARGET${p.reset}`);
  lines.push(`  ${p.brand}${activeWorkspace?.icon || "◆"}${p.reset} ${truncate(activeWorkspace?.name || state.target.workspaceId, width - 5)}`);
  lines.push(`${p.muted}  ACTIVE CONVERSATION${p.reset}`);
  lines.push(`  ${p.cyan}↳${p.reset} ${truncate(state.lastConversation, width - 5)}`);
  lines.push(`${p.green}  ● local · ${state.adapterKind === "mock" ? "demo" : "Newmark core"}${p.reset}`);
  return lines.slice(0, height).map((line) => pad(line, width));
}

function conversationContext(state, p, scope) {
  const workspace = state.workspaces.find((item) => item.id === state.target.workspaceId);
  return [
    `${p.muted}Workspace / ${workspace?.name || state.target.workspaceId} / Conversation${p.reset}`,
    `${p.cyan}↳${p.reset} ${p.bold}${state.lastConversation}${p.reset}  ${p.muted}· ${scope}${p.reset}`,
    `${p.muted}${"─".repeat(42)}${p.reset}`,
    ""
  ];
}

function homeView(state, width, p) {
  const w = Math.max(24, width);
  const half = Math.floor((w - 2) / 2);
  const headline = [
    `${p.bold}Good evening.${p.reset} Your workspace is ready.`,
    `${p.muted}3 active threads · 1 running subagent · all local services healthy${p.reset}`,
    ""
  ];
  const stats = card([
    `${p.cyan}${p.bold}12${p.reset} conversations     ${p.green}${p.bold}97%${p.reset} success rate`,
    `${p.amber}${p.bold}3${p.reset} queued actions     ${p.bold}1.8s${p.reset} median response`,
    `${p.muted}Today · ${state.adapterKind === "mock" ? "mock metrics" : "persisted Newmark state"}${p.reset}`
  ], w, p, "Workspace pulse");
  const actions = [
    `${state.focusRegion === "content" && state.selected === 0 ? `${p.selected}${p.bold}` : ""} [N] New conversation     Start a focused agent thread ${p.reset}`,
    `${state.focusRegion === "content" && state.selected === 1 ? `${p.selected}${p.bold}` : ""} [P] Continue plan        Resume release readiness   ${p.reset}`,
    `${state.focusRegion === "content" && state.selected === 2 ? `${p.selected}${p.bold}` : ""} [A] Add automation       Schedule a recurring run   ${p.reset}`
  ];
  const activityLeft = card([
    `${p.green}✓${p.reset} Regression gate passed`,
    `${p.cyan}●${p.reset} release-audit is running`,
    `${p.muted}○${p.reset} Linux smoke is waiting`
  ], half, p, "Live activity");
  const activityRight = card([
    `Quality     ${progress(88, 10)} 88`,
    `Reliability ${progress(96, 10)} 96`,
    `Speed       ${progress(79, 10)} 79`
  ], w - half - 2, p, "Auto routing");
  const joined = activityLeft.map((line, i) => `${line}  ${activityRight[i] || ""}`);
  return [...headline, ...stats, "", `${p.bold}Quick actions${p.reset}`, ...actions, "", ...joined];
}

function chatView(state, width, height, p) {
  const narrow = width < 82;
  const listWidth = narrow ? 0 : 27;
  const detailWidth = width - listWidth - (listWidth ? 2 : 0);
  const left = listWidth ? [
    `${p.bold}Conversations${p.reset}`,
    `${p.muted}N new · / search${p.reset}`,
    "",
    ...state.snapshot.conversations.map((item, i) => {
      const style = state.focusRegion === "content" && i === state.selected && !state.inputMode ? `${p.selected}${p.bold}` : "";
      const running = state.runningConversationKeys?.has(`${state.target.workspaceId}::${item.id}`);
      const marker = running
        ? `${p.cyan}${["\\", "—", "/", "—"][state.tick % 4]}${p.reset}`
        : item.title === state.lastConversation
          ? `${p.cyan}›${p.reset}`
          : item.pinned
            ? `${p.amber}◆${p.reset}`
            : "·";
      const updated = String(item.updatedAt || "").slice(11, 16) || "—";
      return `${style}${marker} ${pad(item.title, 19)} ${p.muted}${updated}${p.reset}`;
    })
  ] : [];
  const preview = state.snapshot.conversations[state.selected] || state.snapshot.conversations[0] || {
    id: state.target.conversationId,
    title: state.lastConversation || "New conversation"
  };
  const isActive = preview.title === state.lastConversation;
  const workspace = state.workspaces.find((item) => item.id === state.target.workspaceId);
  const right = [
    `${p.muted}${workspace?.name || "Workspace"} / Conversations / ${isActive ? "Current" : "Preview"}${p.reset}`,
    `${p.bold}${preview.title}${p.reset}`,
    `${p.muted}${isActive ? "Current conversation" : "Enter to open this conversation"} · Enter edit · Tab conversations · Build${p.reset}`,
    `${p.muted}${"─".repeat(Math.max(8, detailWidth - 1))}${p.reset}`
  ];
  const available = Math.max(4, height - 10);
  state.messages.slice(-available).forEach((message) => {
    const roleName = message.role === "user" ? "YOU" : message.role === "assistant" ? "NEWMARK" : message.role.toUpperCase();
    const roleColor = message.role === "user" ? p.cyan : message.role === "assistant" ? p.brand : p.amber;
    const roleColumnWidth = 9;
    const messageWidth = Math.max(8, detailWidth - roleColumnWidth);
    const messageRows = wrapText(message.content, messageWidth);
    messageRows.forEach((row, index) => {
      const prefix = index === 0
        ? `${roleColor}${pad(roleName, roleColumnWidth - 2)}${p.reset}  `
        : " ".repeat(roleColumnWidth);
      right.push(`${prefix}${row}`);
    });
    if (message.meta) {
      wrapText(message.meta, messageWidth).forEach((row) => {
        right.push(`${" ".repeat(roleColumnWidth)}${p.muted}${row}${p.reset}`);
      });
    }
    right.push("");
  });
  if (state.busy) right.push(`${p.cyan}${["◐", "◓", "◑", "◒"][state.tick % 4]} Newmark is working…${p.reset}`);
  right.push(`${p.muted}${"─".repeat(Math.max(8, detailWidth - 1))}${p.reset}`);
  const cursor = state.inputMode ? `${p.cyan}▏${p.reset}` : "";
  right.push(`${state.inputMode ? p.selected : ""}${p.bold}>${p.reset} ${state.input || `${p.muted}${state.inputMode ? "Type a message · Enter to send · Tab back" : "Select a conversation · Enter to edit"}${p.reset}`}${cursor}`);
  if (!listWidth) return right;
  const count = Math.max(left.length, right.length);
  return Array.from({ length: count }, (_, i) => `${pad(left[i] || "", listWidth)}  ${right[i] || ""}`);
}

function planView(state, width, p) {
  const planItems = state.snapshot.conversationPlan.items;
  const goal = state.snapshot.goal;
  const lines = [
    ...conversationContext(state, p, "Conversation plan"),
    `${p.bold}Linked Plan · rev ${state.snapshot.linkedPlan.revision}${p.reset}   ${p.cyan}${planItems.filter((item) => item.status === "done").length} / ${planItems.length} steps${p.reset}`,
    "",
    ...planItems.map((item, i) => {
      const style = state.focusRegion === "content" && i === state.selected ? `${p.selected}${p.bold}` : "";
      return `${style} ${statusIcon(item.status, p)}  ${pad(item.text, Math.max(18, width - 28))} ${p.muted}${item.status}${p.reset}`;
    }),
    "",
    ...card([
      `${p.bold}Next handoff${p.reset}`,
      "Finish the Windows package smoke, then unblock the Linux lane.",
      `${p.muted}${state.adapterKind === "mock" ? "Enter opens the selected demo step" : "Plan and goal are loaded from the active Newmark conversation"}${p.reset}`
    ], width, p, "Linked goal")
  ];
  return lines;
}

function goalView(state, width, p) {
  const goal = state.snapshot.goal;
  return [
    ...conversationContext(state, p, "Conversation goal"),
    `${p.bold}Goal${p.reset}   ${goal?.paused ? `${p.amber}paused${p.reset}` : `${p.green}active${p.reset}`}`,
    "",
    `${p.brand}${p.bold}${goal?.objective || "No active goal"}${p.reset}`,
    "",
    `Rounds      ${goal?.goalRounds || 0}`,
    `Verified    ${goal?.verified ? "yes" : "no"}`,
    `Changes     ${goal?.changes?.length || 0}`,
    "",
    `${p.muted}This bar follows ${state.lastConversation}; it is hidden from the workspace menu when no goal exists.${p.reset}`
  ];
}

function agentsView(state, width, p) {
  return [
    ...conversationContext(state, p, "Conversation subagents"),
    `${p.bold}Subagents${p.reset}   ${p.muted}Parallel work with isolated context${p.reset}`,
    "",
    ...state.snapshot.subagents.flatMap((agent, i) => {
      const style = state.focusRegion === "content" && i === state.selected ? `${p.selected}` : "";
      return [
        `${style} ${statusIcon(agent.status, p)} ${p.bold}${pad(agent.displayName, 18)}${p.reset} ${pad(agent.task, Math.max(12, width - 47))} ${p.muted}${agent.status}${p.reset}`,
        `   ${p.cyan}${progress(agent.progress, Math.min(24, Math.max(8, width - 30)))}${p.reset} ${String(agent.progress).padStart(3)}%`
      ];
    }),
    "",
      `${p.muted}Enter opens details · ${state.adapterKind === "mock" ? "execution controls are simulated" : "records come from the active Newmark conversation"}${p.reset}`
  ];
}

function modelView(state, width, p) {
  const { conversationModelOptions } = require("./state");
  const options = conversationModelOptions(state);
  const current = state.snapshot.modelSelection || { kind: "auto" };
  const isCurrent = (selection) => selection.kind === current.kind
    && (selection.kind === "auto"
      || (selection.providerId === current.providerId && selection.modelId === current.modelId));
  return [
    ...conversationContext(state, p, "Conversation model"),
    `${p.bold}Model${p.reset}   ${p.muted}Used by this conversation, including its Plan and Subagents${p.reset}`,
    "",
    ...options.flatMap((option, index) => {
      const style = state.focusRegion === "content" && index === state.selected ? `${p.selected}${p.bold}` : "";
      const marker = isCurrent(option.selection) ? `${p.cyan}●${p.reset}` : "○";
      return [
        `${style} ${marker} ${pad(option.label, Math.max(18, Math.min(32, width - 24)))} ${p.muted}${option.provider}${p.reset}`,
        `   ${p.muted}${truncate(option.description, Math.max(20, width - 5))}${p.reset}`
      ];
    }),
    "",
    `${p.muted}Enter selects for ${state.lastConversation}. Other conversations keep their own model selection.${p.reset}`
  ];
}

function flowBarView(state, width, p) {
  const workflow = state.currentFlow;
  return [
    ...conversationContext(state, p, "Flow bar"),
    `${p.bold}Flow Bar${p.reset}   ${p.green}● tracked${p.reset}`,
    "",
    `${p.brand}${p.bold}${workflow?.name || "No workflow selected"}${p.reset}`,
    `${p.muted}Mode ${state.snapshot.mode} · current task ${Number(workflow?.pc || 0) + 1} / ${workflow?.components?.length || 0}${p.reset}`,
    "",
    `${p.cyan}${progress(workflow?.components?.length ? ((Number(workflow.pc || 0) + 1) / workflow.components.length) * 100 : 0, Math.max(12, Math.min(48, width - 12)))}${p.reset}`,
    "",
    `${p.muted}Shift+Tab in the editor switches modes. Entering Flow always requires a workflow choice.${p.reset}`
  ];
}

function flowListView(state, width, p) {
  return [
    ...conversationContext(state, p, "Flow list"),
    `${p.bold}Flow List${p.reset}   ${p.muted}Available workflows for this tracked conversation${p.reset}`,
    "",
    ...state.flows.map((name, index) => {
      const selected = state.currentFlow?.name === name;
      const style = state.focusRegion === "content" && index === state.selected ? `${p.selected}${p.bold}` : "";
      return `${style} ${selected ? `${p.cyan}●${p.reset}` : "○"} ${pad(name, Math.max(18, width - 8))}`;
    })
  ];
}

function flowTaskView(state, width, p) {
  const components = state.currentFlow?.components || [];
  return [
    ...conversationContext(state, p, "Flow task"),
    `${p.bold}Flow Task${p.reset}   ${p.muted}${state.currentFlow?.name || "No workflow"}${p.reset}`,
    "",
    ...components.flatMap((component, index) => {
      const style = state.focusRegion === "content" && index === state.selected ? `${p.selected}${p.bold}` : "";
      const mode = component.type === "logic" ? "LOGIC" : String(component.mode || "BUILD").toUpperCase();
      return [
        `${style} ${String(component.id).padStart(2)}  ${pad(mode, 7)} ${truncate(component.prompt, Math.max(18, width - 16))}`,
        component.type === "logic" ? `     ${p.muted}true → ${component.goto_true} · false → ${component.goto_false}${p.reset}` : ""
      ].filter(Boolean);
    })
  ];
}

function toolsView(state, width, p) {
  const real = state.adapterKind !== "mock";
  return [
    `${p.bold}Tools & connectors${p.reset}   ${p.muted}Enter toggles ${real ? "Newmark native-tool config" : "access in this demo"}${p.reset}`,
    "",
    `${p.muted}  STATE  TOOL                 SOURCE              CALLS${p.reset}`,
    ...state.tools.map((tool, i) => {
      const style = state.focusRegion === "content" && i === state.selected ? `${p.selected}${p.bold}` : "";
      const stateLabel = tool.enabled ? `${p.green} ON ${p.reset}` : `${p.muted}OFF ${p.reset}`;
      return `${style}  ${stateLabel}   ${pad(tool.name, 20)} ${pad(tool.group, Math.max(12, width - 48))} ${String(tool.calls).padStart(5)}${p.reset}`;
    }),
    "",
    ...card([
      real ? "Tool availability is loaded from the active Newmark config." : "Tool calls are represented for interaction design only.",
      real ? "Agent prompts may execute enabled tools under Newmark's existing approval policy." : "No shell, file, browser, network, or connector action is available here."
    ], width, p, real ? "Live runtime" : "Safety boundary")
  ];
}

function automationView(state, width, p) {
  return [
    `${p.bold}Automations${p.reset}   ${p.muted}Schedules bound to explicit workspaces${p.reset}`,
    "",
    ...state.automations.flatMap((job, i) => {
      const style = state.focusRegion === "content" && i === state.selected ? `${p.selected}${p.bold}` : "";
      return [
        `${style} ${job.enabled ? `${p.green}● ACTIVE${p.reset}` : `${p.muted}○ PAUSED${p.reset}`}  ${pad(job.name, 24)} ${p.muted}${job.schedule}${p.reset}`,
        `           Last run: ${job.last}`
      ];
    }),
    "",
    `${p.muted}Enter pauses/resumes · ${state.adapterKind === "mock" ? "simulated" : "Newmark-backed"} automation${p.reset}`
  ];
}

function memoryView(state, width, p) {
  const index = state.memoryLab.index;
  const detail = selectedMemoryDetail(state);
  const tags = Object.keys(index.tags).sort();
  const roots = tags.filter((tag) => !(index.tags[tag].parents || []).length);
  const parents = detail.node.parents.length ? [...detail.node.parents].sort() : roots;
  const children = [...detail.node.children].sort();
  const relationWidth = Math.max(10, Math.floor((width - 6) / 3));
  const relationColumn = (title, values, column) => [
    `${p.bold}${title}${p.reset}`,
    ...(
      values.length
        ? values.map((tag, row) => {
          const focused = state.focusRegion === "content"
            && state.contentColumn === column
            && (state.memoryColumnIndices[column] || 0) === row;
          const count = index.tags[tag]?.components?.length || 0;
          return `${focused ? `${p.selected}${p.bold}` : ""}> ${pad(tag, relationWidth - 7)} ${p.muted}${String(count).padStart(2)}${p.reset}`;
        })
        : [`${p.muted}— none —${p.reset}`]
    )
  ];
  const parentRows = relationColumn(detail.node.parents.length ? "Parent tags" : "Root tags", parents, 0);
  const selectedRows = relationColumn("Selected tag", detail.tag ? [detail.tag] : [], 1);
  const childRows = relationColumn("Child tags", children, 2);
  const relationRows = Array.from(
    { length: Math.max(parentRows.length, selectedRows.length, childRows.length) },
    (_, row) => `${pad(parentRows[row] || "", relationWidth)} ${p.muted}│${p.reset} ${pad(selectedRows[row] || "", relationWidth)} ${p.muted}│${p.reset} ${childRows[row] || ""}`
  );
  const componentWidth = Math.min(34, Math.max(20, Math.floor(width * 0.38)));
  const componentNames = detail.componentSlugs.map((slug, row) => {
    const meta = state.memoryLab.index.components[slug];
    const selected = row === state.memoryComponentIndex;
    const focused = state.focusRegion === "content" && state.contentColumn === 3
      && (state.memoryColumnIndices[3] || 0) === row;
    const marker = selected ? `${p.cyan}>${p.reset}` : "·";
    return `${focused ? `${p.selected}${p.bold}` : ""}${marker} ${meta?.name || slug}${p.reset}`;
  });
  const contentLines = detail.content.split(/\r?\n/).filter(Boolean).slice(0, 7);
  const components = [
    `${p.bold}Memory components${p.reset}`,
    ...(componentNames.length ? componentNames : [`${p.muted}No memory components${p.reset}`])
  ];
  const preview = [
    `${p.bold}Core memory${p.reset}`,
    `${p.bold}${detail.component?.name || "No component selected"}${p.reset}`,
    `${p.muted}${detail.component?.description || ""}${p.reset}`,
    ...contentLines,
    `${p.muted}Updated ${detail.component?.updatedAt || index.updatedAt} · revision ${detail.component?.revision || 0}${p.reset}`
  ];
  const detailRows = Array.from(
    { length: Math.max(components.length, preview.length) },
    (_, row) => `${pad(components[row] || "", componentWidth)} ${p.muted}│${p.reset} ${preview[row] || ""}`
  );
  return [
    `${p.bold}Memory Lab${p.reset}   ${p.muted}Overview${p.reset}  ${p.selected}${p.bold} Detail ${p.reset}   ${p.muted}Search tags · Reindex${p.reset}`,
    `${p.muted}Newmark detail layout · ←/→ columns · ↑/↓ select · Enter follow/select${p.reset}`,
    `${p.muted}${"─".repeat(Math.max(8, width - 1))}${p.reset}`,
    ...relationRows,
    "",
    ...detailRows,
    "",
    `${p.amber}SIMULATED${p.reset}  ${p.muted}memoryLabVisualization() + memoryLabRead() shapes; no disk read${p.reset}`
  ];
}

function settingsView(state, width, p) {
  const categories = SETTINGS_CATEGORIES;
  const leftWidth = Math.min(22, Math.max(18, Math.floor(width * 0.24)));
  const categoryRows = [
    `${p.bold}Settings${p.reset}`,
    `${p.muted}Categories${p.reset}`,
    "",
    ...categories.map(({ id, icon, label }, index) => {
      const focused = state.focusRegion === "content" && state.contentColumn === 0 && state.settingsCategoryIndex === index;
      const active = state.settingsTab === id;
      return `${focused ? `${p.selected}${p.bold}` : active ? p.bold : ""}${active ? `${p.cyan}>${p.reset}` : " "} ${icon} ${label}${p.reset}`;
    }),
    "",
    `${p.muted}→ enter section${p.reset}`,
    `${p.muted}← return to menu${p.reset}`
  ];
  const header = [
    `${p.bold}${categories[state.settingsCategoryIndex].label} settings${p.reset}`,
    `${p.muted}${categories[state.settingsCategoryIndex].source}${p.reset}`,
    `${p.muted}← categories · ↑/↓ select · Enter toggle · V validate model${p.reset}`,
    ""
  ];
  let detailRows;
  if (state.settingsTab === "providers") {
    detailRows = [
      ...header,
      `${p.muted}  STATE  PROVIDER               PROTOCOL       KEY   MODELS${p.reset}`,
      ...state.providers.map((provider, index) => {
        const style = state.focusRegion === "content" && state.contentColumn === 1 && index === state.selected ? `${p.selected}${p.bold}` : "";
        const enabled = provider.enabled ? `${p.green} ON ${p.reset}` : `${p.muted}OFF ${p.reset}`;
        const key = provider.has_api_key ? `${p.green}set${p.reset}` : `${p.amber}none${p.reset}`;
        return `${style}  ${enabled}   ${pad(provider.name, 22)} ${pad(provider.protocol, 14)} ${key}   ${String(provider.models.length).padStart(3)}${p.reset}`;
      }),
      "",
      `${p.muted}Enter calls ${state.adapterKind === "mock" ? "the mock" : "Newmark"} setProviderEnabled(providerId, enabled).${p.reset}`,
      `${p.amber}SIMULATED${p.reset}  API keys are never present; only has_api_key is rendered.`
    ];
  } else if (state.settingsTab === "models") {
    const models = state.providers.flatMap((provider) => provider.models.map((model) => ({ provider, model })));
    detailRows = [
      ...header,
      `${p.muted}  STATE  MODEL                    PROVIDER          VALIDATION        CTX${p.reset}`,
      ...models.map((entry, index) => {
        const style = state.focusRegion === "content" && state.contentColumn === 1 && index === state.selected ? `${p.selected}${p.bold}` : "";
        const enabled = entry.model.enabled !== false && entry.provider.enabled;
        const stateLabel = enabled ? `${p.green} ON ${p.reset}` : `${p.muted}OFF ${p.reset}`;
        const validation = entry.model.validation || {};
        return `${style}  ${stateLabel}   ${pad(entry.model.display || entry.model.name, 24)} ${pad(entry.provider.name, 18)} ${pad(`${validation.status || "unchecked"}/${validation.level || "—"}`, 17)} ${String(entry.model.max_tokens).padStart(7)}${p.reset}`;
      }),
      "",
      state.validationNotice ? `${p.cyan}${state.validationNotice}${p.reset}` : `${p.muted}V runs ${state.adapterKind === "mock" ? "mock" : "provider-backed"} validateModels([modelName]).${p.reset}`,
      `${p.amber}SIMULATED${p.reset}  No provider request or config write is performed.`
    ];
  } else if (state.settingsTab === "tools") {
    detailRows = [
      ...header,
      `${p.muted}  STATE  TOOL                    GROUP             CALLS${p.reset}`,
      ...state.tools.map((tool, index) => {
        const style = state.focusRegion === "content" && state.contentColumn === 1 && index === state.selected ? `${p.selected}${p.bold}` : "";
        return `${style}  ${tool.enabled ? `${p.green} ON ${p.reset}` : `${p.muted}OFF ${p.reset}`}   ${pad(tool.name, 23)} ${pad(tool.group, 17)} ${String(tool.calls).padStart(5)}${p.reset}`;
      }),
      "",
      `${p.amber}SIMULATED${p.reset}  Enter prepares saveConfig({ nativeTools }).`
    ];
  } else {
    const rows = settingsRows(state);
    detailRows = [
      ...header,
      ...rows.flatMap((row, i) => {
        const style = state.focusRegion === "content" && state.contentColumn === 1 && i === state.selected ? `${p.selected}` : "";
        return [
          `${style} ${p.bold}${pad(row.label, 27)}${p.reset} ${p.cyan}${displaySettingValue(row.value)}${p.reset}${row.extension ? ` ${p.amber}TUI EXTENSION${p.reset}` : ""}`,
          `   ${p.muted}${settingDescription(state.settingsTab, row.key)}${p.reset}`
        ];
      }),
      "",
      ...(state.settingsTab === "personalization" ? personalizationPreview(state, p) : []),
      `${p.muted}${settingsActionHint(state.settingsTab)}${p.reset}`,
      `${p.amber}SIMULATED${p.reset}  Changes remain in process memory; adapter payloads match integration targets.`
    ];
  }
  const count = Math.max(categoryRows.length, detailRows.length);
  return Array.from(
    { length: count },
    (_, row) => `${pad(categoryRows[row] || "", leftWidth)} ${p.muted}│${p.reset} ${detailRows[row] || ""}`
  );
}

function settingDescription(tab, key) {
  const descriptions = {
    language: "Main UI and preferred Agent reply language.",
    inputBehavior: "Guide sends now; Next queues after the current run.",
    dialogStyle: "Formal concise or friendly relaxed responses.",
    feedbackLevel: "Controls how often Newmark asks before choosing.",
    closeBehavior: "Close the application or keep it in the tray.",
    expandTools: "Default expansion state for completed tool blocks.",
    theme: "Dark, light, or system appearance.",
    fontFamily: "Host font request; terminal support depends on the terminal application.",
    fontColor: "Proposed TUI foreground field; desktop state hydration still needs adding.",
    backgroundColor: "Six-digit application-shell background color.",
    glassAlpha: "Desktop glass opacity; terminal preview is representative.",
    backend: "Run the Agent kernel on Windows or WSL; restart required.",
    wslDistro: "Distribution used by the WSL Agent backend.",
    terminalTimeout: "Upper cap for shell timeout and forced interruption.",
    defaultShell: "Default shell identifier passed to terminal sessions.",
    autoArchive: "Automatically create cold records for completed work.",
    retentionDays: "Retention policy prepared under archive settings.",
    includeMemory: "Include Memory Lab metadata in archive exports.",
    exportFormat: "Default archive export representation.",
    channel: "Stable or prerelease update stream.",
    autoCheck: "Check for updates during application startup.",
    autoDownload: "Download only after a successful simulated check.",
    source: "GitHub release or local package source."
  };
  return descriptions[key] || `${tab} setting`;
}

function hexRgb(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value || ""));
  if (!match) return [230, 234, 242];
  return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
}

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = hexRgb(hex).map((value) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function personalizationPreview(state, p) {
  const appearance = state.settings.personalization;
  const [fr, fg, fb] = hexRgb(appearance.fontColor);
  const [br, bg, bb] = hexRgb(appearance.backgroundColor);
  const sample = `${ESC}38;2;${fr};${fg};${fb}m${ESC}48;2;${br};${bg};${bb}m Newmark Aa 中 123 ${p.reset}`;
  const contrast = contrastRatio(appearance.fontColor, appearance.backgroundColor);
  return [
    `${p.bold}Live color preview${p.reset}  ${sample}`,
    `${p.muted}Font request: ${appearance.fontFamily} · contrast ${contrast.toFixed(2)}:1 ${contrast >= 4.5 ? "PASS" : "LOW"}${p.reset}`,
    `${p.muted}A TUI cannot force the terminal host to change its font face.${p.reset}`,
    ""
  ];
}

function settingsActionHint(tab) {
  if (tab === "general") return "O open global config · R refresh config";
  if (tab === "archive") return "L list archive inventory";
  if (tab === "updates") return "U check version and GitHub update";
  return "Enter cycles or toggles the selected setting";
}

function helpView(state, width, p) {
  return [
    `${p.brand}${p.bold}SHORTCUT GUIDE${p.reset}   ${p.muted}Context-aware TUI controls${p.reset}`,
    `${p.muted}${"─".repeat(Math.max(20, width - 1))}${p.reset}`,
    "",
    `${p.bold}Navigation${p.reset}`,
    "  ↑ / ↓       Move within the current menu level or list",
    "  ← / →       Move between menu levels and content columns",
    "  Enter       Expand workspace, open view, select conversation, or confirm",
    "  Tab         From editor: conversation selection; from content: left menu",
    "",
    `${p.bold}Conversation editing${p.reset}`,
    "  Enter       Edit selected conversation / send current draft",
    "  Shift+Tab   Cycle Build → Plan → Goal → Flow",
    "  Flow        Requires ↑ / ↓ + Enter workflow selection before editing",
    "  T           Pin / unpin selected conversation; cursor follows its ID",
    "",
    `${p.bold}Running work${p.reset}`,
    "  \\ — / —     Rotating left marker means that conversation is running",
    "  Esc         Request graceful stop for the focused running conversation",
    "  Esc again   Force-stop that same conversation",
    "  Switching focus never interrupts background conversations",
    "",
    `${p.bold}Global${p.reset}`,
    "  Ctrl+K      Command palette",
    "  N           New conversation",
    "  T           Toggle theme outside conversation selection",
    "  ?           Quick help overlay",
    "  Q / Ctrl+C  Quit"
  ];
}

function renderContent(state, width, height, p) {
  const views = {
    home: homeView,
    chat: (s, w, colors) => chatView(s, w, height, colors),
    plan: planView,
    goal: goalView,
    agents: agentsView,
    model: modelView,
    flowbar: flowBarView,
    flowlist: flowListView,
    flowtask: flowTaskView,
    tools: toolsView,
    memory: memoryView,
    automation: automationView,
    settings: settingsView,
    help: helpView
  };
  return views[state.view](state, width, p);
}

function overlayLines(state, width, p) {
  if (state.overlay === "help") {
    return card([
      `${p.bold}Menu${p.reset}        ↑↓ visible tree   Enter expand/collapse/open`,
      `${p.bold}Focus${p.reset}       ←/→ move columns; only leftmost content returns to menu`,
      `${p.bold}Actions${p.reset}     ↑↓ select   Enter open/toggle/follow   V validate`,
      `${p.bold}Compose${p.reset}     Enter on a conversation edits   Tab returns to conversation selection`,
      `${p.bold}Global${p.reset}      Ctrl+K commands   T theme   ? help   Q quit`,
      `${p.bold}Editing${p.reset}     Enter send   Backspace delete   Esc stop / Esc again force-stops`,
      "",
      `${p.muted}${state.adapterKind === "mock" ? "Demo mode uses isolated in-memory data." : "Actions are bound to the active Newmark Conversation target."}${p.reset}`,
      `${p.cyan}Press Esc or ? to close${p.reset}`
    ], Math.min(78, width - 4), p, "Keyboard shortcuts");
  }
  if (state.overlay === "palette") {
    const commands = filteredCommands(state);
    const rows = [
      `${p.bold}>${p.reset} ${state.paletteQuery}${p.cyan}▏${p.reset}`,
      `${p.muted}${"─".repeat(Math.max(8, Math.min(64, width - 10)))}${p.reset}`,
      ...(commands.length ? commands.slice(0, 7).map((command, i) => {
        const style = i === state.paletteIndex ? `${p.selected}${p.bold}` : "";
        return `${style} ${pad(command.label, Math.max(18, Math.min(52, width - 18)))} ${p.muted}${command.hint}${p.reset}`;
      }) : [`${p.muted} No matching commands${p.reset}`]),
      "",
      `${p.muted}Type to filter · ↑↓ choose · Enter run · Esc close${p.reset}`
    ];
    return card(rows, Math.min(72, width - 4), p, "Command palette");
  }
  if (state.overlay === "flow-select") {
    return card([
      `${p.bold}Flow mode requires a workflow${p.reset}`,
      `${p.muted}This selection is bound to ${state.lastConversation}.${p.reset}`,
      "",
      ...(state.flows.length
        ? state.flows.map((name, index) => {
          const style = index === state.flowSelectionIndex ? `${p.selected}${p.bold}` : "";
          return `${style} ${index === state.flowSelectionIndex ? "›" : " "} ${name}${p.reset}`;
        })
        : [`${p.amber}No workflows are configured in ~/.Newmark/Flow.${p.reset}`]),
      "",
      `${p.cyan}↑↓ select · Enter confirm${p.reset}`
    ], Math.min(72, width - 4), p, "Select workflow");
  }
  if (state.overlay === "details") {
    return card([
      `${p.bold}Mock detail panel${p.reset}`,
      "This interaction would open a focused inspector in the integrated TUI.",
      "For the prototype it proves modal focus, dismissal, and context handoff.",
      "",
      `${p.cyan}Press Esc or Enter to close${p.reset}`
    ], Math.min(68, width - 4), p, "Details");
  }
  return [];
}

function render(state, columns = process.stdout.columns || 100, rows = process.stdout.rows || 30) {
  const p = palette(state);
  const width = Math.max(52, columns);
  const height = Math.max(20, rows);
  const compact = width < 78;
  const sidebarWidth = compact ? 0 : 22;
  const contentWidth = width - sidebarWidth - 2;
  const bodyHeight = height - 3;
  const sidebar = sidebarWidth ? renderSidebar(state, bodyHeight, sidebarWidth, p) : [];
  const content = renderContent(state, contentWidth, bodyHeight, p);
  const body = Array.from({ length: bodyHeight }, (_, i) => {
    const left = sidebarWidth ? `${pad(sidebar[i] || "", sidebarWidth)}${p.muted}│${p.reset} ` : "";
    return `${left}${pad(content[i] || "", contentWidth)}`;
  });
  const activeNav = data.navigation.find((item) => item.id === state.view);
  const compactContext = ["chat", "plan", "agents"].includes(state.view)
    ? ` · ${truncate(state.lastConversation, 18)}`
    : "";
  const top = compact
    ? `${p.panel}${p.bold} NEWMARK ${p.reset}${p.panel}${p.muted} ${activeNav.icon} ${activeNav.label}${compactContext}${" ".repeat(Math.max(0, width - visibleLength(activeNav.label) - visibleLength(compactContext) - 15))}${p.reset}`
    : "";
  if (compact) body.unshift(pad(top, width));
  const focus = state.focusRegion === "menu" ? "MENU" : "CONTENT";
  const footer = `${p.panel} ${p.cyan}${focus}${p.reset}${p.panel}${p.muted} · ${truncate(state.notice, width - 42)}${p.reset}${p.panel}${" ".repeat(Math.max(1, width - visibleLength(state.notice) - visibleLength(focus) - 35))}Tab back  ? help  Q quit ${p.reset}`;
  const renderedBody = body.slice(0, height - 1);
  while (renderedBody.length < height - 1) renderedBody.push(pad("", width));
  let output = `${ESC}?25l${ESC}2J${ESC}H${p.paint}${renderedBody.join("\n")}\n${pad(footer, width)}`;
  const overlay = overlayLines(state, width, p);
  if (overlay.length) {
    const overlayWidth = Math.max(...overlay.map(visibleLength));
    const x = Math.max(1, Math.floor((width - overlayWidth) / 2) + 1);
    const y = Math.max(2, Math.floor((height - overlay.length) / 2));
    overlay.forEach((line, index) => {
      output += `${ESC}${y + index};${x}H${line}`;
    });
  }
  return `${output}${p.final}`;
}

module.exports = { render, stripAnsi, visibleLength, wrapText };
