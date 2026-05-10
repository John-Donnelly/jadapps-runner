/**
 * g-code-visualizer: parses G-code (G0/G1 movements) and renders the
 * toolpath as an SVG top-down preview.
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

export default async function gCodeVisualizer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "g-code-visualizer requires one G-code input");
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  let x = 0, y = 0, z = 0;
  const segments: { x1: number; y1: number; x2: number; y2: number; extrude: boolean }[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let lineCount = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split(";")[0]!.trim();
    if (!line) continue;
    const m = /^G([01])\b/.exec(line);
    if (!m) continue;
    lineCount += 1;
    const nx = matchVal(line, /X(-?\d+(\.\d+)?)/) ?? x;
    const ny = matchVal(line, /Y(-?\d+(\.\d+)?)/) ?? y;
    const nz = matchVal(line, /Z(-?\d+(\.\d+)?)/) ?? z;
    const e = matchVal(line, /E(-?\d+(\.\d+)?)/);
    if (nx !== x || ny !== y) {
      segments.push({ x1: x, y1: y, x2: nx, y2: ny, extrude: (e ?? 0) > 0 });
      if (nx < minX) minX = nx; if (nx > maxX) maxX = nx;
      if (ny < minY) minY = ny; if (ny > maxY) maxY = ny;
    }
    x = nx; y = ny; z = nz;
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 200; maxY = 200; }
  const w = maxX - minX || 1, h = maxY - minY || 1;
  const paths = segments.map((s) =>
    `<line x1="${s.x1 - minX}" y1="${maxY - s.y1}" x2="${s.x2 - minX}" y2="${maxY - s.y2}" stroke="${s.extrude ? "#000" : "#ccc"}" stroke-width="${s.extrude ? 0.4 : 0.2}"/>`
  ).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * 2}" height="${h * 2}">${paths}</svg>`;
  const outRef = "gcode-preview.svg";
  await writeFile(join(ctx.scratchDir, outRef), svg, "utf8");
  return { ok: true, outputs: { commandCount: lineCount, segmentCount: segments.length, bbox: [minX, minY, maxX, maxY] }, fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(svg, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function matchVal(line: string, re: RegExp): number | null {
  const m = re.exec(line);
  return m && m[1] ? parseFloat(m[1]) : null;
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
