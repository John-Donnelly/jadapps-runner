/**
 * checksum-generator: produces a sha256 (default) or md5/sha1 manifest
 * for every input file. Output is a `checksums.txt` in the BSD/coreutils
 * format: `<hash>  <filename>` per line.
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

export default async function checksumGenerator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length === 0) {
    return errorResult("missing_input", "checksum-generator requires at least one input");
  }
  const cfg = ctx.inputs ?? {};
  const algo = ["sha256", "sha1", "md5", "sha512"].includes(String(cfg.algorithm ?? "sha256"))
    ? String(cfg.algorithm ?? "sha256")
    : "sha256";

  const lines: string[] = [];
  const entries: { name: string; hash: string; bytes: number }[] = [];
  let totalIn = 0;
  for (const ref of ctx.fileRefs) {
    const path = join(ctx.scratchDir, ref.ref);
    const inSize = sizeOrFallback(path, ref.bytes);
    totalIn += inSize;
    const buf = await readFile(path);
    const hash = createHash(algo).update(buf).digest("hex");
    const name = ref.filename ?? ref.ref;
    lines.push(`${hash}  ${name}`);
    entries.push({ name, hash, bytes: buf.length });
  }
  ctx.emitProgress(totalIn);

  const txt = lines.join("\n") + "\n";
  const txtRef = `checksums.${algo}.txt`;
  await writeFile(join(ctx.scratchDir, txtRef), txt, "utf8");
  const json = JSON.stringify({ algorithm: algo, entries }, null, 2);
  const jsonRef = `checksums.${algo}.json`;
  await writeFile(join(ctx.scratchDir, jsonRef), json, "utf8");

  return {
    ok: true,
    outputs: { algorithm: algo, fileCount: entries.length },
    fileRefs: [
      { ref: txtRef, bytes: Buffer.byteLength(txt, "utf8"), sha256: "", mime: "text/plain", filename: txtRef },
      { ref: jsonRef, bytes: Buffer.byteLength(json, "utf8"), sha256: "", mime: "application/json", filename: jsonRef },
    ],
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
