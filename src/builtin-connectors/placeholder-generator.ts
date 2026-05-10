/**
 * placeholder-generator: emits an SVG placeholder of the requested
 * dimensions and label. Useful for layout mockups.
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

export default async function placeholderGenerator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const width = Math.max(1, Number(cfg.width ?? 600));
  const height = Math.max(1, Number(cfg.height ?? 400));
  const text = String(cfg.text ?? `${width}x${height}`);
  const bg = String(cfg.background ?? "#ddd");
  const fg = String(cfg.foreground ?? "#666");
  const fontSize = Math.min(width, height) / 8;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${bg}"/>
  <text x="50%" y="50%" font-family="sans-serif" font-size="${fontSize}" fill="${fg}" text-anchor="middle" dominant-baseline="central">${escapeXml(text)}</text>
</svg>
`;
  const outRef = `placeholder-${width}x${height}.svg`;
  await writeFile(join(ctx.scratchDir, outRef), svg, "utf8");
  ctx.emitProgress(svg.length);
  return { ok: true, outputs: { width, height, text }, fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(svg, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }], bytesProcessed: svg.length, durationMs: Date.now() - start };
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
