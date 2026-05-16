using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace JadAppsRunner.Core;

/// <summary>
/// Loopback HTTP client for the Node sidecar's <c>/v1/settings</c>
/// endpoint. The tray-menu's Output Folder picker and the future
/// Settings page consume this — both write through the sidecar so
/// the SQLite-backed settings store stays the single source of truth.
/// </summary>
/// <remarks>
/// Bearer auth uses the pairing token the sidecar wrote at boot to
/// <c>%USERPROFILE%\.jadapps-runner\pairing-token</c>. Same scheme as
/// the Tauri host (<c>src-tauri/src/settings_client.rs</c>).
/// </remarks>
public sealed class SettingsClient
{
    private const string DefaultHost = "127.0.0.1";
    private const int DefaultPort = 9789;

    private readonly HttpClient _http;
    private readonly Func<string?> _tokenProvider;

    public SettingsClient(HttpClient http, Func<string?>? tokenProvider = null)
    {
        _http = http;
        _tokenProvider = tokenProvider ?? DefaultTokenProvider;
        _http.Timeout = TimeSpan.FromSeconds(3);
        _http.BaseAddress = new Uri($"http://{DefaultHost}:{DefaultPort}");
    }

    /// <summary>GET /v1/settings.</summary>
    public async Task<RunnerSettings> GetAsync(CancellationToken ct = default)
    {
        using var req = NewRequest(HttpMethod.Get, "/v1/settings", null);
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        res.EnsureSuccessStatusCode();
        var body = await res.Content.ReadFromJsonAsync<RunnerSettings>(ct).ConfigureAwait(false);
        return body ?? throw new InvalidOperationException("empty /v1/settings response");
    }

    /// <summary>PATCH /v1/settings — returns the merged result.</summary>
    public async Task<RunnerSettings> PatchAsync(SettingsPatch patch, CancellationToken ct = default)
    {
        using var req = NewRequest(HttpMethod.Patch, "/v1/settings", patch);
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
        {
            var text = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            throw new HttpRequestException(
                $"runner returned {(int)res.StatusCode}: {text}");
        }
        var body = await res.Content.ReadFromJsonAsync<RunnerSettings>(ct).ConfigureAwait(false);
        return body ?? throw new InvalidOperationException("empty PATCH response");
    }

    private HttpRequestMessage NewRequest(HttpMethod method, string path, object? body)
    {
        var req = new HttpRequestMessage(method, path);
        var token = _tokenProvider();
        if (!string.IsNullOrEmpty(token))
        {
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }
        if (body is not null)
        {
            req.Content = JsonContent.Create(body);
        }
        return req;
    }

    /// <summary>Reads the sidecar's pairing token from disk.</summary>
    private static string? DefaultTokenProvider()
    {
        var path = PathResolver.PairingTokenPath();
        if (!File.Exists(path))
        {
            return null;
        }
        try
        {
            return File.ReadAllText(path).Trim();
        }
        catch
        {
            return null;
        }
    }
}

/// <summary>
/// Full settings shape — mirror of <c>RunnerSettings</c> in
/// <c>src/settings/store.ts</c>.
/// </summary>
public sealed record RunnerSettings
{
    [JsonPropertyName("outputDir")]
    public required string OutputDir { get; init; }

    [JsonPropertyName("perToolSubfolders")]
    public bool PerToolSubfolders { get; init; }

    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; init; }
}

/// <summary>
/// Partial-update payload for PATCH /v1/settings. Null fields are
/// omitted from the serialized JSON so the runner treats them as
/// "leave unchanged".
/// </summary>
public sealed class SettingsPatch
{
    [JsonPropertyName("outputDir")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? OutputDir { get; init; }

    [JsonPropertyName("perToolSubfolders")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? PerToolSubfolders { get; init; }
}
