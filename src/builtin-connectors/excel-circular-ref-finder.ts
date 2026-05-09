/**
 * excel-circular-ref-finder: detects circular references in formulas. A
 * circular reference is one where the formula in cell X (transitively)
 * references X itself. Builds a dependency graph from formula cells and
 * runs Tarjan's SCC algorithm; any SCC of size > 1, or any self-loop, is
 * reported.
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

interface CycleHit { sheet: string; cells: string[]; }

export default async function excelCircularRefFinder(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-circular-ref-finder requires one .xlsx input");

  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inPath);
  ctx.emitProgress(totalIn);

  const cycles: CycleHit[] = [];
  const cellRefRe = /\$?([A-Z]+)\$?(\d+)/g;

  for (const sheet of wb.worksheets) {
    const adjacency = new Map<string, Set<string>>();
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.value as { formula?: string } | null | undefined;
        if (!value || typeof value !== "object" || !value.formula) return;
        const deps = new Set<string>();
        for (const m of value.formula.matchAll(cellRefRe)) deps.add(`${m[1]}${m[2]}`);
        if (deps.size > 0) adjacency.set(cell.address, deps);
      });
    });

    const sccs = tarjan(adjacency);
    for (const scc of sccs) {
      if (scc.length > 1) cycles.push({ sheet: sheet.name, cells: scc });
      else if (scc[0] && adjacency.get(scc[0])?.has(scc[0])) cycles.push({ sheet: sheet.name, cells: scc });
    }
  }

  const out = JSON.stringify({ cycleCount: cycles.length, cycles }, null, 2);
  const outRef = "circular-refs.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { cycleCount: cycles.length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function tarjan(adj: Map<string, Set<string>>): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const result: string[][] = [];

  function strongconnect(v: string) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    const neighbours = adj.get(v) ?? new Set();
    for (const w of neighbours) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }
    if (lowlinks.get(v) === indices.get(v)) {
      const component: string[] = [];
      while (true) {
        const w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      result.push(component);
    }
  }

  for (const v of adj.keys()) if (!indices.has(v)) strongconnect(v);
  return result;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
