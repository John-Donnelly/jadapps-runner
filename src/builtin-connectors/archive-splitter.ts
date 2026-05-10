/**
 * archive-splitter: splits a single ZIP into N smaller ZIPs by partitioning
 * its entries to stay under `partSizeBytes` each. Output names use a
 * `<base>.part-N.zip` pattern.
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

export default async function archiveSplitter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "archive-splitter requires one ZIP input");

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const cfg = ctx.inputs ?? {};
  const partSizeBytes = Math.max(1024 * 1024, Number(cfg.partSizeBytes ?? 50 * 1024 * 1024));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
  ctx.emitProgress(totalIn);

  const baseName = (ref.filename ?? ref.ref).replace(/\.zip$/i, "");
  const fileRefs: FileRef[] = [];
  let partIndex = 1;
  let currentZip = new (JSZip as unknown as new () => import("jszip"))();
  let currentBytes = 0;
  let entriesInCurrent = 0;

  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const data = await file.async("nodebuffer");
    if (currentBytes + data.length > partSizeBytes && entriesInCurrent > 0) {
      const out = await currentZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      const name = `${baseName}.part-${partIndex}.zip`;
      await writeFile(join(ctx.scratchDir, name), out);
      fileRefs.push({ ref: name, bytes: out.length, sha256: "", mime: "application/zip", filename: name });
      partIndex += 1;
      currentZip = new (JSZip as unknown as new () => import("jszip"))();
      currentBytes = 0;
      entriesInCurrent = 0;
    }
    currentZip.file(path, data);
    currentBytes += data.length;
    entriesInCurrent += 1;
  }
  if (entriesInCurrent > 0) {
    const out = await currentZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const name = `${baseName}.part-${partIndex}.zip`;
    await writeFile(join(ctx.scratchDir, name), out);
    fileRefs.push({ ref: name, bytes: out.length, sha256: "", mime: "application/zip", filename: name });
  }

  return {
    ok: true,
    outputs: { partCount: fileRefs.length, partSizeBytes },
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
