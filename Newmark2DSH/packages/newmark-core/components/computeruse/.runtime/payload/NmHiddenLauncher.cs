using System;
using System.Runtime.InteropServices;

/**
 * The process launcher, and nothing else.
 *
 * It creates no desktop and holds no desktop handle: the two halves of a desktop launch are
 * two types because that is the arrangement a previous phase measured to work.
 *
 * Configuration is passed on the COMMAND LINE and never through the environment. The same
 * call, the same lpDesktop and the same command line were measured to give a child that dies
 * before its first instruction (0xC0000142 native, 0x8007008A managed) when the configuration
 * travelled as an environment variable written with SetEnvironmentVariableW and the child was
 * given a null environment block with CREATE_UNICODE_ENVIRONMENT. The block is therefore
 * inherited - never built here - and paths with spaces are quoted on the command line.
 */
public static class NmHiddenLauncher
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

  public static int Launch(string desktopName, string commandLine, out int error)
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
      /* The environment block is IntPtr.Zero, which means INHERIT. It is never built and no
         variable is ever set for the child: that path was measured to kill the child before
         its first instruction. CREATE_UNICODE_ENVIRONMENT is harmless with an inherited
         block and is kept so this is the same call that was measured to work. */
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
