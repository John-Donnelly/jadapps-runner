/**
 * yaml-to-json: converts a subset of YAML 1.2 to JSON. Supports nested
 * mappings, sequences, scalars (strings/numbers/booleans/null/dates),
 * inline `[a, b]` and `{k: v}`, and basic quoted strings. Anchors,
 * aliases, complex keys, and tagged scalars are out of scope for v0.1.
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

export default async function yamlToJson(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "yaml-to-json requires one YAML input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const cleaned = text.replace(/\r\n/g, "\n").split("\n").map((line) => line.replace(/(?<!["']) *#.*$/, "")).join("\n");
  const lines = cleaned.split("\n").filter((line) => line.trim() !== "");
  const value = parseBlock(lines, 0, 0).value;

  const out = JSON.stringify(value, null, 2);
  const outRef = `${(ref.filename ?? "doc").replace(/\.ya?ml$/i, "")}.json`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { rootKind: kindOf(value) },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function parseBlock(lines: string[], startIdx: number, baseIndent: number): { value: unknown; nextIdx: number } {
  if (startIdx >= lines.length) return { value: null, nextIdx: startIdx };
  const first = lines[startIdx]!;
  const indent = countIndent(first);
  const trimmed = first.trim();
  if (trimmed.startsWith("-")) return parseSequence(lines, startIdx, indent);
  if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(trimmed)) return parseMapping(lines, startIdx, indent);
  // single scalar
  return { value: parseScalar(trimmed), nextIdx: startIdx + 1 };
}

function parseSequence(lines: string[], startIdx: number, indent: number): { value: unknown[]; nextIdx: number } {
  const items: unknown[] = [];
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i]!;
    if (countIndent(line) < indent) break;
    if (countIndent(line) > indent) { i += 1; continue; }
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) break;
    const rest = trimmed.slice(1).trim();
    if (!rest) {
      const r = parseBlock(lines, i + 1, indent + 2);
      items.push(r.value);
      i = r.nextIdx;
      continue;
    }
    if (rest.includes(":") && /^[A-Za-z_]/.test(rest)) {
      // inline mapping start; treat the whole "- key: val" as a one-key mapping
      const kvIdx = rest.indexOf(":");
      const k = rest.slice(0, kvIdx).trim();
      const v = rest.slice(kvIdx + 1).trim();
      const obj: Record<string, unknown> = {};
      if (v) obj[k] = parseScalar(v);
      else {
        const r = parseBlock(lines, i + 1, indent + 2);
        obj[k] = r.value;
        items.push(obj);
        i = r.nextIdx;
        continue;
      }
      items.push(obj);
      i += 1;
      continue;
    }
    items.push(parseScalar(rest));
    i += 1;
  }
  return { value: items, nextIdx: i };
}

function parseMapping(lines: string[], startIdx: number, indent: number): { value: Record<string, unknown>; nextIdx: number } {
  const obj: Record<string, unknown> = {};
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i]!;
    if (countIndent(line) < indent) break;
    if (countIndent(line) > indent) { i += 1; continue; }
    const trimmed = line.trim();
    const colon = trimmed.indexOf(":");
    if (colon < 0) { i += 1; continue; }
    const key = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();
    if (rest) {
      obj[key] = parseScalar(rest);
      i += 1;
    } else {
      const r = parseBlock(lines, i + 1, indent + 2);
      obj[key] = r.value;
      i = r.nextIdx;
    }
  }
  return { value: obj, nextIdx: i };
}

function parseScalar(s: string): unknown {
  if (s.startsWith("[") && s.endsWith("]")) return parseFlowList(s);
  if (s.startsWith("{") && s.endsWith("}")) return parseFlowMap(s);
  if ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (/^(true|yes|on)$/i.test(s)) return true;
  if (/^(false|no|off)$/i.test(s)) return false;
  if (/^(null|~)$/i.test(s) || s === "") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

function parseFlowList(s: string): unknown[] {
  const inner = s.slice(1, -1);
  return splitTop(inner, ",").map((p) => parseScalar(p.trim()));
}

function parseFlowMap(s: string): Record<string, unknown> {
  const inner = s.slice(1, -1);
  const out: Record<string, unknown> = {};
  for (const piece of splitTop(inner, ",")) {
    const kv = splitTop(piece.trim(), ":");
    if (kv.length === 2) out[kv[0]!.trim()] = parseScalar(kv[1]!.trim());
  }
  return out;
}

function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

function countIndent(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === " ") i++;
  return i;
}

function kindOf(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
