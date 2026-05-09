/**
 * md-code-block-tagger: infers the language for fenced code blocks that have
 * no info string. Detection is signature-based: shebangs, syntax markers,
 * keywords. Conservative — leaves blocks untagged if the heuristics can't
 * decide.
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

export default async function mdCodeBlockTagger(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-code-block-tagger requires one Markdown input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  let tagged = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fenceMatch = /^(\s*)```(.*)$/.exec(line);
    if (!fenceMatch) { out.push(line); i++; continue; }
    const indent = fenceMatch[1] ?? "";
    const info = (fenceMatch[2] ?? "").trim();
    const body: string[] = [];
    i++;
    while (i < lines.length && !/^\s*```/.test(lines[i] ?? "")) {
      body.push(lines[i] ?? "");
      i++;
    }
    const closing = i < lines.length ? lines[i] ?? "" : "```";
    if (i < lines.length) i++;

    let lang = info;
    if (!lang) {
      const detected = detectLanguage(body.join("\n"));
      if (detected) { lang = detected; tagged++; }
    }
    out.push(`${indent}\`\`\`${lang}`);
    out.push(...body);
    out.push(closing);
  }

  const transformed = out.join("\n");
  const outRef = `tagged-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, transformed, "utf8");

  return {
    ok: true,
    outputs: { taggedCount: tagged },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(transformed, "utf8"), sha256: "", mime: "text/markdown", filename: ref.filename ?? "tagged.md" }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function detectLanguage(code: string): string | null {
  const trimmed = code.trim();
  if (!trimmed) return null;
  const firstLine = (trimmed.split("\n")[0] ?? "").trim();
  if (/^#!/.test(firstLine)) {
    if (/python/.test(firstLine)) return "python";
    if (/node|nodejs/.test(firstLine)) return "javascript";
    if (/bash|sh/.test(firstLine)) return "bash";
  }
  if (/^<\?xml|<!DOCTYPE html|<html/i.test(trimmed)) return "html";
  if (/^\s*\{[\s\S]*\}\s*$/.test(trimmed) && /"[^"]*"\s*:/.test(trimmed)) return "json";
  if (/^---\n[\s\S]*?\n---/.test(trimmed)) return "yaml";
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|ALTER TABLE)\b/i.test(firstLine)) return "sql";
  if (/^(import |export |const |let |function |interface |type )/.test(trimmed) && /:\s*[A-Z]\w*/.test(trimmed)) return "typescript";
  if (/^(import |export |const |let |function )/.test(trimmed)) return "javascript";
  if (/^(def |class |import |from \w+ import )/.test(trimmed)) return "python";
  if (/^package \w+|^func \w+\(|^import \(/.test(trimmed)) return "go";
  if (/fn \w+\(|let mut |impl |use \w+::/.test(trimmed)) return "rust";
  if (/^\s*\$ |^\s*sudo |grep |awk /.test(trimmed)) return "bash";
  if (/^(@|\.\w+\s*\{)|^\s*[\w.#]+\s*\{[^}]*color:/m.test(trimmed)) return "css";
  return null;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
