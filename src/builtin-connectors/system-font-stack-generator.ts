/**
 * system-font-stack-generator: emits a recommended cross-platform
 * system font-stack for the requested role ("ui", "serif", "mono"),
 * matching modern OS defaults (Apple system, Segoe UI, Roboto, etc.).
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

const STACKS: Record<string, string[]> = {
  ui: ["-apple-system", "BlinkMacSystemFont", `"Segoe UI"`, "Roboto", `"Helvetica Neue"`, "Arial", `"Apple Color Emoji"`, `"Segoe UI Emoji"`, "sans-serif"],
  serif: [`"Iowan Old Style"`, `"Apple Garamond"`, "Baskerville", `"Times New Roman"`, `"Droid Serif"`, "Times", "serif"],
  mono: ["Menlo", "Consolas", "Monaco", `"Liberation Mono"`, `"Lucida Console"`, "monospace"],
  display: ["Athelas", "Constantia", "Georgia", `"Times New Roman"`, "serif"],
};

export default async function systemFontStackGenerator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const role = (Object.keys(STACKS).includes(String(cfg.role ?? "ui")) ? String(cfg.role ?? "ui") : "ui");
  const selector = String(cfg.selector ?? "body");
  const stack = STACKS[role]!.join(", ");
  const css = `${selector} {\n  font-family: ${stack};\n}\n`;
  const json = JSON.stringify({ role, stack: STACKS[role] }, null, 2);

  await writeFile(join(ctx.scratchDir, "system-font-stack.css"), css, "utf8");
  await writeFile(join(ctx.scratchDir, "system-font-stack.json"), json, "utf8");
  ctx.emitProgress(css.length + json.length);

  return {
    ok: true,
    outputs: { role, fontFamily: stack },
    fileRefs: [
      { ref: "system-font-stack.css", bytes: Buffer.byteLength(css, "utf8"), sha256: "", mime: "text/css", filename: "system-font-stack.css" },
      { ref: "system-font-stack.json", bytes: Buffer.byteLength(json, "utf8"), sha256: "", mime: "application/json", filename: "system-font-stack.json" },
    ],
    bytesProcessed: css.length + json.length,
    durationMs: Date.now() - start,
  };
}
