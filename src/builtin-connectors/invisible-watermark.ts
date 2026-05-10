/**
 * invisible-watermark: embeds a short identifier into the LSB of the
 * image's blue channel — invisible to the eye but recoverable. Light
 * cousin of image-steganography for ownership tagging.
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

export default async function invisibleWatermark(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "invisible-watermark requires one image input");
  let sharp: typeof import("sharp");
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); }
  catch (err) { return errorResult("driver_missing", `sharp not installed: ${(err as Error).message}`); }
  const cfg = ctx.inputs ?? {};
  const message = String(cfg.identifier ?? cfg.message ?? "");
  if (!message) return errorResult("invalid_input", "invisible-watermark requires `identifier` input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const factory = sharp as unknown as (b: Buffer, o?: object) => {
    raw(): { toBuffer(o: { resolveWithObject: boolean }): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }> };
  };
  const { data, info } = await factory(buf).raw().toBuffer({ resolveWithObject: true });

  const messageBytes = Buffer.from(message, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(messageBytes.length, 0);
  const payload = Buffer.concat([header, messageBytes]);
  const totalBits = payload.length * 8;
  const capacityBits = Math.floor(data.length / info.channels);
  if (totalBits > capacityBits) return errorResult("payload_too_large", "image is too small to hold the watermark");

  for (let bit = 0; bit < totalBits; bit++) {
    const byte = payload[Math.floor(bit / 8)]!;
    const b = (byte >> (7 - (bit % 8))) & 1;
    const px = bit * info.channels + 2; // blue channel
    if (px < data.length) data[px] = (data[px]! & 0xFE) | b;
  }

  const factory2 = sharp as unknown as (b: Buffer, o: { raw: { width: number; height: number; channels: number } }) => { png(): { toBuffer(): Promise<Buffer> } };
  const out = await factory2(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
  const outRef = (ref.filename ?? ref.ref).replace(/(\.[^.]+)?$/, ".watermarked.png");
  await writeFile(join(ctx.scratchDir, outRef), out);
  return { ok: true, outputs: { identifier: message, identifierBytes: messageBytes.length, capacityBytes: Math.floor(capacityBits / 8) - 4 }, fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "image/png", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
