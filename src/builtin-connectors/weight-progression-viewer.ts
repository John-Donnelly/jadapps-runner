/**
 * weight-progression-viewer: emits an HTML preview that renders the
 * same string at every weight 100..900 so a designer can visually
 * compare weight progression of an installed font.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function weightProgressionViewer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const family = String(cfg.family ?? "Inter");
  const sample = String(cfg.sampleText ?? "The quick brown fox jumps over the lazy dog");
  const sizePx = Number(cfg.fontSize ?? 24);

  const rows = [100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) =>
    `<div style="font-weight:${w};font-size:${sizePx}px;font-family:'${family}',sans-serif;margin-bottom:0.5em;">
       <span style="color:#888;font-size:14px;font-family:monospace;">${w}</span> &nbsp; ${escapeHtml(sample)}
     </div>`
  ).join("\n");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Weight Progression: ${escapeHtml(family)}</title></head><body style="font-family:'${family}',sans-serif;padding:32px;">${rows}</body></html>`;

  const outRef = "weight-progression.html";
  await writeFile(join(ctx.scratchDir, outRef), html, "utf8");
  ctx.emitProgress(html.length);

  return {
    ok: true,
    outputs: { family, sampleText: sample, weightCount: 9 },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(html, "utf8"), sha256: "", mime: "text/html", filename: outRef }],
    bytesProcessed: html.length,
    durationMs: Date.now() - start,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
