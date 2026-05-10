/**
 * font-comparison-overlay: emits an HTML page that renders the same
 * sample text in two or more uploaded fonts on top of each other (one
 * with reduced opacity) so a designer can spot subtle metric differences.
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

export default async function fontComparisonOverlay(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length < 2) {
    return errorResult("missing_input", "font-comparison-overlay requires at least two font inputs");
  }
  const cfg = ctx.inputs ?? {};
  const sample = String(cfg.sampleText ?? "Hamburgefonstiv 0123");
  const sizePx = Number(cfg.fontSize ?? 96);
  const baseUrl = String(cfg.baseUrl ?? "");

  const families = ctx.fileRefs.map((r, i) => `Font${i + 1}`);
  const fontFaces = ctx.fileRefs.map((r, i) =>
    `@font-face { font-family: "Font${i + 1}"; src: url("${baseUrl}${r.filename ?? r.ref}"); font-display: block; }`
  ).join("\n");

  const overlays = families.map((f, i) => {
    const opacity = i === 0 ? 1 : 0.45;
    const color = i === 0 ? "#000" : ["#ff3366", "#3366ff", "#22aa44"][i - 1] ?? "#999";
    return `<div style="position:absolute;top:0;left:0;font-family:'${f}',sans-serif;font-size:${sizePx}px;opacity:${opacity};color:${color};">${escapeHtml(sample)}</div>`;
  }).join("\n");

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaces}</style></head><body style="padding:64px;"><div style="position:relative;height:${sizePx + 32}px;">${overlays}</div><div style="margin-top:64px;font-family:monospace;font-size:13px;color:#666;">${families.map((f, i) => `<div>${f}: ${ctx.fileRefs[i]!.filename ?? ctx.fileRefs[i]!.ref}</div>`).join("")}</div></body></html>`;

  const outRef = "font-comparison.html";
  await writeFile(join(ctx.scratchDir, outRef), html, "utf8");
  ctx.emitProgress(html.length);

  return {
    ok: true,
    outputs: { fontCount: ctx.fileRefs.length, sampleText: sample },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(html, "utf8"), sha256: "", mime: "text/html", filename: outRef }],
    bytesProcessed: html.length,
    durationMs: Date.now() - start,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
