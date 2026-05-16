namespace JadAppsRunner.Core;

/// <summary>
/// Resolves on-disk paths the runner uses. Single source of truth for
/// <c>%USERPROFILE%\.jadapps-runner</c> + child paths, kept in sync
/// with <c>src/config.ts</c> and <c>src-tauri/src/core/config.rs</c>.
/// </summary>
public static class PathResolver
{
    /// <summary>
    /// <c>%USERPROFILE%\.jadapps-runner</c>, or just <c>.\.jadapps-runner</c>
    /// when the user-profile dir is unavailable.
    /// </summary>
    public static string DataDir()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (string.IsNullOrEmpty(home))
        {
            home = ".";
        }
        return Path.Combine(home, ".jadapps-runner");
    }

    /// <summary>
    /// <c>%USERPROFILE%\.jadapps-runner\preauth.json</c> — Node sidecar
    /// scans this on boot and redeems the embedded token.
    /// </summary>
    public static string PreauthMarkerPath() => Path.Combine(DataDir(), "preauth.json");

    /// <summary>
    /// <c>%USERPROFILE%\.jadapps-runner\pairing-token</c> — Bearer token
    /// the WinUI3 host uses to call <c>/v1/*</c> on the local sidecar.
    /// </summary>
    public static string PairingTokenPath() => Path.Combine(DataDir(), "pairing-token");

    /// <summary>Logs directory; created on first write.</summary>
    public static string LogsDir() => Path.Combine(DataDir(), "logs");

    /// <summary>
    /// Resolves the bundled <c>cli.js</c>. The MSIX layout drops the
    /// staged runtime bundle under <c>&lt;appdir&gt;\Assets\runtime-bundle\</c>;
    /// dev builds run against <c>&lt;repo&gt;\dist\cli.js</c>.
    /// </summary>
    public static string SidecarEntry(string appBaseDir)
    {
        return Path.Combine(appBaseDir, "Assets", "runtime-bundle", "cli.js");
    }

    /// <summary>
    /// Resolves the bundled Node binary. Matches the staging script's
    /// <c>node.exe</c> drop next to <c>cli.js</c>.
    /// </summary>
    public static string SidecarNode(string appBaseDir)
    {
        return Path.Combine(appBaseDir, "Assets", "runtime-bundle", "node.exe");
    }
}
