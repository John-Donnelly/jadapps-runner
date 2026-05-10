/**
 * character-coverage-map: lists every Unicode code point covered by a
 * font, optionally compared against a target character set ("latin",
 * "european", "vietnamese") to compute coverage percentage.
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

const TARGET_SETS: Record<string, [number, number][]> = {
  latin: [[0x0020, 0x007E]],
  european: [[0x0020, 0x007E], [0x00A0, 0x017F]],
  vietnamese: [[0x0020, 0x007E], [0x00C0, 0x024F], [0x1E00, 0x1EFF]],
  cyrillic: [[0x0020, 0x007E], [0x0400, 0x04FF]],
};

export default async function characterCoverageMap(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "character-coverage-map requires one font input");
  const cfg = ctx.inputs ?? {};
  const targetName = String(cfg.target ?? "latin");

  let fontkit: unknown;
  try {
    const fontkitMod = await import("@pdf-lib/fontkit");
    fontkit = (fontkitMod as unknown as { default?: unknown }).default ?? fontkitMod;
  } catch (err) {
    return errorResult("driver_missing", `@pdf-lib/fontkit not installed: ${(err as Error).message}`);
  }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const font = (fontkit as { create(b: Buffer): { characterSet?: number[] } }).create(buf);
  const covered: Set<number> = new Set(font.characterSet ?? []);

  const target = TARGET_SETS[targetName] ?? TARGET_SETS.latin!;
  let targetTotal = 0, targetCovered = 0;
  const missing: number[] = [];
  for (const [from, to] of target) {
    for (let cp = from; cp <= to; cp++) {
      targetTotal += 1;
      if (covered.has(cp)) targetCovered += 1;
      else missing.push(cp);
    }
  }

  const summary = {
    file: ref.filename ?? ref.ref,
    target: targetName,
    coveredCount: covered.size,
    targetTotal,
    targetCovered,
    coveragePercent: targetTotal > 0 ? (targetCovered / targetTotal) * 100 : 0,
    missing: missing.slice(0, 256).map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`),
    missingTotal: missing.length,
  };
  const out = JSON.stringify(summary, null, 2);
  const outRef = "character-coverage.json";
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");

  return {
    ok: true,
    outputs: { coveragePercent: summary.coveragePercent, missingTotal: missing.length, target: targetName },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
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
