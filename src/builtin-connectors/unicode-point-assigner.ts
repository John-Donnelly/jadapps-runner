/**
 * unicode-point-assigner: assigns Unicode code points to a list of
 * named glyphs (e.g. for icon fonts). Output is a JSON manifest mapping
 * glyph-name → codepoint, starting from a configurable PUA range.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function unicodePointAssigner(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const names = parseList(cfg.glyphNames);
  if (names.length === 0) return errorResult("invalid_input", "unicode-point-assigner requires `glyphNames` list");
  const startCp = Number(cfg.startCodePoint ?? 0xE000);

  const map: Record<string, string> = {};
  const entries: { name: string; codePoint: number; hex: string }[] = [];
  let cp = startCp;
  for (const name of names) {
    map[name] = `U+${cp.toString(16).toUpperCase()}`;
    entries.push({ name, codePoint: cp, hex: `U+${cp.toString(16).toUpperCase()}` });
    cp += 1;
  }

  const json = JSON.stringify({ startCodePoint: `U+${startCp.toString(16).toUpperCase()}`, entries }, null, 2);
  const css = entries.map((e) => `.icon-${e.name}::before { content: "\\${e.codePoint.toString(16)}"; }`).join("\n") + "\n";

  await writeFile(join(ctx.scratchDir, "unicode-mapping.json"), json, "utf8");
  await writeFile(join(ctx.scratchDir, "icon-classes.css"), css, "utf8");
  ctx.emitProgress(json.length + css.length);

  return {
    ok: true,
    outputs: { glyphCount: entries.length, firstCodePoint: entries[0]?.hex, lastCodePoint: entries[entries.length - 1]?.hex },
    fileRefs: [
      { ref: "unicode-mapping.json", bytes: Buffer.byteLength(json, "utf8"), sha256: "", mime: "application/json", filename: "unicode-mapping.json" },
      { ref: "icon-classes.css", bytes: Buffer.byteLength(css, "utf8"), sha256: "", mime: "text/css", filename: "icon-classes.css" },
    ],
    bytesProcessed: json.length + css.length,
    durationMs: Date.now() - start,
  };
}

function parseList(input: unknown): string[] {
  if (Array.isArray(input)) return input.map(String);
  if (typeof input === "string") return input.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
