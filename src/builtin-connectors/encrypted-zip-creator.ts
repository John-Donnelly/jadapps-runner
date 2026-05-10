/**
 * encrypted-zip-creator: produces a password-protected ZIP. Pure-JS ZIP
 * libraries (JSZip) cannot write PKWARE/AES-encrypted entries, so this
 * reports driver_missing when the native 7z binary isn't available.
 */

import { readFile } from "node:fs/promises";
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

export default async function encryptedZipCreator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "encrypted-zip-creator requires at least one input");
  }
  const cfg = ctx.inputs ?? {};
  if (typeof cfg.password !== "string" || cfg.password.length === 0) {
    return errorResult("invalid_input", "encrypted-zip-creator requires a `password` input");
  }

  let totalIn = 0;
  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    await readFile(path);
  }
  ctx.emitProgress(totalIn);
  void start;

  return errorResult(
    "driver_missing",
    "encrypted ZIP creation requires a native driver (e.g. 7z binary). JSZip and other pure-JS libraries cannot write PKWARE or AES-encrypted entries.",
  );
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
