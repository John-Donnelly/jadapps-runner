/**
 * character-whitelist-builder: from a sample text input (or list of
 * code-points), emits the unique unicode-range CSS subset string and a
 * unicode-list .txt — both feedstock for font-subsetter pipelines.
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

export default async function characterWhitelistBuilder(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  let text = "";
  if (typeof cfg.text === "string") text = cfg.text;
  if (ctx.fileRefs[0]) {
    const inPath = join(ctx.scratchDir, ctx.fileRefs[0].ref);
    text += (text ? "\n" : "") + await readFile(inPath, "utf8");
    ctx.emitProgress(sizeOrFallback(inPath, ctx.fileRefs[0].bytes));
  }
  if (!text) return errorResult("missing_input", "character-whitelist-builder requires text input or a text fileRef");

  const cps = new Set<number>();
  for (const ch of [...text]) {
    const cp = ch.codePointAt(0);
    if (typeof cp === "number") cps.add(cp);
  }
  const sorted = [...cps].sort((a, b) => a - b);
  const ranges = compactRanges(sorted);
  const cssRange = ranges.map((r) => r.from === r.to ? `U+${r.from.toString(16).toUpperCase()}` : `U+${r.from.toString(16).toUpperCase()}-${r.to.toString(16).toUpperCase()}`).join(", ");
  const txt = sorted.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`).join("\n") + "\n";

  await writeFile(join(ctx.scratchDir, "unicode-range.css"), `/* unicode-range: */\n/* ${cssRange} */\n`, "utf8");
  await writeFile(join(ctx.scratchDir, "whitelist.txt"), txt, "utf8");

  return {
    ok: true,
    outputs: { uniqueCodePoints: cps.size, rangeCount: ranges.length, cssRange },
    fileRefs: [
      { ref: "unicode-range.css", bytes: Buffer.byteLength(`/* unicode-range: */\n/* ${cssRange} */\n`, "utf8"), sha256: "", mime: "text/css", filename: "unicode-range.css" },
      { ref: "whitelist.txt", bytes: Buffer.byteLength(txt, "utf8"), sha256: "", mime: "text/plain", filename: "whitelist.txt" },
    ],
    bytesProcessed: text.length,
    durationMs: Date.now() - start,
  };
}

function compactRanges(sorted: number[]): { from: number; to: number }[] {
  const result: { from: number; to: number }[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]! === sorted[j]! + 1) j += 1;
    result.push({ from: sorted[i]!, to: sorted[j]! });
    i = j + 1;
  }
  return result;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
