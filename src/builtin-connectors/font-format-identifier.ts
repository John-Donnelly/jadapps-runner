/**
 * font-format-identifier: detects the format of an input font file by
 * its magic bytes. Recognizes TTF, OTF, WOFF, WOFF2, EOT, TTC, SVG.
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

export default async function fontFormatIdentifier(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "font-format-identifier requires one font input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const fmt = detectFontFormat(buf);
  const report = {
    file: ref.filename ?? ref.ref,
    format: fmt,
    sizeBytes: buf.length,
    firstBytesHex: buf.subarray(0, 8).toString("hex"),
  };
  const out = JSON.stringify(report, null, 2);
  const outRef = "font-format.json";
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");

  return {
    ok: true,
    outputs: { format: fmt },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function detectFontFormat(buf: Buffer): string {
  if (buf.length < 4) return "unknown";
  const sig = buf.subarray(0, 4).toString("ascii");
  if (sig === "wOFF") return "woff";
  if (sig === "wOF2") return "woff2";
  if (sig === "OTTO") return "otf";
  if (sig === "ttcf") return "ttc";
  if (buf[0] === 0x00 && buf[1] === 0x01 && buf[2] === 0x00 && buf[3] === 0x00) return "ttf";
  if (buf[0] === 0x4c && buf[1] === 0x50 && buf.length > 36) return "eot";
  if (sig === "<?xm" || sig === "<svg") return "svg-font";
  return "unknown";
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
