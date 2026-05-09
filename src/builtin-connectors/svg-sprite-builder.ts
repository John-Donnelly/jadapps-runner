/**
 * svg-sprite-builder: combines multiple SVG inputs into a single sprite
 * sheet with each source becoming a `<symbol>` referenced by its filename.
 * Use as `<svg><use href="sprite.svg#name"/></svg>` from your markup.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function svgSpriteBuilder(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "svg-sprite-builder requires at least one SVG input");
  }

  const symbols: string[] = [];
  let totalIn = 0;
  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    const text = await readFile(path, "utf8");
    const id = (ref.filename ?? ref.ref).replace(/\.svg$/i, "").replace(/[^a-zA-Z0-9_-]/g, "-");
    const viewBoxMatch = /<svg[^>]*\bviewBox="([^"]+)"/i.exec(text);
    const viewBox = viewBoxMatch ? viewBoxMatch[1] : "0 0 24 24";
    const inner = text.replace(/<\?xml[\s\S]*?\?>/g, "").replace(/<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
    symbols.push(`  <symbol id="${id}" viewBox="${viewBox}">${inner.trim()}</symbol>`);
  }
  ctx.emitProgress(totalIn);

  const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
${symbols.join("\n")}
</svg>
`;
  const outRef = "sprite.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, sprite, "utf8");

  return {
    ok: true,
    outputs: { symbolCount: symbols.length, ids: ctx.fileRefs.map((r) => (r.filename ?? r.ref).replace(/\.svg$/i, "").replace(/[^a-zA-Z0-9_-]/g, "-")) },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(sprite, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
