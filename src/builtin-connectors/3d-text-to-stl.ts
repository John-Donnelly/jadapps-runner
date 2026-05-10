/**
 * 3d-text-to-stl: extrudes text into a 3D STL plate. True text-to-mesh
 * needs a font glyph -> path -> triangulation pipeline (OpenJSCAD or
 * three.js + earcut) — reports driver_missing in the runner.
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

export default async function threeDTextToStl(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  void cfg.text;
  void start;
  const placeholder = JSON.stringify({ note: "3d-text-to-stl requires a font + path-to-mesh pipeline (OpenJSCAD or three.js + earcut). The runner does not bundle these." }, null, 2);
  const outRef = "3d-text-info.json";
  await writeFile(join(ctx.scratchDir, outRef), placeholder, "utf8");
  ctx.emitProgress(placeholder.length);
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code: "driver_missing", message: "3d text-to-mesh requires OpenJSCAD or three.js + earcut + a font glyph extractor. Not bundled." } };
}
