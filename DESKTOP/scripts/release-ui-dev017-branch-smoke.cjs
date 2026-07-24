const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '20260724-dev-0.1.7-branch-guide-ui-smoke.png');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw new Error(message); };

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.setTimeout(1000, () => request.destroy(new Error('CDP discovery timeout')));
    request.on('error', reject);
  });
}

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function discoverTarget(port, child) {
  let pages = [];
  let lastError = '';
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) fail(`Electron exited before CDP discovery: ${child.exitCode}`);
    try {
      pages = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const page = pages.find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (page) return page;
    } catch (error) {
      lastError = String(error && error.message || error);
    }
    await sleep(300);
  }
  fail(`CDP target timeout pages=${JSON.stringify(pages.map(page => page.url))} error=${lastError}`);
}

function connect(page) {
  let sequence = 0;
  const pending = new Map();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    };
  });
  const ready = Promise.race([opened, new Promise((_, reject) => setTimeout(() => reject(new Error('CDP websocket timeout')), 10000))]);
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
    }, 20000);
  });
  return { ws, ready, call };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

(async () => {
  if (!fs.existsSync(exePath)) fail(`missing packaged executable: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkDev017Ui-'));
  const port = await freeTcpPort();
  let child;
  let cdp;
  try {
    child = spawn(exePath, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${path.join(root, 'ElectronData')}`,
      '--no-sandbox',
      '--root', root,
    ], {
      cwd: path.dirname(exePath),
      stdio: process.env.NEWMARK_SMOKE_DEBUG === '1' ? 'inherit' : 'ignore',
      windowsHide: true,
    });
    cdp = connect(await discoverTarget(port, child));
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(cdp, `typeof renderChatMessages === 'function' && typeof renderConversationWorkRun === 'function'`)) break;
      await sleep(200);
      if (attempt === 99) fail('renderer functions did not become ready');
    }

    const result = await evaluate(cdp, `(() => {
      const target = currentConversationTarget();
      state.conversationBranchGroups = [];
      hydrateConversationBranchState({
        branches: [],
        activeBranchId: 'edited-guide',
        runtimeBranchId: 'edited-guide',
        branchGroupId: 'guide-group',
        branchGroups: [
        {
          id: 'start-group', sourceMessageIndex: 0, activeBranchId: 'edited-page', branches: [
            { id: 'original-page', sourceMessageIndex: 0 },
            { id: 'edited-page', sourceMessageIndex: 0 },
          ],
        },
        {
          id: 'guide-group', sourceMessageIndex: 1, activeBranchId: 'edited-guide', branches: [
            { id: 'original-guide', sourceMessageIndex: 1 },
            { id: 'edited-guide', sourceMessageIndex: 1 },
          ],
        },
        ],
      });
      state.activeConversationBranchId = 'edited-page';
      state.guideMessageIndexByClientId = { 'guide-dev017': 1 };
      renderChatMessages([
        { role: 'user', content: 'Edited branch instruction', timestamp: '2026-07-24T04:00:00.000Z' },
        { role: 'user', content: 'Guide before later work', clientMessageId: 'guide-dev017', runId: 'dev017-run', timestamp: '2026-07-24T04:00:01.000Z' },
        { role: 'user', content: 'Later user message must not own the pager', timestamp: '2026-07-24T04:00:02.000Z' },
      ]);
      const run = {
        runId: 'dev017-run',
        target,
        status: 'interrupted',
        expanded: true,
        startedAt: '2026-07-24T04:00:00.000Z',
        endedAt: '2026-07-24T04:00:03.000Z',
        events: [
          {
            id: 'guide-event', sequence: 1, type: 'guide_applied', timestamp: '2026-07-24T04:00:01.000Z',
            guide: { clientMessageId: 'guide-dev017', content: 'Guide before later work', status: 'applied', createdAt: '2026-07-24T04:00:01.000Z' },
          },
          { id: 'edit-call', sequence: 2, type: 'tool_call', toolName: 'apply_patch', toolArgs: JSON.stringify({ path: 'DESKTOP/src/ui/index.html', old_str: 'old line', new_str: 'new line' }), completed: true },
          { id: 'terminal-call', sequence: 3, type: 'tool_call', toolName: 'shell_command', toolArgs: JSON.stringify({ command: 'npm.cmd test' }), completed: true },
        ],
      };
      renderConversationWorkRun(run);
      const pagers = Array.from(document.querySelectorAll('.conversation-branch-pager'));
      const pager = pagers[0];
      const pagerParent = pager && pager.closest('.chat-msg.user');
      const users = Array.from(document.querySelectorAll('.chat-msg.user[data-message-index]'));
      const guide = document.querySelector('.work-run-guide-message[data-client-message-id="guide-dev017"]');
      const guideButtons = guide ? Array.from(guide.querySelectorAll('.msg-action-btn')) : [];
      const fileSummary = document.querySelector('.conversation-work-file-inline > summary');
      const terminalRow = document.querySelector('.conversation-work-activity-item:not(:has(.conversation-work-file-inline))');
      const fileIcon = fileSummary && fileSummary.querySelector('.nm-icon');
      const fileText = fileSummary && fileSummary.querySelector('.conversation-work-file-name');
      const terminalIcon = terminalRow && terminalRow.querySelector('.nm-icon');
      const terminalText = terminalRow && terminalRow.querySelector('.conversation-work-command-label');
      const webFetchLabel = workToolCommandLabel({ toolName: 'web_fetch', toolArgs: JSON.stringify({ url: 'https://example.com/fetch-target' }) });
      const webSearchLabel = workToolCommandLabel({ toolName: 'web_search', toolArgs: JSON.stringify({ query: 'https://example.com/search-target' }) });
      const rect = element => {
        if (!element) return null;
        const value = element.getBoundingClientRect();
        return { left: value.left, top: value.top, width: value.width, height: value.height };
      };
      return {
        pagerText: pager && pager.textContent,
        pagerParentIndex: pagerParent && pagerParent.getAttribute('data-message-index'),
        pagerTexts: pagers.map(node => node.textContent),
        pagerGroupIds: pagers.map(node => node.getAttribute('data-branch-group-id')),
        pagerParentIndices: pagers.map(node => node.closest('.chat-msg.user') && node.closest('.chat-msg.user').getAttribute('data-message-index')),
        finalUserIndex: users.length ? users[users.length - 1].getAttribute('data-message-index') : null,
        pagerArrowTags: pager ? Array.from(pager.querySelectorAll('.branch-page-arrow')).map(node => node.tagName) : [],
        pagerArrowText: pager ? Array.from(pager.querySelectorAll('.branch-page-arrow')).map(node => node.textContent) : [],
        guideButtonCount: guideButtons.length,
        guideButtonTitles: guideButtons.map(button => button.title),
        guideMessageIndex: guide && guide.getAttribute('data-message-index'),
        fileSummary: rect(fileSummary),
        fileIcon: rect(fileIcon),
        fileText: rect(fileText),
        terminalRow: rect(terminalRow),
        terminalIcon: rect(terminalIcon),
        terminalText: rect(terminalText),
        fileFont: fileText && getComputedStyle(fileText).fontFamily,
        terminalFont: terminalText && getComputedStyle(terminalText).fontFamily,
        webFetchLabel,
        webSearchLabel,
        fileDisplay: fileSummary && getComputedStyle(fileSummary).display,
        fileColumns: fileSummary && getComputedStyle(fileSummary).gridTemplateColumns,
      };
    })()`);

    if (result.pagerTexts.join(',') !== '<2/2>,<2/2>' || result.pagerGroupIds.join(',') !== 'start-group,guide-group' || result.pagerParentIndices.join(',') !== '0,1') fail(`nested branch pagers were not independently preserved: ${JSON.stringify(result)}`);
    if (result.pagerParentIndex !== '0' || result.finalUserIndex === result.pagerParentIndex) fail(`branch pager is not anchored to the edited node: ${JSON.stringify(result)}`);
    if (result.pagerArrowTags.join(',') !== 'SPAN,SPAN' || result.pagerArrowText.join('') !== '<>') fail(`branch arrows are not inline clickable text: ${JSON.stringify(result)}`);
    if (result.guideButtonCount !== 2 || result.guideMessageIndex !== '1') fail(`Guide copy/edit actions missing: ${JSON.stringify(result)}`);
    if (!result.fileIcon || !result.terminalIcon || !result.fileText || !result.terminalText) fail(`file/terminal activity rows missing: ${JSON.stringify(result)}`);
    if (Math.abs(result.fileIcon.left - result.terminalIcon.left) > 1 || Math.abs(result.fileText.left - result.terminalText.left) > 1) fail(`file and terminal icon/text columns are not aligned: ${JSON.stringify(result)}`);
    if (result.fileFont !== result.terminalFont || result.fileDisplay !== 'grid' || !String(result.fileColumns || '').startsWith('17px ')) fail(`file and terminal typography/grid mismatch: ${JSON.stringify(result)}`);
    if (result.fileSummary.width > 700) fail(`edited-file row retained an oversized flexible blank area: ${JSON.stringify(result)}`);
    if (result.webFetchLabel !== 'web_fetch · https://example.com/fetch-target' || result.webSearchLabel !== 'web_search · https://example.com/search-target') fail(`web tool target URL is not visible beside the tool name: ${JSON.stringify(result)}`);

    const immediateFirstEdit = await evaluate(cdp, `(() => {
      const original = { id: 'first-original', sourceMessageIndex: 0 };
      const edited = { id: 'first-edited', sourceMessageIndex: 0 };
      hydrateConversationBranchState({
        activeBranchId: 'first-edited', runtimeBranchId: 'first-edited', branchGroupId: 'first-group',
        branchGroups: [{ id: 'first-group', sourceMessageIndex: 0, activeBranchId: 'first-edited', branches: [original, edited] }],
      });
      renderChatMessages([]);
      addMsg('user', 'Edited first message', 'build', state.model, 0, {});
      renderConversationBranchPagers();
      const pager = document.querySelector('.conversation-branch-pager[data-branch-group-id="first-group"]');
      return { text: pager && pager.textContent, parentIndex: pager && pager.closest('.chat-msg.user').getAttribute('data-message-index'), body: document.getElementById('chat-area').innerText };
    })()`);
    if (immediateFirstEdit.text !== '<2/2>' || immediateFirstEdit.parentIndex !== '0' || !immediateFirstEdit.body.includes('Edited first message')) fail(`first-message edit did not paginate immediately before Build completion: ${JSON.stringify(immediateFirstEdit)}`);

    const guidePrefixResult = await evaluate(cdp, `(() => {
      const target = currentConversationTarget();
      const run = {
        runId: 'guide-prefix-run', target, status: 'interrupted', expanded: true,
        startedAt: '2026-07-24T06:00:00.000Z', endedAt: '2026-07-24T06:00:02.000Z', primaryPrompt: 'BUILD_PREFIX_PROMPT',
        events: [{ id: 'guide-prefix-event', sequence: 1, type: 'status', content: 'BUILD_PREFIX_ACTIVITY', timestamp: '2026-07-24T06:00:01.000Z' }], guides: [],
      };
      hydrateConversationBranchState({ activeBranchId: 'guide-new', runtimeBranchId: 'guide-new', branchGroupId: 'guide-prefix-group', branchGroups: [{ id: 'guide-prefix-group', sourceMessageIndex: 2, activeBranchId: 'guide-new', branches: [{ id: 'guide-old' }, { id: 'guide-new' }] }] });
      syncWorkRunsSnapshot([run], target);
      renderChatMessages([
        { role: 'user', content: 'BUILD_PREFIX_PROMPT', runId: 'guide-prefix-run' },
        { role: 'assistant', content: 'BUILD_PREFIX_REPLY', runId: 'guide-prefix-run' },
      ]);
      state.guideMessageIndexByClientId['guide-new-client'] = 2;
      applyAgentWorkEventToRun({ id: 'guide-new-event', type: 'guide_applied', content: 'EDITED_GUIDE_NODE', workspaceId: target.workspaceId, conversationId: target.conversationId, runId: 'guide-prefix-run', clientMessageId: 'guide-new-client', guide: { clientMessageId: 'guide-new-client', target, runId: 'guide-prefix-run', status: 'applied', content: 'EDITED_GUIDE_NODE', createdAt: new Date().toISOString() } });
      renderConversationBranchPagers();
      const runElement = document.querySelector('.conversation-work-run[data-run-id="guide-prefix-run"]');
      const guide = document.querySelector('.work-run-guide-message[data-client-message-id="guide-new-client"]');
      const pager = guide && guide.querySelector('.conversation-branch-pager[data-branch-group-id="guide-prefix-group"]');
      return { body: document.getElementById('chat-area').innerText, sameWrapper: !!(runElement && guide && runElement.closest('.work-run-message') === guide.closest('.work-run-message')), pagerText: pager && pager.textContent };
    })()`);
    if (!guidePrefixResult.body.includes('BUILD_PREFIX_PROMPT') || !guidePrefixResult.body.includes('BUILD_PREFIX_ACTIVITY') || !guidePrefixResult.body.includes('EDITED_GUIDE_NODE') || !guidePrefixResult.sameWrapper || guidePrefixResult.pagerText !== '<2/2>') fail(`Guide edit did not preserve its owning Build prefix at the Guide pagination node: ${JSON.stringify(guidePrefixResult)}`);

    const pageSwitchResult = await evaluate(cdp, `(async () => {
      const target = currentConversationTarget();
      const originalBranch = { id: 'tree-original', createdAt: '2026-07-24T05:00:00.000Z', sourceMessageIndex: 0, sourceText: 'Original instruction' };
      const editedBranch = { id: 'tree-edited', createdAt: '2026-07-24T05:00:01.000Z', sourceMessageIndex: 0, sourceText: 'Edited instruction' };
      const groupFor = activeBranchId => ({ id: 'tree-group', sourceMessageIndex: 0, activeBranchId, branches: [originalBranch, editedBranch] });
      const pages = {
        'tree-original': {
          branches: [originalBranch, editedBranch], branchGroups: [groupFor('tree-original')], branchGroupId: 'tree-group', activeBranchId: 'tree-original', runtimeBranchId: 'tree-original',
          chatMessages: [{ role: 'user', content: 'Original instruction' }, { role: 'assistant', content: 'ORIGINAL_PAGE_ONLY' }],
          workRuns: [{ runId: 'original-tree-run', target, status: 'completed', expanded: false, startedAt: '2026-07-24T05:00:00.000Z', endedAt: '2026-07-24T05:00:01.000Z', events: [], guides: [], primaryPrompt: 'Original instruction' }],
        },
        'tree-edited': {
          branches: [originalBranch, editedBranch], branchGroups: [groupFor('tree-edited')], branchGroupId: 'tree-group', activeBranchId: 'tree-edited', runtimeBranchId: 'tree-original',
          chatMessages: [{ role: 'user', content: 'Edited instruction' }, { role: 'assistant', content: 'EDITED_PAGE_ONLY' }],
          workRuns: [{ runId: 'edited-tree-run', target, status: 'completed', expanded: false, startedAt: '2026-07-24T05:00:02.000Z', endedAt: '2026-07-24T05:00:03.000Z', events: [], guides: [], primaryPrompt: 'Edited instruction' }],
        },
      };
      let stopCalls = 0;
      let activationCalls = 0;
      const testApi = Object.assign({}, api, {
        inspectConversationBranch: async (_target, branchId) => pages[branchId],
        stopConversation: async () => { stopCalls++; return { action: 'stopped', status: 'interrupted' }; },
        activateConversationBranch: async (_target, branchId) => {
        activationCalls++;
        return Object.assign({}, pages[branchId], { runtimeBranchId: branchId });
        },
      });
      window.__setBranchApiForTest(testApi);
      hydrateConversationBranchState(pages['tree-edited']);
      syncWorkRunsSnapshot(pages['tree-edited'].workRuns, target);
      renderChatMessages(pages['tree-edited'].chatMessages);
      const before = document.getElementById('chat-area').innerText;
      await window.switchConversationBranch(-1, 'tree-group');
      const original = document.getElementById('chat-area').innerText;
      const originalRuns = workRunsForTarget(target).map(run => run.runId);
      await window.switchConversationBranch(1, 'tree-group');
      const edited = document.getElementById('chat-area').innerText;
      const editedRuns = workRunsForTarget(target).map(run => run.runId);
      const pagerStopCalls = stopCalls;
      const pagerActivationCalls = activationCalls;
      const activated = await activateViewedConversationBranchForSend(target);
      return { before, original, originalRuns, edited, editedRuns, activeBranchId: state.activeConversationBranchId, runtimeBranchId: state.runtimeConversationBranchId, pagerStopCalls, pagerActivationCalls, activated, stopCalls, activationCalls };
    })()`);
    if (!pageSwitchResult.before.includes('EDITED_PAGE_ONLY') || pageSwitchResult.before.includes('ORIGINAL_PAGE_ONLY')) fail(`edited branch leaked another page before switching: ${JSON.stringify(pageSwitchResult)}`);
    if (!pageSwitchResult.original.includes('ORIGINAL_PAGE_ONLY') || pageSwitchResult.original.includes('EDITED_PAGE_ONLY') || pageSwitchResult.originalRuns.join(',') !== 'original-tree-run') fail(`original branch was not an exclusive page tree: ${JSON.stringify(pageSwitchResult)}`);
    if (!pageSwitchResult.edited.includes('EDITED_PAGE_ONLY') || pageSwitchResult.edited.includes('ORIGINAL_PAGE_ONLY') || pageSwitchResult.editedRuns.join(',') !== 'edited-tree-run' || pageSwitchResult.activeBranchId !== 'tree-edited') fail(`edited branch was not restored as an exclusive page tree: ${JSON.stringify(pageSwitchResult)}`);
    if (pageSwitchResult.pagerStopCalls !== 0 || pageSwitchResult.pagerActivationCalls !== 0) fail(`page inspection stopped or activated a runtime branch: ${JSON.stringify(pageSwitchResult)}`);
    if (!pageSwitchResult.activated || pageSwitchResult.stopCalls !== 0 || pageSwitchResult.activationCalls !== 1 || pageSwitchResult.runtimeBranchId !== 'tree-edited') fail(`sending from the inspected page did not activate exactly that branch: ${JSON.stringify(pageSwitchResult)}`);

    const guideTailIsolation = await evaluate(cdp, `(() => {
      const target = currentConversationTarget();
      const prefixEvent = { id: 'shared-prefix', sequence: 1, type: 'status', content: 'SHARED_GUIDE_PREFIX' };
      const originalTail = { id: 'original-tail', sequence: 3, type: 'tool_call', toolName: 'bash', content: 'ORIGINAL_GUIDE_TAIL' };
      const editedTail = { id: 'edited-tail', sequence: 3, type: 'tool_call', toolName: 'read', content: 'EDITED_GUIDE_TAIL' };
      const runFor = events => ({ runId: 'guide-tail-run', target, status: 'completed', expanded: true, startedAt: '2026-07-24T07:00:00.000Z', endedAt: '2026-07-24T07:00:04.000Z', primaryPrompt: 'SHARED_BUILD_START', events, guides: [] });
      const pages = {
        old: { activeBranchId: 'guide-old', runtimeBranchId: 'guide-new', branchGroupId: 'guide-tail-group', branchGroups: [{ id: 'guide-tail-group', sourceMessageIndex: 2, activeBranchId: 'guide-old', branches: [{ id: 'guide-old' }, { id: 'guide-new' }] }], chatMessages: [{ role: 'user', content: 'SHARED_BUILD_START', runId: 'guide-tail-run' }, { role: 'assistant', content: 'SHARED_GUIDE_PREFIX', runId: 'guide-tail-run' }, { role: 'user', content: 'ORIGINAL_GUIDE_NODE', runId: 'guide-tail-run', clientMessageId: 'old-guide' }, { role: 'assistant', content: 'ORIGINAL_AFTER_GUIDE' }], workRuns: [runFor([prefixEvent, originalTail])] },
        new: { activeBranchId: 'guide-new', runtimeBranchId: 'guide-new', branchGroupId: 'guide-tail-group', branchGroups: [{ id: 'guide-tail-group', sourceMessageIndex: 2, activeBranchId: 'guide-new', branches: [{ id: 'guide-old' }, { id: 'guide-new' }] }], chatMessages: [{ role: 'user', content: 'SHARED_BUILD_START', runId: 'guide-tail-run' }, { role: 'assistant', content: 'SHARED_GUIDE_PREFIX', runId: 'guide-tail-run' }, { role: 'user', content: 'EDITED_GUIDE_NODE', runId: 'guide-tail-run', clientMessageId: 'new-guide' }, { role: 'assistant', content: 'EDITED_AFTER_GUIDE' }], workRuns: [runFor([prefixEvent, editedTail])] },
      };
      hydrateConversationBranchState(pages.new);
      syncWorkRunsSnapshot(pages.new.workRuns, target);
      renderChatMessages(pages.new.chatMessages);
      const edited = document.getElementById('chat-area').innerText;
      hydrateConversationBranchState(pages.old);
      syncWorkRunsSnapshot(pages.old.workRuns, target);
      renderChatMessages(pages.old.chatMessages);
      const original = document.getElementById('chat-area').innerText;
      return { edited, original };
    })()`);
    if (!guideTailIsolation.edited.includes('SHARED_GUIDE_PREFIX') || !guideTailIsolation.original.includes('SHARED_GUIDE_PREFIX') || guideTailIsolation.edited.includes('ORIGINAL_GUIDE_TAIL') || guideTailIsolation.edited.includes('ORIGINAL_AFTER_GUIDE') || guideTailIsolation.original.includes('EDITED_GUIDE_TAIL') || guideTailIsolation.original.includes('EDITED_AFTER_GUIDE')) fail(`Guide page tails leaked across the edit node: ${JSON.stringify(guideTailIsolation)}`);

    const shot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
    if (fs.statSync(screenshotPath).size < 10000) fail('packaged UI screenshot is unexpectedly small');
    console.log(`[release-ui-dev017-branch-smoke] PASS ${JSON.stringify(result)} screenshot=${screenshotPath}`);
  } finally {
    try { cdp?.ws.close(); } catch (_) {}
    if (child?.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        if (!fs.existsSync(root)) break;
      } catch (_) {}
      await sleep(300);
    }
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
