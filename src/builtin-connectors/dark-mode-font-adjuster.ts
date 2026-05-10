/**
 * dark-mode-font-adjuster: emits a media-query block that nudges weight
 * and color slightly down for dark mode (since light text on dark
 * looks heavier than dark text on light at the same weight).
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

export default async function darkModeFontAdjuster(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const selector = String(cfg.selector ?? "body");
  const lightWeight = Number(cfg.lightWeight ?? 400);
  const darkWeight = Number(cfg.darkWeight ?? 300);
  const lightColor = String(cfg.lightColor ?? "#1a1a1a");
  const darkColor = String(cfg.darkColor ?? "#e8e8e8");

  const css = [
    `${selector} {`,
    `  font-weight: ${lightWeight};`,
    `  color: ${lightColor};`,
    `}`,
    ``,
    `@media (prefers-color-scheme: dark) {`,
    `  ${selector} {`,
    `    font-weight: ${darkWeight};`,
    `    color: ${darkColor};`,
    `    -webkit-font-smoothing: antialiased;`,
    `    -moz-osx-font-smoothing: grayscale;`,
    `  }`,
    `}`,
    ``,
  ].join("\n");

  const outRef = "dark-mode-font.css";
  await writeFile(join(ctx.scratchDir, outRef), css, "utf8");
  ctx.emitProgress(css.length);

  return {
    ok: true,
    outputs: { selector, lightWeight, darkWeight, lightColor, darkColor },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(css, "utf8"), sha256: "", mime: "text/css", filename: outRef }],
    bytesProcessed: css.length,
    durationMs: Date.now() - start,
  };
}
