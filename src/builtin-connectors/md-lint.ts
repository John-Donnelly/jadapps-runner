/**
 * md-lint: reports common Markdown problems without modifying the source.
 * Rules: trailing whitespace, hard-tabs, mixed list markers, multiple H1s,
 * skipped heading levels, broken table column counts, unclosed fences,
 * link with no text, image without alt.
 */

import { readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, FileRef } from "../types.js";

interface ToolContext {
  toolId: string;
  inputs: Record<string, unknown>;
  fileRefs: FileRef[];
  scratchDir: string;
  emitProgress(bytes: number): void;
}

interface Issue { line: number; rule: string; message: string; }

export default async function mdLint(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-lint requires one Markdown input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const issues: Issue[] = [];
  const lines = text.split("\n");
  let h1Count = 0;
  let lastHeading = 0;
  let inFence = false;
  let fenceOpenLine = 0;
  const bulletStyles = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNum = i + 1;

    if (/^```/.test(line.trim())) {
      if (!inFence) { fenceOpenLine = lineNum; inFence = true; }
      else inFence = false;
      continue;
    }

    if (/[ \t]+$/.test(line)) issues.push({ line: lineNum, rule: "trailing-whitespace", message: "trailing whitespace" });
    if (/\t/.test(line) && !inFence) issues.push({ line: lineNum, rule: "hard-tab", message: "hard tab in body" });

    if (!inFence) {
      const headingMatch = /^(#{1,6})\s+\S/.exec(line);
      if (headingMatch && headingMatch[1]) {
        const level = headingMatch[1].length;
        if (level === 1) h1Count += 1;
        if (h1Count > 1 && level === 1) issues.push({ line: lineNum, rule: "multiple-h1", message: "more than one H1 in document" });
        if (lastHeading > 0 && level > lastHeading + 1) issues.push({ line: lineNum, rule: "skipped-heading", message: `skipped heading level (jumped from H${lastHeading} to H${level})` });
        lastHeading = level;
      }

      const bulletMatch = /^\s*([-*+])\s+/.exec(line);
      if (bulletMatch && bulletMatch[1]) bulletStyles.add(bulletMatch[1]);

      for (const m of line.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
        if ((m[1] ?? "").trim() === "") issues.push({ line: lineNum, rule: "image-no-alt", message: "image missing alt text" });
      }
      for (const m of line.matchAll(/(?<!!)\[([^\]]*)\]\(([^)]+)\)/g)) {
        if ((m[1] ?? "").trim() === "") issues.push({ line: lineNum, rule: "link-no-text", message: "link with empty text" });
      }

      if (line.includes("|") && /\s*\|\s*[-:]+\s*\|/.test(line) && i > 0) {
        const headerCols = (lines[i - 1] ?? "").split("|").filter((s, idx, arr) => idx > 0 && idx < arr.length - 1).length;
        const sepCols = line.split("|").filter((s, idx, arr) => idx > 0 && idx < arr.length - 1).length;
        if (headerCols > 0 && sepCols > 0 && headerCols !== sepCols) {
          issues.push({ line: lineNum, rule: "table-column-mismatch", message: `header has ${headerCols} cols, separator has ${sepCols}` });
        }
      }
    }
  }
  if (inFence) issues.push({ line: fenceOpenLine, rule: "unclosed-fence", message: "code fence opened but never closed" });
  if (bulletStyles.size > 1) issues.push({ line: 1, rule: "mixed-bullet-markers", message: `mixed bullet markers used: ${[...bulletStyles].join(", ")}` });

  const outRef = "lint-report.json";
  const report = JSON.stringify({ issues, issueCount: issues.length }, null, 2);
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, report, "utf8");

  return {
    ok: true,
    outputs: { issueCount: issues.length, ruleBreakdown: countByRule(issues) },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(report, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function countByRule(issues: Issue[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const issue of issues) out[issue.rule] = (out[issue.rule] ?? 0) + 1;
  return out;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
