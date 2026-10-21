using System;using System.Collections.Generic;using System.Diagnostics;using System.Drawing;using System.IO;using System.Reflection;using System.Windows.Forms;
internal static class GpuProbe {
 static DesktopPet pet;static PetConfig cfg;static List<object> checks=new List<object>();static int failed;static BindingFlags flags=BindingFlags.NonPublic|BindingFlags.Instance;
 static void Check(string name,bool ok,object detail){checks.Add(new{name=name,ok=ok,detail=detail});if(!ok)failed++;Console.WriteLine((ok?"PASS ":"FAIL ")+name);}
 static object Field(string name){return typeof(DesktopPet).GetField(name,flags).GetValue(pet);}static void Call(string name,params object[] args){typeof(DesktopPet).GetMethod(name,flags).Invoke(pet,args);}static double SizeValue(){return (double)Field("sizeMultiplier");}
 [STAThread]static int Main(string[] args){
 PetNative.SetProcessDpiAwarenessContext(new IntPtr(-4));if(args[0]=="--capture"){var captureCfg=PetFiles.Json.Deserialize<PetConfig>(File.ReadAllText(args[1]));DesktopCapture.Run(captureCfg,int.Parse(args[2]));return 0;}
 cfg=PetFiles.Json.Deserialize<PetConfig>(File.ReadAllText(args[0]));cfg.ownerPid=Process.GetCurrentProcess().Id;Application.EnableVisualStyles();pet=new DesktopPet(cfg,args[0]);var timer=new Timer{Interval=30};var clock=Stopwatch.StartNew();int stage=0;long mark=0;IntPtr viewerHandle=IntPtr.Zero;bool pending=false;
 timer.Tick+=async delegate {if(pending)return;pending=true;try{
 var viewer=(DesktopViewer)Field("viewer");double progress=((PetSpring)Field("reveal")).Value;
 if(clock.ElapsedMilliseconds>45000)throw new TimeoutException("GPU integration stage "+stage);
 if(stage==0&&clock.ElapsedMilliseconds>850){Check("entrance settles at saved default",Math.Abs(SizeValue()-1)<.001,SizeValue());pet.Location=new Point(Screen.PrimaryScreen.WorkingArea.Left+80,Screen.PrimaryScreen.WorkingArea.Top+120);Call("Toggle");viewer=(DesktopViewer)Field("viewer");Check("cold preview stays hidden until anchor is primed",!viewer.Primed&&viewer.Opacity==0,viewer.Opacity);stage=1;mark=clock.ElapsedMilliseconds;}
 else if(stage==1&&viewer!=null&&viewer.Ready&&!((PetSpring)Field("reveal")).Moving&&viewer.HasFrame){
 var web=(Microsoft.Web.WebView2.WinForms.WebView2)typeof(DesktopViewer).GetField("web",flags).GetValue(viewer);
 string loaded=await web.CoreWebView2.ExecuteScriptAsync("document.getElementById('frame').naturalWidth");if(loaded=="0")return;
 Check("GPU viewer decoded actual hidden-desktop capture",Int32.Parse(loaded)>0,loaded);Check("expanded covers exact monitor",viewer.Bounds==viewer.FullBounds&&viewer.ContentBounds==viewer.FullBounds,PetNative.Bounds(viewer.Bounds));Check("expanded disables contour",(bool)Field("anyExpanded"),Field("anyExpanded"));
 // Freeze native progression and inspect Chromium's actual transformed rectangle.
 var frameClock=(PetFrameClock)Field("timer");frameClock.Stop();
 try{foreach(double p in new double[]{0,.2,.5}){viewer.SetProgress(p);await System.Threading.Tasks.Task.Delay(90);
 string geometry=await web.CoreWebView2.ExecuteScriptAsync("(()=>{const r=document.getElementById('surface').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,vw:innerWidth,vh:innerHeight}})()");
 var g=PetFiles.Json.Deserialize<Dictionary<string,double>>(geometry);double sx=viewer.FullBounds.Width/g["vw"],sy=viewer.FullBounds.Height/g["vh"];
 double cx=(g["x"]+g["w"]/2)*sx+viewer.FullBounds.Left,cy=(g["y"]+g["h"]/2)*sy+viewer.FullBounds.Top;
 double travel=(viewer.Scale-viewer.InitialScale)/(1-viewer.InitialScale),expectedX=viewer.Anchor.X+(viewer.FullBounds.Left+viewer.FullBounds.Width/2.0-viewer.Anchor.X)*travel;
 Check("GPU geometry follows NewMate scale anchor at "+p,Math.Abs(cx-expectedX)<2&&Math.Abs(g["w"]*sx-viewer.FullBounds.Width*viewer.Scale)<2,new{cx,cy,expectedX,anchor=viewer.Anchor.ToString(),geometry});
 }}finally{viewer.SetProgress(1);frameClock.Start();}
 string caption=await web.CoreWebView2.ExecuteScriptAsync("document.getElementById('caption').textContent");Check("normal preview has no engineering caption",caption=="\"\"",caption);
 using(var bytes=new MemoryStream(File.ReadAllBytes(Path.Combine(cfg.directory,"frame.png"))))using(var background=new Bitmap(bytes)){var color=background.GetPixel(background.Width-1,background.Height-1);Check("desktop background is pure black",color.R==0&&color.G==0&&color.B==0,color.ToString());}
 File.WriteAllText(Path.Combine(cfg.directory,"transfer-motion"),"in");await System.Threading.Tasks.Task.Delay(350);Check("process transfer pulse preserves expanded preview",(bool)Field("expanded")&&Field("viewer")==viewer,Field("expanded"));
 using(var file=File.Create(Path.Combine(cfg.directory,"viewer.png")))await web.CoreWebView2.CapturePreviewAsync(Microsoft.Web.WebView2.Core.CoreWebView2CapturePreviewImageFormat.Png,file);
 if(File.Exists(Path.Combine(cfg.directory,"fixture.json"))){await web.CoreWebView2.ExecuteScriptAsync("document.dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true}));document.getElementById('surface').click()");await System.Threading.Tasks.Task.Delay(200);var fixture=PetFiles.Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(cfg.directory,"fixture.json")));Check("hidden source has received no preview input",Convert.ToInt32(fixture["clicks"])==0&&Convert.ToInt32(fixture["keys"])==0,fixture);}else{using(var bytes=new MemoryStream(File.ReadAllBytes(Path.Combine(cfg.directory,"frame.png"))))using(var blank=new Bitmap(bytes)){bool black=true;for(int y=0;y<blank.Height;y++)for(int x=0;x<blank.Width;x++)if((blank.GetPixel(x,y).ToArgb()&0xffffff)!=0)black=false;Check("empty desktop contains only black pixels",black,null);}}
 viewerHandle=viewer.Handle;Call("Collapse");stage=2;}
 else if(stage==2&&progress<.85&&progress>.1){double before=progress;Call("Toggle");Check("reverse retains viewer and progress",viewer.Handle==viewerHandle&&Math.Abs(((PetSpring)Field("reveal")).Value-before)<.0001,before);stage=3;}
 else if(stage==3&&progress>.999){Call("Collapse");stage=4;}
 else if(stage==4&&viewer==null){Check("collapsed hides viewer and restores contour",!(bool)Field("anyExpanded"),Field("anyExpanded"));pet.Location=new Point(Screen.PrimaryScreen.WorkingArea.Right-pet.Width-60,180);Call("Toggle");viewer=(DesktopViewer)Field("viewer");Check("warm reopen reuses ready GPU renderer",viewer.Ready&&viewer.Handle==viewerHandle,viewer.Handle.ToInt64());Check("warm preview waits for relocated anchor",!viewer.Primed&&viewer.Opacity==0,viewer.Anchor.ToString());stage=5;}
 else if(stage==5&&progress>.999){Call("Collapse");stage=6;}
 else if(stage==6&&viewer==null){Call("ChangeScale",1.374);var saved=PetFiles.Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(cfg.settingsPath));Check("continuous size persists version 2",Convert.ToDouble(saved["size_multiplier"])==1.374&&Convert.ToInt32(saved["version"])==2,saved);File.WriteAllText(cfg.settingsPath,"{\"version\":2,\"size_multiplier\":0.3}");stage=7;mark=clock.ElapsedMilliseconds;}
 else if(stage==7&&SizeValue()==.3){Check("external settings resize without restart",clock.ElapsedMilliseconds-mark<1000,clock.ElapsedMilliseconds-mark);File.WriteAllText(cfg.settingsPath,"{\"version\":2,\"size_multiplier\":3}");stage=8;}
 else if(stage==8&&SizeValue()==3){Check("upper endpoint 300 percent accepted",true,SizeValue());Call("BeginExit");stage=9;}
 }catch(Exception ex){Check("integration completed",false,ex.ToString());timer.Stop();pet.Dispose();Application.ExitThread();}finally{pending=false;}};
 pet.Shown+=delegate{timer.Start();};pet.FormClosed+=delegate{timer.Stop();Check("completion closes preview and capture",Field("viewer")==null&&Field("capture")==null,null);};
 try{Application.Run(pet);}finally{timer.Dispose();pet.Dispose();File.WriteAllText(Path.Combine(cfg.directory,"gpu-checks.json"),PetFiles.Json.Serialize(new{checks=checks,failed=failed}));}return failed==0?0:1;
 }
}
