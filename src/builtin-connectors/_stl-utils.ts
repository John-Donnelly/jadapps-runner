/**
 * Shared helpers for STL-based connectors. Hand-rolled binary/ASCII
 * STL parser with no third-party deps.
 */

export interface Triangle { nx: number; ny: number; nz: number; v: [number, number, number][] }

export function isBinaryStl(buf: Buffer): boolean {
  if (buf.length < 84) return false;
  const tris = buf.readUInt32LE(80);
  return buf.length >= 84 + tris * 50;
}

export function parseStl(buf: Buffer): Triangle[] {
  if (isBinaryStl(buf)) return parseBinaryStl(buf);
  return parseAsciiStl(buf.toString("utf8"));
}

export function parseBinaryStl(buf: Buffer): Triangle[] {
  const tris = buf.readUInt32LE(80);
  const result: Triangle[] = [];
  for (let i = 0; i < tris; i++) {
    const o = 84 + i * 50;
    if (o + 50 > buf.length) break;
    const nx = buf.readFloatLE(o), ny = buf.readFloatLE(o + 4), nz = buf.readFloatLE(o + 8);
    const v: [number, number, number][] = [];
    for (let vi = 0; vi < 3; vi++) {
      const p = o + 12 + vi * 12;
      v.push([buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8)]);
    }
    result.push({ nx, ny, nz, v });
  }
  return result;
}

export function parseAsciiStl(text: string): Triangle[] {
  const tris: Triangle[] = [];
  const tokens = text.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "facet" && tokens[i + 1] === "normal") {
      const nx = parseFloat(tokens[i + 2] ?? "0"), ny = parseFloat(tokens[i + 3] ?? "0"), nz = parseFloat(tokens[i + 4] ?? "0");
      const v: [number, number, number][] = [];
      let j = i + 5;
      while (j < tokens.length && v.length < 3) {
        if (tokens[j] === "vertex") {
          v.push([parseFloat(tokens[j + 1] ?? "0"), parseFloat(tokens[j + 2] ?? "0"), parseFloat(tokens[j + 3] ?? "0")]);
          j += 4;
        } else j += 1;
      }
      if (v.length === 3) tris.push({ nx, ny, nz, v });
      i = j;
    }
  }
  return tris;
}

export function writeBinaryStl(tris: Triangle[]): Buffer {
  const out = Buffer.alloc(84 + tris.length * 50);
  out.writeUInt32LE(tris.length, 80);
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i]!;
    const o = 84 + i * 50;
    out.writeFloatLE(t.nx, o); out.writeFloatLE(t.ny, o + 4); out.writeFloatLE(t.nz, o + 8);
    for (let v = 0; v < 3; v++) {
      const p = o + 12 + v * 12;
      out.writeFloatLE(t.v[v]![0], p);
      out.writeFloatLE(t.v[v]![1], p + 4);
      out.writeFloatLE(t.v[v]![2], p + 8);
    }
  }
  return out;
}

export function computeBoundingBox(tris: Triangle[]): { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] } {
  if (tris.length === 0) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const t of tris) for (const [x, y, z] of t.v) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], size: [maxX - minX, maxY - minY, maxZ - minZ] };
}

export function triangleArea(t: Triangle): number {
  const [a, b, c] = t.v;
  if (!a || !b || !c) return 0;
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cross = [
    ab[1]! * ac[2]! - ab[2]! * ac[1]!,
    ab[2]! * ac[0]! - ab[0]! * ac[2]!,
    ab[0]! * ac[1]! - ab[1]! * ac[0]!,
  ];
  return 0.5 * Math.sqrt(cross[0]! ** 2 + cross[1]! ** 2 + cross[2]! ** 2);
}

export function signedTetraVolume(t: Triangle): number {
  const [a, b, c] = t.v;
  if (!a || !b || !c) return 0;
  return (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
}
