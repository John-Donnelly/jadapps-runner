/**
 * stl-ascii-to-binary: converts an ASCII STL to binary STL.
 *
 * Output is byte-identical to the in-process implementation in JAD Apps
 * (lib/3d/mesh-processor.ts::convertStlAsciiToBinary). Verified by the
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

export default async function stlAsciiToBinary(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "Upload an STL file.");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (!isAsciiStl(ab)) {
    return errorResult(
      "not_ascii_stl",
      "This file is already binary STL. Use the STL Binary → ASCII tool instead.",
    );
  }

  const positions = parseAsciiStlPositions(buf.toString("utf-8"));
  if (positions.length === 0) {
    return errorResult("invalid_stl", "No triangles parsed; input may be invalid ASCII STL.");
  }

  const out = writeBinaryStl(positions);
  const stem = getStemName(ref.filename ?? ref.ref);
  const outRef = `${stem}.binary.stl`;
  await writeFile(join(ctx.scratchDir, outRef), out);

  const triCount = positions.length / 9;
  return {
    ok: true,
    outputs: {
      triangleCount: triCount,
      inputBytes: buf.length,
      outputBytes: out.length,
      reduction: buf.length > 0 ? Math.round((1 - out.length / buf.length) * 100) : 0,
    },
    fileRefs: [{ ref: outRef, bytes: out.length, sha256: "", mime: "model/stl", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

/** Detect ASCII vs binary STL — mirrors lib/3d/mesh-processor.ts::isAsciiStl. */
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
 * Parse ASCII STL into a Float32Array of vertex positions (9 floats per
 * triangle). Matches three.js STLLoader's parse order so the resulting bytes
 * are byte-identical to the in-process pipeline.
 *
 * IMPORTANT: uses Float32Array so values are truncated to single-precision,
 * mirroring three.js's geometry storage. Without this, the cross-product
 * normals would compute on doubles and produce off-by-ULP bytes.
 */
function parseAsciiStlPositions(text: string): Float32Array {
  const positions: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    positions.push(parseFloat(m[1]!), parseFloat(m[2]!), parseFloat(m[3]!));
  }
  return new Float32Array(positions);
}

/** Mirror lib/3d/mesh-processor.ts::writeBinaryStl exactly. */
function writeBinaryStl(positions: Float32Array): Buffer {
  const triCount = positions.length / 9;
  const buf = Buffer.alloc(84 + triCount * 50);
  const header = "JAD Apps STL exporter";
  for (let i = 0; i < header.length && i < 80; i++) buf[i] = header.charCodeAt(i);
  buf.writeUInt32LE(triCount, 80);

  let off = 84;
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

    buf.writeFloatLE(nx, off); off += 4;
    buf.writeFloatLE(ny, off); off += 4;
    buf.writeFloatLE(nz, off); off += 4;
    buf.writeFloatLE(ax, off); off += 4;
    buf.writeFloatLE(ay, off); off += 4;
    buf.writeFloatLE(az, off); off += 4;
    buf.writeFloatLE(bx, off); off += 4;
    buf.writeFloatLE(by, off); off += 4;
    buf.writeFloatLE(bz, off); off += 4;
    buf.writeFloatLE(cx, off); off += 4;
    buf.writeFloatLE(cy, off); off += 4;
    buf.writeFloatLE(cz, off); off += 4;
    off += 2; // attribute byte count — already zero from Buffer.alloc
  }
  return buf;
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
