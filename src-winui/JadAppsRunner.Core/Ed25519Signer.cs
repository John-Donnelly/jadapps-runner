using System.Text;
using Org.BouncyCastle.Asn1;
using Org.BouncyCastle.Asn1.Pkcs;
using Org.BouncyCastle.Asn1.X509;
using Org.BouncyCastle.Crypto;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.OpenSsl;
using Org.BouncyCastle.Pkcs;
using Org.BouncyCastle.Security;
using Org.BouncyCastle.X509;
using BcEd25519Signer = Org.BouncyCastle.Crypto.Signers.Ed25519Signer;
using BcEd25519KeyPairGenerator = Org.BouncyCastle.Crypto.Generators.Ed25519KeyPairGenerator;

namespace JadAppsRunner.Core;

/// <summary>
/// Ed25519 keypair generation + signing, matching the wire format the
/// Node side uses in <c>src/auth/keypair.ts</c>:
///
///   - Public key: SPKI PEM ("BEGIN PUBLIC KEY")
///   - Private key: PKCS#8 PEM ("BEGIN PRIVATE KEY")
///   - Signature: raw 64-byte EdDSA signature, base64-encoded
/// </summary>
public static class Ed25519Signer
{
    /// <summary>
    /// Generates a fresh Ed25519 keypair and returns the SPKI / PKCS#8
    /// PEM strings that <c>generateEd25519()</c> in Node produces.
    /// </summary>
    public static (string publicPem, string privatePem) GenerateKeypair()
    {
        var random = new SecureRandom();
        var gen = new BcEd25519KeyPairGenerator();
        gen.Init(new Ed25519KeyGenerationParameters(random));
        var pair = gen.GenerateKeyPair();

        var pubBytes = SubjectPublicKeyInfoFactory
            .CreateSubjectPublicKeyInfo(pair.Public)
            .GetDerEncoded();
        var privBytes = PrivateKeyInfoFactory
            .CreatePrivateKeyInfo(pair.Private)
            .GetDerEncoded();

        return (
            PemEncode("PUBLIC KEY", pubBytes),
            PemEncode("PRIVATE KEY", privBytes));
    }

    /// <summary>
    /// Sign a UTF-8 string payload with a PKCS#8 PEM private key, and
    /// return the base64-encoded signature.
    /// </summary>
    /// <remarks>
    /// Wire-compatible with Node's
    /// <c>crypto.sign(null, Buffer.from(payload, "utf8"), privateKeyPem)</c>:
    /// EdDSA does its own hashing, so the algorithm arg is null on both sides.
    /// </remarks>
    public static string Sign(string privateKeyPem, string payload)
    {
        var bytes = Encoding.UTF8.GetBytes(payload);
        var sig = SignBytes(privateKeyPem, bytes);
        return Convert.ToBase64String(sig);
    }

    /// <summary>Raw-bytes overload of <see cref="Sign"/>.</summary>
    public static byte[] SignBytes(string privateKeyPem, byte[] payload)
    {
        var key = ParsePrivatePem(privateKeyPem);
        var signer = new BcEd25519Signer();
        signer.Init(forSigning: true, key);
        signer.BlockUpdate(payload, 0, payload.Length);
        return signer.GenerateSignature();
    }

    /// <summary>
    /// Verify an EdDSA signature against an SPKI-PEM public key.
    /// </summary>
    public static bool Verify(string publicKeyPem, string payload, string signatureBase64)
    {
        return VerifyBytes(publicKeyPem, Encoding.UTF8.GetBytes(payload), Convert.FromBase64String(signatureBase64));
    }

    /// <summary>Raw-bytes overload of <see cref="Verify"/>.</summary>
    public static bool VerifyBytes(string publicKeyPem, byte[] payload, byte[] signature)
    {
        var key = ParsePublicPem(publicKeyPem);
        var signer = new BcEd25519Signer();
        signer.Init(forSigning: false, key);
        signer.BlockUpdate(payload, 0, payload.Length);
        return signer.VerifySignature(signature);
    }

    private static Ed25519PrivateKeyParameters ParsePrivatePem(string pem)
    {
        using var reader = new StringReader(pem);
        var parser = new PemReader(reader);
        var obj = parser.ReadObject();
        return obj switch
        {
            AsymmetricCipherKeyPair pair => (Ed25519PrivateKeyParameters)pair.Private,
            Ed25519PrivateKeyParameters key => key,
            PrivateKeyInfo info => (Ed25519PrivateKeyParameters)
                PrivateKeyFactory.CreateKey(info),
            Asn1Object asn1 => (Ed25519PrivateKeyParameters)
                PrivateKeyFactory.CreateKey(PrivateKeyInfo.GetInstance(asn1)),
            _ => throw new ArgumentException(
                $"unexpected PEM object type {obj?.GetType().FullName ?? "null"}",
                nameof(pem)),
        };
    }

    private static Ed25519PublicKeyParameters ParsePublicPem(string pem)
    {
        using var reader = new StringReader(pem);
        var parser = new PemReader(reader);
        var obj = parser.ReadObject();
        return obj switch
        {
            Ed25519PublicKeyParameters key => key,
            SubjectPublicKeyInfo info => (Ed25519PublicKeyParameters)
                PublicKeyFactory.CreateKey(info),
            Asn1Object asn1 => (Ed25519PublicKeyParameters)
                PublicKeyFactory.CreateKey(SubjectPublicKeyInfo.GetInstance(asn1)),
            _ => throw new ArgumentException(
                $"unexpected PEM object type {obj?.GetType().FullName ?? "null"}",
                nameof(pem)),
        };
    }

    private static string PemEncode(string label, byte[] der)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"-----BEGIN {label}-----");
        var base64 = Convert.ToBase64String(der);
        for (var i = 0; i < base64.Length; i += 64)
        {
            sb.AppendLine(base64.Substring(i, Math.Min(64, base64.Length - i)));
        }
        sb.AppendLine($"-----END {label}-----");
        return sb.ToString();
    }
}
