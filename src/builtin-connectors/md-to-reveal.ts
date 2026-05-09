/**
 * md-to-reveal: converts Markdown to a reveal.js HTML slide deck. Slides
 * are split on `---` (horizontal) and `--` (vertical); each slide's
 * Markdown body is rendered to HTML with `marked`.
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

export default async function mdToReveal(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-to-reveal requires one Markdown input");

  const cfg = ctx.inputs ?? {};
  const title = String(cfg.title ?? (ref.filename ?? "Slides").replace(/\.md$/i, ""));
  const theme = String(cfg.theme ?? "white");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  let marked: typeof import("marked");
  try { marked = await import("marked"); }
  catch (err) {
    return errorResult("driver_missing", `marked not installed: ${(err as Error).message}`);
  }

  marked.marked.setOptions({ gfm: true, breaks: false });
  const horizontalSlides = text.split(/\n^---\s*$\n/m);
  const slidesHtml: string[] = [];
  let total = 0;

  for (const horizontal of horizontalSlides) {
    const verticals = horizontal.split(/\n^--\s*$\n/m);
    if (verticals.length === 1) {
      const body = await marked.marked.parse(verticals[0] ?? "");
      slidesHtml.push(`<section>${body}</section>`);
      total += 1;
    } else {
      const inner: string[] = [];
      for (const v of verticals) {
        const body = await marked.marked.parse(v ?? "");
        inner.push(`<section>${body}</section>`);
        total += 1;
      }
      slidesHtml.push(`<section>${inner.join("")}</section>`);
    }
  }

  const out = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/theme/${escapeHtml(theme)}.css">
</head>
<body>
<div class="reveal"><div class="slides">
${slidesHtml.join("\n")}
</div></div>
<script src="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js"></script>
<script>Reveal.initialize({hash:true});</script>
</body>
</html>
`;

  const outRef = `${title}.html`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { slideCount: total, theme },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "text/html", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
