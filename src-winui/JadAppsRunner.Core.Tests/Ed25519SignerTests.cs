using System.Text;
using JadAppsRunner.Core;
using Xunit;

namespace JadAppsRunner.Core.Tests;

public class Ed25519SignerTests
{
    [Fact]
    public void GenerateProducesValidPemPair()
    {
        var (pub, priv) = Ed25519Signer.GenerateKeypair();
        Assert.Contains("BEGIN PUBLIC KEY", pub);
        Assert.Contains("BEGIN PRIVATE KEY", priv);
        Assert.Contains("END PUBLIC KEY", pub);
        Assert.Contains("END PRIVATE KEY", priv);
    }

    [Fact]
    public void RoundTripSignAndVerify()
    {
        var (pub, priv) = Ed25519Signer.GenerateKeypair();
        var payload = "device-abc-123.1700000000";
        var sig = Ed25519Signer.Sign(priv, payload);
        Assert.True(Ed25519Signer.Verify(pub, payload, sig));
    }

    [Fact]
    public void VerifyRejectsTamperedPayload()
    {
        var (pub, priv) = Ed25519Signer.GenerateKeypair();
        var sig = Ed25519Signer.Sign(priv, "original");
        Assert.False(Ed25519Signer.Verify(pub, "tampered", sig));
    }

    [Fact]
    public void VerifyRejectsWrongKey()
    {
        var (_, priv1) = Ed25519Signer.GenerateKeypair();
        var (pub2, _) = Ed25519Signer.GenerateKeypair();
        var sig = Ed25519Signer.Sign(priv1, "msg");
        Assert.False(Ed25519Signer.Verify(pub2, "msg", sig));
    }

    [Fact]
    public void SignatureIsDeterministic_For_Same_Input()
    {
        // Pure Ed25519 (RFC 8032) is deterministic — same key + same
        // message always produces identical signature bytes. This is
        // also true on the Node side via crypto.sign(null, ...).
        var (_, priv) = Ed25519Signer.GenerateKeypair();
        var sig1 = Ed25519Signer.Sign(priv, "same input");
        var sig2 = Ed25519Signer.Sign(priv, "same input");
        Assert.Equal(sig1, sig2);
    }

    [Fact]
    public void SignatureIsExactly64BytesRaw()
    {
        var (_, priv) = Ed25519Signer.GenerateKeypair();
        var raw = Ed25519Signer.SignBytes(priv, Encoding.UTF8.GetBytes("x"));
        Assert.Equal(64, raw.Length);
    }
}
