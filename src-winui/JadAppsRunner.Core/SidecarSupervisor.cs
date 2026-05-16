using System.Diagnostics;
using System.Runtime.InteropServices;

namespace JadAppsRunner.Core;

/// <summary>
/// Spawns and supervises the Node sidecar (<c>cli.js start</c>).
/// Port of <c>src-tauri/src/sidecar.rs</c> to managed C# — same crash
/// supervision semantics, same log-piping conventions.
/// </summary>
/// <remarks>
/// <para>
/// Key differences from the Tauri Rust version:
/// </para>
/// <list type="bullet">
///   <item>Uses a Win32 job object with
///   <c>JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE</c> so the Node child dies
///   when the WinUI3 host process exits, even on a hard crash.</item>
///   <item>Returns a <see cref="Task"/> from <see cref="StartAsync"/>
///   that completes when the supervisor loop exits — easier to await
///   from the host's lifetime hooks than the Rust async-task fire-and-forget.</item>
/// </list>
/// </remarks>
public sealed class SidecarSupervisor : IAsyncDisposable
{
    private const int MaxBackoffSeconds = 60;

    private readonly string _nodePath;
    private readonly string _cliPath;
    private readonly int _port;
    private readonly Action<string>? _logSink;
    private readonly Action<bool>? _onRunningChanged;

    private CancellationTokenSource? _cts;
    private Task? _loop;
    private Process? _child;
    private SafeJobObject? _jobObject;
    private readonly object _lock = new();
    private int _restartCount;

    public SidecarSupervisor(
        string nodePath,
        string cliPath,
        int port = 9789,
        Action<string>? logSink = null,
        Action<bool>? onRunningChanged = null)
    {
        _nodePath = nodePath;
        _cliPath = cliPath;
        _port = port;
        _logSink = logSink;
        _onRunningChanged = onRunningChanged;
    }

    /// <summary>True when the child process is currently alive.</summary>
    public bool IsRunning
    {
        get
        {
            lock (_lock)
            {
                return _child is { HasExited: false };
            }
        }
    }

    /// <summary>
    /// Start the supervision loop. Idempotent: a second call before
    /// <see cref="StopAsync"/> is a no-op.
    /// </summary>
    public Task StartAsync()
    {
        lock (_lock)
        {
            if (_loop is not null && !_loop.IsCompleted)
            {
                return Task.CompletedTask;
            }
            _cts = new CancellationTokenSource();
            _restartCount = 0;
            _loop = Task.Run(() => SuperviseAsync(_cts.Token));
            return Task.CompletedTask;
        }
    }

    /// <summary>
    /// Stop the sidecar intentionally. The supervisor loop exits and
    /// does NOT restart the child.
    /// </summary>
    public async Task StopAsync()
    {
        CancellationTokenSource? cts;
        Task? loop;
        lock (_lock)
        {
            cts = _cts;
            loop = _loop;
            _cts = null;
            _loop = null;
        }
        if (cts is null)
        {
            return;
        }
        await cts.CancelAsync().ConfigureAwait(false);
        KillChild();
        if (loop is not null)
        {
            try
            {
                await loop.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Expected on intentional shutdown.
            }
        }
        cts.Dispose();
    }

    /// <summary>Restart the child — same supervisor instance.</summary>
    public async Task RestartAsync()
    {
        KillChild();
        // Brief pause matches the Rust version's 500ms — gives Windows
        // time to release the loopback port before the new bind.
        await Task.Delay(500).ConfigureAwait(false);
        // Supervisor loop notices the child exited and respawns.
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync().ConfigureAwait(false);
        _jobObject?.Dispose();
    }

    private async Task SuperviseAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            _onRunningChanged?.Invoke(false);
            try
            {
                var child = SpawnChild();
                lock (_lock)
                {
                    _child = child;
                }
                _onRunningChanged?.Invoke(true);
                Log($"sidecar spawned, pid={child.Id}");
                _restartCount = 0; // healthy spawn resets backoff

                await child.WaitForExitAsync(ct).ConfigureAwait(false);
                Log($"sidecar exited: {child.ExitCode}");
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex)
            {
                Log($"spawn failed: {ex.Message}");
            }
            finally
            {
                lock (_lock)
                {
                    _child = null;
                }
                _onRunningChanged?.Invoke(false);
            }

            if (ct.IsCancellationRequested)
            {
                return;
            }
            var delay = NextBackoffSeconds();
            Log($"sidecar crashed, restarting in {delay}s");
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(delay), ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private Process SpawnChild()
    {
        var info = new ProcessStartInfo
        {
            FileName = _nodePath,
            ArgumentList = { _cliPath, "start" },
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        info.EnvironmentVariables["JADAPPS_RUNNER_LOG_LEVEL"] = "info";
        info.EnvironmentVariables["JADAPPS_RUNNER_PORT"] = _port.ToString();

        var child = new Process { StartInfo = info, EnableRaisingEvents = true };
        child.OutputDataReceived += (_, e) => { if (e.Data is not null) Log($"[stdout] {e.Data}"); };
        child.ErrorDataReceived += (_, e) => { if (e.Data is not null) Log($"[stderr] {e.Data}"); };

        if (!child.Start())
        {
            throw new InvalidOperationException("Process.Start returned false");
        }
        child.BeginOutputReadLine();
        child.BeginErrorReadLine();

        // Bind the child to a job object that auto-kills on host crash.
        // We create the job lazily — first child only — so the host's
        // own process never gets re-assigned.
        EnsureJobObject().AssignProcess(child);

        return child;
    }

    private SafeJobObject EnsureJobObject()
    {
        if (_jobObject is null)
        {
            _jobObject = SafeJobObject.CreateKillOnClose();
        }
        return _jobObject;
    }

    private void KillChild()
    {
        Process? c;
        lock (_lock)
        {
            c = _child;
            _child = null;
        }
        if (c is null || c.HasExited)
        {
            return;
        }
        try
        {
            c.Kill(entireProcessTree: true);
        }
        catch
        {
            // Best-effort; the job object will catch the rest on host
            // shutdown if our Kill misses for any reason.
        }
    }

    private int NextBackoffSeconds()
    {
        // 1, 2, 4, 8, 16, 32, 60, 60, …  (matches Rust supervisor).
        var count = Math.Min(_restartCount, 6);
        _restartCount++;
        var d = 1 << count;
        return Math.Min(d, MaxBackoffSeconds);
    }

    private void Log(string line) => _logSink?.Invoke(line);
}

/// <summary>
/// Thin wrapper over a Win32 job object configured with
/// <c>JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE</c>. Assigning the Node
/// child to this guarantees Node dies when the host process exits,
/// even on a hard crash where managed finalizers don't run.
/// </summary>
internal sealed class SafeJobObject : IDisposable
{
    private IntPtr _handle;

    private SafeJobObject(IntPtr handle)
    {
        _handle = handle;
    }

    public static SafeJobObject CreateKillOnClose()
    {
        var handle = NativeMethods.CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero)
        {
            throw new System.ComponentModel.Win32Exception(
                Marshal.GetLastWin32Error(), "CreateJobObject failed");
        }

        var info = new NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            BasicLimitInformation = new NativeMethods.JOBOBJECT_BASIC_LIMIT_INFORMATION
            {
                LimitFlags = NativeMethods.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };
        var size = Marshal.SizeOf(info);
        var ptr = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            if (!NativeMethods.SetInformationJobObject(
                handle,
                NativeMethods.JobObjectExtendedLimitInformation,
                ptr,
                (uint)size))
            {
                var err = Marshal.GetLastWin32Error();
                NativeMethods.CloseHandle(handle);
                throw new System.ComponentModel.Win32Exception(
                    err, "SetInformationJobObject failed");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(ptr);
        }
        return new SafeJobObject(handle);
    }

    public void AssignProcess(Process process)
    {
        if (!NativeMethods.AssignProcessToJobObject(_handle, process.Handle))
        {
            throw new System.ComponentModel.Win32Exception(
                Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
        }
    }

    public void Dispose()
    {
        if (_handle != IntPtr.Zero)
        {
            NativeMethods.CloseHandle(_handle);
            _handle = IntPtr.Zero;
        }
    }

    private static class NativeMethods
    {
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        public const int JobObjectExtendedLimitInformation = 9;

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string? lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetInformationJobObject(
            IntPtr hJob, int JobObjectInformationClass, IntPtr lpJobObjectInformation, uint cbJobObjectInformationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CloseHandle(IntPtr hObject);

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public IntPtr MinimumWorkingSetSize;
            public IntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public IntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public IntPtr ProcessMemoryLimit;
            public IntPtr JobMemoryLimit;
            public IntPtr PeakProcessMemoryUsed;
            public IntPtr PeakJobMemoryUsed;
        }
    }
}
