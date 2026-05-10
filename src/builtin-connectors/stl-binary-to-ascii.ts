/**
 * stl-binary-to-ascii: converts a binary STL to ASCII STL.
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

export default async function stlBinaryToAscii(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "stl-binary-to-ascii requires one STL input");
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  if (buf.length < 84) return errorResult("invalid_stl", "input is too small to be a binary STL");
  const tris = buf.readUInt32LE(80);
  const lines: string[] = ["solid converted"];
  for (let i = 0; i < tris; i++) {
    const o = 84 + i * 50;
    if (o + 50 > buf.length) break;
    const nx = buf.readFloatLE(o), ny = buf.readFloatLE(o + 4), nz = buf.readFloatLE(o + 8);
    lines.push(`  facet normal ${nx} ${ny} ${nz}`);
    lines.push(`    outer loop`);
    for (let v = 0; v < 3; v++) {
      const p = o + 12 + v * 12;
      lines.push(`      vertex ${buf.readFloatLE(p)} ${buf.readFloatLE(p + 4)} ${buf.readFloatLE(p + 8)}`);
    }
    lines.push(`    endloop`);
    lines.push(`  endfacet`);
  }
  lines.push("endsolid converted");
  const out = lines.join("\n") + "\n";
  const outRef = (ref.filename ?? ref.ref).replace(/\.stl$/i, ".ascii.stl");
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");
  return { ok: true, outputs: { triangleCount: tris, inputBytes: buf.length, outputBytes: Buffer.byteLength(out, "utf8") }, fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "model/stl", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
