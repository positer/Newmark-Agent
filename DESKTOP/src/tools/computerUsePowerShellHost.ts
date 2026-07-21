import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as readline from 'readline';

type HelperLane = 'action' | 'uia' | 'windows' | 'uia_advisory' | 'windows_advisory';

interface PendingRequest {
  resolve: (result: PowerShellResult) => void;
  timer: NodeJS.Timeout;
}

export interface PowerShellResult {
  ok: boolean;
  output: string;
  elapsedMs: number;
}

const HOST_SCRIPT = [
  '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  'Add-Type -AssemblyName UIAutomationClient',
  'Add-Type -AssemblyName UIAutomationTypes',
  `if (-not ("NewmarkComputerUseNative" -as [type])) { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class NewmarkComputerUseNative { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }' }`,
  'while (($line = [Console]::In.ReadLine()) -ne $null) {',
  '  $id = ""',
  '  $timer = [System.Diagnostics.Stopwatch]::StartNew()',
  '  try {',
  '    $request = $line | ConvertFrom-Json',
  '    $id = [string]$request.id',
  '    $source = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([string]$request.script))',
  '    $previousPreference = $ErrorActionPreference',
  '    $ErrorActionPreference = "Stop"',
  '    try { $output = (& ([scriptblock]::Create($source)) 2>&1 | Out-String -Width 1048576).Trim() } finally { $ErrorActionPreference = $previousPreference }',
  '    $response = @{ id=$id; ok=$true; output=$output; elapsed_ms=[int]$timer.ElapsedMilliseconds }',
  '  } catch {',
  '    $response = @{ id=$id; ok=$false; output=[string]$_; elapsed_ms=[int]$timer.ElapsedMilliseconds }',
  '  }',
  '  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 6))',
  '  [Console]::Out.Flush()',
  '}',
].join('; ');

class PowerShellWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private restarting = false;
  private unavailableUntil = 0;

  constructor(private readonly lane: HelperLane) {}

  ready(): boolean {
    return Date.now() >= this.unavailableUntil && !!this.child && !this.child.killed && this.child.exitCode === null;
  }

  async run(script: string, timeoutMs: number): Promise<PowerShellResult> {
    const startedAt = Date.now();
    if (Date.now() < this.unavailableUntil) {
      return { ok: false, output: `Computer Use ${this.lane} helper is cooling down after a timeout.`, elapsedMs: 0 };
    }
    try {
      const result = await this.send(script, timeoutMs);
      this.unavailableUntil = 0;
      return result;
    } catch (error) {
      if (error instanceof Error && /timed out after/i.test(error.message)) {
        // A timed-out PowerShell script is still occupying the single lane.
        // Restart the helper, but do not replay the same advisory UIA query and
        // double its tail latency. The caller can continue with a screenshot or
        // return the bounded warning result.
        this.stop();
        this.unavailableUntil = Date.now() + 60_000;
        return { ok: false, output: error.message, elapsedMs: Date.now() - startedAt };
      }
      if (this.restarting) throw error;
      this.restarting = true;
      try {
        this.stop();
        const retried = await this.send(script, timeoutMs);
        return { ...retried, elapsedMs: Date.now() - startedAt };
      } finally {
        this.restarting = false;
      }
    }
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill();
    this.rejectPending(`Computer Use ${this.lane} helper stopped.`);
  }

  private async send(script: string, timeoutMs: number): Promise<PowerShellResult> {
    const child = this.ensureChild();
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    return await new Promise<PowerShellResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Computer Use ${this.lane} helper timed out after ${timeoutMs} ms.`));
      }, Math.max(100, timeoutMs));
      this.pending.set(id, {
        timer,
        resolve: result => resolve({ ...result, elapsedMs: Date.now() - startedAt }),
      });
      const request = JSON.stringify({
        id,
        script: Buffer.from(script, 'utf8').toString('base64'),
      });
      child.stdin.write(`${request}\n`, 'utf8', error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child;
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      HOST_SCRIPT,
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.setDefaultEncoding('utf8');
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => this.handleLine(line));
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${String(chunk)}`.slice(-8192);
    });
    child.once('error', error => {
      if (this.child !== child) return;
      this.child = null;
      this.rejectPending(error.message);
    });
    child.once('exit', (code, signal) => {
      lines.close();
      if (this.child !== child) return;
      this.child = null;
      this.rejectPending(`Computer Use ${this.lane} helper exited (${code ?? signal ?? 'unknown'}).${stderr ? ` ${stderr.trim()}` : ''}`);
    });
    this.child = child;
    return child;
  }

  private handleLine(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = String(parsed.id || '');
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve({
      ok: parsed.ok === true,
      output: String(parsed.output || ''),
      elapsedMs: Math.max(0, Number(parsed.elapsed_ms || 0)),
    });
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, output: message, elapsedMs: 0 });
    }
    this.pending.clear();
  }
}

const workers: Record<HelperLane, PowerShellWorker> = {
  action: new PowerShellWorker('action'),
  uia: new PowerShellWorker('uia'),
  windows: new PowerShellWorker('windows'),
  uia_advisory: new PowerShellWorker('uia_advisory'),
  windows_advisory: new PowerShellWorker('windows_advisory'),
};

let cleanupRegistered = false;

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const stop = () => {
    workers.action.stop();
    workers.uia.stop();
    workers.windows.stop();
    workers.uia_advisory.stop();
    workers.windows_advisory.stop();
  };
  process.once('exit', stop);
}

export async function runPersistentPowerShell(script: string, timeoutMs = 30000, lane: HelperLane = 'action'): Promise<PowerShellResult> {
  if (process.platform !== 'win32') {
    return { ok: false, output: 'Persistent PowerShell helper is Windows-only.', elapsedMs: 0 };
  }
  registerCleanup();
  return await workers[lane].run(script, timeoutMs);
}

export function computerUsePowerShellLaneReady(lane: HelperLane): boolean {
  return process.platform === 'win32' && workers[lane].ready();
}

export function stopComputerUsePowerShellHost(): void {
  workers.action.stop();
  workers.uia.stop();
  workers.windows.stop();
  workers.uia_advisory.stop();
  workers.windows_advisory.stop();
}
