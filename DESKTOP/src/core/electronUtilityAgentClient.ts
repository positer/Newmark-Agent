import { utilityProcess } from 'electron';
import { spawn } from 'child_process';
import { ConversationRuntimeTarget, NormalizedConversationTarget, normalizeConversationTarget } from './conversationTarget';
import { AgentWorkEvent, ConversationInputEnvelope, GuideReceipt } from './types';
import {
  UtilityAgentPromptResult,
  UtilityAgentRequest,
  UtilityAgentResponse,
  UtilityAgentSnapshotResult,
  UtilityAgentStopResult,
  UtilityHostToolRequest,
  UtilityHostToolResult,
  UtilityPromptRequest,
} from './utilityAgentProtocol';

type UtilityChild = ReturnType<typeof utilityProcess.fork>;
// PowerShell startup plus Add-Type compilation can exceed three seconds on a
// cold or busy Windows host even though Toolhelp itself is healthy.
const WINDOWS_TREE_SNAPSHOT_TIMEOUT_MS = 12_000;
const WINDOWS_TREE_PRIMARY_HOOK_TIMEOUT_MS = 4_000;
const WINDOWS_TREE_MAX_RESCANS = 6;
const WINDOWS_TREE_STABLE_EMPTY_RESCANS = 3;
const WINDOWS_TREE_RESCAN_DELAY_MS = 75;
const WINDOWS_TREE_RESCAN_TIMEOUT_MS = 4_000;
const WINDOWS_TREE_IDENTITY_KILL_TIMEOUT_MS = 4_000;
const WINDOWS_TREE_FORCE_STOP_DEADLINE_MS = 29_000;
const WINDOWS_HELPER_CLOSE_GRACE_MS = 750;
const activeWindowsProcessHelpers = new Map<number, { child: ReturnType<typeof spawn>; pid: number; ownerKey: string }>();
const windowsProcessHelperIds = new WeakMap<ReturnType<typeof spawn>, number>();
const windowsProcessHelperRetryTimers = new Map<number, ReturnType<typeof setTimeout>>();
let windowsProcessHelperSequence = 0;
let windowsProcessHelpersShuttingDown = false;
let windowsProcessQueryScriptOverrideForTest: string | null = null;

export function activeWindowsProcessHelperPidsForTest(): number[] {
  return [...activeWindowsProcessHelpers.values()].map(record => record.pid);
}

export function setWindowsProcessQueryScriptForTest(script: string | null): void {
  windowsProcessQueryScriptOverrideForTest = script;
}

function trackWindowsProcessHelper(child: ReturnType<typeof spawn>, ownerKey: string): void {
  const pid = Number(child.pid || 0);
  const helperId = ++windowsProcessHelperSequence;
  windowsProcessHelperIds.set(child, helperId);
  if (pid > 0) activeWindowsProcessHelpers.set(helperId, { child, pid, ownerKey });
  child.once('close', () => {
    if (pid <= 0) return;
    const record = activeWindowsProcessHelpers.get(helperId);
    if (record?.child === child) activeWindowsProcessHelpers.delete(helperId);
    const retry = windowsProcessHelperRetryTimers.get(helperId);
    if (retry) clearTimeout(retry);
    windowsProcessHelperRetryTimers.delete(helperId);
  });
}

export function trackWindowsProcessHelperForTest(child: ReturnType<typeof spawn>, ownerKey = 'test'): void {
  trackWindowsProcessHelper(child, ownerKey);
}

function windowsProcessHelperExited(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function requestWindowsProcessHelperDrain(child: ReturnType<typeof spawn>): void {
  const helperId = windowsProcessHelperIds.get(child);
  if (!helperId || windowsProcessHelperExited(child) || activeWindowsProcessHelpers.get(helperId)?.child !== child) return;
  try { child.kill(); } catch {}
  if (windowsProcessHelperRetryTimers.has(helperId)) return;
  const timer = setTimeout(() => {
    windowsProcessHelperRetryTimers.delete(helperId);
    requestWindowsProcessHelperDrain(child);
  }, Math.max(50, Math.floor(WINDOWS_HELPER_CLOSE_GRACE_MS / 3)));
  timer.unref?.();
  windowsProcessHelperRetryTimers.set(helperId, timer);
}

async function terminateWindowsProcessHelperAndWait(child: ReturnType<typeof spawn>): Promise<boolean> {
  if (windowsProcessHelperExited(child) || !child.pid) return true;
  const closed = new Promise<boolean>(resolve => child.once('close', () => resolve(true)));
  requestWindowsProcessHelperDrain(child);
  return await Promise.race([
    closed,
    delay(WINDOWS_HELPER_CLOSE_GRACE_MS).then(() => false),
  ]);
}

export async function terminateWindowsProcessHelperForTest(child: ReturnType<typeof spawn>): Promise<boolean> {
  return await terminateWindowsProcessHelperAndWait(child);
}

/** Drain helper handles during backend shutdown or before a cleanup-only retry. */
export async function drainWindowsProcessHelpers(timeoutMs = 5_000, ownerKey?: string): Promise<void> {
  const deadline = Date.now() + Math.max(WINDOWS_HELPER_CLOSE_GRACE_MS, timeoutMs);
  while (true) {
    const matching = [...activeWindowsProcessHelpers.values()]
      .filter(record => ownerKey === undefined || record.ownerKey === ownerKey);
    if (!matching.length) return;
    for (const { child } of matching) requestWindowsProcessHelperDrain(child);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Windows process helper drain timed out; retained helper PIDs: ${matching.map(record => record.pid).join(', ')}`);
    }
    await delay(Math.min(100, remaining));
  }
}

export async function shutdownWindowsProcessHelpers(timeoutMs = 5_000): Promise<void> {
  windowsProcessHelpersShuttingDown = true;
  await drainWindowsProcessHelpers(timeoutMs);
}

export interface WindowsProcessTreeEntry {
  pid: number;
  parentPid: number;
  depth: number;
  creationIdentity: string;
}

export interface WindowsProcessTreeSnapshot {
  rootPid: number;
  entries: WindowsProcessTreeEntry[];
}

export interface WindowsUtilityProcessTreeOptions {
  snapshot?: (
    rootPid: number,
    timeoutMs: number,
    anchorPids?: readonly number[],
    ownerKey?: string,
  ) => Promise<WindowsProcessTreeSnapshot>;
  primaryKill?: (rootPid: number, timeoutMs: number) => Promise<boolean>;
  terminatePid?: (pid: number, creationIdentity: string) => void | Promise<void>;
  snapshotTimeoutMs?: number;
  primaryTimeoutMs?: number;
  maxRescans?: number;
  stableEmptyRescans?: number;
  rescanDelayMs?: number;
  rescanTimeoutMs?: number;
  identityKillTimeoutMs?: number;
  forceStopDeadlineMs?: number;
  helperOwnerKey?: string;
}

export interface ElectronUtilityAgentClientOptions {
  windowsProcessTree?: WindowsUtilityProcessTreeOptions;
  killChild?: (defaultKill: () => boolean) => boolean;
  /** Test seam used to prove concurrent callers cannot bypass startup readiness. */
  startupGate?: () => void | Promise<void>;
}

function runWindowsProcessQuery(rootPid: number, timeoutMs: number, anchorPids: readonly number[] = [], ownerKey = 'global'): Promise<string> {
  if (windowsProcessHelpersShuttingDown) return Promise.reject(new Error('Windows process helper subsystem is shutting down'));
  const encodedAnchors = [...new Set(anchorPids)]
    .filter(pid => Number.isInteger(pid) && pid > 0)
    .map(pid => String(pid))
    .join(';');
  const script = String.raw`$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class NewmarkProcessSnapshot {
  private const uint TH32CS_SNAPPROCESS = 0x00000002;
  private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
  private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct PROCESSENTRY32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)]
  private struct FILETIME { public uint Low; public uint High; }
  private static string CreationIdentity(uint pid) {
    IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (process == IntPtr.Zero) return "";
    try {
      FILETIME creation, exit, kernel, user;
      if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return "";
      ulong value = ((ulong)creation.High << 32) | creation.Low;
      return value.ToString(System.Globalization.CultureInfo.InvariantCulture);
    } finally { CloseHandle(process); }
  }
  public static string Capture(uint rootPid, string encodedAnchors) {
    IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      var processes = new List<Tuple<uint, uint>>();
      var entry = new PROCESSENTRY32();
      entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      if (Process32FirstW(snapshot, ref entry)) {
        do { processes.Add(Tuple.Create(entry.th32ProcessID, entry.th32ParentProcessID)); }
        while (Process32NextW(snapshot, ref entry));
      }
      var owned = new HashSet<uint>();
      owned.Add(rootPid);
      foreach (string encoded in encodedAnchors.Split(new[]{';'}, StringSplitOptions.RemoveEmptyEntries))
        owned.Add(UInt32.Parse(encoded, System.Globalization.CultureInfo.InvariantCulture));
      bool changed;
      do {
        changed = false;
        foreach (var process in processes) {
          if (!owned.Contains(process.Item2) || owned.Contains(process.Item1)) continue;
          owned.Add(process.Item1);
          changed = true;
        }
      } while (changed);
      var rows = new List<string>();
      foreach (var process in processes) {
        if (!owned.Contains(process.Item1)) continue;
        rows.Add(process.Item1.ToString() + "," + process.Item2.ToString() + "," + CreationIdentity(process.Item1));
      }
      return string.Join("\n", rows);
    } finally { CloseHandle(snapshot); }
  }
}
'@
Add-Type -TypeDefinition $source
[NewmarkProcessSnapshot]::Capture(${rootPid}, '${encodedAnchors}')`;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let query: ReturnType<typeof spawn>;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let terminalError: Error | null = null;
    let drainStarted = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    const failAfterDrain = (error: Error): void => {
      if (!terminalError) terminalError = error;
      if (drainStarted) return;
      drainStarted = true;
      void terminateWindowsProcessHelperAndWait(query).then(() => finish(terminalError!));
    };
    try {
      query = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsProcessQueryScriptOverrideForTest || script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    trackWindowsProcessHelper(query, ownerKey);
    query.stdout?.on('data', chunk => {
      if (terminalError) return;
      stdout += String(chunk || '');
      if (stdout.length > 4 * 1024 * 1024) {
        stdout = '';
        failAfterDrain(new Error('Windows process-tree snapshot exceeded its output limit'));
      }
    });
    query.stderr?.on('data', chunk => { stderr = `${stderr}${String(chunk || '')}`.slice(-2_000); });
    query.once('error', error => {
      if (!query.pid) finish(terminalError || error);
      else failAfterDrain(terminalError || error);
    });
    query.once('close', code => {
      if (terminalError) finish(terminalError);
      else if (code === 0) finish();
      else finish(new Error(`Windows process-tree snapshot exited (${code}): ${stderr || 'no stderr'}`));
    });
    timer = setTimeout(() => {
      failAfterDrain(new Error('Windows process-tree snapshot timed out'));
    }, Math.max(100, timeoutMs));
  });
}

export async function snapshotWindowsProcessTree(
  rootPid: number,
  timeoutMs = WINDOWS_TREE_SNAPSHOT_TIMEOUT_MS,
  anchorPids: readonly number[] = [],
  ownerKey = 'global',
): Promise<WindowsProcessTreeSnapshot> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) throw new Error('Invalid Windows utility process id');
  const raw = (await runWindowsProcessQuery(rootPid, timeoutMs, anchorPids, ownerKey)).replace(/^\uFEFF/, '').trim();
  const rows = raw.split(/\r?\n/)
    .map(line => line.trim().split(','))
    .filter(parts => parts.length === 3)
    .map(parts => ({
      pid: Number(parts[0] || 0),
      parentPid: Number(parts[1] || 0),
      creationIdentity: String(parts[2] || '').trim(),
    }))
    .filter(value => Number.isInteger(value.pid) && value.pid > 0);
  const childrenByParent = new Map<number, typeof rows>();
  for (const row of rows) {
    const children = childrenByParent.get(row.parentPid) || [];
    children.push(row);
    childrenByParent.set(row.parentPid, children);
  }
  const seedPids = [...new Set([rootPid, ...anchorPids.filter(pid => Number.isInteger(pid) && pid > 0)])];
  const rowByPid = new Map(rows.map(row => [row.pid, row]));
  const entries: WindowsProcessTreeEntry[] = seedPids
    .map(pid => rowByPid.get(pid))
    .filter((row): row is typeof rows[number] => !!row)
    .map(row => ({ ...row, depth: 0 }));
  const traversal: Array<{ pid: number; depth: number }> = seedPids.map(pid => ({ pid, depth: 0 }));
  const seen = new Set<number>(seedPids);
  for (let index = 0; index < traversal.length; index++) {
    const parent = traversal[index];
    for (const child of childrenByParent.get(parent.pid) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      traversal.push({ pid: child.pid, depth: parent.depth + 1 });
      entries.push({ ...child, depth: parent.depth + 1 });
    }
  }
  const unidentified = entries.filter(entry => !/^\d+$/.test(entry.creationIdentity));
  if (unidentified.length) {
    throw new Error(`Windows process-tree snapshot could not identify process creation time: ${unidentified.map(entry => entry.pid).join(', ')}`);
  }
  return { rootPid, entries };
}

function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function remainingWindowsTreeBudget(deadline: number, capMs: number, label: string, reserveHelperClose = false): number {
  const remaining = deadline - Date.now() - (reserveHelperClose ? WINDOWS_HELPER_CLOSE_GRACE_MS + 75 : 0);
  if (remaining < 100) throw new Error(`Windows utility process-tree ${label} has no helper close budget before the force-stop deadline`);
  return Math.max(100, Math.min(Math.max(100, capMs), remaining));
}

async function withinWindowsTreeDeadline<T>(operation: Promise<T>, deadline: number, label: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`Windows utility process-tree ${label} exceeded the force-stop deadline`);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Windows utility process-tree ${label} exceeded the force-stop deadline`)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function runWindowsIdentityTermination(entries: WindowsProcessTreeEntry[], timeoutMs: number, ownerKey: string): Promise<void> {
  if (!entries.length) return Promise.resolve();
  if (windowsProcessHelpersShuttingDown) return Promise.reject(new Error('Windows process helper subsystem is shutting down'));
  if (entries.some(entry => !Number.isInteger(entry.pid) || entry.pid <= 0 || !/^\d+$/.test(entry.creationIdentity))) {
    return Promise.reject(new Error('Invalid identity-bound Windows process termination request'));
  }
  const encodedTargets = entries.map(entry => `${entry.pid}:${entry.creationIdentity}`).join(';');
  const script = String.raw`$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class NewmarkIdentityTerminator {
  private const uint PROCESS_TERMINATE = 0x00000001;
  private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
  private const int ERROR_INVALID_PARAMETER = 87;
  [StructLayout(LayoutKind.Sequential)] private struct FILETIME { public uint Low; public uint High; }
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  private sealed class Target {
    public IntPtr Handle;
    public uint Pid;
  }
  public static string KillAll(string encodedTargets) {
    var targets = new List<Target>();
    try {
      foreach (string encoded in encodedTargets.Split(new[]{';'}, StringSplitOptions.RemoveEmptyEntries)) {
        string[] parts = encoded.Split(':');
        uint pid = UInt32.Parse(parts[0], System.Globalization.CultureInfo.InvariantCulture);
        ulong expectedCreation = UInt64.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture);
        IntPtr process = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero) {
          int error = Marshal.GetLastWin32Error();
          if (error == ERROR_INVALID_PARAMETER) continue;
          throw new System.ComponentModel.Win32Exception(error);
        }
        FILETIME creation, exit, kernel, user;
        if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) {
          CloseHandle(process);
          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        ulong actualCreation = ((ulong)creation.High << 32) | creation.Low;
        if (actualCreation != expectedCreation) {
          CloseHandle(process);
          throw new InvalidOperationException("PID creation identity changed; refusing to terminate a reused PID");
        }
        targets.Add(new Target { Handle = process, Pid = pid });
      }
      foreach (Target target in targets) {
        if (!TerminateProcess(target.Handle, 1))
          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
      return "terminated:" + targets.Count.ToString();
    } finally {
      foreach (Target target in targets) CloseHandle(target.Handle);
    }
  }
}
'@
Add-Type -TypeDefinition $source
[NewmarkIdentityTerminator]::KillAll('${encodedTargets}')`;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = '';
    let child: ReturnType<typeof spawn>;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let terminalError: Error | null = null;
    let drainStarted = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const failAfterDrain = (error: Error): void => {
      if (!terminalError) terminalError = error;
      if (drainStarted) return;
      drainStarted = true;
      void terminateWindowsProcessHelperAndWait(child).then(() => finish(terminalError!));
    };
    try {
      child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    trackWindowsProcessHelper(child, ownerKey);
    child.stderr?.on('data', chunk => { stderr = `${stderr}${String(chunk || '')}`.slice(-2_000); });
    child.once('error', error => {
      if (!child.pid) finish(terminalError || error);
      else failAfterDrain(terminalError || error);
    });
    child.once('close', code => {
      if (terminalError) finish(terminalError);
      else if (code === 0) finish();
      else finish(new Error(`Identity-bound Windows process termination exited (${code}): ${stderr || 'no stderr'}`));
    });
    timer = setTimeout(() => {
      failAfterDrain(new Error('Identity-bound Windows process termination timed out'));
    }, Math.max(100, timeoutMs));
  });
}

function assertWindowsCreationOrder(child: WindowsProcessTreeEntry, parent: WindowsProcessTreeEntry): void {
  if (BigInt(child.creationIdentity) < BigInt(parent.creationIdentity)) {
    throw new Error(`Windows process-tree creation order is invalid for child ${child.pid} and parent ${parent.pid}`);
  }
}

function assertInitialWindowsProcessTree(
  snapshot: WindowsProcessTreeSnapshot,
  expectedRootCreationIdentity?: string,
): void {
  const root = snapshot.entries.find(entry => entry.pid === snapshot.rootPid);
  if (!root) throw new Error('Initial Windows process-tree snapshot did not contain the utility root');
  if (!/^\d+$/.test(root.creationIdentity)) throw new Error('Initial Windows utility process creation identity is unavailable');
  if (expectedRootCreationIdentity && root.creationIdentity !== expectedRootCreationIdentity) {
    throw new Error(`Windows utility root creation identity mismatch: expected ${expectedRootCreationIdentity}, received ${root.creationIdentity}`);
  }
  const entries = new Map(snapshot.entries.map(entry => [entry.pid, entry]));
  for (const entry of snapshot.entries) {
    const parent = entries.get(entry.parentPid);
    if (parent) assertWindowsCreationOrder(entry, parent);
  }
}

function mergeWindowsProcessTreeSnapshots(
  first: WindowsProcessTreeSnapshot,
  second: WindowsProcessTreeSnapshot,
): WindowsProcessTreeSnapshot {
  if (first.rootPid !== second.rootPid) throw new Error('Windows process-tree rescan root mismatch');
  const entries = new Map<number, WindowsProcessTreeEntry>(first.entries.map(entry => [entry.pid, entry]));
  const current = new Map<number, WindowsProcessTreeEntry>(second.entries.map(entry => [entry.pid, entry]));
  for (const entry of [...second.entries].sort((left, right) => left.depth - right.depth)) {
    const known = entries.get(entry.pid);
    if (known) {
      if (known.creationIdentity !== entry.creationIdentity) {
        throw new Error(`Windows PID reuse detected for ${entry.pid}; restart was blocked`);
      }
      if (known.parentPid !== entry.parentPid) {
        throw new Error(`Windows parent identity changed for PID ${entry.pid}; restart was blocked`);
      }
      continue;
    }
    const knownParent = entries.get(entry.parentPid);
    const currentParent = current.get(entry.parentPid);
    if (knownParent) assertWindowsCreationOrder(entry, knownParent);
    if (!knownParent || !currentParent || knownParent.creationIdentity !== currentParent.creationIdentity) {
      throw new Error(`Windows descendant ${entry.pid} appeared after parent identity could no longer be proven; restart was blocked`);
    }
    entries.set(entry.pid, entry);
  }
  return { rootPid: first.rootPid, entries: [...entries.values()] };
}

async function terminateIdentityBoundEntries(
  entries: WindowsProcessTreeEntry[],
  options: WindowsUtilityProcessTreeOptions,
  deadline: number,
): Promise<void> {
  if (!entries.length) return;
  if (options.terminatePid) {
    for (const entry of entries) {
      await withinWindowsTreeDeadline(
        Promise.resolve(options.terminatePid(entry.pid, entry.creationIdentity)),
        deadline,
        `identity termination for PID ${entry.pid}`,
      );
    }
    return;
  }
  const timeoutMs = remainingWindowsTreeBudget(
    deadline,
    options.identityKillTimeoutMs ?? WINDOWS_TREE_IDENTITY_KILL_TIMEOUT_MS,
    'identity termination',
    true,
  );
  await withinWindowsTreeDeadline(
    runWindowsIdentityTermination(entries, timeoutMs, options.helperOwnerKey || 'global'),
    deadline,
    'identity termination',
  );
}

export async function terminateCapturedWindowsProcessTree(
  snapshot: WindowsProcessTreeSnapshot,
  options: WindowsUtilityProcessTreeOptions = {},
): Promise<void> {
  assertInitialWindowsProcessTree(snapshot);
  const deadline = Date.now() + Math.min(
    WINDOWS_TREE_FORCE_STOP_DEADLINE_MS,
    Math.max(1, Math.floor(options.forceStopDeadlineMs ?? WINDOWS_TREE_FORCE_STOP_DEADLINE_MS)),
  );
  await terminateIdentityBoundEntries(
    [...snapshot.entries].sort((left, right) => right.depth - left.depth),
    options,
    deadline,
  );
}

async function confirmWindowsProcessTreeQuiescence(
  initial: WindowsProcessTreeSnapshot,
  snapshotter: (
    rootPid: number,
    timeoutMs: number,
    anchorPids?: readonly number[],
    ownerKey?: string,
  ) => Promise<WindowsProcessTreeSnapshot>,
  options: WindowsUtilityProcessTreeOptions,
  deadline: number,
): Promise<void> {
  let known = initial;
  let stableEmpty = 0;
  const maxRescans = Math.max(1, Math.floor(options.maxRescans ?? WINDOWS_TREE_MAX_RESCANS));
  const stableRequired = Math.max(1, Math.min(maxRescans, Math.floor(options.stableEmptyRescans ?? WINDOWS_TREE_STABLE_EMPTY_RESCANS)));
  const rescanDelayMs = Math.max(0, Math.floor(options.rescanDelayMs ?? WINDOWS_TREE_RESCAN_DELAY_MS));
  for (let scan = 0; scan < maxRescans; scan++) {
    if (scan > 0) await withinWindowsTreeDeadline(delay(rescanDelayMs), deadline, 'rescan delay');
    const timeoutMs = remainingWindowsTreeBudget(
      deadline,
      options.rescanTimeoutMs ?? WINDOWS_TREE_RESCAN_TIMEOUT_MS,
      'rescan',
      !options.snapshot,
    );
    let current = await withinWindowsTreeDeadline(
      snapshotter(initial.rootPid, timeoutMs, known.entries.map(entry => entry.pid), options.helperOwnerKey),
      deadline,
      'rescan',
    );
    known = mergeWindowsProcessTreeSnapshots(known, current);
    if (!current.entries.length) {
      stableEmpty += 1;
      if (stableEmpty >= stableRequired) return;
      continue;
    }
    stableEmpty = 0;
    const root = current.entries.find(entry => entry.pid === initial.rootPid);
    if (root) {
      await terminateIdentityBoundEntries([root], options, deadline);
      if (++scan >= maxRescans) break;
      await withinWindowsTreeDeadline(delay(rescanDelayMs), deadline, 'post-root rescan delay');
      const postRootTimeoutMs = remainingWindowsTreeBudget(
        deadline,
        options.rescanTimeoutMs ?? WINDOWS_TREE_RESCAN_TIMEOUT_MS,
        'post-root rescan',
        !options.snapshot,
      );
      current = await withinWindowsTreeDeadline(
        snapshotter(initial.rootPid, postRootTimeoutMs, known.entries.map(entry => entry.pid), options.helperOwnerKey),
        deadline,
        'post-root rescan',
      );
      known = mergeWindowsProcessTreeSnapshots(known, current);
    } else if (current.entries.length) {
      // Give a surviving branch one bounded scheduling turn before the final
      // descendant snapshot so children created during root teardown cannot
      // escape the captured ownership set.
      if (++scan >= maxRescans) break;
      await withinWindowsTreeDeadline(delay(rescanDelayMs), deadline, 'survivor rescan delay');
      const survivorTimeoutMs = remainingWindowsTreeBudget(
        deadline,
        options.rescanTimeoutMs ?? WINDOWS_TREE_RESCAN_TIMEOUT_MS,
        'survivor rescan',
        !options.snapshot,
      );
      current = await withinWindowsTreeDeadline(
        snapshotter(initial.rootPid, survivorTimeoutMs, known.entries.map(entry => entry.pid), options.helperOwnerKey),
        deadline,
        'survivor rescan',
      );
      known = mergeWindowsProcessTreeSnapshots(known, current);
    }
    const ordered = [...current.entries].sort((left, right) => right.depth - left.depth);
    await terminateIdentityBoundEntries(ordered, options, deadline);
  }
  throw new Error(`Windows utility process tree did not reach ${stableRequired} stable empty rescans within ${maxRescans} scans`);
}

export async function terminateWindowsUtilityProcessTree(
  pid: number,
  expectedRootCreationIdentity: string,
  options: WindowsUtilityProcessTreeOptions = {},
): Promise<void> {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) throw new Error('Invalid Windows utility process id');
  if (!/^\d+$/.test(expectedRootCreationIdentity)) throw new Error('Windows utility root creation identity is unavailable');
  const snapshotter = options.snapshot || snapshotWindowsProcessTree;
  // Production never passes a snapshotted PID back to bare taskkill.  An
  // explicit hook exists only for deterministic failure/success-path tests;
  // default cleanup is identity-handle-bound from the first termination.
  const primaryKill = options.primaryKill || null;
  const deadline = Date.now() + Math.min(
    WINDOWS_TREE_FORCE_STOP_DEADLINE_MS,
    Math.max(1, Math.floor(options.forceStopDeadlineMs ?? WINDOWS_TREE_FORCE_STOP_DEADLINE_MS)),
  );
  let snapshot: WindowsProcessTreeSnapshot | null = null;
  let snapshotError: Error | null = null;
  try {
    const timeoutMs = remainingWindowsTreeBudget(
      deadline,
      options.snapshotTimeoutMs ?? WINDOWS_TREE_SNAPSHOT_TIMEOUT_MS,
      'initial snapshot',
      !options.snapshot,
    );
    snapshot = await withinWindowsTreeDeadline(
      snapshotter(pid, timeoutMs, [], options.helperOwnerKey),
      deadline,
      'initial snapshot',
    );
  } catch (error) {
    snapshotError = error instanceof Error ? error : new Error(String(error));
    snapshot = null;
  }
  if (snapshot) assertInitialWindowsProcessTree(snapshot, expectedRootCreationIdentity);
  if (primaryKill) {
    try {
      const timeoutMs = remainingWindowsTreeBudget(
        deadline,
        options.primaryTimeoutMs ?? WINDOWS_TREE_PRIMARY_HOOK_TIMEOUT_MS,
        'primary test hook',
      );
      await withinWindowsTreeDeadline(primaryKill(pid, timeoutMs), deadline, 'primary test hook');
    } catch {}
  }
  if (snapshot) {
    // A hook success report is not proof of quiescence.  Default and injected
    // paths use the same identity-aware bounded rescan gate.
    await confirmWindowsProcessTreeQuiescence(snapshot, snapshotter, options, deadline);
    return;
  }
  // An initial snapshot failure leaves descendant ownership unknown. A
  // test-hook success (including an already-dead root) therefore cannot
  // authorize a replacement generation; best-effort observation may continue,
  // but this call must still reject below.
  try {
    const timeoutMs = remainingWindowsTreeBudget(
      deadline,
      options.rescanTimeoutMs ?? WINDOWS_TREE_RESCAN_TIMEOUT_MS,
      'uncertain-tree rescan',
      !options.snapshot,
    );
    await withinWindowsTreeDeadline(
      snapshotter(pid, timeoutMs, [], options.helperOwnerKey),
      deadline,
      'uncertain-tree rescan',
    );
  } catch {}
  throw new Error(`Windows utility process-tree snapshot failed and restart was blocked: ${snapshotError?.message || 'unknown snapshot error'}`);
}

export type UtilityHostToolHandler = ((request: UtilityHostToolRequest, signal?: AbortSignal) => Promise<unknown>) & {
  cancelTarget?(runtimeKey: string): void;
};

export class ElectronUtilityAgentClient {
  private child: UtilityChild | null = null;
  private pending = new Map<string, {
    generation: number;
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  private listeners = new Set<(event: AgentWorkEvent) => void>();
  private hostToolHandler: UtilityHostToolHandler | null = null;
  private hostToolRuns = new Map<string, { generation: number; controller: AbortController }>();
  private childGeneration = 0;
  private readyGeneration = 0;
  private invalidGenerations = new Set<number>();
  private startPromise: Promise<void> | null = null;
  private forceStopPromise: Promise<void> | null = null;
  private childRootIdentity: { generation: number; pid: number; creationIdentity: string } | null = null;
  private sequence = 0;
  private lastError = '';
  // A failed force-stop means an old descendant may still own target-scoped
  // resources.  This is intentionally sticky for the lifetime of this client:
  // only rebuilding the Electron main-process runtime pool may clear it.
  private restartQuarantine: Error | null = null;

  constructor(
    private readonly root: string,
    private readonly hostScript: string,
    private readonly target: NormalizedConversationTarget,
    private readonly options: ElectronUtilityAgentClientOptions = {},
  ) {}

  subscribe(listener: (event: AgentWorkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setHostToolHandler(handler: UtilityHostToolHandler | null): void {
    this.hostToolHandler = handler;
  }

  status(): { enabled: true; connected: boolean; pid: number; error: string; runtimeKey: string; quarantined: boolean; generation: number; readyGeneration: number; rootCreationIdentity: string } {
    return {
      enabled: true,
      connected: !!this.child?.pid,
      pid: Number(this.child?.pid || 0),
      error: this.lastError,
      runtimeKey: this.target.runtimeKey,
      quarantined: !!this.restartQuarantine,
      generation: this.childGeneration,
      readyGeneration: this.readyGeneration,
      rootCreationIdentity: this.childRootIdentity?.generation === this.childGeneration
        ? this.childRootIdentity.creationIdentity
        : '',
    };
  }

  async start(): Promise<void> {
    this.throwIfRestartQuarantined();
    const starting = this.startPromise;
    if (starting) {
      await starting;
      this.assertReadyGeneration();
      return;
    }
    if (this.child?.pid) {
      this.assertReadyGeneration();
      return;
    }
    const operation = this.startNewChild();
    this.startPromise = operation;
    try {
      await operation;
      this.assertReadyGeneration();
    } finally {
      if (this.startPromise === operation) this.startPromise = null;
    }
  }

  private async startNewChild(): Promise<void> {
    const child = utilityProcess.fork(this.hostScript, [], {
      cwd: this.root,
      env: {
        ...process.env,
        NEWMARK_RUNTIME_ROOT: this.root,
        NEWMARK_RUNTIME_KEY: this.target.runtimeKey,
        NEWMARK_WORKSPACE_ID: this.target.workspaceId,
        NEWMARK_CONVERSATION_ID: this.target.conversationId,
        NEWMARK_ISOLATED_RUNTIME: '1',
      },
      serviceName: `Newmark Agent ${this.target.workspaceId}/${this.target.conversationId}`.slice(0, 120),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    const generation = ++this.childGeneration;
    this.readyGeneration = 0;
    this.lastError = '';
    child.on('message', message => this.handleMessage(child, generation, message));
    child.on('error', (_type, _location, report) => {
      if (this.child === child) this.lastError = String(report || 'Utility runtime fatal error').slice(-2000);
    });
    child.on('exit', code => this.handleExit(child, code));
    child.stderr?.on('data', chunk => {
      if (this.child === child) this.lastError = `${this.lastError}${String(chunk || '')}`.trim().slice(-2000);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Electron utility runtime spawn timed out')), 10_000);
      child.once('spawn', () => { clearTimeout(timer); resolve(); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Electron utility runtime exited during spawn (${code})`)); });
    });
    try {
      await this.options.startupGate?.();
      if (process.platform === 'win32') {
        const identitySnapshot = await snapshotWindowsProcessTree(
          Number(child.pid || 0),
          WINDOWS_TREE_SNAPSHOT_TIMEOUT_MS,
          [],
          this.windowsHelperOwnerKey(generation),
        );
        assertInitialWindowsProcessTree(identitySnapshot);
        const rootIdentity = identitySnapshot.entries.find(entry => entry.pid === child.pid)?.creationIdentity || '';
        if (!rootIdentity || this.child !== child || this.childGeneration !== generation) {
          throw new Error('Electron utility runtime root identity capture became stale');
        }
        this.childRootIdentity = { generation, pid: Number(child.pid || 0), creationIdentity: rootIdentity };
      }
      const ping = await this.request('ping', undefined, 10_000, generation) as { runtimeKey?: string };
      if (String(ping.runtimeKey || '') !== this.target.runtimeKey) throw new Error('Electron utility runtime ping target mismatch');
      if (this.child !== child || this.childGeneration !== generation || this.invalidGenerations.has(generation)) {
        throw new Error('Electron utility runtime startup readiness became stale');
      }
      this.readyGeneration = generation;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.enterRestartQuarantine(failure);
      const exited = await this.killChildHandleAndAwaitExit(child, 1_000);
      if (exited && this.child === child) this.detachChild(child, failure);
      throw failure;
    }
  }

  async prompt(params: UtilityPromptRequest): Promise<UtilityAgentPromptResult> {
    await this.start();
    return await this.request('prompt', { ...params, target: this.checkedTarget(params.target) }, 0) as UtilityAgentPromptResult;
  }

  async snapshot(): Promise<UtilityAgentSnapshotResult> {
    await this.start();
    return await this.requestTargetSnapshot();
  }

  async requestStop(runId?: string): Promise<UtilityAgentStopResult> {
    if (!this.child) {
      return { action: 'not_running', runtimeKey: this.target.runtimeKey, checkpointed: false, backend: 'utility', pid: 0 };
    }
    return await this.request('stop', { target: this.target, runId }, 5_000) as UtilityAgentStopResult;
  }

  async enqueueGuide(envelope: ConversationInputEnvelope): Promise<GuideReceipt> {
    await this.start();
    return await this.request('guide', { target: this.target, envelope }, 5_000) as GuideReceipt;
  }

  async checkpoint(): Promise<Record<string, unknown>> {
    await this.start();
    return await this.request('checkpoint', { target: this.target }, 5_000) as Record<string, unknown>;
  }

  async setWorkRunExpanded(runId: string, expanded: boolean): Promise<boolean> {
    await this.start();
    return !!await this.request('set_work_run_expanded', { target: this.target, runId, expanded }, 5_000);
  }

  async updateSetting(section: string, key: string, value: unknown): Promise<void> {
    if (!this.child?.pid) return;
    await this.request('update_setting', { section, key, value }, 5_000);
  }

  async stop(): Promise<void> {
    if (this.forceStopPromise) return await this.forceStopPromise;
    const child = this.child;
    if (!child) return;
    if (!this.restartQuarantine && this.readyGeneration === this.childGeneration) {
      try { await this.request('shutdown', undefined, 2_000); } catch {}
    }
    if (this.child === child) {
      const failure = new Error('Electron utility runtime stop could not confirm child exit');
      const exited = await this.killChildHandleAndAwaitExit(child, 1_000);
      if (exited && this.child === child) this.detachChild(child, new Error('Electron utility runtime stopped'));
      else if (!exited) {
        this.enterRestartQuarantine(failure);
        // Retain the UtilityProcess object and surface the failure.  The pool
        // must not evict the only identity-safe handle to a still-live child.
        throw failure;
      }
    }
  }

  async forceStop(): Promise<void> {
    const active = this.forceStopPromise;
    if (active) return await active;
    const operation = this.forceStopTransaction();
    this.forceStopPromise = operation;
    try {
      await operation;
    } finally {
      if (this.forceStopPromise === operation) this.forceStopPromise = null;
    }
  }

  private async forceStopTransaction(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const pid = Number(child.pid || 0);
    const generation = this.childGeneration;
    this.invalidateGeneration(generation, new Error('Electron conversation runtime force-restarted'));
    try {
      if (process.platform === 'win32') {
        // A previous timed-out helper remains handle-tracked.  Cleanup-only
        // retries must drain it before starting another tree transaction.
        const helperOwnerKey = this.windowsHelperOwnerKey(generation);
        await drainWindowsProcessHelpers(2_000, helperOwnerKey);
        const rootIdentity = this.childRootIdentity;
        if (!rootIdentity
          || rootIdentity.generation !== generation
          || rootIdentity.pid !== pid
          || !rootIdentity.creationIdentity) {
          throw new Error('Electron utility runtime expected root creation identity is unavailable');
        }
        await terminateWindowsUtilityProcessTree(
          pid,
          rootIdentity.creationIdentity,
          { ...this.options.windowsProcessTree, helperOwnerKey },
        );
      } else {
        try { child.kill(); } catch {}
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.enterRestartQuarantine(failure);
      // The UtilityProcess object retains the original OS process handle, so
      // killing through it is identity-safe even when PID-tree discovery is
      // uncertain. Descendants remain unknown, hence quarantine is still
      // permanent and replacement remains forbidden.
      const exited = await this.killChildHandleAndAwaitExit(child, 1_000);
      if (exited && this.child === child) this.detachChild(child, failure);
      throw failure;
    }
    this.detachChild(child, new Error('Electron conversation runtime was force-restarted'));
  }

  async forceRestart(): Promise<void> {
    this.throwIfRestartQuarantined();
    await this.forceStop();
    try {
      await this.start();
      // A replacement is not committed merely because ping succeeded.  The
      // target-bound snapshot is part of the restart transaction and must be
      // valid before callers may send any more work.
      await this.requestTargetSnapshot();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.enterRestartQuarantine(failure);
      try { await this.forceStop(); } catch {}
      throw failure;
    }
  }

  private async killChildHandleAndAwaitExit(child: UtilityChild, timeoutMs: number): Promise<boolean> {
    if (this.child !== child) return true;
    let requested = false;
    const exited = new Promise<boolean>(resolve => child.once('exit', () => resolve(true)));
    try {
      requested = this.options.killChild
        ? this.options.killChild(() => child.kill())
        : child.kill();
    } catch {
      requested = false;
    }
    if (!requested) return this.child !== child;
    const confirmed = await Promise.race([
      exited,
      delay(Math.max(1, timeoutMs)).then(() => false),
    ]);
    return confirmed || this.child !== child;
  }

  private async requestTargetSnapshot(): Promise<UtilityAgentSnapshotResult> {
    const snapshot = await this.request('snapshot', { target: this.target }, 15_000) as UtilityAgentSnapshotResult;
    if (snapshot?.target?.runtimeKey !== this.target.runtimeKey) {
      throw new Error('Electron utility runtime snapshot target mismatch');
    }
    return snapshot;
  }

  private enterRestartQuarantine(error: Error): void {
    if (!this.restartQuarantine) this.restartQuarantine = error;
    this.invalidateGeneration(this.childGeneration, new Error(
      `Electron utility restart quarantined until the app backend is restarted: ${this.restartQuarantine.message}`,
    ));
    this.lastError = `Electron utility restart quarantined: ${this.restartQuarantine.message}`.slice(-2_000);
  }

  private throwIfRestartQuarantined(): void {
    if (!this.restartQuarantine) return;
    throw new Error(`Electron utility restart quarantined until the app backend is restarted: ${this.restartQuarantine.message}`);
  }

  private checkedTarget(target: ConversationRuntimeTarget): NormalizedConversationTarget {
    const normalized = normalizeConversationTarget(target);
    if (normalized.runtimeKey !== this.target.runtimeKey) throw new Error('Electron utility client target mismatch');
    return normalized;
  }

  private windowsHelperOwnerKey(generation: number): string {
    return `${this.target.runtimeKey}::generation:${generation}`;
  }

  private assertReadyGeneration(): void {
    const generation = this.childGeneration;
    if (!this.child?.pid
      || this.readyGeneration !== generation
      || this.invalidGenerations.has(generation)) {
      throw new Error('Electron utility runtime is not ready');
    }
  }

  private request(
    method: UtilityAgentRequest['method'],
    params?: unknown,
    timeoutMs = 30_000,
    startupGeneration?: number,
  ): Promise<unknown> {
    if (this.restartQuarantine) {
      return Promise.reject(new Error(`Electron utility restart quarantined until the app backend is restarted: ${this.restartQuarantine.message}`));
    }
    const child = this.child;
    if (!child?.pid) return Promise.reject(new Error('Electron utility runtime is not running'));
    const generation = this.childGeneration;
    if (startupGeneration === undefined) {
      if (this.readyGeneration !== generation || this.invalidGenerations.has(generation)) {
        return Promise.reject(new Error('Electron utility runtime generation is not ready'));
      }
    } else if (startupGeneration !== generation || this.invalidGenerations.has(generation) || method !== 'ping') {
      return Promise.reject(new Error('Electron utility runtime startup generation is invalid'));
    }
    const id = `utility-${process.pid}-${Date.now()}-${++this.sequence}`;
    const payload = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => { this.pending.delete(id); reject(new Error(`Electron utility request timed out: ${method}`)); }, timeoutMs)
        : null;
      this.pending.set(id, { generation, resolve, reject, timer });
      try {
        child.postMessage(payload);
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(child: UtilityChild, generation: number, message: unknown): void {
    if (this.child !== child
      || this.childGeneration !== generation
      || this.invalidGenerations.has(generation)
      || this.restartQuarantine
      || !message
      || typeof message !== 'object') return;
    const envelope = message as Record<string, unknown>;
    const ready = this.readyGeneration === generation;
    if (envelope.event === 'work' && envelope.data) {
      if (!ready) return;
      for (const listener of this.listeners) listener(envelope.data as AgentWorkEvent);
      return;
    }
    if (envelope.event === 'host_tool_request' && envelope.data) {
      if (!ready) return;
      void this.handleHostToolRequest(child, generation, envelope.data as UtilityHostToolRequest);
      return;
    }
    if (envelope.event === 'host_tool_cancel' && envelope.data) {
      if (!ready) return;
      const requestId = String((envelope.data as Record<string, unknown>).requestId || '');
      const run = this.hostToolRuns.get(requestId);
      if (run?.generation === generation) {
        run.controller.abort(new Error('Electron utility host tool cancelled by Agent run'));
        this.hostToolRuns.delete(requestId);
        this.hostToolHandler?.cancelTarget?.(this.target.runtimeKey);
      }
      return;
    }
    const response = message as UtilityAgentResponse;
    const pending = response.id ? this.pending.get(response.id) : undefined;
    if (!pending || pending.generation !== generation) return;
    this.pending.delete(response.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error));
  }

  private async handleHostToolRequest(child: UtilityChild, generation: number, request: UtilityHostToolRequest): Promise<void> {
    if (this.restartQuarantine
      || this.invalidGenerations.has(generation)
      || this.readyGeneration !== generation
      || this.child !== child) return;
    let result: UtilityHostToolResult;
    const controller = new AbortController();
    this.hostToolRuns.set(request.requestId, { generation, controller });
    const allowed = new Set<UtilityHostToolRequest['tool']>(['browser_control', 'browser_use', 'computer_use', 'automation', 'terminal_takeover']);
    if (!allowed.has(request.tool)) {
      result = { requestId: request.requestId, ok: false, error: `Electron host tool is not allowed: ${String(request.tool)}` };
    } else if (request.target.runtimeKey !== this.target.runtimeKey) {
      result = { requestId: request.requestId, ok: false, error: 'Electron host tool target mismatch' };
    } else if (!this.hostToolHandler) {
      result = { requestId: request.requestId, ok: false, error: 'Electron host tool handler is unavailable' };
    } else {
      try {
        result = { requestId: request.requestId, ok: true, result: await this.hostToolHandler(request, controller.signal) as UtilityHostToolResult['result'] };
      } catch (error) {
        result = { requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    this.hostToolRuns.delete(request.requestId);
    if (controller.signal.aborted
      || this.restartQuarantine
      || this.invalidGenerations.has(generation)
      || this.readyGeneration !== generation
      || this.child !== child
      || this.childGeneration !== generation
      || !child.pid) return;
    try {
      child.postMessage({
        id: `utility-host-result-${process.pid}-${Date.now()}-${++this.sequence}`,
        method: 'host_tool_result',
        params: result,
      });
    } catch {}
  }

  private handleExit(child: UtilityChild, code: number): void {
    if (this.child !== child) return;
    const error = new Error(`Electron utility runtime exited (${code}): ${this.lastError || 'no stderr'}`);
    this.detachChild(child, error);
  }

  private detachChild(child: UtilityChild, error: Error): void {
    if (this.child !== child) return;
    const generation = this.childGeneration;
    this.invalidateGeneration(generation, error);
    this.child = null;
    this.childRootIdentity = null;
    this.readyGeneration = 0;
  }

  private invalidateGeneration(generation: number, error: Error): void {
    if (generation <= 0) return;
    this.invalidGenerations.add(generation);
    if (this.readyGeneration === generation) this.readyGeneration = 0;
    for (const [requestId, run] of this.hostToolRuns) {
      if (run.generation !== generation) continue;
      run.controller.abort(error);
      this.hostToolRuns.delete(requestId);
    }
    this.hostToolHandler?.cancelTarget?.(this.target.runtimeKey);
    for (const [requestId, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }
}
