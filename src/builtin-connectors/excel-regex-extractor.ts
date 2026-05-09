/**
 * excel-regex-extractor: scans every cell on every sheet for matches of a
 * supplied regex pattern and emits a JSON report with cell address, sheet,
 * full match, and capture groups.
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

interface Match { sheet: string; address: string; match: string; groups: string[]; }

export default async function excelRegexExtractor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-regex-extractor requires one .xlsx input");

  const cfg = ctx.inputs ?? {};
  const pattern = String(cfg.pattern ?? "");
  const flags = typeof cfg.flags === "string" ? cfg.flags : "g";

  if (!pattern) return errorResult("invalid_config", "pattern is required");
  let re: RegExp;
  try { re = new RegExp(pattern, flags.includes("g") ? flags : flags + "g"); }
  catch (err) { return errorResult("invalid_config", `invalid regex: ${(err as Error).message}`); }

  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inPath);
  ctx.emitProgress(totalIn);

  const matches: Match[] = [];
  for (const sheet of wb.worksheets) {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = cellAsString(cell.value);
        if (!text) return;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          matches.push({ sheet: sheet.name, address: cell.address, match: m[0], groups: m.slice(1).map((g) => g ?? "") });
          if (m.index === re.lastIndex) re.lastIndex += 1;
        }
      });
    });
  }

  const out = JSON.stringify({ pattern, flags, matchCount: matches.length, matches }, null, 2);
  const outRef = "extract.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { matchCount: matches.length, pattern, flags },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function cellAsString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const obj = value as { result?: unknown; text?: string; richText?: { text: string }[]; formula?: string };
    if (obj.result !== undefined) return cellAsString(obj.result);
    if (obj.text) return obj.text;
    if (Array.isArray(obj.richText)) return obj.richText.map((r) => r.text).join("");
    if (obj.formula) return obj.formula;
  }
  return "";
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
