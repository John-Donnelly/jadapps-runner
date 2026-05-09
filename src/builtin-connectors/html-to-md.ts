/**
 * html-to-md: minimal HTML → Markdown conversion. Handles common tags
 * (h1-h6, p, strong/b, em/i, code, pre, a, img, ul/ol/li, blockquote, hr,
 * br, table). Unknown tags are stripped to plaintext. Doesn't try to be
 * Pandoc — just covers ~95% of typical HTML article bodies.
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

export default async function htmlToMd(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "html-to-md requires one HTML input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const html = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  let body = html;
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(body);
  if (bodyMatch && bodyMatch[1]) body = bodyMatch[1];
  body = body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");

  const md = convertHtml(body).trim() + "\n";
  const outRef = `${(ref.filename ?? "doc").replace(/\.html?$/i, "")}.md`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, md, "utf8");

  return {
    ok: true,
    outputs: {},
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(md, "utf8"), sha256: "", mime: "text/markdown", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

function convertHtml(html: string): string {
  let out = html;
  for (let level = 6; level >= 1; level--) {
    const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi");
    out = out.replace(re, (_, body) => `\n\n${"#".repeat(level)} ${stripTags(body).trim()}\n\n`);
  }
  out = out.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, body) => `\n\n${cleanInline(body)}\n\n`);
  out = out.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, body) => `\n\n> ${cleanInline(body).replace(/\n/g, "\n> ")}\n\n`);
  out = out.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, body) => `\n\n\`\`\`\n${decodeEntities(body)}\n\`\`\`\n\n`);
  out = out.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, body) => `\n\n\`\`\`\n${stripTags(body)}\n\`\`\`\n\n`);
  out = out.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, body) => `\n\n${convertList(body, false)}\n\n`);
  out = out.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, body) => `\n\n${convertList(body, true)}\n\n`);
  out = out.replace(/<hr\s*\/?\s*>/gi, "\n\n---\n\n");
  out = out.replace(/<br\s*\/?\s*>/gi, "  \n");
  out = out.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, body) => `\n\n${convertTable(body)}\n\n`);
  out = cleanInline(out);
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
}

function cleanInline(s: string): string {
  let out = s;
  out = out.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  out = out.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  out = out.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  out = out.replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  out = out.replace(/<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, "![$2]($1)");
  out = out.replace(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]+)"[^>]*\/?>/gi, "![$1]($2)");
  out = out.replace(/<img[^>]*src="([^"]+)"[^>]*\/?>/gi, "![]($1)");
  out = stripTags(out);
  return decodeEntities(out);
}

function convertList(body: string, ordered: boolean): string {
  const items = [...body.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => cleanInline(m[1] ?? "").trim());
  return items.map((item, i) => `${ordered ? `${i + 1}.` : "-"} ${item}`).join("\n");
}

function convertTable(body: string): string {
  const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => [...m[1]!.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cm) => cleanInline(cm[1] ?? "").trim().replace(/\|/g, "\\|")));
  if (rows.length === 0) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  const out: string[] = [];
  out.push("| " + (rows[0] ?? []).concat(new Array(cols - rows[0]!.length).fill("")).join(" | ") + " |");
  out.push("| " + new Array(cols).fill(":---").join(" | ") + " |");
  for (let i = 1; i < rows.length; i++) {
    const padded = (rows[i] ?? []).concat(new Array(cols - rows[i]!.length).fill(""));
    out.push("| " + padded.join(" | ") + " |");
  }
  return out.join("\n");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
