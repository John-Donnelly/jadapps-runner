/**
 * latin-filter: prepares a Latin-1-only character whitelist for use with
 * font-subsetter. Pure-JS fallback for builds where full subsetting
 * is unavailable: outputs the unicode-range string ready for @font-face.
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

export default async function latinFilter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const includeExtended = Boolean(cfg.includeExtended ?? true);

  const ranges: string[] = ["U+0020-007E"];
  if (includeExtended) ranges.push("U+00A0-00FF", "U+0100-017F", "U+0180-024F", "U+1E00-1EFF");
  const cssRange = ranges.join(", ");

  const css = `@font-face {\n  font-family: "LatinSubset";\n  unicode-range: ${cssRange};\n  src: url("/fonts/latin-subset.woff2") format("woff2");\n  font-display: swap;\n}\n`;
  const json = JSON.stringify({ ranges, cssRange, includeExtended }, null, 2);

  await writeFile(join(ctx.scratchDir, "latin-filter.css"), css, "utf8");
  await writeFile(join(ctx.scratchDir, "latin-filter.json"), json, "utf8");
  ctx.emitProgress(css.length + json.length);

  return {
    ok: true,
    outputs: { rangeCount: ranges.length, cssRange, includeExtended },
    fileRefs: [
      { ref: "latin-filter.css", bytes: Buffer.byteLength(css, "utf8"), sha256: "", mime: "text/css", filename: "latin-filter.css" },
      { ref: "latin-filter.json", bytes: Buffer.byteLength(json, "utf8"), sha256: "", mime: "application/json", filename: "latin-filter.json" },
    ],
    bytesProcessed: css.length + json.length,
    durationMs: Date.now() - start,
  };
}
