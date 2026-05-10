/**
 * vertex-face-counter: reports unique vertex count, face count, and
 * Euler characteristic of an STL mesh.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";
import { parseStl } from "./_stl-utils.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function vertexFaceCounter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "vertex-face-counter requires one STL input");
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const tris = parseStl(buf);
  const verts = new Set<string>();
  const edges = new Set<string>();
  for (const t of tris) {
    const keys = t.v.map((v) => v.join(",")) as [string, string, string];
    for (const k of keys) verts.add(k);
    for (let i = 0; i < 3; i++) {
      const a = keys[i]!, b = keys[(i + 1) % 3]!;
      edges.add(a < b ? `${a}|${b}` : `${b}|${a}`);
    }
  }
  const V = verts.size, F = tris.length, E = edges.size;
  const euler = V - E + F;
  const json = JSON.stringify({ file: ref.filename ?? ref.ref, vertices: V, faces: F, edges: E, eulerCharacteristic: euler }, null, 2);
  const outRef = "vf-count.json";
  await writeFile(join(ctx.scratchDir, outRef), json, "utf8");
  return { ok: true, outputs: { vertices: V, faces: F, edges: E, eulerCharacteristic: euler }, fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(json, "utf8"), sha256: "", mime: "application/json", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
