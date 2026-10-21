// Native hit-test regression. Input is posted to the HWND actually under the
// slider, never dispatched as a DOM event or directly to the known WebView.
using System;using System.Drawing;using System.IO;using System.Reflection;using System.Runtime.InteropServices;using System.Threading.Tasks;using System.Windows.Forms;using System.Collections.Generic;
using Microsoft.Web.WebView2.WinForms;
internal static class MenuHitProbe {
 [DllImport("user32.dll")]static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")]static extern bool ScreenToClient(IntPtr h,ref Point p);
 [DllImport("user32.dll")]static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 static int failed;static List<object> checks=new List<object>();
 static void Check(string name,bool ok,object detail){checks.Add(new{name,ok,detail});Console.WriteLine((ok?"PASS ":"FAIL ")+name);if(!ok)failed++;}
 [STAThread]static int Main(string[] args){
  PetNative.SetProcessDpiAwarenessContext(new IntPtr(-4));Application.EnableVisualStyles();
  Application.ThreadException+=delegate(object sender,System.Threading.ThreadExceptionEventArgs e){Check("no unhandled UI exception",false,e.Exception.ToString());Application.ExitThread();};
  var cfg=PetFiles.Json.Deserialize<PetConfig>(File.ReadAllText(args[0]));cfg.ownerPid=System.Diagnostics.Process.GetCurrentProcess().Id;
  var under=new Form{Text="NewMate hit test backdrop",Bounds=new Rectangle(50,50,900,700)};
  var pet=new DesktopPet(cfg,args[0]);int underClicks=0;under.MouseDown+=delegate{underClicks++;};
  under.Shown+=async delegate{try{
   pet.Show();pet.Location=new Point(150,200);await Task.Delay(800);
   var flags=BindingFlags.Instance|BindingFlags.NonPublic;
   typeof(DesktopPet).GetMethod("OnMouseUp",flags).Invoke(pet,new object[]{new MouseEventArgs(MouseButtons.Right,1,pet.Width/2,pet.Height/2,0)});
   DshPetMenu menu=null;for(int i=0;i<100;i++){menu=(DshPetMenu)typeof(DesktopPet).GetField("dshMenu",flags).GetValue(pet);if(menu!=null&&menu.Open)break;await Task.Delay(100);}
   if(menu==null||!menu.Open)throw new Exception("Menu did not open");
   var web=(WebView2)typeof(DshPetMenu).GetField("web",flags).GetValue(menu);
   string js="(()=>{const r=document.querySelector('input').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,dpr:devicePixelRatio}})()";
   var box=PetFiles.Json.Deserialize<Dictionary<string,double>>(await web.CoreWebView2.ExecuteScriptAsync(js));
   for(int j=0;j<3;j++){
    var point=web.PointToScreen(new Point((int)((box["x"]+box["w"]*(.25+j*.25))*box["dpr"]),(int)((box["y"]+box["h"]/2)*box["dpr"])));
    IntPtr target=WindowFromPoint(point);bool owned=GetAncestor(target,2)==menu.Handle;
    Check("slider native hit belongs to menu "+j,owned,new{target=target.ToInt64(),menu=menu.Handle.ToInt64()});
    if(!owned)continue;
    ScreenToClient(target,ref point);IntPtr lp=new IntPtr((point.Y<<16)|(point.X&65535));
    PostMessage(target,0x201,new IntPtr(1),lp);await Task.Delay(90);PostMessage(target,0x202,IntPtr.Zero,lp);await Task.Delay(250);
    Check("slider remains open "+j,menu.Open,null);
   }
   string value=await web.CoreWebView2.ExecuteScriptAsync("document.querySelector('input').value");
   var prefs=PetFiles.Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(cfg.settingsPath));
   Check("native slider input persists size",Convert.ToDouble(prefs["size_multiplier"])>1.5,new{value,prefs});
   Check("no click reaches backdrop",underClicks==0,underClicks);
   using(var file=File.Create(Path.Combine(cfg.directory,"menu.png")))await web.CoreWebView2.CapturePreviewAsync(Microsoft.Web.WebView2.Core.CoreWebView2CapturePreviewImageFormat.Png,file);
  }catch(Exception ex){Check("menu probe completed",false,ex.ToString());}finally{pet.Dispose();under.Close();}};
  Application.Run(under);File.WriteAllText(Path.Combine(cfg.directory,"checks.json"),PetFiles.Json.Serialize(new{checks,failed}));return failed==0?0:1;
 }
}
