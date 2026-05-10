/**
 * variable-font-size-calc: compute fluid CSS sizes for variable fonts —
 * given a base px size and viewport range, emit a CSS variable that
 * scales with viewport using clamp().
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

export default async function variableFontSizeCalc(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const minRem = Number(cfg.minRem ?? 1);
  const maxRem = Number(cfg.maxRem ?? 2);
  const minVw = Number(cfg.minViewport ?? 320);
  const maxVw = Number(cfg.maxViewport ?? 1440);
  if (![minRem, maxRem, minVw, maxVw].every((n) => Number.isFinite(n) && n > 0)) {
    return errorResult("invalid_input", "all numeric inputs must be positive");
  }

  const slope = (maxRem * 16 - minRem * 16) / (maxVw - minVw);
  const intercept = minRem * 16 - slope * minVw;
  const preferred = `${(slope * 100).toFixed(4)}vw + ${intercept.toFixed(4)}px`;
  const css = [
    `:root {`,
    `  --fluid-fs: clamp(${minRem}rem, ${preferred}, ${maxRem}rem);`,
    `}`,
    `.fluid-text { font-size: var(--fluid-fs); }`,
    ``,
  ].join("\n");

  const outRef = "variable-font-size.css";
  await writeFile(join(ctx.scratchDir, outRef), css, "utf8");
  ctx.emitProgress(css.length);

  return {
    ok: true,
    outputs: { minRem, maxRem, minVw, maxVw, preferred },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(css, "utf8"), sha256: "", mime: "text/css", filename: outRef }],
    bytesProcessed: css.length,
    durationMs: Date.now() - start,
  };
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
