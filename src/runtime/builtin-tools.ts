import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Built-in tools ship inside the @jadapps/runner package and run via the same
 * worker pool as dynamically-loaded bundles. Unlike CDN bundles they can
 * `import("pg")` / `import("mongodb")` etc. because they run from the runner's
 * own node_modules tree.
 *
 * Adding a new built-in tool:
 *   1. Add `src/builtin-connectors/<name>.ts` with a default export `(ctx) => Promise<StepResult>`
 *   2. Add the entry to BUILTIN_TOOLS below
 *   3. Add the tsup entry in tsup.config.ts
 *   4. Add the corresponding tool-registry entry on the website with runtime "runner-builtin"
 */
export const BUILTIN_TOOLS: Record<string, { module: string; npmDeps: string[] }> = {
  postgres: {
    module: "postgres",
    npmDeps: ["pg"],
  },
  mongodb: {
    module: "mongodb",
    npmDeps: ["mongodb"],
  },
  redis: {
    module: "redis",
    npmDeps: ["redis"],
  },
  smtp: {
    module: "smtp",
    npmDeps: ["nodemailer"],
  },
  // Markdown family (batch 1 of 3) — pure-Node string transforms.
  "md-emoji-remover": { module: "md-emoji-remover", npmDeps: [] },
  "md-bold-italic-cleaner": { module: "md-bold-italic-cleaner", npmDeps: [] },
  "md-frontmatter-builder": { module: "md-frontmatter-builder", npmDeps: [] },
  "md-toc-generator": { module: "md-toc-generator", npmDeps: [] },
  "md-heading-shifter": { module: "md-heading-shifter", npmDeps: [] },
  "md-image-path-rewriter": { module: "md-image-path-rewriter", npmDeps: [] },
  "md-merger": { module: "md-merger", npmDeps: [] },
  "md-minifier": { module: "md-minifier", npmDeps: [] },
  "md-secret-redactor": { module: "md-secret-redactor", npmDeps: [] },
  "md-list-fixer": { module: "md-list-fixer", npmDeps: [] },
  // Markdown family (batch 2 of 3) — pure-Node string transforms.
  "md-prettifier": { module: "md-prettifier", npmDeps: [] },
  "md-lint": { module: "md-lint", npmDeps: [] },
  "md-diff": { module: "md-diff", npmDeps: [] },
  "md-link-validator": { module: "md-link-validator", npmDeps: [] },
  "md-from-text": { module: "md-from-text", npmDeps: [] },
  "md-splitter": { module: "md-splitter", npmDeps: [] },
  "md-table-repair": { module: "md-table-repair", npmDeps: [] },
  "md-math-normalizer": { module: "md-math-normalizer", npmDeps: [] },
  "md-code-block-tagger": { module: "md-code-block-tagger", npmDeps: [] },
  "md-footnote-linker": { module: "md-footnote-linker", npmDeps: [] },
  "md-ref-link-converter": { module: "md-ref-link-converter", npmDeps: [] },
  "md-gfm-to-commonmark": { module: "md-gfm-to-commonmark", npmDeps: [] },
  // Markdown family (batch 3 of 3) — uses `marked` for HTML/format conversion.
  "md-to-html": { module: "md-to-html", npmDeps: ["marked"] },
  "md-to-github-html": { module: "md-to-github-html", npmDeps: ["marked"] },
  "md-to-reveal": { module: "md-to-reveal", npmDeps: ["marked"] },
  "md-to-slack": { module: "md-to-slack", npmDeps: [] },
  "md-to-jira": { module: "md-to-jira", npmDeps: [] },
  // Excel family (batch 1 of 3) — uses `exceljs` for .xlsx parse/write.
  "excel-to-csv": { module: "excel-to-csv", npmDeps: ["exceljs"] },
  "excel-to-json": { module: "excel-to-json", npmDeps: ["exceljs"] },
  "excel-base64-encoder": { module: "excel-base64-encoder", npmDeps: [] },
  "excel-format-inspector": { module: "excel-format-inspector", npmDeps: ["exceljs"] },
  "excel-comment-purger": { module: "excel-comment-purger", npmDeps: ["exceljs"] },
  "excel-app-metadata-wiper": { module: "excel-app-metadata-wiper", npmDeps: ["exceljs"] },
  "excel-hidden-sheet-destroyer": { module: "excel-hidden-sheet-destroyer", npmDeps: ["exceljs"] },
  "excel-vba-macro-stripper": { module: "excel-vba-macro-stripper", npmDeps: ["exceljs"] },
  "excel-external-link-auditor": { module: "excel-external-link-auditor", npmDeps: ["exceljs"] },
  "excel-formula-to-value": { module: "excel-formula-to-value", npmDeps: ["exceljs"] },
  "excel-date-standardizer": { module: "excel-date-standardizer", npmDeps: ["exceljs"] },
  "excel-regex-extractor": { module: "excel-regex-extractor", npmDeps: ["exceljs"] },
};

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the absolute filesystem path of a built-in tool's module.
 * In dev (tsx) we serve from src/ so consumers can hot-edit; in production
 * we serve the tsup-compiled JS from dist/builtin-connectors/.
 *
 * Returns null if the tool isn't a built-in (caller falls back to the
 * dynamic CDN bundle path).
 */
export function resolveBuiltinModulePath(toolId: string): string | null {
  const entry = BUILTIN_TOOLS[toolId];
  if (!entry) return null;

  // __dirname is dist/runtime in production, src/runtime in dev (tsx).
  // Walk up one to land at dist/ or src/, then into builtin-connectors/.
  const root = join(__dirname, "..");
  const ext = process.env.JADAPPS_RUNNER_DEV === "true" ? ".ts" : ".js";
  const candidate = join(root, "builtin-connectors", `${entry.module}${ext}`);
  if (existsSync(candidate)) return candidate;

  // Fallback: try the other extension (handles edge cases where the env var
  // isn't set the way we expect, e.g. `npm test` on a built artifact).
  const fallback = join(
    root,
    "builtin-connectors",
    `${entry.module}${ext === ".ts" ? ".js" : ".ts"}`,
  );
  return existsSync(fallback) ? fallback : null;
}

export function isBuiltinTool(toolId: string): boolean {
  return toolId in BUILTIN_TOOLS;
}
