/**
 * password-entropy-auditor: scores each password in an input list (one per
 * line) for Shannon entropy bits, character class diversity, length, and a
 * categorical strength rating ("very weak" → "very strong"). Common
 * dictionary fragments knock the score down.
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

const COMMON_FRAGMENTS = ["password", "qwerty", "letmein", "welcome", "admin", "login", "abc123", "iloveyou", "monkey", "dragon", "1234", "0000"];

interface Score { password: string; length: number; classes: string[]; entropyBits: number; rating: string; commonFragmentsHit: string[]; }

export default async function passwordEntropyAuditor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "password-entropy-auditor requires one text input (one password per line)");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const passwords = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const scores = passwords.map((p) => scorePassword(p));
  const distribution: Record<string, number> = {};
  for (const s of scores) distribution[s.rating] = (distribution[s.rating] ?? 0) + 1;

  const report = JSON.stringify({ count: scores.length, distribution, scores }, null, 2);
  const outRef = "password-audit.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, report, "utf8");

  return {
    ok: true,
    outputs: { count: scores.length, distribution },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(report, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function scorePassword(password: string): Score {
  const classes: string[] = [];
  if (/[a-z]/.test(password)) classes.push("lower");
  if (/[A-Z]/.test(password)) classes.push("upper");
  if (/\d/.test(password)) classes.push("digit");
  if (/[^A-Za-z0-9]/.test(password)) classes.push("symbol");

  const charSetSize = (classes.includes("lower") ? 26 : 0) + (classes.includes("upper") ? 26 : 0) + (classes.includes("digit") ? 10 : 0) + (classes.includes("symbol") ? 32 : 0);
  let entropyBits = password.length * Math.log2(Math.max(1, charSetSize));
  const lower = password.toLowerCase();
  const hits: string[] = [];
  for (const f of COMMON_FRAGMENTS) if (lower.includes(f)) { hits.push(f); entropyBits -= 10; }

  let rating = "very weak";
  if (entropyBits >= 90) rating = "very strong";
  else if (entropyBits >= 70) rating = "strong";
  else if (entropyBits >= 50) rating = "fair";
  else if (entropyBits >= 30) rating = "weak";

  return { password: maskMiddle(password), length: password.length, classes, entropyBits: Math.max(0, entropyBits), rating, commonFragmentsHit: hits };
}

function maskMiddle(s: string): string {
  if (s.length <= 2) return "*".repeat(s.length);
  return s[0] + "*".repeat(Math.max(1, s.length - 2)) + s[s.length - 1];
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
