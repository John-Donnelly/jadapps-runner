import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScratchManager } from "../src/runtime/scratch";
import {
  inferContentFilename,
  materializeContentInput,
  materializePathInput,
  normaliseInputContent,
  resolveInputPath,
  writeOutputsToDir,
} from "../src/mcp/input-materialize";

let tmp: string;
let scratch: ScratchManager;
let scratchDir: string;
const runId = "test-run";

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "mcp-input-materialize-"));
  scratch = new ScratchManager(join(tmp, "scratch"));
  scratchDir = scratch.acquire(runId);
});

afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* tolerated */
  }
});

describe("inferContentFilename", () => {
  it("uses mimeType when present", () => {
    expect(inferContentFilename("csv-cleaner", "text/csv")).toBe("input.csv");
    expect(inferContentFilename("workflow-run", "application/json")).toBe("input.json");
  });
  it("falls back to slug family", () => {
    expect(inferContentFilename("csv-cleaner", undefined)).toBe("input.csv");
    expect(inferContentFilename("pdf-merge", undefined)).toBe("input.pdf");
    expect(inferContentFilename("totally-unknown-tool", undefined)).toBe("input.txt");
  });
});

describe("normaliseInputContent", () => {
  it("wraps a bare string", () => {
    expect(normaliseInputContent("name,age\nAlice,30\n", "csv-cleaner")).toEqual([
      { filename: "input.csv", content: "name,age\nAlice,30\n", mimeType: undefined },
    ]);
  });
  it("returns [] for nullish", () => {
    expect(normaliseInputContent(undefined, "csv-cleaner")).toEqual([]);
    expect(normaliseInputContent(null, "csv-cleaner")).toEqual([]);
  });
});

describe("materializeContentInput", () => {
  it("writes string + returns a valid FileRef", async () => {
    const ref = await materializeContentInput(
      { filename: "data.csv", content: "x,y\n1,2\n", mimeType: "text/csv" },
      scratchDir,
    );
    expect(ref.filename).toBe("data.csv");
    expect(ref.bytes).toBe(8);
    expect(ref.mime).toBe("text/csv");
    expect(readFileSync(join(scratchDir, ref.ref), "utf8")).toBe("x,y\n1,2\n");
  });
});

describe("materializePathInput", () => {
  it("hard-links an absolute file into scratch", async () => {
    const src = join(tmp, "src.csv");
    writeFileSync(src, "a,b\n1,2\n", "utf8");
    const result = await materializePathInput({ path: src }, scratchDir);
    if (!("ref" in result)) throw new Error("expected ref");
    expect(readFileSync(join(scratchDir, result.ref.ref), "utf8")).toBe("a,b\n1,2\n");
    expect(result.ref.bytes).toBe(8);
  });

  it("rejects relative paths", async () => {
    const result = await materializePathInput({ path: "relative/foo.csv" }, scratchDir);
    expect("error" in result).toBe(true);
  });
});

describe("resolveInputPath", () => {
  it("passes absolute paths through", () => {
    const abs = join(tmp, "x.csv");
    expect(resolveInputPath(abs, undefined)).toEqual({ path: abs });
  });
  it("resolves relative paths against cwd", () => {
    const r = resolveInputPath("./data/x.csv", "C:/dev/proj");
    if ("error" in r) throw new Error("unexpected");
    expect(r.path.replace(/\\/g, "/").endsWith("/dev/proj/data/x.csv")).toBe(true);
  });
  it("rejects relative without cwd, mentioning the fix", () => {
    const r = resolveInputPath("./x.csv", undefined);
    expect("error" in r && r.error).toMatch(/'cwd'/);
  });
});

describe("writeOutputsToDir", () => {
  it("writes outputs and refuses to clobber existing files", async () => {
    const ref = "ab12-out.csv";
    writeFileSync(join(scratchDir, ref), "result", "utf8");
    const outDir = join(tmp, "out-1");

    const first = await writeOutputsToDir({
      outputDir: outDir,
      overwrite: false,
      runId,
      outputRefs: [
        { ref, bytes: 6, sha256: "0".repeat(64), mime: "text/csv", filename: "out.csv" },
      ],
      scratch,
    });
    expect("paths" in first).toBe(true);
    if ("paths" in first) {
      expect(readFileSync(first.paths[0]!, "utf8")).toBe("result");
    }

    // Second write without overwrite → refuses
    const second = await writeOutputsToDir({
      outputDir: outDir,
      overwrite: false,
      runId,
      outputRefs: [
        { ref, bytes: 6, sha256: "0".repeat(64), mime: "text/csv", filename: "out.csv" },
      ],
      scratch,
    });
    expect("error" in second && second.error).toMatch(/already exists/);
  });

  it("creates the target dir recursively", async () => {
    const ref = "cd34-makedir.txt";
    writeFileSync(join(scratchDir, ref), "ok", "utf8");
    const outDir = join(tmp, "out-2", "nested");
    const result = await writeOutputsToDir({
      outputDir: outDir,
      overwrite: false,
      runId,
      outputRefs: [
        { ref, bytes: 2, sha256: "1".repeat(64), mime: "text/plain", filename: "makedir.txt" },
      ],
      scratch,
    });
    expect("paths" in result).toBe(true);
  });
});
