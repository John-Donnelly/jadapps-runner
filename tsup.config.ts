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
    "builtin-connectors/md-emoji-remover": "src/builtin-connectors/md-emoji-remover.ts",
    "builtin-connectors/md-bold-italic-cleaner": "src/builtin-connectors/md-bold-italic-cleaner.ts",
    "builtin-connectors/md-frontmatter-builder": "src/builtin-connectors/md-frontmatter-builder.ts",
    "builtin-connectors/md-toc-generator": "src/builtin-connectors/md-toc-generator.ts",
    "builtin-connectors/md-heading-shifter": "src/builtin-connectors/md-heading-shifter.ts",
    "builtin-connectors/md-image-path-rewriter": "src/builtin-connectors/md-image-path-rewriter.ts",
    "builtin-connectors/md-merger": "src/builtin-connectors/md-merger.ts",
    "builtin-connectors/md-minifier": "src/builtin-connectors/md-minifier.ts",
    "builtin-connectors/md-secret-redactor": "src/builtin-connectors/md-secret-redactor.ts",
    "builtin-connectors/md-list-fixer": "src/builtin-connectors/md-list-fixer.ts",
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
