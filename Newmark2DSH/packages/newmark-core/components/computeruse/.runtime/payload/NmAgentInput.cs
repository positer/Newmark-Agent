using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class NmAgentInput
{
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extraInfo);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool GetCursorPos(out POINT point);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);

  public const uint MOUSEEVENTF_MOVE = 0x0001;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP = 0x0010;

  /* The wire form of the three button names. The SPELLINGS are decoded where the JSON field lives,
     so the accepted vocabulary is exactly one list and this type only bounds an integer. */
  public const int BUTTON_NONE = 0;
  public const int BUTTON_LEFT = 1;
  public const int BUTTON_RIGHT = 2;

  /* The bounds enforced by SweepMeasured. */
  public const int STEPS_MIN = 1;
  public const int STEPS_MAX = 240;
  public const int DURATION_MIN_MS = 1;
  public const int DURATION_MAX_MS = 15000;
  public const int DELTA_MAX = 100000;

  /**
   * The cursor on THIS desktop, or an EMPTY array when it could not be read.
   *
   * Empty rather than a zero point, because (0,0) is a legal position and a caller that could not
   * tell "the pointer is at the origin" from "the read failed" would restore the pointer to the
   * corner. The real-mode sweep refuses on the same condition.
   */
  public static int[] Cursor()
  {
    POINT point = new POINT();
    if (!GetCursorPos(out point)) return new int[0];
    int[] answer = new int[2];
    answer[0] = point.X;
    answer[1] = point.Y;
    return answer;
  }

  /** The window this desktop holds as its foreground, which is where a gesture would land. */
  public static IntPtr Foreground()
  {
    return GetForegroundWindow();
  }

  /**
   * Bring one window of this desktop to the front, and answer whether the call accepted it.
   *
   * The answer is a measurement and not a promise: the window manager is free to refuse the
   * activation, and a caller that needs the foreground to have moved has to read this value
   * rather than the request it made.
   */
  public static bool BringForeground(IntPtr hWnd)
  {
    if (hWnd == IntPtr.Zero) return false;
    if (!IsWindow(hWnd)) return false;
    return SetForegroundWindow(hWnd);
  }

  /**
   * Everything one sweep measured.
   *
   * Injected is the answer a caller acts on and it is three-valued: -1 means an argument or a bound
   * was refused and NOTHING was attempted, 0 means the motion ran and injected no move record, and
   * a positive count is the number of relative move records actually injected.
   */
  public sealed class SweepFact
  {
    public int Injected { get; set; }
    public string Error { get; set; }
    public int Dx { get; set; }
    public int Dy { get; set; }
    public int Steps { get; set; }
    public int SumDx { get; set; }
    public int SumDy { get; set; }
    public int DurationMs { get; set; }
    public int ElapsedMs { get; set; }
    public int Button { get; set; }
    public int ButtonHeldMs { get; set; }
    public bool ButtonReleased { get; set; }
    public int CursorBeforeX { get; set; }
    public int CursorBeforeY { get; set; }
    public int CursorMovedX { get; set; }
    public int CursorMovedY { get; set; }
    public int CursorAfterX { get; set; }
    public int CursorAfterY { get; set; }
    /* Whether each cursor read answered at all. A position is only reported when its own read
       answered, because (0,0) is a legal pointer position and a caller cannot tell the two apart. */
    public bool CursorRestorable { get; set; }
    public bool CursorMeasured { get; set; }
    public bool CursorAfterMeasured { get; set; }
    public bool CursorRestored { get; set; }
  }

  /** The injected-count form, for a caller that wants only the number of move records. */
  public static int Sweep(int dx, int dy, int steps, int durationMs, int button)
  {
    return SweepMeasured(dx, dy, steps, durationMs, button).Injected;
  }

  /**
   * Inject one relative sweep and answer with what was measured.
   *
   * WHERE THE BOUNDS ARE ENFORCED, AND WHY HERE. This method is the only thing that moves the
   * pointer, so a bound enforced at a caller would simply be bypassed by the next caller. Outside
   * them it refuses with the plain message below and NOTHING has moved yet - it never clamps a
   * value and then reports success for motion nobody asked for.
   *
   * HOW THE DELTAS ADD UP. Each step target is the CUMULATIVE displacement after that step, rounded
   * once; the delta injected is that target minus what has already been sent. Rounding every step
   * on its own loses the remainder and lands the pointer beside the requested point, whereas
   * rounding the target puts the whole remainder on the LAST step - so the injected deltas sum to
   * exactly (dx, dy). SumDx and SumDy report that sum as measured, not as promised, which is what
   * lets a receipt show a defect instead of repeating the request back.
   *
   * WHY THE STEPS ARE TIMED AGAINST A STOPWATCH. A chain of sleeps accumulates its own dispatch
   * cost, so the gesture would run longer than asked and the drift would grow with the step count.
   * Each step instead waits for one deadline computed from a single monotonic origin. The wait is
   * a sleep and then a short spin, because the sleep resolution is coarser than the
   * sub-millisecond spacing a 240-step sweep has.
   */
  public static SweepFact SweepMeasured(int dx, int dy, int steps, int durationMs, int button)
  {
    SweepFact fact = new SweepFact();
    fact.Injected = -1;
    fact.Error = "";
    fact.Dx = dx;
    fact.Dy = dy;
    fact.Steps = steps;
    fact.DurationMs = durationMs;
    fact.Button = button;

    if (steps < STEPS_MIN || steps > STEPS_MAX)
    {
      fact.Error = "sweep steps must be a whole number between 1 and 240";
      return fact;
    }
    if (durationMs < DURATION_MIN_MS || durationMs > DURATION_MAX_MS)
    {
      fact.Error = "sweep duration_ms must be between 1 and 15000";
      return fact;
    }
    if (dx < -DELTA_MAX || dx > DELTA_MAX || dy < -DELTA_MAX || dy > DELTA_MAX)
    {
      fact.Error = "sweep dx and dy must each be within 100000 pixels";
      return fact;
    }
    if (button != BUTTON_NONE && button != BUTTON_LEFT && button != BUTTON_RIGHT)
    {
      fact.Error = "sweep button must be none, left or right";
      return fact;
    }

    // THE CURSOR POSITION IS BEST-EFFORT, AND THAT IS A PROPERTY OF THE DESKTOP.
    //
    // On a desktop that has never been the input desktop GetCursorPos fails and SetCursorPos is
    // refused, so there is no readable pointer position and nothing to restore to. That makes the
    // RESTORE impossible; it is not a reason to withhold the steering motion the caller asked for.
    // Measured on a hidden desktop created by this agent: both cursor calls failed, a 40 px
    // relative injection left the interactive desktop's pointer exactly where it was, and no
    // position could be read anywhere - which is why the receipt says "restore impossible" rather
    // than reporting a restore that never happened.
    int[] before = Cursor();
    fact.CursorRestorable = before.Length >= 2;
    if (fact.CursorRestorable)
    {
      fact.CursorBeforeX = before[0];
      fact.CursorBeforeY = before[1];
    }
    fact.Injected = 0;

    bool pressed = false;
    long pressedAt = 0;
    long clockStart = Stopwatch.GetTimestamp();
    long frequency = Stopwatch.Frequency;
    int sentX = 0;
    int sentY = 0;
    try
    {
      if (button != BUTTON_NONE)
      {
        pressedAt = Stopwatch.GetTimestamp();
        mouse_event(DownFlag(button), 0, 0, 0, UIntPtr.Zero);
        pressed = true;
      }
      for (int step = 1; step <= steps; step += 1)
      {
        int wantX = (int)Math.Round((double)dx * step / steps);
        int wantY = (int)Math.Round((double)dy * step / steps);
        int stepX = wantX - sentX;
        int stepY = wantY - sentY;
        if (stepX != 0 || stepY != 0)
        {
          mouse_event(MOUSEEVENTF_MOVE, stepX, stepY, 0, UIntPtr.Zero);
          sentX = wantX;
          sentY = wantY;
          fact.Injected = fact.Injected + 1;
          fact.SumDx = sentX;
          fact.SumDy = sentY;
        }
        long due = clockStart + ((long)durationMs * frequency * step) / (1000L * steps);
        long remaining = due - Stopwatch.GetTimestamp();
        if (remaining > 0)
        {
          long sleepMs = (remaining * 1000L) / frequency;
          if (sleepMs > 1L) Thread.Sleep((int)(sleepMs - 1L));
          while (Stopwatch.GetTimestamp() < due) Thread.Sleep(0);
        }
      }
      fact.ElapsedMs = (int)(((Stopwatch.GetTimestamp() - clockStart) * 1000L) / frequency);
    }
    catch (Exception error)
    {
      // The motion is the part that can throw, and an exception must not reach the agent's
      // script-scope trap - that trap exits the whole agent, so a failed gesture would cost the
      // desktop it was aimed at. It is reported as what it was.
      fact.Error = "the sweep raised " + error.GetType().Name + ": " + error.Message;
    }
    finally
    {
      // EVERY path releases: the loop end, a refusal that got this far, the exception above, and a
      // caller that stopped waiting. A button left down on a desktop nobody is looking at is the
      // worst thing this method could leave behind, so the release is not conditional on success.
      if (pressed)
      {
        mouse_event(UpFlag(button), 0, 0, 0, UIntPtr.Zero);
        fact.ButtonHeldMs = (int)(((Stopwatch.GetTimestamp() - pressedAt) * 1000L) / frequency);
        fact.ButtonReleased = true;
      }
    }

    // Where the pointer had actually got to, measured BEFORE the restore. This is the evidence that
    // the desktop own cursor followed the injection, so a caller can tell "the injection moved
    // nothing here" from "it moved and was put back".
    int[] moved = Cursor();
    fact.CursorMeasured = moved.Length >= 2;
    if (fact.CursorMeasured)
    {
      fact.CursorMovedX = moved[0];
      fact.CursorMovedY = moved[1];
    }
    if (fact.CursorRestorable)
    {
      // The restore uses the ABSOLUTE call on purpose: it puts the pointer back and produces no
      // relative packet, so a gesture repeated in the same direction does not accumulate a phantom
      // turn out of its own cleanup. It is called ONLY with a position that was read here - a
      // guessed origin would move a pointer nobody asked to move.
      bool placed = SetCursorPos(fact.CursorBeforeX, fact.CursorBeforeY);
      int[] after = Cursor();
      fact.CursorAfterMeasured = after.Length >= 2;
      if (fact.CursorAfterMeasured)
      {
        fact.CursorAfterX = after[0];
        fact.CursorAfterY = after[1];
      }
      // Measured, not assumed: the restore counts only when the call was accepted AND the position
      // read back exactly. A pointer that is merely close is not the pointer that was here before.
      fact.CursorRestored = placed && fact.CursorAfterMeasured && fact.CursorAfterX == fact.CursorBeforeX && fact.CursorAfterY == fact.CursorBeforeY;
    }

    if (fact.Error.Length == 0 && fact.Injected <= 0)
    {
      fact.Error = "the sweep injected no relative move: dx and dy are below one pixel of travel";
    }
    return fact;
  }

  static uint DownFlag(int button)
  {
    if (button == BUTTON_RIGHT) return MOUSEEVENTF_RIGHTDOWN;
    return MOUSEEVENTF_LEFTDOWN;
  }

  static uint UpFlag(int button)
  {
    if (button == BUTTON_RIGHT) return MOUSEEVENTF_RIGHTUP;
    return MOUSEEVENTF_LEFTUP;
  }
}
