/**
 * archive-merger: combines the contents of multiple ZIPs into a single
 * output ZIP. On filename collision the later input wins (or returns an
 * error if `onCollision: "error"`).
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

export default async function archiveMerger(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length < 2) {
    return errorResult("missing_input", "archive-merger requires at least two archives");
  }
  const cfg = ctx.inputs ?? {};
  const onCollision = ["error", "skip", "overwrite"].includes(cfg.onCollision as string) ? cfg.onCollision as string : "overwrite";

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const out = new (JSZip as unknown as new () => import("jszip"))();
  let totalIn = 0;
  let collisions = 0;
  const seen = new Set<string>();
  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    const buf = await readFile(path);
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) continue;
    const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
    for (const [entryPath, file] of Object.entries(zip.files)) {
      if (file.dir) continue;
      const data = await file.async("nodebuffer");
      if (seen.has(entryPath)) {
        collisions += 1;
        if (onCollision === "error") return errorResult("collision", `path collision: ${entryPath}`);
        if (onCollision === "skip") continue;
      }
      out.file(entryPath, data);
      seen.add(entryPath);
    }
  }
  ctx.emitProgress(totalIn);

  const buf = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const outRef = "merged.zip";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, buf);

  return {
    ok: true,
    outputs: { archivesMerged: ctx.fileRefs.length, totalEntries: seen.size, collisions, onCollision },
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
