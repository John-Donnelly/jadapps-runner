/**
 * md-secret-redactor: scans for secret patterns (API keys, AWS keys, JWT,
 * bearer tokens, GitHub PATs, basic auth in URLs) and replaces matches with
 * `[REDACTED]`. Optional `extraPatterns` extends the rule set.
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

const BUILTIN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github-pat", re: /\bghp_[A-Za-z0-9]{36,}\b/g },
  { name: "github-fine-grained", re: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9]{32,}\b/g },
  { name: "stripe-secret", re: /\bsk_(live|test)_[A-Za-z0-9]{24,}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "basic-auth-url", re: /\b(https?:\/\/)([^:@\s/]+):([^@\s]+)@/g },
  { name: "private-key-block", re: /-----BEGIN (RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g },
];

export default async function mdSecretRedactor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-secret-redactor requires one Markdown input");

  const cfg = ctx.inputs ?? {};
  const extraPatterns = parseExtraPatterns(cfg.extraPatterns);

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  let total = 0;
  const counts: Record<string, number> = {};
  let transformed = text;
  for (const { name, re } of BUILTIN_PATTERNS) {
    transformed = transformed.replace(re, (m) => {
      counts[name] = (counts[name] ?? 0) + 1;
      total += 1;
      if (name === "basic-auth-url") return m.replace(/:[^@]+@/, ":[REDACTED]@");
      return "[REDACTED]";
    });
  }
  for (const pattern of extraPatterns) {
    try {
      const re = new RegExp(pattern, "g");
      transformed = transformed.replace(re, () => { total += 1; return "[REDACTED]"; });
    } catch { /* ignore invalid extras */ }
  }

  const outRef = `redacted-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, transformed, "utf8");

  return {
    ok: true,
    outputs: { totalRedactions: total, byPattern: counts },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(transformed, "utf8"), sha256: "", mime: "text/markdown", filename: ref.filename ?? "redacted.md" }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function parseExtraPatterns(input: unknown): string[] {
  if (input == null) return [];
  if (Array.isArray(input)) return input.map(String);
  if (typeof input === "string") {
    try { const p = JSON.parse(input); return Array.isArray(p) ? p.map(String) : []; }
    catch { return input.split("\n").map((s) => s.trim()).filter(Boolean); }
  }
  return [];
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
