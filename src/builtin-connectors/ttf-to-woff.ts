/**
 * ttf-to-woff: converts a TTF/OTF font into WOFF format. WOFF is just
 * a deflate-compressed wrapper around the font tables; we use a pure-JS
 * approach via `wawoff2` if available, otherwise driver_missing.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function ttfToWoff(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "ttf-to-woff requires one TTF/OTF input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const ttf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const woff = wrapWoff(ttf);
  const outRef = (ref.filename ?? ref.ref).replace(/\.(ttf|otf)$/i, ".woff");
  await writeFile(join(ctx.scratchDir, outRef), woff);

  return {
    ok: true,
    outputs: { ttfBytes: ttf.length, woffBytes: woff.length, ratio: woff.length / ttf.length },
    fileRefs: [{ ref: outRef, bytes: woff.length, sha256: "", mime: "font/woff", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function wrapWoff(ttf: Buffer): Buffer {
  const sfntVersion = ttf.readUInt32BE(0);
  const numTables = ttf.readUInt16BE(4);
  const headerSize = 12 + numTables * 16;
  const woffHeaderSize = 44;
  const newDirOffset = woffHeaderSize;

  const tables: { tag: number; origOffset: number; origLength: number; compressed: Buffer; comprOffset: number }[] = [];
  let comprOffset = newDirOffset + numTables * 20;
  for (let i = 0; i < numTables; i++) {
    const recOff = 12 + i * 16;
    const tag = ttf.readUInt32BE(recOff);
    const origOffset = ttf.readUInt32BE(recOff + 8);
    const origLength = ttf.readUInt32BE(recOff + 12);
    const tableData = ttf.subarray(origOffset, origOffset + origLength);
    const compressed = deflateRawSync(tableData);
    const useCompressed = compressed.length < origLength;
    const stored = useCompressed ? compressed : tableData;
    tables.push({ tag, origOffset, origLength, compressed: stored, comprOffset });
    comprOffset += stored.length;
    if (comprOffset % 4 !== 0) comprOffset += 4 - (comprOffset % 4);
  }

  const totalSize = comprOffset;
  const out = Buffer.alloc(totalSize);
  out.write("wOFF", 0, 4, "ascii");
  out.writeUInt32BE(sfntVersion, 4);
  out.writeUInt32BE(totalSize, 8);
  out.writeUInt16BE(numTables, 12);
  out.writeUInt16BE(0, 14);
  out.writeUInt32BE(ttf.length, 16);
  out.writeUInt16BE(0x0001, 20);
  out.writeUInt16BE(0x0000, 22);

  let dirOff = newDirOffset;
  for (const t of tables) {
    out.writeUInt32BE(t.tag, dirOff);
    out.writeUInt32BE(t.comprOffset, dirOff + 4);
    out.writeUInt32BE(t.compressed.length, dirOff + 8);
    out.writeUInt32BE(t.origLength, dirOff + 12);
    out.writeUInt32BE(0, dirOff + 16);
    t.compressed.copy(out, t.comprOffset);
    dirOff += 20;
  }
  void headerSize;
  return out;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
