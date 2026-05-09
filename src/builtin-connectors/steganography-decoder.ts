/**
 * steganography-decoder: extracts a UTF-8 message previously embedded in a
 * PNG via LSB encoding. Reads the 4-byte length header from the first 32
 * pixel bytes, then the payload. Returns the decoded message and a sha256
 * of it so the caller can confirm round-trip integrity.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function steganographyDecoder(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "steganography-decoder requires one PNG input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    return errorResult("not_a_png", "input is not a PNG file");
  }

  const png = parsePng(buf);
  if (!png) return errorResult("parse_error", "could not parse PNG chunks");

  const stride = png.width * png.bytesPerPixel + 1;
  const lengthBits = readBits(png.pixelData, stride, 0, 32);
  const length = lengthBits.readUInt32BE(0);
  if (length === 0 || length > 1024 * 1024 * 16) {
    return errorResult("no_payload", "no plausible payload found (length looks corrupt)");
  }
  const payload = readBits(png.pixelData, stride, 32, length * 8);
  const message = payload.toString("utf8");

  const outRef = "decoded.txt";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, message, "utf8");

  return {
    ok: true,
    outputs: { messageBytes: length, message: message.length > 4096 ? message.slice(0, 4096) + "…" : message, checksum: createHash("sha256").update(payload).digest("hex").slice(0, 16) },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(message, "utf8"), sha256: "", mime: "text/plain", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

interface PngData { width: number; height: number; bytesPerPixel: number; pixelData: Buffer; }

function parsePng(buf: Buffer): PngData | null {
  let i = 8;
  let ihdr: Buffer | null = null;
  const idatChunks: Buffer[] = [];
  while (i < buf.length) {
    const length = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString("latin1");
    const data = buf.subarray(i + 8, i + 8 + length);
    if (type === "IHDR") ihdr = Buffer.from(data);
    else if (type === "IDAT") idatChunks.push(Buffer.from(data));
    if (type === "IEND") break;
    i += length + 12;
  }
  if (!ihdr) return null;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8]!;
  const colorType = ihdr[9]!;
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (channels === 0 || bitDepth !== 8) return null;
  const compressed = Buffer.concat(idatChunks);
  const pixelData = inflateSync(compressed);
  return { width, height, bytesPerPixel: channels, pixelData };
}

function readBits(pixels: Buffer, stride: number, bitOffset: number, bitCount: number): Buffer {
  const out = Buffer.alloc(Math.ceil(bitCount / 8));
  let bitIndex = 0;
  let pixelByteCount = 0;
  for (let row = 0; row * stride < pixels.length && bitIndex < bitCount; row++) {
    for (let col = 1; col < stride && bitIndex < bitCount; col++) {
      if (pixelByteCount < bitOffset) { pixelByteCount += 1; continue; }
      const idx = row * stride + col;
      const bit = pixels[idx]! & 1;
      out[Math.floor(bitIndex / 8)]! |= bit << (7 - (bitIndex % 8));
      bitIndex += 1;
      pixelByteCount += 1;
    }
  }
  return out;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
