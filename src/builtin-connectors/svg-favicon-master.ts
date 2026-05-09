/**
 * svg-favicon-master: emits the standard favicon set from a single SVG —
 * 16/32/48 ICO sizes, 180px Apple touch icon, 192/512 PWA manifests, plus
 * the SVG itself. Optionally writes a manifest.json + HTML snippet.
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

export default async function svgFaviconMaster(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "svg-favicon-master requires one SVG input");
  const cfg = ctx.inputs ?? {};
  const themeColor = String(cfg.themeColor ?? "#4F46E5");
  const appName = String(cfg.appName ?? "App");

  let sharpMod: typeof import("sharp");
  try { sharpMod = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const sharp = sharpMod as unknown as (input: Buffer, options?: { density?: number }) => import("sharp").Sharp;

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const fileRefs: FileRef[] = [];
  const sizes = [16, 32, 48, 96, 180, 192, 512];
  for (const size of sizes) {
    const out = await sharp(buf, { density: 384 }).resize({ width: size, height: size, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const name = size === 180 ? "apple-touch-icon.png" : `favicon-${size}.png`;
    const outPath = join(ctx.scratchDir, name);
    await writeFile(outPath, out);
    fileRefs.push({ ref: name, bytes: out.length, sha256: "", mime: "image/png", filename: name });
  }

  // Copy the SVG into the bundle as `favicon.svg`.
  const svgRef = "favicon.svg";
  const svgPath = join(ctx.scratchDir, svgRef);
  await writeFile(svgPath, buf);
  fileRefs.push({ ref: svgRef, bytes: buf.length, sha256: "", mime: "image/svg+xml", filename: svgRef });

  // Manifest + HTML snippet.
  const manifest = {
    name: appName,
    short_name: appName.slice(0, 12),
    icons: [
      { src: "favicon-192.png", sizes: "192x192", type: "image/png" },
      { src: "favicon-512.png", sizes: "512x512", type: "image/png" },
    ],
    theme_color: themeColor,
    background_color: "#ffffff",
    display: "standalone",
  };
  const manifestRef = "manifest.json";
  await writeFile(join(ctx.scratchDir, manifestRef), JSON.stringify(manifest, null, 2), "utf8");
  fileRefs.push({ ref: manifestRef, bytes: 0, sha256: "", mime: "application/json", filename: manifestRef });

  const snippet = `<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n<link rel="alternate icon" href="/favicon-32.png" sizes="32x32">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n<meta name="theme-color" content="${themeColor}">\n<link rel="manifest" href="/manifest.json">\n`;
  const snippetRef = "head-snippet.html";
  await writeFile(join(ctx.scratchDir, snippetRef), snippet, "utf8");
  fileRefs.push({ ref: snippetRef, bytes: Buffer.byteLength(snippet, "utf8"), sha256: "", mime: "text/html", filename: snippetRef });

  return {
    ok: true,
    outputs: { sizes, themeColor, appName },
    fileRefs,
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
