/**
 * md-toc-generator: scans `#` headings and inserts a Markdown table of
 * contents at `<!-- TOC -->` (or prepends one at the top if absent).
 * Anchors mimic GitHub's slug rules.
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

export default async function mdTocGenerator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-toc-generator requires one Markdown input");

  const cfg = ctx.inputs ?? {};
  const minLevel = Math.max(1, Math.min(6, Math.floor(Number(cfg.minLevel ?? 1))));
  const maxLevel = Math.max(minLevel, Math.min(6, Math.floor(Number(cfg.maxLevel ?? 4))));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const headings = extractHeadings(text, minLevel, maxLevel);
  const slugCounts = new Map<string, number>();
  const tocLines: string[] = [];
  for (const h of headings) {
    const baseSlug = slugify(h.title);
    const count = slugCounts.get(baseSlug) ?? 0;
    slugCounts.set(baseSlug, count + 1);
    const slug = count === 0 ? baseSlug : `${baseSlug}-${count}`;
    const indent = "  ".repeat(h.level - minLevel);
    tocLines.push(`${indent}- [${h.title}](#${slug})`);
  }
  const toc = tocLines.join("\n");

  let body: string;
  let insertedAt: string;
  if (text.includes("<!-- TOC -->")) {
    body = text.replace(/<!--\s*TOC\s*-->[\s\S]*?(?=\n\n|$)/, `<!-- TOC -->\n${toc}\n<!-- /TOC -->`);
    insertedAt = "marker";
  } else {
    body = `<!-- TOC -->\n${toc}\n<!-- /TOC -->\n\n` + text;
    insertedAt = "top";
  }

  const outRef = `toc-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, body, "utf8");

  return {
    ok: true,
    outputs: { headingCount: headings.length, insertedAt, minLevel, maxLevel },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(body, "utf8"), sha256: "", mime: "text/markdown", filename: ref.filename ?? "toc.md" }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

interface Heading { level: number; title: string; }

function extractHeadings(text: string, minLevel: number, maxLevel: number): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^```/.test(line.trim())) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const level = m[1].length;
    if (level < minLevel || level > maxLevel) continue;
    out.push({ level, title: m[2] });
  }
  return out;
}

function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
