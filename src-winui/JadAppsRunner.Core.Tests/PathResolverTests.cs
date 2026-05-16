using JadAppsRunner.Core;
using Xunit;

namespace JadAppsRunner.Core.Tests;

public class PathResolverTests
{
    [Fact]
    public void DataDir_EndsWith_Jadapps_Folder()
    {
        var dir = PathResolver.DataDir();
        Assert.EndsWith(".jadapps-runner", dir);
    }

    [Fact]
    public void PreauthMarkerPath_IsInsideDataDir()
    {
        var dir = PathResolver.DataDir();
        var marker = PathResolver.PreauthMarkerPath();
        Assert.StartsWith(dir, marker);
        Assert.EndsWith("preauth.json", marker);
    }

    [Fact]
    public void PairingTokenPath_IsInsideDataDir()
    {
        var dir = PathResolver.DataDir();
        var tok = PathResolver.PairingTokenPath();
        Assert.StartsWith(dir, tok);
        Assert.EndsWith("pairing-token", tok);
    }

    [Fact]
    public void SidecarEntry_PointsAtAssetsRuntimeBundleCliJs()
    {
        var entry = PathResolver.SidecarEntry(@"C:\Program Files\JAD\Runner");
        Assert.Equal(@"C:\Program Files\JAD\Runner\Assets\runtime-bundle\cli.js", entry);
    }

    [Fact]
    public void SidecarNode_PointsAtAssetsRuntimeBundleNodeExe()
    {
        var node = PathResolver.SidecarNode(@"C:\Program Files\JAD\Runner");
        Assert.Equal(@"C:\Program Files\JAD\Runner\Assets\runtime-bundle\node.exe", node);
    }
}
