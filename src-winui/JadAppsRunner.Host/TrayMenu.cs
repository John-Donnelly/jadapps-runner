using System;
using System.Diagnostics;
using System.IO;
using H.NotifyIcon;
using JadAppsRunner.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Storage.Pickers;
using WinRT.Interop;

namespace JadAppsRunner.Host;

/// <summary>
/// Tray icon + context menu. Mirrors the Tauri tray surface from
/// <c>src-tauri/src/tray.rs</c>:
///   - Status row (Running / Stopped)
///   - Start / Restart / Stop
///   - Open Dashboard (browser)
///   - Output Folder picker + Open Output Folder
///   - Quit
///
/// Auto-launch and "Check for Updates" toggles will land alongside
/// the Settings window in a follow-up — this scaffold focuses on
/// the parity-critical pieces.
/// </summary>
public sealed class TrayMenu
{
    private readonly SidecarSupervisor _supervisor;
    private readonly SettingsClient _settings;
    private readonly Func<IntPtr> _ownerHwndProvider;
    private TaskbarIcon? _icon;
    private MenuFlyoutItem? _statusItem;
    private MenuFlyoutItem? _outputItem;

    public TrayMenu(
        SidecarSupervisor supervisor,
        SettingsClient settings,
        Func<IntPtr> ownerHwndProvider)
    {
        _supervisor = supervisor;
        _settings = settings;
        _ownerHwndProvider = ownerHwndProvider;
    }

    public void Show()
    {
        _statusItem = new MenuFlyoutItem
        {
            Text = "○ Stopped",
            IsEnabled = false,
        };

        var startItem = new MenuFlyoutItem { Text = "Start" };
        startItem.Click += async (_, _) => await _supervisor.StartAsync().ConfigureAwait(false);

        var restartItem = new MenuFlyoutItem { Text = "Restart" };
        restartItem.Click += async (_, _) => await _supervisor.RestartAsync().ConfigureAwait(false);

        var stopItem = new MenuFlyoutItem { Text = "Stop" };
        stopItem.Click += async (_, _) => await _supervisor.StopAsync().ConfigureAwait(false);

        var dashboardItem = new MenuFlyoutItem { Text = "Open Dashboard…" };
        dashboardItem.Click += (_, _) => OpenUrl("https://jadapps.app/dashboard");

        _outputItem = new MenuFlyoutItem { Text = "Output Folder…" };
        _outputItem.Click += async (_, _) => await PickOutputFolderAsync().ConfigureAwait(false);

        var openOutputItem = new MenuFlyoutItem { Text = "Open Output Folder" };
        openOutputItem.Click += async (_, _) => await OpenOutputFolderAsync().ConfigureAwait(false);

        var quitItem = new MenuFlyoutItem { Text = "Quit JAD Apps Runner" };
        quitItem.Click += async (_, _) =>
        {
            await _supervisor.StopAsync().ConfigureAwait(false);
            Application.Current.Exit();
        };

        var menu = new MenuFlyout();
        menu.Items.Add(_statusItem);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(startItem);
        menu.Items.Add(restartItem);
        menu.Items.Add(stopItem);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(dashboardItem);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(_outputItem);
        menu.Items.Add(openOutputItem);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(quitItem);

        _icon = new TaskbarIcon
        {
            ToolTipText = "JAD Apps Runner — Starting…",
            ContextFlyout = menu,
        };
        _icon.ForceCreate();

        // Refresh menu state every 30s — pairing + outputDir can change
        // out-of-band (the user typing `jadapps-runner pair` in a shell).
        var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(30) };
        timer.Tick += async (_, _) => await RefreshAsync().ConfigureAwait(false);
        timer.Start();

        // Initial paint — fire-and-forget; the user can interact with
        // the tray immediately.
        _ = RefreshAsync();
    }

    private async System.Threading.Tasks.Task RefreshAsync()
    {
        if (_statusItem is null)
        {
            return;
        }
        var running = _supervisor.IsRunning;
        try
        {
            _statusItem.Text = running ? "● Running" : "○ Stopped";
            if (_icon is not null)
            {
                _icon.ToolTipText = running
                    ? "JAD Apps Runner — Running"
                    : "JAD Apps Runner — Stopped";
            }
            if (running && _outputItem is not null)
            {
                var s = await _settings.GetAsync().ConfigureAwait(true);
                _outputItem.Text = $"Output Folder: {ShortenPath(s.OutputDir, 40)}";
            }
        }
        catch
        {
            // Best-effort UI refresh; ignore transient failures.
        }
    }

    private async System.Threading.Tasks.Task PickOutputFolderAsync()
    {
        var picker = new FolderPicker
        {
            SuggestedStartLocation = PickerLocationId.DocumentsLibrary,
        };
        picker.FileTypeFilter.Add("*");

        // WinUI3 FolderPicker requires an HWND anchor. Without it, the
        // call throws E_INVALIDARG on unpackaged dev runs, and even in
        // MSIX-packaged runs the dialog can open behind other windows.
        var hwnd = _ownerHwndProvider();
        if (hwnd != IntPtr.Zero)
        {
            InitializeWithWindow.Initialize(picker, hwnd);
        }

        var folder = await picker.PickSingleFolderAsync();
        if (folder is null)
        {
            return;
        }
        try
        {
            await _settings.PatchAsync(new SettingsPatch { OutputDir = folder.Path }).ConfigureAwait(true);
            await RefreshAsync().ConfigureAwait(true);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"PATCH /v1/settings failed: {ex.Message}");
        }
    }

    private async System.Threading.Tasks.Task OpenOutputFolderAsync()
    {
        try
        {
            var s = await _settings.GetAsync().ConfigureAwait(true);
            if (Directory.Exists(s.OutputDir))
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "explorer.exe",
                    Arguments = $"\"{s.OutputDir}\"",
                    UseShellExecute = true,
                });
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Open Output Folder failed: {ex.Message}");
        }
    }

    private static void OpenUrl(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Open URL failed: {ex.Message}");
        }
    }

    private static string ShortenPath(string raw, int max)
    {
        if (raw.Length <= max)
        {
            return raw;
        }
        var tailLen = Math.Max(0, max - 4);
        return "…" + raw[^tailLen..];
    }
}
