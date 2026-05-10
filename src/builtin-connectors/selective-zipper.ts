/**
 * selective-zipper: builds a ZIP that includes only the inputs whose
 * filename matches the include patterns and doesn't match the exclude
 * patterns. Same glob syntax as selective-extractor.
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

export default async function selectiveZipper(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "selective-zipper requires at least one input");
  }
  const cfg = ctx.inputs ?? {};
  const include = parseList(cfg.includePatterns).length > 0 ? parseList(cfg.includePatterns) : ["**"];
  const exclude = parseList(cfg.excludePatterns);

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const includeRes = include.map(globToRegex);
  const excludeRes = exclude.map(globToRegex);
  const zip = new (JSZip as unknown as new () => import("jszip"))();
  let totalIn = 0;
  let added = 0, skipped = 0;
  for (const ref of ctx.fileRefs) {
    const name = ref.filename ?? ref.ref;
    if (!includeRes.some((re) => re.test(name)) || excludeRes.some((re) => re.test(name))) {
      skipped += 1;
      continue;
    }
    const path = join(ctx.scratchDir, ref.ref);
    totalIn += sizeOrFallback(path, ref.bytes);
    const data = await readFile(path);
    zip.file(name, data);
    added += 1;
  }
  ctx.emitProgress(totalIn);

  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const outRef = "selected.zip";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, buf);

  return {
    ok: true,
    outputs: { added, skipped, includePatterns: include, excludePatterns: exclude },
    fileRefs: [{ ref: outRef, bytes: buf.length, sha256: "", mime: "application/zip", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function parseList(input: unknown): string[] {
  if (Array.isArray(input)) return input.map(String);
  if (typeof input === "string") return input.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\*\*/g, "::DOUBLESTAR::").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/::DOUBLESTAR::/g, ".*");
  return new RegExp(`^${pattern}$`);
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
