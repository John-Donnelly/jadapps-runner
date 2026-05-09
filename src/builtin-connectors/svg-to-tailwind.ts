/**
 * svg-to-tailwind: rewrites inline SVG fill/stroke colors to use Tailwind
 * `currentColor` and emits a small Tailwind/JSX wrapper that controls
 * colour via the `text-…` utility class. Useful for mono icons embedded
 * in a Tailwind project.
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

export default async function svgToTailwind(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-to-tailwind requires one SVG input");
  const cfg = ctx.inputs ?? {};
  const componentName = String(cfg.componentName ?? "Icon");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  // Replace any non-"none" fill/stroke with currentColor.
  let result = text.replace(/(\s(?:fill|stroke)=")([^"]+)(")/gi, (m, pre, value, post) => {
    if (value === "none") return m;
    return `${pre}currentColor${post}`;
  });
  // Strip width/height so the user controls via Tailwind class.
  result = result.replace(/<svg([^>]*)>/, (_, attrs) => {
    const cleaned = (attrs as string).replace(/\swidth="?\d+(?:\.\d+)?"?/g, "").replace(/\sheight="?\d+(?:\.\d+)?"?/g, "");
    return `<svg${cleaned} className={className}>`;
  });
  result = result.replace(/<\?xml[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").trim();

  const tsx = `// Use as <${componentName} className="h-5 w-5 text-indigo-500" />
import { type ReactElement } from "react";

export function ${componentName}({ className = "h-5 w-5" }: { className?: string }): ReactElement {
  return (
${result.split("\n").map((l) => "    " + l).join("\n")}
  );
}
`;

  const outRef = `${componentName}.tsx`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, tsx, "utf8");

  return {
    ok: true,
    outputs: { componentName },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(tsx, "utf8"), sha256: "", mime: "text/typescript", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
