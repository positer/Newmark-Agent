using System;using System.Diagnostics;using System.Drawing;using System.IO;using System.Reflection;using System.Windows.Forms;
internal static class TransferPacingProbe {
 [STAThread]static int Main(string[] args){
  Application.EnableVisualStyles();var source=new Form{Text="NewMate pacing QA",Bounds=new Rectangle(120,120,320,220)};source.Show();
  var c=new TransferConfig{id="pacing-qa",directory=args[0],sourceDesktop="Default",targetDesktop="Default",sourceHandle=TransferNative.Hex(source.Handle),sourcePid=Process.GetCurrentProcess().Id,sourceStart=TransferNative.Start(Process.GetCurrentProcess().Id),side="real",ownerPid=Process.GetCurrentProcess().Id,width=320,height=220};
  var broker=new TransferBroker(c,IntPtr.Zero);var timer=new Timer{Interval=50};var elapsed=Stopwatch.StartNew();int stage=0,failed=0;DateTime stamp=DateTime.MinValue;long mark=0;
  timer.Tick+=delegate{try{
   if(elapsed.ElapsedMilliseconds>10000)throw new TimeoutException("No progress while display clock stopped");
   string file=Path.Combine(c.directory,"status.json");
   if(stage==0&&File.Exists(file)){
    ((PetFrameClock)typeof(TransferBroker).GetField("timer",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(broker)).Stop();
    stamp=File.GetLastWriteTimeUtc(file);mark=elapsed.ElapsedMilliseconds;stage=1;
   }else if(stage==1&&elapsed.ElapsedMilliseconds-mark>700){
    if(File.GetLastWriteTimeUtc(file)<=stamp)throw new Exception("Status heartbeat stopped with display clock");
    Console.WriteLine("PASS broker heartbeat survives stopped display pacing");
    PetFiles.WriteJson(Path.Combine(c.directory,"command.json"),new{id="stop-without-vblank",op="return"});stage=2;
   }else if(stage==2&&broker.IsDisposed){
    Console.WriteLine("PASS return command completes without display ticks");
    if(source.IsDisposed)throw new Exception("Original source disposed");
    Console.WriteLine("PASS original window survives return");timer.Stop();source.Close();Application.ExitThread();
   }
  }catch(Exception ex){Console.WriteLine("FAIL "+ex.Message);failed++;timer.Stop();broker.Dispose();source.Close();Application.ExitThread();}};
  broker.Shown+=delegate{timer.Start();};Application.Run(broker);timer.Dispose();broker.Dispose();source.Dispose();return failed==0&&stage==2?0:1;
 }
}
