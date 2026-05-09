/**
 * aes-256-encryptor: AES-256-GCM encrypt or decrypt using a passphrase. The
 * key is derived via scrypt(passphrase, salt). For encryption, salt+iv+tag
 * are prepended to the ciphertext; decryption parses them back out.
 *
 * Wire format (encrypt): [salt(16)][iv(12)][tag(16)][ciphertext]
 *
 * Streams are not used because GCM auth tag must be verified before output
 * is trusted; we buffer the file. Keep an eye on this for >2GB inputs.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function aes256Encryptor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "aes-256-encryptor requires one input file");

  const cfg = ctx.inputs ?? {};
  const action = cfg.action === "decrypt" ? "decrypt" : "encrypt";
  const passphrase = String(cfg.passphrase ?? "");
  if (!passphrase) return errorResult("invalid_config", "passphrase is required");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  if (action === "encrypt") {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(passphrase, salt, 32);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
    const tag = cipher.getAuthTag();
    const out = Buffer.concat([salt, iv, tag, ct]);
    const outRef = `${ref.ref}.enc`;
    const outPath = join(ctx.scratchDir, outRef);
    await writeFile(outPath, out);
    return {
      ok: true,
      outputs: { action, originalBytes: totalIn, encryptedBytes: out.length },
      fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "application/octet-stream", filename: outRef }],
      bytesProcessed: totalIn,
      durationMs: Date.now() - start,
    };
  }

  if (buf.length < 44) return errorResult("invalid_input", "ciphertext is too short to contain salt+iv+tag header");
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(28, 44);
  const ct = buf.subarray(44);
  const key = scryptSync(passphrase, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (err) {
    return errorResult("decryption_failed", `decryption failed: ${(err as Error).message}`);
  }
  const outRef = ref.ref.replace(/\.enc$/i, "") + ".dec";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, plain);
  return {
    ok: true,
    outputs: { action, originalBytes: totalIn, decryptedBytes: plain.length },
    fileRefs: [{ ref: outRef, bytes: plain.length, sha256: "", mime: ref.mime || "application/octet-stream", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
