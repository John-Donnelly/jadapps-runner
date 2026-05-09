/**
 * pii-redactor: silences or beep-replaces audio segments matching PII
 * patterns. Workflow: transcribe via whisper-cli (with word timestamps),
 * regex-match the transcript for PII (emails, phone numbers, SSNs,
 * credit-card-shaped digits), then run ffmpeg to silence those time
 * windows.
 */

import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StepResult, FileRef } from "../types.js";

const execFileAsync = promisify(execFile);

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

interface WhisperWord { word: string; start: number; end: number; }
interface Segment { from: number; to: number; reason: string; }

const PII = [
  { name: "phone", re: /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g },
  { name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: "ssn", re: /\d{3}-\d{2}-\d{4}/g },
  { name: "credit-card", re: /(?:\d{4}[\s-]?){3}\d{4}/g },
];

export default async function piiRedactor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pii-redactor requires one audio input");
  const cfg = ctx.inputs ?? {};
  const padMs = Math.max(0, Math.min(2000, Number(cfg.padMs ?? 200)));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);

  const preppedPath = join(ctx.scratchDir, "_redactor-input.wav");
  try {
    await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-ac", "1", "-ar", "16000", "-f", "wav", preppedPath]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "ffmpeg not found on PATH");
    return errorResult("ffmpeg_error", `ffmpeg pre-process failed: ${(err as { message: string }).message}`);
  }

  const baseName = (ref.filename ?? "audio").replace(/\.[^.]+$/, "");
  const outBase = join(ctx.scratchDir, `${baseName}-words`);
  try {
    await execFileAsync("whisper-cli", ["-l", "en", "-ojson", "--print-progress", "false", "-of", outBase, "-f", preppedPath]);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return errorResult("driver_missing", "whisper-cli not found on PATH");
    return errorResult("whisper_error", `whisper-cli failed: ${(err as { message: string }).message}`);
  }

  let words: WhisperWord[] = [];
  try {
    const json = JSON.parse(await readFile(`${outBase}.json`, "utf8"));
    const segments = (json as { transcription?: { offsets?: { from: number; to: number }; text?: string }[] }).transcription ?? [];
    for (const seg of segments) {
      const text = String(seg.text ?? "").trim();
      const from = (seg.offsets?.from ?? 0) / 1000;
      const to = (seg.offsets?.to ?? 0) / 1000;
      if (text) words.push({ word: text, start: from, end: to });
    }
  } catch {
    return errorResult("whisper_error", "could not parse whisper output");
  }

  const segmentsToSilence: Segment[] = [];
  const fullText = words.map((w) => w.word).join(" ");
  for (const { name, re } of PII) {
    for (const m of fullText.matchAll(re)) {
      // Approximate the word range covering this match.
      const matchStart = m.index ?? 0;
      const matchEnd = matchStart + m[0].length;
      let charPos = 0;
      let firstWord: WhisperWord | null = null;
      let lastWord: WhisperWord | null = null;
      for (const w of words) {
        const wEnd = charPos + w.word.length;
        if (charPos <= matchEnd && wEnd >= matchStart) {
          if (!firstWord) firstWord = w;
          lastWord = w;
        }
        charPos = wEnd + 1;
      }
      if (firstWord && lastWord) {
        segmentsToSilence.push({
          from: Math.max(0, firstWord.start - padMs / 1000),
          to: lastWord.end + padMs / 1000,
          reason: name,
        });
      }
    }
  }

  if (segmentsToSilence.length === 0) {
    // Nothing to redact — just copy the input to a sensibly-named output.
    return {
      ok: true,
      outputs: { redactedSegments: 0 },
      fileRefs: [{ ...ref }],
      bytesProcessed: totalIn,
      durationMs: Date.now() - start,
    };
  }

  // Build a volume filter that mutes each detected window.
  const muteFilter = segmentsToSilence
    .map((s) => `volume=enable='between(t,${s.from.toFixed(3)},${s.to.toFixed(3)})':volume=0`)
    .join(",");

  const ext = extname(ref.filename ?? ".mp3") || ".mp3";
  const outRef = `${baseName}-redacted${ext}`;
  const outPath = join(ctx.scratchDir, outRef);

  try {
    await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-af", muteFilter, outPath]);
  } catch (err) {
    return errorResult("ffmpeg_error", `silencing pass failed: ${(err as { message: string }).message}`);
  }

  ctx.emitProgress(totalIn);
  const outBytes = sizeOrFallback(outPath, 0);
  return {
    ok: true,
    outputs: { redactedSegments: segmentsToSilence.length, segments: segmentsToSilence },
    fileRefs: [{ ref: outRef, bytes: outBytes, sha256: "", mime: ref.mime || "audio/mpeg", filename: outRef }],
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
