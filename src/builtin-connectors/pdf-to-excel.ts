/**
 * pdf-to-excel: extracts tables from a PDF (via pdfjs text positions) and
 * writes them to a fresh .xlsx, one sheet per detected table. Reuses the
 * detection logic from pdf-table-to-json.
 */

import { readFile } from "node:fs/promises";
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

interface TextItem { str: string; transform?: number[]; width?: number; }
interface PositionedItem { text: string; x: number; y: number; w: number; }

export default async function pdfToExcel(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-to-excel requires one PDF input");

  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  let ExcelJS: typeof import("exceljs");
  try { pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); }
  catch (err) { return errorResult("driver_missing", `pdfjs-dist not installed: ${(err as Error).message}`); }
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false }).promise;
  ctx.emitProgress(totalIn);

  const wb = new ExcelJS.Workbook();
  let totalRows = 0;
  let tableCount = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items = (content.items as TextItem[]).filter((it) => typeof it.str === "string" && it.str.trim() !== "");
    const detected = detectTable(items, 2);
    if (detected.length === 0) continue;
    const ws = wb.addWorksheet(`Page ${i}`);
    for (const row of detected) ws.addRow(row);
    totalRows += detected.length;
    tableCount += 1;
  }
  await doc.destroy();

  if (tableCount === 0) {
    return errorResult("no_tables", "no tables detected (PDF may be scanned — try OCR first)");
  }

  const baseName = (ref.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}.xlsx`;
  const outPath = join(ctx.scratchDir, outRef);
  await wb.xlsx.writeFile(outPath);
  const outBytes = sizeOrFallback(outPath, 0);

  return {
    ok: true,
    outputs: { tableCount, totalRows, pageCount: doc.numPages },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function detectTable(items: TextItem[], minColumns: number): string[][] {
  const positioned: PositionedItem[] = items.map((it) => ({
    text: it.str, x: it.transform?.[4] ?? 0, y: it.transform?.[5] ?? 0, w: it.width ?? 0,
  }));
  const rows = clusterRows(positioned);
  if (rows.length < 2) return [];
  const widest = rows.reduce((best, r) => r.length > best.length ? r : best, rows[0] ?? []);
  if (widest.length < minColumns) return [];
  const anchors = widest.map((it) => it.x).sort((a, b) => a - b);
  const cellsPerRow: string[][] = [];
  for (const row of rows) {
    if (row.length < 2) continue;
    const cells: string[] = new Array(anchors.length).fill("");
    for (const item of row) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < anchors.length; i++) {
        const d = Math.abs(item.x - anchors[i]!);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      cells[bestIdx] = (cells[bestIdx] ?? "").length === 0 ? item.text : cells[bestIdx] + " " + item.text;
    }
    if (cells.filter((c) => c.length > 0).length >= minColumns) cellsPerRow.push(cells);
  }
  return cellsPerRow;
}

function clusterRows(items: PositionedItem[]): PositionedItem[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: PositionedItem[][] = [];
  for (const item of sorted) {
    const last = rows[rows.length - 1];
    if (last && last.length > 0 && Math.abs((last[0]?.y ?? 0) - item.y) <= 3) last.push(item);
    else rows.push([item]);
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x);
  return rows;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
