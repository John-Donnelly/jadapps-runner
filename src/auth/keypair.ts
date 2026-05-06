import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

export interface RawKeypair {
  publicKey: string;
  privateKey: string;
}

export function generateEd25519(): RawKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

/** Ed25519 sign — algorithm arg is null because EdDSA has its own internal hashing. */
export function signWithDeviceKey(privateKeyPem: string, payload: string): string {
  return cryptoSign(null, Buffer.from(payload, "utf8"), privateKeyPem).toString("base64");
}

export function verifyDeviceSignature(
  publicKeyPem: string,
  payload: string,
  signatureB64: string,
): boolean {
  return cryptoVerify(
    null,
    Buffer.from(payload, "utf8"),
    publicKeyPem,
    Buffer.from(signatureB64, "base64"),
  );
}
