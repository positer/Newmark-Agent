using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

/**
 * Windows on the calling thread desktop, and the four acts the agent performs on them.
 *
 * EnumWindows enumerates the top-level windows of the desktop the CALLING THREAD is attached
 * to, which is exactly the reach this module is built on: no desktop handle is passed in,
 * because the process is already on the desktop it is listing.
 *
 * Input is posted, not injected. A hidden desktop can never be the input desktop, so SendInput
 * has nothing to aim at there; PostMessage puts the message in the target window queue and the
 * window own message loop dispatches it. That is the mechanism that makes a hidden desktop
 * drivable at all, and it is why the same code drives the same application on the interactive
 * desktop without moving the real pointer.
 */
public static class NmAgentWindow
{
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAPINFOHEADER
  {
    public uint biSize; public int biWidth; public int biHeight;
    public ushort biPlanes; public ushort biBitCount; public uint biCompression;
    public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
    public uint biClrUsed; public uint biClrImportant;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAPINFO
  {
    public BITMAPINFOHEADER bmiHeader; public uint bmiColors0;
  }

  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr lParam);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")]
  public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW")]
  public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int maxCount);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool PostMessageW(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SendMessageW(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern IntPtr GetWindowDC(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);

  [DllImport("gdi32.dll")]
  public static extern IntPtr CreateCompatibleDC(IntPtr hdc);

  [DllImport("gdi32.dll")]
  public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int width, int height);

  [DllImport("gdi32.dll")]
  public static extern IntPtr SelectObject(IntPtr hdc, IntPtr handle);

  [DllImport("gdi32.dll")]
  public static extern bool DeleteObject(IntPtr handle);

  [DllImport("gdi32.dll")]
  public static extern bool DeleteDC(IntPtr hdc);

  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

  [DllImport("gdi32.dll")]
  public static extern bool BitBlt(IntPtr destination, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint rop);

  [DllImport("gdi32.dll")]
  public static extern int GetDIBits(IntPtr hdc, IntPtr bitmap, uint start, uint lines, byte[] bits, ref BITMAPINFO info, uint usage);

  public const uint WM_MOUSEMOVE = 0x0200;
  public const uint WM_LBUTTONDOWN = 0x0201;
  public const uint WM_LBUTTONUP = 0x0202;
  public const uint WM_KEYDOWN = 0x0100;
  public const uint WM_KEYUP = 0x0101;
  public const uint WM_CHAR = 0x0102;
  public const uint WM_MOUSEWHEEL = 0x020A;
  public const uint SRCCOPY = 0x00CC0020;

  public sealed class WindowFact
  {
    public long Handle { get; set; }
    public string Title { get; set; }
    public string ClassName { get; set; }
    public int ProcessId { get; set; }
    public int ThreadId { get; set; }
    public int Left { get; set; }
    public int Top { get; set; }
    public int Right { get; set; }
    public int Bottom { get; set; }
    public int ClientWidth { get; set; }
    public int ClientHeight { get; set; }
    public bool Visible { get; set; }
    public bool Minimized { get; set; }
  }

  public static WindowFact One(IntPtr hWnd)
  {
    RECT rect;
    RECT client;
    if (!GetWindowRect(hWnd, out rect)) return null;
    if (!GetClientRect(hWnd, out client)) { client.Left = 0; client.Top = 0; client.Right = 0; client.Bottom = 0; }
    WindowFact fact = new WindowFact();
    fact.Handle = hWnd.ToInt64();
    StringBuilder className = new StringBuilder(512);
    GetClassNameW(hWnd, className, className.Capacity);
    fact.ClassName = className.ToString();
    StringBuilder title = new StringBuilder(2048);
    GetWindowTextW(hWnd, title, title.Capacity);
    fact.Title = title.ToString();
    uint processId;
    uint threadId = GetWindowThreadProcessId(hWnd, out processId);
    fact.ProcessId = (int)processId;
    fact.ThreadId = (int)threadId;
    fact.Left = rect.Left; fact.Top = rect.Top; fact.Right = rect.Right; fact.Bottom = rect.Bottom;
    fact.ClientWidth = client.Right - client.Left;
    fact.ClientHeight = client.Bottom - client.Top;
    fact.Visible = IsWindowVisible(hWnd);
    fact.Minimized = IsIconic(hWnd);
    return fact;
  }

  public static WindowFact[] TopLevelWindows()
  {
    List<WindowFact> results = new List<WindowFact>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
    {
      try
      {
        WindowFact fact = One(hWnd);
        if (fact != null) results.Add(fact);
      }
      catch (Exception) { }
      return true;
    }, IntPtr.Zero);
    return results.ToArray();
  }

  public static WindowFact[] ChildWindows(IntPtr parent)
  {
    List<WindowFact> results = new List<WindowFact>();
    EnumChildWindows(parent, delegate(IntPtr hWnd, IntPtr lParam)
    {
      try
      {
        WindowFact fact = One(hWnd);
        if (fact != null) results.Add(fact);
      }
      catch (Exception) { }
      return true;
    }, IntPtr.Zero);
    return results.ToArray();
  }

  /** The first descendant whose class name contains EDIT, which is where typing lands. */
  public static IntPtr FindEditChild(IntPtr parent)
  {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, delegate(IntPtr hWnd, IntPtr lParam)
    {
      if (found != IntPtr.Zero) return false;
      StringBuilder className = new StringBuilder(512);
      GetClassNameW(hWnd, className, className.Capacity);
      string name = className.ToString().ToUpperInvariant();
      if (name.IndexOf("EDIT") >= 0) { found = hWnd; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static bool Post(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam)
  {
    return PostMessageW(hWnd, message, wParam, lParam);
  }

  /**
   * The two packed message parameters, built HERE rather than in PowerShell.
   *
   * Shifting a signed 16-bit value left by 16 is how these messages want their coordinates, and
   * PowerShell arithmetic promotes and wraps differently from C#: a negative wheel delta shifted
   * in PowerShell produced a value outside the range IntPtr accepts. Building them here means
   * there is one implementation of the packing and it is written in the language the message
   * format is defined in.
   */
  public static long PointLParam(int x, int y)
  {
    /* Cast to ushort FIRST, then widen. Writing (long)(y & 0xFFFF) looks equivalent and is not:
       the compiler warns CS0078 that the OR is applied to a sign-extended operand, and Add-Type
       in Windows PowerShell 5.1 treats warnings as errors, so a warning here is a lane that will
       not compile. Measured: this payload failed to compile with exactly that message. */
    long high = (long)(ushort)y;
    long low = (long)(ushort)x;
    return (high << 16) | low;
  }

  public static long WheelWParam(int delta)
  {
    return (long)(ushort)delta << 16;
  }

  /** Where the middle of a window client area is, in screen coordinates. */
  public static bool ClientCenterOnScreen(IntPtr hWnd, out int screenX, out int screenY)
  {
    screenX = 0;
    screenY = 0;
    RECT client;
    if (!GetClientRect(hWnd, out client)) return false;
    POINT point = new POINT();
    point.X = (client.Right - client.Left) / 2;
    point.Y = (client.Bottom - client.Top) / 2;
    if (!ClientToScreen(hWnd, ref point)) return false;
    screenX = point.X;
    screenY = point.Y;
    return true;
  }

  /**
   * Capture one window into a BMP file, and say WHICH route produced the pixels.
   *
   * PrintWindow is asked first with PW_RENDERFULLCONTENT (2), then with 0, and only then is
   * BitBlt from the window DC tried. The route is returned rather than assumed: a capture that
   * silently fell back to a screen grab of an occluded window would produce a plausible file
   * of the wrong pixels, and a measurement that cannot tell those apart is not a measurement.
   * Route 2 and 0 are PrintWindow, route 3 is BitBlt, route 0 with ok 0 is nothing.
   */
  public static int Capture(IntPtr hWnd, string path, out int width, out int height, out int route, out int printWindowError)
  {
    RECT logical; GetWindowRect(hWnd,out logical);
    IntPtr dpi=SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(hWnd));
    try { return CaptureInContext(hWnd,path,logical.Right-logical.Left,logical.Bottom-logical.Top,out width,out height,out route,out printWindowError); }
    finally { if(dpi!=IntPtr.Zero)SetThreadDpiAwarenessContext(dpi); }
  }
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("gdi32.dll")] static extern int SetStretchBltMode(IntPtr dc,int mode);
  [DllImport("gdi32.dll")] static extern bool StretchBlt(IntPtr to,int x,int y,int width,int height,IntPtr from,int sx,int sy,int sourceWidth,int sourceHeight,uint operation);
  static int CaptureInContext(IntPtr hWnd, string path,int logicalWidth,int logicalHeight,out int width,out int height,out int route,out int printWindowError)
  {
    width = 0; height = 0; route = 0; printWindowError = 0;
    if (!IsWindow(hWnd)) return 0;
    RECT rect;
    if (!GetWindowRect(hWnd, out rect)) return 0;
    int w = rect.Right - rect.Left;
    int h = rect.Bottom - rect.Top;
    if (w <= 0 || h <= 0) return 0;
    IntPtr windowDc = GetWindowDC(hWnd);
    if (windowDc == IntPtr.Zero) return 0;
    IntPtr memoryDc = IntPtr.Zero;
    IntPtr bitmap = IntPtr.Zero;
    IntPtr previous = IntPtr.Zero;
    try
    {
      memoryDc = CreateCompatibleDC(windowDc);
      if (memoryDc == IntPtr.Zero) return 0;
      bitmap = CreateCompatibleBitmap(windowDc, w, h);
      if (bitmap == IntPtr.Zero) return 0;
      previous = SelectObject(memoryDc, bitmap);
      bool captured = false;
      if (PrintWindow(hWnd, memoryDc, 2)) { route = 2; captured = true; }
      else if (PrintWindow(hWnd, memoryDc, 0)) { route = 0; captured = true; }
      else if (BitBlt(memoryDc, 0, 0, w, h, windowDc, 0, 0, SRCCOPY)) { route = 3; captured = true; }
      if (!captured) { printWindowError = Marshal.GetLastWin32Error(); return 0; }
      // Preserve the agent's advertised coordinate space, even when the target is PMv2.
      if(logicalWidth>0&&logicalHeight>0&&(logicalWidth!=w||logicalHeight!=h)) {
        IntPtr scaledDc=CreateCompatibleDC(windowDc),scaledBitmap=CreateCompatibleBitmap(windowDc,logicalWidth,logicalHeight);
        if(scaledDc==IntPtr.Zero||scaledBitmap==IntPtr.Zero){if(scaledDc!=IntPtr.Zero)DeleteDC(scaledDc);if(scaledBitmap!=IntPtr.Zero)DeleteObject(scaledBitmap);return 0;}
        IntPtr scaledPrevious=SelectObject(scaledDc,scaledBitmap);SetStretchBltMode(scaledDc,4);
        bool scaled=StretchBlt(scaledDc,0,0,logicalWidth,logicalHeight,memoryDc,0,0,w,h,SRCCOPY);
        if(!scaled){SelectObject(scaledDc,scaledPrevious);DeleteObject(scaledBitmap);DeleteDC(scaledDc);return 0;}
        SelectObject(memoryDc,previous);DeleteObject(bitmap);DeleteDC(memoryDc);
        memoryDc=scaledDc;bitmap=scaledBitmap;previous=scaledPrevious;w=logicalWidth;h=logicalHeight;
      }
      SelectObject(memoryDc, previous);
      previous = IntPtr.Zero;
      byte[] bits = new byte[w * h * 4];
      BITMAPINFO info = new BITMAPINFO();
      info.bmiHeader.biSize = 40;
      info.bmiHeader.biWidth = w;
      info.bmiHeader.biHeight = -h;
      info.bmiHeader.biPlanes = 1;
      info.bmiHeader.biBitCount = 32;
      info.bmiHeader.biCompression = 0;
      info.bmiHeader.biSizeImage = (uint)(w * h * 4);
      int lines = GetDIBits(memoryDc, bitmap, 0, (uint)h, bits, ref info, 0);
      if (lines != h) { printWindowError = Marshal.GetLastWin32Error(); return 0; }
      WriteBmp(path, bits, w, h);
      width = w; height = h;
      return 1;
    }
    finally
    {
      if (previous != IntPtr.Zero && memoryDc != IntPtr.Zero) SelectObject(memoryDc, previous);
      if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
      if (memoryDc != IntPtr.Zero) DeleteDC(memoryDc);
      ReleaseDC(hWnd, windowDc);
    }
  }

  static void WriteBmp(string path, byte[] bits, int width, int height)
  {
    int imageSize = width * height * 4;
    System.IO.FileStream stream = new System.IO.FileStream(path, System.IO.FileMode.Create, System.IO.FileAccess.Write);
    try
    {
      System.IO.BinaryWriter writer = new System.IO.BinaryWriter(stream);
      writer.Write((byte)0x42);
      writer.Write((byte)0x4D);
      writer.Write(14 + 40 + imageSize);
      writer.Write((short)0);
      writer.Write((short)0);
      writer.Write(54);
      writer.Write(40);
      writer.Write(width);
      writer.Write(-height);
      writer.Write((short)1);
      writer.Write((short)32);
      writer.Write(0);
      writer.Write(imageSize);
      writer.Write(0);
      writer.Write(0);
      writer.Write(0);
      writer.Write(0);
      writer.Write(bits);
      writer.Flush();
    }
    finally { stream.Close(); }
  }
}
