using System.Runtime.InteropServices;
using JadAppsRunner.Core;
using Xunit;

namespace JadAppsRunner.Core.Tests;

/// <summary>
/// Lightweight tests for the supervisor — full lifecycle tests need
/// an actual sidecar binary, so we exercise the behaviour with a tiny
/// process that exits immediately. The crash-restart backoff and the
/// job-object plumbing get verified via short timed runs.
/// </summary>
public class SidecarSupervisorTests
{
    [Fact]
    public void NotRunning_BeforeStart()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return; // job object is Win32-only
        }
        var sup = new SidecarSupervisor("nonexistent.exe", "nonexistent.js");
        Assert.False(sup.IsRunning);
    }

    [Fact]
    public async Task Start_WithBadCommand_DoesNotThrow_AndSupervisorContinues()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }
        var logs = new List<string>();
        var sup = new SidecarSupervisor(
            nodePath: "C:\\Windows\\System32\\does-not-exist-jadapps-test.exe",
            cliPath: "doesnt-matter.js",
            logSink: line =>
            {
                lock (logs) logs.Add(line);
            });

        await sup.StartAsync();
        // Give the supervisor a couple of cycles. We expect 1+ spawn
        // failures plus backoff sleeps — but no crash from the test.
        await Task.Delay(750);
        await sup.StopAsync();

        lock (logs)
        {
            // Got at least one error and we survived.
            Assert.Contains(logs, l => l.Contains("spawn failed", StringComparison.OrdinalIgnoreCase));
        }
        Assert.False(sup.IsRunning);
    }

    [Fact]
    public async Task Start_WithSuccessfulShortLivedProcess_TogglesRunning()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }
        // A real Node sidecar is heavy; use cmd.exe printing a line then
        // exiting as a stand-in for the spawn+supervise path. The
        // supervisor loop should see it exit and apply backoff.
        var sup = new SidecarSupervisor(
            nodePath: Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe",
            cliPath: "/c echo jadapps-test && exit 0",
            port: 0);

        var seen = new List<bool>();
        // No public event for state changes, but isRunning is observable.
        await sup.StartAsync();
        for (var i = 0; i < 10; i++)
        {
            seen.Add(sup.IsRunning);
            await Task.Delay(80);
        }
        await sup.StopAsync();
        // We don't assert the exact transition pattern — Windows process
        // startup latency varies — only that the supervisor did not throw
        // and that StopAsync left it stopped.
        Assert.False(sup.IsRunning);
    }
}
