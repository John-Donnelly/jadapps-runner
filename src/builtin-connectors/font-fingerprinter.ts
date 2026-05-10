/**
 * font-fingerprinter: produces a stable hash + summary for a font file
 * so two builds of the "same" font can be compared. Uses sha256 of the
 * raw bytes plus the font's name table (via fontkit if available).
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function fontFingerprinter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "font-fingerprinter requires one font input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const sha = createHash("sha256").update(buf).digest("hex");
  ctx.emitProgress(totalIn);

  let nameTable: Record<string, string> = {};
  try {
    const fontkitMod = await import("@pdf-lib/fontkit");
    const fontkit = (fontkitMod as unknown as { default?: typeof fontkitMod }).default ?? fontkitMod;
    const font = (fontkit as unknown as { create(b: Buffer): { fullName?: string; familyName?: string; subfamilyName?: string; postscriptName?: string; copyright?: string; version?: string } }).create(buf);
    nameTable = {
      fullName: font.fullName ?? "",
      familyName: font.familyName ?? "",
      subfamilyName: font.subfamilyName ?? "",
      postscriptName: font.postscriptName ?? "",
      copyright: font.copyright ?? "",
      version: font.version ?? "",
    };
  } catch (err) {
    nameTable = { error: `fontkit unavailable: ${(err as Error).message}` };
  }

  const fingerprint = createHash("sha256").update(sha).update(JSON.stringify(nameTable)).digest("hex");
  const report = {
    file: ref.filename ?? ref.ref,
    bytes: buf.length,
    sha256: sha,
    fingerprint,
    nameTable,
  };
  const out = JSON.stringify(report, null, 2);
  const outRef = "fingerprint.json";
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");

  return {
    ok: true,
    outputs: { sha256: sha, fingerprint, familyName: nameTable.familyName ?? "" },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
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
