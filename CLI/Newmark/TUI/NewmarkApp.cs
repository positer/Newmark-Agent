namespace Newmark.TUI;

using Terminal.Gui;
using Newmark.Engine;
using Newmark.Utils;
using NStack;

/// <summary>
/// Main Newmark TUI application using Terminal.Gui.
/// Layout: left sidebar | center chat | right sidebar | bottom terminal
/// Dynamic gradient borders based on agent state.
/// </summary>
public class NewmarkApp
{
    private readonly NewmarkAgent _agent;
    private readonly string _rootPath;

    private Window? _mainWindow;
    private TabView? _leftTabs;
    private TextView? _mdReader;
    private TextView? _chatView;
    private TextField? _promptField;
    private Label? _statusLabel;
    private RadioGroup? _modeSelector;
    private RadioGroup? _inputModeSelector;
    private ComboBox? _modelSelector;
    private ComboBox? _intelSelector;
    private Button? _submitBtn;
    private ComboBox? _workflowCombo;
    private ListView? _workflowList;
    private Button? _selectWfBtn;
    private Button? _refreshWfBtn;
    private Button? _openEditorBtn;
    private Label? _currentWfLabel;
    private FrameView? _leftPanel;
    private FrameView? _rightPanel;
    private FrameView? _bottomPanel;

    private GradientState _gradient = new();
    private string _terminalOutput = "";

    public NewmarkApp(string rootPath)
    {
        _rootPath = rootPath;
        _agent = new NewmarkAgent(rootPath);

        _agent.OnStatusChange += OnAgentStatusChange;
        _agent.OnOutput += OnAgentOutput;
        _agent.OnOptionQuestion += OnAgentOption;
        _agent.OnSubagentOutput += OnSubagentMessage;
    }

    public void Run()
    {
        Application.Init();
        Colors.Base.Normal = Application.Driver.MakeAttribute(Color.Black, Color.White);

        _mainWindow = new Window("Newmark Agent")
        {
            X = 0, Y = 0,
            Width = Dim.Fill(), Height = Dim.Fill()
        };
        Application.Top.Add(_mainWindow);

        BuildLeftPanel();
        BuildCenterPanel();
        BuildRightPanel();
        BuildBottomPanel();
        BuildStatusBar();

        Application.Run();
        Application.Shutdown();
    }

    private void BuildLeftPanel()
    {
        _leftPanel = new FrameView("Workspace & Settings")
        {
            X = 0, Y = 1,
            Width = 30, Height = Dim.Fill(4)
        };

        _leftTabs = new TabView { X = 0, Y = 0, Width = Dim.Fill(), Height = Dim.Fill() };

        var wsTab = new TabView.Tab("Workspace", BuildWorkspaceView());
        var settingsTab = new TabView.Tab("Settings", BuildSettingsView());
        var pluginsTab = new TabView.Tab("Plugins", BuildPluginsView());
        var flowTab = new TabView.Tab("Flow", BuildFlowView());
        var autoTab = new TabView.Tab("Auto", BuildAutoView());

        _leftTabs.AddTab(wsTab, true);
        _leftTabs.AddTab(settingsTab, false);
        _leftTabs.AddTab(pluginsTab, false);
        _leftTabs.AddTab(flowTab, false);
        _leftTabs.AddTab(autoTab, false);

        _leftPanel.Add(_leftTabs);
        _mainWindow?.Add(_leftPanel);
    }

    private View BuildWorkspaceView()
    {
        var view = new View { X = 0, Y = 0, Width = Dim.Fill(), Height = Dim.Fill() };

        var label = new Label("Internal Workspaces:")
        { X = 0, Y = 0, Width = Dim.Fill(), Height = 1 };
        view.Add(label);

        var internalList = new ListView(new List<string>())
        { X = 0, Y = 1, Width = Dim.Fill(), Height = 6 };
        view.Add(internalList);

        var extLabel = new Label("External Workspaces:")
        { X = 0, Y = 8, Width = Dim.Fill(), Height = 1 };
        view.Add(extLabel);

        var externalList = new ListView(new List<string>())
        { X = 0, Y = 9, Width = Dim.Fill(), Height = 6 };
        view.Add(externalList);

        var createBtn = new Button("New Workspace")
        { X = 0, Y = 16, Width = 14 };
        createBtn.Clicked += () =>
        {
            var ws = _agent.Workspace.CreateInternalWorkspace();
            RefreshWorkspaceLists(internalList, externalList);
        };
        view.Add(createBtn);

        var addExtBtn = new Button("Add External")
        { X = 15, Y = 16, Width = 13 };
        addExtBtn.Clicked += () =>
        {
            var dlg = new Dialog("External Path", 60, 8);
            var pathField = new TextField("") { X = 1, Y = 1, Width = 50 };
            dlg.Add(pathField);
            var okBtn = new Button("OK") { X = 10, Y = 3 };
            okBtn.Clicked += () =>
            {
                if (!string.IsNullOrEmpty(pathField.Text.ToString()))
                {
                    _agent.Workspace.AddExternalWorkspace(pathField.Text.ToString()!);
                    RefreshWorkspaceLists(internalList, externalList);
                }
                Application.RequestStop();
            };
            dlg.Add(okBtn);
            Application.Run(dlg);
        };
        view.Add(addExtBtn);

        return view;
    }

    private void RefreshWorkspaceLists(ListView internalList, ListView externalList)
    {
        var ws = _agent.Workspace.ListWorkspaces();
        var intl = ws["internal"] as List<Dictionary<string, object>> ?? new();
        var extl = ws["external"] as List<Dictionary<string, object>> ?? new();

        internalList.SetSource(intl.Select(w => $"{w["name"]}").ToList());
        externalList.SetSource(extl.Select(w => $"{w["name"]}").ToList());
    }

    private View BuildSettingsView()
    {
        var view = new View { X = 0, Y = 0, Width = Dim.Fill(), Height = Dim.Fill() };
        var y = 0;

        view.Add(new Label("Tone:") { X = 0, Y = y, Width = 10 });
        var tonePicker = new RadioGroup(new NStack.ustring[] { "Strict", "Casual" })
        { X = 11, Y = y };
        var currentTone = _agent.Config.Get<string>("general", "tone");
        tonePicker.SelectedItem = currentTone == "casual_friendly" ? 1 : 0;
        tonePicker.SelectedItemChanged += (args) =>
        {
            _agent.Config.Set("general", "tone", args.SelectedItem == 1 ? "casual_friendly" : "strict_simple");
        };
        view.Add(tonePicker);

        y += 2;
        view.Add(new Label("Access:") { X = 0, Y = y, Width = 10 });
        var accessPicker = new RadioGroup(new ustring[] { "Full", "ReadOnly Out", "No Outside" })
        { X = 11, Y = y };
        var access = _agent.Config.Get<string>("workspace", "access_permission");
        accessPicker.SelectedItem = access switch { "outside_readonly" => 1, "no_outside_access" => 2, _ => 0 };
        accessPicker.SelectedItemChanged += (args) =>
        {
            _agent.Config.Set("workspace", "access_permission",
                args.SelectedItem == 1 ? "outside_readonly" : args.SelectedItem == 2 ? "no_outside_access" : "full_access");
        };
        view.Add(accessPicker);

        y += 2;
        var saveBtn = new Button("Save Settings") { X = 0, Y = y };
        saveBtn.Clicked += () => _agent.Config.Save();
        view.Add(saveBtn);

        return view;
    }

    private View BuildPluginsView()
    {
        var view = new View { X = 0, Y = 0, Width = Dim.Fill(), Height = Dim.Fill() };
        view.Add(new Label("Skills & Plugins") { X = 0, Y = 0 });
        view.Add(new Label("Auto-download:") { X = 0, Y = 2 });
        view.Add(new Label(_agent.Config.Get<string>("skills", "auto_download") ?? "conservative")
        { X = 0, Y = 3 });
        return view;
    }

    private View BuildAutoView()
    {
        var view = new View { X = 0, Y = 0, Width = Dim.Fill(), Height = Dim.Fill() };
        view.Add(new Label("Automation") { X = 0, Y = 0 });

        var autoSwitch = new CheckBox("Auto switch model") { X = 0, Y = 2 };
        autoSwitch.Checked = _agent.Config.Get<bool>("models", "auto_switch");
        autoSwitch.Toggled += (oldVal) => _agent.Config.Set("models", "auto_switch", !oldVal);
        view.Add(autoSwitch);

        var autoSettings = new CheckBox("Auto adjust settings") { X = 0, Y = 3 };
        autoSettings.Checked = _agent.Config.Get<bool>("agent", "auto_adjust_settings");
        autoSettings.Toggled += (oldVal) => _agent.Config.Set("agent", "auto_adjust_settings", !oldVal);
        view.Add(autoSettings);

        return view;
    }

    private View BuildFlowView()
    {
        var view = new View { X = 0, Y = 0, Width = Dim.Fill(), Height = Dim.Fill() };

        _currentWfLabel = new Label("Current: (none)")
        { X = 0, Y = 0, Width = Dim.Fill(), Height = 1 };
        view.Add(_currentWfLabel);

        var listLabel = new Label("Workflows:")
        { X = 0, Y = 1, Width = Dim.Fill(), Height = 1 };
        view.Add(listLabel);

        _workflowList = new ListView(new List<string>())
        { X = 0, Y = 2, Width = Dim.Fill(), Height = 6 };
        view.Add(_workflowList);

        _selectWfBtn = new Button("Select") { X = 0, Y = 9, Width = 8 };
        _selectWfBtn.Clicked += () =>
        {
            if (_workflowList?.SelectedItem >= 0)
            {
                var names = _agent.FlowManager.GetWorkflowNames();
                if (_workflowList.SelectedItem < names.Count)
                {
                    _agent.CurrentWorkflow = names[_workflowList.SelectedItem];
                    _currentWfLabel.Text = $"Current: {_agent.CurrentWorkflow}";
                    if (_workflowCombo != null)
                    {
                        var items = new List<string> { "(select)" };
                        items.AddRange(names);
                        _workflowCombo.SelectedItem = items.IndexOf(_agent.CurrentWorkflow);
                        _workflowCombo.SetSource(items);
                    }
                }
            }
        };
        view.Add(_selectWfBtn);

        _refreshWfBtn = new Button("Refresh") { X = 10, Y = 9, Width = 8 };
        _refreshWfBtn.Clicked += () => RefreshFlowList();
        view.Add(_refreshWfBtn);

        _openEditorBtn = new Button("Open Editor") { X = 0, Y = 11, Width = 14 };
        _openEditorBtn.Clicked += () =>
        {
            try
            {
                var editorPath = Path.Combine(_rootPath, "Flow", "FlowEditor.html");
                if (File.Exists(editorPath))
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(editorPath) { UseShellExecute = true });
                else
                    AppendChat("\n[Flow] FlowEditor.html not found.\n");
            }
            catch { AppendChat("\n[Flow] Cannot open editor.\n"); }
        };
        view.Add(_openEditorBtn);

        return view;
    }

    private void RefreshFlowList()
    {
        if (_workflowList == null) return;
        var names = _agent.FlowManager.GetWorkflowNames();
        _workflowList.SetSource(names);
        if (_workflowCombo != null)
        {
            var items = new List<string> { "(select)" };
            items.AddRange(names);
            _workflowCombo.SetSource(items);
            if (!string.IsNullOrEmpty(_agent.CurrentWorkflow))
            {
                var idx = items.IndexOf(_agent.CurrentWorkflow);
                if (idx >= 0) _workflowCombo.SelectedItem = idx;
            }
        }
        _currentWfLabel!.Text = $"Current: {_agent.CurrentWorkflow ?? "(none)"}";
    }

    private void BuildCenterPanel()
    {
        var centerFrame = new FrameView("Conversation")
        {
            X = 31, Y = 1,
            Width = Dim.Fill(31),
            Height = Dim.Fill(5)
        };

        _chatView = new TextView
        {
            X = 0, Y = 0,
            Width = Dim.Fill(), Height = Dim.Fill(4),
            ReadOnly = true
        };
        centerFrame.Add(_chatView);

        var inputFrame = new FrameView("Prompt")
        {
            X = 0, Y = Pos.Bottom(_chatView),
            Width = Dim.Fill(), Height = 4
        };

        var x = 0;
        _modeSelector = new RadioGroup(new ustring[] { "Build", "Plan", "Goal", "Flow" })
        { X = x, Y = 0 };
        _modeSelector.SelectedItem = (int)_agent.CurrentMode;
        _modeSelector.SelectedItemChanged += (args) =>
        {
            _agent.SetMode((AgentMode)args.SelectedItem);
            if ((AgentMode)args.SelectedItem == AgentMode.Flow)
                RefreshFlowList();
        };
        inputFrame.Add(_modeSelector);

        x += 25;
        var wfLabel = new Label("WF:") { X = x, Y = 0, Width = 3 };
        inputFrame.Add(wfLabel);
        _workflowCombo = new ComboBox { X = x + 3, Y = 0, Width = 10 };
        _workflowCombo.SetSource(new List<string> { "(select)" });
        _workflowCombo.SelectedItemChanged += (args) =>
        {
            if (args.Value != null && args.Value.ToString() != "(select)")
            {
                _agent.CurrentWorkflow = args.Value.ToString();
                _currentWfLabel!.Text = $"Current: {_agent.CurrentWorkflow}";
            }
        };
        inputFrame.Add(_workflowCombo);

        x += 16;
        var modelLabel = new Label("Model:") { X = x, Y = 0, Width = 6 };
        inputFrame.Add(modelLabel);
        _modelSelector = new ComboBox { X = x + 6, Y = 0, Width = 12 };
        RefreshModelSelector();
        inputFrame.Add(_modelSelector);

        x += 19;
        var intelLabel = new Label("IQ:") { X = x, Y = 0, Width = 3 };
        inputFrame.Add(intelLabel);
        _intelSelector = new ComboBox { X = x + 3, Y = 0, Width = 8 };
        _intelSelector.SetSource(new List<string> { "low", "medium", "high" });
        _intelSelector.SelectedItem = IndexOfIntelligence(_agent.Intelligence);
        _intelSelector.SelectedItemChanged += (args) =>
            _agent.SetIntelligence(args.Value?.ToString() ?? "medium");
        inputFrame.Add(_intelSelector);

        x += 12;
        _inputModeSelector = new RadioGroup(new ustring[] { "Guide", "Next" })
        { X = x, Y = 0 };
        _inputModeSelector.SelectedItem = (int)_agent.CurrentInput;
        _inputModeSelector.SelectedItemChanged += (args) =>
            _agent.SetInputMode((InputMode)args.SelectedItem);
        inputFrame.Add(_inputModeSelector);

        _promptField = new TextField("")
        { X = 0, Y = 2, Width = Dim.Fill(10), Height = 1 };
        _promptField.KeyPress += (args) =>
        {
            if (args.KeyEvent.Key == Key.Enter && (args.KeyEvent.IsCtrl || !args.KeyEvent.IsCtrl))
            {
                bool ctrlEnter = args.KeyEvent.IsCtrl;
                bool useGuide = _agent.CurrentInput == InputMode.Guide;
                if (ctrlEnter) useGuide = !useGuide;

                var text = _promptField.Text.ToString();
                if (string.IsNullOrWhiteSpace(text)) return;

                if (useGuide)
                {
                    _ = ProcessInputAsync(text);
                }
                else
                {
                    _agent.QueueNextPrompt(text!);
                    AppendChat($"\n[Queued for next round: {text}]");
                }
                _promptField.Text = "";
                args.Handled = true;
            }
        };
        inputFrame.Add(_promptField);

        _submitBtn = new Button("Send")
        { X = Pos.Right(_promptField) - 6, Y = 2, Width = 8 };
        _submitBtn.Clicked += () =>
        {
            var text = _promptField.Text.ToString();
            if (string.IsNullOrWhiteSpace(text)) return;
            var useGuide = _agent.CurrentInput == InputMode.Guide;

            if (useGuide)
                _ = ProcessInputAsync(text);
            else
            {
                _agent.QueueNextPrompt(text!);
                AppendChat($"\n[Queued: {text}]");
            }
            _promptField.Text = "";
        };
        inputFrame.Add(_submitBtn);

        centerFrame.Add(inputFrame);
        _mainWindow?.Add(centerFrame);
    }

    private void RefreshModelSelector()
    {
        var models = _agent.Config.GetAllModels();
        var names = models.Select(m => m.GetValueOrDefault("name", "")?.ToString() ?? "").ToList();
        if (names.Count == 0) names.Add("(no models)");
        _modelSelector?.SetSource(names);
        var current = _agent.CurrentModel;
        _modelSelector!.SelectedItem = names.IndexOf(current);
        _modelSelector!.SelectedItemChanged += (args) =>
        {
            if (args.Value != null)
                _agent.Config.Set("models", "default_model", args.Value.ToString()!);
        };
    }

    private int IndexOfIntelligence(string intel)
    {
        return intel switch { "low" => 0, "medium" => 1, "high" => 2, _ => 1 };
    }

    private void BuildRightPanel()
    {
        _rightPanel = new FrameView("Viewer & Subagents")
        {
            X = Pos.Right(_mainWindow!) - 31, Y = 1,
            Width = 30, Height = Dim.Fill(4)
        };

        var tabs = new TabView { X = 0, Y = 0, Width = Dim.Fill(), Height = Dim.Fill() };

        _mdReader = new TextView { ReadOnly = true };
        tabs.AddTab(new TabView.Tab("MD Reader", _mdReader), true);

        var subagentView = BuildSubagentView();
        tabs.AddTab(new TabView.Tab("Subagents", subagentView), false);

        var browserView = new TextView { ReadOnly = true };
        browserView.Text = "Built-in Browser\n\nEnter URL to render web content.";
        tabs.AddTab(new TabView.Tab("Browser", browserView), false);

        _rightPanel.Add(tabs);
        _mainWindow?.Add(_rightPanel);
    }

    private View BuildSubagentView()
    {
        var view = new View { X = 0, Y = 0, Width = Dim.Fill(), Height = Dim.Fill() };

        var list = new ListView(new List<string> { "(no subagents)" })
        { X = 0, Y = 0, Width = Dim.Fill(), Height = 6 };
        view.Add(list);

        var historyView = new TextView { X = 0, Y = 7, Width = Dim.Fill(), Height = Dim.Fill(), ReadOnly = true };
        view.Add(historyView);

        list.SelectedItemChanged += (args) =>
        {
            var subs = _agent.GetActiveSubagents();
            if (args.Item >= 0 && args.Item < subs.Count)
            {
                var sub = subs[args.Item];
                historyView.Text = System.Text.Json.JsonSerializer.Serialize(
                    sub.GetValueOrDefault("messages", new List<object>()), new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
            }
        };

        return view;
    }

    private void BuildBottomPanel()
    {
        _bottomPanel = new FrameView("Terminal")
        {
            X = 31, Y = Pos.Bottom(_mainWindow!) - 5,
            Width = Dim.Fill(31), Height = 4
        };

        var shellLabel = new Label("Shell:") { X = 0, Y = 0, Width = 6 };
        var shellPicker = new RadioGroup(new ustring[] { "PS", "Bash", "CMD" })
        { X = 6, Y = 0 };
        shellPicker.SelectedItem = _agent.Config.Get<string>("terminal", "default_shell") switch
        {
            "bash" => 1, "cmd" => 2, _ => 0
        };
        shellPicker.SelectedItemChanged += (args) =>
        {
            _agent.Config.Set("terminal", "default_shell",
                args.SelectedItem == 1 ? "bash" : args.SelectedItem == 2 ? "cmd" : "shell");
        };
        _bottomPanel.Add(shellLabel);
        _bottomPanel.Add(shellPicker);

        var cmdField = new TextField("") { X = 0, Y = 1, Width = Dim.Fill(4), Height = 1 };
        cmdField.KeyPress += async (args) =>
        {
            if (args.KeyEvent.Key == Key.Enter)
            {
                var cmd = cmdField.Text.ToString();
                if (string.IsNullOrWhiteSpace(cmd)) return;
                _terminalOutput += $"\n> {cmd}\n";
                var result = await _agent.Tools.Terminal.RunCommandAsync(cmd!);
                _terminalOutput += result + "\n";
                cmdField.Text = "";
                args.Handled = true;
            }
        };
        _bottomPanel.Add(cmdField);

        var runBtn = new Button("Run") { X = Pos.Right(cmdField) - 5, Y = 1, Width = 5 };
        runBtn.Clicked += async () =>
        {
            var cmd = cmdField.Text.ToString();
            if (string.IsNullOrWhiteSpace(cmd)) return;
            _terminalOutput += $"\n> {cmd}\n";
            var result = await _agent.Tools.Terminal.RunCommandAsync(cmd!);
            _terminalOutput += result + "\n";
            cmdField.Text = "";
        };
        _bottomPanel.Add(runBtn);

        _mainWindow?.Add(_bottomPanel);
    }

    private void BuildStatusBar()
    {
        _statusLabel = new Label("Ready | Mode: Build | Model: none")
        {
            X = 0, Y = Pos.Bottom(_mainWindow!) - 1,
            Width = Dim.Fill(), Height = 1,
            ColorScheme = new ColorScheme { Normal = Terminal.Gui.Application.Driver.MakeAttribute(Color.White, Color.Blue) }
        };
        _mainWindow?.Add(_statusLabel);
    }

    private async Task ProcessInputAsync(string input)
    {
        AppendChat($"\n[User]: {input}\n");
        AppendChat($"[Assistant ({_agent.CurrentMode}, {_agent.CurrentModel})]: ");

        await foreach (var token in _agent.ProcessAsync(input))
        {
        }

        AppendChat("\n---\n");
    }

    private void AppendChat(string text)
    {
        Application.MainLoop.Invoke(() =>
        {
            if (_chatView != null)
            {
                _chatView.Text += text;
                _chatView.CursorPosition = new Point(0, _chatView.Lines - 1);
                _chatView.SetNeedsDisplay();
            }
        });
    }

    private void OnAgentStatusChange(AgentStatus status)
    {
        Application.MainLoop.Invoke(() =>
        {
            var statusText = status switch
            {
                AgentStatus.Working => "Working...",
                AgentStatus.Error => "Error",
                AgentStatus.GoalWorking => "Goal: Working",
                AgentStatus.GoalComplete => "Goal: Complete!",
                AgentStatus.Planning => "Planning",
                _ => "Ready"
            };
            if (_statusLabel != null)
                _statusLabel.Text = $"{statusText} | Mode: {_agent.CurrentMode} | Model: {_agent.CurrentModel}";

            _gradient.SetState(status switch
            {
                AgentStatus.Working => "working",
                AgentStatus.Error => "error",
                AgentStatus.GoalWorking => "goal_continue",
                AgentStatus.GoalComplete => "goal_complete",
                AgentStatus.Planning => "planning",
                _ => "idle"
            });
            ApplyGradient();
        });
    }

    private void OnAgentOutput(string text)
    {
        Application.MainLoop.Invoke(() =>
        {
            if (_chatView != null)
            {
                _chatView.Text += text;
                _chatView.SetNeedsDisplay();
            }
        });
    }

    private void OnAgentOption(OptionQuestion question)
    {
        Application.MainLoop.Invoke(() =>
        {
            var optionLevel = _agent.Config.Get<string>("agent", "option_feedback");
            if (optionLevel == "fully_autonomous") return;

            AppendChat($"\n[{question.Header}] {question.Question}\n");
            for (int i = 0; i < question.Options.Count; i++)
                AppendChat($"  [{i + 1}] {question.Options[i].Label} - {question.Options[i].Description}\n");
        });
    }

    private void OnSubagentMessage(string msg)
    {
        AppendChat($"\n[Subagent] {msg}\n");
    }

    private void ApplyGradient()
    {
        var (gradientCSS, startColor, endColor) = _gradient.GetGradientColors();
    }
}
