/**
 * magic-byte-validator: confirms a file's magic-byte signature matches its
 * advertised MIME type or extension. Returns ok=true when consistent, plus
 * the detected type. When the upload type is "spoofed" (e.g. .png file that
 * is actually a ZIP) this surfaces it.
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

const SIGNATURES: { mime: string; extensions: string[]; signatures: { offset: number; bytes: number[] }[] }[] = [
  { mime: "application/pdf", extensions: ["pdf"], signatures: [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }] },
  { mime: "image/png", extensions: ["png"], signatures: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }] },
  { mime: "image/jpeg", extensions: ["jpg", "jpeg"], signatures: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }] },
  { mime: "image/gif", extensions: ["gif"], signatures: [
    { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
    { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  ] },
  { mime: "application/zip", extensions: ["zip", "xlsx", "docx", "pptx"], signatures: [{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }] },
  { mime: "application/gzip", extensions: ["gz"], signatures: [{ offset: 0, bytes: [0x1f, 0x8b] }] },
  { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extensions: ["xlsx"], signatures: [{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }] },
  { mime: "audio/mpeg", extensions: ["mp3"], signatures: [{ offset: 0, bytes: [0x49, 0x44, 0x33] }] },
  { mime: "video/mp4", extensions: ["mp4"], signatures: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }] },
];

export default async function magicByteValidator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "magic-byte-validator requires one input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const ext = (ref.filename ?? "").toLowerCase().split(".").pop() ?? "";
  const claimedMime = ref.mime ?? "";

  const detected = SIGNATURES.find((sig) => sig.signatures.some((s) => matches(buf, s)));
  const consistentByExt = detected ? detected.extensions.includes(ext) : false;
  const consistentByMime = detected ? detected.mime === claimedMime || claimedMime.endsWith("/" + ext) : false;
  const consistent = consistentByExt || consistentByMime || (claimedMime === "" && ext === "");

  const report = JSON.stringify({
    filename: ref.filename,
    claimedMime,
    extension: ext,
    detectedMime: detected?.mime ?? null,
    consistent,
    spoofed: detected != null && !consistent,
  }, null, 2);
  const outRef = "validation.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, report, "utf8");

  return {
    ok: true,
    outputs: { consistent, detectedMime: detected?.mime ?? null, claimedMime, extension: ext, spoofed: detected != null && !consistent },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(report, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function matches(buf: Buffer, sig: { offset: number; bytes: number[] }): boolean {
  if (buf.length < sig.offset + sig.bytes.length) return false;
  for (let i = 0; i < sig.bytes.length; i++) if (buf[sig.offset + i] !== sig.bytes[i]) return false;
  return true;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
