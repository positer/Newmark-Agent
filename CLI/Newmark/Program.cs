using Newmark.TUI;

namespace Newmark;

class Program
{
    static void Main(string[] args)
    {
        string rootPath = AppDomain.CurrentDomain.BaseDirectory;
        string installPath = Path.GetFullPath(Path.Combine(rootPath, "..", "..", "..", ".."));

        if (!Directory.Exists(Path.Combine(installPath, "config.json")))
            installPath = rootPath;

        var app = new NewmarkApp(installPath);
        app.Run();
    }
}
