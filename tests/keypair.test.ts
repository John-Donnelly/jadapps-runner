import { describe, it, expect } from "vitest";
import { generateEd25519, signWithDeviceKey, verifyDeviceSignature } from "../src/auth/keypair";
import { webcrypto } from "node:crypto";

describe("device keypair", () => {
  it("signs and verifies via node:crypto symmetrically", () => {
    const { publicKey, privateKey } = generateEd25519();
    const sig = signWithDeviceKey(privateKey, "device-1.1700000000000");
    expect(verifyDeviceSignature(publicKey, "device-1.1700000000000", sig)).toBe(true);
    expect(verifyDeviceSignature(publicKey, "device-1.1700000000001", sig)).toBe(false);
  });

  it("verifies via WebCrypto SubtleCrypto.verify (matching the edge runtime path)", async () => {
    const { publicKey, privateKey } = generateEd25519();
    const challenge = "device-1.1700000000000";
    const sig = signWithDeviceKey(privateKey, challenge);

    // Mirror the JAD Apps server's verify implementation.
    const b64 = publicKey
      .replace(/-----BEGIN [^-]+-----/g, "")
      .replace(/-----END [^-]+-----/g, "")
      .replace(/\s+/g, "");
    const der = Buffer.from(b64, "base64");
    const key = await webcrypto.subtle.importKey(
      "spki",
      der,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const ok = await webcrypto.subtle.verify(
      "Ed25519",
      key,
      Buffer.from(sig, "base64"),
      Buffer.from(challenge, "utf8"),
    );
    expect(ok).toBe(true);
  });
});
