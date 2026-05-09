/**
 * md-to-docx: converts Markdown to a .docx using the `docx` library. Covers
 * headings (#-######), paragraphs, bold/italic/code, ordered and unordered
 * lists, links, blockquotes, and code blocks. Tables and images are
 * approximated as plaintext blocks for v0.1.
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

export default async function mdToDocx(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "md-to-docx requires one Markdown input");

  let docxLib: typeof import("docx");
  try { docxLib = await import("docx"); }
  catch (err) { return errorResult("driver_missing", `docx not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const text = await readFile(inPath, "utf8");
  ctx.emitProgress(totalIn);

  const blocks = parseMarkdownBlocks(text);
  const children: import("docx").Paragraph[] = [];
  for (const block of blocks) {
    children.push(...convertBlock(block, docxLib));
  }
  const doc = new docxLib.Document({ sections: [{ properties: {}, children }] });

  const buf = await docxLib.Packer.toBuffer(doc);
  const baseName = (ref.filename ?? "doc").replace(/\.md$/i, "");
  const outRef = `${baseName}.docx`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, buf);

  return {
    ok: true,
    outputs: { blockCount: blocks.length, paragraphCount: children.length },
    fileRefs: [{ ref: outRef, bytes: buf.length, sha256: "", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: outRef }],
    bytesProcessed: totalIn,
    durationMs: Date.now() - start,
  };
}

interface Block { kind: "heading" | "paragraph" | "list" | "ordered-list" | "blockquote" | "code"; level?: number; lang?: string; lines: string[]; }

function parseMarkdownBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) { i += 1; continue; }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading && heading[1] && heading[2]) {
      blocks.push({ kind: "heading", level: heading[1].length, lines: [heading[2]] });
      i += 1; continue;
    }
    if (/^```/.test(line.trim())) {
      const fenceMatch = /^```(.*)$/.exec(line.trim());
      const lang = fenceMatch?.[1]?.trim() ?? "";
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test((lines[i] ?? "").trim())) { code.push(lines[i] ?? ""); i += 1; }
      i += 1;
      blocks.push({ kind: "code", lang, lines: code });
      continue;
    }
    if (/^>\s/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) { quoted.push((lines[i] ?? "").replace(/^>\s?/, "")); i += 1; }
      blocks.push({ kind: "blockquote", lines: quoted });
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? "")) { items.push((lines[i] ?? "").replace(/^\s*[-*+]\s+/, "")); i += 1; }
      blocks.push({ kind: "list", lines: items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? "")) { items.push((lines[i] ?? "").replace(/^\s*\d+[.)]\s+/, "")); i += 1; }
      blocks.push({ kind: "ordered-list", lines: items });
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && !isBlockStart(lines[i] ?? "")) { paragraph.push(lines[i] ?? ""); i += 1; }
    blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}

function isBlockStart(line: string): boolean {
  return /^#{1,6}\s/.test(line) || /^```/.test(line.trim()) || /^>\s/.test(line) || /^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line);
}

function convertBlock(block: Block, docxLib: typeof import("docx")): import("docx").Paragraph[] {
  const { Paragraph, TextRun, HeadingLevel } = docxLib;
  switch (block.kind) {
    case "heading": {
      const headingMap = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
      const heading = headingMap[(block.level ?? 1) - 1] ?? HeadingLevel.HEADING_1;
      return [new Paragraph({ heading, children: parseInline((block.lines[0] ?? ""), TextRun) })];
    }
    case "paragraph":
      return [new Paragraph({ children: parseInline(block.lines.join(" "), TextRun) })];
    case "list":
      return block.lines.map((line) => new Paragraph({ bullet: { level: 0 }, children: parseInline(line, TextRun) }));
    case "ordered-list":
      return block.lines.map((line) => new Paragraph({ numbering: { reference: "default-numbering", level: 0 }, children: parseInline(line, TextRun) }));
    case "blockquote":
      return [new Paragraph({ indent: { left: 720 }, children: parseInline(block.lines.join(" "), TextRun) })];
    case "code":
      return block.lines.map((line) => new Paragraph({ children: [new TextRun({ text: line, font: "Consolas", size: 18 })] }));
  }
}

function parseInline(text: string, TextRun: typeof import("docx").TextRun): import("docx").TextRun[] {
  const runs: import("docx").TextRun[] = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) runs.push(new TextRun({ text: text.slice(last, m.index) }));
    const matched = m[0];
    if (matched.startsWith("**") || matched.startsWith("__")) runs.push(new TextRun({ text: matched.slice(2, -2), bold: true }));
    else if (matched.startsWith("`")) runs.push(new TextRun({ text: matched.slice(1, -1), font: "Consolas" }));
    else if (matched.startsWith("*") || matched.startsWith("_")) runs.push(new TextRun({ text: matched.slice(1, -1), italics: true }));
    else if (matched.startsWith("[")) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(matched);
      if (linkMatch && linkMatch[1]) runs.push(new TextRun({ text: linkMatch[1], style: "Hyperlink" }));
    }
    last = m.index! + matched.length;
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last) }));
  return runs.length > 0 ? runs : [new TextRun({ text })];
}

function sizeOrFallback(path: string, fallback: number): number {
  try { return statSync(path).size; } catch { return fallback; }
}

function errorResult(code: string, message: string): StepResult {
  return { ok: false, outputs: {}, fileRefs: [], bytesProcessed: 0, durationMs: 0, error: { code, message } };
}
