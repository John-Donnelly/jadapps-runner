/**
 * hex-header-inspector: dumps the first N bytes of a file as a hex listing
 * (offset, hex, ASCII) and identifies the file type from its magic bytes.
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

const MAGIC: { name: string; mime: string; signature: number[]; offset?: number }[] = [
  { name: "PDF", mime: "application/pdf", signature: [0x25, 0x50, 0x44, 0x46] },
  { name: "PNG", mime: "image/png", signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: "JPEG", mime: "image/jpeg", signature: [0xff, 0xd8, 0xff] },
  { name: "GIF87a", mime: "image/gif", signature: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
  { name: "GIF89a", mime: "image/gif", signature: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  { name: "ZIP/Office", mime: "application/zip", signature: [0x50, 0x4b, 0x03, 0x04] },
  { name: "GZip", mime: "application/gzip", signature: [0x1f, 0x8b] },
  { name: "7-Zip", mime: "application/x-7z-compressed", signature: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { name: "RAR", mime: "application/vnd.rar", signature: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { name: "ELF", mime: "application/x-elf", signature: [0x7f, 0x45, 0x4c, 0x46] },
  { name: "Mach-O 32", mime: "application/x-mach-binary", signature: [0xfe, 0xed, 0xfa, 0xce] },
  { name: "Mach-O 64", mime: "application/x-mach-binary", signature: [0xfe, 0xed, 0xfa, 0xcf] },
  { name: "PE/Windows", mime: "application/x-msdownload", signature: [0x4d, 0x5a] },
  { name: "MP3", mime: "audio/mpeg", signature: [0x49, 0x44, 0x33] },
  { name: "WAV", mime: "audio/wav", signature: [0x52, 0x49, 0x46, 0x46] },
  { name: "MP4", mime: "video/mp4", signature: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  { name: "WebM", mime: "video/webm", signature: [0x1a, 0x45, 0xdf, 0xa3] },
];

export default async function hexHeaderInspector(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "hex-header-inspector requires one input file");

  const cfg = ctx.inputs ?? {};
  const headerBytes = Math.max(16, Math.min(4096, Math.floor(Number(cfg.headerBytes ?? 256))));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const slice = buf.subarray(0, headerBytes);
  const detected = detectMagic(buf);

  const lines: string[] = [];
  for (let i = 0; i < slice.length; i += 16) {
    const chunk = slice.subarray(i, i + 16);
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...chunk].map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(48, " ")}  ${ascii}`);
  }

  const report = `File: ${ref.filename ?? ref.ref}
Bytes: ${totalIn}
Detected: ${detected ? `${detected.name} (${detected.mime})` : "unknown"}

${lines.join("\n")}
`;

  const outRef = "hex-dump.txt";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, report, "utf8");

  return {
    ok: true,
    outputs: { detected: detected ?? null, headerBytes, totalBytes: totalIn },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(report, "utf8"), sha256: "", mime: "text/plain", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function detectMagic(buf: Buffer): { name: string; mime: string } | null {
  for (const m of MAGIC) {
    const offset = m.offset ?? 0;
    if (buf.length < offset + m.signature.length) continue;
    let match = true;
    for (let i = 0; i < m.signature.length; i++) if (buf[offset + i] !== m.signature[i]) { match = false; break; }
    if (match) return { name: m.name, mime: m.mime };
  }
  return null;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
