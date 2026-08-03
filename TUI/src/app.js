"use strict";

const readline = require("node:readline");
const path = require("node:path");
const { render } = require("./render");
const {
  activateMenu,
  activateMemorySelection,
  applyConversationResult,
  applyThemeAppearance,
  applySnapshot,
  beginAutomationCreate,
  beginWorkflowCreate,
  confirmSettingChoiceSelection,
  createAutomationFromDraft,
  createState,
  cycleConversationMode,
  enterConversation,
  filteredCommands,
  moveFocusHorizontal,
  moveConversationHistoryCursor,
  moveInputCursorVertical,
  moveMenuSelection,
  moveSettingChoiceSelection,
  moveSelection,
  markConversationRunning,
  returnToConversationSelection,
  requestConversationStop,
  runSettingsAction,
  saveWorkflowFromDraft,
  setMemorySearchQuery,
  selectConversationModel,
  selectIntelligenceTier,
  selectFlowWorkflow,
  switchView,
  toggleAgentHistory,
  toggleConversationPinned,
  toggleSelectedBuildBlock,
  toggleSelected,
  toggleWorkflowDetails,
  validateSelectedModel
} = require("./state");

const ESC = "\u001b[";

function createPaintScheduler(state, output = process.stdout, renderFrame = render) {
  let pending = false;
  let lastFrame = "";
  const flush = () => {
    pending = false;
    const frame = renderFrame(state);
    if (frame === lastFrame) return false;
    lastFrame = frame;
    output.write(frame);
    return true;
  };
  const paint = () => {
    if (pending) return;
    pending = true;
    setImmediate(flush);
  };
  paint.flush = flush;
  return paint;
}

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
    state.inputCursor = 0;
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
    process.stderr.write("Run DESKTOP build first, or use --demo for isolated sample data.\n");
    process.exitCode = 1;
    return;
  }
  const state = createState({ adapter });
  let timer = null;
  let animationTimer = null;
  let closing = false;
  const paint = createPaintScheduler(state);
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
    state.inputCursor = 0;
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
    }, 250);
  }

  async function sendRealMessage(text) {
    const target = { ...state.target };
    state.input = "";
    state.inputCursor = 0;
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
      }, 250);
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
      if (state.contentColumn === 0) selectIntelligenceTier(state);
      else selectConversationModel(state);
    } else if (state.view === "flowlist") {
      state.flowSelectionIndex = state.selected;
      selectFlowWorkflow(state);
    } else if (state.view === "memory") {
      const result = activateMemorySelection(state);
      if (result && typeof result.then === "function") result.catch((error) => { state.notice = `Viewer failed: ${error.message}`; }).finally(paint);
    } else if (state.view === "automation") {
      if (state.selected === 0) beginAutomationCreate(state);
      else toggleSelected(state);
    } else if (state.view === "workflow") {
      if (state.selected === 0) beginWorkflowCreate(state);
      else toggleWorkflowDetails(state);
    } else if (state.view === "tools" || state.view === "settings") {
      if (state.view === "settings" && state.contentColumn === 0) {
        moveFocusHorizontal(state, 1);
        return;
      }
      const result = toggleSelected(state);
      if (result && typeof result.then === "function") {
        result.catch((error) => {
          state.notice = `Setting update failed: ${error.message}`;
        }).finally(paint);
      }
    } else if (state.view === "agents") {
      toggleAgentHistory(state);
    } else if (state.view === "plan") {
      const step = state.snapshot.conversationPlan.items[state.selected];
      state.notice = step
        ? `Plan step selected: ${step.text} · ${state.adapterKind === "mock" ? "demo" : "persisted conversation"}`
        : "No plan step in the active conversation";
    } else {
      state.notice = "No additional action for this item";
    }
  }

  function handleMemorySearch(str, key) {
    if (key.name === "escape") {
      state.memorySearchActive = false;
      setMemorySearchQuery(state, "");
      state.notice = "Memory tag search cleared";
    } else if (key.name === "return") {
      state.memorySearchActive = false;
      activateMemorySelection(state);
    } else if (key.name === "up") {
      moveSelection(state, -1);
    } else if (key.name === "down") {
      moveSelection(state, 1);
    } else if (key.name === "backspace") {
      setMemorySearchQuery(state, [...state.memorySearchQuery].slice(0, -1).join(""));
    } else if (str && !key.ctrl && !key.meta && str >= " ") {
      setMemorySearchQuery(state, `${state.memorySearchQuery}${str}`);
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
    if (state.conversationHistoryFocus) {
      if (key.name === "escape") {
        Promise.resolve(requestConversationStop(state)).finally(paint);
      } else if (key.name === "tab") {
        state.conversationHistoryFocus = false;
        returnToConversationSelection(state);
      } else if (key.name === "up") {
        moveConversationHistoryCursor(state, -1);
      } else if (key.name === "down") {
        moveConversationHistoryCursor(state, 1);
      } else if (key.name === "return" || key.name === "space") {
        const toggled = toggleSelectedBuildBlock(state);
        if (toggled && typeof toggled.then === "function") toggled.catch(() => {}).finally(paint);
      }
      return;
    }
    if (key.name === "tab" && key.shift) {
      cycleConversationMode(state);
    } else if (key.name === "escape") {
      Promise.resolve(requestConversationStop(state)).finally(paint);
    } else if (key.name === "tab") {
      returnToConversationSelection(state);
    } else if (key.name === "escape") {
      state.notice = "Esc is reserved for stopping an active run · Tab returns to conversation selection";
    } else if (key.name === "up") {
      moveInputCursorVertical(state, -1);
    } else if (key.name === "down") {
      moveInputCursorVertical(state, 1);
    } else if (key.name === "left") {
      state.inputCursor = Math.max(0, (Number(state.inputCursor) || 0) - 1);
    } else if (key.name === "right") {
      state.inputCursor = Math.min([...state.input].length, (Number(state.inputCursor) || 0) + 1);
    } else if (key.name === "return" && key.shift) {
      const characters = [...state.input];
      const cursor = Math.max(0, Math.min(characters.length, Number(state.inputCursor) || 0));
      characters.splice(cursor, 0, "\n");
      state.input = characters.join("");
      state.inputCursor = cursor + 1;
    } else if (key.name === "return") {
      const text = state.input.trim();
      if (text) {
        if (state.adapterKind === "mock") simulateReply(text);
        else void sendRealMessage(text);
      }
    } else if (key.name === "backspace") {
      const characters = [...state.input];
      const cursor = Math.max(0, Math.min(characters.length, Number(state.inputCursor) || 0));
      if (cursor > 0) {
        characters.splice(cursor - 1, 1);
        state.input = characters.join("");
        state.inputCursor = cursor - 1;
      }
    } else if (str && !key.ctrl && !key.meta && str >= " ") {
      const characters = [...state.input];
      const cursor = Math.max(0, Math.min(characters.length, Number(state.inputCursor) || 0));
      characters.splice(cursor, 0, str);
      state.input = characters.join("");
      state.inputCursor = cursor + [...str].length;
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

  function handleSettingChoice(key) {
    if (key.name === "up") {
      moveSettingChoiceSelection(state, -1);
    } else if (key.name === "down") {
      moveSettingChoiceSelection(state, 1);
    } else if (key.name === "return") {
      const result = confirmSettingChoiceSelection(state);
      if (result && typeof result.then === "function") {
        result.catch(() => {}).finally(paint);
      }
    } else if (key.name === "escape") {
      state.overlay = null;
      state.settingChoiceTab = "";
      state.settingChoiceKey = "";
      state.settingChoiceIndex = 0;
      state.notice = "Input mode selection cancelled";
    }
  }

  function handleCreateForm(str, key) {
    const isAutomation = state.overlay === "automation-create";
    const draft = isAutomation ? state.automationDraft : state.workflowDraft;
    const fieldKey = isAutomation ? "automationFormIndex" : "workflowFormIndex";
    const maxIndex = isAutomation ? 4 : 3;
    const textFields = isAutomation ? { 0: "prompt", 2: "intervalSec" } : { 0: "name", 2: "prompt" };
    const cycles = isAutomation
      ? {
          1: ["once", "loop", "schedule"],
          3: ["existing", "new"]
        }
      : { 1: ["build", "plan", "goal"] };
    const index = state[fieldKey];
    const submit = () => {
      const action = isAutomation ? createAutomationFromDraft(state) : saveWorkflowFromDraft(state);
      Promise.resolve(action).catch((error) => {
        state.notice = `${isAutomation ? "Automation" : "WorkFlow"} creation failed: ${error.message}`;
      }).finally(paint);
    };
    if (key.name === "escape") {
      state.overlay = null;
      state.notice = `${isAutomation ? "Automation" : "WorkFlow"} creation cancelled`;
    } else if (key.name === "up") {
      state[fieldKey] = (index - 1 + maxIndex + 1) % (maxIndex + 1);
    } else if (key.name === "down" || key.name === "tab") {
      state[fieldKey] = (index + 1) % (maxIndex + 1);
    } else if ((key.name === "left" || key.name === "right") && cycles[index]) {
      const values = cycles[index];
      const current = values.indexOf(draft[isAutomation && index === 3 ? "conversationMode" : isAutomation ? "condition" : "mode"]);
      const next = (current + (key.name === "right" ? 1 : -1) + values.length) % values.length;
      if (isAutomation && index === 3) draft.conversationMode = values[next];
      else if (isAutomation) draft.condition = values[next];
      else draft.mode = values[next];
    } else if (key.name === "return") {
      if (index === maxIndex) submit();
      else state[fieldKey] = index + 1;
    } else if (key.name === "backspace" && textFields[index]) {
      const name = textFields[index];
      draft[name] = [...String(draft[name] || "")].slice(0, -1).join("");
    } else if (str && !key.ctrl && !key.meta && str >= " " && textFields[index]) {
      const name = textFields[index];
      draft[name] = `${draft[name] || ""}${str}`;
    }
  }

  function handleKey(str, key) {
    if (key.ctrl && key.name === "c") return quit();
    if (state.overlay === "palette") handlePalette(str, key);
    else if (state.overlay === "flow-select") handleFlowSelection(key);
    else if (state.overlay === "settings-choice") handleSettingChoice(key);
    else if (state.overlay === "automation-create" || state.overlay === "workflow-create") handleCreateForm(str, key);
    else if (state.inputMode) handleInput(str, key);
    else if (state.memorySearchActive) handleMemorySearch(str, key);
    else if (state.overlay) {
      if (key.name === "escape" || key.name === "return" || str === "?") state.overlay = null;
    } else if (key.ctrl && key.name === "k") {
      state.overlay = "palette";
      state.paletteQuery = "";
      state.paletteIndex = 0;
    } else if (state.view === "memory" && str === "/") {
      state.memorySearchActive = true;
      state.focusRegion = "content";
      state.contentColumn = 0;
      state.notice = "Search Memory Lab tags";
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
    else if (str === "q" || str === "Q") return quit();
    else if (str === "?") state.overlay = "help";
    else if ((str === "t" || str === "T") && state.view === "chat" && state.focusRegion === "content" && !state.inputMode) toggleConversationPinned(state);
    else if (str === "t" || str === "T") executeAction(state, "theme");
    else if (str === "n" || str === "N") executeAction(state, "new-chat");
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

module.exports = { createPaintScheduler, executeAction, start };
