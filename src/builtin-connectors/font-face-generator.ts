/**
 * font-face-generator: produces a @font-face block per uploaded font
 * file, auto-detecting weight/style from filename hints. Output is
 * `fonts.css` ready to import.
 */

import { writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function fontFaceGenerator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "font-face-generator requires at least one font input");
  }
  const cfg = ctx.inputs ?? {};
  const family = String(cfg.family ?? "CustomFont");
  const baseUrl = String(cfg.baseUrl ?? "/fonts");

  const blocks: string[] = [];
  for (const ref of ctx.fileRefs) {
    const name = (ref.filename ?? ref.ref).toLowerCase();
    const ext = extname(name).toLowerCase().replace(".", "");
    const format = ext === "woff2" ? "woff2" : ext === "woff" ? "woff" : ext === "ttf" ? "truetype" : ext === "otf" ? "opentype" : ext;
    const weight = detectWeight(name);
    const style = name.includes("italic") || name.includes("oblique") ? "italic" : "normal";
    blocks.push([
      `@font-face {`,
      `  font-family: "${family}";`,
      `  src: url("${baseUrl}/${ref.filename ?? ref.ref}") format("${format}");`,
      `  font-weight: ${weight};`,
      `  font-style: ${style};`,
      `  font-display: swap;`,
      `}`,
    ].join("\n"));
  }
  const css = blocks.join("\n\n") + "\n";

  const outRef = "fonts.css";
  await writeFile(join(ctx.scratchDir, outRef), css, "utf8");
  ctx.emitProgress(css.length);

  return {
    ok: true,
    outputs: { faceCount: blocks.length, family },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(css, "utf8"), sha256: "", mime: "text/css", filename: outRef }],
    bytesProcessed: css.length,
    durationMs: Date.now() - start,
  };
}

function detectWeight(name: string): number {
  if (name.includes("thin") || name.includes("hairline")) return 100;
  if (name.includes("extralight") || name.includes("ultralight")) return 200;
  if (name.includes("light")) return 300;
  if (name.includes("medium")) return 500;
  if (name.includes("semibold") || name.includes("demibold")) return 600;
  if (name.includes("extrabold") || name.includes("ultrabold")) return 800;
  if (name.includes("bold")) return 700;
  if (name.includes("black") || name.includes("heavy")) return 900;
  return 400;
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
