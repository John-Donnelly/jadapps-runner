/**
 * vertex-color-stripper: STL doesn't carry per-vertex colour by default
 * (only some non-standard extensions do). For OBJ inputs, strips any
 * "vn" / "vt" / colour annotations to leave a plain position+face mesh.
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

export default async function vertexColorStripper(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "vertex-color-stripper requires one mesh input");
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const isObj = (ref.filename ?? ref.ref).toLowerCase().endsWith(".obj");
  if (!isObj) {
    // STL has no standard vertex colour; output the input as-is, just mark it stripped.
    const outRef = (ref.filename ?? ref.ref).replace(/(\.[^.]+)$/, ".stripped$1");
    await writeFile(join(ctx.scratchDir, outRef), buf);
    return { ok: true, outputs: { input: "stl", action: "passthrough" }, fileRefs: [{ ref: outRef, bytes: buf.length, sha256: "", mime: ref.mime, filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
  }
  const text = buf.toString("utf8");
  const lines = text.split(/\r?\n/);
  let stripped = 0;
  const out = lines.map((line) => {
    const t = line.trim();
    if (t.startsWith("vn ") || t.startsWith("vt ")) { stripped += 1; return ""; }
    if (t.startsWith("v ")) {
      const parts = t.split(/\s+/);
      if (parts.length > 4) { stripped += 1; return parts.slice(0, 4).join(" "); }
    }
    return line;
  }).filter((l) => l.length > 0).join("\n") + "\n";

  const outRef = (ref.filename ?? ref.ref).replace(/\.obj$/i, ".stripped.obj");
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");
  return { ok: true, outputs: { strippedLines: stripped }, fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "model/obj", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
