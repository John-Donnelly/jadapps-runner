import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScratchManager } from "../src/runtime/scratch";

import {
  // @ts-expect-error — internal helpers exposed for white-box tests.
  __test_normaliseInputContent as normaliseInputContent,
  // @ts-expect-error — internal helpers exposed for white-box tests.
  __test_materializeContentInput as materializeContentInput,
  // @ts-expect-error — internal helpers exposed for white-box tests.
  __test_inferContentFilename as inferContentFilename,
  // @ts-expect-error — internal helpers exposed for white-box tests.
  __test_resolveInputPath as resolveInputPath,
} from "../src/mcp/tools/tool";

let tmp: string;
let scratch: ScratchManager;
let scratchDir: string;
const runId = "test-run";

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "mcp-tool-content-"));
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

describe("inferContentFilename", () => {
  it("picks an extension from mimeType when supplied", () => {
    expect(inferContentFilename("csv-cleaner", "text/csv")).toBe("input.csv");
    expect(inferContentFilename("any-slug", "application/json")).toBe("input.json");
    expect(inferContentFilename("md-emoji-remover", "text/markdown")).toBe("input.md");
  });

  it("falls back to the slug's family prefix when no mimeType", () => {
    expect(inferContentFilename("csv-cleaner", undefined)).toBe("input.csv");
    expect(inferContentFilename("json-validator", undefined)).toBe("input.json");
    expect(inferContentFilename("md-toc-generator", undefined)).toBe("input.md");
    expect(inferContentFilename("pdf-merge", undefined)).toBe("input.pdf");
    expect(inferContentFilename("xml-to-json", undefined)).toBe("input.xml");
  });

  it("returns .txt for unknown families and .bin for binary-by-default families", () => {
    expect(inferContentFilename("totally-unknown-tool", undefined)).toBe("input.txt");
    expect(inferContentFilename("image-resizer", undefined)).toBe("input.bin");
    expect(inferContentFilename("audio-compressor", undefined)).toBe("input.bin");
  });
});

describe("normaliseInputContent", () => {
  it("returns [] when no content is supplied", () => {
    expect(normaliseInputContent(undefined, "csv-cleaner")).toEqual([]);
    expect(normaliseInputContent(null, "csv-cleaner")).toEqual([]);
  });

  it("wraps a bare string into a single entry with an inferred filename", () => {
    const out = normaliseInputContent("name,age\nAlice,30\n", "csv-cleaner");
    expect(out).toEqual([
      { filename: "input.csv", content: "name,age\nAlice,30\n", mimeType: undefined },
    ]);
  });

  it("passes arrays through as-is, requiring filename + content fields", () => {
    const out = normaliseInputContent(
      [
        { filename: "a.csv", content: "x,y\n1,2\n", mimeType: "text/csv" },
        { filename: "b.md", content: "# title\n" },
      ],
      "csv-merger",
    );
    expect(out).toEqual([
      { filename: "a.csv", content: "x,y\n1,2\n", mimeType: "text/csv" },
      { filename: "b.md", content: "# title\n", mimeType: undefined },
    ]);
  });

  it("throws if an array entry is malformed", () => {
    expect(() =>
      normaliseInputContent([{ filename: "x.csv" /* no content */ }], "csv-cleaner"),
    ).toThrow(/filename, content/);
  });
});

describe("materializeContentInput", () => {
  it("writes the string to scratch and returns a usable FileRef", async () => {
    const ref = await materializeContentInput(
      { filename: "messy.csv", content: "name,age\nAlice,30\n", mimeType: "text/csv" },
      scratchDir,
    );
    expect(ref.filename).toBe("messy.csv");
    expect(ref.bytes).toBe(18);
    expect(ref.mime).toBe("text/csv");
    expect(ref.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(scratchDir, ref.ref), "utf8")).toBe("name,age\nAlice,30\n");
  });

  it("guesses a mimeType from the filename when not supplied", async () => {
    const ref = await materializeContentInput(
      { filename: "data.json", content: "{}", mimeType: undefined },
      scratchDir,
    );
    expect(ref.mime).toBe("application/json");
  });
});

describe("resolveInputPath", () => {
  it("returns absolute paths unchanged", () => {
    const abs = join(tmp, "fixture.csv");
    writeFileSync(abs, "x\n", "utf8");
    expect(resolveInputPath(abs, undefined)).toEqual({ path: abs });
  });

  it("rejects relative paths without cwd, pointing at the fix", () => {
    const result = resolveInputPath("data/file.csv", undefined);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/'cwd'/);
    }
  });

  it("resolves relative paths against an absolute cwd", () => {
    const result = resolveInputPath("./data/file.csv", "C:/dev/myproject");
    if ("error" in result) throw new Error("unexpected error: " + result.error);
    // Normalise separators for cross-platform comparison
    expect(result.path.replace(/\\/g, "/").endsWith("dev/myproject/data/file.csv")).toBe(true);
  });
});
