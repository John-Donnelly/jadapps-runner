/**
 * svg-hex-swapper: replaces hex colors throughout an SVG. Pass `mappings`
 * as a JSON map of {oldHex: newHex} (case-insensitive, with or without #).
 * Useful for theming a vector asset without re-editing in a vector tool.
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

export default async function svgHexSwapper(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-hex-swapper requires one SVG input");
  const cfg = ctx.inputs ?? {};
  const mappings = parseMap(cfg.mappings);
  if (!mappings || Object.keys(mappings).length === 0) return errorResult("invalid_config", "mappings JSON object is required");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  let result = text;
  let totalReplacements = 0;
  for (const [from, to] of Object.entries(mappings)) {
    const fromNorm = from.replace(/^#/, "").toLowerCase();
    const toNorm = "#" + to.replace(/^#/, "").toLowerCase();
    const re = new RegExp(`#${fromNorm}\\b`, "gi");
    let count = 0;
    result = result.replace(re, () => { count++; return toNorm; });
    totalReplacements += count;
  }

  const outRef = ref.filename ?? "themed.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, result, "utf8");

  return {
    ok: true,
    outputs: { totalReplacements, mappingCount: Object.keys(mappings).length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(result, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function parseMap(input: unknown): Record<string, string> | null {
  if (input == null) return null;
  if (typeof input === "object" && !Array.isArray(input)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[k] = String(v ?? "");
    return out;
  }
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) out[k] = String(v ?? "");
        return out;
      }
    } catch { return null; }
  }
  return null;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
