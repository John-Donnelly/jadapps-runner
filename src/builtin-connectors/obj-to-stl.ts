/**
 * obj-to-stl: converts a Wavefront OBJ to binary STL.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";
import { writeBinaryStl, type Triangle } from "./_stl-utils.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function objToStl(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "obj-to-stl requires one OBJ input");
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const verts: [number, number, number][] = [];
  const tris: Triangle[] = [];
  for (const line of text.split(/\r?\n/)) {
    const tok = line.trim().split(/\s+/);
    if (tok[0] === "v" && tok.length >= 4) {
      verts.push([parseFloat(tok[1]!), parseFloat(tok[2]!), parseFloat(tok[3]!)]);
    } else if (tok[0] === "f" && tok.length >= 4) {
      const idxs = tok.slice(1).map((s) => parseInt(s.split("/")[0] ?? "0", 10) - 1);
      // Fan-triangulate polygon faces
      for (let i = 1; i < idxs.length - 1; i++) {
        const a = verts[idxs[0]!]!, b = verts[idxs[i]!]!, c = verts[idxs[i + 1]!]!;
        if (!a || !b || !c) continue;
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const nx = ab[1]! * ac[2]! - ab[2]! * ac[1]!;
        const ny = ab[2]! * ac[0]! - ab[0]! * ac[2]!;
        const nz = ab[0]! * ac[1]! - ab[1]! * ac[0]!;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        tris.push({ nx: nx / len, ny: ny / len, nz: nz / len, v: [a, b, c] });
      }
    }
  }

  const out = writeBinaryStl(tris);
  const outRef = (ref.filename ?? ref.ref).replace(/\.obj$/i, ".stl");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { vertexCount: verts.length, triangleCount: tris.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "model/stl", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
