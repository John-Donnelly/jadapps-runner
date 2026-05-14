/**
 * Cross-repo parity test.
 *
 * Re-runs the runner's built-in connectors against the same fixtures used by
 * the JAD Apps reference-snapshot suite, then asserts byte-for-byte equality
 * with the committed `expected.*` files in that repo.
 *
 * This catches any divergence between the runner's runner-builtin output and
 * the in-process / runner-local output produced by the JAD Apps web app, MCP
 * layer, and API engine.
 *
 * If JAD Apps isn't checked out as a sibling repo at ../JAD Apps, the suite
 * is skipped (matches the precedent set by sample-bundle.test.ts).
 *
 * To regenerate the snapshots after an intentional output change, run
 *   npx tsx scripts/gen-tool-reference-snapshots.ts
 * from the JAD Apps repo, then commit the updated expected.* files.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, copyFileSync, readFileSync, rmSync, statSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";

const JAD_REPO = resolve(__dirname, "..", "..", "JAD Apps");
const RUNNER_CONNECTORS = resolve(__dirname, "..", "src", "builtin-connectors");
const HAS_JAD = existsSync(JAD_REPO);

interface FileRefLike {
  ref: string;
  filename: string;
  bytes: number;
  sha256: string;
  mime: string;
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

function buildCtx(fixturePath: string, inputs: Record<string, unknown> = {}) {
  const scratchDir = mkdtempSync(join(tmpdir(), "jr-parity-"));
  const ref = basename(fixturePath);
  copyFileSync(fixturePath, join(scratchDir, ref));
  return {
    scratchDir,
    cleanup: () => rmSync(scratchDir, { recursive: true, force: true }),
    ctx: {
      toolId: "x",
      inputs,
      fileRefs: [{ ref, filename: ref, bytes: statSync(fixturePath).size, sha256: "", mime: "" }],
      scratchDir,
      emitProgress: () => {},
    } satisfies CtxLike,
  };
}

async function runConnector(connectorFile: string, ctx: CtxLike): Promise<StepResultLike> {
  const modPath = join(RUNNER_CONNECTORS, connectorFile);
  const mod = (await import(pathToFileURL(modPath).href)) as { default: (c: CtxLike) => Promise<StepResultLike> };
  return mod.default(ctx);
}

function loadFixtureSpec(payloadDir: string): {
  scenario: string;
  options: Record<string, unknown>;
  fixturePath: string;
} {
  const payload = JSON.parse(readFileSync(join(payloadDir, "payload.json"), "utf-8")) as {
    options?: Record<string, unknown>;
    files?: string[];
  };
  return {
    scenario: basename(payloadDir),
    options: payload.options ?? {},
    fixturePath: resolve(payloadDir, payload.files?.[0] ?? ""),
  };
}

function readSnapshot(payloadDir: string): { buf: Buffer; path: string } | null {
  for (const name of ["expected.ts", "expected.stl"]) {
    const p = join(payloadDir, name);
    if (existsSync(p)) return { buf: readFileSync(p), path: p };
  }
  return null;
}

function fixturesWithSnapshots(toolDir: string): {
  payloadDir: string;
  expectedPath: string;
  expectedBuf: Buffer;
}[] {
  if (!existsSync(toolDir)) return [];
  const out: { payloadDir: string; expectedPath: string; expectedBuf: Buffer }[] = [];
  for (const entry of readdirSync(toolDir)) {
    const payloadDir = join(toolDir, entry);
    if (!statSync(payloadDir).isDirectory()) continue;
    const snap = readSnapshot(payloadDir);
    if (snap) out.push({ payloadDir, expectedPath: snap.path, expectedBuf: snap.buf });
  }
  return out;
}

async function expectByteMatch(
  connectorFile: string,
  payloadDir: string,
  expectedBuf: Buffer,
): Promise<void> {
  const spec = loadFixtureSpec(payloadDir);
  const { ctx, cleanup, scratchDir } = buildCtx(spec.fixturePath, spec.options);
  try {
    const result = await runConnector(connectorFile, ctx);
    expect(result.ok, `runner returned !ok: ${result.error?.code} ${result.error?.message ?? ""}`).toBe(true);
    expect(result.fileRefs.length, "runner emitted no fileRefs").toBeGreaterThan(0);
    const actualPath = join(scratchDir, result.fileRefs[0]!.ref);
    const actual = readFileSync(actualPath);
    if (!actual.equals(expectedBuf)) {
      // Short diff hint for failures.
      let firstDiff = -1;
      const maxLen = Math.max(actual.length, expectedBuf.length);
      for (let i = 0; i < maxLen; i++) {
        if (actual[i] !== expectedBuf[i]) { firstDiff = i; break; }
      }
      expect.fail(
        `byte mismatch: lenA=${actual.length} lenE=${expectedBuf.length} firstDiff@${firstDiff}\n` +
          `Regenerate the JAD Apps snapshot if this change is intentional:\n` +
          `  cd ../JAD\\ Apps && npx tsx scripts/gen-tool-reference-snapshots.ts`,
      );
    }
  } finally {
    cleanup();
  }
}

describe.skipIf(!HAS_JAD)("Built-in connectors — JAD Apps snapshot parity", () => {
  const stlAsciiDir = join(JAD_REPO, "test-payloads", "3d", "stl-ascii-to-binary");
  const stlBinDir = join(JAD_REPO, "test-payloads", "3d", "stl-binary-to-ascii");
  const trpcDir = join(JAD_REPO, "test-payloads", "excel", "excel-trpc-router");

  describe("stl-ascii-to-binary", () => {
    for (const { payloadDir, expectedBuf } of fixturesWithSnapshots(stlAsciiDir)) {
      it(`${basename(payloadDir)} matches expected.stl`, async () => {
        await expectByteMatch("stl-ascii-to-binary.ts", payloadDir, expectedBuf);
      });
    }
  });

  describe("stl-binary-to-ascii", () => {
    for (const { payloadDir, expectedBuf } of fixturesWithSnapshots(stlBinDir)) {
      it(`${basename(payloadDir)} matches expected.stl`, async () => {
        await expectByteMatch("stl-binary-to-ascii.ts", payloadDir, expectedBuf);
      });
    }
  });

  describe("excel-trpc-router", () => {
    for (const { payloadDir, expectedBuf } of fixturesWithSnapshots(trpcDir)) {
      it(`${basename(payloadDir)} matches expected.ts`, async () => {
        await expectByteMatch("excel-trpc-router.ts", payloadDir, expectedBuf);
      });
    }
  });

  it("error-path fixtures: stl-ascii-to-binary rejects binary input", async () => {
    const dir = join(stlAsciiDir, "05-already-binary");
    if (!existsSync(dir)) return;
    const spec = loadFixtureSpec(dir);
    const { ctx, cleanup } = buildCtx(spec.fixturePath, spec.options);
    try {
      const result = await runConnector("stl-ascii-to-binary.ts", ctx);
      expect(result.ok).toBe(false);
      expect(result.error?.message ?? "").toMatch(/binary STL/i);
    } finally {
      cleanup();
    }
  });

  it("error-path fixtures: stl-binary-to-ascii rejects ASCII input", async () => {
    const dir = join(stlBinDir, "04-already-ascii");
    if (!existsSync(dir)) return;
    const spec = loadFixtureSpec(dir);
    const { ctx, cleanup } = buildCtx(spec.fixturePath, spec.options);
    try {
      const result = await runConnector("stl-binary-to-ascii.ts", ctx);
      expect(result.ok).toBe(false);
      expect(result.error?.message ?? "").toMatch(/already ASCII/i);
    } finally {
      cleanup();
    }
  });

  it("error-path fixtures: stl-binary-to-ascii rejects truncated bytes", async () => {
    const dir = join(stlBinDir, "05-invalid-stl");
    if (!existsSync(dir)) return;
    const spec = loadFixtureSpec(dir);
    const { ctx, cleanup } = buildCtx(spec.fixturePath, spec.options);
    try {
      const result = await runConnector("stl-binary-to-ascii.ts", ctx);
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });
});

if (!HAS_JAD) {
  describe("Built-in connectors — JAD Apps snapshot parity", () => {
    it.skip(`JAD Apps repo not found at ${JAD_REPO} — cross-repo parity skipped`, () => {});
  });
}
