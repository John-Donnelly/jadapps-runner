/**
 * zip-to-tar-gz: rewraps the contents of a ZIP archive into a tar.gz
 * (gzip-compressed tar). Preserves entry paths but resets timestamps
 * and permissions to safe defaults.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function zipToTarGz(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "zip-to-tar-gz requires one ZIP input");

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
  ctx.emitProgress(totalIn);

  const tarChunks: Buffer[] = [];
  let entryCount = 0;
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const data = await file.async("nodebuffer");
    tarChunks.push(buildTarHeader(path, data.length));
    tarChunks.push(data);
    const padding = 512 - (data.length % 512);
    if (padding < 512) tarChunks.push(Buffer.alloc(padding));
    entryCount += 1;
  }
  tarChunks.push(Buffer.alloc(1024)); // EOF marker

  const tarBuf = Buffer.concat(tarChunks);
  const gzBuf = gzipSync(tarBuf);
  const outRef = (ref.filename ?? ref.ref).replace(/\.zip$/i, ".tar.gz");
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, gzBuf);

  return {
    ok: true,
    outputs: { entryCount, tarBytes: tarBuf.length, gzipBytes: gzBuf.length },
    fileRefs: [{ ref: outRef, bytes: gzBuf.length, sha256: "", mime: "application/gzip", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function buildTarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 100, "utf8");
  header.write("0000644", 100, 7, "ascii"); // mode
  header.write("0000000", 108, 7, "ascii"); // uid
  header.write("0000000", 116, 7, "ascii"); // gid
  header.write(size.toString(8).padStart(11, "0"), 124, 11, "ascii");
  header.write("00000000000", 136, 11, "ascii"); // mtime (epoch)
  header.write("        ", 148, 8, "ascii"); // checksum placeholder
  header.write("0", 156, 1, "ascii"); // typeflag = regular file
  header.write("ustar  ", 257, 7, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i] ?? 0;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
