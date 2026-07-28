"use strict";

const readline = require("node:readline");
const path = require("node:path");
const data = require("./data");
const { render } = require("./render");
const {
  activateMenu,
  activateMemorySelection,
  applyConversationResult,
  applyThemeAppearance,
  applySnapshot,
  createState,
  cycleConversationMode,
  enterConversation,
  filteredCommands,
  moveFocusHorizontal,
  moveMenuSelection,
  moveSelection,
  markConversationRunning,
  returnToConversationSelection,
  requestConversationStop,
  runSettingsAction,
  selectConversationModel,
  selectFlowWorkflow,
  switchView,
  toggleConversationPinned,
  toggleSelected,
  validateSelectedModel
} = require("./state");

const ESC = "\u001b[";

function executeAction(state, action) {
  if (action.startsWith("view:")) {
    switchView(state, action.slice(5));
  } else if (action === "new-chat") {
    switchView(state, "chat");
    if (state.adapterKind !== "mock" && typeof state.adapter.createConversation === "function") {
      applySnapshot(state, state.adapter.createConversation());
      state.lastConversation = "New conversation";
      state.notice = "New conversation created in the current workspace";
    } else {
      state.target = { ...state.target, conversationId: "new-conversation" };
      state.lastConversation = "Untitled conversation";
      state.notice = "New draft conversation · demo memory only";
    }
    state.inputMode = true;
    state.input = "";
  } else if (action === "theme") {
    const appearance = applyThemeAppearance(state, state.theme === "dark" ? "Light" : "Dark");
    state.adapter.saveConfig(appearance);
    state.notice = `${state.theme === "dark" ? "Dark" : "Light"} terminal theme`;
  } else if (action === "help") {
    state.overlay = "help";
  }
}

function start(options = {}) {
  const forcedTerminal = process.env.NEWMARK_FORCE_TTY === "1";
  if ((!process.stdin.isTTY || !process.stdout.isTTY) && !forcedTerminal) {
    process.stderr.write("Newmark TUI requires an interactive terminal.\n");
    process.exitCode = 1;
    return;
  }

  const args = process.argv.slice(2);
  const optionValue = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : "";
  };
  let adapter;
  try {
    if (args.includes("--demo") || process.env.NEWMARK_TUI_DEMO === "1") {
      adapter = require("./adapters/mock-newmark-adapter").createMockNewmarkAdapter();
    } else {
      const root = options.root || optionValue("--root");
      const workspacePath = options.workspacePath || optionValue("--workspace");
      adapter = require("./adapters/core-runtime-adapter").createCoreRuntimeAdapter({
        root: root ? path.resolve(root) : undefined,
        workspacePath: workspacePath ? path.resolve(workspacePath) : process.cwd(),
        desktopDist: options.desktopDist
      });
    }
  } catch (error) {
    process.stderr.write(`Unable to start Newmark TUI runtime: ${error.message}\n`);
    process.stderr.write("Run DESKTOP build first, or use --demo for the isolated prototype.\n");
    process.exitCode = 1;
    return;
  }
  const state = createState({ adapter });
  let timer = null;
  let animationTimer = null;
  let closing = false;
  const paint = () => process.stdout.write(render(state));
  const cleanup = () => {
    if (timer) clearInterval(timer);
    if (animationTimer) clearInterval(animationTimer);
    if (typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${ESC}?25h${ESC}0m${ESC}2J${ESC}H`);
  };
  const quit = () => {
    if (closing) return;
    closing = true;
    cleanup();
    if (typeof state.adapter.close === "function") state.adapter.close();
    process.stdout.write(state.adapterKind === "mock"
      ? "Newmark TUI demo closed. No state was saved.\n"
      : "Newmark TUI closed. Conversation and settings state are persisted by Newmark.\n");
    process.exitCode = 0;
    setImmediate(() => process.exit(0));
  };

  function simulateReply(text) {
    state.messages.push({
      messageId: `demo-user-${Date.now()}`,
      role: "user",
      content: text,
      mode: state.snapshot.mode,
      model: "auto",
      timestamp: new Date().toISOString()
    });
    state.input = "";
    state.inputMode = false;
    state.busy = true;
    state.notice = "Simulating model route and tool handoff…";
    paint();
    let step = 0;
    timer = setInterval(() => {
      state.tick += 1;
      step += 1;
      if (step >= 8) {
        clearInterval(timer);
        timer = null;
        state.busy = false;
        state.messages.push({
          messageId: `demo-assistant-${Date.now()}`,
          role: "assistant",
          content: "This is a simulated response. In the integrated version I would route the request, show tool approvals, stream progress, and preserve the Build in this conversation.",
          mode: state.snapshot.mode,
          model: "auto",
          timestamp: new Date().toISOString(),
          meta: `${state.settings.general.dialogStyle} · demo · no tokens used`
        });
        state.notice = "Mock response complete · no network request made";
      }
      paint();
    }, 130);
  }

  async function sendRealMessage(text) {
    const target = { ...state.target };
    state.input = "";
    state.inputMode = false;
    markConversationRunning(state, target, true);
    state.notice = "Running Newmark Agent…";
    if (!animationTimer) {
      animationTimer = setInterval(() => {
        state.tick += 1;
        if (state.runningConversationKeys.size === 0) {
          clearInterval(animationTimer);
          animationTimer = null;
        }
        paint();
      }, 160);
    }
    paint();
    try {
      const snapshot = await state.adapter.sendMessage(text, target);
      applyConversationResult(state, target, snapshot);
    } catch (error) {
      markConversationRunning(state, target, false);
      state.notice = `Agent error: ${error.message}`;
      paint();
    }
  }

  function activate() {
    if (state.view === "home") {
      if (state.selected === 0) executeAction(state, "new-chat");
      else if (state.selected === 1) switchView(state, "plan");
      else switchView(state, "automation");
    } else if (state.view === "chat") {
      enterConversation(state);
    } else if (state.view === "model") {
      selectConversationModel(state);
    } else if (state.view === "flowlist") {
      state.flowSelectionIndex = state.selected;
      selectFlowWorkflow(state);
    } else if (state.view === "memory") {
      activateMemorySelection(state);
    } else if (state.view === "tools" || state.view === "automation" || state.view === "settings") {
      if (state.view === "settings" && state.contentColumn === 0) {
        moveFocusHorizontal(state, 1);
        return;
      }
      toggleSelected(state);
    } else if (state.view === "plan") {
      const step = state.snapshot.conversationPlan.items[state.selected];
      state.notice = step
        ? `Plan step selected: ${step.text} · ${state.adapterKind === "mock" ? "demo" : "persisted conversation"}`
        : "No plan step in the active conversation";
      state.overlay = "details";
    } else {
      state.overlay = "details";
    }
  }

  function handlePalette(str, key) {
    const commands = filteredCommands(state);
    if (key.name === "escape") {
      state.overlay = null;
      state.paletteQuery = "";
    } else if (key.name === "up") {
      state.paletteIndex = (state.paletteIndex - 1 + Math.max(1, commands.length)) % Math.max(1, commands.length);
    } else if (key.name === "down") {
      state.paletteIndex = (state.paletteIndex + 1) % Math.max(1, commands.length);
    } else if (key.name === "return") {
      const command = commands[state.paletteIndex];
      state.overlay = null;
      state.paletteQuery = "";
      state.paletteIndex = 0;
      if (command) executeAction(state, command.action);
    } else if (key.name === "backspace") {
      state.paletteQuery = [...state.paletteQuery].slice(0, -1).join("");
      state.paletteIndex = 0;
    } else if (str && !key.ctrl && !key.meta && str >= " ") {
      state.paletteQuery += str;
      state.paletteIndex = 0;
    }
  }

  function handleInput(str, key) {
    if (key.name === "tab" && key.shift) {
      cycleConversationMode(state);
    } else if (key.name === "escape") {
      Promise.resolve(requestConversationStop(state)).finally(paint);
    } else if (key.name === "tab") {
      returnToConversationSelection(state);
    } else if (key.name === "escape") {
      state.notice = "Esc is reserved for stopping an active run · Tab returns to conversation selection";
    } else if (key.name === "return") {
      const text = state.input.trim();
      if (text) {
        if (state.adapterKind === "mock") simulateReply(text);
        else void sendRealMessage(text);
      }
    } else if (key.name === "backspace") {
      state.input = [...state.input].slice(0, -1).join("");
    } else if (str && !key.ctrl && !key.meta && str >= " ") {
      state.input += str;
    }
  }

  function handleFlowSelection(key) {
    if (key.name === "up" && state.flows.length) {
      state.flowSelectionIndex = (state.flowSelectionIndex - 1 + state.flows.length) % state.flows.length;
    } else if (key.name === "down" && state.flows.length) {
      state.flowSelectionIndex = (state.flowSelectionIndex + 1) % state.flows.length;
    } else if (key.name === "return" && state.flows.length) {
      selectFlowWorkflow(state);
    } else if (key.name === "escape") {
      state.notice = "A workflow selection is required before entering Flow mode";
    }
  }

  function handleKey(str, key) {
    if (key.ctrl && key.name === "c") return quit();
    if (state.overlay === "palette") handlePalette(str, key);
    else if (state.overlay === "flow-select") handleFlowSelection(key);
    else if (state.inputMode) handleInput(str, key);
    else if (state.overlay) {
      if (key.name === "escape" || key.name === "return" || str === "?") state.overlay = null;
    } else if (key.ctrl && key.name === "k") {
      state.overlay = "palette";
      state.paletteQuery = "";
      state.paletteIndex = 0;
    } else if (key.name === "tab") {
      state.focusRegion = "menu";
      state.contentColumn = 0;
      state.notice = "Menu focus";
    } else if (state.focusRegion === "menu" && key.name === "up") moveMenuSelection(state, -1);
    else if (state.focusRegion === "menu" && key.name === "down") moveMenuSelection(state, 1);
    else if (key.name === "left") moveFocusHorizontal(state, -1);
    else if (key.name === "right") moveFocusHorizontal(state, 1);
    else if (state.focusRegion === "menu" && (key.name === "return" || key.name === "space")) activateMenu(state);
    else if (state.focusRegion === "content" && key.name === "up") moveSelection(state, -1);
    else if (state.focusRegion === "content" && key.name === "down") moveSelection(state, 1);
    else if (state.focusRegion === "content" && (str === "v" || str === "V") && state.view === "settings" && state.contentColumn === 1 && state.settingsTab === "models") {
      Promise.resolve(validateSelectedModel(state)).finally(paint);
    }
    else if (state.focusRegion === "content" && state.view === "settings" && state.contentColumn === 1 && (str === "o" || str === "O") && state.settingsTab === "general") {
      Promise.resolve(runSettingsAction(state, "open-config")).finally(paint);
    }
    else if (state.focusRegion === "content" && state.view === "settings" && state.contentColumn === 1 && (str === "r" || str === "R") && state.settingsTab === "general") {
      Promise.resolve(runSettingsAction(state, "reload-config")).finally(paint);
    }
    else if (state.focusRegion === "content" && state.view === "settings" && state.contentColumn === 1 && (str === "l" || str === "L") && state.settingsTab === "archive") {
      Promise.resolve(runSettingsAction(state, "list-archives")).finally(paint);
    }
    else if (state.focusRegion === "content" && state.view === "settings" && state.contentColumn === 1 && (str === "u" || str === "U") && state.settingsTab === "updates") {
      Promise.resolve(runSettingsAction(state, "check-updates")).finally(paint);
    }
    else if (state.focusRegion === "content" && (key.name === "return" || key.name === "space")) activate();
    else if (/^[1-9]$/.test(str)) {
      switchView(state, data.navigation[Number(str) - 1].id);
      state.focusRegion = "content";
    }
    else if (str === "q" || str === "Q") return quit();
    else if (str === "?") state.overlay = "help";
    else if ((str === "t" || str === "T") && state.view === "chat" && state.focusRegion === "content" && !state.inputMode) toggleConversationPinned(state);
    else if (str === "t" || str === "T") executeAction(state, "theme");
    else if (str === "n" || str === "N") executeAction(state, "new-chat");
    else if ((str === "p" || str === "P") && state.view === "home") switchView(state, "plan");
    else if ((str === "a" || str === "A") && state.view === "home") switchView(state, "automation");
    paint();
  }

  readline.emitKeypressEvents(process.stdin);
  if (typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("keypress", handleKey);
  process.stdout.on("resize", paint);
  process.on("exit", () => process.stdout.write(`${ESC}?25h${ESC}0m`));
  process.on("SIGTERM", quit);
  paint();
}

module.exports = { executeAction, start };
