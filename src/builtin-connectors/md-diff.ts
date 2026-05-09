/**
 * md-diff: line-level diff between two Markdown files. Output is a unified
 * diff (context=3) emitted as text. Treats Markdown as plain text — semantic
 * AST diffing is out of scope for v0.1.
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

export default async function mdDiff(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length < 2) {
    return errorResult("missing_input", "md-diff requires two Markdown inputs");
  }
  const a = ctx.fileRefs[0]!;
  const b = ctx.fileRefs[1]!;
  const aPath = join(ctx.scratchDir, a.ref);
  const bPath = join(ctx.scratchDir, b.ref);
  const totalIn = sizeOrFallback(aPath, a.bytes) + sizeOrFallback(bPath, b.bytes);

  const [aText, bText] = await Promise.all([readFile(aPath, "utf8"), readFile(bPath, "utf8")]);
  ctx.emitProgress(totalIn);

  const aLines = aText.split("\n");
  const bLines = bText.split("\n");
  const ops = computeDiff(aLines, bLines);
  const unified = formatUnified(a.filename ?? "a.md", b.filename ?? "b.md", aLines, bLines, ops, 3);

  const outRef = "diff.patch";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, unified, "utf8");

  let added = 0, removed = 0;
  for (const op of ops) { if (op.kind === "add") added += 1; if (op.kind === "remove") removed += 1; }

  return {
    ok: true,
    outputs: { addedLines: added, removedLines: removed },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(unified, "utf8"), sha256: "", mime: "text/x-diff", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

interface Op { kind: "equal" | "add" | "remove"; aIdx: number; bIdx: number; }

function computeDiff(a: string[], b: string[]): Op[] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      else dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  const ops: Op[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { ops.unshift({ kind: "equal", aIdx: i - 1, bIdx: j - 1 }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) { ops.unshift({ kind: "add", aIdx: i, bIdx: j - 1 }); j--; }
    else { ops.unshift({ kind: "remove", aIdx: i - 1, bIdx: j }); i--; }
  }
  return ops;
}

function formatUnified(aName: string, bName: string, aLines: string[], bLines: string[], ops: Op[], context: number): string {
  const out: string[] = [`--- ${aName}`, `+++ ${bName}`];
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i]!.kind === "equal") i++;
    if (i >= ops.length) break;
    const hunkStart = Math.max(0, i - context);
    let j = i;
    while (j < ops.length && (ops[j]!.kind !== "equal" || (j + context < ops.length && ops.slice(j, j + context).some((o) => o.kind !== "equal")))) j++;
    const hunkEnd = Math.min(ops.length, j + context);
    const aStart = ops[hunkStart]!.aIdx + (ops[hunkStart]!.kind === "add" ? 0 : 0);
    const bStart = ops[hunkStart]!.bIdx;
    let aLen = 0, bLen = 0;
    const body: string[] = [];
    for (let k = hunkStart; k < hunkEnd; k++) {
      const op = ops[k]!;
      if (op.kind === "equal") { body.push(" " + (aLines[op.aIdx] ?? "")); aLen++; bLen++; }
      else if (op.kind === "remove") { body.push("-" + (aLines[op.aIdx] ?? "")); aLen++; }
      else { body.push("+" + (bLines[op.bIdx] ?? "")); bLen++; }
    }
    out.push(`@@ -${aStart + 1},${aLen} +${bStart + 1},${bLen} @@`);
    out.push(...body);
    i = hunkEnd;
  }
  return out.join("\n") + "\n";
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
