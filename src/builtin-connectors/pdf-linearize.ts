/**
 * pdf-linearize: rewrites the PDF in linearized ("Fast Web View") form so
 * the first page can be displayed before the rest of the file finishes
 * downloading. Uses qpdf --linearize.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StepResult, FileRef } from "../types.js";

const execFileAsync = promisify(execFile);

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function pdfLinearize(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-linearize requires one PDF input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-linearized.pdf`;
  const outPath = join(ctx.scratchDir, outRef);

  try {
    await execFileAsync("qpdf", ["--linearize", "--", inPath, outPath]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return errorResult("driver_missing", "qpdf binary not found on PATH");
    }
    return errorResult("qpdf_error", `qpdf failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);

  return {
    ok: true,
    outputs: { originalBytes: totalIn, linearizedBytes: outBytes },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "application/pdf", filename: outRef }],
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
