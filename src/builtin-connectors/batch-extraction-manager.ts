/**
 * batch-extraction-manager: extracts multiple ZIP archives in one pass
 * and writes a manifest.json reporting per-archive entry counts and
 * sizes. Each archive's contents land in a folder named after the
 * archive (without extension).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
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

export default async function batchExtractionManager(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "batch-extraction-manager requires at least one archive input");
  }

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const fileRefs: FileRef[] = [];
  const manifest: { archive: string; entries: number; totalBytes: number }[] = [];
  let totalIn = 0;
  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    const buf = await readFile(path);
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) continue;
    const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
    const baseName = (ref.filename ?? ref.ref).replace(/\.zip$/i, "");
    const dirPath = join(ctx.scratchDir, baseName);
    await mkdir(dirPath, { recursive: true });
    let entries = 0, totalBytes = 0;
    for (const [entryPath, file] of Object.entries(zip.files)) {
      if (file.dir) continue;
      const data = await file.async("nodebuffer");
      const safeName = `${baseName}/${entryPath.replace(/[\\:]/g, "_")}`;
      await writeFile(join(ctx.scratchDir, safeName), data);
      fileRefs.push({ ref: safeName, bytes: data.length, sha256: "", mime: "application/octet-stream", filename: safeName });
      entries += 1;
      totalBytes += data.length;
    }
    manifest.push({ archive: ref.filename ?? ref.ref, entries, totalBytes });
  }
  ctx.emitProgress(totalIn);

  const manifestRef = "extraction-manifest.json";
  const manifestPath = join(ctx.scratchDir, manifestRef);
  await writeFile(manifestPath, JSON.stringify({ archiveCount: manifest.length, manifest }, null, 2), "utf8");
  fileRefs.push({ ref: manifestRef, bytes: 0, sha256: "", mime: "application/json", filename: manifestRef });

  return {
    ok: true,
    outputs: { archiveCount: manifest.length, totalEntries: manifest.reduce((s, m) => s + m.entries, 0) },
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
