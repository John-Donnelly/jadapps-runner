/**
 * ligature-toggler: emits CSS that toggles common ligature features
 * (liga, dlig, calt) on or off for a target selector. Doesn't modify
 * the font itself — the toggle happens at the CSS layer.
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

export default async function ligatureToggler(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const selector = String(cfg.selector ?? "body");
  const standard = Boolean(cfg.standard ?? true);
  const discretionary = Boolean(cfg.discretionary ?? false);
  const contextual = Boolean(cfg.contextual ?? true);
  const historical = Boolean(cfg.historical ?? false);

  const features: string[] = [];
  features.push(`"liga" ${standard ? 1 : 0}`);
  features.push(`"dlig" ${discretionary ? 1 : 0}`);
  features.push(`"clig" ${contextual ? 1 : 0}`);
  features.push(`"hlig" ${historical ? 1 : 0}`);

  const css = [
    `${selector} {`,
    `  font-feature-settings: ${features.join(", ")};`,
    `  font-variant-ligatures: ${standard ? "common-ligatures" : "no-common-ligatures"} ${discretionary ? "discretionary-ligatures" : "no-discretionary-ligatures"} ${contextual ? "contextual" : "no-contextual"} ${historical ? "historical-ligatures" : "no-historical-ligatures"};`,
    `}`,
    ``,
  ].join("\n");

  const outRef = "ligature-toggle.css";
  await writeFile(join(ctx.scratchDir, outRef), css, "utf8");
  ctx.emitProgress(css.length);

  return {
    ok: true,
    outputs: { selector, standard, discretionary, contextual, historical },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(css, "utf8"), sha256: "", mime: "text/css", filename: outRef }],
    bytesProcessed: css.length,
    durationMs: Date.now() - start,
  };
}
