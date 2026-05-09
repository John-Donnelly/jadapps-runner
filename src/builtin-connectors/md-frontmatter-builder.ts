/**
 * md-frontmatter-builder: prepends a YAML frontmatter block to a Markdown
 * file, replacing any existing frontmatter. Accepts a JSON object as input.
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

export default async function mdFrontmatterBuilder(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-frontmatter-builder requires one Markdown input");

  const cfg = ctx.inputs ?? {};
  const fields = parseFields(cfg.fields);
  if (fields == null) return errorResult("invalid_config", "fields must be a JSON object");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const body = stripExistingFrontmatter(text);
  const frontmatter = "---\n" + buildYaml(fields) + "---\n\n";
  const combined = frontmatter + body;

  const outRef = `with-fm-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, combined, "utf8");

  return {
    ok: true,
    outputs: { fieldCount: Object.keys(fields).length, replacedExisting: body !== text },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(combined, "utf8"), sha256: "", mime: "text/markdown", filename: ref.filename ?? "with-fm.md" }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function stripExistingFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return text;
  return text.slice(end + 5).replace(/^\n+/, "");
}

function buildYaml(fields: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`${k}: ${formatYamlValue(v)}`);
  }
  return lines.join("\n") + "\n";
}

function formatYamlValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return "[" + v.map((x) => formatYamlValue(x)).join(", ") + "]";
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  if (/^(true|false|null|yes|no)$/i.test(s) || /^-?\d+(\.\d+)?$/.test(s) || /[:#\n\t&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

function parseFields(input: unknown): Record<string, unknown> | null {
  if (input == null) return null;
  if (typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { return null; }
  }
  return null;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
