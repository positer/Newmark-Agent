using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using System.Web.Script.Serialization;
public sealed class PetProbe : Form {
    int clicks, keys; readonly string state;
    readonly Timer timer = new Timer();
    public PetProbe(string output) {
        state=output; Text="Newmark pet isolation fixture"; Bounds=new Rectangle(80,80,720,480);
        BackColor=Color.FromArgb(18,82,130); KeyPreview=true; DoubleBuffered=true;
        MouseDown+=delegate { clicks++; Invalidate(); };
        KeyDown+=delegate { keys++; Invalidate(); };
        timer.Interval=100; timer.Tick+=delegate {
            File.WriteAllText(state,new JavaScriptSerializer().Serialize(new { pid=System.Diagnostics.Process.GetCurrentProcess().Id, hwnd=Handle.ToInt64(), clicks=clicks, keys=keys }));
        }; timer.Start();
    }
    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e); e.Graphics.FillRectangle(Brushes.Lime,30,80,280,180);
        using(var font=new Font("Arial",20)) e.Graphics.DrawString("HIDDEN DESKTOP LIVE\nClicks: "+clicks+"  Keys: "+keys,font,Brushes.White,30,20);
    }
    [STAThread] public static void Main(string[] args) { Application.EnableVisualStyles(); Application.Run(new PetProbe(args[0])); }
}
