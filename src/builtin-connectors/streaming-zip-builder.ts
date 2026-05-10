/**
 * streaming-zip-builder: builds a ZIP from many inputs, emitting
 * progress per entry. Functionally same as folder-to-zip but
 * checkpoints emitProgress so larger jobs surface intermediate state
 * to the orchestrator.
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

export default async function streamingZipBuilder(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "streaming-zip-builder requires at least one input");
  }

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const zip = new (JSZip as unknown as new () => import("jszip"))();
  let processed = 0;
  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    const inSize = sizeOrFallback(path, ref.bytes);
    const data = await readFile(path);
    zip.file(ref.filename ?? ref.ref, data);
    processed += inSize;
    ctx.emitProgress(processed);
  }

  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const outRef = "streamed.zip";
  await writeFile(join(ctx.scratchDir, outRef), out);

  return {
    ok: true,
    outputs: { entryCount: ctx.fileRefs.length, inputBytes: processed, outputBytes: out.length },
    fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "application/zip", filename: outRef }],
    bytesProcessed: processed,
    durationMs: Date.now() - start,
  };
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
