/**
 * pdf-password-protect: encrypts a PDF with user/owner passwords using
 * qpdf. The user password is required to open; the owner password is for
 * permission changes. Both default to the same string when only `password`
 * is supplied. Encryption strength: 256-bit AES (R6).
 *
 * Requires the `qpdf` binary on PATH. The runner returns driver_missing
 * if it's not present so callers can prompt the user to install it.
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

export default async function pdfPasswordProtect(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-password-protect requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const userPassword = String(cfg.userPassword ?? cfg.password ?? "");
  const ownerPassword = String(cfg.ownerPassword ?? cfg.password ?? userPassword);
  if (!userPassword) return errorResult("invalid_config", "userPassword (or password) is required");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-protected.pdf`;
  const outPath = join(ctx.scratchDir, outRef);

  try {
    await execFileAsync("qpdf", ["--encrypt", userPassword, ownerPassword, "256", "--", inPath, outPath]);
  } catch (err) {
    const message = (err as { code?: string; message: string }).message ?? String(err);
    if ((err as { code?: string }).code === "ENOENT") {
      return errorResult("driver_missing", "qpdf binary not found on PATH; install qpdf to enable PDF encryption");
    }
    return errorResult("qpdf_error", `qpdf failed: ${message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);

  return {
    ok: true,
    outputs: { encryptionBits: 256, hasOwnerPassword: ownerPassword !== userPassword },
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
