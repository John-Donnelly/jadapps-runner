/**
 * excel-app-metadata-wiper: clears workbook-level metadata fields (creator,
 * lastModifiedBy, company, manager, keywords, description, category,
 * subject, title) and resets the created/modified timestamps to epoch.
 */

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

export default async function excelAppMetadataWiper(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-app-metadata-wiper requires one .xlsx input");

  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inPath);
  ctx.emitProgress(totalIn);

  const before = {
    creator: wb.creator,
    lastModifiedBy: wb.lastModifiedBy,
    company: wb.company,
    manager: wb.manager,
    title: wb.title,
    subject: wb.subject,
    description: wb.description,
    keywords: wb.keywords,
    category: wb.category,
    created: wb.created,
    modified: wb.modified,
  };

  wb.creator = "";
  wb.lastModifiedBy = "";
  wb.company = "";
  wb.manager = "";
  wb.title = "";
  wb.subject = "";
  wb.description = "";
  wb.keywords = "";
  wb.category = "";
  wb.created = new Date(0);
  wb.modified = new Date(0);

  const outRef = `wiped-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await wb.xlsx.writeFile(outPath);
  const outBytes = sizeOrFallback(outPath, 0);

  const fieldsCleared = Object.entries(before).filter(([, v]) => v && (typeof v !== "object" || (v as Date).getTime?.() !== 0)).length;

  return {
    ok: true,
    outputs: { fieldsCleared, before },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: ref.filename ?? "wiped.xlsx" }],
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
