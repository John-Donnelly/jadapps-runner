/**
 * svg-filter-injector: appends an `<filter>` element to <defs> and applies
 * it to a target element selected by `targetId`. Built-in presets:
 * "drop-shadow", "blur", "grayscale", "duotone", "noise".
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

const PRESETS: Record<string, (id: string, cfg: Record<string, unknown>) => string> = {
  "drop-shadow": (id) => `<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="2" dy="3" stdDeviation="2" flood-opacity="0.4"/></filter>`,
  blur: (id, cfg) => `<filter id="${id}"><feGaussianBlur stdDeviation="${Number(cfg.stdDeviation ?? 4)}"/></filter>`,
  grayscale: (id) => `<filter id="${id}"><feColorMatrix type="matrix" values="0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0 0 0 1 0"/></filter>`,
  duotone: (id, cfg) => {
    const lo = String(cfg.lowColor ?? "#1e293b");
    const hi = String(cfg.highColor ?? "#facc15");
    return `<filter id="${id}"><feColorMatrix type="matrix" values="0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0 0 0 1 0"/><feComponentTransfer><feFuncR type="table" tableValues="${parseInt(lo.slice(1, 3), 16) / 255} ${parseInt(hi.slice(1, 3), 16) / 255}"/><feFuncG type="table" tableValues="${parseInt(lo.slice(3, 5), 16) / 255} ${parseInt(hi.slice(3, 5), 16) / 255}"/><feFuncB type="table" tableValues="${parseInt(lo.slice(5, 7), 16) / 255} ${parseInt(hi.slice(5, 7), 16) / 255}"/></feComponentTransfer></filter>`;
  },
  noise: (id) => `<filter id="${id}"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.3 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>`,
};

export default async function svgFilterInjector(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-filter-injector requires one SVG input");
  const cfg = ctx.inputs ?? {};
  const preset = String(cfg.preset ?? "drop-shadow");
  const filterId = String(cfg.filterId ?? `f-${preset}`);
  const targetId = cfg.targetId != null ? String(cfg.targetId) : null;

  const generator = PRESETS[preset];
  if (!generator) return errorResult("invalid_config", `unknown preset: ${preset}. options: ${Object.keys(PRESETS).join(", ")}`);

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const filterXml = generator(filterId, cfg);
  let result: string;
  if (/<defs[^>]*>/i.test(text)) {
    result = text.replace(/<defs([^>]*)>/i, `<defs$1>${filterXml}`);
  } else {
    result = text.replace(/<svg([^>]*)>/i, `<svg$1><defs>${filterXml}</defs>`);
  }
  if (targetId) {
    const targetRe = new RegExp(`(<[A-Za-z][\\w-]*[^>]*\\bid="${escapeRegex(targetId)}")`, "g");
    result = result.replace(targetRe, `$1 filter="url(#${filterId})"`);
  }

  const outRef = ref.filename ?? "filtered.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, result, "utf8");

  return {
    ok: true,
    outputs: { preset, filterId, applied: targetId != null },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(result, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
