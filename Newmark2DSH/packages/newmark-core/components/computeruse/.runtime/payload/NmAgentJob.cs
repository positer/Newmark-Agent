using System;
using System.Runtime.InteropServices;

/**
 * Ownership, as a kernel object.
 *
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is the whole mechanism: when the last handle to this job
 * closes, the kernel terminates every member. It fires on TerminateProcess, on an access
 * violation, on a machine that is being reset, and on the parent exiting normally - none of
 * which a finally block survives. Holding the handle IS ownership.
 *
 * The agent assigns ITSELF before it launches anything, so every child arrives in the job by
 * inheritance and a tree is covered without the launcher having to name each process. That is
 * the difference between holding an app and holding the browser process an app happens to
 * return while the renderers run outside it.
 */
public static class NmAgentJob
{
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
  {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity;
    public uint PriorityClass; public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS
  {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
  {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, out uint returned);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateJobObject(IntPtr job, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr GetCurrentProcess();

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  public const int JobObjectExtendedLimitInformation = 9;
  public const int JobObjectBasicProcessIdList = 3;
  public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  public const uint PROCESS_SET_QUOTA = 0x0100;
  public const uint PROCESS_TERMINATE = 0x0001;

  public static IntPtr CreateKillOnClose(out int error)
  {
    error = 0;
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) { error = Marshal.GetLastWin32Error(); return IntPtr.Zero; }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    IntPtr buffer = Marshal.AllocHGlobal(size);
    bool applied = false;
    try
    {
      Marshal.StructureToPtr(limits, buffer, false);
      applied = SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size);
      error = Marshal.GetLastWin32Error();
    }
    finally { Marshal.FreeHGlobal(buffer); }
    if (!applied) { CloseHandle(job); return IntPtr.Zero; }
    return job;
  }

  public static bool AssignSelf(IntPtr job, out int error)
  {
    bool assigned = AssignProcessToJobObject(job, GetCurrentProcess());
    error = Marshal.GetLastWin32Error();
    return assigned;
  }

  public static bool SelfInJob(IntPtr job)
  {
    bool result = false;
    IsProcessInJob(GetCurrentProcess(), job, out result);
    return result;
  }

  public static bool PidInJob(int pid, IntPtr job)
  {
    IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) return false;
    try
    {
      bool result = false;
      IsProcessInJob(handle, job, out result);
      return result;
    }
    finally { CloseHandle(handle); }
  }

  public static uint LimitFlags(IntPtr job, out int error)
  {
    error = 0;
    int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try
    {
      uint returned;
      if (!QueryInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size, out returned))
      {
        error = Marshal.GetLastWin32Error();
        return 0;
      }
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = (JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(buffer, typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      return limits.BasicLimitInformation.LimitFlags;
    }
    finally { Marshal.FreeHGlobal(buffer); }
  }

  /**
   * Every pid in the job, and how many the kernel says are assigned.
   *
   * Both numbers are returned because they can disagree: when the buffer is too small the
   * kernel reports more assigned processes than it listed, and a caller that only read the
   * list would believe a partial answer was the whole tree.
   */
  public static int[] MemberPids(IntPtr job, out int error, out int assigned)
  {
    error = 0;
    assigned = 0;
    int capacity = 65536;
    IntPtr buffer = Marshal.AllocHGlobal(capacity);
    try
    {
      uint returned;
      bool answered = QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, (uint)capacity, out returned);
      /* ERROR_MORE_DATA (234) means the buffer was too small: the call reports failure but the
         two counts are filled in, so they are read anyway and the disagreement between them is
         what tells the caller the list is partial. */
      if (!answered)
      {
        error = Marshal.GetLastWin32Error();
        if (error != 234) return new int[0];
      }
      assigned = Marshal.ReadInt32(buffer, 0);
      int listed = Marshal.ReadInt32(buffer, 4);
      int room = (capacity - 8) / IntPtr.Size;
      if (listed > room) listed = room;
      int[] pids = new int[listed];
      for (int i = 0; i < listed; i++) pids[i] = Marshal.ReadInt32(buffer, 8 + (i * IntPtr.Size));
      return pids;
    }
    finally { Marshal.FreeHGlobal(buffer); }
  }

  public static bool Terminate(IntPtr job, out int error)
  {
    bool terminated = TerminateJobObject(job, 1);
    error = Marshal.GetLastWin32Error();
    return terminated;
  }

  /**
   * Membership as a THREE-VALUED answer, because "false" alone cannot be told from a failure.
   *
   * The shipped read was PidInJob, which answers "false" both when the process is genuinely
   * not a member AND when OpenProcess refused the handle - so a read that never happened was
   * reported as the fact "this process is not in the job". Measured on this station: a launched
   * application was reported in_job false while the agent that launched it reported
   * job_in_job true, and nothing in the receipt said which of the two readings it was.
   *
   *   1 the process is a member of this job
   *   0 the handle opened and the process is NOT a member
   *  -1 the handle could not be opened, and the error code says why
   */
  public static int PidMembership(IntPtr job, int pid, out int error)
  {
    error = 0;
    IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) { error = Marshal.GetLastWin32Error(); return -1; }
    try
    {
      bool result = false;
      if (!IsProcessInJob(handle, job, out result)) { error = Marshal.GetLastWin32Error(); return -1; }
      return result ? 1 : 0;
    }
    finally { CloseHandle(handle); }
  }

  /**
   * Put a pid in this job AFTER it was created, and answer what happened.
   *
   * Inheritance is the mechanism that is supposed to make this unnecessary, and it is not
   * sufficient: a launch that hands its work to a process this agent did not create - which is
   * what happens when the target is a packaged application - arrives OUTSIDE the job, and a
   * process outside the job is not killed by KILL_ON_JOB_CLOSE. Holding it is therefore done in
   * two steps and the second one is measured, never assumed.
   *
   * AssignProcessToJobObject needs PROCESS_SET_QUOTA and PROCESS_TERMINATE, which is why this
   * opens its own handle rather than reusing a query-only one. A refusal (typically
   * ERROR_ACCESS_DENIED, 5, when the process already belongs to a job this one cannot nest
   * with) is returned as a failure with its error code, and the caller reports the launch as
   * NOT held rather than silently absent.
   */
  public static bool AssignPid(IntPtr job, int pid, out int error)
  {
    error = 0;
    IntPtr handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) { error = Marshal.GetLastWin32Error(); return false; }
    try
    {
      bool assigned = AssignProcessToJobObject(job, handle);
      error = Marshal.GetLastWin32Error();
      return assigned;
    }
    finally { CloseHandle(handle); }
  }

  public static bool Release(IntPtr job)
  {
    return CloseHandle(job);
  }
}
