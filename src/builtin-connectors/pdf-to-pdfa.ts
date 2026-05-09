/**
 * pdf-to-pdfa: converts a PDF to PDF/A by shelling out to Ghostscript with
 * the appropriate output preset. PDF/A is a strict, archival-grade subset
 * of PDF — it requires fully-embedded fonts, an ICC color profile, and
 * forbids encryption/JS/external content. Without Ghostscript this can't
 * be done correctly; the tool returns driver_missing.
 *
 * Compliance level: 1b by default (visual reproduction guarantee). Set
 * `level: "2b"` or `"3b"` to opt into newer profiles.
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

export default async function pdfToPdfa(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-to-pdfa requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const level = ["1b", "2b", "3b"].includes(cfg.level as string) ? cfg.level as string : "1b";

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-pdfa-${level}.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  const compatibilityLevel = level === "1b" ? "1.4" : level === "2b" ? "1.7" : "1.7";

  const args = [
    "-dPDFA=" + level[0],
    "-dBATCH",
    "-dNOPAUSE",
    "-dQUIET",
    "-sProcessColorModel=DeviceRGB",
    "-sDEVICE=pdfwrite",
    "-dPDFACompatibilityPolicy=1",
    `-dCompatibilityLevel=${compatibilityLevel}`,
    `-sOutputFile=${outPath}`,
    inPath,
  ];

  try {
    await execFileAsync("gs", args);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      // Try the Windows-style "gswin64c" name.
      try {
        await execFileAsync("gswin64c", args);
      } catch (err2) {
        if ((err2 as { code?: string }).code === "ENOENT") {
          return errorResult("driver_missing", "Ghostscript (gs / gswin64c) not found on PATH; install Ghostscript to enable PDF/A conversion");
        }
        return errorResult("ghostscript_error", `gs failed: ${(err2 as { message: string }).message}`);
      }
    } else {
      return errorResult("ghostscript_error", `gs failed: ${(err as { message: string }).message}`);
    }
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);

  return {
    ok: true,
    outputs: { complianceLevel: `PDF/A-${level}`, originalBytes: totalIn, outputBytes: outBytes },
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
