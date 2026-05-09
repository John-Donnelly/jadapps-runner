/**
 * md-ref-link-converter: converts inline links/images to reference-style
 * definitions (or back). For inline -> ref, a stable slug is generated from
 * the link text. Duplicate URLs share a single reference.
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

export default async function mdRefLinkConverter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-ref-link-converter requires one Markdown input");

  const cfg = ctx.inputs ?? {};
  const direction = cfg.direction === "inline" ? "to-inline" : "to-reference";

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const transformed = direction === "to-reference" ? toReference(text) : toInline(text);
  const outRef = `links-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, transformed.text, "utf8");

  return {
    ok: true,
    outputs: { converted: transformed.count, direction },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(transformed.text, "utf8"), sha256: "", mime: "text/markdown", filename: ref.filename ?? "links.md" }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function toReference(text: string): { text: string; count: number } {
  const urlToRef = new Map<string, string>();
  const slugCounts = new Map<string, number>();
  let count = 0;

  const transformed = text.replace(/(!?)\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, bang, label, url) => {
    let refId = urlToRef.get(url);
    if (!refId) {
      const base = slugify(label) || "link";
      const usedCount = slugCounts.get(base) ?? 0;
      refId = usedCount === 0 ? base : `${base}-${usedCount}`;
      slugCounts.set(base, usedCount + 1);
      urlToRef.set(url, refId);
    }
    count += 1;
    return `${bang}[${label}][${refId}]`;
  });

  if (urlToRef.size === 0) return { text: transformed, count: 0 };
  let appended = transformed.replace(/\n+$/, "") + "\n\n";
  for (const [url, refId] of urlToRef) appended += `[${refId}]: ${url}\n`;
  return { text: appended, count };
}

function toInline(text: string): { text: string; count: number } {
  const refs = new Map<string, string>();
  const stripped = text.replace(/^\s*\[([^\]]+)\]:\s*(\S+)\s*$/gm, (_, id, url) => {
    refs.set(id, url);
    return "";
  });
  let count = 0;
  const transformed = stripped.replace(/(!?)\[([^\]]+)\]\[([^\]]*)\]/g, (m, bang, label, id) => {
    const key = id || label;
    const url = refs.get(key);
    if (!url) return m;
    count += 1;
    return `${bang}[${label}](${url})`;
  });
  return { text: transformed.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, "\n"), count };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
