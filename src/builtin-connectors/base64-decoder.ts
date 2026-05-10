/**
 * base64-decoder: decodes a base64 (or data:URI) string back to its
 * binary image. Auto-detects MIME from data URI prefix.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function base64Decoder(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const input = String(cfg.base64 ?? "");
  if (!input) return errorResult("missing_input", "base64-decoder requires `base64` input");

  const dataUriMatch = /^data:([^;,]+);base64,(.+)$/.exec(input.trim());
  const mime = dataUriMatch ? dataUriMatch[1]! : String(cfg.mime ?? "image/png");
  const b64 = dataUriMatch ? dataUriMatch[2]! : input.trim();
  const buf = Buffer.from(b64, "base64");

  const ext = mime.split("/")[1]?.split("+")[0] ?? "bin";
  const outRef = `decoded.${ext}`;
  await writeFile(join(ctx.scratchDir, outRef), buf);
  ctx.emitProgress(buf.length);
  return { ok: true, outputs: { mime, decodedBytes: buf.length, base64Bytes: b64.length }, fileRefs: [{ ref: outRef, bytes: buf.length, sha256: "", mime, filename: outRef }], bytesProcessed: buf.length, durationMs: Date.now() - start };
}

function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
