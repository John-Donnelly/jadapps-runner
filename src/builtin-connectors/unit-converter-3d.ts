/**
 * unit-converter-3d: scales an STL by a unit-conversion factor (e.g.
 * inches → mm). Outputs binary STL.
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

const FACTORS: Record<string, number> = {
  "in-to-mm": 25.4, "mm-to-in": 1 / 25.4,
  "cm-to-mm": 10, "mm-to-cm": 0.1,
  "ft-to-mm": 304.8, "m-to-mm": 1000, "mm-to-m": 0.001,
};

export default async function unitConverter3d(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "unit-converter-3d requires one STL input");
  const cfg = ctx.inputs ?? {};
  const conversion = String(cfg.conversion ?? "in-to-mm");
  const factor = FACTORS[conversion] ?? Number(cfg.factor ?? 1);
  if (!Number.isFinite(factor) || factor === 0) return errorResult("invalid_input", `unknown conversion '${conversion}'`);

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const tris = parseStl(buf).map((t) => ({
    nx: t.nx, ny: t.ny, nz: t.nz,
    v: t.v.map(([x, y, z]) => [x * factor, y * factor, z * factor]) as [number, number, number][],
  }));
  const out = writeBinaryStl(tris);
  const outRef = (ref.filename ?? ref.ref).replace(/\.stl$/i, `.${conversion}.stl`);
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { conversion, factor, triangleCount: tris.length }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "model/stl", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
