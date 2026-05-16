using JadAppsRunner.Core;
using Xunit;

namespace JadAppsRunner.Core.Tests;

public class SidecarFileLoggerTests
{
    /// <summary>
    /// File.ReadAllText opens with FileShare.Read which conflicts
    /// with the logger's FileAccess.Write handle (the OS sharing
    /// check fails on "writer's access ⊄ reader's share"). Use a
    /// FileShare.ReadWrite read so the test can tail a live log.
    /// </summary>
    private static string ReadAllowConcurrentWriter(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(fs);
        return reader.ReadToEnd();
    }

    [Fact]
    public void WriteLine_AppendsToFileAndPersists()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"jadapps-test-{Guid.NewGuid():N}");
        try
        {
            using (var logger = new SidecarFileLogger(dir, "test.log"))
            {
                logger.WriteLine("hello");
                logger.WriteLine("world");
            }
            var body = ReadAllowConcurrentWriter(Path.Combine(dir, "test.log"));
            Assert.Contains("hello", body);
            Assert.Contains("world", body);
        }
        finally
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
    }

    [Fact]
    public void WriteLine_NeverThrows_EvenAfterDispose()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"jadapps-test-{Guid.NewGuid():N}");
        try
        {
            var logger = new SidecarFileLogger(dir, "disposed.log");
            logger.WriteLine("first");
            logger.Dispose();
            // Post-dispose write reopens lazily and succeeds; the
            // logger's contract is "best-effort, never throw".
            logger.WriteLine("after-dispose");
            logger.Dispose();
        }
        finally
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
    }

    [Fact]
    public void MultipleLoggers_DoNotCollide()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"jadapps-test-{Guid.NewGuid():N}");
        try
        {
            using var a = new SidecarFileLogger(dir, "a.log");
            using var b = new SidecarFileLogger(dir, "b.log");
            a.WriteLine("from-a");
            b.WriteLine("from-b");
            Assert.Contains("from-a", ReadAllowConcurrentWriter(a.FilePath));
            Assert.Contains("from-b", ReadAllowConcurrentWriter(b.FilePath));
            Assert.DoesNotContain("from-b", ReadAllowConcurrentWriter(a.FilePath));
        }
        finally
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
    }

    [Fact]
    public void FilePath_LivesUnderLogsDir_WhenUsingDefaultConstructor()
    {
        // Sanity: the no-arg constructor anchors the path under
        // ~/.jadapps-runner/logs/, so a tail in Explorer finds it.
        using var logger = new SidecarFileLogger("ctor-test.log");
        try
        {
            Assert.EndsWith(Path.Combine(".jadapps-runner", "logs", "ctor-test.log"), logger.FilePath);
        }
        finally
        {
            logger.Dispose();
            if (File.Exists(logger.FilePath))
            {
                File.Delete(logger.FilePath);
            }
        }
    }
}
