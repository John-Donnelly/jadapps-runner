/**
 * svg-css-variable-injector: replaces hardcoded fill/stroke colors with
 * CSS custom-properties so the SVG can be themed at runtime via
 * `style="--brand: red"`. Maps original color → variable name.
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

export default async function svgCssVariableInjector(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-css-variable-injector requires one SVG input");
  const cfg = ctx.inputs ?? {};
  const mappings = parseMap(cfg.mappings);
  if (!mappings || Object.keys(mappings).length === 0) {
    return errorResult("invalid_config", "mappings JSON object is required ({\"#abcdef\": \"--brand\"})");
  }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  let result = text;
  let totalReplacements = 0;
  for (const [from, varName] of Object.entries(mappings)) {
    const fromNorm = from.replace(/^#/, "").toLowerCase();
    const fallbackColor = "#" + fromNorm;
    const replacement = `var(${varName}, ${fallbackColor})`;
    const re = new RegExp(`#${fromNorm}\\b`, "gi");
    let count = 0;
    result = result.replace(re, () => { count++; return replacement; });
    totalReplacements += count;
  }

  const outRef = ref.filename ?? "themable.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, result, "utf8");

  return {
    ok: true,
    outputs: { totalReplacements, mappings },
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
    try { const parsed = JSON.parse(input); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) { const out: Record<string, string> = {}; for (const [k, v] of Object.entries(parsed)) out[k] = String(v ?? ""); return out; } } catch { return null; }
  }
  return null;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
