/**
 * excel-i18n-gen: generates per-language JSON files from a translation sheet.
 * Schema: column 1 is the message key; subsequent columns are language codes
 * (e.g. en, fr, de). Output: one JSON file per language, plus a manifest
 * listing the files.
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

export default async function excelI18nGen(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-i18n-gen requires one .xlsx input");

  const cfg = ctx.inputs ?? {};
  const sheetSel = cfg.sheet ?? 1;
  const keyColumn = cfg.keyColumn ?? 1;

  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inPath);
  ctx.emitProgress(totalIn);

  const sheet = typeof sheetSel === "number" ? wb.worksheets[sheetSel - 1] : wb.getWorksheet(String(sheetSel));
  if (!sheet) return errorResult("sheet_not_found", `sheet ${JSON.stringify(sheetSel)} not found`);

  const matrix: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => matrix.push(Array.isArray(row.values) ? row.values.slice(1) : []));
  if (matrix.length < 2) return errorResult("empty_sheet", "need a header row and at least one translation row");

  const header = (matrix[0] ?? []).map((v) => String(v ?? ""));
  const keyIdx = resolveColumn(header, keyColumn);
  if (keyIdx < 0) return errorResult("invalid_config", "keyColumn not found");

  const langIdxs = header.map((_, i) => i).filter((i) => i !== keyIdx);
  const dictionaries: Record<string, Record<string, string>> = {};
  for (const i of langIdxs) dictionaries[header[i]!] = {};

  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r] ?? [];
    const key = String(row[keyIdx] ?? "").trim();
    if (!key) continue;
    for (const i of langIdxs) {
      const value = row[i];
      if (value == null || value === "") continue;
      dictionaries[header[i]!]![key] = String(value);
    }
  }

  const fileRefs: FileRef[] = [];
  const manifest: { lang: string; file: string; messageCount: number }[] = [];
  for (const [lang, dict] of Object.entries(dictionaries)) {
    const json = JSON.stringify(dict, null, 2);
    const outRef = `${lang}.json`;
    const outPath = join(ctx.scratchDir, outRef);
    await writeFile(outPath, json, "utf8");
    fileRefs.push({ ref: outRef, bytes: Buffer.byteLength(json, "utf8"), sha256: "", mime: "application/json", filename: outRef });
    manifest.push({ lang, file: outRef, messageCount: Object.keys(dict).length });
  }

  return {
    ok: true,
    outputs: { langCount: langIdxs.length, manifest },
    fileRefs,
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function resolveColumn(header: string[], col: unknown): number {
  if (typeof col === "number" && Number.isInteger(col) && col > 0 && col <= header.length) return col - 1;
  return header.indexOf(String(col));
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
