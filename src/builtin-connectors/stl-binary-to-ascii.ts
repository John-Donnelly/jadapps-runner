/**
 * stl-binary-to-ascii: converts a binary STL to ASCII STL.
 *
 * Output is byte-identical to the in-process implementation in JAD Apps
 * (lib/3d/mesh-processor.ts::convertStlBinaryToAscii). Verified by the
 * reference-snapshot lock test in the main repo.
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

export default async function stlBinaryToAscii(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "Upload an STL file.");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (isAsciiStl(ab)) {
    return errorResult("not_binary_stl", "This file is already ASCII STL.");
  }
  if (buf.length < 84) {
    return errorResult("invalid_stl", "Input is too small to be a binary STL.");
  }

  const positions = parseBinaryStlPositions(buf);
  const stem = getStemName(ref.filename ?? ref.ref);
  const out = writeAsciiStl(positions, stem);
  const outRef = `${stem}.ascii.stl`;
  await writeFile(join(ctx.scratchDir, outRef), out, "utf8");

  const triCount = positions.length / 9;
  return {
    ok: true,
    outputs: {
      triangleCount: triCount,
      inputBytes: buf.length,
      outputBytes: Buffer.byteLength(out, "utf8"),
    },
    fileRefs: [{
      ref: outRef,
      bytes: Buffer.byteLength(out, "utf8"),
      sha256: "",
      mime: "model/stl",
      filename: outRef,
    }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function isAsciiStl(ab: ArrayBuffer): boolean {
  const head = new Uint8Array(ab, 0, Math.min(80, ab.byteLength));
  const text = new TextDecoder().decode(head).trim().toLowerCase();
  if (!text.startsWith("solid")) return false;
  if (ab.byteLength < 84) return true;
  const dv = new DataView(ab);
  const triCount = dv.getUint32(80, true);
  return ab.byteLength !== 84 + triCount * 50;
}

/**
 * Parse a binary STL's triangle vertices into a Float32Array (9 floats per
 * triangle). The 12-byte face normal is discarded — the writer recomputes
 * normals from the positions, matching the in-process implementation.
 */
function parseBinaryStlPositions(buf: Buffer): Float32Array {
  const triCount = buf.readUInt32LE(80);
  const positions = new Float32Array(triCount * 9);
  let pi = 0;
  for (let t = 0; t < triCount; t++) {
    const o = 84 + t * 50;
    if (o + 50 > buf.length) break;
    for (let v = 0; v < 3; v++) {
      const p = o + 12 + v * 12;
      positions[pi++] = buf.readFloatLE(p);
      positions[pi++] = buf.readFloatLE(p + 4);
      positions[pi++] = buf.readFloatLE(p + 8);
    }
  }
  return positions;
}

/** Mirror lib/3d/mesh-processor.ts::writeAsciiStl exactly (no trailing newline). */
function writeAsciiStl(positions: Float32Array, name: string): string {
  const lines: string[] = [`solid ${name}`];
  const triCount = positions.length / 9;
  for (let t = 0; t < triCount; t++) {
    const i = t * 9;
    const ax = positions[i]!,     ay = positions[i + 1]!, az = positions[i + 2]!;
    const bx = positions[i + 3]!, by = positions[i + 4]!, bz = positions[i + 5]!;
    const cx = positions[i + 6]!, cy = positions[i + 7]!, cz = positions[i + 8]!;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    lines.push(`  facet normal ${nx} ${ny} ${nz}`);
    lines.push("    outer loop");
    lines.push(`      vertex ${ax} ${ay} ${az}`);
    lines.push(`      vertex ${bx} ${by} ${bz}`);
    lines.push(`      vertex ${cx} ${cy} ${cz}`);
    lines.push("    endloop");
    lines.push("  endfacet");
  }
  lines.push(`endsolid ${name}`);
  return lines.join("\n");
}

function getStemName(filename: string): string {
  if (!filename) return "model";
  const slash = filename.lastIndexOf("/");
  const base = slash >= 0 ? filename.slice(slash + 1) : filename;
  return base.replace(/\.[^.]+$/, "") || "model";
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
