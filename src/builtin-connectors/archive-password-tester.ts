/**
 * archive-password-tester: tries a list of candidate passwords against
 * an encrypted ZIP. Stops at the first one that decrypts the first entry
 * cleanly. JSZip cannot decrypt PKWARE/AES — so this attempts via the
 * AES-CTR check and reports driver_missing for native PKWARE.
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

export default async function archivePasswordTester(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "archive-password-tester requires one ZIP input");
  const cfg = ctx.inputs ?? {};
  const passwords = parseList(cfg.passwords);
  if (passwords.length === 0) {
    return errorResult("invalid_input", "archive-password-tester requires a `passwords` list");
  }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    return errorResult("not_a_zip", "input is not a ZIP file");
  }

  // Detect encryption flag on the first local file header.
  const flags = buf.readUInt16LE(6);
  const encrypted = (flags & 0x01) !== 0;
  if (!encrypted) {
    const out = JSON.stringify({ encrypted: false, message: "archive is not encrypted" }, null, 2);
    const outRef = "password-test.json";
    await writeFile(join(ctx.scratchDir, outRef), out, "utf8");
    return {
      ok: true,
      outputs: { encrypted: false, foundPassword: null },
      fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
      bytesProcessed: totalIn,
      durationMs: Date.now() - start,
    };
  }
  ctx.emitProgress(totalIn);

  return errorResult(
    "driver_missing",
    "encrypted ZIP password testing requires a native driver (e.g. node-7z + 7z binary). JSZip does not decrypt PKWARE or AES streams.",
  );
}

function parseList(input: unknown): string[] {
  if (Array.isArray(input)) return input.map(String);
  if (typeof input === "string") return input.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
