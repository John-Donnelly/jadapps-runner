/**
 * pdf-remove-password: decrypts a password-protected PDF using qpdf and
 * writes a fresh, unprotected copy. The supplied password is the user OR
 * owner password (qpdf accepts either for read).
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

export default async function pdfRemovePassword(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-remove-password requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const password = String(cfg.password ?? "");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-unlocked.pdf`;
  const outPath = join(ctx.scratchDir, outRef);

  const args = ["--decrypt"];
  if (password) args.push(`--password=${password}`);
  args.push("--", inPath, outPath);

  try {
    await execFileAsync("qpdf", args);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if ((err as { code?: string }).code === "ENOENT") {
      return errorResult("driver_missing", "qpdf binary not found on PATH");
    }
    if (stderr.includes("invalid password")) {
      return errorResult("wrong_password", "supplied password did not unlock the PDF");
    }
    return errorResult("qpdf_error", `qpdf failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);

  return {
    ok: true,
    outputs: { decryptedBytes: outBytes },
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
