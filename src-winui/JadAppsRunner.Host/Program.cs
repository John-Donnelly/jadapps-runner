using System;
using System.Threading;
using System.Threading.Tasks;
using JadAppsRunner.Core;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace JadAppsRunner.Host;

/// <summary>
/// Custom Main entry. Replaces the XAML-generated default so we can:
///   1. Enforce a single instance via AppInstance.FindOrRegisterForKey,
///      mirroring the Tauri host's tauri-plugin-single-instance gate.
///   2. Forward URL activations (jadapps-runner://pair?token=...) from
///      a redirecting "second" launch to the already-running primary.
///
/// Without this gate, every protocol click / Start-menu launch spawns
/// a fresh Host + sidecar pair — two HTTP servers fighting for 9789,
/// two tray icons, two log streams.
/// </summary>
public static class Program
{
    private const string InstanceKey = "JadAppsRunner-MainInstance";

    [STAThread]
    public static int Main(string[] _args)
    {
        WinRT.ComWrappersSupport.InitializeComWrappers();
        if (DecideRedirection())
        {
            // Second launch handed its activation args over to the
            // primary; exit immediately so no XAML / tray work happens.
            return 0;
        }

        Application.Start(p =>
        {
            _ = p;
            var context = new DispatcherQueueSynchronizationContext(
                DispatcherQueue.GetForCurrentThread());
            SynchronizationContext.SetSynchronizationContext(context);
            _ = new App();
        });
        return 0;
    }

    /// <summary>
    /// Returns true when this process should exit because another
    /// instance is already running. On the primary instance, returns
    /// false and registers as the AppLifecycle key holder so future
    /// activations get redirected here.
    /// </summary>
    private static bool DecideRedirection()
    {
        var args = AppInstance.GetCurrent().GetActivatedEventArgs();
        var keyInstance = AppInstance.FindOrRegisterForKey(InstanceKey);
        if (keyInstance.IsCurrent)
        {
            return false;
        }

        // We're a redirect. Forward the activation args to the primary
        // and exit. RedirectActivationToAsync is async-only — block
        // here because we're about to terminate the process.
        Task.Run(async () => await keyInstance.RedirectActivationToAsync(args)).Wait();
        return true;
    }
}
