/**
 * tar-gz-to-zip: extracts a .tar.gz / .tgz and re-wraps the entries
 * inside a ZIP archive. Loads the tar package on demand.
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

export default async function tarGzToZip(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "tar-gz-to-zip requires one .tar.gz input");

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) {
    return errorResult("not_a_gzip", "input is not gzip-compressed (signature does not match 0x1f8b)");
  }
  const tarBuf = gunzipSync(buf);
  ctx.emitProgress(totalIn);

  const zip = new (JSZip as unknown as new () => import("jszip"))();
  let entryCount = 0;
  let pos = 0;
  while (pos < tarBuf.length - 512) {
    const header = tarBuf.subarray(pos, pos + 512);
    if (header[0] === 0) break;
    const name = readCString(header.subarray(0, 100));
    const sizeStr = readCString(header.subarray(124, 136)).trim();
    const size = parseInt(sizeStr, 8) || 0;
    const typeflag = String.fromCharCode(header[156] ?? 0x30);
    pos += 512;
    if (typeflag === "0" || typeflag === "" || typeflag === "\0") {
      if (name && size >= 0) {
        zip.file(name, tarBuf.subarray(pos, pos + size));
        entryCount += 1;
      }
    }
    pos += Math.ceil(size / 512) * 512;
  }

  const zipBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const outRef = (ref.filename ?? ref.ref).replace(/\.(tar\.gz|tgz)$/i, ".zip");
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, zipBuf);

  return {
    ok: true,
    outputs: { entryCount, tarBytes: tarBuf.length, zipBytes: zipBuf.length },
    fileRefs: [{ ref: outRef, bytes: zipBuf.length, sha256: "", mime: "application/zip", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function readCString(b: Buffer): string {
  const nul = b.indexOf(0);
  return b.subarray(0, nul === -1 ? b.length : nul).toString("utf8");
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
