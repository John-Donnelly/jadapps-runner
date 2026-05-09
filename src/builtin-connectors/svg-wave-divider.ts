/**
 * svg-wave-divider: generates a decorative wave divider SVG (sine, jagged,
 * or curve-and-cut) that you can place between sections of a web page.
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

export default async function svgWaveDivider(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const style = String(cfg.style ?? "sine");
  const width = Math.max(320, Math.min(4096, Number(cfg.width ?? 1440)));
  const height = Math.max(40, Math.min(400, Number(cfg.height ?? 120)));
  const fill = String(cfg.fill ?? "#4F46E5");

  let path: string;
  switch (style) {
    case "sine": {
      const amplitude = height * 0.4;
      const segments = 60;
      const dx = width / segments;
      let d = `M0,${height} L0,${height / 2}`;
      for (let i = 0; i <= segments; i++) {
        const x = i * dx;
        const y = height / 2 - Math.sin((i / segments) * Math.PI * 2) * amplitude;
        d += ` L${x.toFixed(2)},${y.toFixed(2)}`;
      }
      d += ` L${width},${height} Z`;
      path = d;
      break;
    }
    case "jagged": {
      const peaks = 12;
      const dx = width / peaks;
      let d = `M0,${height} L0,${height / 2}`;
      for (let i = 0; i <= peaks; i++) {
        const x = i * dx;
        const y = i % 2 === 0 ? height * 0.2 : height * 0.7;
        d += ` L${x.toFixed(2)},${y.toFixed(2)}`;
      }
      d += ` L${width},${height} Z`;
      path = d;
      break;
    }
    case "curve":
    default:
      path = `M0,${height} L0,${height / 2} Q${width / 4},${height * 0.1} ${width / 2},${height / 2} T${width},${height / 2} L${width},${height} Z`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="none">
  <path d="${path}" fill="${fill}"/>
</svg>
`;
  const outRef = `wave-${style}.svg`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, svg, "utf8");
  ctx.emitProgress(0);

  return {
    ok: true,
    outputs: { style, width, height },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(svg, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }],
    bytesProcessed: 0,
    durationMs: Date.now() - start,
  };
}
