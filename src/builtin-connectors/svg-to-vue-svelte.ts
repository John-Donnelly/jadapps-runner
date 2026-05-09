/**
 * svg-to-vue-svelte: emits both a Vue Single File Component (.vue) and a
 * Svelte component (.svelte) wrapping the input SVG with a `size` prop.
 * Both files in one tool because the conversion is essentially the same.
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

export default async function svgToVueSvelte(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-to-vue-svelte requires one SVG input");
  const cfg = ctx.inputs ?? {};
  const componentName = String(cfg.componentName ?? "Icon");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const cleaned = text.replace(/<\?xml[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  const propsified = cleaned.replace(/<svg([^>]*)>/, (_, attrs) => {
    const stripped = (attrs as string).replace(/\swidth="?\d+(?:\.\d+)?"?/g, "").replace(/\sheight="?\d+(?:\.\d+)?"?/g, "");
    return `<svg${stripped}>`;
  });

  const vueSfc = `<template>
  <svg :width="size" :height="size" v-bind="$attrs">${stripSvgWrapper(propsified)}</svg>
</template>

<script setup lang="ts">
defineProps<{ size?: number | string }>();
</script>
`;
  const svelte = `<script lang="ts">
  export let size: number | string = 24;
</script>

<svg width={size} height={size} {...$$restProps}>${stripSvgWrapper(propsified)}</svg>
`;

  const fileRefs: FileRef[] = [];
  const vuePath = join(ctx.scratchDir, `${componentName}.vue`);
  await writeFile(vuePath, vueSfc, "utf8");
  fileRefs.push({ ref: `${componentName}.vue`, bytes: Buffer.byteLength(vueSfc, "utf8"), sha256: "", mime: "text/x-vue", filename: `${componentName}.vue` });
  const sveltePath = join(ctx.scratchDir, `${componentName}.svelte`);
  await writeFile(sveltePath, svelte, "utf8");
  fileRefs.push({ ref: `${componentName}.svelte`, bytes: Buffer.byteLength(svelte, "utf8"), sha256: "", mime: "text/x-svelte", filename: `${componentName}.svelte` });

  return {
    ok: true,
    outputs: { componentName },
    fileRefs,
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function stripSvgWrapper(svg: string): string {
  const open = svg.indexOf(">");
  const close = svg.lastIndexOf("</svg>");
  if (open < 0 || close < 0) return svg;
  return svg.slice(open + 1, close);
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
