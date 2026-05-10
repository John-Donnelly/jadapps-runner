/**
 * archive-previewer: lists the entries in a ZIP, tar, or tar.gz without
 * extracting. Returns name, size, compressed size, and modified timestamp.
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

interface Entry { name: string; size: number; compressedSize?: number; modified?: string; isDirectory: boolean; }

export default async function archivePreviewer(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "archive-previewer requires one archive input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const fmt = detectFormat(buf, ref.filename ?? "");
  let entries: Entry[];
  try {
    entries = fmt === "zip" ? await listZip(buf) : await listTar(buf, fmt === "tar-gz");
  } catch (err) {
    return errorResult("parse_error", `${fmt} parse failed: ${(err as Error).message}`);
  }

  const out = JSON.stringify({ format: fmt, totalEntries: entries.length, entries }, null, 2);
  const outRef = "preview.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { format: fmt, totalEntries: entries.length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function detectFormat(buf: Buffer, filename: string): "zip" | "tar" | "tar-gz" {
  if (buf[0] === 0x50 && buf[1] === 0x4b) return "zip";
  if (buf[0] === 0x1f && buf[1] === 0x8b) return "tar-gz";
  if (filename.endsWith(".tar")) return "tar";
  if (filename.endsWith(".tgz") || filename.endsWith(".tar.gz")) return "tar-gz";
  return "tar";
}

async function listZip(buf: Buffer): Promise<Entry[]> {
  const JSZipMod = await import("jszip");
  const JSZip = JSZipMod.default as unknown as typeof import("jszip");
  const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
  const out: Entry[] = [];
  zip.forEach((path, file) => {
    const entry: Entry = {
      name: path,
      size: ((file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize) ?? 0,
      isDirectory: file.dir,
    };
    const cs = (file as unknown as { _data?: { compressedSize?: number } })._data?.compressedSize;
    if (typeof cs === "number") entry.compressedSize = cs;
    if (file.date) entry.modified = file.date.toISOString();
    out.push(entry);
  });
  return out;
}

async function listTar(buf: Buffer, gzipped: boolean): Promise<Entry[]> {
  const tarMod = await import("tar");
  const out: Entry[] = [];
  const parser = new tarMod.Parser({ filter: () => true });
  parser.on("entry", (entry: { path: string; size: number; type: string; mtime: Date }) => {
    out.push({ name: entry.path, size: entry.size, modified: entry.mtime.toISOString(), isDirectory: entry.type === "Directory" });
    (entry as unknown as { resume(): void }).resume();
  });
  let stream: Buffer = buf;
  if (gzipped) {
    const zlib = await import("node:zlib");
    stream = zlib.gunzipSync(buf);
  }
  await new Promise<void>((resolve, reject) => {
    parser.on("end", () => resolve());
    parser.on("error", reject);
    parser.end(stream);
  });
  return out;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
