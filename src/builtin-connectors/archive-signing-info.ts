/**
 * archive-signing-info: scans a ZIP for signature metadata (e.g. JAR/APK
 * META-INF/*.SF + .RSA/.DSA, or PGP detached .asc files alongside entries).
 * Reports presence and filenames; does not validate signatures.
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

export default async function archiveSigningInfo(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "archive-signing-info requires one ZIP input");

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
  ctx.emitProgress(totalIn);

  const sigFiles: string[] = [];
  let manifestPresent = false;
  let signatureFile = false;
  for (const path of Object.keys(zip.files)) {
    if (path === "META-INF/MANIFEST.MF") manifestPresent = true;
    if (/^META-INF\/.+\.SF$/.test(path)) { sigFiles.push(path); signatureFile = true; }
    if (/^META-INF\/.+\.(RSA|DSA|EC)$/.test(path)) sigFiles.push(path);
    if (/\.asc$/i.test(path) || /\.sig$/i.test(path)) sigFiles.push(path);
  }

  const report = {
    archive: ref.filename ?? ref.ref,
    likelyJarOrApk: manifestPresent && signatureFile,
    manifestPresent,
    signatureFiles: sigFiles,
    signatureCount: sigFiles.length,
  };
  const out = JSON.stringify(report, null, 2);
  const outRef = "signing-info.json";
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");

  return {
    ok: true,
    outputs: { signatureCount: sigFiles.length, likelyJarOrApk: manifestPresent && signatureFile },
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
