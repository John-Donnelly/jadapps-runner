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
  // Security family — node:crypto built-ins, no extra deps.
  "hash-files": { module: "hash-files", npmDeps: [] },
  "multi-hash-fingerprinter": { module: "multi-hash-fingerprinter", npmDeps: [] },
  "aes-256-encryptor": { module: "aes-256-encryptor", npmDeps: [] },
  // Audio family — pure-Node binary munging.
  "audio-id3-ghoster": { module: "audio-id3-ghoster", npmDeps: [] },
  // PDF family (batch 1 of 3) — pdf-lib for non-rendering page operations.
  "pdf-merge": { module: "pdf-merge", npmDeps: ["pdf-lib"] },
  "pdf-split": { module: "pdf-split", npmDeps: ["pdf-lib"] },
  "pdf-split-fixed": { module: "pdf-split-fixed", npmDeps: ["pdf-lib"] },
  "pdf-split-range": { module: "pdf-split-range", npmDeps: ["pdf-lib"] },
  "pdf-extract-pages": { module: "pdf-extract-pages", npmDeps: ["pdf-lib"] },
  "pdf-delete-pages": { module: "pdf-delete-pages", npmDeps: ["pdf-lib"] },
  "pdf-reorder": { module: "pdf-reorder", npmDeps: ["pdf-lib"] },
  "pdf-rotate": { module: "pdf-rotate", npmDeps: ["pdf-lib"] },
  "pdf-watermark": { module: "pdf-watermark", npmDeps: ["pdf-lib"] },
  "pdf-page-numbers": { module: "pdf-page-numbers", npmDeps: ["pdf-lib"] },
  "pdf-bates-numbering": { module: "pdf-bates-numbering", npmDeps: ["pdf-lib"] },
  "pdf-metadata-scrubber": { module: "pdf-metadata-scrubber", npmDeps: ["pdf-lib"] },
  "pdf-annotation-remover": { module: "pdf-annotation-remover", npmDeps: ["pdf-lib"] },
  "pdf-flatten": { module: "pdf-flatten", npmDeps: ["pdf-lib"] },
  "pdf-stamp": { module: "pdf-stamp", npmDeps: ["pdf-lib"] },
  // Excel family (batch 2 of 3) — analysis and transform tools.
  "excel-circular-ref-finder": { module: "excel-circular-ref-finder", npmDeps: ["exceljs"] },
  "excel-error-locator": { module: "excel-error-locator", npmDeps: ["exceljs"] },
  "excel-formula-highlighter": { module: "excel-formula-highlighter", npmDeps: ["exceljs"] },
  "excel-conditional-splitter": { module: "excel-conditional-splitter", npmDeps: ["exceljs"] },
  "excel-sheet-joiner": { module: "excel-sheet-joiner", npmDeps: ["exceljs"] },
  "excel-unpivot": { module: "excel-unpivot", npmDeps: ["exceljs"] },
  "excel-range-diff": { module: "excel-range-diff", npmDeps: ["exceljs"] },
  "excel-unit-converter": { module: "excel-unit-converter", npmDeps: ["exceljs"] },
  "excel-fuzzy-dedup": { module: "excel-fuzzy-dedup", npmDeps: ["exceljs"] },
  "excel-fuzzy-merger": { module: "excel-fuzzy-merger", npmDeps: ["exceljs"] },
  // Excel family (batch 3 of 3) — analytical and generator tools.
  "excel-formula-explainer": { module: "excel-formula-explainer", npmDeps: ["exceljs"] },
  "excel-pivot-generator": { module: "excel-pivot-generator", npmDeps: ["exceljs"] },
  "excel-goal-seek": { module: "excel-goal-seek", npmDeps: ["exceljs"] },
  "excel-dependency-map": { module: "excel-dependency-map", npmDeps: ["exceljs"] },
  "excel-svg-dataviz": { module: "excel-svg-dataviz", npmDeps: ["exceljs"] },
  "excel-tailwind-export": { module: "excel-tailwind-export", npmDeps: ["exceljs"] },
  "excel-i18n-gen": { module: "excel-i18n-gen", npmDeps: ["exceljs"] },
  "excel-python-gen": { module: "excel-python-gen", npmDeps: ["exceljs"] },
  "excel-trpc-router": { module: "excel-trpc-router", npmDeps: ["exceljs"] },
  "excel-weight-analyzer": { module: "excel-weight-analyzer", npmDeps: ["exceljs"] },
  // PDF family (batch 2 of 3) — more pdf-lib operations.
  "pdf-resize": { module: "pdf-resize", npmDeps: ["pdf-lib"] },
  "pdf-crop": { module: "pdf-crop", npmDeps: ["pdf-lib"] },
  "pdf-form-extractor": { module: "pdf-form-extractor", npmDeps: ["pdf-lib"] },
  "pdf-compose": { module: "pdf-compose", npmDeps: ["pdf-lib"] },
  "pdf-redact": { module: "pdf-redact", npmDeps: ["pdf-lib"] },
  "pdf-pii-redactor": { module: "pdf-pii-redactor", npmDeps: ["pdf-lib"] },
  // Other family — pure-Node text/binary utilities.
  "email-phone-scrubber": { module: "email-phone-scrubber", npmDeps: [] },
  "entropy-analyzer": { module: "entropy-analyzer", npmDeps: [] },
  "file-integrity-monitor": { module: "file-integrity-monitor", npmDeps: [] },
  "hex-header-inspector": { module: "hex-header-inspector", npmDeps: [] },
  "magic-byte-validator": { module: "magic-byte-validator", npmDeps: [] },
  "password-entropy-auditor": { module: "password-entropy-auditor", npmDeps: [] },
  "pii-scan": { module: "pii-scan", npmDeps: [] },
  "xml-to-json": { module: "xml-to-json", npmDeps: [] },
  "yaml-to-json": { module: "yaml-to-json", npmDeps: [] },
  "html-to-md": { module: "html-to-md", npmDeps: [] },
  // PDF family (batch 3 of 3) — text extraction via pdfjs-dist (no canvas).
  "pdf-to-text": { module: "pdf-to-text", npmDeps: ["pdfjs-dist"] },
  "pdf-to-markdown": { module: "pdf-to-markdown", npmDeps: ["pdfjs-dist"] },
  "pdf-to-html": { module: "pdf-to-html", npmDeps: ["pdfjs-dist"] },
  "pdf-to-chunks": { module: "pdf-to-chunks", npmDeps: ["pdfjs-dist"] },
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
