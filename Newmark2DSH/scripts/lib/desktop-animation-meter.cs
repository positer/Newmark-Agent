using System;using System.Collections.Generic;using System.Diagnostics;using System.IO;using System.Reflection;using System.Windows.Forms;
internal static class AnimationMeter {
 [STAThread] static void Main(string[] args) {
  PetNative.SetProcessDpiAwarenessContext(new IntPtr(-4));Application.EnableVisualStyles();
  var config=PetFiles.Json.Deserialize<PetConfig>(File.ReadAllText(args[0]));config.ownerPid=Process.GetCurrentProcess().Id;
  var pet=new DesktopPet(config,args[0]);var flags=BindingFlags.NonPublic|BindingFlags.Instance;
  object clock=typeof(DesktopPet).GetField("timer",flags).GetValue(pet);
  var action=clock.GetType().GetField("frame",flags);var original=(Action)action.GetValue(clock);
  var stamps=new List<double>();var elapsed=Stopwatch.StartNew();double draw=0;
  action.SetValue(clock,new Action(delegate{double at=elapsed.Elapsed.TotalMilliseconds;original();if(at>=1000){stamps.Add(at);draw+=elapsed.Elapsed.TotalMilliseconds-at;}}));
  var cpu=Process.GetCurrentProcess().TotalProcessorTime;var end=new Timer{Interval=6000};
  end.Tick+=delegate{end.Stop();double duration=elapsed.Elapsed.TotalMilliseconds;var spans=new List<double>();for(int i=1;i<stamps.Count;i++)spans.Add(stamps[i]-stamps[i-1]);spans.Sort();
   var mode=clock.GetType().GetField("SyncMode",flags);var skipped=clock.GetType().GetField("Skipped",flags);
   PetFiles.WriteJson(Path.Combine(config.directory,"animation-metrics.json"),new{callback="native UI render tick",frames=stamps.Count,fps=(stamps.Count-1)*1000/(stamps[stamps.Count-1]-stamps[0]),p95_ms=spans[(int)((spans.Count-1)*.95)],mean_draw_ms=draw/stamps.Count,cpu_core_percent=(Process.GetCurrentProcess().TotalProcessorTime-cpu).TotalMilliseconds/duration*100,sync=mode==null?"fixed-60Hz":mode.GetValue(clock),skipped=skipped==null?null:skipped.GetValue(clock)});
   pet.Dispose();Application.ExitThread();};
  pet.Shown+=delegate{end.Start();};Application.Run(pet);end.Dispose();
 }
}
