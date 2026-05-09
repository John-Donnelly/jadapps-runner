/**
 * md-list-fixer: normalises bullet/ordered list markers and indentation.
 * Defaults: bullets → `-`, ordered → `1. 2. 3. …` re-numbered per group,
 * indentation → 2 spaces per nesting level.
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

export default async function mdListFixer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-list-fixer requires one Markdown input");

  const cfg = ctx.inputs ?? {};
  const bullet = ["-", "*", "+"].includes(cfg.bullet as string) ? cfg.bullet as string : "-";
  const renumberOrdered = cfg.renumberOrdered !== false;

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  const orderedCounters: Map<number, number> = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^```/.test(line.trim())) { inFence = !inFence; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }

    const bulletMatch = /^(\s*)([-*+])(\s+.*)$/.exec(line);
    if (bulletMatch) {
      const indent = bulletMatch[1] ?? "";
      orderedCounters.delete(indent.length);
      out.push(`${indent}${bullet}${bulletMatch[3] ?? ""}`);
      continue;
    }
    const orderedMatch = /^(\s*)(\d+)([.)])(\s+.*)$/.exec(line);
    if (orderedMatch) {
      const indent = orderedMatch[1] ?? "";
      const depth = indent.length;
      if (renumberOrdered) {
        const next = (orderedCounters.get(depth) ?? 0) + 1;
        orderedCounters.set(depth, next);
        out.push(`${indent}${next}.${orderedMatch[4] ?? ""}`);
      } else {
        out.push(`${indent}${orderedMatch[2] ?? ""}.${orderedMatch[4] ?? ""}`);
      }
      continue;
    }
    if (line.trim() === "") {
      out.push(line);
      continue;
    }
    if (!/^\s/.test(line)) orderedCounters.clear();
    out.push(line);
  }

  const transformed = out.join("\n");
  const outRef = `lists-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, transformed, "utf8");

  return {
    ok: true,
    outputs: { bullet, renumberOrdered },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(transformed, "utf8"), sha256: "", mime: "text/markdown", filename: ref.filename ?? "lists.md" }],
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
