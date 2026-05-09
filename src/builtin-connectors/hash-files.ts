/**
 * hash-files: computes a single hash digest for each input file. Algorithm
 * defaults to sha256; supports md5, sha1, sha256, sha384, sha512.
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

const ALLOWED = new Set(["md5", "sha1", "sha256", "sha384", "sha512"]);

export default async function hashFiles(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "hash-files requires at least one input");
  }

  const cfg = ctx.inputs ?? {};
  const algorithm = String(cfg.algorithm ?? "sha256").toLowerCase();
  if (!ALLOWED.has(algorithm)) return errorResult("invalid_config", `unsupported algorithm: ${algorithm}`);

  const results: { ref: string; filename: string; bytes: number; hex: string }[] = [];
  let totalIn = 0;
  let bytesProcessed = 0;
  for (const ref of ctx.fileRefs) {
    const inPath = join(ctx.scratchDir, ref.ref);
    const fileBytes = sizeOrFallback(inPath, ref.bytes);
    totalIn += fileBytes;
    const hash = createHash(algorithm);
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(inPath);
      stream.on("data", (chunk: string | Buffer) => {
        hash.update(chunk);
        bytesProcessed += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        if (bytesProcessed % (1024 * 1024) < 65536) ctx.emitProgress(bytesProcessed);
      });
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    results.push({ ref: ref.ref, filename: ref.filename, bytes: fileBytes, hex: hash.digest("hex") });
  }
  ctx.emitProgress(totalIn);

  const report = JSON.stringify({ algorithm, fileCount: results.length, results }, null, 2);
  const outRef = "hashes.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, report, "utf8");

  return {
    ok: true,
    outputs: { algorithm, fileCount: results.length, results },
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
