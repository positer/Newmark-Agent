namespace Newmark.Tools;

using System.Text.RegularExpressions;
using Newmark.Engine;

/// <summary>
/// Web search and web fetch tools.
/// </summary>
public class WebTools
{
    private readonly NewmarkAgent _agent;
    private readonly HttpClient _http;

    public WebTools(NewmarkAgent agent)
    {
        _agent = agent;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        _http.DefaultRequestHeaders.Add("User-Agent", "Newmark-Agent/1.0");
    }

    public async Task<string> SearchAsync(string query)
    {
        if (!_agent.Config.Get<bool>("web", "search_enabled")) return "[Search disabled]";
        try
        {
            string encoded = Uri.EscapeDataString(query);
            string url = $"https://html.duckduckgo.com/html/?q={encoded}";
            string html = await _http.GetStringAsync(url);

            var results = new List<string>();
            var matches = Regex.Matches(html, @"class=""result__snippet"">(.*?)</a>", RegexOptions.Singleline);

            foreach (Match match in matches.Take(5))
            {
                string snippet = Regex.Replace(match.Groups[1].Value, "<[^>]+>", "");
                results.Add(snippet.Trim());
            }

            return results.Count > 0 ? string.Join("\n\n", results) : "No results found.";
        }
        catch (Exception ex) { return $"Search error: {ex.Message}"; }
    }

    public async Task<string> FetchAsync(string url)
    {
        if (!_agent.Config.Get<bool>("web", "fetch_enabled")) return "[Fetch disabled]";
        try
        {
            string html = await _http.GetStringAsync(url);
            string text = Regex.Replace(html, @"<script[^>]*>.*?</script>", "", RegexOptions.Singleline | RegexOptions.IgnoreCase);
            text = Regex.Replace(text, @"<style[^>]*>.*?</style>", "", RegexOptions.Singleline | RegexOptions.IgnoreCase);
            text = Regex.Replace(text, @"<[^>]+>", " ");
            text = Regex.Replace(text, @"\s+", " ").Trim();
            return text.Length > 5000 ? text[..5000] + "..." : text;
        }
        catch (Exception ex) { return $"Fetch error: {ex.Message}"; }
    }
}
