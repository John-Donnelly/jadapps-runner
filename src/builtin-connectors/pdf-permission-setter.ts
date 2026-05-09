/**
 * pdf-permission-setter: applies AES-256 encryption with fine-grained
 * permission flags via qpdf. Permissions: print, modify, copy, annotate,
 * form-fill, accessibility, assemble, print-low-res. Each flag defaults
 * to false (deny) unless explicitly enabled.
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

export default async function pdfPermissionSetter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-permission-setter requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const userPassword = String(cfg.userPassword ?? "");
  const ownerPassword = String(cfg.ownerPassword ?? "");
  if (!ownerPassword) return errorResult("invalid_config", "ownerPassword is required to set permissions");

  const allow = {
    print: cfg.allowPrint === true ? "full" : (cfg.allowPrint === "low" ? "low" : "none"),
    modify: cfg.allowModify === true ? "all" : "none",
    copy: cfg.allowCopy === true ? "y" : "n",
    annotate: cfg.allowAnnotate === true ? "y" : "n",
    formFill: cfg.allowFormFill === true ? "y" : "n",
    accessibility: cfg.allowAccessibility !== false ? "y" : "n",
    assemble: cfg.allowAssemble === true ? "y" : "n",
  };

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-locked.pdf`;
  const outPath = join(ctx.scratchDir, outRef);

  const args = ["--encrypt", userPassword, ownerPassword, "256",
    `--print=${allow.print}`,
    `--modify=${allow.modify}`,
    `--extract=${allow.copy}`,
    `--annotate=${allow.annotate}`,
    `--form=${allow.formFill}`,
    `--accessibility=${allow.accessibility}`,
    `--assemble=${allow.assemble}`,
    "--", inPath, outPath];

  try {
    await execFileAsync("qpdf", args);
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
    outputs: { permissions: allow },
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
