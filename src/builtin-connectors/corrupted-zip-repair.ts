/**
 * corrupted-zip-repair: best-effort recovery of a damaged ZIP. Walks
 * local file headers (skipping the central directory) and re-packs every
 * entry whose compressed payload still inflates cleanly.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function corruptedZipRepair(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "corrupted-zip-repair requires one ZIP input");

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const out = new (JSZip as unknown as new () => import("jszip"))();
  let recovered = 0;
  let skipped = 0;
  let i = 0;
  while (i < buf.length - 30) {
    if (buf[i] !== 0x50 || buf[i + 1] !== 0x4b || buf[i + 2] !== 0x03 || buf[i + 3] !== 0x04) {
      i += 1;
      continue;
    }
    const compression = buf.readUInt16LE(i + 8);
    const compressedSize = buf.readUInt32LE(i + 18);
    const uncompressedSize = buf.readUInt32LE(i + 22);
    const filenameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const headerEnd = i + 30 + filenameLen + extraLen;
    const name = buf.subarray(i + 30, i + 30 + filenameLen).toString("utf8");
    const dataStart = headerEnd;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length || compressedSize === 0 || !name) {
      skipped += 1;
      i = headerEnd;
      continue;
    }
    const payload = buf.subarray(dataStart, dataEnd);
    try {
      let decoded: Buffer;
      if (compression === 0) decoded = Buffer.from(payload);
      else if (compression === 8) decoded = inflateRawSync(payload);
      else { skipped += 1; i = dataEnd; continue; }
      if (uncompressedSize > 0 && decoded.length !== uncompressedSize) {
        skipped += 1;
      } else {
        out.file(name, decoded);
        recovered += 1;
      }
    } catch {
      skipped += 1;
    }
    i = dataEnd;
  }

  const repaired = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const outRef = (ref.filename ?? ref.ref).replace(/\.zip$/i, ".repaired.zip");
  await writeFile(join(ctx.scratchDir, outRef), repaired);

  return {
    ok: true,
    outputs: { recoveredEntries: recovered, skippedEntries: skipped },
    fileRefs: [{ ref: outRef, bytes: repaired.length, sha256: "", mime: "application/zip", filename: outRef }],
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
