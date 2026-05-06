import { generateKeyPairSync, createSign, createVerify } from "node:crypto";

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

export function signWithDeviceKey(privateKeyPem: string, payload: string): string {
  const signer = createSign("SHA256");
  signer.update(payload);
  signer.end();
  return signer.sign(privateKeyPem, "base64");
}

export function verifyDeviceSignature(
  publicKeyPem: string,
  payload: string,
  signatureB64: string,
): boolean {
  const verifier = createVerify("SHA256");
  verifier.update(payload);
  verifier.end();
  return verifier.verify(publicKeyPem, signatureB64, "base64");
}
