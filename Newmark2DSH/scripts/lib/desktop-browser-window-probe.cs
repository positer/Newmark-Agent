using System;using System.Drawing;using System.Drawing.Imaging;using System.Runtime.InteropServices;using System.Text;using System.Windows.Forms;
internal static class BrowserWindowProbe {
 [DllImport("user32.dll")]static extern bool EnumWindows(EnumProc cb,IntPtr p);delegate bool EnumProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")]static extern bool GetClientRect(IntPtr h,out Rect r);struct Rect{public int l,t,r,b;}
 [DllImport("user32.dll")]static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
 [DllImport("user32.dll")]static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int hh,uint flags);
 [DllImport("user32.dll",EntryPoint="SetWindowLongPtrW")]static extern IntPtr SetWindowLongPtr(IntPtr h,int index,IntPtr value);
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")]static extern IntPtr GetWindowLongPtr(IntPtr h,int index);
 [DllImport("user32.dll")]static extern bool SetLayeredWindowAttributes(IntPtr h,uint key,byte alpha,uint flags);
 [DllImport("user32.dll")]static extern bool GetLayeredWindowAttributes(IntPtr h,out uint key,out byte alpha,out uint flags);
 [DllImport("user32.dll")]static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern bool PostMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
 [DllImport("user32.dll")]static extern IntPtr SetProcessDpiAwarenessContext(IntPtr c);
 [DllImport("dwmapi.dll")]static extern int DwmSetWindowAttribute(IntPtr h,int a,ref int v,int n);
 [DllImport("gdi32.dll")]static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
 [DllImport("user32.dll")]static extern int SetWindowRgn(IntPtr h,IntPtr r,bool redraw);
 static void Capture(IntPtr h,string file){Rect r;GetClientRect(h,out r);using(var b=new Bitmap(r.r,r.b,PixelFormat.Format32bppArgb)){using(var g=Graphics.FromImage(b)){var dc=g.GetHdc();try{if(!PrintWindow(h,dc,3))throw new Exception("PrintWindow failed");}finally{g.ReleaseHdc(dc);}}b.Save(file,ImageFormat.Png);}}
 [STAThread]static void Main(string[] args){SetProcessDpiAwarenessContext(new IntPtr(-4));
  if(args[0]=="find"){EnumWindows(delegate(IntPtr h,IntPtr p){var s=new StringBuilder(512);GetWindowText(h,s,512);if(s.ToString().StartsWith(args.Length>1?args[1]:"Browser Live QA")){uint pid;GetWindowThreadProcessId(h,out pid);Console.WriteLine("{\"hwnd\":\"0x"+h.ToInt64().ToString("x")+"\",\"pid\":"+pid+",\"style\":"+GetWindowLongPtr(h,-20).ToInt64()+"}");return false;}return true;},IntPtr.Zero);return;}
  if(args[0]=="pixel"){using(var image=new Bitmap(args[1]))Console.WriteLine(image.GetPixel(int.Parse(args[2]),int.Parse(args[3])).ToArgb().ToString("x"));return;}
  if(args[0]=="convert"){using(var image=new Bitmap(args[1]))image.Save(args[2],ImageFormat.Png);return;}
  IntPtr hwnd=new IntPtr(Convert.ToInt64(args[1].Substring(2),16));
  if(args[0]=="state"){Rect r;GetWindowRect(hwnd,out r);uint key,flags;byte alpha;bool layered=GetLayeredWindowAttributes(hwnd,out key,out alpha,out flags);Console.WriteLine("{\"style\":"+GetWindowLongPtr(hwnd,-20).ToInt64()+",\"alphaValid\":"+(layered?"true":"false")+",\"alpha\":"+alpha+",\"foreground\":"+GetForegroundWindow().ToInt64()+",\"hwnd\":"+hwnd.ToInt64()+",\"hit\":"+GetAncestor(WindowFromPoint(new Point(r.l+100,r.t+250)),2).ToInt64()+"}");}
  if(args[0]=="capture")Capture(hwnd,args[2]);
  if(args[0]=="toggle"){Rect r;GetClientRect(hwnd,out r);var lp=new IntPtr(((r.b/2)<<16)|(r.r/2));PostMessage(hwnd,0x201,new IntPtr(1),lp);PostMessage(hwnd,0x202,IntPtr.Zero,lp);}
  if(args[0]=="park")SetWindowPos(hwnd,IntPtr.Zero,-16000,-16000,0,0,0x15);
  if(args[0]=="cloak"){SetWindowLongPtr(hwnd,-20,new IntPtr(long.Parse(args[2])));SetWindowPos(hwnd,new IntPtr(-1),100,100,0,0,0x31);int yes=1;DwmSetWindowAttribute(hwnd,13,ref yes,4);}
  if(args[0]=="region"){int no=0;DwmSetWindowAttribute(hwnd,13,ref no,4);SetWindowLongPtr(hwnd,-20,new IntPtr(long.Parse(args[2])));SetWindowPos(hwnd,new IntPtr(-1),100,100,0,0,0x31);SetWindowRgn(hwnd,CreateRectRgn(0,0,0,0),true);}
  if(args[0].StartsWith("transparent")){long style=GetWindowLongPtr(hwnd,-20).ToInt64()|0x80000|0x20|0x80;style=args[0]=="transparent-noactivate"?style|0x8000000:style&~0x8000000;SetWindowLongPtr(hwnd,-20,new IntPtr(style));SetLayeredWindowAttributes(hwnd,0,0,2);SetWindowPos(hwnd,new IntPtr(-1),100,100,0,0,0x31);}
  if(args[0]=="restore"){int no=0;DwmSetWindowAttribute(hwnd,13,ref no,4);SetWindowRgn(hwnd,IntPtr.Zero,true);SetWindowLongPtr(hwnd,-20,new IntPtr(long.Parse(args[2])));SetWindowPos(hwnd,new IntPtr(-2),100,100,0,0,0x31);}
  if(args[0]=="close")PostMessage(hwnd,0x10,IntPtr.Zero,IntPtr.Zero);
 }
}
