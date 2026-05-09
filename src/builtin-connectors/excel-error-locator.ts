/**
 * excel-error-locator: lists every cell whose evaluated value is an Excel
 * error (#REF!, #DIV/0!, #VALUE!, #NAME?, #N/A, #NUM!, #NULL!, #SPILL!,
 * #CALC!). Reports sheet, address, formula, and the error code.
 */

import { writeFile } from "node:fs/promises";
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

interface ErrorHit { sheet: string; address: string; formula?: string | undefined; error: string; }

const ERROR_VALUES = new Set(["#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!", "#NULL!", "#SPILL!", "#CALC!"]);

export default async function excelErrorLocator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-error-locator requires one .xlsx input");

  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inPath);
  ctx.emitProgress(totalIn);

  const hits: ErrorHit[] = [];
  for (const sheet of wb.worksheets) {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const cellValue = cell.value as { error?: string; formula?: string; result?: unknown } | string | null | undefined;
        if (cellValue == null) return;
        if (typeof cellValue === "string" && ERROR_VALUES.has(cellValue)) {
          hits.push({ sheet: sheet.name, address: cell.address, error: cellValue });
          return;
        }
        if (typeof cellValue === "object") {
          if (typeof cellValue.error === "string") {
            hits.push({ sheet: sheet.name, address: cell.address, formula: cellValue.formula, error: cellValue.error });
            return;
          }
          const result = cellValue.result;
          if (typeof result === "string" && ERROR_VALUES.has(result)) {
            hits.push({ sheet: sheet.name, address: cell.address, formula: cellValue.formula, error: result });
          }
        }
      });
    });
  }

  const breakdown: Record<string, number> = {};
  for (const h of hits) breakdown[h.error] = (breakdown[h.error] ?? 0) + 1;

  const out = JSON.stringify({ errorCount: hits.length, breakdown, errors: hits }, null, 2);
  const outRef = "errors.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { errorCount: hits.length, breakdown },
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
