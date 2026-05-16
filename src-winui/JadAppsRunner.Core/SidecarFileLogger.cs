namespace JadAppsRunner.Core;

/// <summary>
/// Append-only file logger for the Node sidecar's stdout / stderr.
/// Mirrors <c>pipe_to_log</c> in <c>src-tauri/src/sidecar.rs</c>:
/// writes line-buffered to <c>~/.jadapps-runner/logs/sidecar.*.log</c>
/// and truncates each file when it crosses 10 MB.
/// </summary>
/// <remarks>
/// WinUI3 Host runs as a WinExe with no console window — without
/// this logger, <c>Console.Error.WriteLine</c> calls go nowhere
/// and there's no way to diagnose a sidecar crash.
/// </remarks>
public sealed class SidecarFileLogger : IDisposable
{
    private const long MaxLogBytes = 10L * 1024 * 1024;

    private readonly string _path;
    private readonly object _lock = new();
    private StreamWriter? _writer;
    private FileStream? _stream;

    public SidecarFileLogger(string filename)
        : this(PathResolver.LogsDir(), filename)
    {
    }

    /// <summary>
    /// Constructor that takes the log directory explicitly. Used by
    /// tests so they don't have to redirect global state to verify
    /// behaviour.
    /// </summary>
    public SidecarFileLogger(string directory, string filename)
    {
        Directory.CreateDirectory(directory);
        _path = Path.Combine(directory, filename);
        Open();
    }

    /// <summary>Write one line to the log, with rotation on overflow.</summary>
    public void WriteLine(string line)
    {
        lock (_lock)
        {
            if (_writer is null)
            {
                Open();
            }
            try
            {
                _writer!.WriteLine(line);
                _writer.Flush();
                if (_stream is not null && _stream.Length > MaxLogBytes)
                {
                    Rotate();
                }
            }
            catch
            {
                // Best-effort logger; never throw out of the sidecar
                // log pipe — losing a log line is acceptable, killing
                // the supervisor over it is not.
            }
        }
    }

    /// <summary>The absolute path this logger writes to (for callers that log it).</summary>
    public string FilePath => _path;

    public void Dispose()
    {
        lock (_lock)
        {
            _writer?.Dispose();
            _stream?.Dispose();
            _writer = null;
            _stream = null;
        }
    }

    private void Open()
    {
        _stream = new FileStream(
            _path,
            FileMode.Append,
            FileAccess.Write,
            FileShare.ReadWrite);
        _writer = new StreamWriter(_stream)
        {
            AutoFlush = true,
        };
    }

    private void Rotate()
    {
        _writer?.Dispose();
        _stream?.Dispose();
        _stream = new FileStream(
            _path,
            FileMode.Create, // truncate
            FileAccess.Write,
            FileShare.ReadWrite);
        _writer = new StreamWriter(_stream)
        {
            AutoFlush = true,
        };
    }
}
