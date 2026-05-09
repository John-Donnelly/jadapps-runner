/**
 * md-table-repair: detects pipe-tables in the document and pads each row to a
 * consistent column count. Adds the alignment row if missing and the cell
 * contents look like a header.
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

export default async function mdTableRepair(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-table-repair requires one Markdown input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let i = 0;
  let tablesRepaired = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (/^```/.test(line.trim())) { inFence = !inFence; out.push(line); i++; continue; }
    if (inFence) { out.push(line); i++; continue; }

    if (isTableRow(line)) {
      const tableLines: string[] = [];
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        tableLines.push(lines[i] ?? "");
        i++;
      }
      const repaired = repairTable(tableLines);
      if (repaired.changed) tablesRepaired++;
      out.push(...repaired.rows);
      continue;
    }
    out.push(line);
    i++;
  }

  const transformed = out.join("\n");
  const outRef = `repaired-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, transformed, "utf8");

  return {
    ok: true,
    outputs: { tablesRepaired },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(transformed, "utf8"), sha256: "", mime: "text/markdown", filename: ref.filename ?? "repaired.md" }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function isTableRow(line: string): boolean {
  return line.includes("|") && !/^\s*[-*+]\s/.test(line);
}

function isAlignmentRow(line: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line);
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((s) => s.trim());
}

function repairTable(rows: string[]): { rows: string[]; changed: boolean } {
  if (rows.length === 0) return { rows, changed: false };
  let changed = false;
  const parsed = rows.map(splitRow);
  const maxCols = Math.max(...parsed.map((r) => r.length));

  let alignmentIdx = parsed.findIndex((_, idx) => idx > 0 && isAlignmentRow(rows[idx] ?? ""));
  if (alignmentIdx === -1) {
    parsed.splice(1, 0, new Array(maxCols).fill("---"));
    rows.splice(1, 0, "");
    alignmentIdx = 1;
    changed = true;
  }

  const padded = parsed.map((cells, idx) => {
    if (cells.length < maxCols) {
      changed = true;
      const filler = idx === alignmentIdx ? "---" : "";
      return [...cells, ...new Array(maxCols - cells.length).fill(filler)];
    }
    return cells.slice(0, maxCols);
  });

  return { rows: padded.map((cells) => "| " + cells.join(" | ") + " |"), changed };
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
