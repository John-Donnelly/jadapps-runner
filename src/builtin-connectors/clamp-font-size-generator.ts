/**
 * clamp-font-size-generator: emits CSS clamp(min, preferred, max) for a
 * range of font sizes between two viewport widths. Output is a CSS
 * snippet ready to drop into a stylesheet.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function clampFontSizeGenerator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const minPx = Number(cfg.minSize ?? 14);
  const maxPx = Number(cfg.maxSize ?? 32);
  const minVw = Number(cfg.minViewport ?? 320);
  const maxVw = Number(cfg.maxViewport ?? 1440);
  const selector = String(cfg.selector ?? "html");

  if (![minPx, maxPx, minVw, maxVw].every((n) => Number.isFinite(n) && n > 0)) {
    return errorResult("invalid_input", "minSize/maxSize/minViewport/maxViewport must be positive numbers");
  }

  const slope = (maxPx - minPx) / (maxVw - minVw);
  const yIntercept = minPx - slope * minVw;
  const preferred = `${(slope * 100).toFixed(4)}vw + ${yIntercept.toFixed(4)}px`;
  const css = `${selector} {\n  font-size: clamp(${minPx}px, ${preferred}, ${maxPx}px);\n}\n`;

  const outRef = "clamp-font-size.css";
  await writeFile(join(ctx.scratchDir, outRef), css, "utf8");
  ctx.emitProgress(css.length);

  return {
    ok: true,
    outputs: { minPx, maxPx, minVw, maxVw, preferred },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(css, "utf8"), sha256: "", mime: "text/css", filename: outRef }],
    bytesProcessed: css.length,
    durationMs: Date.now() - start,
  };
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
