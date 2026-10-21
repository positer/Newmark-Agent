using System;
using System.Runtime.InteropServices;

/**
 * Start a process onto a named desktop, from a process that is already on it.
 *
 * The desktop name is passed explicitly rather than left to inheritance. A null lpDesktop
 * does mean "the parent desktop" for a console child, but the whole point of this module is
 * that the landing desktop is a measured fact rather than an assumption, so the name travels
 * on this call and the agent reports what it asked for and what it got.
 */
public static class NmAgentProcess
{
  [StructLayout(LayoutKind.Sequential)]
  public struct STARTUPINFO
  {
    public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars;
    public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
    public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION
  {
    public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateProcessW(IntPtr application, IntPtr commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, IntPtr currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

  public static int LaunchOn(string desktopName, string commandLine, out int error)
  {
    STARTUPINFO info = new STARTUPINFO();
    info.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    IntPtr desktopPointer = Marshal.StringToHGlobalUni(desktopName);
    IntPtr commandPointer = Marshal.StringToHGlobalUni(commandLine);
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    bool started = false;
    try
    {
      info.lpDesktop = desktopPointer;
      /* The environment block stays IntPtr.Zero: the child inherits the agent own block and
         no variable is ever set for it. Building a block and passing it with
         CREATE_UNICODE_ENVIRONMENT was measured in an earlier phase to kill the child before
         its first instruction, so configuration travels on the command line instead. */
      started = CreateProcessW(IntPtr.Zero, commandPointer, IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, IntPtr.Zero, ref info, out process) != IntPtr.Zero;
      error = Marshal.GetLastWin32Error();
    }
    finally
    {
      Marshal.FreeHGlobal(desktopPointer);
      Marshal.FreeHGlobal(commandPointer);
    }
    if (!started) return 0;
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return process.dwProcessId;
  }
}
