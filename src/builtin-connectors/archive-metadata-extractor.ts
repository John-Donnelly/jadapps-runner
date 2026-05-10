/**
 * archive-metadata-extractor: pulls all available metadata from a ZIP
 * (comments, file timestamps, attributes, archive comment) without
 * extracting the contents.
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

export default async function archiveMetadataExtractor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "archive-metadata-extractor requires one archive input");

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
  ctx.emitProgress(totalIn);

  const archiveComment = (zip as unknown as { comment?: string }).comment ?? null;
  interface FileMeta { path: string; comment?: string; modified?: string; permissions?: number; isDirectory: boolean; }
  const files: FileMeta[] = [];
  for (const [path, file] of Object.entries(zip.files)) {
    const meta: FileMeta = { path, isDirectory: file.dir };
    if (file.comment) meta.comment = file.comment;
    if (file.date) meta.modified = file.date.toISOString();
    const perms = (file as unknown as { unixPermissions?: number }).unixPermissions;
    if (typeof perms === "number") meta.permissions = perms;
    files.push(meta);
  }

  const out = JSON.stringify({ archiveComment, fileCount: files.length, files }, null, 2);
  const outRef = "metadata.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { archiveComment, fileCount: files.length, hasComments: files.some((f) => f.comment) },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
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
