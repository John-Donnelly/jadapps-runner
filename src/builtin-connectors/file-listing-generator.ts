/**
 * file-listing-generator: produces a flat text listing of the files in an
 * archive. Format options: "tree" (indented tree view), "csv" (one CSV
 * row per entry), "manifest" (one line per file with size + sha256 if
 * computeChecksums=true).
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function fileListingGenerator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "file-listing-generator requires one archive input");
  const cfg = ctx.inputs ?? {};
  const format = ["tree", "csv", "manifest"].includes(cfg.format as string) ? cfg.format as string : "manifest";
  const computeChecksums = cfg.computeChecksums === true;

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
  ctx.emitProgress(totalIn);

  const entries: { path: string; size: number; sha256?: string }[] = [];
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    let size = ((file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize) ?? 0;
    const entry: { path: string; size: number; sha256?: string } = { path, size };
    if (computeChecksums) {
      const data = await file.async("nodebuffer");
      entry.size = data.length;
      entry.sha256 = createHash("sha256").update(data).digest("hex");
    }
    entries.push(entry);
  }

  let body: string;
  if (format === "csv") {
    body = "path,size" + (computeChecksums ? ",sha256" : "") + "\n" +
      entries.map((e) => `"${e.path.replace(/"/g, '""')}",${e.size}` + (e.sha256 ? `,${e.sha256}` : "")).join("\n") + "\n";
  } else if (format === "tree") {
    body = renderTree(entries.map((e) => e.path));
  } else {
    body = entries.map((e) => `${e.size.toString().padStart(10)}  ${e.sha256 ? e.sha256.slice(0, 16) + "  " : ""}${e.path}`).join("\n") + "\n";
  }

  const outRef = `listing.${format === "csv" ? "csv" : "txt"}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, body, "utf8");

  return {
    ok: true,
    outputs: { format, fileCount: entries.length, computeChecksums },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(body, "utf8"), sha256: "", mime: format === "csv" ? "text/csv" : "text/plain", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function renderTree(paths: string[]): string {
  const root: Record<string, unknown> = {};
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    let cursor = root;
    for (const part of parts) {
      cursor[part] = cursor[part] ?? {};
      cursor = cursor[part] as Record<string, unknown>;
    }
  }
  const lines: string[] = [];
  const walk = (node: Record<string, unknown>, depth: number) => {
    for (const [name, child] of Object.entries(node)) {
      lines.push("  ".repeat(depth) + name);
      if (child && typeof child === "object" && Object.keys(child as object).length > 0) {
        walk(child as Record<string, unknown>, depth + 1);
      }
    }
  };
  walk(root, 0);
  return lines.join("\n") + "\n";
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
