/**
 * preload-tag-builder: emits <link rel="preload"> tags for a given list
 * of font URLs, with the right `as` and `crossorigin` attributes. Helps
 * eliminate FOUT/FOIT in critical-path fonts.
 */

import { writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function preloadTagBuilder(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const urls = parseList(cfg.urls);
  if (urls.length === 0 && (!ctx.fileRefs || ctx.fileRefs.length === 0)) {
    return errorResult("invalid_input", "preload-tag-builder requires `urls` input or font fileRefs");
  }
  const baseUrl = String(cfg.baseUrl ?? "/fonts");
  const finalUrls = urls.length > 0 ? urls : ctx.fileRefs.map((r) => `${baseUrl}/${r.filename ?? r.ref}`);

  const tags = finalUrls.map((url) => {
    const ext = extname(url).toLowerCase().replace(".", "");
    const type = ext === "woff2" ? "font/woff2" : ext === "woff" ? "font/woff" : ext === "ttf" ? "font/ttf" : ext === "otf" ? "font/otf" : "font/woff2";
    return `<link rel="preload" href="${url}" as="font" type="${type}" crossorigin>`;
  });
  const html = tags.join("\n") + "\n";

  const outRef = "preload-tags.html";
  await writeFile(join(ctx.scratchDir, outRef), html, "utf8");
  ctx.emitProgress(html.length);

  return {
    ok: true,
    outputs: { tagCount: tags.length, urls: finalUrls },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(html, "utf8"), sha256: "", mime: "text/html", filename: outRef }],
    bytesProcessed: html.length,
    durationMs: Date.now() - start,
  };
}

function parseList(input: unknown): string[] {
  if (Array.isArray(input)) return input.map(String);
  if (typeof input === "string") return input.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
