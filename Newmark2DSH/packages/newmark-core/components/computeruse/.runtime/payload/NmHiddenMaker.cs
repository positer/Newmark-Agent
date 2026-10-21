using System;
using System.Runtime.InteropServices;
using System.Text;

/**
 * The desktop maker, and nothing else.
 *
 * This type is compiled by its own Add-Type call into its own assembly, and it does not
 * declare CreateProcessW. A previous phase measured that the maker and the launcher compiled
 * into ONE type give a child that dies before its first instruction, while the identical
 * calls in TWO types run. The two halves of a desktop launch therefore stay in two types.
 *
 * The name and device parameters are raw pointers rather than strings. PowerShell converts
 * both a null and an empty string at a string parameter into an empty BSTR rather than a
 * NULL pointer, so a string device parameter that the caller leaves null makes CreateDesktopW
 * answer ERROR_INVALID_PARAMETER (87): it creates nothing, it throws nothing, and every later
 * step quietly runs against the caller's own desktop. Marshalling the pointer here removes
 * the possibility instead of documenting it.
 */
public static class NmHiddenMaker
{
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateDesktopW(IntPtr name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);

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
  public const uint GENERIC_ALL = 0x10000000;
  public const uint DESKTOP_ALL_ACCESS = 0x000F01FF;

  public static string KernelName(IntPtr handle)
  {
    StringBuilder buffer = new StringBuilder(512);
    int needed;
    if (GetUserObjectInformationW(handle, UOI_NAME, buffer, buffer.Capacity * 2, out needed) == 0) return "";
    return buffer.ToString();
  }

  public static string DesktopName()
  {
    return KernelName(GetThreadDesktop(GetCurrentThreadId()));
  }

  public static string WindowStationName()
  {
    return KernelName(GetProcessWindowStation());
  }

  public static IntPtr CreateByName(string name, out int error)
  {
    IntPtr namePointer = Marshal.StringToHGlobalUni(name);
    IntPtr desktop = CreateDesktopW(namePointer, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
    /* The error is only meaningful when the call FAILED. Reading Marshal.GetLastWin32Error after a
       SUCCESSFUL call reports whatever the previous failing call left behind - this reported 203 on
       every healthy open, which reads exactly like a fault and is not one. */
    if (desktop == IntPtr.Zero) error = Marshal.GetLastWin32Error(); else error = 0;
    Marshal.FreeHGlobal(namePointer);
    return desktop;
  }

  public static IntPtr OpenByName(string name, out int error)
  {
    IntPtr desktop = OpenDesktopW(name, 0, false, DESKTOP_ALL_ACCESS);
    if (desktop == IntPtr.Zero) error = Marshal.GetLastWin32Error(); else error = 0;
    return desktop;
  }
}
