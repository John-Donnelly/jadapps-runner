/**
 * md-footnote-linker: collects free-floating `[^ref]: …` definitions and
 * (optionally) auto-numbers inline `[^]` markers in document order. Emits
 * GitHub-flavoured Markdown footnotes.
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

export default async function mdFootnoteLinker(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-footnote-linker requires one Markdown input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const lines = text.split("\n");
  const definitions: { id: string; body: string[] }[] = [];
  const bodyLines: string[] = [];
  let currentDef: { id: string; body: string[] } | null = null;
  let inFence = false;

  for (const line of lines) {
    if (/^```/.test(line.trim())) inFence = !inFence;
    if (!inFence) {
      const defMatch = /^\s*\[\^([^\]]+)\]:\s*(.*)$/.exec(line);
      if (defMatch) {
        if (currentDef) definitions.push(currentDef);
        currentDef = { id: defMatch[1] ?? "", body: [defMatch[2] ?? ""] };
        continue;
      }
      if (currentDef && /^ {2,}/.test(line)) {
        currentDef.body.push(line.trim());
        continue;
      }
    }
    if (currentDef) { definitions.push(currentDef); currentDef = null; }
    bodyLines.push(line);
  }
  if (currentDef) definitions.push(currentDef);

  let anonCounter = 0;
  const transformed = bodyLines.join("\n").replace(/\[\^\]/g, () => {
    anonCounter += 1;
    return `[^auto${anonCounter}]`;
  });

  let withDefs = transformed;
  if (definitions.length > 0 || anonCounter > 0) {
    withDefs = withDefs.replace(/\n+$/, "") + "\n\n";
    for (const def of definitions) {
      withDefs += `[^${def.id}]: ${def.body.join("\n  ")}\n`;
    }
    for (let i = 1; i <= anonCounter; i++) {
      withDefs += `[^auto${i}]: TODO\n`;
    }
  }

  const outRef = `footnotes-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, withDefs, "utf8");

  return {
    ok: true,
    outputs: { definitionCount: definitions.length, autoNumbered: anonCounter },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(withDefs, "utf8"), sha256: "", mime: "text/markdown", filename: ref.filename ?? "footnotes.md" }],
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
