/**
 * excel-tailwind-export: renders the first sheet as a styled HTML table
 * using Tailwind utility classes (CDN). Useful for embedding workbook data
 * into a static page or sharing a quick visual snapshot.
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

export default async function excelTailwindExport(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-tailwind-export requires one .xlsx input");

  const cfg = ctx.inputs ?? {};
  const sheetSel = cfg.sheet ?? 1;
  const title = String(cfg.title ?? (ref.filename ?? "Sheet").replace(/\.xlsx$/i, ""));

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
  if (matrix.length === 0) return errorResult("empty_sheet", "sheet has no rows");

  const header = (matrix[0] ?? []).map((v) => String(v ?? ""));
  const headRow = header.map((h) => `<th class="px-4 py-2 text-left font-semibold border-b border-slate-200 bg-slate-50">${escapeHtml(h)}</th>`).join("");
  const bodyRows = matrix.slice(1).map((row) => {
    const cells = header.map((_, i) => `<td class="px-4 py-2 border-b border-slate-100">${escapeHtml(String(row[i] ?? ""))}</td>`).join("");
    return `<tr class="hover:bg-slate-50">${cells}</tr>`;
  }).join("");

  const out = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-100 p-8">
<div class="max-w-7xl mx-auto bg-white rounded-lg shadow overflow-hidden">
<div class="px-6 py-4 border-b border-slate-200">
<h1 class="text-xl font-semibold text-slate-800">${escapeHtml(title)}</h1>
<p class="text-sm text-slate-500 mt-1">${matrix.length - 1} row${matrix.length - 1 === 1 ? "" : "s"} · ${header.length} column${header.length === 1 ? "" : "s"}</p>
</div>
<div class="overflow-x-auto">
<table class="w-full text-sm text-slate-700"><thead><tr>${headRow}</tr></thead><tbody>${bodyRows}</tbody></table>
</div>
</div>
</body>
</html>
`;

  const outRef = `${title}.html`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { rowCount: matrix.length - 1, columnCount: header.length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "text/html", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
