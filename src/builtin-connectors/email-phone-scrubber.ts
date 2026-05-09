/**
 * email-phone-scrubber: scrubs email addresses and phone numbers from a
 * text or markdown file, replacing matches with placeholders. Variants:
 * "redact" → "[REDACTED]", "mask" → keeps domain or last 4 digits, "drop"
 * → removes the match entirely.
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

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?<!\d)(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;

export default async function emailPhoneScrubber(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "email-phone-scrubber requires one text input");

  const cfg = ctx.inputs ?? {};
  const mode = ["redact", "mask", "drop"].includes(cfg.mode as string) ? cfg.mode as string : "redact";

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  let emails = 0, phones = 0;
  let transformed = text.replace(EMAIL_RE, (m) => {
    emails += 1;
    if (mode === "drop") return "";
    if (mode === "mask") {
      const at = m.indexOf("@");
      return "***@" + m.slice(at + 1);
    }
    return "[EMAIL]";
  });
  transformed = transformed.replace(PHONE_RE, (m) => {
    phones += 1;
    if (mode === "drop") return "";
    if (mode === "mask") {
      const digits = m.replace(/\D/g, "");
      return digits.length >= 4 ? "***-" + digits.slice(-4) : "***";
    }
    return "[PHONE]";
  });

  const outRef = `scrubbed-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, transformed, "utf8");

  return {
    ok: true,
    outputs: { mode, emailsScrubbed: emails, phonesScrubbed: phones },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(transformed, "utf8"), sha256: "", mime: ref.mime || "text/plain", filename: ref.filename ?? "scrubbed.txt" }],
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
