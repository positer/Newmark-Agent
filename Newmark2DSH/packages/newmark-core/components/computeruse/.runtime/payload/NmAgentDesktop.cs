using System;
using System.Runtime.InteropServices;
using System.Text;

/**
 * The agent own desktop handle, held for the agent whole life.
 *
 * The agent is STARTED onto the desktop, so it does not need this handle to see that desktop:
 * it needs the handle to KEEP the desktop alive. A desktop dies when its last handle closes,
 * silently and completely - so a holder is not a convenience, it is the thing that decides
 * whether the desktop exists at all. When this process is killed the handle closes with it and
 * the desktop goes with the handle, which is the lifetime this module wants.
 */
public static class NmAgentDesktop
{
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr OpenDesktopW(string name, int flags, bool inherit, uint access);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool CloseDesktop(IntPtr desktop);

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern int GetUserObjectInformationW(IntPtr handle, int index, StringBuilder info, int length, out int needed);

  [DllImport("user32.dll")]
  public static extern IntPtr GetThreadDesktop(uint threadId);

  [DllImport("user32.dll")]
  public static extern IntPtr GetProcessWindowStation();

  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentThreadId();

  public const int UOI_NAME = 2;
  public const uint DESKTOP_ALL_ACCESS = 0x000F01FF;

  public static string KernelName(IntPtr handle)
  {
    StringBuilder buffer = new StringBuilder(512);
    int needed;
    if (GetUserObjectInformationW(handle, UOI_NAME, buffer, buffer.Capacity * 2, out needed) == 0) return "";
    return buffer.ToString();
  }

  public static string ThreadDesktopName()
  {
    return KernelName(GetThreadDesktop(GetCurrentThreadId()));
  }

  public static string WindowStationName()
  {
    return KernelName(GetProcessWindowStation());
  }

  public static string HoldName(IntPtr hold)
  {
    return KernelName(hold);
  }

  public static IntPtr OpenByName(string name, out int error)
  {
    IntPtr desktop = OpenDesktopW(name, 0, false, DESKTOP_ALL_ACCESS);
    /* Only meaningful when the call FAILED: after a successful open this reported whatever the
       previous failing call left behind (203, every time), which reads like a fault and is not one. */
    if (desktop == IntPtr.Zero) error = Marshal.GetLastWin32Error(); else error = 0;
    return desktop;
  }

  public static bool Close(IntPtr hold)
  {
    return CloseDesktop(hold);
  }
}
