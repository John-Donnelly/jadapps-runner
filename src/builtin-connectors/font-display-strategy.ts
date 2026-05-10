/**
 * font-display-strategy: emits a recommended @font-face block that picks
 * a font-display value based on the input strategy ("fast", "balanced",
 * "loyal") and the font role ("body", "headline", "icon").
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

export default async function fontDisplayStrategy(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const strategy = ["fast", "balanced", "loyal"].includes(String(cfg.strategy ?? "balanced")) ? String(cfg.strategy ?? "balanced") : "balanced";
  const role = ["body", "headline", "icon"].includes(String(cfg.role ?? "body")) ? String(cfg.role ?? "body") : "body";
  const family = String(cfg.family ?? "MyFont");
  const url = String(cfg.url ?? "/fonts/myfont.woff2");

  let display = "swap";
  if (strategy === "fast") display = "swap";
  else if (strategy === "balanced") display = role === "icon" ? "block" : "swap";
  else if (strategy === "loyal") display = role === "headline" ? "optional" : "swap";

  const css = [
    `@font-face {`,
    `  font-family: "${family}";`,
    `  src: url("${url}") format("woff2");`,
    `  font-weight: 400;`,
    `  font-style: normal;`,
    `  font-display: ${display};`,
    `}`,
    ``,
  ].join("\n");

  const outRef = "font-display.css";
  await writeFile(join(ctx.scratchDir, outRef), css, "utf8");
  ctx.emitProgress(css.length);

  return {
    ok: true,
    outputs: { strategy, role, fontDisplay: display, family },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(css, "utf8"), sha256: "", mime: "text/css", filename: outRef }],
    bytesProcessed: css.length,
    durationMs: Date.now() - start,
  };
}
