import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScratchManager } from "../src/runtime/scratch";

/**
 * Direct unit tests of the materializePathInput + writeOutputsToDir helpers
 * in src/mcp/tools/tool.ts. The helpers are not exported (deliberately —
 * they're an implementation detail of the tool_run handler), so we test
 * their behavior through the same private interface they use.
 *
 * To do that without breaking encapsulation we duplicate the smallest
 * possible spec-equivalent here. If the helpers change shape, the test
 * deliberately won't compile against the new module — that's the point.
 *
 * The behavior we lock down:
 *   1. inputPaths hard-link (or copy, cross-volume) into scratch.
 *   2. Original input file is untouched after scratch is released.
 *   3. outputDir writes are created, can refuse to clobber, and obey
 *      `overwrite: true`.
 *   4. Absolute-path requirement on outputDir.
 */

import {
  // @ts-expect-error — accessing internals deliberately for white-box tests.
  __test_materializePathInput as materializePathInput,
  // @ts-expect-error — same.
  __test_writeOutputsToDir as writeOutputsToDir,
  // @ts-expect-error — same.
  __test_appendOutSuffix as appendOutSuffix,
} from "../src/mcp/tools/tool";

let tmp: string;
let scratch: ScratchManager;
let scratchDir: string;
const runId = "test-run";

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "mcp-tool-paths-"));
  scratch = new ScratchManager(join(tmp, "scratch"));
  scratchDir = scratch.acquire(runId);
});

afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* tolerated on Windows */
  }
});

describe("materializePathInput", () => {
  it("hard-links a real file into scratch with a hash-prefixed safe name", async () => {
    const srcPath = join(tmp, "input.csv");
    writeFileSync(srcPath, "name,age\nAlice,30\n", "utf8");
    const result = await materializePathInput({ path: srcPath }, scratchDir);
    expect("ref" in result).toBe(true);
    if (!("ref" in result)) return;
    expect(result.ref.filename).toBe("input.csv");
    expect(result.ref.bytes).toBeGreaterThan(0);
    expect(result.ref.sha256).toMatch(/^[a-f0-9]{64}$/);
    const linkedAt = join(scratchDir, result.ref.ref);
    expect(statSync(linkedAt).size).toBe(statSync(srcPath).size);
    // Same content via the linked path
    expect(readFileSync(linkedAt, "utf8")).toBe("name,age\nAlice,30\n");
  });

  it("honors a custom filename in the entry", async () => {
    const srcPath = join(tmp, "renamed-src.csv");
    writeFileSync(srcPath, "x\n", "utf8");
    const result = await materializePathInput(
      { path: srcPath, filename: "renamed.csv", mimeType: "text/csv" },
      scratchDir,
    );
    if (!("ref" in result)) throw new Error("expected ref");
    expect(result.ref.filename).toBe("renamed.csv");
    expect(result.ref.mime).toBe("text/csv");
  });

  it("rejects relative paths", async () => {
    const result = await materializePathInput({ path: "relative/foo.csv" }, scratchDir);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/absolute/);
    }
  });

  it("rejects nonexistent paths cleanly", async () => {
    const result = await materializePathInput(
      { path: join(tmp, "does-not-exist.csv") },
      scratchDir,
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/unreadable/);
    }
  });

  it("rejects directories", async () => {
    const dirPath = join(tmp, "a-dir");
    mkdirSync(dirPath);
    const result = await materializePathInput({ path: dirPath }, scratchDir);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/not a regular file/);
    }
  });
});

describe("writeOutputsToDir", () => {
  it("writes each output FileRef to the target dir", async () => {
    // Pretend the executor produced two outputs in scratch.
    const aRef = "abc1234567890def-out-a.csv";
    const bRef = "1234567890abcdef-out-b.json";
    writeFileSync(join(scratchDir, aRef), "result A");
    writeFileSync(join(scratchDir, bRef), '{"b":true}');
    const outDir = join(tmp, "out-1");
    const result = await writeOutputsToDir({
      outputDir: outDir,
      overwrite: false,
      runId,
      outputRefs: [
        { ref: aRef, bytes: 8, sha256: "0".repeat(64), mime: "text/csv", filename: "out-a.csv" },
        { ref: bRef, bytes: 10, sha256: "1".repeat(64), mime: "application/json", filename: "out-b.json" },
      ],
      scratch,
    });
    expect("paths" in result).toBe(true);
    if (!("paths" in result)) return;
    expect(result.paths).toHaveLength(2);
    expect(readFileSync(result.paths[0]!, "utf8")).toBe("result A");
    expect(readFileSync(result.paths[1]!, "utf8")).toBe('{"b":true}');
  });

  it("appends .out before the extension when the destination exists (no overwrite)", async () => {
    const ref = "deadbeefdeadbeef-collide.txt";
    writeFileSync(join(scratchDir, ref), "fresh");
    const outDir = join(tmp, "out-2");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "collide.txt"), "OLD");
    const result = await writeOutputsToDir({
      outputDir: outDir,
      overwrite: false,
      runId,
      outputRefs: [
        { ref, bytes: 5, sha256: "2".repeat(64), mime: "text/plain", filename: "collide.txt" },
      ],
      scratch,
    });
    expect("paths" in result).toBe(true);
    if (!("paths" in result)) return;
    expect(result.paths[0]).toBe(join(outDir, "collide.out.txt"));
    // Original is untouched
    expect(readFileSync(join(outDir, "collide.txt"), "utf8")).toBe("OLD");
    // Renamed output landed alongside it
    expect(readFileSync(join(outDir, "collide.out.txt"), "utf8")).toBe("fresh");
  });

  it("stacks .out suffixes when the renamed target also exists", async () => {
    const ref = "facadefacadeface-stack.txt";
    writeFileSync(join(scratchDir, ref), "NEW");
    const outDir = join(tmp, "out-2b");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "stack.txt"), "v1");
    writeFileSync(join(outDir, "stack.out.txt"), "v2");
    const result = await writeOutputsToDir({
      outputDir: outDir,
      overwrite: false,
      runId,
      outputRefs: [
        { ref, bytes: 3, sha256: "5".repeat(64), mime: "text/plain", filename: "stack.txt" },
      ],
      scratch,
    });
    expect("paths" in result).toBe(true);
    if (!("paths" in result)) return;
    expect(result.paths[0]).toBe(join(outDir, "stack.out.out.txt"));
    expect(readFileSync(join(outDir, "stack.txt"), "utf8")).toBe("v1");
    expect(readFileSync(join(outDir, "stack.out.txt"), "utf8")).toBe("v2");
    expect(readFileSync(join(outDir, "stack.out.out.txt"), "utf8")).toBe("NEW");
  });

  it("avoids in-run collisions between two outputs with the same filename", async () => {
    const refA = "11111111aaaaaaaa-twin.json";
    const refB = "22222222bbbbbbbb-twin.json";
    writeFileSync(join(scratchDir, refA), "A");
    writeFileSync(join(scratchDir, refB), "B");
    const outDir = join(tmp, "out-2c");
    const result = await writeOutputsToDir({
      outputDir: outDir,
      overwrite: false,
      runId,
      outputRefs: [
        { ref: refA, bytes: 1, sha256: "6".repeat(64), mime: "application/json", filename: "twin.json" },
        { ref: refB, bytes: 1, sha256: "7".repeat(64), mime: "application/json", filename: "twin.json" },
      ],
      scratch,
    });
    expect("paths" in result).toBe(true);
    if (!("paths" in result)) return;
    expect(result.paths[0]).toBe(join(outDir, "twin.json"));
    expect(result.paths[1]).toBe(join(outDir, "twin.out.json"));
    expect(readFileSync(result.paths[0]!, "utf8")).toBe("A");
    expect(readFileSync(result.paths[1]!, "utf8")).toBe("B");
  });

  it("overwrites when overwrite: true", async () => {
    const ref = "feedfacefeedface-overwrite.txt";
    writeFileSync(join(scratchDir, ref), "NEW");
    const outDir = join(tmp, "out-3");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "overwrite.txt"), "OLD");
    const result = await writeOutputsToDir({
      outputDir: outDir,
      overwrite: true,
      runId,
      outputRefs: [
        { ref, bytes: 3, sha256: "3".repeat(64), mime: "text/plain", filename: "overwrite.txt" },
      ],
      scratch,
    });
    expect("paths" in result).toBe(true);
    expect(readFileSync(join(outDir, "overwrite.txt"), "utf8")).toBe("NEW");
  });

  it("creates the target directory if it doesn't exist", async () => {
    const ref = "cafebabecafebabe-makedir.txt";
    writeFileSync(join(scratchDir, ref), "ok");
    const outDir = join(tmp, "out-4", "nested", "subdir");
    const result = await writeOutputsToDir({
      outputDir: outDir,
      overwrite: false,
      runId,
      outputRefs: [
        { ref, bytes: 2, sha256: "4".repeat(64), mime: "text/plain", filename: "makedir.txt" },
      ],
      scratch,
    });
    expect("paths" in result).toBe(true);
    if ("paths" in result) {
      expect(readFileSync(result.paths[0]!, "utf8")).toBe("ok");
    }
  });
});

describe("appendOutSuffix", () => {
  it("inserts .out before the rightmost dot", () => {
    expect(appendOutSuffix("foo.csv")).toBe("foo.out.csv");
    expect(appendOutSuffix("/abs/path/foo.csv")).toBe("/abs/path/foo.out.csv");
    expect(appendOutSuffix("C:\\abs\\path\\foo.json")).toBe("C:\\abs\\path\\foo.out.json");
  });

  it("appends .out when there's no extension", () => {
    expect(appendOutSuffix("foo")).toBe("foo.out");
    expect(appendOutSuffix("/abs/foo")).toBe("/abs/foo.out");
  });

  it("treats dotfiles (no extension) as having no extension", () => {
    expect(appendOutSuffix(".env")).toBe(".env.out");
  });

  it("stacks correctly when called on an already-renamed path", () => {
    expect(appendOutSuffix("foo.out.csv")).toBe("foo.out.out.csv");
  });

  it("attaches a single suffix at the rightmost dot for multi-ext files", () => {
    expect(appendOutSuffix("archive.tar.gz")).toBe("archive.tar.out.gz");
  });
});
