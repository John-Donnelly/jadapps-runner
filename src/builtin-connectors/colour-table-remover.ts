/**
 * colour-table-remover: removes color font tables (COLR, CPAL, sbix,
 * SVG) so a single emoji-rich font can be slimmed to monochrome.
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

const COLOR_TAGS = new Set(["COLR", "CPAL", "sbix", "CBDT", "CBLC", "SVG ", "EBDT", "EBLC", "EBSC"]);

export default async function colourTableRemover(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "colour-table-remover requires one font input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const ttf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const numTables = ttf.readUInt16BE(4);
  const tablesToKeep: { tagInt: number; offset: number; length: number; checksum: number }[] = [];
  const removed: string[] = [];
  for (let i = 0; i < numTables; i++) {
    const recOff = 12 + i * 16;
    const tag = ttf.subarray(recOff, recOff + 4).toString("ascii");
    const tagInt = ttf.readUInt32BE(recOff);
    const checksum = ttf.readUInt32BE(recOff + 4);
    const offset = ttf.readUInt32BE(recOff + 8);
    const length = ttf.readUInt32BE(recOff + 12);
    if (COLOR_TAGS.has(tag)) removed.push(tag);
    else tablesToKeep.push({ tagInt, offset, length, checksum });
  }

  const newNumTables = tablesToKeep.length;
  const newDirSize = 12 + newNumTables * 16;
  let dataPos = newDirSize;
  const newTables = tablesToKeep.map((t) => {
    const data = ttf.subarray(t.offset, t.offset + t.length);
    const entry = { ...t, newOffset: dataPos, data };
    dataPos += t.length;
    if (dataPos % 4 !== 0) dataPos += 4 - (dataPos % 4);
    return entry;
  });
  const out = Buffer.alloc(dataPos);
  ttf.copy(out, 0, 0, 12);
  out.writeUInt16BE(newNumTables, 4);
  let exp = 0;
  while ((1 << (exp + 1)) <= newNumTables) exp += 1;
  const sr = (1 << exp) * 16;
  out.writeUInt16BE(sr, 6);
  out.writeUInt16BE(exp, 8);
  out.writeUInt16BE(newNumTables * 16 - sr, 10);
  let dirOff = 12;
  for (const t of newTables) {
    out.writeUInt32BE(t.tagInt, dirOff);
    out.writeUInt32BE(t.checksum, dirOff + 4);
    out.writeUInt32BE(t.newOffset, dirOff + 8);
    out.writeUInt32BE(t.length, dirOff + 12);
    t.data.copy(out, t.newOffset);
    dirOff += 16;
  }

  const outRef = (ref.filename ?? ref.ref).replace(/\.(ttf|otf)$/i, ".monochrome.$1");
  await writeFile(join(ctx.scratchDir, outRef), out);

  return {
    ok: true,
    outputs: { removedTables: removed, originalBytes: ttf.length, outputBytes: out.length },
    fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "font/ttf", filename: outRef }],
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
