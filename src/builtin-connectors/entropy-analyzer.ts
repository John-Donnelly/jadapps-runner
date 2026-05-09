/**
 * entropy-analyzer: computes Shannon entropy of an input file's bytes.
 * Reports overall entropy (bits/byte), per-window entropy stats (8 KB
 * windows), and a verdict ("plain text", "compressed/encrypted likely",
 * "mixed").
 */

import { createReadStream, statSync } from "node:fs";
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

export default async function entropyAnalyzer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "entropy-analyzer requires one input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);

  const totalCounts = new Uint32Array(256);
  let totalBytes = 0;
  const windowEntropies: number[] = [];
  let windowCounts = new Uint32Array(256);
  let windowBytes = 0;
  const WINDOW = 8192;

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(inPath);
    stream.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i]!;
        totalCounts[b]! += 1;
        windowCounts[b]! += 1;
        totalBytes += 1;
        windowBytes += 1;
        if (windowBytes === WINDOW) {
          windowEntropies.push(entropy(windowCounts, windowBytes));
          windowCounts = new Uint32Array(256);
          windowBytes = 0;
        }
      }
      ctx.emitProgress(totalBytes);
    });
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  if (windowBytes > 0) windowEntropies.push(entropy(windowCounts, windowBytes));

  const overall = entropy(totalCounts, totalBytes);
  const min = windowEntropies.length > 0 ? Math.min(...windowEntropies) : overall;
  const max = windowEntropies.length > 0 ? Math.max(...windowEntropies) : overall;
  const verdict = overall > 7.5 ? "compressed/encrypted likely" : overall > 5.5 ? "mixed" : "plain text";

  const report = JSON.stringify({ totalBytes, overallEntropyBitsPerByte: overall, minWindowEntropy: min, maxWindowEntropy: max, verdict, windowCount: windowEntropies.length }, null, 2);
  const outRef = "entropy.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, report, "utf8");

  return {
    ok: true,
    outputs: { overall, min, max, verdict, totalBytes },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(report, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function entropy(counts: Uint32Array, total: number): number {
  if (total === 0) return 0;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    const c = counts[i]!;
    if (c === 0) continue;
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return h;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
