/**
 * md-to-jira: converts Markdown to Jira wiki markup:
 *   # H1     -> h1.    ## H2 -> h2. ...
 *   **bold** -> *bold*    *italic* -> _italic_     `code` -> {{code}}
 *   ```js fenced ``` -> {code:js}…{code}      [text](url) -> [text|url]
 *   - bullets -> *  ordered -> #
 *   > quote -> bq.
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

export default async function mdToJira(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-to-jira requires one Markdown input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceLang = "";

  for (const line of lines) {
    const fenceMatch = /^```(.*)$/.exec(line.trim());
    if (fenceMatch) {
      if (!inFence) {
        fenceLang = (fenceMatch[1] ?? "").trim();
        out.push(fenceLang ? `{code:${fenceLang}}` : "{code}");
        inFence = true;
      } else {
        out.push("{code}");
        inFence = false;
      }
      continue;
    }
    if (inFence) { out.push(line); continue; }

    let next = line;
    next = next.replace(/^(#{1,6})\s+(.+?)\s*#*\s*$/, (_, h, body) => `h${(h as string).length}. ${body}`);
    next = next.replace(/^(\s*)[-*+]\s+/g, (_, indent: string) => `${indent}${"*".repeat(Math.floor(indent.length / 2) + 1)} `);
    next = next.replace(/^(\s*)\d+[.)]\s+/g, (_, indent: string) => `${indent}${"#".repeat(Math.floor(indent.length / 2) + 1)} `);
    next = next.replace(/\*\*([^*\n]+?)\*\*/g, "*$1*");
    next = next.replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, "_$1_");
    next = next.replace(/__([^_\n]+?)__/g, "*$1*");
    next = next.replace(/(?<![_\w])_([^_\n]+?)_(?![_\w])/g, "_$1_");
    next = next.replace(/~~([^~\n]+?)~~/g, "-$1-");
    next = next.replace(/`([^`\n]+?)`/g, "{{$1}}");
    next = next.replace(/!?\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, "[$1|$2]");
    next = next.replace(/^>\s+/, "bq. ");
    out.push(next);
  }

  const transformed = out.join("\n");
  const outRef = `jira-${ref.ref.replace(/\.md$/i, "")}.txt`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, transformed, "utf8");

  return {
    ok: true,
    outputs: {},
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(transformed, "utf8"), sha256: "", mime: "text/plain", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
