/**
 * multi-hash-fingerprinter: computes a fingerprint per file using multiple
 * algorithms simultaneously (md5, sha1, sha256, sha512). Single-pass: each
 * file is read once and fed to every hash.
 */

import { createReadStream, statSync } from "node:fs";
import { createHash } from "node:crypto";
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

const DEFAULT_ALGOS = ["md5", "sha1", "sha256", "sha512"];

export default async function multiHashFingerprinter(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "multi-hash-fingerprinter requires at least one input");
  }

  const cfg = ctx.inputs ?? {};
  const algorithms = Array.isArray(cfg.algorithms) ? cfg.algorithms.map(String) : DEFAULT_ALGOS;
  for (const a of algorithms) {
    if (!["md5", "sha1", "sha256", "sha384", "sha512"].includes(a)) {
      return errorResult("invalid_config", `unsupported algorithm: ${a}`);
    }
  }

  const results: { ref: string; filename: string; bytes: number; hashes: Record<string, string> }[] = [];
  let totalIn = 0;

  for (const ref of ctx.fileRefs) {
    const inPath = join(ctx.scratchDir, ref.ref);
    const fileBytes = sizeOrFallback(inPath, ref.bytes);
    totalIn += fileBytes;
    const hashes = algorithms.map((a) => createHash(a));
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(inPath);
      stream.on("data", (chunk) => { for (const h of hashes) h.update(chunk); });
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    const digest: Record<string, string> = {};
    algorithms.forEach((a, i) => { digest[a] = hashes[i]!.digest("hex"); });
    results.push({ ref: ref.ref, filename: ref.filename, bytes: fileBytes, hashes: digest });
  }
  ctx.emitProgress(totalIn);

  const report = JSON.stringify({ algorithms, fileCount: results.length, results }, null, 2);
  const outRef = "fingerprints.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, report, "utf8");

  return {
    ok: true,
    outputs: { algorithms, fileCount: results.length, results },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(report, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
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
