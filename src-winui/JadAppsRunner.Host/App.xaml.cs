using System;
using System.IO;
using System.Net.Http;
using JadAppsRunner.Core;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;
using WinRT.Interop;

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
    private Window? _ownerWindow;
    private IntPtr _ownerHwnd;
    private SidecarFileLogger? _stdoutLog;
    private SidecarFileLogger? _stderrLog;
    private SidecarFileLogger? _hostLog;
    private readonly HttpClient _http = new();

    public App()
    {
        InitializeComponent();
    }

    /// <summary>
    /// Hidden owner window's HWND, exposed so the FolderPicker dialog
    /// can call <c>InitializeWithWindow.Initialize(picker, hwnd)</c>.
    /// Without this the picker has no owner and unpackaged dev runs
    /// fail outright; even MSIX-packaged runs benefit because the
    /// dialog otherwise opens in an unpredictable z-order.
    /// </summary>
    public IntPtr OwnerHwnd => _ownerHwnd;

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        // Cold-launch preauth capture. Drops the marker BEFORE the
        // sidecar boots so its maybeRedeemPreauth() hook picks it up
        // on first start.
        CapturePreauthIfPresent(Environment.GetCommandLineArgs(), "cold-launch argv");

        // Subscribe to redirected activations. When a second launch
        // hits AppInstance.RedirectActivationToAsync, this fires on
        // the primary instance — used to catch jadapps-runner:// URLs
        // arriving after first boot.
        AppInstance.GetCurrent().Activated += OnRedirectedActivation;

        var appBase = AppContext.BaseDirectory;
        var nodeExe = PathResolver.SidecarNode(appBase);
        var cliJs = PathResolver.SidecarEntry(appBase);
        if (!File.Exists(nodeExe))
        {
            nodeExe = "node"; // fall back to PATH for dev runs
        }

        // File loggers for the sidecar pipes. Each line emitted by
        // the SidecarSupervisor's logSink is tagged "[stdout]" /
        // "[stderr]" / supervisor-internal; route them to separate
        // log files so the layout matches src-tauri/src/sidecar.rs
        // and Get-Content -Wait tails are useful.
        _stdoutLog = new SidecarFileLogger("sidecar.stdout.log");
        _stderrLog = new SidecarFileLogger("sidecar.stderr.log");
        _hostLog = new SidecarFileLogger("host.log");

        _supervisor = new SidecarSupervisor(
            nodePath: nodeExe,
            cliPath: cliJs,
            port: 9789,
            logSink: RouteSidecarLine);
        _ = _supervisor.StartAsync();

        // Hidden owner window. Required because WinUI3 dialogs
        // (FolderPicker, FileSavePicker, MessageDialog) need an HWND
        // anchor — there's no implicit "current window" in WinUI3
        // like there was in UWP. The window is kept off-screen and
        // never shown to the user.
        _ownerWindow = new Window();
        _ownerHwnd = WindowNative.GetWindowHandle(_ownerWindow);

        var settings = new SettingsClient(_http);
        _tray = new TrayMenu(_supervisor, settings, () => OwnerHwnd);
        _tray.Show();
    }

    /// <summary>
    /// Fires when a "second" Host launch redirected its activation to
    /// us via AppInstance.RedirectActivationToAsync. Pulls the URL
    /// out of the protocol-activation args and writes the marker —
    /// then asks the running sidecar to restart so its preauth hook
    /// consumes the marker on next boot.
    /// </summary>
    private void OnRedirectedActivation(object? sender, AppActivationArguments e)
    {
        try
        {
            if (e.Kind == ExtendedActivationKind.Protocol &&
                e.Data is Windows.ApplicationModel.Activation.IProtocolActivatedEventArgs proto)
            {
                CapturePreauthIfPresent(new[] { proto.Uri.AbsoluteUri }, "redirected protocol activation");
                _ = _supervisor?.RestartAsync();
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"redirected activation handler failed: {ex.Message}");
        }
    }

    private static void CapturePreauthIfPresent(string[] args, string source)
    {
        var marker = PreauthHandler.ExtractFromArgs(args);
        if (marker is null)
        {
            return;
        }
        try
        {
            var path = PreauthHandler.WriteMarker(PathResolver.DataDir(), marker);
            Console.Error.WriteLine($"preauth marker written ({source}): {path}");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"preauth marker write failed ({source}): {ex.Message}");
        }
    }

    /// <summary>
    /// Tag dispatcher for sidecar log lines. The SidecarSupervisor
    /// prefixes its own lines with "[stdout] " / "[stderr] " when it
    /// pipes from the child; anything else is supervisor-internal
    /// chatter (spawn / exit / backoff messages).
    /// </summary>
    private void RouteSidecarLine(string line)
    {
        if (line.StartsWith("[stdout] ", StringComparison.Ordinal))
        {
            _stdoutLog?.WriteLine(line.Substring("[stdout] ".Length));
        }
        else if (line.StartsWith("[stderr] ", StringComparison.Ordinal))
        {
            _stderrLog?.WriteLine(line.Substring("[stderr] ".Length));
        }
        else
        {
            _hostLog?.WriteLine(line);
        }
    }
}
