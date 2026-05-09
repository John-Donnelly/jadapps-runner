import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    runner: "src/runner.ts",
    "runtime/worker": "src/runtime/worker.ts",
    "builtin-connectors/postgres": "src/builtin-connectors/postgres.ts",
    "builtin-connectors/mongodb": "src/builtin-connectors/mongodb.ts",
    "builtin-connectors/redis": "src/builtin-connectors/redis.ts",
    "builtin-connectors/smtp": "src/builtin-connectors/smtp.ts",
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
  // pg/mongodb/redis/nodemailer stay external — they're listed in dependencies
  // and must be loaded from node_modules at runtime (some have native bindings).
});
