/**
 * svg-clip-path-gen: emits an SVG containing a `<clipPath>` definition for
 * common shapes (circle, rounded-rect, hexagon, star, blob). Useful as a
 * boilerplate generator before assembling avatar masks or hero shapes.
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

export default async function svgClipPathGen(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const shape = String(cfg.shape ?? "circle");
  const id = String(cfg.id ?? `clip-${shape}`);
  const size = Math.max(16, Math.min(2048, Number(cfg.size ?? 200)));

  let pathOrShape: string;
  switch (shape) {
    case "circle":
      pathOrShape = `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}"/>`;
      break;
    case "rounded-rect": {
      const radius = Math.max(0, Math.min(size / 2, Number(cfg.cornerRadius ?? size * 0.15)));
      pathOrShape = `<rect width="${size}" height="${size}" rx="${radius}" ry="${radius}"/>`;
      break;
    }
    case "hexagon": {
      const r = size / 2;
      const points = Array.from({ length: 6 }, (_, i) => {
        const angle = (Math.PI / 3) * i - Math.PI / 6;
        return `${(r + r * Math.cos(angle)).toFixed(2)},${(r + r * Math.sin(angle)).toFixed(2)}`;
      }).join(" ");
      pathOrShape = `<polygon points="${points}"/>`;
      break;
    }
    case "star": {
      const r = size / 2;
      const points = Array.from({ length: 10 }, (_, i) => {
        const radius = i % 2 === 0 ? r : r * 0.4;
        const angle = (Math.PI / 5) * i - Math.PI / 2;
        return `${(r + radius * Math.cos(angle)).toFixed(2)},${(r + radius * Math.sin(angle)).toFixed(2)}`;
      }).join(" ");
      pathOrShape = `<polygon points="${points}"/>`;
      break;
    }
    case "blob": {
      const r = size / 2;
      const segments = 8;
      const noise = (i: number) => 0.85 + Math.sin(i * 1.7 + 0.3) * 0.12;
      const path = Array.from({ length: segments }, (_, i) => {
        const angle = (Math.PI * 2 * i) / segments;
        const radius = r * noise(i);
        const cmd = i === 0 ? "M" : "L";
        return `${cmd}${(r + radius * Math.cos(angle)).toFixed(2)},${(r + radius * Math.sin(angle)).toFixed(2)}`;
      }).join(" ") + " Z";
      pathOrShape = `<path d="${path}"/>`;
      break;
    }
    default:
      return errorResult("invalid_config", `unknown shape: ${shape}`);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <defs>
    <clipPath id="${id}" clipPathUnits="userSpaceOnUse">
      ${pathOrShape}
    </clipPath>
  </defs>
  <rect width="${size}" height="${size}" fill="#4f46e5" clip-path="url(#${id})"/>
</svg>
`;

  const outRef = `clip-${shape}.svg`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, svg, "utf8");
  ctx.emitProgress(0);

  return {
    ok: true,
    outputs: { shape, id, size },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(svg, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }],
    bytesProcessed: 0,
    durationMs: Date.now() - start,
  };
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
