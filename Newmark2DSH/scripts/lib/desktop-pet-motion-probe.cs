// End-to-end motion recorder. Sends physical input only to the pet process it starts.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

internal static class MotionProbe {
    sealed class Backdrop : Form {
        internal Backdrop(Rectangle bounds) {FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;StartPosition=FormStartPosition.Manual;Bounds=bounds;BackColor=Color.FromArgb(41,46,54);}
        protected override bool ShowWithoutActivation {get{return true;}}
        protected override void OnPaint(PaintEventArgs e) {base.OnPaint(e);using(var font=new Font("Microsoft YaHei UI",24))e.Graphics.DrawString("NewMate · 动效实机验收",font,Brushes.LightGray,60,70);}
    }
    [StructLayout(LayoutKind.Sequential)] struct R { public int Left,Top,Right,Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct P { public int X,Y; public P(int x,int y){X=x;Y=y;} }
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr w,out R r);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr w);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(P p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr w,out uint pid);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out P p);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
    static readonly JavaScriptSerializer json=new JavaScriptSerializer();
    static readonly List<object> checks=new List<object>();
    static readonly Dictionary<string,List<Dictionary<string,object>>> recordings=new Dictionary<string,List<Dictionary<string,object>>>();
    static string output, directory;
    static Process pet;
    static int failures;
    static Rectangle screen;
    static Dictionary<string,object> State() {
        for(int i=0;i<10;i++) { try {return json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(directory,"status.json")));} catch(IOException){Thread.Sleep(5);} }
        throw new IOException("Pet status unavailable");
    }
    static double N(Dictionary<string,object> state,string key) { return Convert.ToDouble(state[key]); }
    static void Check(string name,bool ok,object detail) {checks.Add(new{name=name,ok=ok,detail=detail});Console.WriteLine((ok?"PASS ":"FAIL ")+name);if(!ok)failures++;}
    static object Rect(IntPtr w) {R r; if(!GetWindowRect(w,out r))return null;return new{x=r.Left,y=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top};}
    static void Capture(string file) {
        using(var full=new Bitmap(screen.Width,screen.Height))
        using(var g=Graphics.FromImage(full)) {
            g.CopyFromScreen(screen.Location,Point.Empty,screen.Size);
            using(var small=new Bitmap(800,(int)Math.Round(screen.Height*800.0/screen.Width)))
            using(var sg=Graphics.FromImage(small)) {sg.DrawImage(full,new Rectangle(Point.Empty,small.Size));small.Save(file,ImageFormat.Png);}
        }
    }
    static List<Dictionary<string,object>> Record(string name,int duration) {
        var frames=new List<Dictionary<string,object>>();
        string dir=Path.Combine(output,name);Directory.CreateDirectory(dir);
        var clock=Stopwatch.StartNew();long nextCapture=0;
        Thread captureThread=null;Exception captureError=null;
        while(clock.ElapsedMilliseconds<duration) {
            Application.DoEvents();
            var state=State();long hwnd=(long)N(state,"hwnd"), viewer=(long)N(state,"viewer_hwnd");
            state["sample_ms"]=clock.ElapsedMilliseconds;
            state["native_pet_exists"]=IsWindow(new IntPtr(hwnd));
            state["native_viewer_rect"]=Rect(new IntPtr(viewer));
            if(clock.ElapsedMilliseconds>=nextCapture && (captureThread==null || !captureThread.IsAlive)) {
                string file=frames.Count.ToString("D3")+".png";
                // Screen capture must not block native-state sampling and miss
                // the short spring overshoot on slower desktop compositors.
                captureThread=new Thread(delegate(){try{Capture(Path.Combine(dir,file));}catch(Exception ex){captureError=ex;}});
                captureThread.Start();state["screenshot"]=name+"/"+file;nextCapture=clock.ElapsedMilliseconds+100;
            }
            frames.Add(state);Thread.Sleep(12);
        }
        if(captureThread!=null)captureThread.Join();if(captureError!=null)throw captureError;
        recordings[name]=frames;return frames;
    }
    static void MoveToPet() {
        var state=State();R r;var hwnd=new IntPtr((long)N(state,"hwnd"));GetWindowRect(hwnd,out r);
        P p=new P((r.Left+r.Right)/2,(r.Top+r.Bottom)/2);
        if(WindowFromPoint(p)!=hwnd)throw new InvalidOperationException("Pet input target occluded");
        SetCursorPos(p.X,p.Y);
    }
    static void Down() {MoveToPet();mouse_event(2,0,0,0,UIntPtr.Zero);}
    static void Up() {mouse_event(4,0,0,0,UIntPtr.Zero);}
    static void Click() {Down();Thread.Sleep(75);Up();}
    static void Menu() {
        MoveToPet();mouse_event(8,0,0,0,UIntPtr.Zero);Thread.Sleep(65);mouse_event(16,0,0,0,UIntPtr.Zero);
        Wait(delegate {return N(State(),"menu_hwnd")!=0;},3000);
        Thread.Sleep(150);
    }
    static void SelectScale(string name) {
        var hwnd=new IntPtr((long)N(State(),"menu_hwnd"));
        var root=AutomationElement.FromHandle(hwnd);
        var item=root.FindFirst(TreeScope.Descendants,new PropertyCondition(AutomationElement.NameProperty,name));
        if(item==null)throw new InvalidOperationException("Native menu item missing: "+name);
        var rect=item.Current.BoundingRectangle;P p=new P((int)(rect.X+rect.Width/2),(int)(rect.Y+rect.Height/2));
        uint pid;GetWindowThreadProcessId(WindowFromPoint(p),out pid);
        if(pid!=pet.Id)throw new InvalidOperationException("Menu input target is not our pet process");
        SetCursorPos(p.X,p.Y);mouse_event(2,0,0,0,UIntPtr.Zero);Thread.Sleep(50);mouse_event(4,0,0,0,UIntPtr.Zero);
    }
    static void Wait(Func<bool> condition,int timeout) {var timer=Stopwatch.StartNew();while(timer.ElapsedMilliseconds<timeout){if(condition())return;Thread.Sleep(15);}throw new Exception("Condition timed out");}
    static bool Alive(int pid) {try{using(var p=Process.GetProcessById(pid))return !p.HasExited;}catch{return false;}}
    [STAThread] static int Main(string[] args) {
        SetProcessDpiAwarenessContext(new IntPtr(-4));output=args[3];directory=Path.Combine(output,"native");Directory.CreateDirectory(directory);
        P original;GetCursorPos(out original);
        Backdrop backdrop=null;
        try {
            // Warm up screen discovery and JSON parsing before starting entrance.
            screen=Screen.FromPoint(new Point(original.X,original.Y)).Bounds;
            json.Deserialize<Dictionary<string,object>>("{\"warmup\":1}");
            backdrop=new Backdrop(screen);backdrop.Show();Application.DoEvents();Thread.Sleep(120);
            string config=Path.Combine(directory,"config.json");
            string settings=Path.Combine(output,"user-root","computer-use","desktop-pet.json");
            File.WriteAllText(config,json.Serialize(new{ownerPid=Process.GetCurrentProcess().Id,desktop=args[1],asset=args[2],directory=directory,settingsPath=settings}));
            var info=new ProcessStartInfo(args[0],"\""+config+"\"") {UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden};
            pet=Process.Start(info);
            Wait(delegate{return File.Exists(Path.Combine(directory,"status.json"));},10000);
            var entrance=Record("01-entrance",1100);
            Check("entrance grows from small scale and settles at one",entrance.Min(s=>N(s,"pet_scale_x"))<0.7 && Math.Abs(N(entrance.Last(),"pet_scale_x")-1)<0.01,entrance.Count);
            Check("entrance has a measured spring overshoot",entrance.Max(s=>N(s,"pet_scale_y"))>1.015,entrance.Max(s=>N(s,"pet_scale_y")));
            Down();var pressed=Record("02-press",240);
            Check("physical press squashes vertically and stretches horizontally",pressed.Min(s=>N(s,"pet_scale_y"))<0.9 && pressed.Max(s=>N(s,"pet_scale_x"))>1.06,null);
            Up();var opening=Record("03-open",1150);
            var openScales=opening.Where(s=>s["native_viewer_rect"]!=null).Select(s=>N(s,"viewer_scale")).ToArray();
            Check("open zoom has multiple native intermediate rectangles",openScales.Distinct().Count()>3 && openScales.Min()<0.9 && openScales.Max()==1,openScales);
            Check("release rebounds then settles",opening.Max(s=>N(s,"pet_scale_y"))>1.005 && Math.Abs(N(opening.Last(),"pet_scale_y")-1)<0.01,null);
            Check("open ends on exact monitor bounds",json.Serialize(Rect(new IntPtr((long)N(State(),"viewer_hwnd"))))==json.Serialize(new{x=screen.X,y=screen.Y,width=screen.Width,height=screen.Height}),State()["viewer_bounds"]);
            Click();var closing=Record("04-close",1150);
            var closingScales=closing.Where(s=>s["native_viewer_rect"]!=null).Select(s=>N(s,"viewer_scale")).ToArray();
            Check("close zoom shrinks before destroying viewer",closingScales.Distinct().Count()>3 && closingScales.First()>closingScales.Last() && closing.Last()["native_viewer_rect"]==null,closingScales);
            Check("outline stays off throughout visible closing frames",closing.Where(s=>s["native_viewer_rect"]!=null).All(s=>!(bool)s["outline_active"]),null);
            Click();Thread.Sleep(120);long reversedHwnd=(long)N(State(),"viewer_hwnd");Click();Thread.Sleep(100);Click();var reversed=Record("05-reversed",1150);
            Wait(delegate{return (string)State()["viewer_transition"]=="open";},3000);
            Check("rapid reversal reuses one viewer and finishes open",(long)N(State(),"viewer_hwnd")==reversedHwnd && (string)State()["viewer_transition"]=="open",reversedHwnd);
            Click();Thread.Sleep(900);
            Menu();Capture(Path.Combine(output,"menu.png"));
            var menu=AutomationElement.FromHandle(new IntPtr((long)N(State(),"menu_hwnd")));
            Check("native right-click menu exposes six scale choices",new[]{"50%","75%","100%（默认）","125%","150%","200%"}.All(n=>menu.FindFirst(TreeScope.Descendants,new PropertyCondition(AutomationElement.NameProperty,n))!=null),null);
            double initialWidth=Convert.ToDouble(((Dictionary<string,object>)State()["bounds"])["width"]);
            SelectScale("150%");var resized=Record("06-resize",1100);
            double finalWidth=Convert.ToDouble(((Dictionary<string,object>)State()["bounds"])["width"]);
            Check("menu changes actual pet size to 150 percent",N(State(),"size_multiplier")==1.5 && finalWidth/initialWidth>1.45 && finalWidth/initialWidth<1.55,new{initial=initialWidth,final=finalWidth});
            Check("resize interpolates old visual size to new size",resized.Min(s=>N(s,"pet_scale_x"))<0.95 && Math.Abs(N(resized.Last(),"pet_scale_x")-1)<0.01,null);
            Menu();SelectScale("200%");Record("07-large",1000);
            R large;GetWindowRect(new IntPtr((long)N(State(),"hwnd")),out large);
            Check("largest size remains within its monitor",large.Left>=screen.Left && large.Top>=screen.Top && large.Right<=screen.Right && large.Bottom<=screen.Bottom,N(State(),"size_multiplier"));
            Menu();SelectScale("50%");var small=Record("07b-small",1300);
            Check("200 to 50 percent shrink keeps the whole sprite inside its canvas",small.All(s=>{
                var p=(Dictionary<string,object>)s["paint_bounds"];var b=(Dictionary<string,object>)s["bounds"];
                return N(p,"x")>=0 && N(p,"y")>=0 && N(p,"x")+N(p,"width")<=N(b,"width") && N(p,"y")+N(p,"height")<=N(b,"height");
            }) && N(State(),"size_multiplier")==0.5,null);
            Menu();SelectScale("150%");Thread.Sleep(1000);
            Check("last menu choice is durably stored",Convert.ToDouble(json.Deserialize<Dictionary<string,object>>(File.ReadAllText(settings))["size_multiplier"])==1.5,settings);
            Click();Thread.Sleep(800);
            int capturePid=(int)N(State(),"capture_pid");long exitHwnd=(long)N(State(),"viewer_hwnd");
            File.WriteAllText(Path.Combine(directory,"stop"),"motion-acceptance");var exit=Record("08-exit",1100);
            Check("completion exit visibly shrinks the pet",exit.Any(s=>(string)s["pet_transition"]=="exiting") && exit.Min(s=>N(s,"pet_scale_x"))<0.12,null);
            Check("completion exit closes pet viewer and capture",pet.HasExited && !IsWindow(new IntPtr(exitHwnd)) && !Alive(capturePid),capturePid);
            pet.Dispose();
            File.Delete(Path.Combine(directory,"stop"));File.Delete(Path.Combine(directory,"status.json"));
            pet=Process.Start(info);
            Wait(delegate{return File.Exists(Path.Combine(directory,"status.json"));},10000);
            var restored=Record("09-restored-entrance",1100);
            Check("new native process uses saved size from its first frame",restored.All(s=>N(s,"size_multiplier")==1.5) && Convert.ToDouble(((Dictionary<string,object>)restored.First()["bounds"])["width"])==finalWidth,restored.First()["bounds"]);
            File.WriteAllText(Path.Combine(directory,"stop"),"restored-size-stop");
            Wait(delegate{return pet.HasExited;},2500);
        } catch(Exception ex) {Check("motion acceptance completes",false,ex.ToString());}
        finally {
            mouse_event(4|16,0,0,0,UIntPtr.Zero);SetCursorPos(original.X,original.Y);
            if(pet!=null){try{if(!pet.HasExited){pet.Kill();pet.WaitForExit(1000);}}catch{}pet.Dispose();}
            if(backdrop!=null)backdrop.Dispose();
            json.MaxJsonLength=16000000;File.WriteAllText(Path.Combine(output,"motion-results.json"),json.Serialize(new{checks=checks,recordings=recordings}));
        }
        Console.WriteLine((checks.Count-failures)+"/"+checks.Count+" passed");return failures==0?0:1;
    }
}
