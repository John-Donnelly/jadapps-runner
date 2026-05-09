/**
 * pdf-table-to-json: extracts tabular data from a PDF using pdfjs text
 * positions. Detects rows by clustering items with similar y-coordinates;
 * detects columns from horizontal gaps in the first detected row.
 *
 * Output: an array of tables (one per page), each as a 2D array of cell
 * strings. Best-effort — works well on born-digital tables; struggles on
 * scanned PDFs (those need OCR).
 */

import { readFile, writeFile } from "node:fs/promises";
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

export default async function pdfTableToJson(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-table-to-json requires one PDF input");

  const cfg = ctx.inputs ?? {};
  const minColumns = Math.max(2, Math.floor(Number(cfg.minColumns ?? 2)));

  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try { pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); }
  catch (err) { return errorResult("driver_missing", `pdfjs-dist not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const data = new Uint8Array(buf);
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false }).promise;
  ctx.emitProgress(totalIn);

  const tables: { page: number; rows: string[][] }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items = (content.items as TextItem[]).filter((it) => typeof it.str === "string" && it.str.trim() !== "");
    const detected = detectTable(items, minColumns);
    if (detected.length > 0) tables.push({ page: i, rows: detected });
  }
  await doc.destroy();

  const out = JSON.stringify({ pageCount: doc.numPages, tableCount: tables.length, tables }, null, 2);
  const outRef = "tables.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { tableCount: tables.length, totalRows: tables.reduce((s, t) => s + t.rows.length, 0) },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

interface PositionedItem { text: string; x: number; y: number; w: number; }

function detectTable(items: TextItem[], minColumns: number): string[][] {
  const positioned: PositionedItem[] = items.map((it) => ({
    text: it.str,
    x: it.transform?.[4] ?? 0,
    y: it.transform?.[5] ?? 0,
    w: it.width ?? 0,
  }));

  const rows = clusterRows(positioned);
  if (rows.length < 2) return [];

  // Find the row with the most items — likely the widest table row, use its
  // x-positions as column anchors.
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
  const tolerance = 3;
  for (const item of sorted) {
    const last = rows[rows.length - 1];
    if (last && last.length > 0 && Math.abs((last[0]?.y ?? 0) - item.y) <= tolerance) last.push(item);
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
