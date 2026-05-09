/**
 * office-doc-property-wiper: clears author/lastModifiedBy/title/comments
 * metadata from .docx, .xlsx, and .pptx files. Each is a ZIP archive with
 * `docProps/app.xml` and `docProps/core.xml` — we rewrite them with empty
 * Dublin Core values.
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

const FIELDS_TO_CLEAR = ["dc:creator", "dc:title", "dc:subject", "dc:description", "cp:lastModifiedBy", "cp:keywords", "cp:category", "Manager", "Company"];

export default async function officeDocPropertyWiper(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "office-doc-property-wiper requires one .docx/.xlsx/.pptx input");

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  let zip: import("jszip");
  try { zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf); }
  catch (err) { return errorResult("not_a_zip", `not a valid Office Open XML container: ${(err as Error).message}`); }

  const cleared: string[] = [];
  for (const path of ["docProps/core.xml", "docProps/app.xml"]) {
    const file = zip.file(path);
    if (!file) continue;
    const xml = await file.async("string");
    let next = xml;
    for (const field of FIELDS_TO_CLEAR) {
      const re = new RegExp(`<${field}[^>]*>[\\s\\S]*?</${field}>`, "g");
      const before = next;
      next = next.replace(re, `<${field}></${field}>`);
      if (next !== before) cleared.push(field);
    }
    next = next.replace(/<dcterms:created[^>]*>[\s\S]*?<\/dcterms:created>/g, "<dcterms:created xsi:type=\"dcterms:W3CDTF\">1970-01-01T00:00:00Z</dcterms:created>");
    next = next.replace(/<dcterms:modified[^>]*>[\s\S]*?<\/dcterms:modified>/g, "<dcterms:modified xsi:type=\"dcterms:W3CDTF\">1970-01-01T00:00:00Z</dcterms:modified>");
    zip.file(path, next);
  }

  const outBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const outRef = `wiped-${ref.ref}`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, outBuf);

  return {
    ok: true,
    outputs: { fieldsCleared: [...new Set(cleared)] },
    fileRefs: [{ ref: outRef, bytes: outBuf.length, sha256: "", mime: ref.mime || "application/octet-stream", filename: ref.filename ?? "wiped.docx" }],
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
