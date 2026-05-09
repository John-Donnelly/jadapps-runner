/**
 * svg-unused-defs-purger: removes <defs> children whose `id` isn't
 * referenced anywhere else in the document. Catches gradients, clipPaths,
 * filters, and symbols left behind after editing.
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

export default async function svgUnusedDefsPurger(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-unused-defs-purger requires one SVG input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  // Pull every `id` defined inside <defs> blocks.
  const defsRe = /<defs[^>]*>([\s\S]*?)<\/defs>/g;
  const definedIds = new Set<string>();
  for (const m of text.matchAll(defsRe)) {
    for (const idMatch of (m[1] ?? "").matchAll(/\bid="([^"]+)"/g)) definedIds.add(idMatch[1]!);
  }
  if (definedIds.size === 0) {
    const outRef = ref.filename ?? "out.svg";
    const outPath = join(ctx.scratchDir, outRef);
    await writeFile(outPath, text, "utf8");
    return {
      ok: true,
      outputs: { removedCount: 0, note: "no <defs> ids found" },
      fileRefs: [{ ref: outRef, bytes: totalIn, sha256: "", mime: "image/svg+xml", filename: outRef }],
      bytesProcessed: totalIn,
      durationMs: Date.now() - start,
    };
  }

  // Strip <defs> from the body and check what references each id.
  const bodyOutsideDefs = text.replace(defsRe, "");
  const usedIds = new Set<string>();
  for (const id of definedIds) {
    const re = new RegExp(`url\\(#${escapeRegex(id)}\\)|xlink:href="#${escapeRegex(id)}"|href="#${escapeRegex(id)}"`);
    if (re.test(bodyOutsideDefs)) usedIds.add(id);
  }

  let removedCount = 0;
  const result = text.replace(defsRe, (full, body) => {
    // Remove top-level children of <defs> whose id is unused.
    const filtered = (body as string).replace(/<([A-Za-z][\w-]*)([^>]*)\bid="([^"]+)"([^>]*)(?:\/>|>([\s\S]*?)<\/\1>)/g, (m, _tag, _pre, id) => {
      if (usedIds.has(id as string)) return m;
      removedCount += 1;
      return "";
    });
    return `<defs>${filtered}</defs>`;
  });

  const outRef = ref.filename ?? "purged.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, result, "utf8");

  return {
    ok: true,
    outputs: { definedCount: definedIds.size, usedCount: usedIds.size, removedCount },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(result, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
