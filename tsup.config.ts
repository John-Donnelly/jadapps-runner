import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    runner: "src/runner.ts",
    "runtime/worker": "src/runtime/worker.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: { entry: { runner: "src/runner.ts" } },
  shims: true,
  splitting: false,
});
