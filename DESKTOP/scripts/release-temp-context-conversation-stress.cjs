const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');

const repoRoot = path.resolve(__dirname, '..', '..');
const desktopRoot = path.join(repoRoot, 'DESKTOP');
const exePath = path.resolve(process.env.NEWMARK_TEMP_STRESS_EXE
  || path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe'));
const { MemoryLabManager } = require(path.join(desktopRoot, 'dist', 'core', 'memoryLab.js'));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fail(message) {
  throw new Error(message);
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function metrics(values) {
  return {
    count: values.length,
    p50Ms: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...values).toFixed(3)),
  };
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

async function waitForTarget(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(250);
  }
  fail('Timed out waiting for packaged renderer');
}

function connect(target) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  };
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const call = (method, params = {}, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, ready, call };
}

async function evaluate(cdp, expression, timeoutMs = 15000) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression, 30000)) return;
    await sleep(100);
  }
  fail(`Timed out waiting for ${label}`);
}

function parseCliEnvelope(stdout) {
  const text = String(stdout || '').trim();
  const candidates = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).reverse();
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`Packaged CLI did not return JSON: ${text.slice(0, 1200)}`);
  }
}

function runPackagedTool(root, tool, args) {
  const argsFile = path.join(root, `${tool}-args.json`);
  fs.writeFileSync(argsFile, JSON.stringify(args), 'utf8');
  const result = spawnSync(exePath, ['tool', tool, '--args-file', argsFile, '--root', root], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`Packaged ${tool} exited ${result.status}: ${String(result.stderr || result.stdout).slice(0, 1200)}`);
  }
  const envelope = parseCliEnvelope(result.stdout);
  if (envelope.ok !== true) fail(`Packaged ${tool} failed: ${JSON.stringify(envelope).slice(0, 1200)}`);
  return envelope;
}

async function stressPackagedConversationUi(root) {
  const conversationCount = Math.max(1, Number(process.env.NEWMARK_STRESS_CONVERSATIONS || 120));
  const clickIntervalMs = Math.max(0, Number(process.env.NEWMARK_STRESS_CLICK_INTERVAL_MS || 0));
  const port = 51000 + Math.floor(Math.random() * 1000);
  const child = spawn(exePath, [
    `--remote-debugging-port=${port}`,
    '--allow-multiple-instances',
    '--no-sandbox',
    '--root',
    root,
  ], {
    stdio: 'ignore',
    windowsHide: true,
  });
  let cdp;
  try {
    const target = await waitForTarget(port);
    cdp = connect(target);
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    await evaluate(cdp, `(async () => {
      const workspace = await window.api.createWorkspace('temp-context-archive-stress');
      await window.api.selectWorkspace(workspace.id || workspace.name);
      const snapshot = await window.api.getState();
      applyWorkspaceStateFromBackend(snapshot);
      renderConversations();
      return true;
    })()`, 30000);
    await waitFor(
      cdp,
      `document.querySelector('#conversation-list') && typeof window.newConversation === 'function' && typeof window.archiveConv === 'function'`,
      30000,
      'conversation UI',
    );

    const created = await evaluate(cdp, `(async () => {
      const count = ${JSON.stringify(conversationCount)};
      const clickIntervalMs = ${JSON.stringify(clickIntervalMs)};
      const durations = [];
      const requests = [];
      const startedAt = performance.now();
      for (let index = 0; index < count; index++) {
        const before = performance.now();
        requests.push(window.newConversation());
        durations.push(performance.now() - before);
        if (clickIntervalMs > 0) await new Promise(resolve => setTimeout(resolve, clickIntervalMs));
      }
      const dispatchMs = performance.now() - startedAt;
      const settlements = await Promise.allSettled(requests);
      const ids = currentWorkspaceConversations().map(item => String(item.id || ''));
      return {
        count,
        dispatchMs,
        durations,
        rejected: settlements.filter(item => item.status === 'rejected').map(item => String(item.reason || '')),
        ids,
        uniqueIds: new Set(ids).size,
      };
    })()`, 120000);

    if (created.rejected.length) {
      fail(`Rapid create rejected ${created.rejected.length} requests: ${JSON.stringify(created.rejected.slice(0, 5))}`);
    }
    const createdStressIds = created.ids.filter(id => id.startsWith('conv-'));
    if (createdStressIds.length !== conversationCount || new Set(createdStressIds).size !== conversationCount) {
      fail(`Rapid create lost or duplicated conversations: ${JSON.stringify(created)}`);
    }

    const archived = await evaluate(cdp, `(async () => {
      const ids = currentWorkspaceConversations().map(item => String(item.id || '')).filter(id => id.startsWith('conv-'));
      const durations = [];
      const startedAt = performance.now();
      for (const id of ids) {
        const before = performance.now();
        window.archiveConv(id);
        durations.push(performance.now() - before);
      }
      const dispatchMs = performance.now() - startedAt;
      return { ids, durations, dispatchMs, immediateRemaining: currentWorkspaceConversations().filter(item => String(item.id || '').startsWith('conv-')).length };
    })()`, 30000);

    if (archived.immediateRemaining !== 0) fail(`Optimistic archive left ${archived.immediateRemaining} rows`);
    await waitFor(
      cdp,
      `Object.keys(state.conversationArchivePending || {}).length === 0`,
      120000,
      'all archive IPC requests',
    );
    const finalState = await evaluate(cdp, `(async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
      const archives = await window.api.listArchives('workspace');
      return {
        activeIds: currentWorkspaceConversations().map(item => String(item.id || '')),
        archiveConversationIds: archives.map(item => String(item.conversationId || '')),
        pending: Object.keys(state.conversationArchivePending || {}).length,
        responsive: document.visibilityState !== 'hidden' || document.readyState === 'complete',
      };
    })()`, 30000);
    const archivedSet = new Set(finalState.archiveConversationIds);
    const missingArchives = archived.ids.filter(id => !archivedSet.has(id));
    if (missingArchives.length) fail(`Archive loss detected for ${missingArchives.length} conversations`);
    if (finalState.pending !== 0 || !finalState.responsive) fail(`Renderer did not settle: ${JSON.stringify(finalState)}`);

    return {
      created: {
        count: conversationCount,
        clickIntervalMs,
        dispatchMs: Number(created.dispatchMs.toFixed(3)),
        perClick: metrics(created.durations),
        uniqueIds: created.uniqueIds,
        rejected: 0,
      },
      archived: {
        count: conversationCount,
        dispatchMs: Number(archived.dispatchMs.toFixed(3)),
        perClick: metrics(archived.durations),
        missing: 0,
        pending: finalState.pending,
      },
    };
  } finally {
    try { cdp?.ws.close(); } catch {}
    try { child.kill(); } catch {}
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
  }
}

function stressMemoryPolicy(root) {
  const manager = new MemoryLabManager(root, 'en');
  const componentCount = Math.max(10, Number(process.env.NEWMARK_STRESS_COMPONENTS || 300));
  const queryCount = Math.max(1, Number(process.env.NEWMARK_STRESS_QUERIES || 600));
  const relevantSlugs = [];
  const payload = 'bounded context payload '.repeat(45);
  for (let index = 0; index < componentCount; index++) {
    const relevant = index % 30 === 0;
    const name = relevant ? `Adaptive Context Needle ${index}` : `Distractor Note ${index}`;
    const result = manager.update(manager.prepareUpdate({
      name,
      description: relevant ? 'adaptive durable context policy retrieval' : 'unrelated synthetic preference',
      tags: relevant ? ['#Agent', '#Context'] : ['#Distractor'],
      tagPaths: relevant ? [['#Agent', '#Context']] : [['#Distractor']],
      content: relevant
        ? `NEWMARK_CONTEXT_NEEDLE_${index} adaptive retrieval stale guard recovery ${payload}`
        : `synthetic distractor ${index} ${payload}`,
      reason: 'Temporary stress fixture',
      source: 'release-temp-context-conversation-stress',
    }));
    if (relevant) relevantSlugs.push(result.slug);
  }

  const queryDurations = [];
  for (let index = 0; index < queryCount; index++) {
    const startedAt = performance.now();
    const result = manager.query({
      query: 'adaptive durable context policy retrieval stale guard recovery',
      limit: 8,
      maxChars: 5000,
    });
    queryDurations.push(performance.now() - startedAt);
    if (!result.hits.length || !relevantSlugs.includes(result.hits[0].slug)) {
      fail(`Query ${index} did not rank a relevant memory first`);
    }
    if (result.selected > 8 || result.hits.reduce((sum, hit) => sum + hit.content.length, 0) > 5000) {
      fail(`Query ${index} exceeded its retrieval budget`);
    }
  }
  const queryLatency = metrics(queryDurations);
  if (queryLatency.p95Ms >= 50) {
    fail(`Memory query p95 ${queryLatency.p95Ms}ms exceeded the 50ms sustained-query budget`);
  }
  const visualizationStartedAt = performance.now();
  const visualization = manager.visualizationSnapshot();
  const visualizationLoadMs = performance.now() - visualizationStartedAt;
  if (Object.keys(visualization.componentContents).length !== componentCount) {
    fail(`Visualization snapshot loaded ${Object.keys(visualization.componentContents).length}/${componentCount} components`);
  }

  const target = manager.read(relevantSlugs[0]).component;
  if (!target) fail('Update-race target is missing');
  const expectedUpdatedAt = target.meta.updatedAt;
  let updateAccepted = 0;
  let staleRejected = 0;
  for (let index = 0; index < 40; index++) {
    try {
      manager.update(manager.prepareUpdate({
        name: target.meta.name,
        description: target.meta.description,
        tags: target.meta.tags,
        tagPaths: [['#Agent', '#Context']],
        content: `${target.content}\naccepted update candidate ${index}`,
        expectedUpdatedAt,
        reason: `Competing temporary update ${index}`,
        source: 'release-temp-context-conversation-stress',
      }));
      updateAccepted++;
    } catch (error) {
      if (/changed since it was read/.test(String(error && error.message || error))) staleRejected++;
      else throw error;
    }
  }
  if (updateAccepted !== 1 || staleRejected !== 39) {
    fail(`Stale-write guard accepted=${updateAccepted} rejected=${staleRejected}`);
  }

  const packagedQuery = runPackagedTool(root, 'memory_lab_query', {
    query: 'adaptive durable context policy retrieval stale guard recovery',
    limit: 8,
    max_chars: 5000,
  });
  const packagedText = JSON.stringify(packagedQuery.result || packagedQuery);
  if (!packagedText.includes('Routed to Agent runtime')) {
    fail(`Packaged memory query did not expose the Agent runtime route: ${packagedText.slice(0, 1200)}`);
  }

  const reopened = new MemoryLabManager(root, 'en');
  const recoveryQuery = reopened.query({
    query: 'adaptive durable context policy retrieval stale guard recovery',
    limit: 8,
    maxChars: 5000,
  });
  const policyEvents = fs.readFileSync(reopened.policyLogPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const archiveFiles = fs.readdirSync(reopened.archiveDir);
  if (!recoveryQuery.hits.length || policyEvents.length !== componentCount + 1 || archiveFiles.length < 1) {
    fail(`Restart recovery mismatch: hits=${recoveryQuery.hits.length} events=${policyEvents.length} archives=${archiveFiles.length}`);
  }

  return {
    components: componentCount,
    queries: queryCount,
    queryLatency,
    queryP95BudgetMs: 50,
    visualizationLoadMs: Number(visualizationLoadMs.toFixed(3)),
    visualizationComponents: Object.keys(visualization.componentContents).length,
    relevantFirst: queryCount,
    budgetViolations: 0,
    updateRace: { contenders: 40, accepted: updateAccepted, staleRejected },
    packagedCliRoute: true,
    restartRecovery: true,
    policyEvents: policyEvents.length,
    recoveryArchives: archiveFiles.length,
  };
}

(async () => {
  if (process.platform !== 'win32') fail('This packaged Electron stress gate requires Windows');
  if (!fs.existsSync(exePath)) fail(`Packaged executable is missing: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkTempContextConversationStress-'));
  const startedAt = Date.now();
  let cleaned = false;
  try {
    const conversations = process.env.NEWMARK_STRESS_SKIP_UI === '1'
      ? { skipped: true, reason: 'isolated context-only rerun' }
      : await stressPackagedConversationUi(root);
    const memory = process.env.NEWMARK_STRESS_SKIP_MEMORY === '1'
      ? { skipped: true, reason: 'isolated conversation-only rerun' }
      : stressMemoryPolicy(root);
    const report = {
      ok: true,
      suite: 'dev-0.1.12 temporary-root context and conversation stress',
      root,
      durationMs: Date.now() - startedAt,
      conversations,
      memory,
    };
    console.log(`NEWMARK_TEMP_STRESS_RESULT=${JSON.stringify(report)}`);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      cleaned = !fs.existsSync(root);
    } catch {}
    console.log(`NEWMARK_TEMP_STRESS_CLEANED=${cleaned}`);
    if (!cleaned) process.exitCode = 1;
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
