import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveKey(masterB64: string): Buffer {
  return createHash("sha256").update(Buffer.from(masterB64, "base64")).digest();
}

export function encryptJson(masterB64: string, plain: unknown): string {
  const key = deriveKey(masterB64);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const buf = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(plain), "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, buf]).toString("base64");
}

export function decryptJson<T = unknown>(masterB64: string, blobB64: string): T {
  const key = deriveKey(masterB64);
  const blob = Buffer.from(blobB64, "base64");
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as T;
}

export function generateMasterKey(): string {
  return randomBytes(32).toString("base64");
}
