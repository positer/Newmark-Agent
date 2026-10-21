using System;using System.Drawing;using System.IO;using System.Collections.Generic;using System.Windows.Forms;
internal static class TransferLayerProbe {
 static int failed;static List<object> checks=new List<object>();
 static void Check(string name,bool ok){checks.Add(new{name=name,ok=ok});Console.WriteLine((ok?"PASS ":"FAIL ")+name);if(!ok)failed++;}
 static bool Above(IntPtr a,IntPtr b){for(IntPtr h=TransferNative.GetWindow(b,3);h!=IntPtr.Zero;h=TransferNative.GetWindow(h,3))if(h==a)return true;return false;}
 [STAThread]static int Main(string[] args){
  PetNative.SetProcessDpiAwarenessContext(new IntPtr(-4));Application.EnableVisualStyles();
  using(var source=new Form())using(var cover=new Form())using(var viewer=new Form())using(var pet=new Form()){
   source.Bounds=cover.Bounds=new Rectangle(100,100,300,220);source.Show();cover.Show();
   var c=new TransferConfig{directory=args[0],animationDesktop="Default",animationPrevious=TransferNative.Hex(cover.Handle),anchorX=200,anchorY=200};
   using(var flight=new TransferAnimation(c)){
    IntPtr handle=flight.Handle;PetNative.SetWindowPos(handle,IntPtr.Zero,0,0,0,0,0x53);flight.ApplyLayer();
    Check("covered real transfer stays below covering window",Above(cover.Handle,handle));
    Check("ordinary transfer is not topmost",!flight.TopMost);
    viewer.Bounds=new Rectangle(0,0,800,600);viewer.TopMost=true;viewer.Show();PetNative.MarkViewer(viewer.Handle);
    flight.ApplyLayer();Check("real transfer remains below expanded virtual preview",Above(viewer.Handle,handle));
    pet.TopMost=true;pet.Show();PetNative.MarkPet(pet.Handle);
    c.animationDesktop="NmCuHiddenLayerTest";flight.ApplyLayer();
    Check("virtual transfer draws above expanded preview",Above(handle,viewer.Handle));
    Check("virtual transfer remains below NewMate",Above(pet.Handle,handle));
    Check("transfer does not close preview",viewer.Visible&&PetNative.AnyViewer());
    PetNative.UnmarkViewer(viewer.Handle);viewer.Hide();flight.ApplyLayer();
    Check("collapse demotes animation to real desktop layer",!flight.TopMost);
    c.animationDesktop="Default";c.animationTopmost=true;c.animationPrevious=TransferNative.Hex(pet.Handle);flight.ApplyLayer();
    Check("topmost source retains topmost band without covering pet",flight.TopMost&&Above(pet.Handle,handle));
   }
  }
  File.WriteAllText(Path.Combine(args[0],"layer-checks.json"),PetFiles.Json.Serialize(new{checks=checks,failed=failed}));return failed==0?0:1;
 }
}
