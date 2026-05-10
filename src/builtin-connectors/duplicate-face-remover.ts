/**
 * duplicate-face-remover: removes triangles whose three vertices match
 * an already-seen triangle (regardless of winding).
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";
import { parseStl, writeBinaryStl } from "./_stl-utils.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function duplicateFaceRemover(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "duplicate-face-remover requires one STL input");
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const tris = parseStl(buf);
  const seen = new Set<string>();
  const kept: typeof tris = [];
  let removed = 0;
  for (const t of tris) {
    const keys = t.v.map((v) => v.map((c) => c.toFixed(5)).join(",")).sort().join("|");
    if (seen.has(keys)) { removed += 1; continue; }
    seen.add(keys);
    kept.push(t);
  }
  const out = writeBinaryStl(kept);
  const outRef = (ref.filename ?? ref.ref).replace(/\.stl$/i, ".dedup.stl");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { originalCount: tris.length, removedCount: removed, keptCount: kept.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "model/stl", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
