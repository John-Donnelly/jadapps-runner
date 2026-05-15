/**
 * Tests for the orientation-optimizer built-in connector.
 *
 * Covers: output shape, all 6 unique up-direction orientations, the score
 * formula (overhang*5 + footprint*0.001 - bedContact*0.05), bed-contact vs
 * overhang classification, and the 3D-printing heuristic (a flat plate
 * prints flat; a tall column prints on its side).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CONNECTOR_PATH = resolve(__dirname, "..", "src", "builtin-connectors", "orientation-optimizer.ts");

interface FileRefLike {
  ref: string; filename: string; bytes: number; sha256: string; mime: string;
}
interface CtxLike {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRefLike[];
  scratchDir: string;
  emitProgress: (n: number) => void;
}
interface StepResultLike {
  ok: boolean;
  outputs: Record<string, unknown>;
  fileRefs: { ref: string; bytes: number; filename: string }[];
  bytesProcessed: number;
  durationMs: number;
  error?: { code: string; message: string };
}
interface Evaluation {
  rotation: string;
  score: number;
  supportArea: number;
  overhangArea: number;
  bedContactArea: number;
  footprintArea: number;
}
interface ConnectorOutput {
  file: string;
  recommendedRotation: string;
  note: string;
  evaluations: Evaluation[];
}

type Vec3 = [number, number, number];

/** Build a binary STL buffer from CCW-wound triangles with outward normals. */
function makeBinaryStl(triangles: [Vec3, Vec3, Vec3][]): Buffer {
  const triCount = triangles.length;
  const out = Buffer.alloc(84 + triCount * 50);
  out.writeUInt32LE(triCount, 80);
  for (let i = 0; i < triCount; i++) {
    const [a, b, c] = triangles[i]!;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const o = 84 + i * 50;
    out.writeFloatLE(nx, o); out.writeFloatLE(ny, o + 4); out.writeFloatLE(nz, o + 8);
    for (let v = 0; v < 3; v++) {
      const p = o + 12 + v * 12;
      const vert = [a, b, c][v]!;
      out.writeFloatLE(vert[0], p);
      out.writeFloatLE(vert[1], p + 4);
      out.writeFloatLE(vert[2], p + 8);
    }
    // last 2 bytes = attribute byte count = 0
  }
  return out;
}

/** Outward-normal axis-aligned box from (x0,y0,z0) to (x1,y1,z1). */
function boxTriangles(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): [Vec3, Vec3, Vec3][] {
  const v: Vec3[] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  return [
    // bottom (-Z out)
    [v[0]!, v[2]!, v[1]!], [v[0]!, v[3]!, v[2]!],
    // top (+Z out)
    [v[4]!, v[5]!, v[6]!], [v[4]!, v[6]!, v[7]!],
    // -Y
    [v[0]!, v[1]!, v[5]!], [v[0]!, v[5]!, v[4]!],
    // +X
    [v[1]!, v[2]!, v[6]!], [v[1]!, v[6]!, v[5]!],
    // +Y
    [v[2]!, v[3]!, v[7]!], [v[2]!, v[7]!, v[6]!],
    // -X
    [v[3]!, v[0]!, v[4]!], [v[3]!, v[4]!, v[7]!],
  ];
}

async function run(stl: Buffer, filename = "test.stl"): Promise<{ result: StepResultLike; output: ConnectorOutput }> {
  const scratchDir = mkdtempSync(join(tmpdir(), "orient-opt-"));
  writeFileSync(join(scratchDir, filename), stl);
  const ctx: CtxLike = {
    toolId: "orientation-optimizer",
    inputs: {},
    fileRefs: [{ ref: filename, filename, bytes: stl.byteLength, sha256: "", mime: "model/stl" }],
    scratchDir,
    emitProgress: () => {},
  };
  const mod = (await import(pathToFileURL(CONNECTOR_PATH).href)) as { default: (c: CtxLike) => Promise<StepResultLike> };
  const result = await mod.default(ctx);
  let output: ConnectorOutput | undefined;
  if (result.ok && result.fileRefs.length > 0) {
    const txt = readFileSync(join(scratchDir, result.fileRefs[0]!.ref), "utf8");
    output = JSON.parse(txt) as ConnectorOutput;
  }
  rmSync(scratchDir, { recursive: true, force: true });
  if (!output) throw new Error(`Connector failed: ${result.error?.code} ${result.error?.message ?? ""}`);
  return { result, output };
}

const SIX_UNIQUE_ROTATIONS = [
  "identity",      // +Z up
  "rotate-x-180",  // -Z up
  "rotate-y-90",   // +X up
  "rotate-y-270",  // -X up
  "rotate-x-90",   // -Y up
  "rotate-x-270",  // +Y up
];

describe("orientation-optimizer — output shape", () => {
  let scratchDir = "";
  beforeEach(() => { scratchDir = ""; });
  afterEach(() => { if (scratchDir) rmSync(scratchDir, { recursive: true, force: true }); });

  it("returns ok with a JSON fileRef and a recommendedRotation", async () => {
    const cube = makeBinaryStl(boxTriangles(-1, -1, -1, 1, 1, 1));
    const { result, output } = await run(cube);
    expect(result.ok).toBe(true);
    expect(result.fileRefs.length).toBe(1);
    expect(result.fileRefs[0]!.filename).toBe("orientation.json");
    expect(SIX_UNIQUE_ROTATIONS).toContain(output.recommendedRotation);
  });

  it("emits exactly 6 evaluations covering all 6 unique up-axis directions", async () => {
    const cube = makeBinaryStl(boxTriangles(-1, -1, -1, 1, 1, 1));
    const { output } = await run(cube);
    expect(output.evaluations).toHaveLength(6);
    const labels = output.evaluations.map((e) => e.rotation).sort();
    expect(labels).toEqual([...SIX_UNIQUE_ROTATIONS].sort());
  });

  it("evaluations are sorted ascending by score (best first)", async () => {
    const col = makeBinaryStl(boxTriangles(0, 0, 0, 1, 1, 10));
    const { output } = await run(col);
    for (let i = 1; i < output.evaluations.length; i++) {
      expect(output.evaluations[i]!.score).toBeGreaterThanOrEqual(output.evaluations[i - 1]!.score);
    }
  });

  it("recommendedRotation matches evaluations[0].rotation", async () => {
    const col = makeBinaryStl(boxTriangles(0, 0, 0, 1, 1, 10));
    const { output } = await run(col);
    expect(output.recommendedRotation).toBe(output.evaluations[0]!.rotation);
  });

  it("every evaluation exposes score, overhangArea, bedContactArea, footprintArea, supportArea", async () => {
    const plate = makeBinaryStl(boxTriangles(0, 0, 0, 20, 20, 1));
    const { output } = await run(plate);
    for (const e of output.evaluations) {
      expect(Number.isFinite(e.score)).toBe(true);
      expect(e.overhangArea).toBeGreaterThanOrEqual(0);
      expect(e.bedContactArea).toBeGreaterThanOrEqual(0);
      expect(e.footprintArea).toBeGreaterThanOrEqual(0);
      // supportArea is kept as a legacy alias for overhangArea.
      expect(e.supportArea).toBeCloseTo(e.overhangArea, 5);
    }
  });

  it("score matches the documented formula", async () => {
    const plate = makeBinaryStl(boxTriangles(0, 0, 0, 20, 20, 1));
    const { output } = await run(plate);
    for (const e of output.evaluations) {
      const expected = Math.round(
        (e.overhangArea * 5 + e.footprintArea * 0.001 - e.bedContactArea * 0.05) * 100,
      ) / 100;
      expect(Math.abs(e.score - expected)).toBeLessThanOrEqual(0.05);
    }
  });
});

describe("orientation-optimizer — bed-contact vs overhang classification", () => {
  it("4×4×4 cube: bedContact = 16 mm², overhang = 0 in every orientation", async () => {
    const cube = makeBinaryStl(boxTriangles(-2, -2, -2, 2, 2, 2));
    const { output } = await run(cube);
    for (const e of output.evaluations) {
      expect(e.bedContactArea).toBeCloseTo(16, 1);
      expect(e.overhangArea).toBeCloseTo(0, 1);
      expect(e.footprintArea).toBeCloseTo(16, 1);
    }
  });

  it("1×1×10 column lying on its side: bedContact = 10 mm² along the long axis", async () => {
    const col = makeBinaryStl(boxTriangles(0, 0, 0, 1, 1, 10));
    const { output } = await run(col);
    const byRot = new Map(output.evaluations.map((e) => [e.rotation, e]));
    // rotate-y-90 maps original Z (long axis) onto X, so the new bottom is
    // the 1×10 (Y × original-Z) face — area 10.
    expect(byRot.get("rotate-y-90")!.bedContactArea).toBeCloseTo(10, 1);
    // Standing tall (identity): bed contact is the original 1×1 bottom face.
    expect(byRot.get("identity")!.bedContactArea).toBeCloseTo(1, 1);
  });
});

describe("orientation-optimizer — 3D-printing heuristic", () => {
  it("recommends lying flat for a 20×20×1 plate", async () => {
    const plate = makeBinaryStl(boxTriangles(0, 0, 0, 20, 20, 1));
    const { output } = await run(plate);
    // identity (+Z up) or rotate-x-180 (-Z up) — either keeps the long axes
    // flat on the bed. The pre-fix algorithm picked an edge-up rotation.
    expect(["identity", "rotate-x-180"]).toContain(output.recommendedRotation);
  });

  it("recommends lying down a 1×1×10 column", async () => {
    const col = makeBinaryStl(boxTriangles(0, 0, 0, 1, 1, 10));
    const { output } = await run(col);
    // Standing tall = identity or rotate-x-180. Anything else is "lying down".
    expect(output.recommendedRotation).not.toBe("identity");
    expect(output.recommendedRotation).not.toBe("rotate-x-180");
  });

  it("symmetric cube ties: all 6 scores are equal (within rounding)", async () => {
    const cube = makeBinaryStl(boxTriangles(0, 0, 0, 10, 10, 10));
    const { output } = await run(cube);
    const scores = output.evaluations.map((e) => e.score);
    expect(Math.max(...scores) - Math.min(...scores)).toBeLessThanOrEqual(0.02);
  });
});

describe("orientation-optimizer — error handling", () => {
  it("returns an error result when given no fileRefs", async () => {
    const ctx: CtxLike = {
      toolId: "orientation-optimizer",
      inputs: {},
      fileRefs: [],
      scratchDir: mkdtempSync(join(tmpdir(), "orient-opt-empty-")),
      emitProgress: () => {},
    };
    const mod = (await import(pathToFileURL(CONNECTOR_PATH).href)) as { default: (c: CtxLike) => Promise<StepResultLike> };
    const result = await mod.default(ctx);
    rmSync(ctx.scratchDir, { recursive: true, force: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("missing_input");
  });

  it("is deterministic across consecutive runs", async () => {
    const cube = makeBinaryStl(boxTriangles(-1, -1, -1, 1, 1, 1));
    const a = await run(cube, "cube-a.stl");
    const b = await run(cube, "cube-b.stl");
    // file field differs (different scratch filename) but evaluations should match.
    expect(b.output.recommendedRotation).toBe(a.output.recommendedRotation);
    expect(b.output.evaluations.map((e) => ({ ...e }))).toEqual(a.output.evaluations.map((e) => ({ ...e })));
  });
});
