/**
 * excel-dependency-map: emits a directed dependency graph of formula cells.
 * Output JSON: { nodes: ["Sheet1!A1", ...], edges: [["Sheet1!A1","Sheet1!B2"]] }
 * where each edge points from a cell to a cell its formula references.
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

export default async function excelDependencyMap(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-dependency-map requires one .xlsx input");

  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inPath);
  ctx.emitProgress(totalIn);

  const cellRefRe = /(?:'([^']+)'!|([A-Za-z_][A-Za-z0-9_]*)!)?\$?([A-Z]+)\$?(\d+)/g;
  const nodeSet = new Set<string>();
  const edges: [string, string][] = [];
  for (const sheet of wb.worksheets) {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.value as { formula?: string } | null | undefined;
        if (!value || typeof value !== "object" || !value.formula) return;
        const fromKey = `${sheet.name}!${cell.address}`;
        nodeSet.add(fromKey);
        for (const m of value.formula.matchAll(cellRefRe)) {
          const targetSheet = m[1] ?? m[2] ?? sheet.name;
          const target = `${targetSheet}!${m[3]}${m[4]}`;
          if (target === fromKey) continue;
          nodeSet.add(target);
          edges.push([fromKey, target]);
        }
      });
    });
  }

  const out = JSON.stringify({ nodeCount: nodeSet.size, edgeCount: edges.length, nodes: [...nodeSet], edges }, null, 2);
  const outRef = "dep-map.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { nodeCount: nodeSet.size, edgeCount: edges.length },
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
