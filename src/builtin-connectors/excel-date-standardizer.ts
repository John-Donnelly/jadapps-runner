/**
 * excel-date-standardizer: converts every cell that looks like a date to a
 * consistent ISO-8601 string (YYYY-MM-DD). Recognises Excel serial dates,
 * ISO strings, US-style MM/DD/YYYY, and EU-style DD/MM/YYYY. The locale hint
 * (cfg.locale = "us" | "eu") disambiguates ambiguous values.
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

export default async function excelDateStandardizer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-date-standardizer requires one .xlsx input");

  const cfg = ctx.inputs ?? {};
  const locale = cfg.locale === "eu" ? "eu" : "us";

  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inPath);
  ctx.emitProgress(totalIn);

  let normalized = 0;
  for (const sheet of wb.worksheets) {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const result = tryNormalizeDate(cell.value, locale);
        if (result != null) {
          cell.value = result as never;
          normalized += 1;
        }
      });
    });
  }

  const outRef = `dated-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await wb.xlsx.writeFile(outPath);
  const outBytes = sizeOrFallback(outPath, 0);

  return {
    ok: true,
    outputs: { normalizedCount: normalized, locale },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: ref.filename ?? "dated.xlsx" }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function tryNormalizeDate(value: unknown, locale: "us" | "eu"): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && value > 0 && value < 100000) {
    const ms = (value - 25569) * 86400 * 1000;
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
    const slashMatch = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2}|\d{4})$/.exec(trimmed);
    if (slashMatch) {
      const a = Number(slashMatch[1]), b = Number(slashMatch[2]);
      let y = Number(slashMatch[3]);
      if (y < 100) y += 2000;
      let month: number, day: number;
      if (locale === "us") { month = a; day = b; } else { day = a; month = b; }
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }
  }
  return null;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
