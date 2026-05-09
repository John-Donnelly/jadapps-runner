/**
 * md-splitter: splits a Markdown document into multiple files at heading
 * boundaries. `level` controls split depth (default 1 = at every H1). Each
 * chunk inherits the originating heading as its filename.
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

export default async function mdSplitter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-splitter requires one Markdown input");

  const cfg = ctx.inputs ?? {};
  const level = Math.max(1, Math.min(6, Math.floor(Number(cfg.level ?? 1))));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const lines = text.split("\n");
  const splitRe = new RegExp(`^#{1,${level}}\\s+(.+?)\\s*#*\\s*$`);
  const chunks: { name: string; body: string[] }[] = [];
  let current: { name: string; body: string[] } = { name: "preface", body: [] };
  let inFence = false;

  for (const line of lines) {
    if (/^```/.test(line.trim())) inFence = !inFence;
    if (!inFence) {
      const m = splitRe.exec(line);
      if (m && m[1]) {
        if (current.body.length > 0 || current.name !== "preface") chunks.push(current);
        current = { name: slugify(m[1]) || `chunk-${chunks.length}`, body: [line] };
        continue;
      }
    }
    current.body.push(line);
  }
  if (current.body.length > 0) chunks.push(current);

  const fileRefs: FileRef[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const body = c.body.join("\n");
    const safeName = `${String(i).padStart(3, "0")}-${c.name}.md`;
    const outPath = join(ctx.scratchDir, safeName);
    await writeFile(outPath, body, "utf8");
    fileRefs.push({ ref: safeName, bytes: Buffer.byteLength(body, "utf8"), sha256: "", mime: "text/markdown", filename: safeName });
  }

  return {
    ok: true,
    outputs: { chunkCount: chunks.length, level },
    fileRefs,
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
