/**
 * excel-formula-explainer: tokenises each formula and emits a plain-English
 * description per cell. Recognises common functions (SUM, AVERAGE, IF,
 * VLOOKUP, INDEX/MATCH, COUNTIF, SUMIF, ROUND, CONCATENATE, LEN, LEFT,
 * RIGHT, MID, UPPER, LOWER) and operators. Fallback: pretty-prints the
 * tokenised AST.
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

interface Explanation { sheet: string; address: string; formula: string; explanation: string; }

export default async function excelFormulaExplainer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-formula-explainer requires one .xlsx input");

  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inPath);
  ctx.emitProgress(totalIn);

  const explanations: Explanation[] = [];
  for (const sheet of wb.worksheets) {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.value as { formula?: string } | null | undefined;
        if (value && typeof value === "object" && value.formula) {
          explanations.push({ sheet: sheet.name, address: cell.address, formula: value.formula, explanation: explain(value.formula) });
        }
      });
    });
  }

  const out = JSON.stringify({ formulaCount: explanations.length, explanations }, null, 2);
  const outRef = "explanations.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { formulaCount: explanations.length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function explain(formula: string): string {
  const f = formula.trim().replace(/^=/, "");
  const fn = /^([A-Z][A-Z0-9.]+)\s*\(/.exec(f);
  if (!fn || !fn[1]) return `Formula: ${f}`;
  const name = fn[1].toUpperCase();
  const argsStr = f.slice((fn[0] ?? "").length, f.lastIndexOf(")"));
  const args = splitArgs(argsStr);
  switch (name) {
    case "SUM": return `Sums the values in ${args.join(" plus ")}`;
    case "AVERAGE": return `Averages the values in ${args.join(", ")}`;
    case "MIN": return `Returns the smallest value in ${args.join(", ")}`;
    case "MAX": return `Returns the largest value in ${args.join(", ")}`;
    case "COUNT": return `Counts the numeric cells in ${args.join(", ")}`;
    case "COUNTA": return `Counts the non-blank cells in ${args.join(", ")}`;
    case "IF": return `If ${args[0]} then ${args[1]}, otherwise ${args[2] ?? "blank"}`;
    case "VLOOKUP": return `Looks up ${args[0]} in the first column of ${args[1]} and returns column ${args[2]}${args[3] === "FALSE" ? " (exact match)" : " (approximate match)"}`;
    case "HLOOKUP": return `Horizontal lookup of ${args[0]} in ${args[1]}, returning row ${args[2]}`;
    case "INDEX": return `Returns the value at row ${args[1] ?? "?"} of ${args[0]}${args[2] ? `, column ${args[2]}` : ""}`;
    case "MATCH": return `Finds the position of ${args[0]} within ${args[1]}`;
    case "COUNTIF": return `Counts cells in ${args[0]} that match ${args[1]}`;
    case "SUMIF": return `Sums cells in ${args[0]} where ${args[0]} matches ${args[1]}${args[2] ? `, summing ${args[2]}` : ""}`;
    case "ROUND": return `Rounds ${args[0]} to ${args[1]} decimal places`;
    case "ROUNDUP": return `Rounds ${args[0]} up to ${args[1]} decimal places`;
    case "ROUNDDOWN": return `Rounds ${args[0]} down to ${args[1]} decimal places`;
    case "CONCATENATE": case "CONCAT": return `Concatenates ${args.join(", ")}`;
    case "LEN": return `Returns the character length of ${args[0]}`;
    case "LEFT": return `Returns the left ${args[1] ?? 1} character(s) of ${args[0]}`;
    case "RIGHT": return `Returns the right ${args[1] ?? 1} character(s) of ${args[0]}`;
    case "MID": return `Returns ${args[2]} character(s) of ${args[0]} starting at position ${args[1]}`;
    case "UPPER": return `Returns ${args[0]} in uppercase`;
    case "LOWER": return `Returns ${args[0]} in lowercase`;
    case "TRIM": return `Removes leading and trailing whitespace from ${args[0]}`;
    case "AND": return `True only if every condition is true: ${args.join(", ")}`;
    case "OR": return `True if any condition is true: ${args.join(", ")}`;
    case "NOT": return `Inverts the truth of ${args[0]}`;
    case "IFERROR": return `${args[0]}, but returns ${args[1]} on error`;
    case "TODAY": return "Returns today's date";
    case "NOW": return "Returns the current date and time";
    default: return `Calls ${name} with ${args.length} argument(s): ${args.join(", ")}`;
  }
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0, i = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "{") depth++;
    else if (c === ")" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start).trim());
  return out;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
