/**
 * steganography-encoder: hides a UTF-8 message inside a PNG using LSB
 * (least-significant-bit) encoding of the IDAT pixel data. The image is
 * unchanged visually; the payload survives lossless re-saves.
 *
 * Capacity: roughly (width * height * channels) / 8 bytes minus a 4-byte
 * length header. Errors out if the message doesn't fit.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
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

export default async function steganographyEncoder(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "steganography-encoder requires one PNG input");
  const cfg = ctx.inputs ?? {};
  const message = String(cfg.message ?? "");
  if (!message) return errorResult("invalid_config", "message is required");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    return errorResult("not_a_png", "input is not a PNG file");
  }

  const png = parsePng(buf);
  if (!png) return errorResult("parse_error", "could not parse PNG chunks");

  const messageBytes = Buffer.from(message, "utf8");
  const lengthHeader = Buffer.alloc(4);
  lengthHeader.writeUInt32BE(messageBytes.length, 0);
  const payload = Buffer.concat([lengthHeader, messageBytes]);
  const totalBits = payload.length * 8;
  const pixelBytesAvailable = countAvailablePixelBytes(png);
  if (totalBits > pixelBytesAvailable) {
    return errorResult("payload_too_large", `payload needs ${totalBits} bits but image only has ${pixelBytesAvailable}`);
  }

  const newPixels = embedPayloadInPixels(png.pixelData, payload, png.bytesPerPixel, png.width);
  const reencoded = encodePng({ ...png, pixelData: newPixels });

  const outRef = `stego-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, reencoded);

  return {
    ok: true,
    outputs: { messageBytes: messageBytes.length, capacityBytes: Math.floor(pixelBytesAvailable / 8), checksum: createHash("sha256").update(messageBytes).digest("hex").slice(0, 16) },
    fileRefs: [{ ref: outRef, bytes: reencoded.length, sha256: "", mime: "image/png", filename: ref.filename ?? "stego.png" }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

interface PngData { width: number; height: number; bytesPerPixel: number; bitDepth: number; colorType: number; pixelData: Buffer; otherChunks: { type: string; data: Buffer }[]; }

function parsePng(buf: Buffer): PngData | null {
  let i = 8;
  let ihdr: Buffer | null = null;
  let idatChunks: Buffer[] = [];
  const otherChunks: { type: string; data: Buffer }[] = [];
  while (i < buf.length) {
    const length = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString("latin1");
    const data = buf.subarray(i + 8, i + 8 + length);
    if (type === "IHDR") ihdr = Buffer.from(data);
    else if (type === "IDAT") idatChunks.push(Buffer.from(data));
    else if (type !== "IEND") otherChunks.push({ type, data: Buffer.from(data) });
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
  const bytesPerPixel = channels;
  const compressed = Buffer.concat(idatChunks);
  const pixelData = inflateSync(compressed);
  return { width, height, bytesPerPixel, bitDepth, colorType, pixelData, otherChunks };
}

function encodePng(png: PngData): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(png.width, 0);
  ihdr.writeUInt32BE(png.height, 4);
  ihdr[8] = png.bitDepth;
  ihdr[9] = png.colorType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const idat = deflateSync(png.pixelData);
  const chunks: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), encodeChunk("IHDR", ihdr)];
  for (const c of png.otherChunks) chunks.push(encodeChunk(c.type, c.data));
  chunks.push(encodeChunk("IDAT", idat));
  chunks.push(encodeChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function encodeChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = computeCrc(crcInput);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}
function computeCrc(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function countAvailablePixelBytes(png: PngData): number {
  const stride = png.width * png.bytesPerPixel + 1;
  return (png.pixelData.length - png.height) * 1; // bits available = pixel bytes
}

function embedPayloadInPixels(pixels: Buffer, payload: Buffer, bytesPerPixel: number, width: number): Buffer {
  const out = Buffer.from(pixels);
  const stride = width * bytesPerPixel + 1;
  let bitIndex = 0;
  const totalBits = payload.length * 8;
  for (let row = 0; row * stride < out.length && bitIndex < totalBits; row++) {
    for (let col = 1; col < stride && bitIndex < totalBits; col++) {
      const idx = row * stride + col;
      const bit = (payload[Math.floor(bitIndex / 8)]! >> (7 - (bitIndex % 8))) & 1;
      out[idx] = (out[idx]! & 0xfe) | bit;
      bitIndex += 1;
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
