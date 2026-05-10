/**
 * css-variable-generator-font: generates a :root block of CSS custom
 * properties for a typographic system — font sizes, weights,
 * line-heights, letter-spacings — based on a base size + ratio.
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

export default async function cssVariableGeneratorFont(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const basePx = Number(cfg.baseSize ?? 16);
  const ratio = Number(cfg.scaleRatio ?? 1.25);
  const steps = Math.max(1, Math.min(12, Number(cfg.steps ?? 6)));

  if (![basePx, ratio].every((n) => Number.isFinite(n) && n > 0)) {
    return errorResult("invalid_input", "baseSize and scaleRatio must be positive numbers");
  }

  const lines: string[] = [":root {"];
  lines.push(`  --fs-base: ${basePx}px;`);
  for (let i = 1; i <= steps; i++) {
    lines.push(`  --fs-${i}: ${(basePx * Math.pow(ratio, i)).toFixed(2)}px;`);
  }
  for (let i = 1; i <= steps; i++) {
    lines.push(`  --fs-sm-${i}: ${(basePx / Math.pow(ratio, i)).toFixed(2)}px;`);
  }
  for (const w of [100, 300, 400, 500, 600, 700, 800, 900]) {
    lines.push(`  --fw-${w}: ${w};`);
  }
  for (const lh of [1, 1.2, 1.4, 1.6, 1.8]) {
    lines.push(`  --lh-${lh.toString().replace(".", "_")}: ${lh};`);
  }
  lines.push("}");
  const css = lines.join("\n") + "\n";

  const outRef = "font-variables.css";
  await writeFile(join(ctx.scratchDir, outRef), css, "utf8");
  ctx.emitProgress(css.length);

  return {
    ok: true,
    outputs: { basePx, ratio, steps, varCount: lines.length - 2 },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(css, "utf8"), sha256: "", mime: "text/css", filename: outRef }],
    bytesProcessed: css.length,
    durationMs: Date.now() - start,
  };
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
