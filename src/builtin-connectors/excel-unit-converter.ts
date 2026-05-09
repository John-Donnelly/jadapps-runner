/**
 * excel-unit-converter: converts numeric cells between common unit pairs.
 * Defaults: imperial→metric (in→cm, ft→m, mi→km, lb→kg, oz→g, °F→°C). Pass a
 * custom `pairs` array (e.g. [{from:"in", to:"cm"}, ...]) to scope conversions.
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

const FACTORS: Record<string, Record<string, (n: number) => number>> = {
  in: { cm: (n) => n * 2.54, mm: (n) => n * 25.4, m: (n) => n * 0.0254 },
  ft: { m: (n) => n * 0.3048, cm: (n) => n * 30.48, in: (n) => n * 12 },
  mi: { km: (n) => n * 1.609344, m: (n) => n * 1609.344 },
  yd: { m: (n) => n * 0.9144 },
  lb: { kg: (n) => n * 0.45359237, g: (n) => n * 453.59237 },
  oz: { g: (n) => n * 28.349523125 },
  gal: { l: (n) => n * 3.785411784 },
  "°F": { "°C": (n) => (n - 32) * 5 / 9 },
  cm: { in: (n) => n / 2.54 },
  m: { ft: (n) => n / 0.3048 },
  km: { mi: (n) => n / 1.609344 },
  kg: { lb: (n) => n / 0.45359237 },
  g: { oz: (n) => n / 28.349523125 },
  "°C": { "°F": (n) => n * 9 / 5 + 32 },
};

export default async function excelUnitConverter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-unit-converter requires one .xlsx input");

  const cfg = ctx.inputs ?? {};
  const customPairs = Array.isArray(cfg.pairs) ? cfg.pairs as { from: string; to: string }[] : null;

  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inPath);
  ctx.emitProgress(totalIn);

  const valueRe = /^(-?\d+(?:\.\d+)?)\s*(in|ft|mi|yd|lb|oz|gal|cm|m|km|kg|g|°F|°C)$/i;
  let converted = 0;
  for (const sheet of wb.worksheets) {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const raw = cell.value;
        if (typeof raw !== "string") return;
        const m = valueRe.exec(raw.trim());
        if (!m) return;
        const value = Number(m[1]);
        const fromUnit = m[2]!;
        const fn = pickConversion(fromUnit, customPairs);
        if (!fn) return;
        cell.value = `${roundTo(fn.fn(value), 4)} ${fn.to}`;
        converted += 1;
      });
    });
  }

  const outRef = `converted-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await wb.xlsx.writeFile(outPath);
  const outBytes = sizeOrFallback(outPath, 0);

  return {
    ok: true,
    outputs: { convertedCount: converted },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: ref.filename ?? "converted.xlsx" }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function pickConversion(fromUnit: string, pairs: { from: string; to: string }[] | null): { fn: (n: number) => number; to: string } | null {
  const table = FACTORS[fromUnit];
  if (!table) return null;
  if (pairs) {
    const match = pairs.find((p) => p.from.toLowerCase() === fromUnit.toLowerCase() && table[p.to]);
    if (match) return { fn: table[match.to]!, to: match.to };
    return null;
  }
  const targets = Object.keys(table);
  const target = targets[0];
  if (!target) return null;
  return { fn: table[target]!, to: target };
}

function roundTo(n: number, places: number): number {
  const factor = Math.pow(10, places);
  return Math.round(n * factor) / factor;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
