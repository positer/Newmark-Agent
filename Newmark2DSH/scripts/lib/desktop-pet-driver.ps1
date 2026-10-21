param([string]$Action='probe',[long]$HandleValue=0,[int]$X=0,[int]$Y=0,[int]$Dx=0,[int]$Dy=0,[string]$OutputPath='')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PetDriver {
 [StructLayout(LayoutKind.Sequential)] public struct R { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct P { public int X,Y; }
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr w,out R r);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr w);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr w,int n);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(P p);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
 [DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e);
}
'@
[void][PetDriver]::SetProcessDpiAwarenessContext([IntPtr](-4))
$hwnd=[IntPtr]$HandleValue
$r=New-Object PetDriver+R
$exists=[PetDriver]::IsWindow($hwnd)
if ($Action -ne 'alive' -and -not $exists) { throw "Fixture target window is absent: $HandleValue" }
[void][PetDriver]::GetWindowRect($hwnd,[ref]$r)
$old=New-Object PetDriver+P
[void][PetDriver]::GetCursorPos([ref]$old)
if ($Action -eq 'click' -or $Action -eq 'drag') {
    $p=New-Object PetDriver+P; $p.X=$r.Left+$X; $p.Y=$r.Top+$Y
    if ([PetDriver]::WindowFromPoint($p) -ne $hwnd) { throw 'Input target is occluded; refusing physical mouse input.' }
    [void][PetDriver]::SetCursorPos($p.X,$p.Y)
    [PetDriver]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
    try {
        if ($Action -eq 'drag') { for($i=1;$i -le 12;$i++) { [void][PetDriver]::SetCursorPos($p.X+[int]($Dx*$i/12),$p.Y+[int]($Dy*$i/12)); Start-Sleep -Milliseconds 25 } }
        else { Start-Sleep -Milliseconds 60 }
    } finally { Start-Sleep -Milliseconds 100; [PetDriver]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
    Start-Sleep -Milliseconds 100
    [void][PetDriver]::SetCursorPos($old.X,$old.Y)
}
if ($Action -eq 'escape' -or $Action -eq 'key') {
    if ([PetDriver]::GetForegroundWindow() -ne $hwnd) { throw 'Viewer is not foreground; refusing keyboard input.' }
    $vk=if($Action -eq 'escape') { 27 } else { 65 }
    [PetDriver]::keybd_event($vk,0,0,[UIntPtr]::Zero)
    [PetDriver]::keybd_event($vk,0,2,[UIntPtr]::Zero)
}
if ($Action -eq 'capture') {
    $bmp=New-Object Drawing.Bitmap ($r.Right-$r.Left),($r.Bottom-$r.Top)
    $g=[Drawing.Graphics]::FromImage($bmp)
    try { $g.CopyFromScreen($r.Left,$r.Top,0,0,$bmp.Size); $bmp.Save($OutputPath,[Drawing.Imaging.ImageFormat]::Png) } finally { $g.Dispose(); $bmp.Dispose() }
}
$corner=New-Object PetDriver+P; $corner.X=$r.Left; $corner.Y=$r.Top
$monitor=[Windows.Forms.Screen]::FromHandle($hwnd).Bounds
@{exists=$exists;hwnd=$HandleValue;style=[PetDriver]::GetWindowLong($hwnd,-20);bounds=@{x=$r.Left;y=$r.Top;width=($r.Right-$r.Left);height=($r.Bottom-$r.Top)};corner_hit=[PetDriver]::WindowFromPoint($corner).ToInt64();foreground=[PetDriver]::GetForegroundWindow().ToInt64();monitor=@{x=$monitor.X;y=$monitor.Y;width=$monitor.Width;height=$monitor.Height}} | ConvertTo-Json -Depth 4 -Compress
