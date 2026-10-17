# desktop-pet-render-probe.ps1 - composited-screen witness for the NewMate desktop pet.
#
# WHY A SCREEN PROBE. PrintWindow(hwnd,dc,2) cannot see an UpdateLayeredWindow
# surface. Measured on this host it renders the unpainted WinForms control
# background (240,240,240) whatever the pet presents, so it is recorded as
# evidence and never used as a pass criterion. The only witness of what the user
# actually sees is a CopyFromScreen BitBlt of the pet's rectangle, and that is
# what verify-desktop-pet-render.mjs asserts on.
#
# Run under Windows PowerShell 5.1 (powershell.exe): the C# helper below is
# compiled against the .NET Framework System.Drawing. Called only by
# Newmark2DSH/scripts/verify-desktop-pet-render.mjs.
#
# Actions (one -Compress JSON object on stdout; the gate reads the last JSON line):
#   environment   host/screen/DPI fact scan, every top-level window (so the
#                 orchestrator can pick a rectangle the running user pet does not
#                 occupy) and the newmark-desktop-pet processes already running.
#   move          SetWindowPos OUR OWN pet handle to -TargetX/-TargetY. The probe
#                 only ever touches a window it created or was handed.
#   frames        -Count CopyFromScreen frames of the pet rectangle, -IntervalMs
#                 apart, each saved as a PNG and reduced to luma min/max/distinct,
#                 white250, dark60, light200, mean luma, modal block ratio and
#                 sha256 - over the whole rectangle and inside -PaintBounds (the
#                 sprite region). Optionally over an opaque background window of
#                 -BackgroundLuma so the measurement does not depend on the
#                 desktop wallpaper.
#   ring          puts an opaque background window under the pet, captures the pet
#                 rectangle over -BackgroundLumaDark and over -BackgroundLumaLight
#                 and diffs only the pixels outside -PaintBounds (the pet's
#                 transparent padding ring). Per-pixel alpha on the screen is
#                 exactly what makes those pixels follow the background.
#   inject-watch  injects an opaque pure-white UpdateLayeredWindow surface of
#                 exactly the pet rectangle into -HandleValue, then polls the
#                 screen until the pet presents a content frame again or
#                 -TimeoutMs expires. Records the injected frame, every poll and
#                 the heal latency against the injection instant.
#   printwindow   PrintWindow(hwnd,dc,2) digest - EVIDENCE ONLY.
#   selftest      proves the background-window mechanism used by frames/ring really
#                 paints the requested luma on the composited screen.
#
# Every capture raises the pet with SetWindowPos(HWND_TOPMOST, NOMOVE|NOSIZE|
# NOACTIVATE) first. That changes z-order only: it cannot repaint a layered
# surface, so it cannot mask the injected defect.

param(
    [Parameter(Mandatory=$true)][ValidateSet('environment','move','frames','ring','inject-watch','printwindow','desktop-under','selftest')][string]$Action,
    [long]$HandleValue=0,
    [string]$EvidenceDirectory='.',
    [string]$Prefix='frame',
    [int]$Count=5,
    [int]$IntervalMs=200,
    [int]$TimeoutMs=2500,
    [int]$PollMs=150,
    [string]$PaintBounds='',
    [string]$StatusBounds='',
    [int]$RingInset=2,
    [int]$BackgroundLuma=0,
    [int]$BackgroundLumaDark=40,
    [int]$BackgroundLumaLight=235,
    [int]$ChangeThreshold=20,
    [int]$ColorTolerance=12,
    [int]$TargetX=0,
    [int]$TargetY=0,
    [int]$PadPx=40,
    [int]$SelfTestLuma=37
)

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName System.Drawing
$petRenderProbeSource=@'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

// Composited-screen witness for the NewMate desktop pet gate. Plain C# 5 on the
// .NET Framework so Windows PowerShell 5.1 Add-Type compiles it.
public static class PetRenderProbe {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
    [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int X,Y; }
    [StructLayout(LayoutKind.Sequential,Pack=1)] public struct BLEND { public byte Op,Flags,Alpha,Format; }
    [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFO {
        public uint Size; public int Width,Height; public ushort Planes,Bits;
        public uint Compression,ImageSize; public int XPels,YPels; public uint Used,Important;
    }

    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll",SetLastError=true)] public static extern bool GetWindowRect(IntPtr window,out RECT rect);
    [DllImport("user32.dll",SetLastError=true)] public static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int cx,int cy,uint flags);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll",SetLastError=true)] public static extern bool UpdateLayeredWindow(IntPtr window,IntPtr dest,ref POINT point,ref SIZE size,IntPtr source,ref POINT origin,int key,ref BLEND blend,int flags);
    [DllImport("user32.dll",SetLastError=true)] public static extern bool PrintWindow(IntPtr window,IntPtr dc,uint flags);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateWindowEx(uint exStyle,string className,string windowName,uint style,int x,int y,int width,int height,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr param);
    [DllImport("user32.dll",SetLastError=true)] public static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window,int command);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string name);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr dc,ref BITMAPINFO info,uint usage,out IntPtr bits,IntPtr section,uint offset);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc,IntPtr value);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr value);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window,int index);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int max);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder text,int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);

    public delegate bool EnumProc(IntPtr window,IntPtr data);

    public static int GetWindowExStyle(IntPtr window) { return GetWindowLong(window,-20); }
    public static bool RaiseTopmost(IntPtr window) { return SetWindowPos(window,new IntPtr(-1),0,0,0,0,0x13); }
    public static bool HideWindow(IntPtr window) { return ShowWindow(window,0); }
    public static bool MoveNoActivate(IntPtr window,int x,int y) { return SetWindowPos(window,new IntPtr(-1),x,y,0,0,0x11); }
    public static bool RaiseTop(IntPtr window) { return SetWindowPos(window,IntPtr.Zero,0,0,0,0,0x13); }
    public static long HitTest(int x,int y) { POINT point=new POINT(); point.X=x; point.Y=y; return WindowFromPoint(point).ToInt64(); }
    public static long Foreground() { return GetForegroundWindow().ToInt64(); }
    public static int CursorX() { POINT point; GetCursorPos(out point); return point.X; }
    public static int CursorY() { POINT point; GetCursorPos(out point); return point.Y; }
    [DllImport("user32.dll",SetLastError=true)] static extern bool SystemParametersInfo(uint action,uint param,out RECT rect,uint flags);
    public static int[] WorkArea() {
        RECT rect;
        if(!SystemParametersInfo(0x0030,0,out rect,0)) return new int[] { 0, 0, GetSystemMetrics(0), GetSystemMetrics(1) };
        return new int[] { rect.Left, rect.Top, rect.Right-rect.Left, rect.Bottom-rect.Top };
    }
    public static int VirtualScreenX() { return GetSystemMetrics(76); }
    public static int VirtualScreenY() { return GetSystemMetrics(77); }
    public static int VirtualScreenWidth() { return GetSystemMetrics(78); }
    public static int VirtualScreenHeight() { return GetSystemMetrics(79); }

    // Opaque surface (alpha 255 everywhere; premultiplied equals the plain
    // channel) presented with UpdateLayeredWindow. Returns 0 on success, else the
    // Win32 error of the call that failed.
    public static int PaintLayeredOpaque(IntPtr window,int x,int y,int width,int height,int blue,int green,int red) {
        if(width<=0||height<=0) return -1;
        IntPtr dc=CreateCompatibleDC(IntPtr.Zero);
        if(dc==IntPtr.Zero) return Marshal.GetLastWin32Error();
        BITMAPINFO info=new BITMAPINFO();
        info.Size=40; info.Width=width; info.Height=-height; info.Planes=1; info.Bits=32;
        IntPtr bits;
        IntPtr dib=CreateDIBSection(dc,ref info,0,out bits,IntPtr.Zero,0);
        if(dib==IntPtr.Zero){int error=Marshal.GetLastWin32Error();DeleteDC(dc);return error;}
        IntPtr previous=SelectObject(dc,dib);
        try {
            byte[] pixels=new byte[width*height*4];
            for(int i=0;i<pixels.Length;i+=4){pixels[i]=(byte)blue;pixels[i+1]=(byte)green;pixels[i+2]=(byte)red;pixels[i+3]=255;}
            Marshal.Copy(pixels,0,bits,pixels.Length);
            POINT point=new POINT(); point.X=x; point.Y=y;
            POINT origin=new POINT();
            SIZE size=new SIZE(); size.X=width; size.Y=height;
            BLEND blend=new BLEND(); blend.Op=0; blend.Flags=0; blend.Alpha=255; blend.Format=1;
            if(!UpdateLayeredWindow(window,IntPtr.Zero,ref point,ref size,dc,ref origin,0,ref blend,2)) return Marshal.GetLastWin32Error();
            return 0;
        } finally { SelectObject(dc,previous); DeleteObject(dib); DeleteDC(dc); }
    }

    // The observed defect: an opaque pure-white surface of exactly the window
    // rectangle, ULW_ALPHA with AC_SRC_ALPHA and alpha 255 everywhere.
    public static string InjectOpaqueWhite(IntPtr window,int x,int y,int width,int height) {
        int error=PaintLayeredOpaque(window,x,y,width,height,255,255,255);
        return error==0 ? "" : ("opaque white UpdateLayeredWindow failed, win32=" + error);
    }

    public sealed class BackgroundWindowInfo {
        public long Handle {get;set;} public string Error {get;set;}
        public int X {get;set;} public int Y {get;set;} public int Width {get;set;} public int Height {get;set;}
        public int Luma {get;set;} public bool Visible {get;set;}
    }

    // A no-activate, non-topmost window painted through UpdateLayeredWindow: the
    // background the pet is measured over. It sits at the top of the non-topmost
    // band, so a topmost pet window always stays above it.
    public static BackgroundWindowInfo CreateBackgroundWindow(int x,int y,int width,int height,int luma) {
        BackgroundWindowInfo info=new BackgroundWindowInfo();
        info.X=x; info.Y=y; info.Width=width; info.Height=height; info.Luma=luma; info.Handle=0; info.Error="";
        IntPtr window=CreateWindowEx(0x00080000|0x08000000|0x00000080,"STATIC","NewmarkRenderProbeBackground",0x80000000,x,y,width,height,IntPtr.Zero,IntPtr.Zero,GetModuleHandle(null),IntPtr.Zero);
        if(window==IntPtr.Zero){info.Error="CreateWindowEx failed, win32="+Marshal.GetLastWin32Error();return info;}
        int error=PaintLayeredOpaque(window,x,y,width,height,luma,luma,luma);
        if(error!=0){DestroyWindow(window);info.Error="background UpdateLayeredWindow failed, win32="+error;return info;}
        ShowWindow(window,8);
        RaiseTop(window);
        info.Handle=window.ToInt64(); info.Visible=IsWindowVisible(window);
        return info;
    }

    public static BackgroundWindowInfo PaintBackgroundWindow(long handle,int luma) {
        BackgroundWindowInfo info=new BackgroundWindowInfo();
        info.Handle=handle; info.Luma=luma; info.Error="";
        IntPtr window=new IntPtr(handle);
        RECT rect; GetWindowRect(window,out rect);
        info.X=rect.Left; info.Y=rect.Top; info.Width=rect.Right-rect.Left; info.Height=rect.Bottom-rect.Top;
        int error=PaintLayeredOpaque(window,info.X,info.Y,info.Width,info.Height,luma,luma,luma);
        if(error!=0) info.Error="background repaint failed, win32="+error;
        RaiseTop(window);
        info.Visible=IsWindowVisible(window);
        return info;
    }

    public static string DestroyBackgroundWindow(long handle) {
        if(handle==0) return "";
        if(!DestroyWindow(new IntPtr(handle))) return ("DestroyWindow failed, win32="+Marshal.GetLastWin32Error());
        return "";
    }

    public sealed class FrameStats {
        public int Width {get;set;} public int Height {get;set;} public int Pixels {get;set;}
        public int Min {get;set;} public int Max {get;set;} public int Distinct {get;set;} public int Modal {get;set;}
        public double MeanLuma {get;set;} public double BlockRatio {get;set;}
        public int White250 {get;set;} public int Dark60 {get;set;} public int Light200 {get;set;}
        public string Sha256 {get;set;} public string PixelFormat {get;set;}
        public int InsidePixels {get;set;} public int InsideMin {get;set;} public int InsideMax {get;set;}
        public int InsideDistinct {get;set;} public int InsideWhite250 {get;set;} public int InsideDark60 {get;set;} public int InsideLight200 {get;set;}
        public double InsideMeanLuma {get;set;}
        // Exact (255,255,255) is the white-plate signature: the defect measured 27234/27234 and
        // 97682/97682 such pixels, while a healthy frame carries only the sprite's own white.
        public int Pure255 {get;set;} public int InsidePure255 {get;set;}
        // The four rect corners and the centre as packed 0xRRGGBB, so a transparency assertion can
        // compare a composited corner against the same point with the pet hidden.
        public int Corner0 {get;set;} public int Corner1 {get;set;} public int Corner2 {get;set;} public int Corner3 {get;set;}
        public int Center {get;set;}
    }

    static string Hash(byte[] bytes) {
        using(SHA256 sha=SHA256.Create()) {
            byte[] digest=sha.ComputeHash(bytes);
            StringBuilder text=new StringBuilder(digest.Length*2);
            for(int i=0;i<digest.Length;i++) text.Append(digest[i].ToString("x2"));
            return text.ToString();
        }
    }

    // px,py,pw,ph is the pet's paint_bounds in window-relative pixels. The bitmap
    // is an exact CopyFromScreen of the window rectangle, so window coordinates
    // equal bitmap coordinates. pw<=0 records whole-rect facts only.
    public static FrameStats Analyze(Bitmap bitmap,int px,int py,int pw,int ph) {
        FrameStats stats=new FrameStats();
        stats.Width=bitmap.Width; stats.Height=bitmap.Height; stats.PixelFormat=bitmap.PixelFormat.ToString();
        int width=bitmap.Width, height=bitmap.Height;
        BitmapData data=bitmap.LockBits(new Rectangle(0,0,width,height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
        try {
            int stride=data.Stride;
            byte[] bytes=new byte[stride*height];
            Marshal.Copy(data.Scan0,bytes,0,bytes.Length);
            int[] histogram=new int[256];
            int[] insideHistogram=new int[256];
            int min=999,max=-1,white=0,dark=0,light=0,pure=0,insidePure=0;
            int insideMin=999,insideMax=-1,insideWhite=0,insideDark=0,insideLight=0,insidePixels=0;
            long sum=0,insideSum=0;
            bool hasInside=pw>0&&ph>0;
            for(int y=0;y<height;y++) {
                for(int x=0;x<width;x++) {
                    int offset=y*stride+x*4;
                    int luma=(int)Math.Round(0.299*bytes[offset+2]+0.587*bytes[offset+1]+0.114*bytes[offset]);
                    if(luma<0)luma=0; if(luma>255)luma=255;
                    histogram[luma]++; sum+=luma;
                    if(luma<min)min=luma; if(luma>max)max=luma;
                    if(luma>=250)white++; if(luma<=60)dark++; if(luma>=200)light++;
                    if(bytes[offset+2]==255&&bytes[offset+1]==255&&bytes[offset]==255)pure++;
                    if(hasInside&&x>=px&&x<px+pw&&y>=py&&y<py+ph) {
                        insideHistogram[luma]++; insidePixels++; insideSum+=luma;
                        if(luma<insideMin)insideMin=luma; if(luma>insideMax)insideMax=luma;
                        if(luma>=250)insideWhite++; if(luma<=60)insideDark++; if(luma>=200)insideLight++;
                        if(bytes[offset+2]==255&&bytes[offset+1]==255&&bytes[offset]==255)insidePure++;
                    }
                }
            }
            int distinct=0,modal=0;
            for(int i=0;i<256;i++) if(histogram[i]>0){distinct++;if(histogram[i]>modal)modal=histogram[i];}
            int insideDistinct=0;
            for(int i=0;i<256;i++) if(insideHistogram[i]>0) insideDistinct++;
            int total=width*height;
            stats.Min=min;stats.Max=max;stats.Distinct=distinct;stats.Modal=modal;stats.Pixels=total;
            stats.MeanLuma=Math.Round((double)sum/total,2);
            stats.BlockRatio=Math.Round((double)modal/total,4);
            stats.White250=white;stats.Dark60=dark;stats.Light200=light;
            stats.InsidePixels=insidePixels;stats.InsideMin=insidePixels>0?insideMin:-1;stats.InsideMax=insidePixels>0?insideMax:-1;
            stats.InsideDistinct=insideDistinct;stats.InsideWhite250=insideWhite;stats.InsideDark60=insideDark;stats.InsideLight200=insideLight;
            stats.InsideMeanLuma=insidePixels>0?Math.Round((double)insideSum/insidePixels,2):-1;
            stats.Pure255=pure; stats.InsidePure255=insidePure;
            stats.Corner0=PixelAt(bytes,stride,0,0); stats.Corner1=PixelAt(bytes,stride,width-1,0);
            stats.Corner2=PixelAt(bytes,stride,0,height-1); stats.Corner3=PixelAt(bytes,stride,width-1,height-1);
            stats.Center=PixelAt(bytes,stride,width/2,height/2);
            stats.Sha256=Hash(bytes);
        } finally { bitmap.UnlockBits(data); }
        return stats;
    }

    // Packed 0xRRGGBB at one pixel of an already-locked 32bpp frame.
    static int PixelAt(byte[] bytes,int stride,int x,int y) {
        int offset=y*stride+x*4;
        return (bytes[offset+2]<<16)|(bytes[offset+1]<<8)|bytes[offset];
    }

    public sealed class DiffStats {
        public int RingPixels {get;set;} public int ChangedPixels {get;set;} public double ChangedRatio {get;set;}
        public double MeanLumaA {get;set;} public double MeanLumaB {get;set;} public double MeanAbsDelta {get;set;}
        public int MatchAPixels {get;set;} public int MatchBPixels {get;set;}
        public double MatchARatio {get;set;} public double MatchBRatio {get;set;}
    }

    // Diffs only the pixels outside the paint rectangle inflated by inset: the
    // pet's transparent padding ring. A surface that really is composited with
    // per-pixel alpha makes those pixels follow whatever is behind the pet.
    public static DiffStats CompareRing(Bitmap a,Bitmap b,int px,int py,int pw,int ph,int inset,int changeThreshold,int expectedA,int expectedB,int tolerance) {
        DiffStats stats=new DiffStats();
        if(a.Width!=b.Width||a.Height!=b.Height) throw new ArgumentException("ring frames differ in size");
        int width=a.Width,height=a.Height;
        BitmapData da=a.LockBits(new Rectangle(0,0,width,height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
        byte[] bytesA; int strideA;
        try { strideA=da.Stride; bytesA=new byte[strideA*height]; Marshal.Copy(da.Scan0,bytesA,0,bytesA.Length); } finally { a.UnlockBits(da); }
        BitmapData db=b.LockBits(new Rectangle(0,0,width,height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
        byte[] bytesB; int strideB;
        try { strideB=db.Stride; bytesB=new byte[strideB*height]; Marshal.Copy(db.Scan0,bytesB,0,bytesB.Length); } finally { b.UnlockBits(db); }
        int ring=0,changed=0,matchA=0,matchB=0;
        long sumA=0,sumB=0,sumDelta=0;
        int x0=px-inset, x1=px+pw+inset, y0=py-inset, y1=py+ph+inset;
        for(int y=0;y<height;y++) {
            for(int x=0;x<width;x++) {
                if(x>=x0&&x<x1&&y>=y0&&y<y1) continue;
                int oa=y*strideA+x*4, ob=y*strideB+x*4;
                int lumaA=(int)Math.Round(0.299*bytesA[oa+2]+0.587*bytesA[oa+1]+0.114*bytesA[oa]);
                int lumaB=(int)Math.Round(0.299*bytesB[ob+2]+0.587*bytesB[ob+1]+0.114*bytesB[ob]);
                ring++; sumA+=lumaA; sumB+=lumaB;
                int delta=Math.Abs(lumaA-lumaB); sumDelta+=delta;
                if(delta>=changeThreshold) changed++;
                if(Math.Abs(lumaA-expectedA)<=tolerance) matchA++;
                if(Math.Abs(lumaB-expectedB)<=tolerance) matchB++;
            }
        }
        stats.RingPixels=ring; stats.ChangedPixels=changed;
        stats.ChangedRatio=ring>0?Math.Round((double)changed/ring,4):0;
        stats.MeanLumaA=ring>0?Math.Round((double)sumA/ring,2):-1;
        stats.MeanLumaB=ring>0?Math.Round((double)sumB/ring,2):-1;
        stats.MeanAbsDelta=ring>0?Math.Round((double)sumDelta/ring,2):-1;
        stats.MatchAPixels=matchA; stats.MatchBPixels=matchB;
        stats.MatchARatio=ring>0?Math.Round((double)matchA/ring,4):0;
        stats.MatchBRatio=ring>0?Math.Round((double)matchB/ring,4):0;
        return stats;
    }

    public sealed class WindowInfo {
        public long Hwnd {get;set;} public uint Pid {get;set;}
        public string ClassName {get;set;} public string Title {get;set;}
        public bool Visible {get;set;} public bool Topmost {get;set;} public bool Layered {get;set;}
        public int ExStyle {get;set;}
        public int X {get;set;} public int Y {get;set;} public int Width {get;set;} public int Height {get;set;}
    }

    public static WindowInfo[] TopLevelWindows() {
        List<WindowInfo> list=new List<WindowInfo>();
        EnumWindows(delegate(IntPtr window,IntPtr data) {
            WindowInfo info=new WindowInfo();
            RECT rect; GetWindowRect(window,out rect);
            StringBuilder title=new StringBuilder(512); GetWindowText(window,title,512);
            StringBuilder className=new StringBuilder(512); GetClassName(window,className,512);
            uint pid; GetWindowThreadProcessId(window,out pid);
            int style=GetWindowLong(window,-20);
            info.Hwnd=window.ToInt64(); info.Pid=pid; info.Title=title.ToString(); info.ClassName=className.ToString();
            info.Visible=IsWindowVisible(window); info.Topmost=(style&0x00000008)!=0; info.Layered=(style&0x00080000)!=0;
            info.ExStyle=style;
            info.X=rect.Left; info.Y=rect.Top; info.Width=rect.Right-rect.Left; info.Height=rect.Bottom-rect.Top;
            list.Add(info);
            return true;
        },IntPtr.Zero);
        return list.ToArray();
    }
}
'@
Add-Type -TypeDefinition $petRenderProbeSource -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll')
[void][PetRenderProbe]::SetProcessDpiAwarenessContext([IntPtr](-4))
$script:ProbePid=$PID
$script:Clock=[Diagnostics.Stopwatch]::StartNew()

function ConvertTo-Rect([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $parts=$Text.Split(',')
    if ($parts.Count -ne 4) { throw ('Rectangle must be x,y,width,height: ' + $Text) }
    return @{ x=[int]$parts[0]; y=[int]$parts[1]; width=[int]$parts[2]; height=[int]$parts[3] }
}

function Format-Rect([hashtable]$Rect) {
    return ('' + $Rect.x + ',' + $Rect.y + ',' + $Rect.width + ',' + $Rect.height)
}

function Get-WindowRectOf([long]$Handle) {
    $rect=New-Object PetRenderProbe+RECT
    if (-not [PetRenderProbe]::GetWindowRect([IntPtr]$Handle,[ref]$rect)) { throw ('GetWindowRect failed for ' + $Handle) }
    return @{ x=$rect.Left; y=$rect.Top; width=($rect.Right-$rect.Left); height=($rect.Bottom-$rect.Top) }
}

function Get-PaintRect([string]$Text,[hashtable]$Window) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $paint=ConvertTo-Rect $Text
    if ($paint.x -lt 0 -or $paint.y -lt 0 -or ($paint.x+$paint.width) -gt $Window.width -or ($paint.y+$paint.height) -gt $Window.height) {
        throw ('Paint rectangle is not inside the window rectangle: ' + $Text + ' in ' + (Format-Rect $Window))
    }
    return $paint
}

function Get-CoveringRect([hashtable]$Window,[int]$Pad) {
    $virtualX=[PetRenderProbe]::VirtualScreenX(); $virtualY=[PetRenderProbe]::VirtualScreenY()
    $virtualWidth=[PetRenderProbe]::VirtualScreenWidth(); $virtualHeight=[PetRenderProbe]::VirtualScreenHeight()
    $left=[Math]::Max($virtualX,$Window.x-$Pad); $top=[Math]::Max($virtualY,$Window.y-$Pad)
    $right=[Math]::Min($virtualX+$virtualWidth,$Window.x+$Window.width+$Pad)
    $bottom=[Math]::Min($virtualY+$virtualHeight,$Window.y+$Window.height+$Pad)
    if ($left -gt $Window.x -or $top -gt $Window.y -or $right -lt ($Window.x+$Window.width) -or $bottom -lt ($Window.y+$Window.height)) {
        throw ('Background window cannot cover the pet rectangle on a ' + $virtualWidth + 'x' + $virtualHeight + ' virtual screen: ' + (Format-Rect $Window))
    }
    return @{ x=$left; y=$top; width=($right-$left); height=($bottom-$top) }
}

function New-ScreenFrame([hashtable]$Rect) {
    $bitmap=New-Object Drawing.Bitmap -ArgumentList @([int]$Rect.width,[int]$Rect.height)
    $graphics=[Drawing.Graphics]::FromImage($bitmap)
    try { $graphics.CopyFromScreen([int]$Rect.x,[int]$Rect.y,0,0,$bitmap.Size) } finally { $graphics.Dispose() }
    return $bitmap
}

function Save-Png([Drawing.Bitmap]$Bitmap,[string]$File) {
    $Bitmap.Save($File,[Drawing.Imaging.ImageFormat]::Png)
}

function Get-FrameRecord([long]$Handle,[hashtable]$Window,[hashtable]$Paint,[int]$Index,[string]$File,[long]$StartMs=0) {
    [void][PetRenderProbe]::RaiseTopmost([IntPtr]$Handle)
    $hitX=$Window.x+[int]($Window.width/2); $hitY=$Window.y+[int]($Window.height/2)
    if ($Paint -ne $null) { $hitX=$Window.x+$Paint.x+[int]($Paint.width/2); $hitY=$Window.y+$Paint.y+[int]($Paint.height/2) }
    $hit=[PetRenderProbe]::HitTest($hitX,$hitY)
    $paintX=0; $paintY=0; $paintWidth=0; $paintHeight=0
    if ($Paint -ne $null) { $paintX=$Paint.x; $paintY=$Paint.y; $paintWidth=$Paint.width; $paintHeight=$Paint.height }
    $bitmap=New-ScreenFrame $Window
    try {
        $stats=[PetRenderProbe]::Analyze($bitmap,$paintX,$paintY,$paintWidth,$paintHeight)
        Save-Png $bitmap $File
    } finally { $bitmap.Dispose() }
    $pureRatio=0; if ($stats.Pixels -gt 0) { $pureRatio=[Math]::Round($stats.Pure255/$stats.Pixels,4) }
    $insidePureRatio=0; if ($stats.InsidePixels -gt 0) { $insidePureRatio=[Math]::Round($stats.InsidePure255/$stats.InsidePixels,4) }
    return @{
        index=$Index; file=(Split-Path -Leaf $File); startMs=$StartMs; atMs=$script:Clock.ElapsedMilliseconds;
        capturedAtUtc=(Get-Date).ToUniversalTime().ToString('o');
        width=$stats.Width; height=$stats.Height; pixels=$stats.Pixels; pixelFormat=$stats.PixelFormat;
        lumaMin=$stats.Min; lumaMax=$stats.Max; distinct=$stats.Distinct; modal=$stats.Modal; blockRatio=$stats.BlockRatio;
        meanLuma=$stats.MeanLuma; white250=$stats.White250; dark60=$stats.Dark60; light200=$stats.Light200;
        pure255=$stats.Pure255; pure255Ratio=$pureRatio;
        corners=@($stats.Corner0,$stats.Corner1,$stats.Corner2,$stats.Corner3); center=$stats.Center;
        sha256=$stats.Sha256;
        inside=@{
            pixels=$stats.InsidePixels; lumaMin=$stats.InsideMin; lumaMax=$stats.InsideMax; distinct=$stats.InsideDistinct;
            meanLuma=$stats.InsideMeanLuma; white250=$stats.InsideWhite250; dark60=$stats.InsideDark60; light200=$stats.InsideLight200;
            pure255=$stats.InsidePure255; pure255Ratio=$insidePureRatio
        };
        uniformBlock=([bool]($stats.Distinct -eq 1 -or $stats.BlockRatio -ge 0.999));
        content=([bool]($stats.Distinct -gt 1 -and $stats.Dark60 -gt 0 -and $stats.Light200 -gt 0));
        spriteContent=([bool]($stats.InsideDistinct -gt 1 -and $stats.InsideDark60 -gt 0 -and $stats.InsideLight200 -gt 0));
        hitAtPaintCentre=$hit; hitIsOurHandle=([bool]($hit -eq $Handle))
    }
}

function Write-ProbeResult($Value) {
    Write-Output ($Value | ConvertTo-Json -Depth 8 -Compress)
}

try {
    if ($Action -eq 'environment') {
        $petProcesses=@()
        foreach ($process in @(Get-Process -Name newmark-desktop-pet -ErrorAction SilentlyContinue)) {
            $path=''
            try { $path=$process.Path } catch { $path='' }
            $petProcesses+=@{ id=$process.Id; startTime=$process.StartTime.ToUniversalTime().ToString('o'); path=$path }
        }
        Write-ProbeResult @{
            ok=$true; action='environment'; probePid=$script:ProbePid;
            probeHost=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName;
            powerShell=$PSVersionTable.PSVersion.ToString();
            dpi=[PetRenderProbe]::GetDpiForSystem();
            screen=@{ x=0; y=0; width=[PetRenderProbe]::GetSystemMetrics(0); height=[PetRenderProbe]::GetSystemMetrics(1) };
            virtualScreen=@{ x=[PetRenderProbe]::VirtualScreenX(); y=[PetRenderProbe]::VirtualScreenY(); width=[PetRenderProbe]::VirtualScreenWidth(); height=[PetRenderProbe]::VirtualScreenHeight() };
            cursor=@{ x=[PetRenderProbe]::CursorX(); y=[PetRenderProbe]::CursorY() };
            workArea=[PetRenderProbe]::WorkArea();
            foreground=[PetRenderProbe]::Foreground();
            windows=[PetRenderProbe]::TopLevelWindows();
            petProcesses=$petProcesses
        }
        exit 0
    }

    if ($Action -eq 'move') {
        if ($HandleValue -eq 0) { throw 'move requires -HandleValue' }
        if (-not [PetRenderProbe]::IsWindow([IntPtr]$HandleValue)) { throw ('Not a window: ' + $HandleValue) }
        $before=Get-WindowRectOf $HandleValue
        $moved=[PetRenderProbe]::MoveNoActivate([IntPtr]$HandleValue,$TargetX,$TargetY)
        Start-Sleep -Milliseconds 300
        $after=Get-WindowRectOf $HandleValue
        Write-ProbeResult @{
            ok=$true; action='move'; hwnd=$HandleValue; moved=$moved;
            before=$before;
            requested=@{ x=$TargetX; y=$TargetY; width=$before.width; height=$before.height };
            after=$after;
            afterMatchesRequest=([bool]($after.x -eq $TargetX -and $after.y -eq $TargetY))
        }
        exit 0
    }

    if ($Action -eq 'frames') {
        if ($HandleValue -eq 0) { throw 'frames requires -HandleValue' }
        $window=Get-WindowRectOf $HandleValue
        $paint=Get-PaintRect $PaintBounds $window
        $status=ConvertTo-Rect $StatusBounds
        $backgroundInfo=$null
        if ($BackgroundLuma -gt 0) {
            $cover=Get-CoveringRect $window $PadPx
            $backgroundInfo=[PetRenderProbe]::CreateBackgroundWindow($cover.x,$cover.y,$cover.width,$cover.height,$BackgroundLuma)
            if ($backgroundInfo.Error -ne '') { throw ('Background window failed: ' + $backgroundInfo.Error) }
            Start-Sleep -Milliseconds 250
        }
        # Warm the GDI+ capture path and the C# analyser first, so the first real
        # frame does not cost more than the interval and skew the burst.
        $warm=New-ScreenFrame $window
        try { [void][PetRenderProbe]::Analyze($warm,0,0,0,0) } finally { $warm.Dispose() }
        $frames=@()
        $frameMark=$script:Clock.ElapsedMilliseconds
        try {
            for ($index=0; $index -lt $Count; $index++) {
                if ($index -gt 0 -and $IntervalMs -gt 0) {
                    # Spacing is capture start to capture start, so the burst really
                    # is -IntervalMs apart and does not drift by the capture cost.
                    $wait=$IntervalMs-($script:Clock.ElapsedMilliseconds-$frameMark)
                    if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
                }
                $frameMark=$script:Clock.ElapsedMilliseconds
                $file=Join-Path $EvidenceDirectory ($Prefix + '-' + $index + '.png')
                $record=Get-FrameRecord $HandleValue $window $paint $index $file $frameMark
                if ($frames.Count -gt 0) {
                    # start-to-start is the burst spacing; atMs is when the capture
                    # finished (it includes the PNG write) and is kept as measured too.
                    $record['sincePreviousMs']=$record['atMs']-$frames[$frames.Count-1]['atMs']
                    $record['sincePreviousStartMs']=$record['startMs']-$frames[$frames.Count-1]['startMs']
                }
                $frames+=$record
            }
        } finally {
            if ($backgroundInfo -ne $null) { [void][PetRenderProbe]::DestroyBackgroundWindow($backgroundInfo.Handle) }
        }
        $boundsDelta=$null
        if ($status -ne $null) {
            $boundsDelta=@{ x=($window.x-$status.x); y=($window.y-$status.y); width=($window.width-$status.width); height=($window.height-$status.height) }
        }
        $background=$null
        if ($backgroundInfo -ne $null) {
            $background=@{ handle=$backgroundInfo.Handle; luma=$backgroundInfo.Luma; x=$backgroundInfo.X; y=$backgroundInfo.Y; width=$backgroundInfo.Width; height=$backgroundInfo.Height; visible=$backgroundInfo.Visible }
        }
        Write-ProbeResult @{
            ok=$true; action='frames'; probePid=$script:ProbePid; hwnd=$HandleValue;
            window=$window; paintBounds=$paint; statusBounds=$status; boundsDelta=$boundsDelta;
            background=$background; count=$Count; intervalMs=$IntervalMs; frameCount=$frames.Count; frames=$frames
        }
        exit 0
    }

    if ($Action -eq 'ring') {
        if ($HandleValue -eq 0) { throw 'ring requires -HandleValue' }
        if ([string]::IsNullOrWhiteSpace($PaintBounds)) { throw 'ring requires -PaintBounds' }
        $window=Get-WindowRectOf $HandleValue
        $paint=Get-PaintRect $PaintBounds $window
        $status=ConvertTo-Rect $StatusBounds
        $cover=Get-CoveringRect $window $PadPx
        $backgroundInfo=[PetRenderProbe]::CreateBackgroundWindow($cover.x,$cover.y,$cover.width,$cover.height,$BackgroundLumaDark)
        if ($backgroundInfo.Error -ne '') { throw ('Background window failed: ' + $backgroundInfo.Error) }
        try {
            Start-Sleep -Milliseconds 250
            $fileDark=Join-Path $EvidenceDirectory ($Prefix + '-dark.png')
            $frameDark=Get-FrameRecord $HandleValue $window $paint 0 $fileDark
            $painted=[PetRenderProbe]::PaintBackgroundWindow($backgroundInfo.Handle,$BackgroundLumaLight)
            if ($painted.Error -ne '') { throw ('Background repaint failed: ' + $painted.Error) }
            Start-Sleep -Milliseconds 250
            $fileLight=Join-Path $EvidenceDirectory ($Prefix + '-light.png')
            $frameLight=Get-FrameRecord $HandleValue $window $paint 1 $fileLight
            $bitmapDark=[Drawing.Bitmap]::FromFile($fileDark)
            $bitmapLight=[Drawing.Bitmap]::FromFile($fileLight)
            try {
                $diff=[PetRenderProbe]::CompareRing($bitmapDark,$bitmapLight,$paint.x,$paint.y,$paint.width,$paint.height,$RingInset,$ChangeThreshold,$BackgroundLumaDark,$BackgroundLumaLight,$ColorTolerance)
            } finally { $bitmapDark.Dispose(); $bitmapLight.Dispose() }
        } finally { [void][PetRenderProbe]::DestroyBackgroundWindow($backgroundInfo.Handle) }
        $boundsDelta=$null
        if ($status -ne $null) {
            $boundsDelta=@{ x=($window.x-$status.x); y=($window.y-$status.y); width=($window.width-$status.width); height=($window.height-$status.height) }
        }
        Write-ProbeResult @{
            ok=$true; action='ring'; hwnd=$HandleValue; window=$window; paintBounds=$paint; statusBounds=$status; boundsDelta=$boundsDelta;
            ringInset=$RingInset; changeThreshold=$ChangeThreshold; colorTolerance=$ColorTolerance;
            backgroundWindow=@{ handle=$backgroundInfo.Handle; darkLuma=$BackgroundLumaDark; lightLuma=$BackgroundLumaLight; x=$cover.x; y=$cover.y; width=$cover.width; height=$cover.height };
            frameDark=$frameDark; frameLight=$frameLight;
            ring=@{
                pixels=$diff.RingPixels; changedPixels=$diff.ChangedPixels; changedRatio=$diff.ChangedRatio;
                meanLumaDark=$diff.MeanLumaA; meanLumaLight=$diff.MeanLumaB; meanAbsDelta=$diff.MeanAbsDelta;
                matchDarkPixels=$diff.MatchAPixels; matchLightPixels=$diff.MatchBPixels;
                matchDarkRatio=$diff.MatchARatio; matchLightRatio=$diff.MatchBRatio
            }
        }
        exit 0
    }

    if ($Action -eq 'inject-watch') {
        if ($HandleValue -eq 0) { throw 'inject-watch requires -HandleValue' }
        $window=Get-WindowRectOf $HandleValue
        $paint=Get-PaintRect $PaintBounds $window
        $injectMark=$script:Clock.ElapsedMilliseconds
        $injectError=[PetRenderProbe]::InjectOpaqueWhite([IntPtr]$HandleValue,$window.x,$window.y,$window.width,$window.height)
        $injected=([bool]($injectError -eq ''))
        $injectedObserved=$false
        $injectedObservedAtMs=-1
        $healed=$false
        $healMs=-1
        $healFromCaptureStartMs=-1
        $contentFrame=$null
        $lateContentAtMs=-1
        $polls=@()
        while ($true) {
            $index=$polls.Count
            # The window is bounded on the moment a capture STARTS, so content seen
            # here was really on the screen inside -TimeoutMs of the injection.
            $pollStart=$script:Clock.ElapsedMilliseconds
            if ($index -gt 0 -and ($pollStart-$injectMark) -ge $TimeoutMs) { break }
            $file=Join-Path $EvidenceDirectory ($Prefix + '-poll-' + $index.ToString('00') + '.png')
            $record=Get-FrameRecord $HandleValue $window $paint $index $file $pollStart
            $record['sinceInjectionMs']=$record['atMs']-$injectMark
            $record['sinceInjectionStartMs']=$record['startMs']-$injectMark
            if ($polls.Count -gt 0) { $record['sincePreviousStartMs']=$record['startMs']-$polls[$polls.Count-1]['startMs'] }
            $polls+=$record
            if ($record['uniformBlock'] -and $record['white250'] -eq $record['pixels']) {
                $injectedObserved=$true
                if ($injectedObservedAtMs -lt 0) { $injectedObservedAtMs=$record['sinceInjectionMs'] }
            }
            if ($record['content']) {
                $contentFrame=$record
                if ($record['sinceInjectionStartMs'] -le $TimeoutMs) {
                    $healed=$true; $healMs=$record['sinceInjectionMs']; $healFromCaptureStartMs=$record['sinceInjectionStartMs'];
                } else {
                    $lateContentAtMs=$record['sinceInjectionStartMs'];
                }
                break
            }
            if ($polls.Count -ge 200) { break }
            Start-Sleep -Milliseconds $PollMs
        }
        Write-ProbeResult @{
            ok=$true; action='inject-watch'; hwnd=$HandleValue; window=$window; paintBounds=$paint;
            timeoutMs=$TimeoutMs; pollMs=$PollMs;
            injection=@{ ok=$injected; error=$injectError; white=255; rect=$window; injectedAtMs=$injectMark };
            injectedObservedUniformWhite=$injectedObserved; injectedObservedAtMs=$injectedObservedAtMs;
            healed=$healed; healUpperBoundMs=$healMs; healFromCaptureStartMs=$healFromCaptureStartMs; lateContentAtMs=$lateContentAtMs;
            pollCount=$polls.Count; contentFrame=$contentFrame; polls=$polls
        }
        exit 0
    }

    if ($Action -eq 'printwindow') {
        if ($HandleValue -eq 0) { throw 'printwindow requires -HandleValue' }
        $window=Get-WindowRectOf $HandleValue
        $paint=Get-PaintRect $PaintBounds $window
        $bitmap=New-Object Drawing.Bitmap -ArgumentList @([int]$window.width,[int]$window.height,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $printed=$false
        try {
            $graphics=[Drawing.Graphics]::FromImage($bitmap)
            try {
                $hdc=$graphics.GetHdc()
                try { $printed=[PetRenderProbe]::PrintWindow([IntPtr]$HandleValue,$hdc,2) } finally { $graphics.ReleaseHdc($hdc) }
            } finally { $graphics.Dispose() }
            $paintX=0; $paintY=0; $paintWidth=0; $paintHeight=0
            if ($paint -ne $null) { $paintX=$paint.x; $paintY=$paint.y; $paintWidth=$paint.width; $paintHeight=$paint.height }
            $stats=[PetRenderProbe]::Analyze($bitmap,$paintX,$paintY,$paintWidth,$paintHeight)
            $file=Join-Path $EvidenceDirectory ($Prefix + '-printwindow.png')
            Save-Png $bitmap $file
        } finally { $bitmap.Dispose() }
        Write-ProbeResult @{
            ok=$true; action='printwindow'; hwnd=$HandleValue; window=$window; paintBounds=$paint; printed=$printed;
            file=(Split-Path -Leaf $file); width=$stats.Width; height=$stats.Height; pixels=$stats.Pixels;
            lumaMin=$stats.Min; lumaMax=$stats.Max; distinct=$stats.Distinct; modal=$stats.Modal; blockRatio=$stats.BlockRatio;
            meanLuma=$stats.MeanLuma; white250=$stats.White250; dark60=$stats.Dark60; light200=$stats.Light200; sha256=$stats.Sha256;
            hazard='PrintWindow cannot see UpdateLayeredWindow content; evidence only, never a pass criterion.'
        }
        exit 0
    }

    if ($Action -eq 'desktop-under') {
        # The reference half of a pixel-level transparency assertion: hide OUR window, capture the
        # SAME screen rectangle, and record what is actually behind it. A composited corner that
        # equals this record is transparent; an opaque white plate cannot equal it.
        if ($HandleValue -eq 0) { throw 'desktop-under requires -HandleValue' }
        $window=Get-WindowRectOf $HandleValue
        $paint=Get-PaintRect $PaintBounds $window
        # Behind the pet must be the SAME background the burst was captured over, or the
        # reference is a different scene and the comparison is meaningless.
        $cover=Get-CoveringRect $window $PadPx
        $backgroundInfo=[PetRenderProbe]::CreateBackgroundWindow($cover.x,$cover.y,$cover.width,$cover.height,$BackgroundLuma)
        if ($backgroundInfo.Error -ne '') { throw ('Background window failed: ' + $backgroundInfo.Error) }
        Start-Sleep -Milliseconds 250
        [void][PetRenderProbe]::HideWindow([IntPtr]$HandleValue)
        Start-Sleep -Milliseconds 250
        $bitmap=New-ScreenFrame $window
        $shown=[PetRenderProbe]::ShowWindow([IntPtr]$HandleValue,5)
        try {
            $paintX=0; $paintY=0; $paintWidth=0; $paintHeight=0
            if ($paint -ne $null) { $paintX=$paint.x; $paintY=$paint.y; $paintWidth=$paint.width; $paintHeight=$paint.height }
            $stats=[PetRenderProbe]::Analyze($bitmap,$paintX,$paintY,$paintWidth,$paintHeight)
            $file=Join-Path $EvidenceDirectory ($Prefix + '-desktop-under.png')
            Save-Png $bitmap $file
        } finally { $bitmap.Dispose(); if ($backgroundInfo -ne $null) { [void][PetRenderProbe]::DestroyBackgroundWindow($backgroundInfo.Handle) } }
        Write-ProbeResult @{
            ok=$true; action='desktop-under'; hwnd=$HandleValue; window=$window; paintBounds=$paint; reshown=$shown;
            backgroundLuma=$BackgroundLuma; background=@{ handle=$backgroundInfo.Handle; luma=$backgroundInfo.Luma; x=$backgroundInfo.X; y=$backgroundInfo.Y; width=$backgroundInfo.Width; height=$backgroundInfo.Height; visible=$backgroundInfo.Visible };
            file=(Split-Path -Leaf $file); width=$stats.Width; height=$stats.Height; pixels=$stats.Pixels;
            lumaMin=$stats.Min; lumaMax=$stats.Max; distinct=$stats.Distinct; meanLuma=$stats.MeanLuma;
            pure255=$stats.Pure255; white250=$stats.White250;
            corners=@($stats.Corner0,$stats.Corner1,$stats.Corner2,$stats.Corner3); center=$stats.Center;
            sha256=$stats.Sha256;
            note='captured with our window hidden: this is the desktop the pet is composited over'
        }
        exit 0
    }

    if ($Action -eq 'selftest') {
        $rect=@{ x=8; y=8; width=64; height=48 }
        $info=[PetRenderProbe]::CreateBackgroundWindow($rect.x,$rect.y,$rect.width,$rect.height,$SelfTestLuma)
        if ($info.Error -ne '') { throw ('Background window failed: ' + $info.Error) }
        $stats=$null
        try {
            Start-Sleep -Milliseconds 300
            $bitmap=New-ScreenFrame $rect
            try { $stats=[PetRenderProbe]::Analyze($bitmap,0,0,0,0) } finally { $bitmap.Dispose() }
        } finally { [void][PetRenderProbe]::DestroyBackgroundWindow($info.Handle) }
        $matches=([bool]($stats.Min -eq $SelfTestLuma -and $stats.Max -eq $SelfTestLuma))
        Write-ProbeResult @{
            ok=$matches; action='selftest'; paintedLuma=$SelfTestLuma; rect=$rect;
            lumaMin=$stats.Min; lumaMax=$stats.Max; meanLuma=$stats.MeanLuma; distinct=$stats.Distinct;
            matches=$matches; note='proves the UpdateLayeredWindow background window paints the composited screen'
        }
        exit 0
    }

    throw ('Unknown action: ' + $Action)
} catch {
    Write-ProbeResult @{
        ok=$false; action=$Action; error=$_.Exception.Message;
        stack=$_.ScriptStackTrace; atUtc=(Get-Date).ToUniversalTime().ToString('o')
    }
    exit 1
}
