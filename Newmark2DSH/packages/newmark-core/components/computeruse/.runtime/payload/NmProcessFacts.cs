using System;
using System.Runtime.InteropServices;
using System.Text;

/**
 * Process identity, by pid AND start time.
 *
 * A pid on its own is not an identity: Windows reuses it, and a ledger that stores a bare pid
 * will one day terminate a process that merely inherited the number. Every read here answers
 * with the creation time as well, and the terminate refuses when it does not match.
 */
public static class NmProcessFacts
{
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  public static void WatchOwner(int pid) {
    IntPtr owner = OpenProcess(0x100000, false, pid);
    if(owner == IntPtr.Zero) Environment.Exit(0);
    var watcher = new System.Threading.Thread(new System.Threading.ThreadStart(delegate {
      try { WaitForSingleObject(owner, 0xffffffff); Environment.Exit(0); }
      finally { CloseHandle(owner); }
    }));
    watcher.IsBackground = true; watcher.Start();
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct FILETIME { public uint Low; public uint High; }

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetProcessTimes(IntPtr handle, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateProcess(IntPtr handle, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool QueryFullProcessImageNameW(IntPtr handle, uint flags, StringBuilder name, ref int size);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);

  public const uint PROCESS_TERMINATE = 0x0001;
  public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  public const uint STILL_ACTIVE = 259;

  /**
   * Is this pid a process that is still RUNNING?
   *
   * This is not the same question as "does OpenProcess succeed", and the difference is the whole
   * reason this method exists. Measured on this machine: after TerminateProcess returns success, the
   * pid keeps answering OpenProcess and GetProcessTimes for SECONDS - a terminated process stays in
   * the pid table until the kernel reaps it - so a liveness test built on OpenProcess reports a
   * corpse as alive, and a measurement built on that test reports its own successful kill as a
   * failure. A process is alive when its exit code is STILL_ACTIVE and not before.
   */
  public static bool Running(int pid)
  {
    IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) return false;
    try
    {
      uint exitCode;
      if (!GetExitCodeProcess(handle, out exitCode)) return false;
      return exitCode == STILL_ACTIVE;
    }
    finally { CloseHandle(handle); }
  }

  public static long StartTimeTicks(int pid)
  {
    IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) return 0;
    try
    {
      FILETIME creation; FILETIME exit; FILETIME kernel; FILETIME user;
      if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) return 0;
      return ((long)creation.High << 32) | (long)creation.Low;
    }
    finally { CloseHandle(handle); }
  }

  public static string StartTimeUtc(int pid)
  {
    long ticks = StartTimeTicks(pid);
    if (ticks <= 0) return "";
    try { return DateTime.FromFileTimeUtc(ticks).ToString("o"); }
    catch (Exception) { return ""; }
  }

  public static bool Alive(int pid, long expectedTicks)
  {
    if (!Running(pid)) return false;
    long ticks = StartTimeTicks(pid);
    if (ticks <= 0) return false;
    if (expectedTicks <= 0) return true;
    return ticks == expectedTicks;
  }

  public static string ImagePath(int pid)
  {
    IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) return "";
    try
    {
      StringBuilder buffer = new StringBuilder(1024);
      int size = buffer.Capacity;
      if (!QueryFullProcessImageNameW(handle, 0, buffer, ref size)) return "";
      return buffer.ToString();
    }
    finally { CloseHandle(handle); }
  }

  /**
   * Terminate ONLY the process whose creation time matches.
   *
   * Returns 1 when it terminated, 0 when the process was already gone, -1 when the pid is
   * alive but is a DIFFERENT process (reuse), and -2 when the handle or the call failed. A
   * caller can therefore tell "already gone" from "not mine" without guessing.
   */
  public static int TerminateIfStartTime(int pid, long expectedTicks, out int error)
  {
    error = 0;
    /* Already gone is reported as ALREADY GONE and not as a failure. A terminated process keeps
       answering OpenProcess for seconds, so without this check a reaper that ran twice would report
       the second run as a run of failures (-2, "TerminateProcess refused") when in fact there was
       nothing left to do. */
    if (!Running(pid)) return 0;
    IntPtr handle = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) { error = Marshal.GetLastWin32Error(); return 0; }
    try
    {
      FILETIME creation; FILETIME exit; FILETIME kernel; FILETIME user;
      if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) { error = Marshal.GetLastWin32Error(); return -2; }
      long observed = ((long)creation.High << 32) | (long)creation.Low;
      if (expectedTicks > 0 && observed != expectedTicks) { error = 0; return -1; }
      if (!TerminateProcess(handle, 1)) { error = Marshal.GetLastWin32Error(); return -2; }
      return 1;
    }
    finally { CloseHandle(handle); }
  }
}
