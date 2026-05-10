/**
 * archive-diff: compares two ZIP archives entry-by-entry and reports
 * additions, removals, and content-modifications (sha256). Output is
 * a JSON report.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function archiveDiff(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length < 2) {
    return errorResult("missing_input", "archive-diff requires exactly two ZIP inputs");
  }
  const refA = ctx.fileRefs[0];
  const refB = ctx.fileRefs[1];
  if (!refA || !refB) return errorResult("missing_input", "archive-diff requires two ZIP inputs");

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const aPath = join(ctx.scratchDir, refA.ref);
  const bPath = join(ctx.scratchDir, refB.ref);
  const totalIn = sizeOrFallback(aPath, refA.bytes) + sizeOrFallback(bPath, refB.bytes);
  const aBuf = await readFile(aPath);
  const bBuf = await readFile(bPath);
  const zipA = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(aBuf);
  const zipB = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(bBuf);
  ctx.emitProgress(totalIn);

  const hashesA = await collectHashes(zipA);
  const hashesB = await collectHashes(zipB);
  const allPaths = new Set([...hashesA.keys(), ...hashesB.keys()]);

  const added: string[] = [];
  const removed: string[] = [];
  const modified: { path: string; oldSha: string; newSha: string }[] = [];
  const unchanged: string[] = [];
  for (const path of allPaths) {
    const a = hashesA.get(path);
    const b = hashesB.get(path);
    if (!a && b) added.push(path);
    else if (a && !b) removed.push(path);
    else if (a && b && a !== b) modified.push({ path, oldSha: a, newSha: b });
    else if (a && b) unchanged.push(path);
  }

  const report = {
    archiveA: refA.filename ?? refA.ref,
    archiveB: refB.filename ?? refB.ref,
    addedCount: added.length,
    removedCount: removed.length,
    modifiedCount: modified.length,
    unchangedCount: unchanged.length,
    added, removed, modified,
  };
  const out = JSON.stringify(report, null, 2);
  const outRef = "archive-diff.json";
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");

  return {
    ok: true,
    outputs: { added: added.length, removed: removed.length, modified: modified.length, unchanged: unchanged.length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

async function collectHashes(zip: import("jszip")): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const data = await file.async("nodebuffer");
    map.set(path, createHash("sha256").update(data).digest("hex"));
  }
  return map;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
