/**
 * archive-format-converter: dispatches between zip <-> tar.gz formats
 * based on the `targetFormat` input. Other targets (7z, rar) report
 * driver_missing.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function archiveFormatConverter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "archive-format-converter requires one archive input");

  const cfg = ctx.inputs ?? {};
  const target = String(cfg.targetFormat ?? "zip").toLowerCase();
  if (!["zip", "tar.gz", "tgz", "7z", "rar"].includes(target)) {
    return errorResult("invalid_input", `unsupported targetFormat: ${target}`);
  }
  if (target === "7z" || target === "rar") {
    return errorResult("driver_missing", `${target} conversion requires the native ${target} binary`);
  }

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const sourceFormat = detectFormat(buf, ref.filename ?? ref.ref);
  ctx.emitProgress(totalIn);

  let outBuf: Buffer;
  let outRef: string;
  let outMime: string;

  if (sourceFormat === "zip" && (target === "tar.gz" || target === "tgz")) {
    const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
    const tarChunks: Buffer[] = [];
    for (const [path, file] of Object.entries(zip.files)) {
      if (file.dir) continue;
      const data = await file.async("nodebuffer");
      tarChunks.push(makeTarHeader(path, data.length), data);
      const pad = 512 - (data.length % 512);
      if (pad < 512) tarChunks.push(Buffer.alloc(pad));
    }
    tarChunks.push(Buffer.alloc(1024));
    outBuf = gzipSync(Buffer.concat(tarChunks));
    outRef = (ref.filename ?? ref.ref).replace(/\.zip$/i, ".tar.gz");
    outMime = "application/gzip";
  } else if (sourceFormat === "tar.gz" && target === "zip") {
    const tarBuf = gunzipSync(buf);
    const zip = new (JSZip as unknown as new () => import("jszip"))();
    let pos = 0;
    while (pos < tarBuf.length - 512) {
      const header = tarBuf.subarray(pos, pos + 512);
      if (header[0] === 0) break;
      const name = readCString(header.subarray(0, 100));
      const size = parseInt(readCString(header.subarray(124, 136)).trim(), 8) || 0;
      pos += 512;
      if (name && size > 0) zip.file(name, tarBuf.subarray(pos, pos + size));
      pos += Math.ceil(size / 512) * 512;
    }
    outBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    outRef = (ref.filename ?? ref.ref).replace(/\.(tar\.gz|tgz)$/i, ".zip");
    outMime = "application/zip";
  } else {
    return errorResult("invalid_input", `cannot convert ${sourceFormat} to ${target}`);
  }

  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, outBuf);

  return {
    ok: true,
    outputs: { sourceFormat, targetFormat: target, inputBytes: buf.length, outputBytes: outBuf.length },
    fileRefs: [{ ref: outRef, bytes: outBuf.length, sha256: "", mime: outMime, filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function detectFormat(buf: Buffer, name: string): string {
  if (buf[0] === 0x50 && buf[1] === 0x4b) return "zip";
  if (buf[0] === 0x1f && buf[1] === 0x8b) return "tar.gz";
  if (/\.tar\.gz$|\.tgz$/i.test(name)) return "tar.gz";
  if (/\.zip$/i.test(name)) return "zip";
  return "unknown";
}

function makeTarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 100, "utf8");
  h.write("0000644", 100, 7, "ascii");
  h.write("0000000", 108, 7, "ascii");
  h.write("0000000", 116, 7, "ascii");
  h.write(size.toString(8).padStart(11, "0"), 124, 11, "ascii");
  h.write("00000000000", 136, 11, "ascii");
  h.write("        ", 148, 8, "ascii");
  h.write("0", 156, 1, "ascii");
  h.write("ustar  ", 257, 7, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i] ?? 0;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

function readCString(b: Buffer): string {
  const nul = b.indexOf(0);
  return b.subarray(0, nul === -1 ? b.length : nul).toString("utf8");
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
