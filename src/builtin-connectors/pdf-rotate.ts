/**
 * pdf-rotate: rotates pages by a multiple of 90°. `pages` selects which
 * pages to rotate ("all" or "1,3-5"); `angle` is one of 90, 180, 270.
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

export default async function pdfRotate(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-rotate requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const angle = Math.floor(Number(cfg.angle ?? 90));
  if (![90, 180, 270, -90, -180, -270].includes(angle)) {
    return errorResult("invalid_config", `angle must be one of 90, 180, 270 (got ${angle})`);
  }
  const pagesSpec = String(cfg.pages ?? "all").trim();

  let pdfLib: typeof import("pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const src = await pdfLib.PDFDocument.load(buf, { ignoreEncryption: true });
  ctx.emitProgress(totalIn);

  const pageCount = src.getPageCount();
  const targets = pagesSpec.toLowerCase() === "all"
    ? Array.from({ length: pageCount }, (_, i) => i + 1)
    : parsePageList(pagesSpec, pageCount);

  for (const p of targets) {
    const page = src.getPage(p - 1);
    const current = page.getRotation().angle;
    page.setRotation(pdfLib.degrees(((current + angle) % 360 + 360) % 360));
  }

  const bytes = await src.save();
  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-rotated.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, bytes);

  return {
    ok: true,
    outputs: { rotatedCount: targets.length, angle },
    fileRefs: [{ ref: outRef, bytes: bytes.length, sha256: "", mime: "application/pdf", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function parsePageList(spec: string, total: number): number[] {
  const out: number[] = [];
  for (const piece of spec.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const dashMatch = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
    if (dashMatch) {
      const a = Math.max(1, Math.min(total, Number(dashMatch[1])));
      const b = Math.max(1, Math.min(total, Number(dashMatch[2])));
      const lo = Math.min(a, b), hi = Math.max(a, b);
      for (let p = lo; p <= hi; p++) out.push(p);
      continue;
    }
    const single = Number(trimmed);
    if (Number.isInteger(single) && single >= 1 && single <= total) out.push(single);
  }
  return out;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
