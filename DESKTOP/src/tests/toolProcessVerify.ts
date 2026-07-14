import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../core/config';
import { runAsyncProcess, runAsyncWindowsBatch } from '../core/asyncProcess';
import { LLMProvider } from '../llm/provider';
import { SshManager, SshRunner } from '../core/ssh';
import { ToolExecutionContext, ToolExecutor } from '../tools';

let assertions = 0;

function assert(condition: unknown, message: string): asserts condition {
  assertions += 1;
  if (!condition) throw new Error(`Assertion ${assertions} failed: ${message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shellPath(value: string): string {
  if (process.platform === 'win32') return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function nodeScriptCommand(scriptPath: string): string {
  if (process.platform === 'win32') return `& ${shellPath(process.execPath)} ${shellPath(scriptPath)}`;
  return `${shellPath(process.execPath)} ${shellPath(scriptPath)}`;
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-tool-process-'));
  try {
    const config = new ConfigManager(root);
    const tools = new ToolExecutor(root, config);
    let watchdogElapsed = 0;
    let treeAbortElapsed = 0;

    const timerScript = path.join(root, 'timer-command.cjs');
    fs.writeFileSync(timerScript, 'setTimeout(() => process.stdout.write("timer-command-done\\n"), 500);\n', 'utf8');
    const timerStartedAt = Date.now();
    let timerFiredAt = 0;
    const timer = setTimeout(() => { timerFiredAt = Date.now(); }, 40);
    const timerResult = await tools.execute('bash', JSON.stringify({ command: nodeScriptCommand(timerScript), timeout_ms: 5_000 }), root);
    const commandFinishedAt = Date.now();
    clearTimeout(timer);
    assert(timerResult.includes('timer-command-done'), 'bash preserves command stdout');
    assert(timerFiredAt > 0, 'bash does not block the worker event loop timer');
    // A first CreateProcess/PowerShell launch can itself take close to a second on a
    // cold Windows host (Defender and image paging are outside Node's event loop).
    // The regression we need to catch is waiting synchronously for the child
    // command lifetime, so use the relative gap to command completion as the
    // portable non-blocking invariant instead of an absolute scheduler deadline.
    assert(
      timerFiredAt - timerStartedAt < commandFinishedAt - timerStartedAt - 150,
      `40 ms timer fires before the 500 ms child lifetime completes (timer=${timerFiredAt - timerStartedAt} ms, command=${commandFinishedAt - timerStartedAt} ms)`,
    );
    assert(commandFinishedAt - timerFiredAt >= 150, 'timer fires materially before command completion');

    if (process.platform === 'win32') {
      // Make the taskkill launch succeed without killing the fixture process.
      // The target then keeps its pipes open past the cancellation budget, which
      // deterministically proves that settlement does not depend on child close.
      const fakeTaskkillPath = path.join(root, 'taskkill.exe');
      const watchdogPidPath = path.join(root, 'watchdog-child.pid');
      const watchdogScript = path.join(root, 'watchdog-child.cjs');
      const whereExe = path.join(String(process.env.SystemRoot || 'C:\\Windows'), 'System32', 'where.exe');
      assert(fs.existsSync(whereExe), 'Windows settlement fixture has the system where.exe helper');
      fs.copyFileSync(whereExe, fakeTaskkillPath);
      fs.writeFileSync(watchdogScript, [
        "const fs = require('fs');",
        "fs.writeFileSync(process.argv[2], String(process.pid), 'utf8');",
        'setTimeout(() => process.exit(0), 1400);',
        '',
      ].join('\n'), 'utf8');

      const previousCwd = process.cwd();
      const watchdogAbort = new AbortController();
      const watchdogStartedAt = Date.now();
      const watchdogAbortTimer = setTimeout(() => watchdogAbort.abort(new Error('settlement-watchdog-test-abort')), 50);
      let watchdogResult;
      try {
        process.chdir(root);
        watchdogResult = await runAsyncProcess(process.execPath, [watchdogScript, watchdogPidPath], {
          cwd: root,
          signal: watchdogAbort.signal,
        });
        watchdogElapsed = Date.now() - watchdogStartedAt;
      } finally {
        clearTimeout(watchdogAbortTimer);
        process.chdir(previousCwd);
      }
      if (fs.existsSync(watchdogPidPath)) {
        const watchdogPid = Number(fs.readFileSync(watchdogPidPath, 'utf8'));
        if (Number.isInteger(watchdogPid) && watchdogPid > 0) {
          try { process.kill(watchdogPid, 'SIGKILL'); } catch {}
        }
      }
      assert(watchdogResult.aborted && /settlement-watchdog-test-abort/.test(watchdogResult.error || ''), 'settlement watchdog preserves the AbortSignal result');
      assert(watchdogElapsed < 900, `runAsyncProcess settles independently of delayed taskkill/close (elapsed=${watchdogElapsed} ms)`);
    }

    const markerPath = path.join(root, 'descendant-marker.txt');
    const childScript = path.join(root, 'abort-child.cjs');
    const parentScript = path.join(root, 'abort-parent.cjs');
    fs.writeFileSync(childScript, [
      "const fs = require('fs');",
      'const marker = process.argv[2];',
      "setTimeout(() => { fs.writeFileSync(marker, 'descendant-survived', 'utf8'); }, 4000);",
      'setTimeout(() => process.exit(0), 5000);',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(parentScript, [
      "const { spawn } = require('child_process');",
      'spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: \'ignore\', windowsHide: true });',
      'setTimeout(() => process.exit(0), 30000);',
      '',
    ].join('\n'), 'utf8');
    const abortController = new AbortController();
    const abortStartedAt = Date.now();
    const abortTimer = setTimeout(() => abortController.abort(new Error('tool-process-test-abort')), 100);
    const abortCommand = `${nodeScriptCommand(parentScript)} ${shellPath(childScript)} ${shellPath(markerPath)}`;
    const abortResult = await tools.execute(
      'bash',
      JSON.stringify({ command: abortCommand, timeout_ms: 30_000 }),
      root,
      { signal: abortController.signal } as ToolExecutionContext,
    );
    clearTimeout(abortTimer);
    const abortElapsed = Date.now() - abortStartedAt;
    treeAbortElapsed = abortElapsed;
    assert(abortElapsed < 3_500, `AbortSignal stops the Windows/POSIX command tree within its bounded cancellation budget (elapsed=${abortElapsed} ms)`);
    assert(/abort/i.test(abortResult), 'aborted bash keeps a visible bash result');
    await delay(Math.max(750, 4_300 - abortElapsed));
    assert(!fs.existsSync(markerPath), 'aborting bash terminates descendant processes before they can write');

    if (process.platform === 'win32') {
      const batchEchoScript = path.join(root, 'batch-echo.cjs');
      const batchLauncher = path.join(root, 'batch-launcher.cmd');
      const batchPowerShellLauncher = path.join(root, 'batch-launcher.ps1');
      const injectionMarker = path.join(root, 'batch-injected.txt');
      fs.writeFileSync(batchEchoScript, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n', 'utf8');
      fs.writeFileSync(batchLauncher, `@echo off\r\n"${process.execPath}" "%~dp0batch-echo.cjs" %*\r\n`, 'utf8');
      const psQuote = (value: string) => value.replace(/'/g, "''");
      fs.writeFileSync(batchPowerShellLauncher, [
        'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$CommandArgs)',
        `& '${psQuote(process.execPath)}' '${psQuote(batchEchoScript)}' @CommandArgs`,
        'exit $LASTEXITCODE',
        '',
      ].join('\r\n'), 'utf8');
      const batchArguments = [
        'space value',
        `literal & echo injected>"${injectionMarker}"`,
        'pipe|semicolon;quote"percent%PATH%',
      ];
      const batchResult = await runAsyncWindowsBatch(batchLauncher, batchArguments, { timeoutMs: 10_000 });
      assert(batchResult.status === 0 && !batchResult.error, `Windows batch launcher executes asynchronously (${batchResult.error || batchResult.stderr})`);
      assert(batchResult.stdout.trim() === JSON.stringify(batchArguments), `Windows batch launcher forwards metacharacter-rich argv without interpolation (actual=${batchResult.stdout.trim()})`);
      assert(!fs.existsSync(injectionMarker), 'Windows batch launcher does not execute command text embedded in an argument');
      const npmShimResult = await runAsyncWindowsBatch('npm.cmd', ['--version'], { timeoutMs: 10_000 });
      assert(npmShimResult.status === 0 && /^\d+\.\d+\.\d+/.test(npmShimResult.stdout.trim()), 'real npm.cmd companion shim executes through the same safe asynchronous path');
    }

    const sshRoot = path.join(root, 'ssh');
    fs.mkdirSync(path.join(sshRoot, 'Work'), { recursive: true });
    let sshSignal: AbortSignal | undefined;
    const sshRunner: SshRunner = async (
      _command: string,
      args: string[],
      _cwd?: string,
      _timeoutMs?: number,
      signal?: AbortSignal,
    ) => {
      sshSignal = signal;
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return { status: 0, stdout: '', stderr: '', args };
    };
    const sshManager = new SshManager(sshRoot, sshRunner);
    const sshTools = new ToolExecutor(sshRoot, new ConfigManager(sshRoot), sshManager);
    const sshSaved = JSON.parse(await sshTools.execute('ssh_workspace', JSON.stringify({
      action: 'upsert', name: 'Abort SSH', host: '127.0.0.1', port: 22, user: 'tester',
    }), sshRoot)) as { connection: { id: string } };
    const sshAbort = new AbortController();
    const sshPromise = sshTools.execute('ssh_workspace', JSON.stringify({
      action: 'validate', id: sshSaved.connection.id,
    }), sshRoot, { signal: sshAbort.signal } as ToolExecutionContext);
    setTimeout(() => sshAbort.abort(new Error('ssh-test-abort')), 50);
    const sshResult = await sshPromise;
    assert(sshSignal === sshAbort.signal, 'ssh_workspace forwards the kernel AbortSignal to its runner');
    assert(/abort|error/i.test(sshResult), 'ssh_workspace resolves a controlled error after cancellation');

    const originalFetch = globalThis.fetch;
    let imageFetchAborted = false;
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => {
        imageFetchAborted = true;
        const error = new Error('image fetch aborted');
        error.name = 'AbortError';
        reject(error);
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    })) as typeof fetch;
    try {
      const imageAbort = new AbortController();
      const startedImage = Date.now();
      const imagePromise = new LLMProvider('abort-image', 'https://image.test/v1', 'test-key', 'openai')
        .generateImage('fixture-image', 'cancel this image', '256x256', imageAbort.signal)
        .then(() => false, () => true);
      imageAbort.abort(new Error('image generation stop test'));
      assert(await imagePromise && imageFetchAborted && Date.now() - startedImage < 500, 'image_generate forwards AbortSignal into provider fetch and stops promptly');
    } finally {
      globalThis.fetch = originalFetch;
    }

    const toolsSource = fs.readFileSync(path.join(__dirname, '..', 'tools', 'index.js'), 'utf8');
    const sshSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'ssh.js'), 'utf8');
    const agentSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'agent.js'), 'utf8');
    const runnerSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'agentKernelRunner.js'), 'utf8');
    assert(!/\b(?:spawnSync|execSync)\b/.test(toolsSource), 'built ToolExecutor has no synchronous child-process execution');
    assert(!/\b(?:spawnSync|execSync)\b/.test(sshSource), 'built SSH manager has no synchronous child-process execution');
    assert(!/\bexecSync\b/.test(agentSource) && agentSource.includes('runAsyncWindowsBatch'), 'OpenCode uses the cancellable asynchronous Windows batch path instead of execSync');
    assert(runnerSource.includes('handleImageGeneration(args, signal)') && runnerSource.includes('handleFlowRun(args, signal)') && runnerSource.includes('handleMemoryLabTool(name, args, signal)') && runnerSource.includes('handleAutomationTool(name, args, signal)'), 'kernel special tools receive the same run AbortSignal as ordinary ToolExecutor calls');

    console.log(`TOOL_PROCESS_VERIFY_OK assertions=${assertions} watchdog_ms=${process.platform === 'win32' ? watchdogElapsed : 'n/a'} tree_abort_ms=${treeAbortElapsed}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
