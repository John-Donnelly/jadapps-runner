using System;
using System.IO;
using System.Net.Http;
using JadAppsRunner.Core;
using Microsoft.UI.Xaml;

namespace JadAppsRunner.Host;

/// <summary>
/// WinUI3 entry point. Tray-only — no main window. Responsibilities:
///   1. Cold-launch protocol activation (parses jadapps-runner:// from
///      Environment.GetCommandLineArgs() and writes the preauth marker).
///   2. Starts the SidecarSupervisor (manages the Node process).
///   3. Hands off to TrayMenu for the user-visible surface.
///
/// Hot-activation (URL arrives while the app is already running)
/// is wired through Microsoft.Windows.AppLifecycle.AppInstance — see
/// <see cref="OnLaunched"/>.
/// </summary>
public partial class App : Application
{
    private SidecarSupervisor? _supervisor;
    private TrayMenu? _tray;
    private readonly HttpClient _http = new();

    public App()
    {
        InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        // Cold-launch preauth capture. Drops the marker BEFORE the
        // sidecar boots so its maybeRedeemPreauth() hook picks it up
        // on first start.
        var marker = PreauthHandler.ExtractFromArgs(Environment.GetCommandLineArgs());
        if (marker is not null)
        {
            try
            {
                var path = PreauthHandler.WriteMarker(PathResolver.DataDir(), marker);
                Console.Error.WriteLine($"preauth marker written: {path}");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"preauth marker write failed: {ex.Message}");
            }
        }

        var appBase = AppContext.BaseDirectory;
        var nodeExe = PathResolver.SidecarNode(appBase);
        var cliJs = PathResolver.SidecarEntry(appBase);
        if (!File.Exists(nodeExe))
        {
            nodeExe = "node"; // fall back to PATH for dev runs
        }

        _supervisor = new SidecarSupervisor(
            nodePath: nodeExe,
            cliPath: cliJs,
            port: 9789,
            logSink: line => Console.Error.WriteLine($"[sidecar] {line}"));
        _ = _supervisor.StartAsync();

        var settings = new SettingsClient(_http);
        _tray = new TrayMenu(_supervisor, settings);
        _tray.Show();
    }
}
