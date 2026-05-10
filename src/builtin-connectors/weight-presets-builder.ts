/**
 * weight-presets-builder: produces utility classes for the standard
 * 100-900 font-weight scale, named by Tailwind / Material conventions.
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

const PRESETS: { name: string; weight: number }[] = [
  { name: "thin", weight: 100 },
  { name: "extralight", weight: 200 },
  { name: "light", weight: 300 },
  { name: "regular", weight: 400 },
  { name: "medium", weight: 500 },
  { name: "semibold", weight: 600 },
  { name: "bold", weight: 700 },
  { name: "extrabold", weight: 800 },
  { name: "black", weight: 900 },
];

export default async function weightPresetsBuilder(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const prefix = String(cfg.prefix ?? "fw");

  const css = PRESETS.map((p) => `.${prefix}-${p.name} { font-weight: ${p.weight}; }`).join("\n") + "\n";
  const json = JSON.stringify({ prefix, presets: PRESETS }, null, 2);

  await writeFile(join(ctx.scratchDir, "weight-presets.css"), css, "utf8");
  await writeFile(join(ctx.scratchDir, "weight-presets.json"), json, "utf8");
  ctx.emitProgress(css.length + json.length);

  return {
    ok: true,
    outputs: { prefix, presetCount: PRESETS.length },
    fileRefs: [
      { ref: "weight-presets.css", bytes: Buffer.byteLength(css, "utf8"), sha256: "", mime: "text/css", filename: "weight-presets.css" },
      { ref: "weight-presets.json", bytes: Buffer.byteLength(json, "utf8"), sha256: "", mime: "application/json", filename: "weight-presets.json" },
    ],
    bytesProcessed: css.length + json.length,
    durationMs: Date.now() - start,
  };
}
