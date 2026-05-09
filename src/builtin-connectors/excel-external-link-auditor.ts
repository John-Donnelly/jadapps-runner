/**
 * excel-external-link-auditor: lists every formula reference that points at
 * another workbook (e.g. `[Source.xlsx]Sheet1!A1`) plus every hyperlink to
 * an external URL or local file.
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

interface Reference { sheet: string; address: string; kind: "formula-external" | "hyperlink"; target: string; }

export default async function excelExternalLinkAuditor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-external-link-auditor requires one .xlsx input");

  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inPath);
  ctx.emitProgress(totalIn);

  const refs: Reference[] = [];
  const externalFormulaRe = /(?:'?\[[^\]]+\][^']+'|\[\d+\][^\s!]+!|'[A-Za-z]:[^']+\[[^\]]+\][^']+'|file:\/\/[^\s)]+)/g;

  for (const sheet of wb.worksheets) {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.value as { formula?: string; hyperlink?: string } | null | undefined;
        if (value && typeof value === "object") {
          if (value.formula) {
            for (const m of value.formula.matchAll(externalFormulaRe)) {
              refs.push({ sheet: sheet.name, address: cell.address, kind: "formula-external", target: m[0] });
            }
          }
          if (value.hyperlink) {
            refs.push({ sheet: sheet.name, address: cell.address, kind: "hyperlink", target: String(value.hyperlink) });
          }
        }
      });
    });
  }

  const out = JSON.stringify({ totalReferences: refs.length, references: refs }, null, 2);
  const outRef = "external-links.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { totalReferences: refs.length, formulaExternalCount: refs.filter((r) => r.kind === "formula-external").length, hyperlinkCount: refs.filter((r) => r.kind === "hyperlink").length },
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
