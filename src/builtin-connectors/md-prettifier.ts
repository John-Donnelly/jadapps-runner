/**
 * md-prettifier: opinionated Markdown formatting pass. Normalises emphasis
 * markers (*, **), bullet markers (-), heading spacing (one blank line above,
 * one below), trailing-space stripping, and CRLF -> LF.
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

export default async function mdPrettifier(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-prettifier requires one Markdown input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (/^```/.test(raw.trim())) { inFence = !inFence; out.push(raw); continue; }
    if (inFence) { out.push(raw); continue; }

    let line = raw.replace(/[ \t]+$/g, "");
    line = line.replace(/__([^_\n]+?)__/g, "**$1**");
    line = line.replace(/(?<![_\w])_([^_\n]+?)_(?![_\w])/g, "*$1*");
    line = line.replace(/^(\s*)[*+](\s+)/, "$1-$2");

    const isHeading = /^#{1,6}\s+\S/.test(line);
    if (isHeading && out.length > 0) {
      const last = out[out.length - 1];
      if (last !== "") out.push("");
    }
    out.push(line);
    if (isHeading) {
      const next = lines[i + 1];
      if (next != null && next.trim() !== "" && !/^#{1,6}\s/.test(next)) {
        out.push("");
      }
    }
  }

  let transformed = out.join("\n");
  transformed = transformed.replace(/\n{3,}/g, "\n\n");
  transformed = transformed.replace(/^\n+/, "").replace(/\n+$/, "\n");

  const outRef = `pretty-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, transformed, "utf8");

  return {
    ok: true,
    outputs: {},
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(transformed, "utf8"), sha256: "", mime: "text/markdown", filename: ref.filename ?? "pretty.md" }],
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
