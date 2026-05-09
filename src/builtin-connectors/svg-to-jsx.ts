/**
 * svg-to-jsx: converts an SVG to a React functional component. Renames
 * kebab-case attributes to camelCase, swaps `class` for `className`, and
 * replaces hardcoded `width`/`height` with props.
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

export default async function svgToJsx(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-to-jsx requires one SVG input");
  const cfg = ctx.inputs ?? {};
  const componentName = String(cfg.componentName ?? "Icon");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const stripped = text.replace(/<\?xml[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  const jsx = stripped
    .replace(/\bclass=/g, "className=")
    .replace(/\bxmlns:xlink="[^"]*"/g, "")
    .replace(/\bxlink:href=/g, "href=")
    .replace(/-([a-z])/g, (_, l) => l.toUpperCase())
    // Re-fix viewBox/preserveAspectRatio which have intentional camelCase forms
    .replace(/\bviewbox=/gi, "viewBox=")
    .replace(/\bpreserveaspectratio=/gi, "preserveAspectRatio=")
    // Replace fixed width/height on root <svg> with props
    .replace(/<svg([^>]*)>/, (_, attrs) => {
      let cleaned = (attrs as string).replace(/\swidth="?\d+(?:\.\d+)?"?/g, "").replace(/\sheight="?\d+(?:\.\d+)?"?/g, "");
      return `<svg${cleaned} width={width} height={height} {...rest}>`;
    });

  const tsx = `import { type SVGProps } from "react";

export function ${componentName}({ width = 24, height = 24, ...rest }: SVGProps<SVGSVGElement>) {
  return (
${jsx.split("\n").map((l) => "    " + l).join("\n")}
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
