/**
 * icon-font-previewer: renders an HTML grid of every glyph in an icon
 * font with its codepoint label, so designers can browse availability
 * without remembering hex codes.
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

export default async function iconFontPreviewer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "icon-font-previewer requires one font input");

  let fontkit: unknown;
  try {
    const fontkitMod = await import("@pdf-lib/fontkit");
    fontkit = (fontkitMod as unknown as { default?: unknown }).default ?? fontkitMod;
  } catch (err) {
    return errorResult("driver_missing", `@pdf-lib/fontkit not installed: ${(err as Error).message}`);
  }

  const cfg = ctx.inputs ?? {};
  const baseUrl = String(cfg.baseUrl ?? "");
  const family = String(cfg.family ?? "IconFont");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const font = (fontkit as { create(b: Buffer): { characterSet?: number[] } }).create(buf);
  const cps = (font.characterSet ?? []).filter((c) => c >= 0xE000 || (c >= 0x2600 && c <= 0x27BF));

  const cells = cps.slice(0, 4096).map((cp) => {
    const hex = cp.toString(16).toUpperCase();
    const ch = String.fromCodePoint(cp);
    return `<div style="border:1px solid #eee;padding:16px;text-align:center;"><div style="font-family:'${family}';font-size:48px;">${escapeHtml(ch)}</div><div style="font-family:monospace;font-size:11px;color:#888;margin-top:8px;">U+${hex}</div></div>`;
  }).join("\n");

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>@font-face { font-family: "${family}"; src: url("${baseUrl}${ref.filename ?? ref.ref}"); }</style></head><body style="padding:32px;"><h1 style="font-family:sans-serif;">Icon font preview — ${cps.length} icons</h1><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;">${cells}</div></body></html>`;

  const outRef = "icon-preview.html";
  await writeFile(join(ctx.scratchDir, outRef), html, "utf8");

  return {
    ok: true,
    outputs: { iconCount: cps.length, family },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(html, "utf8"), sha256: "", mime: "text/html", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
