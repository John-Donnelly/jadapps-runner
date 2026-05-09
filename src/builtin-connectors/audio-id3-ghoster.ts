/**
 * audio-id3-ghoster: removes the ID3v2 tag block from an MP3 (commonly used
 * to "ghost" the file's metadata before sharing). ID3v2 starts with the
 * literal bytes "ID3" at offset 0; the next 4 bytes encode the tag size
 * (synchsafe integer). We rewrite the file without that prefix.
 *
 * Also strips a trailing ID3v1 tag (the last 128 bytes if they begin with
 * "TAG") when `stripV1` is true (default).
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

export default async function audioId3Ghoster(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "audio-id3-ghoster requires one MP3 input");

  const cfg = ctx.inputs ?? {};
  const stripV1 = cfg.stripV1 !== false;

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  let bodyStart = 0;
  let v2Bytes = 0;
  if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const tagSize = synchsafeToUint(buf.subarray(6, 10));
    bodyStart = 10 + tagSize;
    v2Bytes = bodyStart;
  }

  let bodyEnd = buf.length;
  let v1Bytes = 0;
  if (stripV1 && buf.length >= 128) {
    const tail = buf.subarray(buf.length - 128, buf.length - 125);
    if (tail[0] === 0x54 && tail[1] === 0x41 && tail[2] === 0x47) {
      bodyEnd = buf.length - 128;
      v1Bytes = 128;
    }
  }

  const out = buf.subarray(bodyStart, bodyEnd);
  const outRef = `ghosted-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out);

  return {
    ok: true,
    outputs: { id3v2BytesRemoved: v2Bytes, id3v1BytesRemoved: v1Bytes, originalBytes: totalIn, outputBytes: out.length },
    fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "audio/mpeg", filename: ref.filename ?? "ghosted.mp3" }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function synchsafeToUint(buf: Buffer): number {
  // Each byte uses the bottom 7 bits; high bit is always 0.
  return ((buf[0] ?? 0) << 21) | ((buf[1] ?? 0) << 14) | ((buf[2] ?? 0) << 7) | (buf[3] ?? 0);
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
