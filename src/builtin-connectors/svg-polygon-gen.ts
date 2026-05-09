/**
 * svg-polygon-gen: generates an SVG of a regular polygon (3-100 sides)
 * with optional stroke and fill. Useful as a building block for more
 * complex generators.
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

export default async function svgPolygonGen(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const sides = Math.max(3, Math.min(100, Math.floor(Number(cfg.sides ?? 6))));
  const size = Math.max(20, Math.min(2048, Number(cfg.size ?? 200)));
  const fill = String(cfg.fill ?? "#4F46E5");
  const stroke = String(cfg.stroke ?? "none");
  const strokeWidth = Number(cfg.strokeWidth ?? 0);
  const rotation = Number(cfg.rotation ?? -90); // -90 puts a flat side at bottom for hexagons

  const r = size / 2 - strokeWidth / 2;
  const cx = size / 2;
  const cy = size / 2;
  const points = Array.from({ length: sides }, (_, i) => {
    const angle = ((Math.PI * 2 * i) / sides) + (rotation * Math.PI) / 180;
    return `${(cx + r * Math.cos(angle)).toFixed(2)},${(cy + r * Math.sin(angle)).toFixed(2)}`;
  }).join(" ");

  const strokeAttrs = stroke !== "none" ? ` stroke="${stroke}" stroke-width="${strokeWidth}"` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <polygon points="${points}" fill="${fill}"${strokeAttrs}/>
</svg>
`;

  const outRef = `polygon-${sides}.svg`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, svg, "utf8");
  ctx.emitProgress(0);

  return {
    ok: true,
    outputs: { sides, size, rotation },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(svg, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }],
    bytesProcessed: 0,
    durationMs: Date.now() - start,
  };
}
