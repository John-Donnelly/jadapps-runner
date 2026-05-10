/**
 * multi-format-extractor: extracts every entry from a ZIP, tar, or tar.gz
 * archive into the scratch directory. For 7z and other formats not
 * supported by the bundled libs, returns driver_missing pointing to the
 * 7z binary.
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

export default async function multiFormatExtractor(ctx: ToolContext): Promise<StepResult> {
  const start = Date.now();
  const ref = ctx.fileRefs[0];
  if (!ref) return errorResult("missing_input", "multi-format-extractor requires one archive input");

  const inPath = join(ctx.scratchDir, ref.ref);
  const totalIn = sizeOrFallback(inPath, ref.bytes);
  const buf = await readFile(inPath);
  ctx.emitProgress(totalIn);

  const filename = ref.filename ?? "";
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
  const is7z = buf[0] === 0x37 && buf[1] === 0x7a;
  const isRar = buf[0] === 0x52 && buf[1] === 0x61;
  if (is7z || isRar || filename.endsWith(".7z") || filename.endsWith(".rar")) {
    return errorResult("driver_missing", "7z and rar formats need the 7z binary on PATH; install p7zip");
  }

  let JSZip: typeof import("jszip");
  try { JSZip = (await import("jszip")).default as unknown as typeof import("jszip"); }
  catch (err) { return errorResult("driver_missing", `jszip not installed: ${(err as Error).message}`); }

  const fileRefs: FileRef[] = [];
  if (isZip) {
    const zip = await (JSZip as unknown as { loadAsync(b: Buffer): Promise<import("jszip")> }).loadAsync(buf);
    for (const [path, file] of Object.entries(zip.files)) {
      if (file.dir) continue;
      const data = await file.async("nodebuffer");
      const safeName = path.replace(/[\\:]/g, "_");
      await writeFile(join(ctx.scratchDir, safeName), data);
      fileRefs.push({ ref: safeName, bytes: data.length, sha256: "", mime: "application/octet-stream", filename: path });
    }
  } else if (isGzip || filename.endsWith(".tar.gz") || filename.endsWith(".tgz") || filename.endsWith(".tar")) {
    const tarMod = await import("tar");
    const zlib = await import("node:zlib");
    const tarBuf = isGzip ? zlib.gunzipSync(buf) : buf;
    await new Promise<void>((resolve, reject) => {
      const parser = new tarMod.Parser({ filter: () => true });
      parser.on("entry", (entry: { path: string; type: string; on: (event: string, cb: (...args: unknown[]) => void) => void }) => {
        if (entry.type === "Directory") { (entry as unknown as { resume(): void }).resume(); return; }
        const chunks: Buffer[] = [];
        entry.on("data", ((...args: unknown[]) => { chunks.push(args[0] as Buffer); }));
        entry.on("end", async () => {
          const data = Buffer.concat(chunks);
          const safeName = entry.path.replace(/[\\:]/g, "_");
          await writeFile(join(ctx.scratchDir, safeName), data);
          fileRefs.push({ ref: safeName, bytes: data.length, sha256: "", mime: "application/octet-stream", filename: entry.path });
        });
      });
      parser.on("end", () => resolve());
      parser.on("error", reject);
      parser.end(tarBuf);
    });
  } else {
    return errorResult("unknown_format", "could not detect archive format");
  }

  return {
    ok: true,
    outputs: { extractedCount: fileRefs.length, format: isZip ? "zip" : isGzip ? "tar.gz" : "tar" },
    fileRefs,
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
