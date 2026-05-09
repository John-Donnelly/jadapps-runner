/**
 * pii-scan: scans a text or markdown file for personally-identifiable
 * information patterns and emits a JSON report (counts + samples). Patterns
 * include emails, phone numbers, US SSNs, credit-card-shaped digits, IBANs,
 * IPv4 addresses, and dates of birth. Results are read-only — pair with
 * email-phone-scrubber, md-secret-redactor, or pdf-redact to remove.
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

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: "phone", re: /(?<!\d)(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g },
  { name: "ssn-us", re: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g },
  { name: "credit-card", re: /(?<!\d)(?:\d{4}[\s-]?){3}\d{4}(?!\d)/g },
  { name: "iban", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{4,}\b/g },
  { name: "ipv4", re: /(?<!\d)(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)){3}(?!\d)/g },
  { name: "dob", re: /\b(?:0?[1-9]|1[0-2])[\/-](?:0?[1-9]|[12]\d|3[01])[\/-](?:19|20)\d{2}\b/g },
];

export default async function piiScan(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pii-scan requires one text input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const counts: Record<string, number> = {};
  const samples: Record<string, string[]> = {};
  for (const { name, re } of PATTERNS) {
    counts[name] = 0;
    samples[name] = [];
    for (const m of text.matchAll(re)) {
      counts[name]! += 1;
      if (samples[name]!.length < 3) samples[name]!.push(m[0]);
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const out = JSON.stringify({ totalHits: total, counts, samples }, null, 2);
  const outRef = "pii-scan.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { totalHits: total, counts },
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
