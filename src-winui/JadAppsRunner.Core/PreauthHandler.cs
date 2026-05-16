using System.Text.Json;
using System.Text.Json.Serialization;
using System.Web;

namespace JadAppsRunner.Core;

/// <summary>
/// Parses <c>jadapps-runner://pair?token=...&amp;name=...&amp;platform=...</c>
/// activation URLs and writes the captured token to the marker file
/// the Node sidecar consumes at boot.
/// </summary>
/// <remarks>
/// Wire-format parity with the Rust implementation in
/// <c>src-tauri/src/preauth.rs</c>. Field names match what
/// <c>maybeRedeemPreauth()</c> in <c>src/runner.ts</c> expects.
/// </remarks>
public static class PreauthHandler
{
    public const string ProtocolScheme = "jadapps-runner";
    public const string MarkerFilename = "preauth.json";

    /// <summary>
    /// Parse a pair URL into a marker payload. Returns null when the
    /// URL is for a different action / scheme / missing the token.
    /// Mirrors <c>preauth::parse_pair_url</c> in Rust.
    /// </summary>
    public static PreauthMarker? ParsePairUrl(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }
        var trimmed = raw.Trim();
        var prefix = ProtocolScheme + "://";
        if (!trimmed.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        var rest = trimmed[prefix.Length..];

        string path;
        string query;
        var qIdx = rest.IndexOf('?');
        if (qIdx < 0)
        {
            path = rest;
            query = "";
        }
        else
        {
            path = rest[..qIdx];
            query = rest[(qIdx + 1)..];
        }

        var action = path.Trim('/');
        if (!string.Equals(action, "pair", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        string? token = null;
        string? name = null;
        string? platform = null;
        foreach (var pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eqIdx = pair.IndexOf('=');
            var k = eqIdx < 0 ? pair : pair[..eqIdx];
            var v = eqIdx < 0 ? "" : HttpUtility.UrlDecode(pair[(eqIdx + 1)..]);
            switch (k)
            {
                case "token":
                    token = v;
                    break;
                case "name":
                    name = v;
                    break;
                case "platform":
                    platform = v;
                    break;
            }
        }

        if (string.IsNullOrEmpty(token))
        {
            return null;
        }
        return new PreauthMarker
        {
            PreauthToken = token,
            DeviceName = string.IsNullOrEmpty(name) ? null : name,
            PlatformTag = string.IsNullOrEmpty(platform) ? null : platform,
        };
    }

    /// <summary>
    /// Scan an args array for the first <c>jadapps-runner://</c> URL
    /// and parse it. Used at cold-launch (Environment.GetCommandLineArgs())
    /// and on activation events.
    /// </summary>
    public static PreauthMarker? ExtractFromArgs(IEnumerable<string> args)
    {
        var prefix = ProtocolScheme + "://";
        foreach (var a in args)
        {
            if (a.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                var parsed = ParsePairUrl(a);
                if (parsed is not null)
                {
                    return parsed;
                }
            }
        }
        return null;
    }

    /// <summary>
    /// Write the marker to <c>%USERPROFILE%\.jadapps-runner\preauth.json</c>
    /// for the Node sidecar to consume on next boot/restart.
    /// </summary>
    public static string WriteMarker(string dataDir, PreauthMarker marker)
    {
        Directory.CreateDirectory(dataDir);
        var target = Path.Combine(dataDir, MarkerFilename);
        var json = JsonSerializer.Serialize(marker, MarkerSerializerOptions);
        File.WriteAllText(target, json);
        return target;
    }

    private static readonly JsonSerializerOptions MarkerSerializerOptions = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}

/// <summary>
/// Marker payload. Property names ride the wire as camelCase so they
/// match the JSON shape <c>maybeRedeemPreauth()</c> in Node expects.
/// </summary>
public sealed class PreauthMarker
{
    [JsonPropertyName("preauthToken")]
    public required string PreauthToken { get; init; }

    [JsonPropertyName("deviceName")]
    public string? DeviceName { get; init; }

    [JsonPropertyName("platformTag")]
    public string? PlatformTag { get; init; }
}
