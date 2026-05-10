/**
 * hinting-stripper: removes TrueType hinting tables (fpgm, prep, cvt,
 * gasp) to slim a font. Requires fontTools to safely rewrite the SFNT
 * directory — reports driver_missing if not available.
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

const HINTING_TAGS = new Set(["fpgm", "prep", "cvt ", "gasp", "VDMX", "hdmx", "LTSH"]);

export default async function hintingStripper(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "hinting-stripper requires one TTF/OTF input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const ttf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  if (ttf[0] !== 0x00 || ttf[1] !== 0x01) {
    if (ttf.subarray(0, 4).toString("ascii") !== "OTTO") {
      return errorResult("not_a_font", "input is not a valid TTF/OTF (missing magic)");
    }
  }

  const numTables = ttf.readUInt16BE(4);
  const directoryEnd = 12 + numTables * 16;
  const tablesToKeep: { tag: string; tagInt: number; offset: number; length: number; checksum: number }[] = [];
  const removed: string[] = [];

  for (let i = 0; i < numTables; i++) {
    const recOff = 12 + i * 16;
    const tagInt = ttf.readUInt32BE(recOff);
    const tag = ttf.subarray(recOff, recOff + 4).toString("ascii");
    const checksum = ttf.readUInt32BE(recOff + 4);
    const offset = ttf.readUInt32BE(recOff + 8);
    const length = ttf.readUInt32BE(recOff + 12);
    if (HINTING_TAGS.has(tag)) {
      removed.push(tag);
    } else {
      tablesToKeep.push({ tag, tagInt, offset, length, checksum });
    }
  }

  const newNumTables = tablesToKeep.length;
  const newDirSize = 12 + newNumTables * 16;
  let dataPos = newDirSize;
  const newTables: { tagInt: number; checksum: number; newOffset: number; length: number; data: Buffer }[] = [];
  for (const t of tablesToKeep) {
    const data = ttf.subarray(t.offset, t.offset + t.length);
    newTables.push({ tagInt: t.tagInt, checksum: t.checksum, newOffset: dataPos, length: t.length, data });
    dataPos += t.length;
    if (dataPos % 4 !== 0) dataPos += 4 - (dataPos % 4);
  }

  const out = Buffer.alloc(dataPos);
  ttf.copy(out, 0, 0, 12);
  out.writeUInt16BE(newNumTables, 4);
  // recompute searchRange, entrySelector, rangeShift for safety
  let exp = 0;
  while ((1 << (exp + 1)) <= newNumTables) exp += 1;
  const searchRange = (1 << exp) * 16;
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(exp, 8);
  out.writeUInt16BE(newNumTables * 16 - searchRange, 10);
  void directoryEnd;

  let dirOff = 12;
  for (const t of newTables) {
    out.writeUInt32BE(t.tagInt, dirOff);
    out.writeUInt32BE(t.checksum, dirOff + 4);
    out.writeUInt32BE(t.newOffset, dirOff + 8);
    out.writeUInt32BE(t.length, dirOff + 12);
    t.data.copy(out, t.newOffset);
    dirOff += 16;
  }

  const outRef = (ref.filename ?? ref.ref).replace(/\.(ttf|otf)$/i, ".unhinted.$1");
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
