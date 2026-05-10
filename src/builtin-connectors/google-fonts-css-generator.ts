/**
 * google-fonts-css-generator: produces a @import URL and an <link>
 * preconnect/stylesheet snippet for a given Google Font family with
 * weight and style options. Pure config; no fonts are downloaded.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

export default async function googleFontsCssGenerator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const cfg = ctx.inputs ?? {};
  const family = String(cfg.family ?? "Inter");
  const weights = parseList(cfg.weights, ["400", "700"]);
  const includeItalic = Boolean(cfg.includeItalic ?? false);
  const display = String(cfg.display ?? "swap");

  const familyParam = family.replace(/\s+/g, "+");
  const axes = weights.join(";");
  const italicSpec = includeItalic
    ? `${familyParam}:ital,wght@0,${weights.join(";0,")};1,${weights.join(";1,")}`
    : `${familyParam}:wght@${axes}`;
  const url = `https://fonts.googleapis.com/css2?family=${italicSpec}&display=${display}`;

  const html = [
    `<link rel="preconnect" href="https://fonts.googleapis.com">`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
    `<link rel="stylesheet" href="${url}">`,
  ].join("\n");
  const css = `@import url("${url}");\n`;

  await writeFile(join(ctx.scratchDir, "google-fonts.html"), html, "utf8");
  await writeFile(join(ctx.scratchDir, "google-fonts.css"), css, "utf8");
  ctx.emitProgress(html.length + css.length);

  return {
    ok: true,
    outputs: { family, weights, includeItalic, display, url },
    fileRefs: [
      { ref: "google-fonts.html", bytes: Buffer.byteLength(html, "utf8"), sha256: "", mime: "text/html", filename: "google-fonts.html" },
      { ref: "google-fonts.css", bytes: Buffer.byteLength(css, "utf8"), sha256: "", mime: "text/css", filename: "google-fonts.css" },
    ],
    bytesProcessed: html.length + css.length,
    durationMs: Date.now() - start,
  };
}

function parseList(input: unknown, fallback: string[]): string[] {
  if (Array.isArray(input)) return input.map(String);
  if (typeof input === "string") return input.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return fallback;
}
