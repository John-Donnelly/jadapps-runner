/**
 * zip-comment-editor: replaces or appends the archive-level comment of
 * a ZIP. JSZip's archive-comment support is straightforward but the
 * comment must be written in the end-of-central-directory record.
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

export default async function zipCommentEditor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "zip-comment-editor requires one ZIP input");
  const cfg = ctx.inputs ?? {};
  const newComment = typeof cfg.comment === "string" ? cfg.comment : "";
  const mode = ["replace", "append", "clear"].includes(String(cfg.mode ?? "replace")) ? String(cfg.mode ?? "replace") : "replace";

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
  ctx.emitProgress(totalIn);

  const existing = (zip as unknown as { comment?: string }).comment ?? "";
  let finalComment: string;
  if (mode === "clear") finalComment = "";
  else if (mode === "append") finalComment = existing + (existing ? "\n" : "") + newComment;
  else finalComment = newComment;

  const out = new (JSZip as unknown as new () => import("jszip"))();
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    out.file(path, await file.async("nodebuffer"));
  }
  const outBuf = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE", comment: finalComment });
  const outRef = (ref.filename ?? ref.ref).replace(/\.zip$/i, ".commented.zip");
  await writeFile(join(ctx.scratchDir, outRef), outBuf);

  return {
    ok: true,
    outputs: { mode, oldComment: existing, newComment: finalComment },
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
