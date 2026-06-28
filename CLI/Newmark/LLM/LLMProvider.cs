namespace Newmark.LLM;

using System.Text;
using System.Text.Json;

public class StreamToken { public string Type = "text"; public string Text = ""; public ToolCallRequest? ToolCall; }
public class ToolCallRequest { public string Id = "", Name = "", Arguments = ""; }

/// <summary>
/// OpenAI-compatible LLM provider. Handles API calls, streaming, and model validation.
/// </summary>
public class LLMProvider
{
    private readonly HttpClient _http;
    public string Name { get; }
    public string BaseUrl { get; }
    public string ApiKey { get; }

    public LLMProvider(string name, string baseUrl, string apiKey)
    {
        Name = name;
        BaseUrl = baseUrl;
        ApiKey = apiKey;
        _http = new HttpClient
        {
            BaseAddress = new Uri(baseUrl),
            Timeout = TimeSpan.FromMinutes(5)
        };
        _http.DefaultRequestHeaders.Add("Authorization", $"Bearer {apiKey}");
    }

    public async IAsyncEnumerable<string> ChatStreamAsync(string model, List<Dictionary<string, object>> messages,
        string? system = null, double temperature = 0.7, int maxTokens = 8192)
    {
        var payload = BuildPayload(model, messages, system, temperature, maxTokens, stream: true);
        var content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        var request = new HttpRequestMessage(HttpMethod.Post, "chat/completions") { Content = content };
        HttpResponseMessage response;
        try { response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead); }
        catch { yield break; }
        response.EnsureSuccessStatusCode();

        using var stream = await response.Content.ReadAsStreamAsync();
        using var reader = new StreamReader(stream);

        while (!reader.EndOfStream)
        {
            var line = await reader.ReadLineAsync();
            if (string.IsNullOrEmpty(line) || !line.StartsWith("data: ")) continue;
            var data = line[6..];
            if (data == "[DONE]") break;

            JsonDocument jsonDoc;
            try { jsonDoc = JsonDocument.Parse(data); }
            catch { continue; }

            var choices = jsonDoc.RootElement.GetProperty("choices");
            if (choices.GetArrayLength() > 0)
            {
                var delta = choices[0].GetProperty("delta");
                if (delta.TryGetProperty("content", out var contentEl))
                {
                    var token = contentEl.GetString();
                    if (token != null) yield return token;
                }
            }
        }
    }

    public async Task<string> ChatAsync(string model, List<Dictionary<string, object>> messages,
        string? system = null, double temperature = 0.7, int maxTokens = 8192)
    {
        var payload = BuildPayload(model, messages, system, temperature, maxTokens, stream: false);
        var content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        var response = await _http.PostAsync("chat/completions", content);
        response.EnsureSuccessStatusCode();
        var json = await response.Content.ReadAsStringAsync();
        var doc = JsonDocument.Parse(json);
        return doc.RootElement.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString() ?? "";
    }

    public async Task<Dictionary<string, object>> ValidateAsync(string model)
    {
        var start = DateTime.UtcNow;
        try
        {
            var payload = new Dictionary<string, object>
            {
                ["model"] = model,
                ["messages"] = new[] { new { role = "user", content = "Say OK" } },
                ["max_tokens"] = 10
            };
            var content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
            var response = await _http.PostAsync("chat/completions", content);
            response.EnsureSuccessStatusCode();

            var latency = (DateTime.UtcNow - start).TotalSeconds;
            var json = await response.Content.ReadAsStringAsync();
            var doc = JsonDocument.Parse(json);
            var reply = doc.RootElement.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString() ?? "";

            return new Dictionary<string, object>
            {
                ["valid"] = true, ["model"] = model,
                ["latency_seconds"] = Math.Round(latency, 2), ["response"] = reply, ["error"] = ""
            };
        }
        catch (Exception ex)
        {
            return new Dictionary<string, object>
            {
                ["valid"] = false, ["model"] = model,
                ["latency_seconds"] = 0d, ["response"] = "", ["error"] = ex.Message
            };
        }
    }

    public async Task<Dictionary<string, object>> ValidateVisionAsync(string model)
    {
        try
        {
            var payload = new Dictionary<string, object>
            {
                ["model"] = model,
                ["messages"] = new[] { new {
                    role = "user",
                    content = new object[] {
                        new { type = "text", text = "Reply just YES or NO: can you see this?" },
                        new { type = "image_url", image_url = new { url = "https://placehold.co/1x1/png" } }
                    }
                }},
                ["max_tokens"] = 10
            };
            var content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
            var response = await _http.PostAsync("chat/completions", content);
            response.EnsureSuccessStatusCode();
            var json = await response.Content.ReadAsStringAsync();
            var doc = JsonDocument.Parse(json);
            var reply = doc.RootElement.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString() ?? "";

            return new Dictionary<string, object>
            {
                ["supports_vision"] = reply.Contains("YES", StringComparison.OrdinalIgnoreCase),
                ["response"] = reply, ["error"] = ""
            };
        }
        catch (Exception ex)
        {
            return new Dictionary<string, object>
            {
                ["supports_vision"] = false, ["response"] = "", ["error"] = ex.Message
            };
        }
    }

    public async Task<List<string>> ListModelsAsync()
    {
        try
        {
            var response = await _http.GetAsync("models");
            response.EnsureSuccessStatusCode();
            var json = await response.Content.ReadAsStringAsync();
            var doc = JsonDocument.Parse(json);
            var models = new List<string>();
            foreach (var m in doc.RootElement.GetProperty("data").EnumerateArray())
            {
                var name = m.GetProperty("id").GetString();
                if (name != null) models.Add(name);
            }
            return models;
        }
        catch { return new List<string>(); }
    }

    public Dictionary<string, object> GetIntelligenceConfig(string tier) => tier switch
    {
        "low" => new() { ["temperature"] = 0.3, ["max_tokens"] = 2048 },
        "medium" => new() { ["temperature"] = 0.7, ["max_tokens"] = 8192 },
        "high" => new() { ["temperature"] = 0.5, ["max_tokens"] = 16384 },
        _ => new() { ["temperature"] = 0.7, ["max_tokens"] = 8192 }
    };

    public async IAsyncEnumerable<StreamToken> ChatStreamWithToolsAsync(string model,
        List<Dictionary<string, object>> messages, string? system, double temperature, int maxTokens,
        List<Dictionary<string, object>> tools, bool isFirstRound)
    {
        var payload = BuildToolPayload(model, messages, system, temperature, maxTokens, stream: true, tools);
        var content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        var request = new HttpRequestMessage(HttpMethod.Post, "chat/completions") { Content = content };

        HttpResponseMessage? response = null;
        string? llmError = null;
        try { response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead); response!.EnsureSuccessStatusCode(); }
        catch (Exception ex) { llmError = $"[LLM Error] {ex.Message}"; }
        if (llmError != null) { yield return new StreamToken { Type = "text", Text = llmError }; yield break; }

        using var stream = await response.Content.ReadAsStreamAsync();
        using var reader = new StreamReader(stream);

        var tcAccum = new Dictionary<int, ToolCallAccum>();
        while (!reader.EndOfStream)
        {
            var line = await reader.ReadLineAsync();
            if (string.IsNullOrEmpty(line) || !line.StartsWith("data: ")) continue;
            var data = line[6..]; if (data == "[DONE]") break;

            JsonDocument? doc = null;
            try { doc = JsonDocument.Parse(data); } catch { continue; }
            if (doc == null) continue;

            using (doc)
            {
                var choices = doc.RootElement.GetProperty("choices");
                if (choices.GetArrayLength() == 0) continue;
                var delta = choices[0].GetProperty("delta");

                if (delta.TryGetProperty("content", out var ce) && ce.GetString() is string tc)
                    yield return new StreamToken { Type = "text", Text = tc };

                if (delta.TryGetProperty("tool_calls", out var toolCalls))
                {
                    foreach (var tcEl in toolCalls.EnumerateArray())
                    {
                        int idx = tcEl.GetProperty("index").GetInt32();
                        if (!tcAccum.ContainsKey(idx)) tcAccum[idx] = new ToolCallAccum();
                        var a = tcAccum[idx];
                        if (tcEl.TryGetProperty("id", out var idEl) && idEl.GetString() is string id) a.Id = id;
                        if (tcEl.TryGetProperty("function", out var fn))
                        {
                            if (fn.TryGetProperty("name", out var nm) && nm.GetString() is string n) a.Name = n;
                            if (fn.TryGetProperty("arguments", out var ar) && ar.GetString() is string ag) a.Args += ag;
                        }
                    }
                }
            }
        }

        foreach (var (_, a) in tcAccum.OrderBy(kv => kv.Key))
        {
            yield return new StreamToken
            {
                Type = "tool_call",
                ToolCall = new ToolCallRequest { Id = a.Id, Name = a.Name, Arguments = a.Args }
            };
        }
    }

    private Dictionary<string, object> BuildToolPayload(string model, List<Dictionary<string, object>> messages,
        string? system, double temperature, int maxTokens, bool stream, List<Dictionary<string, object>> tools)
    {
        var fullMessages = new List<object>();
        if (!string.IsNullOrEmpty(system))
            fullMessages.Add(new { role = "system", content = system });
        foreach (var m in messages)
        {
            var role = m.GetValueOrDefault("role", "user")?.ToString() ?? "user";
            if (role == "tool")
            {
                fullMessages.Add(new {
                    role = "tool",
                    tool_call_id = m.GetValueOrDefault("tool_call_id", ""),
                    content = m.GetValueOrDefault("content", "")
                });
            }
            else if (m.TryGetValue("tool_calls", out var tcs) && tcs is List<Dictionary<string, object>> tcList)
            {
                fullMessages.Add(new {
                    role = "assistant",
                    content = m.GetValueOrDefault("content", ""),
                    tool_calls = tcList
                });
            }
            else
            {
                fullMessages.Add(new { role = role, content = m.GetValueOrDefault("content", "") });
            }
        }

        return new Dictionary<string, object>
        {
            ["model"] = model, ["messages"] = fullMessages,
            ["temperature"] = temperature, ["max_tokens"] = maxTokens,
            ["stream"] = stream, ["tools"] = tools,
            ["tool_choice"] = "auto"
        };
    }

    private class ToolCallAccum { public string Id = "", Name = "", Args = ""; }

    private Dictionary<string, object> BuildPayload(string model, List<Dictionary<string, object>> messages,
        string? system, double temperature, int maxTokens, bool stream)
    {
        var fullMessages = new List<object>();
        if (!string.IsNullOrEmpty(system))
            fullMessages.Add(new { role = "system", content = system });
        foreach (var msg in messages)
            fullMessages.Add(msg);

        var payload = new Dictionary<string, object>
        {
            ["model"] = model,
            ["messages"] = fullMessages,
            ["temperature"] = temperature,
            ["max_tokens"] = maxTokens
        };
        if (stream) payload["stream"] = true;
        return payload;
    }
}
