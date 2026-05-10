/**
 * typography-scale-builder: emits a complete typographic scale (h1-h6 +
 * body) using the major-third / minor-third / golden / etc. ratio.
 * Output is a CSS file plus a JSON breakdown.
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

const RATIOS: Record<string, number> = {
  "minor-second": 1.067,
  "major-second": 1.125,
  "minor-third": 1.2,
  "major-third": 1.25,
  "perfect-fourth": 1.333,
  "augmented-fourth": 1.414,
  "perfect-fifth": 1.5,
  "golden": 1.618,
};

export default async function typographyScaleBuilder(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const basePx = Number(cfg.baseSize ?? 16);
  const ratioName = String(cfg.ratio ?? "major-third");
  const ratio = RATIOS[ratioName] ?? 1.25;
  if (!Number.isFinite(basePx) || basePx <= 0) {
    return errorResult("invalid_input", "baseSize must be positive");
  }

  const sizes = {
    h1: basePx * Math.pow(ratio, 5),
    h2: basePx * Math.pow(ratio, 4),
    h3: basePx * Math.pow(ratio, 3),
    h4: basePx * Math.pow(ratio, 2),
    h5: basePx * Math.pow(ratio, 1),
    h6: basePx,
    body: basePx,
    small: basePx / ratio,
    xsmall: basePx / Math.pow(ratio, 2),
  };

  const cssLines: string[] = [];
  for (const [tag, size] of Object.entries(sizes)) {
    cssLines.push(`${tag} { font-size: ${size.toFixed(2)}px; line-height: 1.4; }`);
  }
  const css = cssLines.join("\n") + "\n";
  const json = JSON.stringify({ basePx, ratio: ratioName, ratioValue: ratio, sizes }, null, 2);

  await writeFile(join(ctx.scratchDir, "typography-scale.css"), css, "utf8");
  await writeFile(join(ctx.scratchDir, "typography-scale.json"), json, "utf8");
  ctx.emitProgress(css.length + json.length);

  return {
    ok: true,
    outputs: { ratio: ratioName, ratioValue: ratio, sizes },
    fileRefs: [
      { ref: "typography-scale.css", bytes: Buffer.byteLength(css, "utf8"), sha256: "", mime: "text/css", filename: "typography-scale.css" },
      { ref: "typography-scale.json", bytes: Buffer.byteLength(json, "utf8"), sha256: "", mime: "application/json", filename: "typography-scale.json" },
    ],
    bytesProcessed: css.length + json.length,
    durationMs: Date.now() - start,
  };
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
