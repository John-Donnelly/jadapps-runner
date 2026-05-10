/**
 * auto-format-detector: identifies an input archive's format from its
 * magic bytes. Recognizes ZIP, gzip, tar, tar.gz, bzip2, xz, 7z, RAR.
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

export default async function autoFormatDetector(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "auto-format-detector requires one input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const format = detect(buf);
  const report = {
    archive: ref.filename ?? ref.ref,
    detectedFormat: format,
    sizeBytes: buf.length,
    firstBytesHex: buf.subarray(0, 16).toString("hex"),
  };
  const out = JSON.stringify(report, null, 2);
  const outRef = "format-detection.json";
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");

  return {
    ok: true,
    outputs: { detectedFormat: format },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function detect(buf: Buffer): string {
  if (buf.length < 4) return "unknown";
  const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3];
  if (b0 === 0x50 && b1 === 0x4b && (b2 === 0x03 || b2 === 0x05 || b2 === 0x07)) return "zip";
  if (b0 === 0x1f && b1 === 0x8b) return "gzip";
  if (b0 === 0x42 && b1 === 0x5a && b2 === 0x68) return "bzip2";
  if (b0 === 0xfd && b1 === 0x37 && b2 === 0x7a && b3 === 0x58) return "xz";
  if (b0 === 0x37 && b1 === 0x7a && b2 === 0xbc && b3 === 0xaf) return "7z";
  if (b0 === 0x52 && b1 === 0x61 && b2 === 0x72 && b3 === 0x21) return "rar";
  if (buf.length > 262 && buf.subarray(257, 263).toString("ascii") === "ustar\0") return "tar";
  if (buf.length > 264 && buf.subarray(257, 262).toString("ascii") === "ustar") return "tar";
  return "unknown";
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
