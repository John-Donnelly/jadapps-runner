/**
 * svg-qr-code: generates a QR code as a vector SVG. Uses a hand-rolled QR
 * encoder for the v0.1 to avoid an extra dependency — supports up to QR
 * version 10 (~174 alphanumeric chars at level M). For longer payloads,
 * caller should chunk before encoding.
 *
 * Encoding modes implemented: byte (UTF-8). Numeric/alphanumeric paths
 * use the same byte mode for simplicity (slightly larger output).
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

export default async function svgQrCode(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const text = String(cfg.text ?? "");
  if (!text) return errorResult("invalid_config", "text is required");
  const moduleSize = Math.max(2, Math.min(40, Math.floor(Number(cfg.moduleSize ?? 8))));
  const margin = Math.max(0, Math.min(8, Math.floor(Number(cfg.margin ?? 4))));
  const dark = String(cfg.darkColor ?? "#000000");
  const light = String(cfg.lightColor ?? "#ffffff");

  const matrix = encodeQr(text);
  if (!matrix) return errorResult("payload_too_large", "input too long for v0.1 QR encoder (max ~174 chars at level M)");

  const size = matrix.length;
  const totalSize = (size + margin * 2) * moduleSize;
  const rects: string[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r]![c]) {
        const x = (c + margin) * moduleSize;
        const y = (r + margin) * moduleSize;
        rects.push(`<rect x="${x}" y="${y}" width="${moduleSize}" height="${moduleSize}"/>`);
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" width="${totalSize}" height="${totalSize}" shape-rendering="crispEdges">
  <rect width="${totalSize}" height="${totalSize}" fill="${light}"/>
  <g fill="${dark}">${rects.join("")}</g>
</svg>
`;

  const outRef = "qr.svg";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, svg, "utf8");
  ctx.emitProgress(0);

  return {
    ok: true,
    outputs: { matrixSize: size, totalPixels: totalSize, charCount: text.length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(svg, "utf8"), sha256: "", mime: "image/svg+xml", filename: outRef }],
    bytesProcessed: 0,
    durationMs: Date.now() - start,
  };
}

// Minimal QR encoder — version 1-10, error correction M, byte mode.
// Reference: ISO/IEC 18004:2015. Returns null when payload won't fit.
function encodeQr(text: string): boolean[][] | null {
  const bytes = Buffer.from(text, "utf8");
  // Pick smallest version that fits.
  const capacities = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    if (bytes.length <= capacities[v]!) { version = v; break; }
  }
  if (version === 0) return null;
  const size = 17 + version * 4;

  // Build the codeword stream: mode (4 bits = 0100) + length (8/16 bits) + data + terminator + padding.
  const lengthBits = version >= 10 ? 16 : 8;
  const totalCodewords = ECC_TOTAL[version - 1]!;
  const dataCodewords = totalCodewords - ECC_BYTES[version - 1]!;
  const totalBits = totalCodewords * 8;

  const stream = new BitStream();
  stream.write(0b0100, 4);
  stream.write(bytes.length, lengthBits);
  for (const b of bytes) stream.write(b, 8);
  // Terminator
  const remaining = totalBits - stream.length;
  stream.write(0, Math.min(4, remaining));
  while (stream.length % 8) stream.write(0, 1);
  // Pad with 0xEC, 0x11 alternating
  let padToggle = false;
  while (stream.length < dataCodewords * 8) {
    stream.write(padToggle ? 0x11 : 0xEC, 8);
    padToggle = !padToggle;
  }

  const dataBytes = stream.toBytes();
  const eccBytes = reedSolomon(dataBytes, ECC_BYTES[version - 1]!);
  const fullBytes = Buffer.concat([Buffer.from(dataBytes), Buffer.from(eccBytes)]);

  // Place modules
  const matrix: (boolean | null)[][] = Array.from({ length: size }, () => new Array(size).fill(null));
  placeFinders(matrix, size);
  placeTimingPatterns(matrix, size);
  if (version >= 2) placeAlignmentPatterns(matrix, version);
  placeFormatStub(matrix, size);
  placeData(matrix, size, fullBytes);
  // Apply mask 0 (every (r+c) even) for simplicity. Format info encodes mask 0, level M.
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isReserved(r, c, size, version) && matrix[r]![c] !== null) continue;
      if (matrix[r]![c] === null) matrix[r]![c] = false;
      if ((r + c) % 2 === 0) matrix[r]![c] = !matrix[r]![c];
    }
  }
  placeFormatBits(matrix, size, formatBits(0b00, 0));
  if (version >= 7) placeVersionBits(matrix, size, versionBits(version));
  return matrix.map((row) => row.map((v) => v === true));
}

const ECC_TOTAL = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const ECC_BYTES = [10, 16, 26, 36, 48, 64, 72, 88, 110, 130]; // level M
class BitStream { bits: number[] = []; get length(): number { return this.bits.length; } write(value: number, count: number) { for (let i = count - 1; i >= 0; i--) this.bits.push((value >> i) & 1); } toBytes(): number[] { const out: number[] = []; for (let i = 0; i < this.bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] ?? 0); out.push(b); } return out; } }
function placeFinders(m: (boolean | null)[][], size: number) {
  const placeOne = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      const inOuter = (r === 0 || r === 6 || c === 0 || c === 6) && r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      m[rr]![cc] = inOuter || inInner;
    }
  };
  placeOne(0, 0); placeOne(0, size - 7); placeOne(size - 7, 0);
}
function placeTimingPatterns(m: (boolean | null)[][], size: number) {
  for (let i = 8; i < size - 8; i++) { m[6]![i] = i % 2 === 0; m[i]![6] = i % 2 === 0; }
}
function placeAlignmentPatterns(m: (boolean | null)[][], version: number) {
  const positions = ALIGNMENT_POSITIONS[version - 1] ?? [];
  for (const r of positions) for (const c of positions) {
    if (m[r]![c] !== null) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      m[r + dr]![c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
    }
  }
}
const ALIGNMENT_POSITIONS: number[][] = [[],[ 6, 18 ],[ 6, 22 ],[ 6, 26 ],[ 6, 30 ],[ 6, 34 ],[ 6, 22, 38 ],[ 6, 24, 42 ],[ 6, 26, 46 ],[ 6, 28, 50 ]];
function placeFormatStub(m: (boolean | null)[][], size: number) {
  for (let i = 0; i < 9; i++) { if (m[8]![i] === null) m[8]![i] = false; if (m[i]![8] === null) m[i]![8] = false; }
  for (let i = 0; i < 8; i++) { if (m[8]![size - 1 - i] === null) m[8]![size - 1 - i] = false; if (m[size - 1 - i]![8] === null) m[size - 1 - i]![8] = false; }
  m[size - 8]![8] = true;
}
function placeData(m: (boolean | null)[][], size: number, bytes: Buffer) {
  let bitIndex = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let i = 0; i < size; i++) {
      const r = upward ? size - 1 - i : i;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (m[r]![c] !== null) continue;
        const byte = bytes[Math.floor(bitIndex / 8)] ?? 0;
        const bit = (byte >> (7 - (bitIndex % 8))) & 1;
        m[r]![c] = bit === 1;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}
function isReserved(r: number, c: number, size: number, version: number): boolean {
  if ((r < 9 && c < 9) || (r < 9 && c > size - 9) || (r > size - 9 && c < 9)) return true;
  if (r === 6 || c === 6) return true;
  if (version >= 2) {
    const positions = ALIGNMENT_POSITIONS[version - 1] ?? [];
    for (const ar of positions) for (const ac of positions) if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true;
  }
  return false;
}
function formatBits(level: number, mask: number): number {
  // Format: 5 bits info + 10 bits BCH error correction, XOR with 0x5412.
  const info = (level << 3) | mask;
  let bits = info << 10;
  const generator = 0b10100110111;
  for (let i = 14; i >= 10; i--) if ((bits >> i) & 1) bits ^= generator << (i - 10);
  return ((info << 10) | bits) ^ 0x5412;
}
function placeFormatBits(m: (boolean | null)[][], size: number, fmt: number) {
  for (let i = 0; i < 15; i++) {
    const bit = ((fmt >> i) & 1) === 1;
    if (i < 6) m[8]![i] = bit;
    else if (i < 8) m[8]![i + 1] = bit;
    else if (i === 8) m[7]![8] = bit;
    else m[14 - i]![8] = bit;
    if (i < 8) m[size - 1 - i]![8] = bit;
    else m[8]![size - 15 + i] = bit;
  }
}
function versionBits(version: number): number {
  let bits = version << 12;
  const generator = 0b1111100100101;
  for (let i = 17; i >= 12; i--) if ((bits >> i) & 1) bits ^= generator << (i - 12);
  return (version << 12) | bits;
}
function placeVersionBits(m: (boolean | null)[][], size: number, vbits: number) {
  for (let i = 0; i < 18; i++) {
    const bit = ((vbits >> i) & 1) === 1;
    const r = Math.floor(i / 3);
    const c = (i % 3) + size - 11;
    m[r]![c] = bit;
    m[c]![r] = bit;
  }
}
// Reed-Solomon ECC over GF(256). Generator polynomial built from
// alpha-power roots. Standard implementation.
function reedSolomon(data: number[], eccLen: number): number[] {
  const log = new Uint8Array(256), exp = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) { exp[i] = x; log[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  exp[255] = exp[0]!;
  const generator = new Uint8Array(eccLen + 1); generator[0] = 1;
  for (let i = 0; i < eccLen; i++) {
    const next = new Uint8Array(eccLen + 1);
    for (let j = 0; j < eccLen; j++) {
      next[j] = (next[j] ?? 0) ^ (generator[j] ?? 0);
      const g = generator[j];
      if (g) next[j + 1] = (next[j + 1] ?? 0) ^ (exp[(log[g]! + i) % 255] ?? 0);
    }
    generator.set(next);
  }
  const ecc = new Uint8Array(eccLen);
  for (const byte of data) {
    const factor = byte ^ ecc[0]!;
    for (let j = 0; j < eccLen - 1; j++) ecc[j] = ecc[j + 1]! ^ (factor && generator[j + 1] ? exp[(log[factor]! + log[generator[j + 1]!]!) % 255]! : 0);
    ecc[eccLen - 1] = factor && generator[eccLen] ? exp[(log[factor]! + log[generator[eccLen]!]!) % 255]! : 0;
  }
  return [...ecc];
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
