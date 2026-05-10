/**
 * emoji-remover: scans an input text and strips emoji characters
 * (Misc Symbols/Pictographs, ZWJ sequences, regional indicators).
 * Pure-text utility — no font parsing involved.
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

export default async function emojiRemover(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "emoji-remover requires one text input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const emojiRegex = /(\p{Extended_Pictographic}(\u{200D}\p{Extended_Pictographic})*)|\p{Regional_Indicator}{2}|[\u{FE0F}\u{FE0E}\u{20E3}]/gu;
  let removedCount = 0;
  const cleaned = text.replace(emojiRegex, () => {
    removedCount += 1;
    return "";
  });

  const outRef = (ref.filename ?? ref.ref).replace(/(\.[^.]+)?$/, ".no-emoji$1");
  await writeFile(join(ctx.scratchDir, outRef), cleaned, "utf8");

  return {
    ok: true,
    outputs: { removedCount, originalChars: text.length, cleanedChars: cleaned.length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(cleaned, "utf8"), sha256: "", mime: "text/plain", filename: outRef }],
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
