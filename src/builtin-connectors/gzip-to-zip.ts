/**
 * gzip-to-zip: takes a .gz (single-file gzip) input and re-wraps the
 * decompressed payload inside a ZIP archive. Filename inside the ZIP
 * is the original name minus the .gz suffix.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function gzipToZip(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "gzip-to-zip requires one .gz input");

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) {
    return errorResult("not_a_gzip", "input is not a gzip file (signature does not match 0x1f8b)");
  }
  const decompressed = gunzipSync(buf);
  ctx.emitProgress(totalIn);

  const baseName = (ref.filename ?? ref.ref).replace(/\.gz$/i, "");
  const zip = new (JSZip as unknown as new () => import("jszip"))();
  zip.file(baseName, decompressed);
  const zipBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const outRef = `${baseName.replace(/\..+$/, "")}.zip`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, zipBuf);

  return {
    ok: true,
    outputs: { originalBytes: buf.length, decompressedBytes: decompressed.length, zipBytes: zipBuf.length },
    fileRefs: [{ ref: outRef, bytes: zipBuf.length, sha256: "", mime: "application/zip", filename: outRef }],
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
