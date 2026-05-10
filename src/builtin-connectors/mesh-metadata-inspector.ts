/**
 * mesh-metadata-inspector: comprehensive STL inspection — header text,
 * triangle count, bounding box, watertight check, vertex count.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";
import { parseStl, computeBoundingBox, isBinaryStl } from "./_stl-utils.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function meshMetadataInspector(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "mesh-metadata-inspector requires one STL input");
  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);
  const isBinary = isBinaryStl(buf);
  const headerText = isBinary ? buf.subarray(0, 80).toString("ascii").replace(/\0+$/g, "") : buf.subarray(0, 80).toString("utf8").split("\n")[0];
  const tris = parseStl(buf);
  const bb = computeBoundingBox(tris);
  const verts = new Set<string>();
  const edges = new Map<string, number>();
  for (const t of tris) {
    const keys = t.v.map((v) => v.map((c) => c.toFixed(5)).join(","));
    for (const k of keys) verts.add(k);
    for (let i = 0; i < 3; i++) {
      const a = keys[i]!, b = keys[(i + 1) % 3]!;
      const ek = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(ek, (edges.get(ek) ?? 0) + 1);
    }
  }
  const watertight = [...edges.values()].every((c) => c === 2);
  const json = JSON.stringify({
    file: ref.filename ?? ref.ref,
    encoding: isBinary ? "binary" : "ascii",
    header: headerText,
    triangleCount: tris.length,
    uniqueVertices: verts.size,
    edgeCount: edges.size,
    boundingBox: bb,
    watertight,
  }, null, 2);
  const outRef = "mesh-metadata.json";
  await writeFile(join(ctx.scratchDir, outRef), json, "utf8");
  return { ok: true, outputs: { encoding: isBinary ? "binary" : "ascii", triangleCount: tris.length, watertight }, fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(json, "utf8"), sha256: "", mime: "application/json", filename: outRef }], bytesProcessed: totalIn, durationMs: Date.now() - start };
}

function sizeOrFallback(path: string, fallback: number): number { try { return statSync(path).size; } catch { return fallback; } }
function errorResult(code: string, message: string): StepResult { return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } }; }
