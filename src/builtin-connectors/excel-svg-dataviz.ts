/**
 * excel-svg-dataviz: renders a basic chart (bar or line) of two columns from
 * a sheet to an SVG file. Pure SVG generation — no canvas or browser needed.
 */

import { writeFile } from "node:fs/promises";
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

export default async function excelSvgDataviz(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "excel-svg-dataviz requires one .xlsx input");

  const cfg = ctx.inputs ?? {};
  const sheetSel = cfg.sheet ?? 1;
  const labelColumn = cfg.labelColumn;
  const valueColumn = cfg.valueColumn;
  const chartType = cfg.chartType === "line" ? "line" : "bar";
  if (labelColumn == null || valueColumn == null) return errorResult("invalid_config", "labelColumn and valueColumn are required");

  let ExcelJS: typeof import("exceljs");
  try { ExcelJS = (await import("exceljs")).default as typeof import("exceljs"); }
  catch (err) { return errorResult("driver_missing", `exceljs not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inPath);
  ctx.emitProgress(totalIn);

  const sheet = typeof sheetSel === "number" ? wb.worksheets[sheetSel - 1] : wb.getWorksheet(String(sheetSel));
  if (!sheet) return errorResult("sheet_not_found", `sheet ${JSON.stringify(sheetSel)} not found`);
  const matrix: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => matrix.push(Array.isArray(row.values) ? row.values.slice(1) : []));
  if (matrix.length < 2) return errorResult("empty_sheet", "need at least one data row");

  const header = (matrix[0] ?? []).map((v) => String(v ?? ""));
  const labelIdx = resolveColumn(header, labelColumn);
  const valueIdx = resolveColumn(header, valueColumn);
  if (labelIdx < 0 || valueIdx < 0) return errorResult("invalid_config", "labelColumn or valueColumn not found");

  const points: { label: string; value: number }[] = [];
  for (let i = 1; i < matrix.length; i++) {
    const row = matrix[i] ?? [];
    const label = String(row[labelIdx] ?? "");
    const value = Number(row[valueIdx]);
    if (label && Number.isFinite(value)) points.push({ label, value });
  }
  if (points.length === 0) return errorResult("insufficient_data", "no valid (label, value) pairs found");

  const svg = chartType === "bar" ? renderBar(points, header[valueIdx] ?? "value") : renderLine(points, header[valueIdx] ?? "value");

  const outRef = "chart.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, svg, "utf8");

  return {
    ok: true,
    outputs: { chartType, pointCount: points.length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(svg, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function renderBar(points: { label: string; value: number }[], yLabel: string): string {
  const W = 800, H = 400, P = 60;
  const innerW = W - 2 * P;
  const innerH = H - 2 * P;
  const max = Math.max(...points.map((p) => p.value), 1);
  const barW = innerW / points.length * 0.8;
  const gap = innerW / points.length * 0.2;
  const bars = points.map((p, i) => {
    const x = P + i * (barW + gap) + gap / 2;
    const h = (p.value / max) * innerH;
    const y = H - P - h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="#4f46e5"/>` +
           `<text x="${(x + barW / 2).toFixed(1)}" y="${H - P + 15}" text-anchor="middle" font-size="10" fill="#333">${escapeXml(p.label.slice(0, 12))}</text>`;
  }).join("");
  return wrapSvg(W, H, P, innerH, yLabel, bars, max);
}

function renderLine(points: { label: string; value: number }[], yLabel: string): string {
  const W = 800, H = 400, P = 60;
  const innerW = W - 2 * P;
  const innerH = H - 2 * P;
  const max = Math.max(...points.map((p) => p.value), 1);
  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
  const path = points.map((p, i) => {
    const x = P + i * stepX;
    const y = H - P - (p.value / max) * innerH;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const labels = points.map((p, i) => `<text x="${(P + i * stepX).toFixed(1)}" y="${H - P + 15}" text-anchor="middle" font-size="10" fill="#333">${escapeXml(p.label.slice(0, 12))}</text>`).join("");
  return wrapSvg(W, H, P, innerH, yLabel, `<path d="${path}" fill="none" stroke="#4f46e5" stroke-width="2"/>${labels}`, max);
}

function wrapSvg(W: number, H: number, P: number, innerH: number, yLabel: string, body: string, max: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<style>text { font-family: system-ui, -apple-system, sans-serif; }</style>
<line x1="${P}" y1="${P}" x2="${P}" y2="${H - P}" stroke="#999"/>
<line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#999"/>
<text x="${P - 8}" y="${P + 4}" text-anchor="end" font-size="10" fill="#666">${max.toFixed(0)}</text>
<text x="${P - 8}" y="${H - P + 4}" text-anchor="end" font-size="10" fill="#666">0</text>
<text x="${P}" y="${P - 16}" font-size="12" fill="#333">${escapeXml(yLabel)}</text>
${body}
</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function resolveColumn(header: string[], col: unknown): number {
  if (typeof col === "number" && Number.isInteger(col) && col > 0 && col <= header.length) return col - 1;
  return header.indexOf(String(col));
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
