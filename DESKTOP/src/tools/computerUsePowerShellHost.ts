import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as readline from 'readline';

type HelperLane = 'action' | 'uia' | 'windows' | 'uia_advisory' | 'windows_advisory' | 'sparse';

interface PendingRequest {
  resolve: (result: PowerShellResult) => void;
  timer: NodeJS.Timeout;
}

interface ReadinessWaiter {
  child: ChildProcessWithoutNullStreams;
  resolve: (ready: boolean) => void;
  timer: NodeJS.Timeout;
}

export interface PowerShellResult {
  ok: boolean;
  output: string;
  elapsedMs: number;
}

function createHostScript(includeUiAutomation: boolean): string {
  return [
    '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    ...(includeUiAutomation ? ['Add-Type -AssemblyName UIAutomationClient', 'Add-Type -AssemblyName UIAutomationTypes'] : []),
    ...(includeUiAutomation ? [`if (-not ("NewmarkComputerUseNative" -as [type])) { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class NewmarkComputerUseNative { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }' }`] : []),
    ...(!includeUiAutomation ? [`if (-not ("NewmarkSparseCapture" -as [type])) { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class NewmarkSparseCapture { [StructLayout(LayoutKind.Sequential)] struct BitmapInfoHeader { public uint Size; public int Width; public int Height; public ushort Planes; public ushort BitCount; public uint Compression; public uint SizeImage; public int XPelsPerMeter; public int YPelsPerMeter; public uint ColorsUsed; public uint ColorsImportant; } [StructLayout(LayoutKind.Sequential)] struct BitmapInfo { public BitmapInfoHeader Header; public uint Colors; } [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd); [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc); [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc); [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc); [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr hdc, ref BitmapInfo info, uint usage, out IntPtr bits, IntPtr section, uint offset); [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj); [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj); [DllImport("gdi32.dll")] static extern int SetStretchBltMode(IntPtr hdc, int mode); [DllImport("gdi32.dll")] static extern bool SetBrushOrgEx(IntPtr hdc, int x, int y, IntPtr oldOrigin); [DllImport("gdi32.dll", SetLastError=true)] static extern bool StretchBlt(IntPtr dst, int dx, int dy, int dw, int dh, IntPtr src, int sx, int sy, int sw, int sh, int operation); [DllImport("gdi32.dll")] static extern bool GdiFlush(); public sealed class Capture : IDisposable { private int width; private byte[] pixels; internal Capture(int w, byte[] p) { width=w; pixels=p; } public byte GetLuma(int x, int y) { int offset=(y*width+x)*4; return (byte)Math.Round((pixels[offset+2]*0.299)+(pixels[offset+1]*0.587)+(pixels[offset]*0.114)); } public void Dispose() { pixels=null; } } public static Capture CaptureScaled(int x, int y, int width, int height, int targetWidth, int targetHeight) { IntPtr screen=GetDC(IntPtr.Zero); if (screen == IntPtr.Zero) throw new InvalidOperationException("Could not read desktop DC."); IntPtr memory=IntPtr.Zero; IntPtr bitmap=IntPtr.Zero; IntPtr previous=IntPtr.Zero; IntPtr bits=IntPtr.Zero; try { memory=CreateCompatibleDC(screen); BitmapInfo info=new BitmapInfo(); info.Header.Size=(uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(BitmapInfoHeader)); info.Header.Width=targetWidth; info.Header.Height=-targetHeight; info.Header.Planes=1; info.Header.BitCount=32; info.Header.Compression=0; info.Header.SizeImage=(uint)(targetWidth*targetHeight*4); bitmap=CreateDIBSection(screen,ref info,0,out bits,IntPtr.Zero,0); if (memory == IntPtr.Zero || bitmap == IntPtr.Zero || bits == IntPtr.Zero) throw new InvalidOperationException("Could not allocate sparse DIB section."); previous=SelectObject(memory,bitmap); if (previous == IntPtr.Zero) throw new InvalidOperationException("Could not select sparse DIB section."); if (SetStretchBltMode(memory,4)==0 || !SetBrushOrgEx(memory,0,0,IntPtr.Zero)) throw new InvalidOperationException("Could not configure sparse capture scaling."); if (!StretchBlt(memory,0,0,targetWidth,targetHeight,screen,x,y,width,height,0x00CC0020)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); if (!GdiFlush()) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); byte[] pixels=new byte[targetWidth*targetHeight*4]; Marshal.Copy(bits,pixels,0,pixels.Length); return new Capture(targetWidth,pixels); } finally { if (memory != IntPtr.Zero && previous != IntPtr.Zero) SelectObject(memory,previous); if (bitmap != IntPtr.Zero) DeleteObject(bitmap); if (memory != IntPtr.Zero) DeleteDC(memory); ReleaseDC(IntPtr.Zero,screen); } } }' }`] : []),
    '$hostReady = @{ id="__newmark_ready__"; ready=$true }; [Console]::Out.WriteLine(($hostReady | ConvertTo-Json -Compress)); [Console]::Out.Flush()',
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
}

const HOST_SCRIPT = createHostScript(true);
const SPARSE_HOST_SCRIPT = createHostScript(false);

class PowerShellWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readyChild: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private readinessWaiters = new Set<ReadinessWaiter>();
  private restarting = false;
  private unavailableUntil = 0;

  constructor(private readonly lane: HelperLane) {}

  ready(): boolean {
    return Date.now() >= this.unavailableUntil
      && !!this.child
      && !this.child.killed
      && this.child.exitCode === null
      && this.readyChild === this.child;
  }

  async prepare(timeoutMs: number): Promise<{ ready: boolean; elapsedMs: number }> {
    const startedAt = Date.now();
    if (Date.now() < this.unavailableUntil) return { ready: false, elapsedMs: 0 };
    const child = this.ensureChild();
    if (this.readyChild === child) return { ready: true, elapsedMs: Date.now() - startedAt };
    const ready = await new Promise<boolean>(resolve => {
      let settled = false;
      let waiter: ReadinessWaiter;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(waiter.timer);
        this.readinessWaiters.delete(waiter);
        resolve(value);
      };
      waiter = {
        child,
        resolve: finish,
        timer: setTimeout(() => finish(false), Math.max(0, Math.floor(timeoutMs))),
      };
      this.readinessWaiters.add(waiter);
      if (this.readyChild === child) finish(true);
    });
    return { ready, elapsedMs: Date.now() - startedAt };
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
    this.readyChild = null;
    if (child) this.resolveReadiness(child, false);
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
      this.lane === 'sparse' ? SPARSE_HOST_SCRIPT : HOST_SCRIPT,
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.setDefaultEncoding('utf8');
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => this.handleLine(line, child));
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${String(chunk)}`.slice(-8192);
    });
    child.once('error', error => {
      if (this.child !== child) return;
      this.child = null;
      this.readyChild = null;
      this.resolveReadiness(child, false);
      this.rejectPending(error.message);
    });
    child.once('exit', (code, signal) => {
      lines.close();
      if (this.child !== child) return;
      this.child = null;
      this.readyChild = null;
      this.resolveReadiness(child, false);
      this.rejectPending(`Computer Use ${this.lane} helper exited (${code ?? signal ?? 'unknown'}).${stderr ? ` ${stderr.trim()}` : ''}`);
    });
    this.child = child;
    return child;
  }

  private handleLine(line: string, child: ChildProcessWithoutNullStreams): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (String(parsed.id || '') === '__newmark_ready__' && parsed.ready === true) {
      if (this.child === child) {
        this.readyChild = child;
        this.resolveReadiness(child, true);
      }
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

  private resolveReadiness(child: ChildProcessWithoutNullStreams, ready: boolean): void {
    for (const waiter of [...this.readinessWaiters]) {
      if (waiter.child === child) waiter.resolve(ready);
    }
  }
}

const workers: Record<HelperLane, PowerShellWorker> = {
  action: new PowerShellWorker('action'),
  uia: new PowerShellWorker('uia'),
  windows: new PowerShellWorker('windows'),
  uia_advisory: new PowerShellWorker('uia_advisory'),
  windows_advisory: new PowerShellWorker('windows_advisory'),
  sparse: new PowerShellWorker('sparse'),
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
    workers.sparse.stop();
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

export async function prepareComputerUsePowerShellLane(lane: HelperLane, timeoutMs: number): Promise<{ ready: boolean; elapsedMs: number }> {
  if (process.platform !== 'win32') return { ready: false, elapsedMs: 0 };
  registerCleanup();
  return await workers[lane].prepare(timeoutMs);
}

export function stopComputerUsePowerShellLane(lane: HelperLane): void {
  workers[lane].stop();
}

export function stopComputerUsePowerShellHost(): void {
  workers.action.stop();
  workers.uia.stop();
  workers.windows.stop();
  workers.uia_advisory.stop();
  workers.windows_advisory.stop();
  workers.sparse.stop();
}
