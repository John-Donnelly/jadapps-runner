/**
 * svg-to-pdf: rasters a subset of SVG into a PDF page using pdf-lib's
 * drawSvgPath, drawRectangle, drawLine, drawCircle, and drawText. Supports
 * <path>, <rect>, <line>, <circle>, <ellipse>, <text>, <g>. Stroke and
 * fill colours read from `stroke`/`fill` attributes (named or hex). Other
 * SVG features (gradients, filters, masks, foreignObject, embedded raster
 * images) are not supported in v0.1.
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

interface SvgElement { tag: string; attrs: Record<string, string>; text: string; children: SvgElement[]; }

export default async function svgToPdf(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-to-pdf requires one SVG input");

  let pdfLib: typeof import("pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const root = parseSvg(text);
  if (!root) return errorResult("parse_error", "could not parse SVG");

  const viewBox = parseViewBox(root.attrs.viewBox ?? "");
  const width = Number(root.attrs.width ?? viewBox?.[2] ?? 800);
  const height = Number(root.attrs.height ?? viewBox?.[3] ?? 600);

  const doc = await pdfLib.PDFDocument.create();
  const page = doc.addPage([width, height]);
  drawElement(page, root, height, pdfLib);

  const bytes = await doc.save();
  const baseName = (ref.filename ?? "doc").replace(/\.svg$/i, "");
  const outRef = `${baseName}.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, bytes);

  return {
    ok: true,
    outputs: { width, height },
    fileRefs: [{ ref: outRef, bytes: bytes.length, sha256: "", mime: "application/pdf", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function parseSvg(text: string): SvgElement | null {
  const cleaned = text.replace(/<\?xml[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const tagRe = /<\/?([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let pos = 0;
  const stack: SvgElement[] = [];
  let root: SvgElement | null = null;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(cleaned)) !== null) {
    const between = cleaned.slice(pos, match.index);
    if (between.trim() && stack.length > 0) stack[stack.length - 1]!.text += between;
    pos = tagRe.lastIndex;
    const isClose = match[0].startsWith("</");
    const tag = (match[1] ?? "").toLowerCase();
    const isSelfClose = match[3] === "/";
    if (isClose) { stack.pop(); continue; }
    const attrs: Record<string, string> = {};
    for (const am of (match[2] ?? "").matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g)) attrs[am[1]!] = am[2]!;
    const node: SvgElement = { tag, attrs, text: "", children: [] };
    if (stack.length > 0) stack[stack.length - 1]!.children.push(node);
    if (!root) root = node;
    if (!isSelfClose) stack.push(node);
  }
  return root;
}

function parseViewBox(s: string): [number, number, number, number] | null {
  const parts = s.trim().split(/\s+|,/).map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) return parts as [number, number, number, number];
  return null;
}

interface RGB { r: number; g: number; b: number; }
function parseColor(value: string | undefined): RGB | null {
  if (!value || value === "none") return null;
  const named: Record<string, RGB> = { black: { r: 0, g: 0, b: 0 }, white: { r: 1, g: 1, b: 1 }, red: { r: 1, g: 0, b: 0 }, green: { r: 0, g: 0.5, b: 0 }, blue: { r: 0, g: 0, b: 1 }, gray: { r: 0.5, g: 0.5, b: 0.5 }, grey: { r: 0.5, g: 0.5, b: 0.5 } };
  if (named[value]) return named[value];
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex && hex[1]) {
    const h = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 };
  }
  const rgbMatch = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(value);
  if (rgbMatch) return { r: Number(rgbMatch[1]) / 255, g: Number(rgbMatch[2]) / 255, b: Number(rgbMatch[3]) / 255 };
  return null;
}

function drawElement(page: import("pdf-lib").PDFPage, node: SvgElement, pageHeight: number, pdfLib: typeof import("pdf-lib")): void {
  const { drawSvgPath, rgb } = { drawSvgPath: null as unknown, rgb: pdfLib.rgb };
  void drawSvgPath;
  const fill = parseColor(node.attrs.fill);
  const stroke = parseColor(node.attrs.stroke);
  const strokeWidth = Number(node.attrs["stroke-width"] ?? 1);

  switch (node.tag) {
    case "svg":
    case "g":
      for (const child of node.children) drawElement(page, child, pageHeight, pdfLib);
      break;
    case "rect": {
      const x = Number(node.attrs.x ?? 0);
      const y = Number(node.attrs.y ?? 0);
      const w = Number(node.attrs.width ?? 0);
      const h = Number(node.attrs.height ?? 0);
      const opts: import("pdf-lib").PDFPageDrawRectangleOptions = { x, y: pageHeight - y - h, width: w, height: h };
      if (fill) opts.color = rgb(fill.r, fill.g, fill.b);
      if (stroke) { opts.borderColor = rgb(stroke.r, stroke.g, stroke.b); opts.borderWidth = strokeWidth; }
      page.drawRectangle(opts);
      break;
    }
    case "line": {
      const x1 = Number(node.attrs.x1 ?? 0);
      const y1 = Number(node.attrs.y1 ?? 0);
      const x2 = Number(node.attrs.x2 ?? 0);
      const y2 = Number(node.attrs.y2 ?? 0);
      const color = stroke ?? { r: 0, g: 0, b: 0 };
      page.drawLine({ start: { x: x1, y: pageHeight - y1 }, end: { x: x2, y: pageHeight - y2 }, thickness: strokeWidth, color: rgb(color.r, color.g, color.b) });
      break;
    }
    case "circle": {
      const cx = Number(node.attrs.cx ?? 0);
      const cy = Number(node.attrs.cy ?? 0);
      const r = Number(node.attrs.r ?? 0);
      const opts: import("pdf-lib").PDFPageDrawCircleOptions = { x: cx, y: pageHeight - cy, size: r };
      if (fill) opts.color = rgb(fill.r, fill.g, fill.b);
      if (stroke) { opts.borderColor = rgb(stroke.r, stroke.g, stroke.b); opts.borderWidth = strokeWidth; }
      page.drawCircle(opts);
      break;
    }
    case "ellipse": {
      const cx = Number(node.attrs.cx ?? 0);
      const cy = Number(node.attrs.cy ?? 0);
      const rx = Number(node.attrs.rx ?? 0);
      const ry = Number(node.attrs.ry ?? 0);
      const opts: import("pdf-lib").PDFPageDrawEllipseOptions = { x: cx, y: pageHeight - cy, xScale: rx, yScale: ry };
      if (fill) opts.color = rgb(fill.r, fill.g, fill.b);
      if (stroke) { opts.borderColor = rgb(stroke.r, stroke.g, stroke.b); opts.borderWidth = strokeWidth; }
      page.drawEllipse(opts);
      break;
    }
    case "path": {
      const d = node.attrs.d ?? "";
      if (d) {
        const opts: import("pdf-lib").PDFPageDrawSVGOptions = { x: 0, y: pageHeight };
        if (fill) opts.color = rgb(fill.r, fill.g, fill.b);
        if (stroke) { opts.borderColor = rgb(stroke.r, stroke.g, stroke.b); opts.borderWidth = strokeWidth; }
        page.drawSvgPath(d, opts);
      }
      break;
    }
    case "text": {
      const x = Number(node.attrs.x ?? 0);
      const y = Number(node.attrs.y ?? 0);
      const fontSize = Number(node.attrs["font-size"] ?? 12);
      const color = fill ?? stroke ?? { r: 0, g: 0, b: 0 };
      const text = node.text.replace(/\s+/g, " ").trim();
      if (text) {
        page.drawText(text, { x, y: pageHeight - y, size: fontSize, color: rgb(color.r, color.g, color.b) });
      }
      for (const child of node.children) drawElement(page, child, pageHeight, pdfLib);
      break;
    }
    default:
      for (const child of node.children) drawElement(page, child, pageHeight, pdfLib);
  }
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
