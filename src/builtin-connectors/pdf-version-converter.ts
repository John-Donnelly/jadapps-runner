/**
 * pdf-version-converter: changes the PDF version stamped at the start of
 * the file (e.g. `%PDF-1.7`). Doesn't actually downgrade features that the
 * lower version doesn't support — that needs a full PDF rewriter (qpdf).
 * Useful for fixing tooling that gates on the version string.
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

const VALID_VERSIONS = ["1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "2.0"];

export default async function pdfVersionConverter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-version-converter requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const targetVersion = String(cfg.targetVersion ?? "1.7");
  if (!VALID_VERSIONS.includes(targetVersion)) {
    return errorResult("invalid_config", `targetVersion must be one of ${VALID_VERSIONS.join(", ")}`);
  }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const headerEnd = Math.min(buf.length, 64);
  const header = buf.subarray(0, headerEnd).toString("latin1");
  const versionMatch = /^%PDF-(\d\.\d)/.exec(header);
  if (!versionMatch || !versionMatch[1]) return errorResult("not_a_pdf", "input doesn't start with a %PDF-x.y header");
  const sourceVersion = versionMatch[1];

  const newHeader = `%PDF-${targetVersion}`;
  const oldHeader = `%PDF-${sourceVersion}`;
  const out = Buffer.concat([Buffer.from(newHeader, "latin1"), buf.subarray(oldHeader.length)]);

  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-v${targetVersion.replace(".", "_")}.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out);

  return {
    ok: true,
    outputs: { sourceVersion, targetVersion, note: targetVersion < sourceVersion ? "header-only downgrade; features above target may break" : "" },
    fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "application/pdf", filename: outRef }],
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
