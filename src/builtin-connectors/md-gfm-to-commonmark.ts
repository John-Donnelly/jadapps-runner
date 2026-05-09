/**
 * md-gfm-to-commonmark: rewrites GitHub-flavoured Markdown extensions into
 * vanilla CommonMark. Specifically: ~strikethrough~ -> <s>x</s>, task lists
 * to plain bullets, autolinked URLs become explicit <url>, tables are kept
 * (CommonMark 0.30 supports them), pipe escapes preserved.
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

export default async function mdGfmToCommonmark(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-gfm-to-commonmark requires one Markdown input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const lines = text.split("\n");
  let inFence = false;
  let strikethroughs = 0, taskLists = 0, autolinks = 0;
  const out: string[] = [];

  for (const line of lines) {
    if (/^```/.test(line.trim())) { inFence = !inFence; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }

    let next = line;
    next = next.replace(/~~([^~\n]+)~~/g, (_, body) => { strikethroughs++; return `<s>${body}</s>`; });
    next = next.replace(/^(\s*[-*+])\s+\[[ xX]\]\s+/, (_, lead) => { taskLists++; return `${lead} `; });
    next = next.replace(/(^|[\s(])(https?:\/\/[^\s<>"\)]+)/g, (_, pre, url) => { autolinks++; return `${pre}<${url}>`; });
    out.push(next);
  }

  const transformed = out.join("\n");
  const outRef = `commonmark-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, transformed, "utf8");

  return {
    ok: true,
    outputs: { strikethroughsConverted: strikethroughs, taskListsFlattened: taskLists, autolinksWrapped: autolinks },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(transformed, "utf8"), sha256: "", mime: "text/markdown", filename: ref.filename ?? "commonmark.md" }],
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
