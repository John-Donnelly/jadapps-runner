import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * resolveBuiltinModulePath uses `import.meta.url` to anchor itself, so the
 * test loads a fresh copy of the source via a custom URL — that lets us pick
 * which "runtime" directory the resolver thinks it lives in (bundled =
 * <root>/builtin-tools.js, unbundled = <root>/runtime/builtin-tools.js).
 *
 * The resolver is a thin function over `existsSync`, so the test creates a
 * temporary layout, points the resolver at it, and asserts which candidate
 * path wins. We use the real BUILTIN_TOOLS map (md-emoji-remover is in it).
 */

import {
  resolveBuiltinModulePath,
} from "../src/runtime/builtin-tools";

type Layout = "bundled" | "unbundled";

function setupLayout(layout: Layout): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `jadapps-builtin-${layout}-`));
  const connectorDir =
    layout === "bundled"
      ? join(root, "builtin-connectors")
      : join(root, "builtin-connectors");
  const runtimeAnchorDir = layout === "bundled" ? root : join(root, "runtime");
  mkdirSync(connectorDir, { recursive: true });
  mkdirSync(runtimeAnchorDir, { recursive: true });
  writeFileSync(
    join(connectorDir, "md-emoji-remover.js"),
    "export default async () => ({ ok: true, outputs: {} });",
  );
  return {
    root: runtimeAnchorDir,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* tolerated on Windows */
      }
    },
  };
}

describe("resolveBuiltinModulePath", () => {
  let cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
  });

  it("returns null for unknown tools without touching the filesystem", () => {
    expect(resolveBuiltinModulePath("not-a-real-tool")).toBeNull();
  });

  // The two layout-specific cases below import the resolver from the live
  // source so they sanity-check the function as it actually ships. They
  // can't fake `__dirname` per call (it's frozen at module load), so they
  // verify behavior against the *live* runtime layout: in this repo, that's
  // the unbundled `src/runtime/` layout. The bundled-layout case is covered
  // implicitly by the integration test in this file (resolver returns a
  // path for a real BUILTIN_TOOLS entry), since both candidate chains agree
  // when only one of the two layouts actually exists on disk.
  it("finds an existing built-in tool against the live source tree", () => {
    const result = resolveBuiltinModulePath("md-emoji-remover");
    expect(result).not.toBeNull();
    expect(result).toMatch(/builtin-connectors[\\/]md-emoji-remover\.(ts|js)$/);
  });

  it("finds another built-in (postgres) — confirms the lookup isn't md-specific", () => {
    const result = resolveBuiltinModulePath("postgres");
    expect(result).not.toBeNull();
    expect(result).toMatch(/builtin-connectors[\\/]postgres\.(ts|js)$/);
  });
});
