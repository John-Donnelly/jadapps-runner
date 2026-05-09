/**
 * pdf-form-extractor: dumps every AcroForm field's name and value to a JSON
 * report. Distinguishes text fields, checkboxes, radio groups, dropdowns,
 * and option lists.
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

interface FieldRecord { name: string; type: string; value: unknown; }

export default async function pdfFormExtractor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "pdf-form-extractor requires one PDF input");

  let pdfLib: typeof import("pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  const doc = await pdfLib.PDFDocument.load(buf, { ignoreEncryption: true });
  ctx.emitProgress(totalIn);

  const records: FieldRecord[] = [];
  try {
    const form = doc.getForm();
    for (const field of form.getFields()) {
      const name = field.getName();
      const type = field.constructor.name;
      let value: unknown = null;
      if (field instanceof pdfLib.PDFTextField) value = field.getText();
      else if (field instanceof pdfLib.PDFCheckBox) value = field.isChecked();
      else if (field instanceof pdfLib.PDFRadioGroup) value = field.getSelected();
      else if (field instanceof pdfLib.PDFDropdown) value = field.getSelected();
      else if (field instanceof pdfLib.PDFOptionList) value = field.getSelected();
      records.push({ name, type, value });
    }
  } catch (err) {
    return errorResult("form_read_failed", `unable to read form: ${(err as Error).message}`);
  }

  const out = JSON.stringify({ fieldCount: records.length, fields: records }, null, 2);
  const outRef = "form-fields.json";
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, out, "utf8");

  return {
    ok: true,
    outputs: { fieldCount: records.length },
    fileRefs: [{ ref: outRef, bytes: Buffer.byteLength(out, "utf8"), sha256: "", mime: "application/json", filename: outRef }],
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
