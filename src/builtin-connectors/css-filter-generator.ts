/**
 * css-filter-generator: emits a CSS `filter:` declaration that mimics
 * common Instagram/photo presets ("vintage", "noir", "warm", "cool").
 * Pure-text generator; no image is touched.
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

const PRESETS: Record<string, string> = {
  vintage: "sepia(0.4) contrast(1.1) brightness(1.05) saturate(1.1)",
  noir: "grayscale(1) contrast(1.4) brightness(0.9)",
  warm: "saturate(1.4) hue-rotate(-10deg) brightness(1.05)",
  cool: "saturate(1.2) hue-rotate(15deg) brightness(0.97)",
  faded: "saturate(0.6) brightness(1.05) contrast(0.9)",
  vivid: "saturate(1.6) contrast(1.15)",
};

export default async function cssFilterGenerator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const preset = String(cfg.preset ?? "vintage");
  const filter = PRESETS[preset] ?? PRESETS.vintage!;
  const selector = String(cfg.selector ?? ".filtered");
  const css = `${selector} {\n  filter: ${filter};\n}\n`;
  const outRef = "css-filter.css";
  await writeFile(join(ctx.scratchDir, outRef), css, "utf8");
  ctx.emitProgress(css.length);
  return { ok: true, outputs: { preset, filter }, fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(css, "utf8"), sha256: "", mime: "text/css", filename: outRef }], bytesProcessed: css.length, durationMs: Date.now() - start };
}
