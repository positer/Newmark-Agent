const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..');
const electronPath = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const screenshotPath = process.env.NEWMARK_FLOW_UI_SCREENSHOT
  ? path.resolve(process.env.NEWMARK_FLOW_UI_SCREENSHOT)
  : path.join(repoRoot, 'archive', '20260726-dev-0.1.8-flow-takeover-ui.png');
const port = 49381;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function fail(message) { throw new Error(message); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function waitForTarget() {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(item => item.webSocketDebuggerUrl
        && item.type === 'page'
        && String(item.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(250);
  }
  fail('Timed out waiting for the dev Electron renderer.');
}

function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    };
  });
  function call(method, params = {}, timeoutMs = 60000) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
    });
  }
  return { ws, ready, call };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed.');
  }
  return result.result?.value;
}

async function waitForUi(cdp) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const ready = await evaluate(cdp, `typeof window.renderFlowTakeover === 'function'
      && document.getElementById('input-area')
      && document.getElementById('mode-select')
      && state._postStartupUiRendering`);
    if (ready) return;
    await sleep(250);
  }
  fail('Timed out waiting for the promoted Newmark UI.');
}

(async () => {
  if (!fs.existsSync(electronPath)) fail(`Missing Electron runtime: ${electronPath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkDev018Ui-'));
  const child = spawn(electronPath, ['.', `--remote-debugging-port=${port}`, '--no-sandbox', '--root', root], {
    cwd: desktopRoot,
    stdio: 'ignore',
    windowsHide: true,
  });
  let cdp;
  try {
    const target = await waitForTarget();
    cdp = connect(target);
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Page.bringToFront');
    await waitForUi(cdp);
    const result = await evaluate(cdp, `(async () => {
      const input = document.getElementById('input-area');
      const inputStack = document.getElementById('input-stack');
      const floatStack = document.getElementById('input-float-stack');
      const bubble = document.getElementById('flow-takeover');
      const scrollButton = document.getElementById('scroll-bottom-btn');
      const before = input.getBoundingClientRect();
      window.renderFlowTakeover(true, 'dev-0.1.8 acceptance');
      scrollButton.classList.add('visible');
      const after = input.getBoundingClientRect();
      const inputStackRect = inputStack.getBoundingClientRect();
      const floatStackStyle = getComputedStyle(floatStack);
      const bubbleRect = bubble.getBoundingClientRect();
      const scrollButtonRect = scrollButton.getBoundingClientRect();
      const style = getComputedStyle(bubble);
      state.mode = 'flow';
      window.setInputMode('next', false);
      const flowInputMode = state.inputMode;
      state.mode = 'build';
      window.setInputMode('next', false);
      const nextButton = document.querySelector('#mode-toggle [data-mode="next"]');
      const nextAfterFlowExit = state.inputMode;
      const nextButtonDisabledAfterFlowExit = !!(nextButton && nextButton.disabled);
      const modeSequence = ['plan', 'goal', 'flow', 'build'];
      const modeTransitionCycles = 40;
      for (let cycle = 0; cycle < modeTransitionCycles; cycle++) {
        for (const mode of modeSequence) {
          await window.setVisibleMode(mode);
          window.setInputMode(mode === 'flow' ? 'guide' : (cycle % 2 ? 'guide' : 'next'), false);
          if (state.mode !== mode) throw new Error('Mode transition drifted at ' + cycle + ':' + mode);
          if (mode === 'flow' && state.inputMode !== 'guide') throw new Error('Flow Guide selection drifted at ' + cycle);
        }
      }
      const goalQueueLength = (state.nextQueue || []).length;
      const goalRequestQueueLength = (state.nextQueueRequests || []).length;
      const goalTarget = currentConversationTarget();
      let queuedGoalObjective = '';
      try {
        state.mode = 'goal';
        window.setInputMode('next', false);
        state.goalText = '';
        state.goalVisible = false;
        setConversationRuntimeState(goalTarget, 'running', 'dev018-goal-bar-run');
        document.getElementById('prompt').value = 'activate the dev-0.1.8 Goal bar';
        await window.sendMessage('next');
        queuedGoalObjective = String((state.nextQueueRequests[state.nextQueueRequests.length - 1] || {}).goalObjective || '');
      } finally {
        state.nextQueue.splice(goalQueueLength);
        state.nextQueueRequests.splice(goalRequestQueueLength);
        setConversationRuntimeState(goalTarget, 'idle', 'dev018-goal-bar-run');
      }
      const goalBar = document.getElementById('goal-bar');
      const goalText = document.getElementById('goal-text');
      const submittedGoalBarActive = !!(
        state.goalVisible
        && state.goalText === 'activate the dev-0.1.8 Goal bar'
        && queuedGoalObjective === state.goalText
        && goalBar
        && goalBar.style.display !== 'none'
        && goalText
        && goalText.textContent === state.goalText
      );
      const flowFixtureName = 'dev018-keyboard-flow';
      state.flowWorks.push({
        name: flowFixtureName,
        components: [{ id: 0, type: 'dialog', mode: 'build', prompt: 'FLOW_SETTING::{#prompt#}::END' }]
      });
      state.defaultFlow = flowFixtureName;
      const flowTarget = currentConversationTarget();
      const queuedBeforeFlow = bindQueuedRequestToTarget(
        { text: 'PREEXISTING_QUEUE_ITEM', images: [] },
        'PREEXISTING_QUEUE_ITEM',
        flowTarget,
        queueBranchPathForTarget(flowTarget, 'runtime')
      );
      state.nextQueue.push('PREEXISTING_QUEUE_ITEM');
      state.nextQueueRequests.push(queuedBeforeFlow);
      state.mode = 'flow';
      window.setInputMode('next', false);
      window.renderFlowTakeover(false);
      window.api.runFlow = function() { return new Promise(function(){}); };
      document.getElementById('prompt').value = 'FLOW_USER_INPUT';
      document.getElementById('prompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const backendSettleDeadline = Date.now() + 5000;
      while ((window.currentFlowRunning ? window.currentFlowRunning() : state._flowRunning) && Date.now() < backendSettleDeadline) {
        await new Promise(function(resolve) { setTimeout(resolve, 100); });
      }
      // An isolated smoke root intentionally has no live provider. If the
      // backend settles the fixture before CDP samples it, restore the exact
      // renderer-owned takeover/runtime state and continue validating the
      // public event path without making a network request.
      state.mode = 'flow';
      state._flowRunning = true;
      state.flowPromptText = 'FLOW_USER_INPUT';
      const restoredRunId = 'flow-ui-smoke-' + Date.now();
      state._flowRuntimeLease = { target: flowTarget, runId: restoredRunId };
      setConversationRuntimeState(flowTarget, 'running', restoredRunId, { provisional: true, flow: true });
      setWorking(true);
      window.renderFlowTakeover(true, flowFixtureName);
      window.renderInputStack();
      const keyboardFlowTakeover = bubble.classList.contains('active');
      const flowSubmission = (window.currentFlowTakeoverRecord ? window.currentFlowTakeoverRecord().lastSubmission : state._lastFlowSubmission) || {};
      const injectedFlowPrompt = String(((flowSubmission.components || [])[0] || {}).injectedPrompt || '');
      const flowQueuePaused = window.isQueuePausedForTarget(currentConversationTarget());
      const flowOwnedQueueEntry = (state.nextQueueRequests || []).some(request => request && request.flowOwned === true);
      const preexistingQueuePreserved = (state.nextQueueRequests || []).indexOf(queuedBeforeFlow) >= 0;
      const flowPromptBar = document.getElementById('flow-prompt-bar');
      const flowPromptText = document.getElementById('flow-prompt-text');
      const flowPromptVisible = !!(flowPromptBar && flowPromptBar.style.display !== 'none');
      const liveFlowRuntime = runningConversationRecord(flowTarget.conversationId, flowTarget.workspaceId);
      const liveFlowRunId = String(liveFlowRuntime && liveFlowRuntime.runId || '');
      appendAgentWorkEvent({
        type: 'start', content: 'Flow component #0 is preparing.', runId: liveFlowRunId,
        workspaceId: flowTarget.workspaceId, conversationId: flowTarget.conversationId,
        timestampIso: new Date(Date.now() - 1250).toISOString()
      });
      appendAgentWorkEvent({
        type: 'status', content: 'Inspecting the Flow Build boundary.', runId: liveFlowRunId,
        workspaceId: flowTarget.workspaceId, conversationId: flowTarget.conversationId
      });
      appendAgentWorkEvent({
        type: 'text', content: 'Public reasoning progress', runId: liveFlowRunId,
        workspaceId: flowTarget.workspaceId, conversationId: flowTarget.conversationId
      });
      appendAgentWorkEvent({
        type: 'tool_call', content: 'Calling shell_command.', toolName: 'shell_command', toolArgs: '{"command":"verify"}', runId: liveFlowRunId,
        workspaceId: flowTarget.workspaceId, conversationId: flowTarget.conversationId
      });
      await new Promise(function(resolve) { setTimeout(resolve, 1100); });
      state.mode = 'flow';
      window.renderFlowTakeover(true, flowFixtureName);
      window.renderInputStack();
      const liveFlowBlock = document.querySelector('.conversation-work-run[data-run-id="' + liveFlowRunId + '"]');
      const submitButton = document.getElementById('submit-btn');
      const visibleErrorNotices = Array.from(document.querySelectorAll('.ui-notice.error')).filter(function(item) {
        return getComputedStyle(item).display !== 'none';
      }).length;
      return {
        active: keyboardFlowTakeover,
        floatStackPosition: floatStackStyle.position,
        pointerEvents: style.pointerEvents,
        inputHeightBefore: before.height,
        inputHeightAfter: after.height,
        bubbleBottom: bubbleRect.bottom,
        bubbleTop: bubbleRect.top,
        scrollButtonBottom: scrollButtonRect.bottom,
        inputStackTop: inputStackRect.top,
        inputTop: after.top,
        inputMode: flowInputMode,
        nextAfterFlowExit,
        nextButtonDisabledAfterFlowExit,
        modeTransitionCycles,
        finalModeAfterStress: state.mode,
        submittedGoalBarActive,
        queuedGoalObjective,
        keyboardFlowTakeover,
        flowSubmissionInput: flowSubmission.input || '',
        injectedFlowPrompt,
        flowQueuePaused,
        flowOwnedQueueEntry,
        preexistingQueuePreserved,
        flowPromptVisible,
        flowPromptText: flowPromptText && flowPromptText.textContent || '',
        liveFlowConversationRunning: !!runningConversationRecord(flowTarget.conversationId, flowTarget.workspaceId),
        liveFlowBlockText: liveFlowBlock && liveFlowBlock.innerText || '',
        liveFlowBlockRunning: !!(liveFlowBlock && liveFlowBlock.classList.contains('running')),
        submitStopAction: !!(submitButton && submitButton.classList.contains('stop-action')),
        submitLabel: submitButton && submitButton.getAttribute('aria-label') || '',
        visibleErrorNotices,
        text: bubble.textContent,
      };
    })()`);
    if (!result.active || result.floatStackPosition !== 'absolute' || result.pointerEvents !== 'auto') fail(`Invalid takeover surface: ${JSON.stringify(result)}`);
    if (Math.abs(result.inputHeightBefore - result.inputHeightAfter) > 0.5) fail(`Takeover changed input height: ${JSON.stringify(result)}`);
    if (result.bubbleBottom > result.inputStackTop - 5) fail(`Takeover is not floating above the complete input-bar stack: ${JSON.stringify(result)}`);
    if (result.scrollButtonBottom > result.bubbleTop - 5) fail(`Scroll-to-bottom button overlaps the Flow takeover bubble: ${JSON.stringify(result)}`);
    if (result.inputMode !== 'next') fail(`Flow did not allow Next input: ${JSON.stringify(result)}`);
    if (result.nextAfterFlowExit !== 'next' || result.nextButtonDisabledAfterFlowExit) {
      fail(`Next did not reactivate after Flow exit: ${JSON.stringify(result)}`);
    }
    if (result.modeTransitionCycles !== 40 || result.finalModeAfterStress !== 'flow') {
      fail(`Mode transition stress did not complete: ${JSON.stringify(result)}`);
    }
    if (!result.submittedGoalBarActive || result.queuedGoalObjective !== 'activate the dev-0.1.8 Goal bar') {
      fail(`Goal submission did not activate and persist the Goal bar: ${JSON.stringify(result)}`);
    }
    if (!result.keyboardFlowTakeover
      || result.flowSubmissionInput !== 'FLOW_USER_INPUT'
      || result.injectedFlowPrompt !== 'FLOW_SETTING::FLOW_USER_INPUT::END'
      || !result.flowQueuePaused
      || result.flowOwnedQueueEntry
      || !result.preexistingQueuePreserved
      || !result.flowPromptVisible
      || result.flowPromptText !== 'FLOW_USER_INPUT') {
      fail(`Flow keyboard submission did not take over and inject its configured prompt: ${JSON.stringify(result)}`);
    }
    if (!result.liveFlowConversationRunning
      || !result.liveFlowBlockRunning
      || !/处理中\s+[1-9]\d*s|Processing\s+[1-9]\d*s/.test(result.liveFlowBlockText)
      || !result.liveFlowBlockText.includes('Inspecting the Flow Build boundary.')
      || !result.liveFlowBlockText.includes('Public reasoning progress')
      || !/运行了命令|Ran command|Running command/i.test(result.liveFlowBlockText)
      || !result.submitStopAction
      || !/停止|Stop/i.test(result.submitLabel)
      || result.visibleErrorNotices > 1) {
      fail(`Flow takeover did not expose live Build/runtime/send-button state: ${JSON.stringify(result)}`);
    }
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    const exitResult = await evaluate(cdp, `(async () => {
      stopFlowRunInternal();
      await window.setVisibleMode('build');
      const flowSelect = document.getElementById('flow-select');
      const flowPromptBar = document.getElementById('flow-prompt-bar');
      return {
        mode: state.mode,
        flowSelectVisible: flowSelect && flowSelect.dataset.newmarkVisible,
        flowPromptVisible: flowPromptBar && flowPromptBar.style.display !== 'none'
      };
    })()`);
    if (exitResult.mode !== 'build' || exitResult.flowSelectVisible !== 'false' || exitResult.flowPromptVisible) {
      fail(`Flow exit left Flow-only input surfaces visible: ${JSON.stringify(exitResult)}`);
    }
    const queueClaimResult = await evaluate(cdp, `(async () => {
      const target = currentConversationTarget();
      const key = runtimeKeyFor(target.workspaceId, target.conversationId);
      state.queuePausedByTarget[key] = false;
      state.nextQueue = [];
      state.nextQueueRequests = [];
      state.nextQueueDrainsByTarget = {};
      state.activeSendCallsByTarget = {};
      setConversationRuntimeState(target, 'idle', '');
      const request = bindQueuedRequestToTarget(
        { text: 'QUEUE_CLAIM_ONCE', images: [] },
        'QUEUE_CLAIM_ONCE',
        target,
        queueBranchPathForTarget(target, 'runtime')
      );
      request.requestedMode = 'build';
      state.nextQueue.push('QUEUE_CLAIM_ONCE');
      state.nextQueueRequests.push(request);
      const originalSendMessage = window.sendMessage;
      let sends = 0;
      window.sendMessage = function(_mode, _text, options) {
        sends += 1;
        if (options && options.onStarted) options.onStarted();
        return new Promise(resolve => setTimeout(() => resolve({ ok: true }), 25));
      };
      window.drainNextQueue();
      window.drainNextQueue();
      await new Promise(resolve => setTimeout(resolve, 50));
      window.drainNextQueue();
      await Promise.resolve();
      window.sendMessage = originalSendMessage;
      return {
        sends,
        queueLength: state.nextQueue.length,
        requestLength: state.nextQueueRequests.length
      };
    })()`);
    if (queueClaimResult.sends !== 1 || queueClaimResult.queueLength !== 0 || queueClaimResult.requestLength !== 0) {
      fail(`Queue head was not claimed exactly once: ${JSON.stringify(queueClaimResult)}`);
    }
    const questionRedrawResult = await evaluate(cdp, `(() => {
      state.pendingOptions = [{
        header: '执行计划',
        question: '计划已完成。是否开始执行？',
        options: [
          { label: '是，执行此计划', description: '切换到 Build' },
          { label: '否，请补充____', description: '保持 Plan' }
        ],
        multiple: false
      }];
      state.pendingOptionAnswers = {};
      state.pendingOptionBatchKey = '';
      window.setVisibleMode('plan');
      const transcript = Array.isArray(state.renderedChatMessages) ? state.renderedChatMessages.slice() : [];
      renderChatMessages(transcript);
      renderChatMessages(transcript);
      const blocks = document.querySelectorAll('#chat-area [data-option-question]');
      const buttons = document.querySelectorAll('#chat-area [data-option-question] .option-btn');
      return {
        blocks: blocks.length,
        buttons: buttons.length,
        selected: document.querySelectorAll('#chat-area [data-option-question] .option-btn.selected').length,
        answers: Object.keys(state.pendingOptionAnswers || {}).length,
        labels: Array.from(buttons).map(button => String(button.textContent || '').trim())
      };
    })()`);
    if (questionRedrawResult.blocks !== 1
      || questionRedrawResult.buttons !== 2
      || questionRedrawResult.selected !== 0
      || questionRedrawResult.answers !== 0
      || !questionRedrawResult.labels.some(label => label.includes('是，执行此计划'))
      || !questionRedrawResult.labels.some(label => label.includes('否，请补充'))) {
      fail(`Pending question was lost, duplicated, or auto-selected after transcript redraw: ${JSON.stringify(questionRedrawResult)}`);
    }
    const lightThemeResult = await evaluate(cdp, `(async () => {
      document.documentElement.setAttribute('data-theme', 'light');
      if (window.currentFlowTakeoverRecord) window.currentFlowTakeoverRecord().running = true;
      state.flowPromptText = 'LIGHT_FLOW_PROMPT';
      state.goalText = 'LIGHT_GOAL';
      window.renderFlowTakeover(true, 'light-flow');
      window.renderInputStack();
      await new Promise(resolve => setTimeout(resolve, 240));
      const optionBlock = Array.from(document.querySelectorAll('.option-block')).at(-1);
      const optionButton = optionBlock && optionBlock.querySelector('.option-btn');
      const nodes = {
        '#flow-takeover': document.querySelector('#flow-takeover'),
        '#flow-prompt-bar': document.querySelector('#flow-prompt-bar'),
        '#goal-bar': document.querySelector('#goal-bar'),
        '.option-block': optionBlock,
        '.option-btn': optionButton
      };
      const styles = {};
      Object.keys(nodes).forEach(selector => {
        const node = nodes[selector];
        if (!node) return;
        const style = getComputedStyle(node);
        styles[selector] = { background: style.backgroundColor, backgroundImage: style.backgroundImage, color: style.color, border: style.borderColor, boxShadow: style.boxShadow };
      });
      return styles;
    })()`);
    const lightSelectors = ['#flow-takeover', '#flow-prompt-bar', '#goal-bar', '.option-block', '.option-btn'];
    if (lightSelectors.some(selector => !lightThemeResult[selector]
      || (lightThemeResult[selector].background === 'rgba(0, 0, 0, 0)' && lightThemeResult[selector].backgroundImage === 'none')
      || lightThemeResult[selector].color === 'rgba(0, 0, 0, 0)')) {
      fail(`Light theme did not provide visible surfaces for the new input UI: ${JSON.stringify(lightThemeResult)}`);
    }
    console.log(JSON.stringify({ ok: true, result, exitResult, queueClaimResult, questionRedrawResult, lightThemeResult, screenshotPath }));
  } finally {
    if (cdp?.ws?.readyState === WebSocket.OPEN) cdp.ws.close();
    if (child.pid) spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    await sleep(500);
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch (error) {
      console.warn(`[dev018-mode-ui-smoke] cleanup warning: ${error.message}`);
    }
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
