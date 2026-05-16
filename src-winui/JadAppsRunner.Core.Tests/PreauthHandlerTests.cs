using JadAppsRunner.Core;
using Xunit;

namespace JadAppsRunner.Core.Tests;

public class PreauthHandlerTests
{
    [Fact]
    public void ParsesMinimalPairUrl()
    {
        var m = PreauthHandler.ParsePairUrl("jadapps-runner://pair?token=ABC123");
        Assert.NotNull(m);
        Assert.Equal("ABC123", m!.PreauthToken);
        Assert.Null(m.DeviceName);
        Assert.Null(m.PlatformTag);
    }

    [Fact]
    public void ParsesFullPairUrl_WithUrlEncodedName()
    {
        var m = PreauthHandler.ParsePairUrl(
            "jadapps-runner://pair?token=xyz&name=alice%2Dlaptop&platform=win32-msix");
        Assert.NotNull(m);
        Assert.Equal("xyz", m!.PreauthToken);
        Assert.Equal("alice-laptop", m.DeviceName);
        Assert.Equal("win32-msix", m.PlatformTag);
    }

    [Fact]
    public void ToleratesTrailingSlash()
    {
        var m = PreauthHandler.ParsePairUrl("jadapps-runner://pair/?token=T");
        Assert.NotNull(m);
        Assert.Equal("T", m!.PreauthToken);
    }

    [Theory]
    [InlineData("jadapps-runner://login?token=T")]      // wrong action
    [InlineData("https://jadapps.app/pair?token=T")]    // wrong scheme
    [InlineData("jadapps-runner://pair")]               // no token at all
    [InlineData("jadapps-runner://pair?name=alice")]    // no token query param
    [InlineData("jadapps-runner://pair?token=")]        // empty token
    [InlineData("")]                                     // empty input
    [InlineData("   ")]                                  // whitespace
    public void RejectsBadInputs(string input)
    {
        Assert.Null(PreauthHandler.ParsePairUrl(input));
    }

    [Fact]
    public void ExtractsFirstPairUrlFromArgv()
    {
        var argv = new[]
        {
            "JadAppsRunner.Host.exe",
            "--whatever",
            "jadapps-runner://pair?token=FROM_ARGV",
            "extra",
        };
        var m = PreauthHandler.ExtractFromArgs(argv);
        Assert.NotNull(m);
        Assert.Equal("FROM_ARGV", m!.PreauthToken);
    }

    [Fact]
    public void ExtractReturnsNullWhenNoUrlPresent()
    {
        var argv = new[] { "JadAppsRunner.Host.exe", "start" };
        Assert.Null(PreauthHandler.ExtractFromArgs(argv));
    }

    [Fact]
    public void WriteMarker_CreatesDirAndWritesCamelCaseJson()
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"jadapps-test-{Guid.NewGuid():N}");
        try
        {
            var dest = Path.Combine(tmp, "nested", ".jadapps-runner");
            var marker = new PreauthMarker
            {
                PreauthToken = "T1",
                DeviceName = "alice-laptop",
                PlatformTag = "win32-msix",
            };
            var path = PreauthHandler.WriteMarker(dest, marker);
            Assert.True(File.Exists(path));
            var body = File.ReadAllText(path);
            Assert.Contains("\"preauthToken\": \"T1\"", body);
            Assert.Contains("\"deviceName\": \"alice-laptop\"", body);
            Assert.Contains("\"platformTag\": \"win32-msix\"", body);
        }
        finally
        {
            if (Directory.Exists(tmp))
            {
                Directory.Delete(tmp, recursive: true);
            }
        }
    }

    [Fact]
    public void WriteMarker_OmitsOptionalFieldsWhenNull()
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"jadapps-test-{Guid.NewGuid():N}");
        try
        {
            var marker = new PreauthMarker { PreauthToken = "T2" };
            var path = PreauthHandler.WriteMarker(tmp, marker);
            var body = File.ReadAllText(path);
            Assert.Contains("\"preauthToken\"", body);
            Assert.DoesNotContain("deviceName", body);
            Assert.DoesNotContain("platformTag", body);
        }
        finally
        {
            if (Directory.Exists(tmp))
            {
                Directory.Delete(tmp, recursive: true);
            }
        }
    }
}
