namespace Newmark.Utils;

/// <summary>
/// Dynamic gradient border state machine for agent status visualization.
/// Generates CSS-compatible gradient colors that animate based on agent state.
/// </summary>
public class GradientState
{
    private int _colorIndex;
    private double _phase;
    private bool _increasing = true;
    private readonly List<string> _defaultColors = new() { "#00ff88", "#00ccff", "#aa44ff", "#ff4488" };

    public string CurrentState { get; private set; } = "idle";
    public List<string> Colors { get; set; }
    public double Speed { get; set; } = 2;
    public int Width { get; set; } = 2;

    public GradientState(List<string>? colors = null, double speed = 2, int width = 2)
    {
        Colors = colors ?? new List<string>(_defaultColors);
        Speed = speed;
        Width = width;
    }

    public void SetState(string state)
    {
        CurrentState = state;
        _phase = 0;
    }

    public void TransitionMode(string from, string to)
    {
        CurrentState = "transitioning";
        _phase = 0;
    }

    public void TransitionIntelligence(string tier)
    {
        _phase += 0.5;
    }

    public string GetCurrentGradientCSS()
    {
        double offset = _colorIndex + _phase;
        if (_increasing)
        {
            _colorIndex++;
            if (_colorIndex >= Colors.Count - 1) _increasing = false;
        }
        else
        {
            _colorIndex--;
            if (_colorIndex <= 0) _increasing = true;
        }

        int idx = _colorIndex % Colors.Count;
        int nextIdx = (_colorIndex + 1) % Colors.Count;

        return CurrentState switch
        {
            "working" => $"linear-gradient(90deg, {Colors[idx]}, {Colors[nextIdx]})",
            "error" => "linear-gradient(90deg, #ff4444, #ff8800)",
            "idle" => $"linear-gradient(90deg, {Colors[0]}, {Colors[^1]})",
            "goal" => $"linear-gradient(90deg, {Colors[0]}, {Colors[2]}, {Colors[3]})",
            "goal_continue" => $"linear-gradient(135deg, {Colors[1]}, {Colors[2]})",
            "goal_complete" => "linear-gradient(90deg, #00ff88, #00ff88)",
            "planning" => $"linear-gradient(90deg, {Colors[1]}, {Colors[3]})",
            "transitioning" => $"linear-gradient(45deg, {Colors[idx]}, {Colors[nextIdx]})",
            _ => $"linear-gradient(90deg, {Colors[0]}, {Colors[^1]})"
        };
    }

    public (string, string, string) GetGradientColors()
    {
        string gradient = GetCurrentGradientCSS();
        string startColor = Colors[_colorIndex % Colors.Count];
        string endColor = Colors[(_colorIndex + 1) % Colors.Count];

        if (CurrentState == "error")
        {
            startColor = "#ff4444";
            endColor = "#ff8800";
        }

        return (gradient, startColor, endColor);
    }
}
