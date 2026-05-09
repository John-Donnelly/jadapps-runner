/**
 * md-from-text: heuristic conversion of plain text to Markdown. Treats:
 *   - blank-line-separated paragraphs as paragraphs
 *   - leading "* "/"- "/"1. " runs as lists (preserved)
 *   - leading capitalised single-line paragraphs as candidate headings (when
 *     the next line is short and looks like a title)
 *   - trailing URL on a line as auto-link
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

export default async function mdFromText(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-from-text requires one text input");

  const cfg = ctx.inputs ?? {};
  const detectHeadings = cfg.detectHeadings !== false;
  const detectLinks = cfg.detectLinks !== false;

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const paragraphs = text.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const out: string[] = [];

  for (const p of paragraphs) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    const lines = trimmed.split("\n");

    if (detectHeadings && lines.length === 1) {
      const single = lines[0]!;
      if (single.length < 80 && /^[A-Z]/.test(single) && !/[.!?]$/.test(single) && !/^[*#-]/.test(single)) {
        out.push(`## ${single}`);
        continue;
      }
    }

    let body = lines.join("\n");
    if (detectLinks) {
      body = body.replace(/(^|\s)(https?:\/\/[^\s<>"]+)/g, (_, pre, url) => `${pre}<${url}>`);
    }
    out.push(body);
  }

  const transformed = out.join("\n\n") + "\n";
  const outRef = `from-text-${ref.ref.replace(/\.[^.]+$/, "")}.md`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, transformed, "utf8");

  return {
    ok: true,
    outputs: { paragraphCount: paragraphs.filter((p) => p.trim()).length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(transformed, "utf8"), sha256: "", mime: "text/markdown", filename: outRef }],
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
