/**
 * image-steganography: embeds a short message into the LSB of an image's
 * RGB channels and outputs PNG. Supports both encode and decode modes.
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

export default async function imageSteganography(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "image-steganography requires one image input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const mode = cfg.mode === "decode" ? "decode" : "encode";
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const factory = sharp as unknown as (b: Buffer | object, o?: object) => {
    raw(): { toBuffer(o: { resolveWithObject: boolean }): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }> };
    png(): { toBuffer(): Promise<Buffer> };
  };
  const { data, info } = await factory(buf).raw().toBuffer({ resolveWithObject: true });

  if (mode === "encode") {
    const message = String(cfg.message ?? "");
    if (!message) return errorResult("invalid_input", "encode requires `message` input");
    const messageBytes = Buffer.from(message, "utf8");
    const lengthHeader = Buffer.alloc(4);
    lengthHeader.writeUInt32BE(messageBytes.length, 0);
    const payload = Buffer.concat([lengthHeader, messageBytes]);
    const totalBits = payload.length * 8;
    if (totalBits > data.length / info.channels * 3) return errorResult("payload_too_large", "image is too small to hold the message");
    let bitIndex = 0;
    for (let p = 0; p < data.length && bitIndex < totalBits; p += info.channels) {
      for (let ch = 0; ch < 3 && bitIndex < totalBits; ch++) {
        const byte = payload[Math.floor(bitIndex / 8)]!;
        const bit = (byte >> (7 - (bitIndex % 8))) & 1;
        data[p + ch] = (data[p + ch]! & 0xFE) | bit;
        bitIndex += 1;
      }
    }
    const factory2 = sharp as unknown as (b: Buffer, o: { raw: { width: number; height: number; channels: number } }) => { png(): { toBuffer(): Promise<Buffer> } };
    const out = await factory2(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
    const outRef = "stego.png";
    await writeFile(join(ctx.scratchDir, outRef), out);
    return { ok: true, outputs: { mode, messageBytes: messageBytes.length, capacityBytes: Math.floor(data.length / info.channels * 3 / 8) - 4 }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "image/png", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
  }

  // decode
  const headerBits: number[] = [];
  for (let p = 0, bi = 0; p < data.length && bi < 32; p += info.channels) {
    for (let ch = 0; ch < 3 && bi < 32; ch++) { headerBits.push(data[p + ch]! & 1); bi += 1; }
  }
  let len = 0;
  for (let i = 0; i < 32; i++) len = (len << 1) | (headerBits[i] ?? 0);
  if (len < 0 || len > 1 << 20) return errorResult("decode_failed", `recovered message length is implausible (${len})`);
  const messageBits: number[] = [];
  for (let p = 0, bi = 0; p < data.length && bi < 32 + len * 8; p += info.channels) {
    for (let ch = 0; ch < 3 && bi < 32 + len * 8; ch++) {
      if (bi >= 32) messageBits.push(data[p + ch]! & 1);
      bi += 1;
    }
  }
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    let b = 0;
    for (let bit = 0; bit < 8; bit++) b = (b << 1) | (messageBits[i * 8 + bit] ?? 0);
    out[i] = b;
  }
  const message = out.toString("utf8");
  const json = JSON.stringify({ mode, message }, null, 2);
  const outRef = "stego-decoded.json";
  await writeFile(join(ctx.scratchDir, outRef), json, "utf8");
  return { ok: true, outputs: { mode, message }, fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(json, "utf8"), sha256: "", mime: "application/json", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
