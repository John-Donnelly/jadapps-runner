/**
 * md-link-validator: extracts every [text](url) link, then optionally checks
 * each URL with a HEAD request (concurrent, with timeout). Results emitted as
 * a JSON report.
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

interface LinkResult { line: number; url: string; text: string; status: "skipped" | "ok" | "error"; httpStatus?: number; error?: string; }

export default async function mdLinkValidator(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-link-validator requires one Markdown input");

  const cfg = ctx.inputs ?? {};
  const checkExternal = cfg.checkExternal === true;
  const timeoutMs = Math.max(1000, Math.min(30000, Number(cfg.timeoutMs ?? 5000)));
  const concurrency = Math.max(1, Math.min(20, Number(cfg.concurrency ?? 5)));

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const lines = text.split("\n");
  const links: { line: number; url: string; text: string }[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^```/.test(line.trim())) { inFence = !inFence; continue; }
    if (inFence) continue;
    for (const m of line.matchAll(/(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      links.push({ line: i + 1, text: m[1] ?? "", url: m[2] ?? "" });
    }
  }

  let results: LinkResult[];
  if (!checkExternal) {
    results = links.map((l) => ({ ...l, status: "skipped" as const }));
  } else {
    results = await checkUrls(links, concurrency, timeoutMs);
  }

  const okCount = results.filter((r) => r.status === "ok").length;
  const errorCount = results.filter((r) => r.status === "error").length;

  const report = JSON.stringify({ totalLinks: results.length, okCount, errorCount, results }, null, 2);
  const outRef = "link-report.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, report, "utf8");

  return {
    ok: true,
    outputs: { totalLinks: results.length, okCount, errorCount, checked: checkExternal },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(report, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

async function checkUrls(links: { line: number; url: string; text: string }[], concurrency: number, timeoutMs: number): Promise<LinkResult[]> {
  const results: LinkResult[] = new Array(links.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= links.length) return;
        const link = links[idx]!;
        if (!/^https?:\/\//i.test(link.url)) {
          results[idx] = { ...link, status: "skipped" };
          continue;
        }
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), timeoutMs);
          const res = await fetch(link.url, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
          clearTimeout(timer);
          results[idx] = { ...link, status: res.ok ? "ok" : "error", httpStatus: res.status };
        } catch (e) {
          results[idx] = { ...link, status: "error", error: (e as Error).message };
        }
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
