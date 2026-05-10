/**
 * selective-extractor: extracts only the entries from an archive whose
 * paths match `includePatterns` (glob-like) and don't match
 * `excludePatterns`. Wildcards: * matches anything-but-/, ** matches across
 * slashes, ? matches one char.
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

export default async function selectiveExtractor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "selective-extractor requires one archive input");
  const cfg = ctx.inputs ?? {};
  const include = parseList(cfg.includePatterns).length > 0 ? parseList(cfg.includePatterns) : ["**"];
  const exclude = parseList(cfg.excludePatterns);

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
  ctx.emitProgress(totalIn);

  const includeRes = include.map(globToRegex);
  const excludeRes = exclude.map(globToRegex);
  const fileRefs: FileRef[] = [];
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    if (!includeRes.some((re) => re.test(path))) continue;
    if (excludeRes.some((re) => re.test(path))) continue;
    const data = await file.async("nodebuffer");
    const safeName = path.replace(/[\\:]/g, "_");
    const outPath = join(ctx.scratchDir, safeName);
    await writeFile(outPath, data);
    fileRefs.push({ ref: safeName, bytes: data.length, sha256: "", mime: "application/octet-stream", filename: path });
  }

  return {
    ok: true,
    outputs: { extractedCount: fileRefs.length, includePatterns: include, excludePatterns: exclude },
    fileRefs,
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
  const pattern = escaped
    .replace(/\*\*/g, "::DOUBLESTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/::DOUBLESTAR::/g, ".*");
  return new RegExp(`^${pattern}$`);
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
