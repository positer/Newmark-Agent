const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');
const exePath = path.resolve(process.env.NEWMARK_TEST_EXE || path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe'));
const taskkillPath = path.join(path.resolve(process.env.SystemRoot || process.env.windir || 'C:\\Windows'), 'System32', 'taskkill.exe');
const MINIMUM_ACCEPTANCE_RUNS = 20;
const STARTUP_GUEST_FREE_MS = 5000;
const DEFAULT_BASELINE_PRIVATE_MIB = 696;
const STARTUP_ABSOLUTE_PRIVATE_MIB_LIMIT = 525;
const STARTUP_MINIMUM_REDUCTION_FRACTION = 0.25;
const BROWSER_ON_DEMAND_TOTAL_PRIVATE_MIB_LIMIT = 696;
const BROWSER_ON_DEMAND_DELTA_PRIVATE_MIB_LIMIT = 300;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function round(value, digits = 1) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function getJson(url, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('CDP request timed out')));
    request.on('error', reject);
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function connectCdp(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('failed to connect to Electron CDP'));
    ws.onmessage = event => {
      const message = JSON.parse(String(event.data));
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      clearTimeout(callback.timer);
      if (message.error) callback.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else callback.resolve(message.result);
    };
  });
  function call(method, params = {}, timeoutMs = 15000) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
  }
  return { ws, ready, call };
}

async function evaluate(cdp, expression, timeoutMs = 15000) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'renderer evaluation failed');
  return result.result?.value;
}

async function waitForIndexTarget(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(75);
  }
  throw new Error('timed out waiting for packaged index.html target');
}

const PROCESS_CLASSES = ['main', 'renderer', 'gpu', 'utility', 'webview_guest', 'other'];

function classifyProcess(row, rootPid, classifiedByPid = new Map()) {
  if (Number(row.pid) === Number(rootPid)) return 'main';
  const commandLine = String(row.commandLine || '').toLowerCase();
  if (/--type[= ]gpu-process\b/.test(commandLine)) return 'gpu';
  if (/--type[= ]renderer\b/.test(commandLine)) {
    if (/--guest-instance-id\b|--webview-tag\b|newmark-browser|persist:newmark-browser/.test(commandLine)) return 'webview_guest';
    return 'renderer';
  }
  if (/--type[= ]utility\b|utility[-_ ]?host/.test(commandLine)) return 'utility';
  if (classifiedByPid.get(Number(row.parentPid)) === 'utility') return 'utility';
  return 'other';
}

function summarizeProcesses(rows, rootPid) {
  const classes = Object.fromEntries(PROCESS_CLASSES.map(name => [name, {
    count: 0,
    privateBytes: 0,
    privateMiB: 0,
    processes: [],
  }]));
  const classifiedByPid = new Map();
  const remaining = [...rows].sort((a, b) => Number(a.pid) === Number(rootPid) ? -1 : Number(b.pid) === Number(rootPid) ? 1 : 0);
  for (let pass = 0; pass < 2; pass += 1) {
    for (const row of remaining) {
      if (classifiedByPid.has(Number(row.pid))) continue;
      const parentClass = classifiedByPid.get(Number(row.parentPid));
      if (pass === 0 && Number(row.pid) !== Number(rootPid) && !parentClass && !/--type[= ](?:gpu-process|renderer|utility)\b|utility[-_ ]?host/i.test(String(row.commandLine || ''))) continue;
      classifiedByPid.set(Number(row.pid), classifyProcess(row, rootPid, classifiedByPid));
    }
  }
  for (const row of remaining) {
    const kind = classifiedByPid.get(Number(row.pid)) || classifyProcess(row, rootPid, classifiedByPid);
    const privateSize = Number(row.privateBytes || 0);
    const process = {
      pid: Number(row.pid),
      parentPid: Number(row.parentPid),
      name: String(row.name || ''),
      privateBytes: privateSize,
      privateMiB: round(privateSize / 1024 / 1024, 2),
    };
    classes[kind].count += 1;
    classes[kind].privateBytes += privateSize;
    classes[kind].processes.push(process);
  }
  for (const item of Object.values(classes)) item.privateMiB = round(item.privateBytes / 1024 / 1024, 2);
  const total = Object.values(classes).reduce((sum, item) => sum + item.privateBytes, 0);
  return { total, count: rows.length, classes };
}

function privateByteSnapshots(rootPid, sampleCount = 1) {
  const command = [
    `$root = ${Number(rootPid)}`,
    `$sampleCount = ${Math.max(1, Number(sampleCount) || 1)}`,
    '$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine)',
    '$ids = New-Object System.Collections.Generic.HashSet[int]',
    '[void]$ids.Add($root)',
    'do { $before=$ids.Count; foreach($row in $rows) { if($ids.Contains([int]$row.ParentProcessId)) { [void]$ids.Add([int]$row.ProcessId) } } } while($ids.Count -gt $before)',
    '$tracked = @($rows | Where-Object { $ids.Contains([int]$_.ProcessId) })',
    '$samples = @()',
    'for($sample=0; $sample -lt $sampleCount; $sample++) { $memory=@{}; foreach($proc in @(Get-Process -Id @($ids) -ErrorAction SilentlyContinue)) { $memory[[int]$proc.Id]=[int64]$proc.PrivateMemorySize64 }; $processes=@($tracked | Where-Object { $memory.ContainsKey([int]$_.ProcessId) } | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; name=[string]$_.Name; commandLine=[string]$_.CommandLine; privateBytes=[int64]$memory[[int]$_.ProcessId] } }); $samples += [pscustomobject]@{ processes=$processes }; if($sample + 1 -lt $sampleCount) { Start-Sleep -Milliseconds 150 } }',
    '[pscustomobject]@{ samples=$samples } | ConvertTo-Json -Compress -Depth 5',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`private-byte probe exited ${result.status}: ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(String(result.stdout || '{}').trim());
  const samples = Array.isArray(parsed.samples) ? parsed.samples : parsed.samples ? [parsed.samples] : [];
  return samples.map(sample => summarizeProcesses(
    Array.isArray(sample.processes) ? sample.processes : sample.processes ? [sample.processes] : [],
    rootPid,
  ));
}

async function stablePrivateBytes(rootPid, sampleCount = 3) {
  const snapshots = privateByteSnapshots(rootPid, sampleCount);
  if (snapshots.length !== sampleCount) throw new Error(`private-byte probe returned ${snapshots.length}/${sampleCount} samples`);
  snapshots.sort((a, b) => a.total - b.total);
  const chosen = snapshots[Math.floor(snapshots.length / 2)];
  return {
    ...chosen,
    stableSampleCount: snapshots.length,
    stableRangeBytes: snapshots.at(-1).total - snapshots[0].total,
  };
}

function summarizeProcessClasses(samples, field) {
  return Object.fromEntries(PROCESS_CLASSES.map(name => {
    const memory = samples.map(sample => Number(sample[field]?.[name]?.privateMiB || 0));
    const counts = samples.map(sample => Number(sample[field]?.[name]?.count || 0));
    return [name, {
      privateMiB: {
        p50: round(percentile(memory, 0.5), 2),
        p95: round(percentile(memory, 0.95), 2),
        max: round(Math.max(...memory), 2),
      },
      count: {
        p50: percentile(counts, 0.5),
        p95: percentile(counts, 0.95),
        max: Math.max(...counts),
      },
    }];
  }));
}

function stopTree(child) {
  if (!child?.pid) return;
  spawnSync(taskkillPath, ['/PID', String(child.pid), '/T', '/F'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
}

async function stopPackagedRun(child, cdp) {
  if (cdp) {
    try { await cdp.call('Browser.close', {}, 2000); } catch {}
  }
  const gracefulDeadline = Date.now() + 4000;
  while (child && child.exitCode === null && child.signalCode === null && Date.now() < gracefulDeadline) {
    await sleep(100);
  }
  if (child && child.exitCode === null && child.signalCode === null) stopTree(child);
  // Chromium releases its shared-profile singleton asynchronously after the
  // root process exits. Keep teardown outside the next run's timing window.
  await sleep(1500);
}

async function removeTreeWithRetries(target, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(String(error?.code || ''))) throw error;
      stopTree(child);
      await sleep(250);
    }
  }
  throw lastError || new Error(`Timed out removing benchmark root: ${target}`);
}

function browserGuestTargets(targets) {
  return targets.filter(item => {
    const description = `${item.type || ''} ${item.title || ''} ${item.url || ''}`;
    return item.type === 'webview' || /newmark-browser|browser-webview|persist:newmark-browser|about:blank/i.test(description);
  });
}

async function listBrowserGuests(port) {
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
  return browserGuestTargets(targets);
}

async function monitorStartupBrowserGuests(port, startedAt) {
  const until = startedAt + STARTUP_GUEST_FREE_MS;
  let pollCount = 0;
  let reachablePollCount = 0;
  let firstEndpointReachableMs = null;
  let lastEndpointReachableMs = null;
  let maximumGuestCount = 0;
  const guestViolations = [];
  let lastEndpointError = '';
  while (Date.now() < until) {
    pollCount += 1;
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`, 250);
      const observedAtMs = Date.now() - startedAt;
      if (Date.now() <= until) {
        reachablePollCount += 1;
        if (firstEndpointReachableMs === null) firstEndpointReachableMs = observedAtMs;
        lastEndpointReachableMs = observedAtMs;
      }
      const guests = browserGuestTargets(targets);
      maximumGuestCount = Math.max(maximumGuestCount, guests.length);
      if (guests.length > 0) {
        guestViolations.push({
          observedAtMs,
          count: guests.length,
          targets: guests.map(item => ({ type: String(item.type || ''), url: String(item.url || '') })),
        });
      }
    } catch (error) {
      lastEndpointError = error instanceof Error ? error.message : String(error);
    }
    const remaining = until - Date.now();
    if (remaining > 0) await sleep(Math.min(75, remaining));
  }
  return {
    windowMs: STARTUP_GUEST_FREE_MS,
    pollCount,
    endpointReachable: reachablePollCount > 0,
    reachablePollCount,
    firstEndpointReachableMs,
    lastEndpointReachableMs,
    maximumGuestCount,
    guestViolations,
    lastEndpointError: reachablePollCount > 0 ? '' : lastEndpointError,
  };
}

async function waitForGuestCount(port, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let guests = [];
  while (Date.now() <= deadline) {
    guests = await listBrowserGuests(port);
    if (guests.length === expected) return guests;
    await sleep(50);
  }
  throw new Error(`expected ${expected} Browser guest target(s), observed ${guests.length}`);
}

async function verifyPromptInteractivity(cdp, index) {
  const token = `dev010-interactive-${index}-${Date.now()}`;
  const setup = await evaluate(cdp, `(() => {
    const prompt = document.querySelector('#prompt');
    const submit = document.querySelector('#submit-btn');
    if (!prompt) throw new Error('prompt input is missing');
    if (!submit) throw new Error('submit button is missing');
    const promptStyle = getComputedStyle(prompt);
    const submitStyle = getComputedStyle(submit);
    const promptRect = prompt.getBoundingClientRect();
    const submitRect = submit.getBoundingClientRect();
    const originalSubmit = window.submitCurrentAction;
    if (typeof originalSubmit !== 'function') throw new Error('submitCurrentAction is unavailable');
    const inputListener = event => {
      if (event.isTrusted) window.__newmarkBenchmarkInteractive.trustedInputEvents += 1;
    };
    window.__newmarkBenchmarkInteractive = {
      token: ${JSON.stringify(token)},
      originalSubmit,
      inputListener,
      trustedInputEvents: 0,
      submitInvocations: 0,
    };
    prompt.value = '';
    prompt.addEventListener('input', inputListener);
    prompt.focus();
    window.submitCurrentAction = function() {
      window.__newmarkBenchmarkInteractive.submitInvocations += 1;
    };
    return {
      promptDisabled: !!prompt.disabled,
      promptReadOnly: !!prompt.readOnly,
      promptVisible: promptStyle.visibility !== 'hidden' && promptStyle.display !== 'none' && promptRect.width > 0 && promptRect.height > 0,
      promptFocused: document.activeElement === prompt,
      submitDisabled: !!submit.disabled,
      submitVisible: submitStyle.visibility !== 'hidden' && submitStyle.display !== 'none' && submitRect.width > 0 && submitRect.height > 0,
      submitX: submitRect.left + submitRect.width / 2,
      submitY: submitRect.top + submitRect.height / 2,
    };
  })()`);
  try {
    assert(setup.promptDisabled === false, `run ${index} prompt input is disabled`);
    assert(setup.promptReadOnly === false, `run ${index} prompt input is read-only`);
    assert(setup.promptVisible === true, `run ${index} prompt input is not visible`);
    assert(setup.promptFocused === true, `run ${index} prompt input could not receive focus`);
    assert(setup.submitDisabled === false, `run ${index} submit button is disabled`);
    assert(setup.submitVisible === true, `run ${index} submit button is not visible`);
    await cdp.call('Input.insertText', { text: token });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: setup.submitX, y: setup.submitY });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: setup.submitX, y: setup.submitY, button: 'left', clickCount: 1 });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: setup.submitX, y: setup.submitY, button: 'left', clickCount: 1 });
    const result = await evaluate(cdp, `(() => {
      const prompt = document.querySelector('#prompt');
      const probe = window.__newmarkBenchmarkInteractive;
      return {
        valueMatches: !!prompt && prompt.value === probe.token,
        trustedInputEvents: Number(probe.trustedInputEvents || 0),
        submitInvocations: Number(probe.submitInvocations || 0),
      };
    })()`);
    assert(result.valueMatches === true, `run ${index} CDP text input did not reach #prompt`);
    assert(result.trustedInputEvents > 0, `run ${index} #prompt received no trusted input event`);
    assert(result.submitInvocations === 1, `run ${index} submit click path invoked ${result.submitInvocations} time(s), expected 1`);
    return {
      promptEnabled: true,
      promptWritable: true,
      trustedInputEvents: result.trustedInputEvents,
      submitEnabled: true,
      submitClickInvocations: result.submitInvocations,
    };
  } finally {
    await evaluate(cdp, `(() => {
      const prompt = document.querySelector('#prompt');
      const probe = window.__newmarkBenchmarkInteractive;
      if (probe) {
        if (prompt) prompt.removeEventListener('input', probe.inputListener);
        window.submitCurrentAction = probe.originalSubmit;
      }
      delete window.__newmarkBenchmarkInteractive;
      if (prompt) {
        prompt.value = '';
        prompt.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      }
      return true;
    })()`).catch(() => undefined);
  }
}

function summarizeRunSet(requestedRuns, samples) {
  const completedRuns = samples.length;
  const sequentialRunNumbers = samples.every((sample, index) => Number(sample.run) === index + 1);
  const consistent = completedRuns === requestedRuns && sequentialRunNumbers;
  return {
    requestedRuns,
    completedRuns,
    sampleCount: samples.length,
    minimumAcceptanceRuns: MINIMUM_ACCEPTANCE_RUNS,
    sequentialRunNumbers,
    consistent,
    acceptanceEligible: consistent && requestedRuns >= MINIMUM_ACCEPTANCE_RUNS,
  };
}

function startupMemoryAcceptance(p95MiB, baselineMiB) {
  const relativeLimitMiB = baselineMiB * (1 - STARTUP_MINIMUM_REDUCTION_FRACTION);
  return {
    criterion: 'p95_lte_absolute_or_reduced_baseline',
    p95MiB: round(p95MiB, 2),
    absoluteLimitMiB: STARTUP_ABSOLUTE_PRIVATE_MIB_LIMIT,
    relativeLimitMiB: round(relativeLimitMiB, 2),
    minimumReductionPercent: STARTUP_MINIMUM_REDUCTION_FRACTION * 100,
    effectiveOrLimitMiB: round(Math.max(STARTUP_ABSOLUTE_PRIVATE_MIB_LIMIT, relativeLimitMiB), 2),
    deltaFromBaselineMiB: round(p95MiB - baselineMiB, 2),
    reductionFromBaselinePercent: round(((baselineMiB - p95MiB) / baselineMiB) * 100, 2),
    passed: p95MiB <= STARTUP_ABSOLUTE_PRIVATE_MIB_LIMIT || p95MiB <= relativeLimitMiB,
  };
}

function browserOnDemandMemoryAcceptance(totalP95MiB, deltaP95MiB) {
  const totalPassed = totalP95MiB <= BROWSER_ON_DEMAND_TOTAL_PRIVATE_MIB_LIMIT;
  const deltaPassed = deltaP95MiB <= BROWSER_ON_DEMAND_DELTA_PRIVATE_MIB_LIMIT;
  return {
    criterion: 'total_p95_lte_limit_and_delta_p95_lte_limit',
    totalP95MiB: round(totalP95MiB, 2),
    totalLimitMiB: BROWSER_ON_DEMAND_TOTAL_PRIVATE_MIB_LIMIT,
    totalHeadroomMiB: round(BROWSER_ON_DEMAND_TOTAL_PRIVATE_MIB_LIMIT - totalP95MiB, 2),
    deltaP95MiB: round(deltaP95MiB, 2),
    deltaLimitMiB: BROWSER_ON_DEMAND_DELTA_PRIVATE_MIB_LIMIT,
    deltaHeadroomMiB: round(BROWSER_ON_DEMAND_DELTA_PRIVATE_MIB_LIMIT - deltaP95MiB, 2),
    totalPassed,
    deltaPassed,
    passed: totalPassed && deltaPassed,
  };
}

async function oneRun(index, root, profile) {
  const port = await freePort();
  const startedAt = Date.now();
  let child;
  let cdp;
  let stage = 'spawn';
  try {
    child = spawn(exePath, [
      `--remote-debugging-port=${port}`,
      '--no-sandbox',
      '--root', root,
      `--user-data-dir=${profile}`,
    ], { cwd: path.dirname(exePath), stdio: 'ignore', windowsHide: true });
    const startupGuestMonitorPromise = monitorStartupBrowserGuests(port, startedAt);
    stage = 'wait-for-index';
    const target = await waitForIndexTarget(port);
    cdp = connectCdp(target);
    stage = 'wait-for-promoted-ui';
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    const interactiveMs = Date.now() - startedAt;
    await cdp.call('Runtime.enable');
    stage = 'prompt-interactivity';
    const promptInteractivity = await verifyPromptInteractivity(cdp, index);

    stage = 'startup-guest-monitor';
    const startupGuestMonitor = await startupGuestMonitorPromise;
    assert(startupGuestMonitor.guestViolations.length === 0,
      `run ${index} Browser guest appeared during the first ${STARTUP_GUEST_FREE_MS}ms: ${JSON.stringify(startupGuestMonitor.guestViolations)}`);
    const guestsBefore = await listBrowserGuests(port);
    assert(guestsBefore.length === 0, `run ${index} Browser guest count before demand was ${guestsBefore.length}, expected 0`);
    const browserLifecycleBefore = await evaluate(cdp, `window.browserGuestLifecycleSnapshot()`);
    assert(browserLifecycleBefore?.createCount === 0
      && browserLifecycleBefore?.firstCreatedAtMs === null
      && browserLifecycleBefore?.present === false,
    `run ${index} Browser lifecycle recorded startup creation before demand: ${JSON.stringify(browserLifecycleBefore)}`);
    const memoryBeforeBrowser = await stablePrivateBytes(child.pid);
    assert(memoryBeforeBrowser.total > 0 && memoryBeforeBrowser.count > 0, `run ${index} private-byte sample is empty`);

    stage = 'large-input-fixture';
    const inputFixture = await evaluate(cdp, `new Promise(resolve => {
      const prompt = document.querySelector('#prompt');
      if (!prompt) throw new Error('prompt input is missing');
      const line = 'dev010-large-input-fixture-abcdefghijklmnopqrstuvwxyz-0123456789\\n';
      const fixtureLines = 1024;
      prompt.value = line.repeat(fixtureLines);
      prompt.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: line }));
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({
        fixtureBytes: new TextEncoder().encode(prompt.value).byteLength,
        fixtureLines,
      })));
    })`);
    assert(Number(inputFixture?.fixtureBytes) >= 64 * 1024,
      `run ${index} large-input fixture is smaller than 64KiB: ${inputFixture?.fixtureBytes || 0} bytes`);
    let inputLatencyMs;
    stage = 'throttled-input-latency';
    await cdp.call('Emulation.setCPUThrottlingRate', { rate: 4 });
    try {
      await evaluate(cdp, `(() => {
        const prompt = document.querySelector('#prompt');
        prompt.focus();
        prompt.setSelectionRange(prompt.value.length, prompt.value.length);
        window.__newmarkInputLatencyProbe = new Promise(resolve => {
          const started = performance.now();
          prompt.addEventListener('input', event => {
            requestAnimationFrame(() => resolve({
              latencyMs: performance.now() - started,
              trusted: event.isTrusted === true,
            }));
          }, { once: true });
        });
        return true;
      })()`);
      await cdp.call('Input.insertText', { text: 'x' });
      const inputProbe = await evaluate(cdp, 'window.__newmarkInputLatencyProbe');
      assert(inputProbe?.trusted === true, `run ${index} throttled input probe was not a trusted renderer event`);
      inputLatencyMs = Number(inputProbe?.latencyMs);
      await evaluate(cdp, 'delete window.__newmarkInputLatencyProbe; true').catch(() => undefined);
    } finally {
      await cdp.call('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => undefined);
    }

    stage = 'browser-demand';
    const browserStartedAt = Date.now();
    await evaluate(cdp, `window.switchRightTab('browser'); true`);
    let browserReady = false;
    while (Date.now() - browserStartedAt <= 5000) {
      browserReady = await evaluate(cdp, `(() => {
        const views = Array.from(document.querySelectorAll('#browser-webview'));
        if (views.length !== 1 || views[0].getAttribute('partition') !== 'persist:newmark-browser') return false;
        return views[0].dataset?.newmarkBrowserReady === 'true';
      })()`);
      if (browserReady) break;
      await sleep(50);
    }
    assert(browserReady, `run ${index} Browser guest was not ready after demand`);
    const browserDeadlineRemainingMs = Math.max(1, 5000 - (Date.now() - browserStartedAt));
    const guestsAfter = await waitForGuestCount(port, 1, browserDeadlineRemainingMs);
    const browserOpenMs = Date.now() - browserStartedAt;
    const guestCountDelta = guestsAfter.length - guestsBefore.length;
    assert(guestCountDelta === 1, `run ${index} Browser guest delta was ${guestCountDelta}, expected +1`);
    const browserLifecycleAfter = await evaluate(cdp, `window.browserGuestLifecycleSnapshot()`);
    assert(browserLifecycleAfter?.createCount === 1
      && browserLifecycleAfter?.present === true
      && Number(browserLifecycleAfter?.firstCreatedAtMs) >= STARTUP_GUEST_FREE_MS,
    `run ${index} Browser lifecycle did not preserve the five-second creation floor: ${JSON.stringify(browserLifecycleAfter)}`);
    const memoryAfterBrowser = await stablePrivateBytes(child.pid);
    assert(memoryAfterBrowser.total > 0 && memoryAfterBrowser.count > 0, `run ${index} post-Browser private-byte sample is empty`);
    return {
      run: index,
      interactiveMs,
      promptInteractivity,
      startupGuestMonitor,
      browserLifecycleBefore,
      browserLifecycleAfter,
      inputLatencyMs: round(Number(inputLatencyMs), 2),
      inputFixtureBytes: Number(inputFixture.fixtureBytes),
      inputFixtureLines: Number(inputFixture.fixtureLines),
      browserOpenMs,
      browserGuestCountBefore: guestsBefore.length,
      browserGuestCountAfter: guestsAfter.length,
      browserGuestCountDelta: guestCountDelta,
      privateBytesBeforeBrowser: Number(memoryBeforeBrowser.total),
      privateMiBBeforeBrowser: round(Number(memoryBeforeBrowser.total) / 1024 / 1024, 2),
      privateBytesAfterBrowser: Number(memoryAfterBrowser.total),
      privateMiBAfterBrowser: round(Number(memoryAfterBrowser.total) / 1024 / 1024, 2),
      privateMiBDeltaAfterBrowser: round((Number(memoryAfterBrowser.total) - Number(memoryBeforeBrowser.total)) / 1024 / 1024, 2),
      processCountBeforeBrowser: Number(memoryBeforeBrowser.count),
      processCountAfterBrowser: Number(memoryAfterBrowser.count),
      privateMemoryStableSamplesBeforeBrowser: Number(memoryBeforeBrowser.stableSampleCount),
      privateMemoryStableRangeMiBBeforeBrowser: round(Number(memoryBeforeBrowser.stableRangeBytes) / 1024 / 1024, 2),
      privateMemoryStableSamplesAfterBrowser: Number(memoryAfterBrowser.stableSampleCount),
      privateMemoryStableRangeMiBAfterBrowser: round(Number(memoryAfterBrowser.stableRangeBytes) / 1024 / 1024, 2),
      processClassesBeforeBrowser: memoryBeforeBrowser.classes,
      processClassesAfterBrowser: memoryAfterBrowser.classes,
    };
  } catch (error) {
    throw new Error(`run ${index} failed during ${stage}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await stopPackagedRun(child, cdp);
    try { cdp?.ws.close(); } catch {}
  }
}

function runSelfTest() {
  const mib = 1024 * 1024;
  const rows = [
    { pid: 100, parentPid: 1, name: 'Newmark Agent.exe', commandLine: '"Newmark Agent.exe"', privateBytes: 100 * mib },
    { pid: 101, parentPid: 100, name: 'Newmark Agent.exe', commandLine: '--type=renderer', privateBytes: 40 * mib },
    { pid: 102, parentPid: 100, name: 'Newmark Agent.exe', commandLine: '--type=gpu-process', privateBytes: 30 * mib },
    { pid: 103, parentPid: 100, name: 'Newmark Agent.exe', commandLine: '--type=utility --utility-sub-type=node.mojom.NodeService', privateBytes: 20 * mib },
    { pid: 104, parentPid: 103, name: 'node.exe', commandLine: 'utility child', privateBytes: 10 * mib },
    { pid: 105, parentPid: 100, name: 'Newmark Agent.exe', commandLine: '--type=renderer --guest-instance-id=7', privateBytes: 25 * mib },
    { pid: 106, parentPid: 100, name: 'crashpad_handler.exe', commandLine: '--monitor-self', privateBytes: 5 * mib },
  ];
  const snapshot = summarizeProcesses(rows, 100);
  assert(snapshot.total === 230 * mib, `self-test total mismatch: ${snapshot.total}`);
  assert(snapshot.count === 7, `self-test process count mismatch: ${snapshot.count}`);
  assert(snapshot.classes.main.count === 1, 'self-test main classification failed');
  assert(snapshot.classes.renderer.count === 1, 'self-test renderer classification failed');
  assert(snapshot.classes.gpu.count === 1, 'self-test GPU classification failed');
  assert(snapshot.classes.utility.count === 2, 'self-test utility descendant classification failed');
  assert(snapshot.classes.webview_guest.count === 1, 'self-test WebView guest classification failed');
  assert(snapshot.classes.other.count === 1, 'self-test other classification failed');
  assert(!JSON.stringify(snapshot).includes('commandLine'), 'self-test output leaked command lines');
  const aggregate = summarizeProcessClasses([
    { before: snapshot.classes },
    { before: snapshot.classes },
  ], 'before');
  assert(aggregate.webview_guest.privateMiB.p95 === 25, 'self-test class percentile failed');
  const guests = browserGuestTargets([
    { type: 'page', title: 'Newmark', url: 'file:///index.html' },
    { type: 'webview', title: 'Browser', url: 'about:blank' },
  ]);
  assert(guests.length === 1, `self-test Browser guest detection failed: ${guests.length}`);
  assert(percentile([1, 2, 3, 4, 5], 0.95) === 5, 'self-test percentile failed');
  const diagnosticSamples = [{ run: 1 }, { run: 2 }];
  const diagnosticRunSet = summarizeRunSet(2, diagnosticSamples);
  assert(diagnosticRunSet.consistent, 'self-test diagnostic run/sample consistency failed');
  assert(!diagnosticRunSet.acceptanceEligible, 'self-test short run was incorrectly acceptance eligible');
  const formalRunSet = summarizeRunSet(MINIMUM_ACCEPTANCE_RUNS,
    Array.from({ length: MINIMUM_ACCEPTANCE_RUNS }, (_, index) => ({ run: index + 1 })));
  assert(formalRunSet.consistent && formalRunSet.acceptanceEligible, 'self-test formal run eligibility failed');
  assert(!summarizeRunSet(2, [{ run: 1 }]).consistent, 'self-test mismatched run/sample count was accepted');
  const startupAbsoluteAcceptance = startupMemoryAcceptance(500, DEFAULT_BASELINE_PRIVATE_MIB);
  const startupRelativeAcceptance = startupMemoryAcceptance(540, 800);
  const startupRejection = startupMemoryAcceptance(526, DEFAULT_BASELINE_PRIVATE_MIB);
  assert(startupAbsoluteAcceptance.passed, 'self-test startup absolute memory gate failed');
  assert(startupRelativeAcceptance.passed, 'self-test startup relative memory gate failed');
  assert(!startupRejection.passed, 'self-test startup over-limit memory was accepted');
  const browserAcceptance = browserOnDemandMemoryAcceptance(696, 300);
  const browserFormerFalseRejection = browserOnDemandMemoryAcceptance(526, 26);
  const browserTotalRejection = browserOnDemandMemoryAcceptance(696.01, 100);
  const browserDeltaRejection = browserOnDemandMemoryAcceptance(650, 300.01);
  assert(browserAcceptance.passed && browserAcceptance.totalPassed && browserAcceptance.deltaPassed,
    'self-test Browser boundary memory gate failed');
  assert(browserFormerFalseRejection.passed, 'self-test Browser memory incorrectly reused the startup 525 MiB gate');
  assert(!browserTotalRejection.passed && !browserTotalRejection.totalPassed && browserTotalRejection.deltaPassed,
    'self-test Browser total runaway was accepted');
  assert(!browserDeltaRejection.passed && browserDeltaRejection.totalPassed && !browserDeltaRejection.deltaPassed,
    'self-test Browser delta runaway was accepted');
  assert(path.isAbsolute(taskkillPath) && path.basename(taskkillPath).toLowerCase() === 'taskkill.exe',
    `self-test taskkill path is not absolute: ${taskkillPath}`);
  console.log(JSON.stringify({
    ok: true,
    selfTest: true,
    acceptanceEligible: false,
    acceptancePassed: false,
    runSet: diagnosticRunSet,
    syntheticFormalRunSetContract: formalRunSet,
    processClasses: PROCESS_CLASSES,
    classifiedProcesses: snapshot.count,
    totalPrivateMiB: round(snapshot.total / mib, 2),
    commandLinesEmitted: false,
    browserGuestDetection: true,
    startupGuestMonitorContract: true,
    promptInteractivityContract: true,
    startupAndBrowserOnDemandMemoryGates: {
      startupAbsoluteOrRelative: true,
      browserTotalAndDelta: true,
      startupAbsoluteLimitMiB: STARTUP_ABSOLUTE_PRIVATE_MIB_LIMIT,
      browserTotalLimitMiB: BROWSER_ON_DEMAND_TOTAL_PRIVATE_MIB_LIMIT,
      browserDeltaLimitMiB: BROWSER_ON_DEMAND_DELTA_PRIVATE_MIB_LIMIT,
    },
    absoluteTaskkillPath: true,
    realPackageLaunched: false,
  }));
}

let benchmarkSuiteTempRoot = '';

(async () => {
  if (process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }
  if (process.platform !== 'win32') {
    console.log('[benchmark-dev010-startup-memory] skipped outside Windows');
    return;
  }
  assert(fs.existsSync(exePath), `packaged executable is missing: ${exePath}`);
  const runs = Number(argValue('--runs') || process.env.NEWMARK_PERF_RUNS || MINIMUM_ACCEPTANCE_RUNS);
  assert(Number.isSafeInteger(runs) && runs >= 1, `--runs must be a positive integer, received ${JSON.stringify(runs)}`);
  if (runs < MINIMUM_ACCEPTANCE_RUNS && process.env.NEWMARK_ALLOW_SHORT_PERF !== '1') {
    throw new Error(`dev-0.0.10 acceptance requires at least ${MINIMUM_ACCEPTANCE_RUNS} runs; set NEWMARK_ALLOW_SHORT_PERF=1 only for script diagnostics`);
  }
  const outputPath = argValue('--output') || process.env.NEWMARK_PERF_OUTPUT;
  benchmarkSuiteTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-dev010-perf-suite-'));
  const root = path.join(benchmarkSuiteTempRoot, 'root');
  const profile = path.join(benchmarkSuiteTempRoot, 'profile');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  const samples = [];
  for (let index = 1; index <= runs; index += 1) {
    let sample;
    try {
      sample = await oneRun(index, root, profile);
    } catch (error) {
      if (outputPath) {
        const resolved = path.resolve(outputPath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, JSON.stringify({
          ok: false,
          version: '0.0.10',
          runs,
          sampleCount: samples.length,
          acceptanceEligible: false,
          acceptancePassed: false,
          acceptanceStatus: 'incomplete',
          failedRun: index,
          failure: error instanceof Error ? error.message : String(error),
          samples,
        }, null, 2) + '\n', 'utf8');
      }
      throw error;
    }
    samples.push(sample);
    console.log(`[benchmark-dev010-startup-memory] ${index}/${runs} interactive=${sample.interactiveMs}ms startupPrivate=${sample.privateMiBBeforeBrowser}MiB browser=${sample.browserOpenMs}ms browserPrivate=${sample.privateMiBAfterBrowser}MiB browserDelta=${sample.privateMiBDeltaAfterBrowser}MiB input4x=${sample.inputLatencyMs}ms`);
    if (process.env.NEWMARK_PERF_VERBOSE === '1') {
      console.log(`[benchmark-dev010-startup-memory] process classes before Browser: ${JSON.stringify(sample.processClassesBeforeBrowser)}`);
      console.log(`[benchmark-dev010-startup-memory] process classes after Browser: ${JSON.stringify(sample.processClassesAfterBrowser)}`);
    }
  }

  const interactive = samples.map(item => item.interactiveMs);
  const browser = samples.map(item => item.browserOpenMs);
  const input = samples.map(item => item.inputLatencyMs);
  const memory = samples.map(item => item.privateMiBBeforeBrowser);
  const memoryAfterBrowser = samples.map(item => item.privateMiBAfterBrowser);
  const memoryDeltaAfterBrowser = samples.map(item => item.privateMiBDeltaAfterBrowser);
  const inputFixtureBytes = samples.map(item => item.inputFixtureBytes);
  const guestCountsBefore = samples.map(item => item.browserGuestCountBefore);
  const guestCountsAfter = samples.map(item => item.browserGuestCountAfter);
  const guestDeltas = samples.map(item => item.browserGuestCountDelta);
  const startupGuestViolations = samples.reduce((sum, item) => sum + item.startupGuestMonitor.guestViolations.length, 0);
  const startupReachableRuns = samples.filter(item => item.startupGuestMonitor.endpointReachable).length;
  const startupLifecycleVerifiedRuns = samples.filter(item => item.browserLifecycleBefore?.createCount === 0
    && item.browserLifecycleBefore?.firstCreatedAtMs === null
    && item.browserLifecycleBefore?.present === false).length;
  const startupMaximumGuestCount = Math.max(...samples.map(item => item.startupGuestMonitor.maximumGuestCount));
  const trustedPromptInputEvents = samples.map(item => item.promptInteractivity.trustedInputEvents);
  const submitClickInvocations = samples.map(item => item.promptInteractivity.submitClickInvocations);
  const baselineMiB = Number(process.env.NEWMARK_PERF_BASELINE_MIB || DEFAULT_BASELINE_PRIVATE_MIB);
  assert(Number.isFinite(baselineMiB) && baselineMiB > 0, `NEWMARK_PERF_BASELINE_MIB must be positive, received ${JSON.stringify(baselineMiB)}`);
  const runSet = summarizeRunSet(runs, samples);
  assert(runSet.consistent,
    `run/sample mismatch: requested=${runSet.requestedRuns}, completed=${runSet.completedRuns}, samples=${runSet.sampleCount}, sequential=${runSet.sequentialRunNumbers}`);
  const startupMemoryGate = startupMemoryAcceptance(round(percentile(memory, 0.95), 2), baselineMiB);
  const browserMemoryGate = browserOnDemandMemoryAcceptance(
    round(percentile(memoryAfterBrowser, 0.95), 2),
    round(percentile(memoryDeltaAfterBrowser, 0.95), 2),
  );
  const summary = {
    ok: true,
    version: '0.0.10',
    runs,
    sampleCount: samples.length,
    runSet,
    acceptanceEligible: runSet.acceptanceEligible,
    acceptancePassed: false,
    acceptanceStatus: runSet.acceptanceEligible ? 'pending-gates' : 'diagnostic-only',
    coldDefinition: 'fresh packaged process per run; one isolated persistent runtime root and Electron profile are reused across the run set; OS filesystem cache is not flushed',
    interactiveMs: { p50: percentile(interactive, 0.5), p95: percentile(interactive, 0.95), max: Math.max(...interactive) },
    browserOpenMs: { p50: percentile(browser, 0.5), p95: percentile(browser, 0.95), max: Math.max(...browser) },
    inputLatencyFourTimesCpuMs: { p50: round(percentile(input, 0.5), 2), p95: round(percentile(input, 0.95), 2), max: round(Math.max(...input), 2) },
    inputFixture: {
      minimumBytes: Math.min(...inputFixtureBytes),
      maximumBytes: Math.max(...inputFixtureBytes),
      linesPerRun: samples[0].inputFixtureLines,
    },
    privateMiBBeforeBrowser: { p50: round(percentile(memory, 0.5), 2), p95: round(percentile(memory, 0.95), 2), max: round(Math.max(...memory), 2) },
    privateMiBAfterBrowser: {
      p50: round(percentile(memoryAfterBrowser, 0.5), 2),
      p95: round(percentile(memoryAfterBrowser, 0.95), 2),
      max: round(Math.max(...memoryAfterBrowser), 2),
    },
    privateMiBDeltaAfterBrowser: {
      p50: round(percentile(memoryDeltaAfterBrowser, 0.5), 2),
      p95: round(percentile(memoryDeltaAfterBrowser, 0.95), 2),
      min: round(Math.min(...memoryDeltaAfterBrowser), 2),
      max: round(Math.max(...memoryDeltaAfterBrowser), 2),
    },
    browserGuestTargets: {
      beforeDemand: { min: Math.min(...guestCountsBefore), max: Math.max(...guestCountsBefore) },
      afterDemand: { min: Math.min(...guestCountsAfter), max: Math.max(...guestCountsAfter) },
      delta: { min: Math.min(...guestDeltas), max: Math.max(...guestDeltas) },
    },
    startupFirstFiveSeconds: {
      windowMs: STARTUP_GUEST_FREE_MS,
      endpointReachableRuns: startupReachableRuns,
      endpointReachabilityIsDiagnostic: true,
      lifecycleVerifiedRuns: startupLifecycleVerifiedRuns,
      requiredLifecycleVerifiedRuns: samples.length,
      browserGuestViolationCount: startupGuestViolations,
      maximumBrowserGuestCount: startupMaximumGuestCount,
    },
    promptInteractivity: {
      enabledAndWritableRuns: samples.filter(item => item.promptInteractivity.promptEnabled && item.promptInteractivity.promptWritable).length,
      trustedInputEvents: { min: Math.min(...trustedPromptInputEvents), max: Math.max(...trustedPromptInputEvents) },
      submitClickInvocations: { min: Math.min(...submitClickInvocations), max: Math.max(...submitClickInvocations) },
    },
    processClassPrivateMiBBeforeBrowser: summarizeProcessClasses(samples, 'processClassesBeforeBrowser'),
    processClassPrivateMiBAfterBrowser: summarizeProcessClasses(samples, 'processClassesAfterBrowser'),
    baselineMiB,
    privateMemoryAcceptance: {
      startupBeforeBrowser: startupMemoryGate,
      browserOnDemand: browserMemoryGate,
    },
    samples,
  };

  const persistSummary = () => {
    if (!outputPath) return;
    const resolved = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  };
  try {
    assert(summary.interactiveMs.p50 <= 3000, `interactive P50 exceeds 3s: ${summary.interactiveMs.p50}ms`);
    assert(summary.interactiveMs.p95 <= 5000, `interactive P95 exceeds 5s: ${summary.interactiveMs.p95}ms`);
    assert(summary.interactiveMs.max <= 8000, `interactive max exceeds 8s: ${summary.interactiveMs.max}ms`);
    assert(summary.browserOpenMs.p95 <= 2000, `first Browser open P95 exceeds 2s: ${summary.browserOpenMs.p95}ms`);
    assert(summary.inputLatencyFourTimesCpuMs.p95 <= 150, `4x CPU-throttled input P95 exceeds 150ms: ${summary.inputLatencyFourTimesCpuMs.p95}ms`);
    assert(summary.inputFixture.minimumBytes >= 64 * 1024,
      `large-input fixture minimum is below 64KiB: ${summary.inputFixture.minimumBytes} bytes`);
    assert(summary.browserGuestTargets.beforeDemand.max === 0,
      `Browser guest existed before demand: ${summary.browserGuestTargets.beforeDemand.max}`);
    assert(summary.browserGuestTargets.afterDemand.min === 1 && summary.browserGuestTargets.afterDemand.max === 1,
      `Browser guest count after demand was not exactly one: ${JSON.stringify(summary.browserGuestTargets.afterDemand)}`);
    assert(summary.browserGuestTargets.delta.min === 1 && summary.browserGuestTargets.delta.max === 1,
      `Browser guest demand delta was not exactly +1: ${JSON.stringify(summary.browserGuestTargets.delta)}`);
    assert(summary.startupFirstFiveSeconds.lifecycleVerifiedRuns === samples.length,
      `Browser lifecycle did not prove zero guest creation before demand in every run: ${summary.startupFirstFiveSeconds.lifecycleVerifiedRuns}/${samples.length}`);
    assert(summary.startupFirstFiveSeconds.browserGuestViolationCount === 0 && summary.startupFirstFiveSeconds.maximumBrowserGuestCount === 0,
      `Browser guest appeared during the first ${STARTUP_GUEST_FREE_MS}ms: ${JSON.stringify(summary.startupFirstFiveSeconds)}`);
    assert(summary.promptInteractivity.enabledAndWritableRuns === samples.length
      && summary.promptInteractivity.trustedInputEvents.min > 0
      && summary.promptInteractivity.submitClickInvocations.min === 1
      && summary.promptInteractivity.submitClickInvocations.max === 1,
      `prompt input/submit interactivity failed: ${JSON.stringify(summary.promptInteractivity)}`);
    assert(startupMemoryGate.passed,
      `startup private bytes P95 exceeds ${STARTUP_ABSOLUTE_PRIVATE_MIB_LIMIT}MiB and did not improve ${STARTUP_MINIMUM_REDUCTION_FRACTION * 100}% from ${baselineMiB}MiB: ${summary.privateMiBBeforeBrowser.p95}MiB`);
    assert(browserMemoryGate.passed,
      `Browser-on-demand private bytes exceeded its runaway limits: total P95 ${browserMemoryGate.totalP95MiB}MiB (limit ${browserMemoryGate.totalLimitMiB}MiB, passed=${browserMemoryGate.totalPassed}); delta P95 ${browserMemoryGate.deltaP95MiB}MiB (limit ${browserMemoryGate.deltaLimitMiB}MiB, passed=${browserMemoryGate.deltaPassed})`);
  } catch (error) {
    summary.ok = false;
    summary.acceptancePassed = false;
    summary.acceptanceStatus = 'failed';
    summary.failure = error instanceof Error ? error.message : String(error);
    persistSummary();
    console.log(JSON.stringify(summary, null, 2));
    throw error;
  }

  summary.acceptancePassed = summary.acceptanceEligible;
  summary.acceptanceStatus = summary.acceptanceEligible ? 'passed' : 'diagnostic-only';
  persistSummary();
  console.log(JSON.stringify(summary, null, 2));
  await removeTreeWithRetries(benchmarkSuiteTempRoot, null);
  benchmarkSuiteTempRoot = '';
})().catch(async error => {
  if (benchmarkSuiteTempRoot) {
    try { await removeTreeWithRetries(benchmarkSuiteTempRoot, null); } catch {}
    benchmarkSuiteTempRoot = '';
  }
  console.error(`[benchmark-dev010-startup-memory] ${error.stack || error.message}`);
  process.exitCode = 1;
});
