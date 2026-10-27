// A window that reports what actually reached it, for the Computer Use acceptance test.
//
// The point is to measure delivery, not to look like an app: every key down/up (with the
// modifier state at that moment), every click on the canvas, every wheel delta and the
// editor's text (plus the clipboard on Ctrl+C/V) is appended to events.jsonl as one JSON
// object per line. The harness asserts against that file, so "ok: true" from the tool is
// never accepted as proof that a keystroke arrived.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using System.Web.Script.Serialization;

internal sealed class Witness : Form {
    private readonly string directory;
    private readonly object gate = new object();
    private TextBox editor;
    private Panel canvas;
    private ListBox list;

    internal Witness(string directory) {
        this.directory = directory;
        Text = "Newmark CU Witness";
        Width = 900; Height = 640;
        StartPosition = FormStartPosition.Manual;
        Left = 120; Top = 120;
        KeyPreview = true;

        // All three targets are visible at once, not hidden behind tabs: a click or a wheel event
        // that lands on an unselected tab page would be an artefact of the witness, not of CU.
        editor = new TextBox { Multiline = true, Dock = DockStyle.Top, Height = 180, Name = "editor", ScrollBars = ScrollBars.Vertical };
        canvas = new Panel { Dock = DockStyle.Fill, Name = "canvas", BackColor = Color.FromArgb(24, 24, 28) };
        canvas.Paint += (s, e) => {
            using (var brush = new SolidBrush(Color.FromArgb(120, 160, 255)))
                e.Graphics.FillEllipse(brush, canvas.Width / 2 - 40, canvas.Height / 2 - 40, 80, 80);
        };
        list = new ListBox { Dock = DockStyle.Bottom, Height = 140, Name = "list", IntegralHeight = false };
        for (int index = 0; index < 200; index++) list.Items.Add("row " + index);
        Controls.Add(canvas);
        Controls.Add(list);
        Controls.Add(editor);

        KeyDown += (s, e) => Log(new Dictionary<string, object> { { "kind", "keydown" }, { "key", e.KeyCode.ToString() }, { "code", (int)e.KeyCode }, { "modifiers", e.Modifiers.ToString() }, { "focus", FocusedControl() } });
        KeyUp += (s, e) => {
            Log(new Dictionary<string, object> { { "kind", "keyup" }, { "key", e.KeyCode.ToString() }, { "code", (int)e.KeyCode }, { "modifiers", e.Modifiers.ToString() }, { "focus", FocusedControl() } });
            if (e.Control && (e.KeyCode == Keys.C || e.KeyCode == Keys.X || e.KeyCode == Keys.V)) {
                string clip = "";
                try { if (Clipboard.ContainsText()) clip = Clipboard.GetText(); } catch { }
                Log(new Dictionary<string, object> { { "kind", "clipboard" }, { "key", e.KeyCode.ToString() }, { "text", clip }, { "editor_len", editor.Text.Length } });
            }
        };
        editor.TextChanged += (s, e) => Log(new Dictionary<string, object> { { "kind", "editor" }, { "length", editor.Text.Length }, { "text", editor.Text.Length <= 120 ? editor.Text : editor.Text.Substring(0, 120) }, { "selection", editor.SelectionLength } });
        canvas.MouseDown += (s, e) => Log(new Dictionary<string, object> { { "kind", "canvas_click" }, { "x", e.X }, { "y", e.Y }, { "button", e.Button.ToString() } });
        canvas.MouseWheel += (s, e) => Log(new Dictionary<string, object> { { "kind", "canvas_wheel" }, { "delta", e.Delta } });
        list.MouseWheel += (s, e) => Log(new Dictionary<string, object> { { "kind", "list_wheel" }, { "delta", e.Delta }, { "top", list.TopIndex } });
        Shown += (s, e) => WriteStatus();
        FormClosing += (s, e) => { try { WriteStatus(); } catch { } };
    }

    private string FocusedControl() {
        var control = ActiveControl as ContainerControl;
        while (control != null && control.ActiveControl is ContainerControl) control = control.ActiveControl as ContainerControl;
        if (control == null) return "form";
        var inner = control.ActiveControl;
        return inner != null && !string.IsNullOrEmpty(inner.Name) ? inner.Name : control.Name;
    }

    private void WriteStatus() {
        var status = new Dictionary<string, object> {
            { "ready", true },
            { "hwnd", Handle.ToInt64() },
            { "form", Rect(this) },
            { "title", Text },
            { "editor", Rect(editor) },
            { "canvas", Rect(canvas) },
            { "list", Rect(list) },
            { "editor_hwnd", editor.Handle.ToInt64() },
            { "canvas_hwnd", canvas.Handle.ToInt64() },
            { "list_hwnd", list.Handle.ToInt64() },
        };
        File.WriteAllText(Path.Combine(directory, "status.json"), new JavaScriptSerializer().Serialize(status));
    }

    private static string Rect(Control control) {
        var point = control.PointToScreen(Point.Empty);
        return string.Format("{0},{1},{2},{3}", point.X, point.Y, control.Width, control.Height);
    }

    private void Log(Dictionary<string, object> entry) {
        entry["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    lock (gate) {
            File.AppendAllText(Path.Combine(directory, "events.jsonl"), new JavaScriptSerializer().Serialize(entry) + "\n");
        }
    }

    [STAThread]
    private static void Main(string[] args) {
        string directory = args.Length > 0 ? args[0] : Path.GetTempPath();
        Directory.CreateDirectory(directory);
        Application.EnableVisualStyles();
        Application.Run(new Witness(directory));
    }
}
