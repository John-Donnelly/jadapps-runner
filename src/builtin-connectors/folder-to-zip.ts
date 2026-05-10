/**
 * folder-to-zip: bundles every input file into a single ZIP archive,
 * preserving the on-disk filenames. For nested directory trees the caller
 * is responsible for naming each fileRef with a relative path (e.g.
 * "subdir/file.txt").
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

export default async function folderToZip(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "folder-to-zip requires at least one input");
  }

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const cfg = ctx.inputs ?? {};
  const compression = cfg.compression === "STORE" ? "STORE" : "DEFLATE";
  const compressionLevel = Math.max(1, Math.min(9, Math.floor(Number(cfg.compressionLevel ?? 6))));

  const zip = new (JSZip as unknown as new () => import("jszip"))();
  let totalIn = 0;
  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    const data = await readFile(path);
    const name = ref.filename ?? ref.ref;
    zip.file(name, data);
  }
  ctx.emitProgress(totalIn);

  const buf = await zip.generateAsync({ type: "nodebuffer", compression, compressionOptions: { level: compressionLevel } });
  const outRef = "archive.zip";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, buf);

  return {
    ok: true,
    outputs: { fileCount: ctx.fileRefs.length, originalBytes: totalIn, archivedBytes: buf.length, compression },
    fileRefs: [{ ref: outRef, bytes: buf.length, sha256: "", mime: "application/zip", filename: outRef }],
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
