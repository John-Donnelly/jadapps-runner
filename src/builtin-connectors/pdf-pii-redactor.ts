/**
 * pdf-pii-redactor: scans the PDF's text content for PII patterns (emails,
 * phone numbers, US-style SSNs, credit-card-shaped digits) and reports
 * matches. Note: this v0.1 reports matches only — it does NOT yet draw
 * black boxes over them on the page, since pdf-lib's text-position queries
 * aren't precise enough without pdfjs. Treat output as an audit, then feed
 * regions to pdf-redact for the actual redaction pass.
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

interface PiiHit { kind: string; match: string; }

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: "phone-us", re: /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g },
  { name: "ssn", re: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g },
  { name: "credit-card", re: /(?<!\d)(?:\d{4}[\s-]?){3}\d{4}(?!\d)/g },
  { name: "iban", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{4,}\b/g },
];

export default async function pdfPiiRedactor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-pii-redactor requires one PDF input");

  let pdfLib: typeof import("pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const doc = await pdfLib.PDFDocument.load(buf, { ignoreEncryption: true });
  ctx.emitProgress(totalIn);

  // pdf-lib doesn't expose extracted text; we read the raw text strings from
  // the document's content streams. For text inside font-encoded streams
  // this catches plain ASCII; encrypted/compressed binary content will not
  // be scanned. Use pdf-to-text + pdf-redact for full coverage when those
  // tools land.
  const text = buf.toString("latin1");
  const hits: PiiHit[] = [];
  const counts: Record<string, number> = {};
  for (const { name, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      hits.push({ kind: name, match: m[0] });
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }

  const out = JSON.stringify({ hitCount: hits.length, breakdown: counts, pageCount: doc.getPageCount(), hits: hits.slice(0, 1000) }, null, 2);
  const outRef = "pii-report.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { hitCount: hits.length, breakdown: counts, note: "audit only; pair with pdf-redact for visible boxes once pdfjs lands" },
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
