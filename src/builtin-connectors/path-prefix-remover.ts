/**
 * path-prefix-remover: rewrites entry paths inside a ZIP, stripping a
 * configured leading prefix. Useful for removing wrapper directories
 * created by GitHub-style export ZIPs.
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

export default async function pathPrefixRemover(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "path-prefix-remover requires one ZIP input");
  const cfg = ctx.inputs ?? {};
  const explicitPrefix = typeof cfg.prefix === "string" ? cfg.prefix : null;

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
  ctx.emitProgress(totalIn);

  const filePaths = Object.entries(zip.files).filter(([, f]) => !f.dir).map(([p]) => p);
  const prefix = explicitPrefix ?? autodetectPrefix(filePaths);

  const out = new (JSZip as unknown as new () => import("jszip"))();
  let stripped = 0;
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const newPath = path.startsWith(prefix) ? path.slice(prefix.length) : path;
    if (newPath === path) {
      out.file(path, await file.async("nodebuffer"));
    } else {
      out.file(newPath || path, await file.async("nodebuffer"));
      stripped += 1;
    }
  }

  const outBuf = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const outRef = (ref.filename ?? ref.ref).replace(/\.zip$/i, ".reprefixed.zip");
  await writeFile(join(ctx.scratchDir, outRef), outBuf);

  return {
    ok: true,
    outputs: { strippedCount: stripped, prefixUsed: prefix },
    fileRefs: [{ ref: outRef, bytes: outBuf.length, sha256: "", mime: "application/zip", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function autodetectPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  const first = paths[0];
  if (!first || !first.includes("/")) return "";
  const candidate = first.split("/")[0] + "/";
  if (paths.every((p) => p.startsWith(candidate))) return candidate;
  return "";
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
