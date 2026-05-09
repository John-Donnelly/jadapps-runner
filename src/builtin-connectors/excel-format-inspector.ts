/**
 * excel-format-inspector: reports a workbook's structural metadata. For each
 * sheet: name, row count, column count, defined-name range, hidden flag,
 * number of merged cells, formula count, comment count, external link
 * presence, hyperlink count.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function excelFormatInspector(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-format-inspector requires one .xlsx input");

  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inPath);
  ctx.emitProgress(totalIn);

  const sheets = wb.worksheets.map((sheet) => {
    let formulaCount = 0;
    let commentCount = 0;
    let hyperlinkCount = 0;
    let externalRefs = 0;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.value as { formula?: string; hyperlink?: string } | null | undefined;
        if (value && typeof value === "object" && value.formula) {
          formulaCount += 1;
          if (/\[\d+\]/.test(value.formula) || /^'?\[/.test(value.formula)) externalRefs += 1;
        }
        if (cell.note) commentCount += 1;
        if (value && typeof value === "object" && value.hyperlink) hyperlinkCount += 1;
      });
    });
    return {
      name: sheet.name,
      hidden: sheet.state === "hidden" || sheet.state === "veryHidden",
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      mergedCount: Object.keys((sheet.model as { merges?: unknown }).merges ?? {}).length,
      formulaCount,
      commentCount,
      hyperlinkCount,
      externalRefs,
    };
  });

  const summary = {
    fileBytes: totalIn,
    sheetCount: sheets.length,
    creator: wb.creator,
    lastModifiedBy: wb.lastModifiedBy,
    created: wb.created,
    modified: wb.modified,
    company: wb.company,
    sheets,
  };

  const out = JSON.stringify(summary, null, 2);
  const outRef = "format-report.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: summary as unknown as Record<string, unknown>,
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
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
