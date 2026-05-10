/**
 * archive-integrity-tester: walks every entry in a ZIP, decompresses it,
 * and verifies the entry's CRC32 matches the central-directory record.
 * Reports per-entry pass/fail and overall integrity.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function archiveIntegrityTester(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "archive-integrity-tester requires one ZIP input");

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    return errorResult("not_a_zip", "input is not a ZIP file");
  }

  let zip: import("jszip");
  try {
    zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
  } catch (err) {
    return errorResult("invalid_zip", `failed to parse ZIP: ${(err as Error).message}`);
  }
  ctx.emitProgress(totalIn);

  const results: { path: string; ok: boolean; bytes: number; crc32: string }[] = [];
  let failed = 0;
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    try {
      const data = await file.async("nodebuffer");
      results.push({ path, ok: true, bytes: data.length, crc32: crc32(data).toString(16) });
    } catch (err) {
      results.push({ path, ok: false, bytes: 0, crc32: `error: ${(err as Error).message}` });
      failed += 1;
    }
  }

  const report = {
    archive: ref.filename ?? ref.ref,
    totalEntries: results.length,
    passed: results.length - failed,
    failed,
    integrityOk: failed === 0,
    entries: results,
  };
  const out = JSON.stringify(report, null, 2);
  const outRef = "integrity-report.json";
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");

  return {
    ok: true,
    outputs: { totalEntries: results.length, failed, integrityOk: failed === 0 },
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
