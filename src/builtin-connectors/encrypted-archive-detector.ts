/**
 * encrypted-archive-detector: scans a ZIP for encrypted entries by
 * inspecting the general-purpose bit flag (bit 0 set means encrypted)
 * and the strong-encryption header. Reports per-entry encryption status.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function encryptedArchiveDetector(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "encrypted-archive-detector requires one archive input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    return errorResult("not_a_zip", "input is not a ZIP file (signature does not match PK\\x03\\x04)");
  }

  // Walk local file headers and check the general-purpose bit flag (offset 6).
  // PKWARE encryption: bit 0 = 1. AES-256: also bit 0 + extra field 0x9901.
  const entries: { name: string; encrypted: boolean; strongEncryption: boolean; aes: boolean }[] = [];
  let i = 0;
  while (i < buf.length - 30) {
    if (buf[i] !== 0x50 || buf[i + 1] !== 0x4b || buf[i + 2] !== 0x03 || buf[i + 3] !== 0x04) break;
    const flags = buf.readUInt16LE(i + 6);
    const compression = buf.readUInt16LE(i + 8);
    const compressedSize = buf.readUInt32LE(i + 18);
    const filenameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + filenameLen).toString("utf8");
    const extra = buf.subarray(i + 30 + filenameLen, i + 30 + filenameLen + extraLen);
    const aes = compression === 99 || hasAesExtraField(extra);
    entries.push({ name, encrypted: (flags & 0x01) !== 0, strongEncryption: (flags & 0x40) !== 0, aes });
    i += 30 + filenameLen + extraLen + compressedSize;
  }

  const summary = {
    totalEntries: entries.length,
    encryptedCount: entries.filter((e) => e.encrypted).length,
    aesCount: entries.filter((e) => e.aes).length,
    encrypted: entries.length > 0 && entries.every((e) => e.encrypted),
    entries,
  };
  const out = JSON.stringify(summary, null, 2);
  const outRef = "encryption-report.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { totalEntries: summary.totalEntries, encryptedCount: summary.encryptedCount, allEncrypted: summary.encrypted },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function hasAesExtraField(extra: Buffer): boolean {
  let j = 0;
  while (j < extra.length - 4) {
    const id = extra.readUInt16LE(j);
    const sz = extra.readUInt16LE(j + 2);
    if (id === 0x9901) return true;
    j += 4 + sz;
  }
  return false;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
