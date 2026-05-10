/**
 * stl-ascii-to-binary: converts an ASCII STL to binary STL.
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

export default async function stlAsciiToBinary(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "stl-ascii-to-binary requires one STL input");
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);
  const tris = parseAsciiStl(text);
  if (tris.length === 0) return errorResult("invalid_stl", "no triangles parsed; input may be binary or invalid ASCII STL");
  const out = Buffer.alloc(84 + tris.length * 50);
  out.writeUInt32LE(tris.length, 80);
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i]!;
    const o = 84 + i * 50;
    out.writeFloatLE(t.nx, o); out.writeFloatLE(t.ny, o + 4); out.writeFloatLE(t.nz, o + 8);
    for (let v = 0; v < 3; v++) {
      const p = o + 12 + v * 12;
      out.writeFloatLE(t.v[v]![0]!, p);
      out.writeFloatLE(t.v[v]![1]!, p + 4);
      out.writeFloatLE(t.v[v]![2]!, p + 8);
    }
  }
  const outRef = (ref.filename ?? ref.ref).replace(/\.stl$/i, ".binary.stl");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { triangleCount: tris.length, inputBytes: text.length, outputBytes: out.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "model/stl", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

export function parseAsciiStl(text: string): { nx: number; ny: number; nz: number; v: number[][] }[] {
  const tris: { nx: number; ny: number; nz: number; v: number[][] }[] = [];
  const tokens = text.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "facet" && tokens[i + 1] === "normal") {
      const nx = parseFloat(tokens[i + 2] ?? "0"), ny = parseFloat(tokens[i + 3] ?? "0"), nz = parseFloat(tokens[i + 4] ?? "0");
      const v: number[][] = [];
      let j = i + 5;
      while (j < tokens.length && v.length < 3) {
        if (tokens[j] === "vertex") {
          v.push([parseFloat(tokens[j + 1] ?? "0"), parseFloat(tokens[j + 2] ?? "0"), parseFloat(tokens[j + 3] ?? "0")]);
          j += 4;
        } else j += 1;
      }
      if (v.length === 3) tris.push({ nx, ny, nz, v });
      i = j;
    }
  }
  return tris;
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
