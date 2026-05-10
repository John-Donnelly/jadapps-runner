/**
 * nested-archive-extractor: recursively extracts archives that contain
 * other archives. Walks down up to `maxDepth` levels; stops when no more
 * archive files are found in the most recent extraction layer.
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

export default async function nestedArchiveExtractor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "nested-archive-extractor requires one archive input");
  const cfg = ctx.inputs ?? {};
  const maxDepth = Math.max(1, Math.min(10, Math.floor(Number(cfg.maxDepth ?? 5))));

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  ctx.emitProgress(totalIn);

  const fileRefs: FileRef[] = [];
  const queue: { buf: Buffer; pathPrefix: string; depth: number }[] = [{ buf: await readFile(inPath), pathPrefix: "", depth: 0 }];
  let totalExtracted = 0;
  while (queue.length > 0) {
    const { buf, pathPrefix, depth } = queue.shift()!;
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) continue; // Only ZIP for v0.1
    const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
    for (const [path, file] of Object.entries(zip.files)) {
      if (file.dir) continue;
      const data = await file.async("nodebuffer");
      const fullPath = pathPrefix ? `${pathPrefix}/${path}` : path;
      const safeName = fullPath.replace(/[\\:]/g, "_");
      await writeFile(join(ctx.scratchDir, safeName), data);
      fileRefs.push({ ref: safeName, bytes: data.length, sha256: "", mime: "application/octet-stream", filename: fullPath });
      totalExtracted += 1;
      if (depth < maxDepth - 1 && data[0] === 0x50 && data[1] === 0x4b) {
        queue.push({ buf: data, pathPrefix: fullPath.replace(/\.zip$/i, ""), depth: depth + 1 });
      }
    }
  }

  return {
    ok: true,
    outputs: { totalExtracted, maxDepth },
    fileRefs,
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
