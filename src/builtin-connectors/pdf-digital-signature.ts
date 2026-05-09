/**
 * pdf-digital-signature: invisible PKCS#7 cryptographic signature using a
 * PFX/P12 certificate. Same crypto as pdf-sign, but draws no visible
 * widget. Useful when the signature is verified programmatically.
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

export default async function pdfDigitalSignature(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  if (!Array.isArray(ctx.fileRefs) || ctx.fileRefs.length < 2) {
    return errorResult("missing_input", "pdf-digital-signature requires a PDF and a .p12/.pfx certificate");
  }

  const cfg = ctx.inputs ?? {};
  const passphrase = String(cfg.passphrase ?? "");
  const signerName = String(cfg.signerName ?? "Signer");
  const reason = String(cfg.reason ?? "Authenticated by digital signature");
  const location = String(cfg.location ?? "");

  let pdfLib: typeof import("pdf-lib");
  let signpdf: typeof import("@signpdf/signpdf");
  let signerP12: typeof import("@signpdf/signer-p12");
  let placeholder: typeof import("@signpdf/placeholder-pdf-lib");
  try { pdfLib = await import("pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `pdf-lib not installed: ${(err as Error).message}`); }
  try { signpdf = await import("@signpdf/signpdf"); }
  catch (err) { return errorResult("driver_missing", `@signpdf/signpdf not installed: ${(err as Error).message}`); }
  try { signerP12 = await import("@signpdf/signer-p12"); }
  catch (err) { return errorResult("driver_missing", `@signpdf/signer-p12 not installed: ${(err as Error).message}`); }
  try { placeholder = await import("@signpdf/placeholder-pdf-lib"); }
  catch (err) { return errorResult("driver_missing", `@signpdf/placeholder-pdf-lib not installed: ${(err as Error).message}`); }

  const pdfRef = ctx.fileRefs[0]!;
  const certRef = ctx.fileRefs[1]!;
  const pdfPath = join(ctx.scratchDir, pdfRef.ref);
  const certPath = join(ctx.scratchDir, certRef.ref);
  const totalIn = sizeOrFallback(pdfPath, pdfRef.bytes) + sizeOrFallback(certPath, certRef.bytes);
  const pdfBuf = await readFile(pdfPath);
  const certBuf = await readFile(certPath);

  const doc = await pdfLib.PDFDocument.load(pdfBuf);
  const placeholderApi = placeholder as unknown as { pdflibAddPlaceholder(opts: Record<string, unknown>): void };
  placeholderApi.pdflibAddPlaceholder({ pdfDoc: doc, reason, contactInfo: location, name: signerName, location });
  const withPlaceholder = await doc.save();

  const Signer = signerP12.P12Signer as unknown as new (cert: Buffer, opts: { passphrase: string }) => unknown;
  const signpdfInstance = signpdf.default ?? signpdf;
  const signed = await (signpdfInstance as unknown as { sign(buf: Buffer, signer: unknown): Promise<Buffer> })
    .sign(Buffer.from(withPlaceholder), new Signer(certBuf, { passphrase }));

  ctx.emitProgress(totalIn);
  const baseName = (pdfRef.filename ?? "doc").replace(/\.pdf$/i, "");
  const outRef = `${baseName}-signed.pdf`;
  const outPath = join(ctx.scratchDir, outRef);
  await writeFile(outPath, signed);

  return {
    ok: true,
    outputs: { signerName, reason, signed: true, invisible: true },
    fileRefs: [{ ref: outRef, bytes: signed.length, sha256: "", mime: "application/pdf", filename: outRef }],
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
