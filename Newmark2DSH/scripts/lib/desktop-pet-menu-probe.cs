// Isolated fixture: invoke the production right-button handler, then operate its real menu.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;
internal static class MenuProbe {
    [STAThread] private static void Main(string[] args) {
        PetNative.SetProcessDpiAwarenessContext(new IntPtr(-4));
        Application.EnableVisualStyles();
        string root=Path.GetFullPath(args.Length>0 ? args[0] : AppDomain.CurrentDomain.BaseDirectory);
        var config=PetFiles.Json.Deserialize<PetConfig>(File.ReadAllText(Path.Combine(root,"config.json")));
        config.ownerPid=Process.GetCurrentProcess().Id;
        var pet=new DesktopPet(config,Path.Combine(root,"config.json"));
        var panel=new Form {Text="NewMate CSS Menu Test",StartPosition=FormStartPosition.Manual,Location=new Point(160,180),Size=new Size(470,180)};
        var open=new Button {Text="Open production NewMate menu",Dock=DockStyle.Top,Height=55};
        panel.Controls.Add(open);
        open.Click+=delegate {
            typeof(DesktopPet).GetMethod("OnMouseUp",BindingFlags.NonPublic|BindingFlags.Instance).Invoke(pet,new object[]{new MouseEventArgs(MouseButtons.Right,1,pet.Width/2,pet.Height/2,0)});
        };
        panel.Shown+=delegate {pet.Show();pet.Location=new Point(1100,350);panel.BeginInvoke(new Action(()=>open.PerformClick()));};
        var timer=new Timer {Interval=600};bool pending=false;
        timer.Tick+=async delegate {
            if(pending)return;
            var menu=(DshPetMenu)typeof(DesktopPet).GetField("dshMenu",BindingFlags.NonPublic|BindingFlags.Instance).GetValue(pet);
            string command=Path.Combine(root,"command.txt");
            if(File.Exists(command) && File.ReadAllText(command)=="open") {File.Delete(command);open.PerformClick();}
            if(menu==null||!menu.Open)return;
            pending=true;
            try {
                var web=(WebView2)typeof(DshPetMenu).GetField("web",BindingFlags.NonPublic|BindingFlags.Instance).GetValue(menu);
                var json=await web.CoreWebView2.ExecuteScriptAsync(@"(()=>{const m=document.querySelector('[data-newmate-menu]'),r=m.querySelector('input'),material=m.firstElementChild;const c=getComputedStyle(m),s=getComputedStyle(r),b=getComputedStyle(material);return {title:m.textContent,themeHash:'"+menu.ThemeHash+@"',surface:b.backgroundColor,radius:c.borderRadius,font:s.fontFamily,fontSize:s.fontSize,rowHeight:r.getBoundingClientRect().height,rowColor:s.color,hover:getComputedStyle(m.querySelector('input:hover')||r).backgroundColor,selected:r.value,menuWidth:m.getBoundingClientRect().width,menuHeight:m.getBoundingClientRect().height,bodyDark:document.body.hasAttribute('data-ds-dark-theme'),width:innerWidth,height:innerHeight,dpr:devicePixelRatio};})()");
                PetFiles.Write(Path.Combine(root,"computed.json"),json);
                if(File.Exists(command)) {
                    string action=File.ReadAllText(command);File.Delete(command);
                    if(action=="capture")using(var file=File.Create(Path.Combine(root,"menu.png")))await web.CoreWebView2.CapturePreviewAsync(Microsoft.Web.WebView2.Core.CoreWebView2CapturePreviewImageFormat.Png,file);
                    if(action=="focus")await web.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-newmate-slider]').focus()");
                    if(action=="select150")await web.CoreWebView2.ExecuteScriptAsync("(()=>{const s=document.querySelector('[data-newmate-slider]');s.value='137.4';s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));})()");
                    if(action=="escape")await web.CoreWebView2.ExecuteScriptAsync("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
                }
            } catch(Exception ex){PetFiles.Write(Path.Combine(root,"probe-error.txt"),ex.ToString());}
            finally{pending=false;}
        };
        timer.Start();panel.FormClosed+=delegate{timer.Stop();timer.Dispose();pet.Dispose();};
        Application.Run(panel);
    }
}
