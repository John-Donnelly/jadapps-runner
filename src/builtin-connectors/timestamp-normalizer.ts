/**
 * timestamp-normalizer: rewrites every entry's mtime in a ZIP to a
 * fixed deterministic value (default: 2000-01-01T00:00:00Z). Produces
 * reproducible builds where the only variation is content, not when
 * the archive was zipped.
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

export default async function timestampNormalizer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "timestamp-normalizer requires one ZIP input");
  const cfg = ctx.inputs ?? {};
  const fixedTimestamp = typeof cfg.timestamp === "string" ? new Date(cfg.timestamp) : new Date("2000-01-01T00:00:00Z");
  if (Number.isNaN(fixedTimestamp.getTime())) {
    return errorResult("invalid_input", "timestamp must be ISO-8601 parseable");
  }

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
  ctx.emitProgress(totalIn);

  const out = new (JSZip as unknown as new () => import("jszip"))();
  let normalized = 0;
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const data = await file.async("nodebuffer");
    out.file(path, data, { date: fixedTimestamp });
    normalized += 1;
  }

  const outBuf = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const outRef = (ref.filename ?? ref.ref).replace(/\.zip$/i, ".normalized.zip");
  await writeFile(join(ctx.scratchDir, outRef), outBuf);

  return {
    ok: true,
    outputs: { normalizedCount: normalized, fixedTimestamp: fixedTimestamp.toISOString() },
    fileRefs: [{ ref: outRef, bytes: outBuf.length, sha256: "", mime: "application/zip", filename: outRef }],
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
